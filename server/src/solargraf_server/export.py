"""Eksport historii urządzenia do CSV (D57): ``GET /api/sites/{id}/devices/{did}/export.csv``.

Wszystkie metryki z profilu urządzenia (bez UNSUPPORTED) w jednym pliku, format „długi”: wiersz
na przedział (albo odczyt), metrykę i kanał. Plik pod polskiego Excela: separator ``;``, przecinek
dziesiętny, UTF-8 z BOM. Brak danych to puste pole, nigdy 0. Pola tekstowe zaczynające się od
znaku formuły dostają apostrof (ochrona przed wstrzyknięciem formuł). Każdy eksport jest w audycie
(``DATA_EXPORTED``), bez danych. Odpowiedź strumieniowana; sesja strumienia jest osobna.
"""

from __future__ import annotations

import csv
import enum
import io
import re
import unicodedata
import uuid
from collections.abc import AsyncIterator, Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime
from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from solargraf_profiles.model import ProfileOrigin
from solargraf_server import authz
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth
from solargraf_server.devices import DeviceMetric, device_metrics
from solargraf_server.history import (
    NOT_FOUND_DEVICE,
    HistoryResolution,
    bucket_count,
    bucket_starts,
)
from solargraf_server.models import NO_CHANNEL, Aggregate, Device, Measurement, Quality, Resolution
from solargraf_server.profiles import ProfileCatalog
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["export"])

MAX_ROWS = 500_000
MAX_RANGE = timedelta(days=400)
RAW_MAX_RANGE = timedelta(days=7)
# Pochodzenie, gdy profilu urządzenia nie ma w katalogu — nie zgadujemy DEVICE/SIMULATED.
UNKNOWN_ORIGIN = "NIEZNANE"
FETCH_ROWS = 5000


class ExportResolution(enum.StrEnum):
    RAW = "raw"
    M5 = "5m"
    H1 = "1h"
    D1 = "1d"


AGGREGATE_HEADER = (
    "czas_utc",
    "czas_lokalny",
    "metryka",
    "kanał",
    "jednostka",
    "średnia",
    "min",
    "max",
    "ostatnia",
    "pokrycie",
    "pochodzenie",
)
RAW_HEADER = (
    "czas_utc",
    "czas_lokalny",
    "metryka",
    "kanał",
    "jednostka",
    "wartość",
    "jakość",
    "pochodzenie",
)

_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def number(value: float | None) -> str:
    """Liczba z przecinkiem dziesiętnym; brak wartości to puste pole (nigdy 0)."""
    if value is None:
        return ""
    return repr(float(value)).replace(".", ",")


def safe_text(value: str) -> str:
    """Tekst bez ryzyka formuły w arkuszu: początek ``= + - @`` (i tab/CR) dostaje apostrof."""
    return f"'{value}" if value.startswith(_FORMULA_START) else value


def utc_text(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_text(t: datetime, tz: ZoneInfo) -> str:
    # Bez przesunięcia — Excel go nie rozumie; jednoznaczny jest czas UTC w pierwszej kolumnie.
    return t.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")


def slug(name: str) -> str:
    """Nazwa do pliku: ASCII, małe litery, myślniki (ł → l, bez innych znaków)."""
    ascii_name = (
        unicodedata.normalize("NFKD", name.replace("ł", "l").replace("Ł", "L"))
        .encode("ascii", "ignore")
        .decode()
    )
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:40] or "x"


def filename(
    site: str,
    device: str,
    start: datetime,
    end: datetime,
    resolution: ExportResolution,
    tz: ZoneInfo,
    *,
    simulated: bool,
) -> str:
    day = "%Y%m%d"
    parts = [
        "historia",
        slug(site),
        slug(device),
        start.astimezone(tz).strftime(day),
        # Koniec zakresu jest wyłączny — w nazwie ostatni dzień, który zawiera dane.
        (end - timedelta(microseconds=1)).astimezone(tz).strftime(day),
        resolution.value,
    ]
    if simulated:
        parts.append("SIMULATED")
    return "_".join(parts) + ".csv"


def encode_rows(rows: Iterable[Sequence[str]]) -> bytes:
    buffer = io.StringIO()
    csv.writer(buffer, delimiter=";", lineterminator="\r\n").writerows(
        [safe_text(cell) for cell in row] for row in rows
    )
    return buffer.getvalue().encode("utf-8")


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _channel(metric: DeviceMetric) -> int:
    return metric.channel if metric.channel is not None else NO_CHANNEL


def _channel_text(metric: DeviceMetric) -> str:
    return "" if metric.channel is None else str(metric.channel)


async def _raw_count(
    db: AsyncSession,
    device_id: uuid.UUID,
    metrics: list[DeviceMetric],
    start: datetime,
    end: datetime,
) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Measurement)
        .where(
            Measurement.device_id == device_id,
            tuple_(Measurement.metric, Measurement.channel).in_(
                [(m.key, _channel(m)) for m in metrics]
            ),
            Measurement.received_at >= start,
            Measurement.received_at < end,
        )
    )
    return count or 0


async def _raw_rows(
    db: AsyncSession,
    device_id: uuid.UUID,
    metric: DeviceMetric,
    start: datetime,
    end: datetime,
    tz: ZoneInfo,
) -> AsyncIterator[list[str]]:
    result = await db.stream(
        select(Measurement.received_at, Measurement.value, Measurement.quality, Measurement.origin)
        .where(
            Measurement.device_id == device_id,
            Measurement.metric == metric.key,
            Measurement.channel == _channel(metric),
            Measurement.received_at >= start,
            Measurement.received_at < end,
        )
        .order_by(Measurement.received_at)
        .execution_options(yield_per=FETCH_ROWS)
    )
    async for at, value, quality, origin in result:
        yield [
            utc_text(at),
            local_text(at, tz),
            metric.key,
            _channel_text(metric),
            metric.unit,
            # Wartość tylko dla GOOD — jak w historii (D46); jakość w osobnej kolumnie.
            number(value if quality == Quality.GOOD else None),
            quality,
            origin,
        ]


async def _aggregate_rows(
    db: AsyncSession,
    device_id: uuid.UUID,
    metric: DeviceMetric,
    resolution: ExportResolution,
    start: datetime,
    end: datetime,
    tz: ZoneInfo,
    origin: str,
) -> AsyncIterator[list[str]]:
    starts = bucket_starts(HistoryResolution(resolution.value), start, end, tz)
    result = await db.stream(
        select(
            Aggregate.bucket_start,
            Aggregate.avg,
            Aggregate.min,
            Aggregate.max,
            Aggregate.last,
            Aggregate.coverage,
        )
        .where(
            Aggregate.device_id == device_id,
            Aggregate.metric == metric.key,
            Aggregate.channel == _channel(metric),
            Aggregate.resolution == Resolution(resolution.value).value,
            Aggregate.bucket_start >= starts[0],
            Aggregate.bucket_start < end,
        )
        .execution_options(yield_per=FETCH_ROWS)
    )
    found = {row[0]: row[1:] async for row in result}
    for t in starts:
        values = found.get(t)
        avg, low, high, last, coverage = values if values is not None else (None,) * 4 + (0.0,)
        yield [
            utc_text(t),
            local_text(t, tz),
            metric.key,
            _channel_text(metric),
            metric.unit,
            number(avg),
            number(low),
            number(high),
            number(last),
            number(coverage),
            origin,
        ]


async def _csv(
    maker: async_sessionmaker[AsyncSession],
    device_id: uuid.UUID,
    metrics: list[DeviceMetric],
    resolution: ExportResolution,
    start: datetime,
    end: datetime,
    tz: ZoneInfo,
    origin: str,
) -> AsyncIterator[bytes]:
    raw = resolution is ExportResolution.RAW
    yield "﻿".encode() + encode_rows([RAW_HEADER if raw else AGGREGATE_HEADER])
    async with maker() as db:
        for metric in metrics:
            rows = (
                _raw_rows(db, device_id, metric, start, end, tz)
                if raw
                else _aggregate_rows(db, device_id, metric, resolution, start, end, tz, origin)
            )
            chunk: list[list[str]] = []
            async for row in rows:
                chunk.append(row)
                if len(chunk) >= FETCH_ROWS:
                    yield encode_rows(chunk)
                    chunk = []
            if chunk:
                yield encode_rows(chunk)


@router.get(
    "/{site_id}/devices/{device_id}/export.csv",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/csv": {}}}},
)
async def export_device_csv(
    site_id: uuid.UUID,
    device_id: uuid.UUID,
    request: Request,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(current_auth)],
    start: Annotated[AwareDatetime, Query(alias="from")],
    end: Annotated[AwareDatetime, Query(alias="to")],
    resolution: ExportResolution = ExportResolution.H1,
) -> StreamingResponse:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    device = await db.scalar(
        select(Device).where(Device.id == device_id, Device.site_id == site_id)
    )
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_DEVICE)
    if start >= end:
        raise _unprocessable("Początek zakresu musi być przed końcem.")
    if end - start > MAX_RANGE:
        raise _unprocessable("Zakres eksportu może mieć najwyżej 400 dni.")
    if resolution is ExportResolution.RAW and end - start > RAW_MAX_RANGE:
        raise _unprocessable("Surowe odczyty można eksportować najwyżej za 7 dni.")

    catalog: ProfileCatalog | None = getattr(request.app.state, "profiles", None)
    profile = (
        catalog.get(device.profile_id, device.profile_version)
        if catalog is not None and device.profile_id is not None and device.profile_version
        else None
    )
    metrics = device_metrics(profile)
    tz = ZoneInfo(access.site.timezone)
    if resolution is ExportResolution.RAW:
        rows = await _raw_count(db, device_id, metrics, start, end) if metrics else 0
    else:
        rows = bucket_count(HistoryResolution(resolution.value), start, end, tz) * len(metrics)
    if rows > MAX_ROWS:
        raise _unprocessable(
            f"Za dużo wierszy (limit {MAX_ROWS}) — wybierz większy przedział albo krótszy zakres."
        )

    origin = profile.origin.value if profile is not None else UNKNOWN_ORIGIN
    await auth_service.audit(
        db,
        "DATA_EXPORTED",
        user_id=auth.user.id,
        organization_id=access.site.organization_id,
        target=f"device:{device_id};{resolution.value};{utc_text(start)}/{utc_text(end)}",
    )
    await db.commit()

    name = filename(
        access.site.name,
        device.name,
        start,
        end,
        resolution,
        tz,
        simulated=profile is not None and profile.origin is ProfileOrigin.SIMULATED,
    )
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    return StreamingResponse(
        _csv(maker, device_id, metrics, resolution, start, end, tz, origin),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "no-store",
        },
    )
