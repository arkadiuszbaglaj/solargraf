"""Energia za okres i wskaźniki D27 urządzenia (D48) i instalacji (D51).

- ``GET /api/sites/{id}/devices/{did}/energy`` — serie jednego urządzenia.
- ``GET /api/sites/{id}/energy`` — serie instalacji: każda z dokładnie jednego włączonego
  urządzenia, którego profil ją udostępnia; kilka źródeł albo brak źródła → seria niedostępna
  (bez sumowania). Wskaźniki z serii wybranych w ten sposób, także z różnych urządzeń.

Liczone przy zapytaniu z agregatów (``worker``): liczniki z agregatów godzinowych, zużycie domu
z agregatów 5 min mocy ``load_power``. Przedziały: godziny (zakres do doby), doby albo miesiące
w strefie instalacji.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import AwareDatetime, BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server import authz
from solargraf_server.aggregation import H1, local_day_start
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth
from solargraf_server.devices import device_metrics
from solargraf_server.energy import (
    HourEnergy,
    Kpi,
    KpiStatus,
    counter_hours,
    hour_starts,
    power_hours,
    ratio_kpi,
    total,
)
from solargraf_server.models import NO_CHANNEL, Aggregate, Device, Measurement, Resolution
from solargraf_server.profiles import Catalog, ProfileCatalog
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["energy"])

NOT_FOUND_DEVICE = "Nie znaleziono urządzenia."
MAX_RANGE = timedelta(days=400)

# Klucz w odpowiedzi → metryka źródłowa. Zużycie domu z mocy (brak licznika w katalogu).
COUNTERS = {
    "pv": "pv_energy_total",
    "grid_import": "grid_import_energy_total",
    "grid_export": "grid_export_energy_total",
    "battery_charge": "battery_charge_energy_total",
    "battery_discharge": "battery_discharge_energy_total",
}
LOAD_KEY, LOAD_METRIC = "load", "load_power"
SOURCES = {**COUNTERS, LOAD_KEY: LOAD_METRIC}

BucketSize = Literal["1h", "1d", "1mo"]


class EnergyBucketOut(BaseModel):
    t: datetime
    wh: float | None
    coverage: float


class EnergySeriesOut(BaseModel):
    key: str
    metric: str
    device_id: uuid.UUID
    # COUNTER — przyrost licznika; POWER — moc zintegrowana w czasie (wartość pochodna).
    source: Literal["COUNTER", "POWER"]
    total_wh: float | None
    coverage: float
    reset_detected: bool
    buckets: list[EnergyBucketOut]


class KpiOut(BaseModel):
    value: float | None
    status: KpiStatus
    reason: str | None
    coverage: float
    definition: str


class KpisOut(BaseModel):
    self_consumption: KpiOut
    self_sufficiency: KpiOut


class EnergyOut(BaseModel):
    timezone: str
    bucket: BucketSize
    origins: list[str]
    series: list[EnergySeriesOut]
    kpis: KpisOut


class UnavailableSeriesOut(BaseModel):
    key: str
    metric: str
    # NOT_PROVIDED — żadne włączone urządzenie nie podaje metryki; AMBIGUOUS — kilka źródeł.
    reason: Literal["NOT_PROVIDED", "AMBIGUOUS"]
    sources: int


class SiteEnergyOut(EnergyOut):
    unavailable: list[UnavailableSeriesOut]


SELF_CONSUMPTION = "Autokonsumpcja = (produkcja PV - eksport) / produkcja PV"
SELF_SUFFICIENCY = "Samowystarczalność = (zużycie domu - import) / zużycie domu"


def bucket_size(start: datetime, end: datetime) -> BucketSize:
    span = end - start
    if span <= timedelta(hours=25):
        return "1h"
    if span <= timedelta(days=32):
        return "1d"
    return "1mo"


def local_month_start(ts: datetime, tz: ZoneInfo) -> datetime:
    local = ts.astimezone(tz)
    return datetime(local.year, local.month, 1, tzinfo=tz).astimezone(UTC)


def bucket_of(size: BucketSize, tz: ZoneInfo) -> Callable[[datetime], datetime]:
    if size == "1h":
        return lambda h: h
    if size == "1d":
        return lambda h: local_day_start(h, tz)
    return lambda h: local_month_start(h, tz)


async def _counter_lasts(
    db: AsyncSession, device_id: uuid.UUID, metric: str, start: datetime, end: datetime
) -> dict[datetime, float | None]:
    rows = await db.execute(
        select(Aggregate.bucket_start, Aggregate.last).where(
            Aggregate.device_id == device_id,
            Aggregate.metric == metric,
            Aggregate.channel == NO_CHANNEL,
            Aggregate.resolution == Resolution.H1.value,
            Aggregate.bucket_start >= start - H1,  # ostatni odczyt godziny przed zakresem
            Aggregate.bucket_start < end,
        )
    )
    lasts: dict[datetime, float | None] = dict(rows.all())
    return lasts


async def _power_m5(
    db: AsyncSession, device_id: uuid.UUID, metric: str, start: datetime, end: datetime
) -> list[tuple[datetime, float | None, float]]:
    rows = await db.execute(
        select(Aggregate.bucket_start, Aggregate.avg, Aggregate.coverage)
        .where(
            Aggregate.device_id == device_id,
            Aggregate.metric == metric,
            Aggregate.channel == NO_CHANNEL,
            Aggregate.resolution == Resolution.M5.value,
            Aggregate.bucket_start >= start,
            Aggregate.bucket_start < end,
        )
        .order_by(Aggregate.bucket_start)
    )
    return [(at, avg, cov) for at, avg, cov in rows.all()]


def _kpi(kpi: Kpi, definition: str) -> KpiOut:
    return KpiOut(
        value=kpi.value,
        status=kpi.status,
        reason=kpi.reason,
        coverage=kpi.coverage,
        definition=definition,
    )


@router.get("/{site_id}/devices/{device_id}/energy", response_model=EnergyOut)
async def device_energy(
    site_id: uuid.UUID,
    device_id: uuid.UUID,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(current_auth)],
    start: Annotated[AwareDatetime, Query(alias="from")],
    end: Annotated[AwareDatetime, Query(alias="to")],
) -> EnergyOut:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    device = await db.scalar(
        select(Device).where(Device.id == device_id, Device.site_id == site_id)
    )
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_DEVICE)
    _check_range(start, end)
    available = _available(catalog, device)
    sources = {key: device.id for key, metric in SOURCES.items() if metric in available}
    return await compute_energy(db, sources, start, end, access.site.timezone)


def _available(catalog: ProfileCatalog, device: Device) -> set[str]:
    profile = (
        catalog.get(device.profile_id, device.profile_version)
        if device.profile_id is not None and device.profile_version is not None
        else None
    )
    return {m.key for m in device_metrics(profile) if m.channel is None}


def _check_range(start: datetime, end: datetime) -> None:
    if start >= end:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Początek zakresu musi być przed końcem."
        )
    if end - start > MAX_RANGE:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Zakres jest za długi.")


async def compute_energy(
    db: AsyncSession,
    sources: dict[str, uuid.UUID],
    start: datetime,
    end: datetime,
    timezone: str,
) -> EnergyOut:
    """Serie i wskaźniki dla ``sources`` (klucz serii → urządzenie, które ją podaje)."""
    tz = ZoneInfo(timezone)
    hours = hour_starts(start, end)
    size = bucket_size(start, end)
    to_bucket = bucket_of(size, tz)

    per_hour: dict[str, list[HourEnergy]] = {}
    series: list[EnergySeriesOut] = []
    for key, metric in COUNTERS.items():
        device_id = sources.get(key)
        if device_id is None:
            continue
        lasts = await _counter_lasts(db, device_id, metric, hours[0], end)
        per_hour[key] = counter_hours(hours, lasts)
        series.append(_series(key, metric, device_id, "COUNTER", per_hour[key], to_bucket))
    load_device = sources.get(LOAD_KEY)
    if load_device is not None:
        m5 = await _power_m5(db, load_device, LOAD_METRIC, hours[0], end)
        per_hour[LOAD_KEY] = power_hours(hours, m5)
        series.append(
            _series(LOAD_KEY, LOAD_METRIC, load_device, "POWER", per_hour[LOAD_KEY], to_bucket)
        )

    origins: list[str] = (
        list(
            await db.scalars(
                select(Measurement.origin)
                .where(
                    or_(
                        *(
                            (Measurement.device_id == s.device_id)
                            & (Measurement.metric == s.metric)
                            for s in series
                        )
                    ),
                    Measurement.received_at >= start,
                    Measurement.received_at < end,
                )
                .distinct()
                .order_by(Measurement.origin)
            )
        )
        if series
        else []
    )
    return EnergyOut(
        timezone=timezone,
        bucket=size,
        origins=origins,
        series=series,
        kpis=KpisOut(
            self_consumption=_kpi(
                ratio_kpi(
                    per_hour.get("pv"),
                    per_hour.get("grid_export"),
                    "Brak produkcji PV w tym okresie.",
                ),
                SELF_CONSUMPTION,
            ),
            self_sufficiency=_kpi(
                ratio_kpi(
                    per_hour.get(LOAD_KEY),
                    per_hour.get("grid_import"),
                    "Brak zużycia w tym okresie.",
                ),
                SELF_SUFFICIENCY,
            ),
        ),
    )


@router.get("/{site_id}/energy", response_model=SiteEnergyOut)
async def site_energy(
    site_id: uuid.UUID,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(current_auth)],
    start: Annotated[AwareDatetime, Query(alias="from")],
    end: Annotated[AwareDatetime, Query(alias="to")],
) -> SiteEnergyOut:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    _check_range(start, end)
    devices = list(
        await db.scalars(
            select(Device)
            .where(Device.site_id == site_id, Device.enabled.is_(True))
            .order_by(Device.name, Device.id)
        )
    )
    provided = {device.id: _available(catalog, device) for device in devices}
    sources: dict[str, uuid.UUID] = {}
    unavailable: list[UnavailableSeriesOut] = []
    for key, metric in SOURCES.items():
        providers = [d.id for d in devices if metric in provided[d.id]]
        if len(providers) == 1:
            sources[key] = providers[0]
        else:
            unavailable.append(
                UnavailableSeriesOut(
                    key=key,
                    metric=metric,
                    reason="NOT_PROVIDED" if not providers else "AMBIGUOUS",
                    sources=len(providers),
                )
            )
    energy = await compute_energy(db, sources, start, end, access.site.timezone)
    return SiteEnergyOut(**energy.model_dump(), unavailable=unavailable)


def _series(
    key: str,
    metric: str,
    device_id: uuid.UUID,
    source: Literal["COUNTER", "POWER"],
    hours: list[HourEnergy],
    to_bucket: Callable[[datetime], datetime],
) -> EnergySeriesOut:
    result = total(hours, to_bucket)
    return EnergySeriesOut(
        key=key,
        metric=metric,
        device_id=device_id,
        source=source,
        total_wh=result.wh,
        coverage=result.coverage,
        reset_detected=result.reset_detected,
        buckets=[EnergyBucketOut(t=b.start, wh=b.wh, coverage=b.coverage) for b in result.buckets],
    )
