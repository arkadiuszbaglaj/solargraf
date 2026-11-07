"""Historia metryki urządzenia: ``GET /api/sites/{id}/devices/{did}/history`` (D46).

Najwyżej ``MAX_POINTS`` punktów. ``auto`` wybiera najmniejszą rozdzielczość, która się mieści
(surowe odczyty tylko do ``RAW_AUTO_MAX``);
jawna rozdzielczość dająca więcej punktów to 422. Przedział bez danych to punkt z ``value=null``
i pokryciem 0 — nigdy zero. Dla liczników narastających wartością jest ostatni odczyt, dla
pozostałych średnia. Czasy w UTC; doby wyrównane do północy w strefie instalacji.
"""

from __future__ import annotations

import enum
import math
import uuid
from datetime import datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import AwareDatetime, BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_profiles.catalog import METRICS, MetricDefinition
from solargraf_server import authz
from solargraf_server.aggregation import H1, M5, floor_utc, local_day_start, local_days
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth
from solargraf_server.models import NO_CHANNEL, Aggregate, Device, Measurement, Quality, Resolution
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["history"])

MAX_POINTS = 2000
# ``auto`` wybiera surowe odczyty tylko dla krótkich zakresów — w nich luki nie są punktami
# ``null``, a dłuższy zakres prawie zawsze ma przerwy, które wykres musi pokazać.
RAW_AUTO_MAX = timedelta(hours=6)
NOT_FOUND_DEVICE = "Nie znaleziono urządzenia."


class HistoryResolution(enum.StrEnum):
    AUTO = "auto"
    RAW = "raw"
    M5 = "5m"
    H1 = "1h"
    D1 = "1d"


_ORDER = (HistoryResolution.RAW, HistoryResolution.M5, HistoryResolution.H1, HistoryResolution.D1)
_STEP = {HistoryResolution.M5: M5, HistoryResolution.H1: H1}


class HistoryPoint(BaseModel):
    t: datetime
    value: float | None
    min: float | None = None
    max: float | None = None
    # Część przedziału pokryta próbkami GOOD (0-1); dla ``raw`` brak.
    coverage: float | None = None


class HistoryOut(BaseModel):
    metric: str
    channel: int | None
    unit: str
    cumulative: bool
    resolution: HistoryResolution
    timezone: str
    # Pochodzenie surowych pomiarów w zakresie (np. SIMULATED) — UI musi je oznaczyć.
    origins: list[str]
    points: list[HistoryPoint]


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _metric(metric: str, channel: int | None) -> tuple[MetricDefinition, int]:
    definition = METRICS.get(metric)
    if definition is None:
        raise _unprocessable("Nieznana metryka.")
    if definition.channeled and channel is None:
        raise _unprocessable("Metryka wymaga kanału.")
    if not definition.channeled and channel is not None:
        raise _unprocessable("Metryka nie ma kanałów.")
    return definition, channel if channel is not None else NO_CHANNEL


def bucket_starts(
    resolution: HistoryResolution, start: datetime, end: datetime, tz: ZoneInfo
) -> list[datetime]:
    """Początki przedziałów przecinających ``[start, end)``."""
    if resolution is HistoryResolution.D1:
        return local_days(start, end, tz)
    step = _STEP[resolution]
    first = floor_utc(start, step)
    return [first + i * step for i in range(math.ceil((end - first) / step))]


def bucket_count(
    resolution: HistoryResolution, start: datetime, end: datetime, tz: ZoneInfo
) -> int:
    if resolution is HistoryResolution.D1:
        # Górne oszacowanie bez generowania listy (doba ma co najmniej 23 h).
        return math.ceil((end - local_day_start(start, tz)) / timedelta(hours=23))
    step = _STEP[resolution]
    return math.ceil((end - floor_utc(start, step)) / step)


async def _raw_count(
    db: AsyncSession,
    device_id: uuid.UUID,
    metric: str,
    channel: int,
    start: datetime,
    end: datetime,
) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Measurement)
        .where(
            Measurement.device_id == device_id,
            Measurement.metric == metric,
            Measurement.channel == channel,
            Measurement.received_at >= start,
            Measurement.received_at < end,
        )
    )
    return count or 0


@router.get("/{site_id}/devices/{device_id}/history", response_model=HistoryOut)
async def device_history(
    site_id: uuid.UUID,
    device_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(current_auth)],
    metric: Annotated[str, Query(max_length=64)],
    start: Annotated[AwareDatetime, Query(alias="from")],
    end: Annotated[AwareDatetime, Query(alias="to")],
    channel: Annotated[int | None, Query(ge=1, le=32)] = None,
    resolution: HistoryResolution = HistoryResolution.AUTO,
) -> HistoryOut:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    device = await db.scalar(
        select(Device.id).where(Device.id == device_id, Device.site_id == site_id)
    )
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_DEVICE)
    definition, ch = _metric(metric, channel)
    if start >= end:
        raise _unprocessable("Początek zakresu musi być przed końcem.")
    tz = ZoneInfo(access.site.timezone)

    async def fits(res: HistoryResolution) -> bool:
        if res is HistoryResolution.RAW:
            return await _raw_count(db, device_id, metric, ch, start, end) <= MAX_POINTS
        return bucket_count(res, start, end, tz) <= MAX_POINTS

    if resolution is HistoryResolution.AUTO:
        for candidate in _ORDER:
            if candidate is HistoryResolution.RAW and end - start > RAW_AUTO_MAX:
                continue
            if await fits(candidate):
                resolution = candidate
                break
        else:
            raise _unprocessable("Zakres jest za długi.")
    elif not await fits(resolution):
        raise _unprocessable(f"Za dużo punktów (limit {MAX_POINTS}) — wybierz większy przedział.")

    origins = await db.scalars(
        select(Measurement.origin)
        .where(
            Measurement.device_id == device_id,
            Measurement.metric == metric,
            Measurement.channel == ch,
            Measurement.received_at >= start,
            Measurement.received_at < end,
        )
        .distinct()
        .order_by(Measurement.origin)
    )
    if resolution is HistoryResolution.RAW:
        points = await _raw_points(db, device_id, metric, ch, start, end)
    else:
        points = await _bucket_points(
            db, device_id, metric, ch, resolution, start, end, tz, definition.cumulative
        )
    return HistoryOut(
        metric=metric,
        channel=channel,
        unit=definition.canonical_unit.value,
        cumulative=definition.cumulative,
        resolution=resolution,
        timezone=access.site.timezone,
        origins=list(origins),
        points=points,
    )


async def _raw_points(
    db: AsyncSession,
    device_id: uuid.UUID,
    metric: str,
    channel: int,
    start: datetime,
    end: datetime,
) -> list[HistoryPoint]:
    rows = await db.execute(
        select(Measurement.received_at, Measurement.value, Measurement.quality)
        .where(
            Measurement.device_id == device_id,
            Measurement.metric == metric,
            Measurement.channel == channel,
            Measurement.received_at >= start,
            Measurement.received_at < end,
        )
        .order_by(Measurement.received_at)
    )
    # Wartość tylko dla GOOD — INVALID/STALE/MISSING to luka, nie liczba.
    return [
        HistoryPoint(t=at, value=value if quality == Quality.GOOD else None)
        for at, value, quality in rows.all()
    ]


async def _bucket_points(
    db: AsyncSession,
    device_id: uuid.UUID,
    metric: str,
    channel: int,
    resolution: HistoryResolution,
    start: datetime,
    end: datetime,
    tz: ZoneInfo,
    cumulative: bool,
) -> list[HistoryPoint]:
    starts = bucket_starts(resolution, start, end, tz)
    rows = await db.scalars(
        select(Aggregate).where(
            Aggregate.device_id == device_id,
            Aggregate.metric == metric,
            Aggregate.channel == channel,
            Aggregate.resolution == Resolution(resolution.value).value,
            Aggregate.bucket_start >= starts[0],
            Aggregate.bucket_start < end,
        )
    )
    found = {a.bucket_start: a for a in rows}
    points = []
    for t in starts:
        agg = found.get(t)
        if agg is None:
            points.append(HistoryPoint(t=t, value=None, coverage=0.0))
            continue
        points.append(
            HistoryPoint(
                t=t,
                value=agg.last if cumulative else agg.avg,
                min=agg.min,
                max=agg.max,
                coverage=agg.coverage,
            )
        )
    return points
