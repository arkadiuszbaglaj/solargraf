"""API monitora serwera (D16, D60): tylko rola OWNER — dane ujawniają infrastrukturę.

Odpowiedź nie zawiera nazw hostów, adresów, ścieżek, procesów ani zmiennych środowiskowych.
Ocena pochodzi z workera; jeśli jest starsza niż ``STATUS_STALE_AFTER``, worker jest uznany za
niedostępny, a ocena za krytyczną (metryki są wtedy nieaktualne, nie zerowe).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import ColumnElement, DateTime, Interval, exists, func, literal, select
from sqlalchemy.orm import InstrumentedAttribute

from solargraf_server import __version__
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth
from solargraf_server.models import Membership, Role
from solargraf_server.models.system import (
    STATUS_ROW_ID,
    SystemComponent,
    SystemMetricSample,
    SystemStatus,
)
from solargraf_server.system import host, trends
from solargraf_server.system.stability import (
    COMPONENT_NAMES,
    ComponentState,
    Level,
    Severity,
    component_code,
    percent,
)

router = APIRouter(prefix="/api/system", tags=["system"])

# Worker mierzy co 60 s; 3 pominięte pomiary = worker niedostępny.
STATUS_STALE_AFTER = timedelta(seconds=180)


def utcnow() -> datetime:
    return datetime.now(UTC)


class ReasonOut(BaseModel):
    code: str
    severity: Severity
    message: str
    since: datetime | None


class ComponentOut(BaseModel):
    component: str
    name: str
    state: ComponentState
    checked_at: datetime | None
    last_ok_at: datetime | None


class PercentOut(BaseModel):
    memory: float | None
    swap: float | None
    disk: float | None


class SystemHealthOut(BaseModel):
    level: Level
    reasons: list[ReasonOut]
    evaluated_at: datetime | None
    # True — ocena i metryki starsze niż próg (worker nie mierzy).
    stale: bool
    sampled_at: datetime | None
    # Wartości w jednostkach kanonicznych; None — niedostępne na tym hoście albo brak pomiaru.
    metrics: dict[str, float | None]
    percent: PercentOut
    components: list[ComponentOut]
    app_version: str
    server_time: datetime


async def require_owner(
    auth: Annotated[AuthContext, Depends(current_auth)], db: DbSession
) -> AuthContext:
    """Monitor serwera widzi tylko OWNER (D29)."""
    owner = await db.scalar(
        select(
            exists().where(Membership.user_id == auth.user.id, Membership.role == Role.OWNER.value)
        )
    )
    if not owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Brak uprawnień do stanu serwera.")
    return auth


@router.get("/health", response_model=SystemHealthOut)
async def system_health(
    db: DbSession, _: Annotated[AuthContext, Depends(require_owner)]
) -> SystemHealthOut:
    now = utcnow()
    row = await db.get(SystemStatus, STATUS_ROW_ID)
    stale = row is None or now - row.evaluated_at > STATUS_STALE_AFTER

    sampled_at = await db.scalar(select(func.max(SystemMetricSample.sampled_at)))
    metrics: dict[str, float | None] = dict.fromkeys(host.METRICS)
    if sampled_at is not None:
        samples = await db.execute(
            select(SystemMetricSample.metric, SystemMetricSample.value).where(
                SystemMetricSample.sampled_at == sampled_at
            )
        )
        metrics.update(dict(samples.all()))

    stored = {c.component: c for c in (await db.scalars(select(SystemComponent))).all()}
    components: list[ComponentOut] = []
    for name, label in COMPONENT_NAMES.items():
        component = stored.get(name)
        state = ComponentState(component.state) if component else ComponentState.UNKNOWN
        if name == "worker" and row is not None and stale:
            state = ComponentState.DOWN
        components.append(
            ComponentOut(
                component=name,
                name=label,
                state=state,
                checked_at=component.checked_at if component else None,
                last_ok_at=component.last_ok_at if component else None,
            )
        )

    reasons = [ReasonOut.model_validate(r) for r in row.reasons] if row else []
    level = Level(row.level) if row else Level.UNKNOWN
    if row is not None and stale:
        worker = COMPONENT_NAMES["worker"]
        reasons.insert(
            0,
            ReasonOut(
                code=component_code("worker"),
                severity=Severity.CRITICAL,
                message=f"Składnik niedostępny: {worker} — brak aktualnych pomiarów",
                since=row.evaluated_at,
            ),
        )
        level = Level.CRITICAL

    return SystemHealthOut(
        level=level,
        reasons=reasons,
        evaluated_at=row.evaluated_at if row else None,
        stale=stale,
        sampled_at=sampled_at,
        metrics=metrics,
        percent=PercentOut(
            memory=percent(metrics[host.MEM_USED], metrics[host.MEM_TOTAL]),
            swap=percent(metrics[host.SWAP_USED], metrics[host.SWAP_TOTAL]),
            disk=percent(metrics[host.DISK_USED], metrics[host.DISK_TOTAL]),
        ),
        components=components,
        app_version=__version__,
        server_time=now,
    )


# --- historia (D61) ---------------------------------------------------------------------

RangeName = Literal["24h", "7d", "30d"]
# Seria → jednostka; procenty liczone dla każdej próbki osobno (zajęte / całkowite), potem średnia.
SERIES_UNITS: dict[str, str] = {
    "cpu_percent": "%",
    "memory_percent": "%",
    "disk_percent": "%",
    "cpu_temp_c": "°C",
}


class PointOut(BaseModel):
    t: datetime
    # None — brak próbek w przedziale (luka), nie 0.
    avg: float | None
    max: float | None


class SeriesOut(BaseModel):
    unit: str
    points: list[PointOut]


class ForecastOut(BaseModel):
    status: trends.ForecastStatus
    full_at: datetime | None
    growth_bytes_per_day: float | None


class SystemMetricsOut(BaseModel):
    range: RangeName
    step_s: int
    start: datetime
    end: datetime
    series: dict[str, SeriesOut]
    disk_forecast: ForecastOut
    server_time: datetime


HISTORY_METRICS = (
    host.CPU_PERCENT,
    host.MEM_USED,
    host.MEM_TOTAL,
    host.DISK_USED,
    host.DISK_TOTAL,
    host.CPU_TEMP,
)


def _pick(metric: str) -> ColumnElement[float | None]:
    sample = SystemMetricSample
    return func.max(sample.value).filter(sample.metric == metric)


def _ratio(used: str, total: str) -> ColumnElement[float | None]:
    return _pick(used) * 100 / func.nullif(_pick(total), 0)


def _bin(
    step: timedelta, column: ColumnElement[datetime] | InstrumentedAttribute[datetime]
) -> ColumnElement[datetime]:
    return func.date_bin(
        literal(step, Interval()),
        column,
        literal(trends.ORIGIN, DateTime(timezone=True)),
        type_=DateTime(timezone=True),
    )


def _round(value: object) -> float | None:
    if value is None:
        return None
    if not isinstance(value, int | float):
        raise TypeError(type(value).__name__)
    return round(float(value), 2)


async def _series(
    db: DbSession, start: datetime, end: datetime, step: timedelta
) -> dict[str, SeriesOut]:
    sample = SystemMetricSample
    per_sample = (
        select(
            sample.sampled_at.label("t"),
            _pick(host.CPU_PERCENT).label("cpu_percent"),
            _ratio(host.MEM_USED, host.MEM_TOTAL).label("memory_percent"),
            _ratio(host.DISK_USED, host.DISK_TOTAL).label("disk_percent"),
            _pick(host.CPU_TEMP).label("cpu_temp_c"),
        )
        .where(
            sample.sampled_at >= trends.floor_to(start, step),
            sample.sampled_at <= end,
            sample.metric.in_(HISTORY_METRICS),
        )
        .group_by(sample.sampled_at)
        .subquery()
    )
    bucket = _bin(step, per_sample.c.t).label("bucket")
    columns: list[ColumnElement[float | None]] = []
    for name in SERIES_UNITS:
        columns += [func.avg(per_sample.c[name]), func.max(per_sample.c[name])]
    rows = (await db.execute(select(bucket, *columns).group_by(bucket))).all()

    found: dict[str, dict[datetime, trends.Bucket]] = {name: {} for name in SERIES_UNITS}
    for row in rows:
        for i, name in enumerate(SERIES_UNITS):
            avg, peak = row[1 + 2 * i], row[2 + 2 * i]
            if avg is not None:
                found[name][row[0]] = trends.Bucket(_round(avg), _round(peak))
    return {
        name: SeriesOut(
            unit=unit,
            points=[
                PointOut(t=t, avg=b.avg, max=b.max)
                for t, b in trends.fill(found[name], start, end, step)
            ],
        )
        for name, unit in SERIES_UNITS.items()
    }


async def _disk_forecast(db: DbSession, now: datetime) -> trends.Forecast:
    sample = SystemMetricSample
    hour = _bin(timedelta(hours=1), sample.sampled_at).label("hour")
    hourly = await db.execute(
        select(hour, func.avg(sample.value))
        .where(
            sample.metric == host.DISK_USED,
            sample.value.is_not(None),
            sample.sampled_at >= now - trends.FORECAST_WINDOW,
        )
        .group_by(hour)
    )
    points = [(t, float(v)) for t, v in hourly.all() if v is not None]
    total = await db.scalar(
        select(sample.value)
        .where(sample.metric == host.DISK_TOTAL, sample.value.is_not(None))
        .order_by(sample.sampled_at.desc())
        .limit(1)
    )
    return trends.disk_forecast(points, total, now)


@router.get("/metrics", response_model=SystemMetricsOut)
async def system_metrics(
    db: DbSession,
    _: Annotated[AuthContext, Depends(require_owner)],
    range_: Annotated[RangeName, Query(alias="range")] = "24h",
) -> SystemMetricsOut:
    now = utcnow()
    window = trends.RANGES[range_]
    start = now - window.span
    forecast = await _disk_forecast(db, now)
    return SystemMetricsOut(
        range=range_,
        step_s=int(window.step.total_seconds()),
        start=start,
        end=now,
        series=await _series(db, start, now, window.step),
        disk_forecast=ForecastOut(
            status=forecast.status,
            full_at=forecast.full_at,
            growth_bytes_per_day=_round(forecast.growth_bytes_per_day),
        ),
        server_time=now,
    )
