"""API monitora serwera (D16, D60): tylko rola OWNER — dane ujawniają infrastrukturę.

Odpowiedź nie zawiera nazw hostów, adresów, ścieżek, procesów ani zmiennych środowiskowych.
Ocena pochodzi z workera; jeśli jest starsza niż ``STATUS_STALE_AFTER``, worker jest uznany za
niedostępny, a ocena za krytyczną (metryki są wtedy nieaktualne, nie zerowe).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import exists, func, select

from solargraf_server import __version__
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth
from solargraf_server.models import Membership, Role
from solargraf_server.models.system import (
    STATUS_ROW_ID,
    SystemComponent,
    SystemMetricSample,
    SystemStatus,
)
from solargraf_server.system import host
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
        metrics.update(dict(samples.tuples().all()))

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
