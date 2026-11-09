"""Alarmy instalacji w API (D55): lista i potwierdzanie. Uprawnienia przez ``authz``.

- ``GET /api/sites/{id}/alarms`` — otwarte i zamknięte w ostatnich ``days`` dobach (domyślnie
  1 = 24 h), strona ``offset``/``limit``; kolejność: otwarte niepotwierdzone, otwarte potwierdzone,
  zamknięte; w grupie priorytet, potem najnowsze. Filtry ``state`` i ``severity`` działają po
  stronie serwera; ``total`` to liczba pasujących, ``summary`` liczy cały okres bez filtrów.
  VIEWER czyta tylko 24 h; dłuższa historia (D76) wymaga OWNER/ADMIN — inaczej 403.
  ``can_acknowledge`` i ``can_view_history`` mówią UI, które elementy pokazać.
- ``POST /api/sites/{id}/alarms/{alarm_id}/acknowledge`` — OWNER/ADMIN, z CSRF. Nie zamyka
  alarmu (zamyka go ``worker``, gdy warunek ustąpi); można potwierdzić także zamknięty.
  Ponowne potwierdzenie nie zmienia, kto i kiedy potwierdził. Wpis w dzienniku audytu.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import ColumnElement, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server import authz
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, require_csrf, utcnow
from solargraf_server.models import Alarm, AlarmSeverity, User
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["alarms"])

CLOSED_WINDOW = timedelta(hours=24)
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
FORBIDDEN = "Brak uprawnień."
FORBIDDEN_HISTORY = (
    "Historia alarmów starszych niż 24 h jest dostępna dla właściciela i administratora."
)

HISTORY_DAYS = (1, 7, 30, 90, 365)  # 365 = retencja zamkniętych alarmów (D55)
StateFilter = Literal["all", "active", "unacknowledged", "closed"]


class AlarmOut(BaseModel):
    id: uuid.UUID
    code: str
    severity: AlarmSeverity
    title: str
    details: str | None
    device_id: uuid.UUID | None
    # Ostatni udany odczyt (alarmy urządzeń) albo heartbeat (agent); null = nigdy.
    last_ok_at: datetime | None
    opened_at: datetime
    last_seen_at: datetime
    closed_at: datetime | None
    acknowledged_at: datetime | None
    # Nazwa wyświetlana potwierdzającego (członek organizacji); bez e-maila.
    acknowledged_by: str | None


class AlarmSummaryOut(BaseModel):
    """Liczby w całym okresie, niezależnie od filtrów i strony."""

    critical_active: int
    warning_active: int
    unacknowledged: int
    closed: int


class AlarmListOut(BaseModel):
    alarms: list[AlarmOut]
    can_acknowledge: bool
    can_view_history: bool
    days: int
    total: int
    has_more: bool
    summary: AlarmSummaryOut


def _state_filter(state: StateFilter) -> ColumnElement[bool] | None:
    if state == "active":
        return Alarm.closed_at.is_(None)
    if state == "unacknowledged":
        return Alarm.acknowledged_at.is_(None)
    if state == "closed":
        return Alarm.closed_at.is_not(None)
    return None


async def _authorize(
    db: AsyncSession, auth: AuthContext, site_id: uuid.UUID, action: authz.SiteAction
) -> authz.SiteAccess:
    try:
        return await authz.authorize_site(db, auth.user.id, site_id, action)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    except authz.ForbiddenError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN) from None


def _out(alarm: Alarm, acknowledged_by: str | None) -> AlarmOut:
    return AlarmOut(
        id=alarm.id,
        code=alarm.code,
        severity=AlarmSeverity(alarm.severity),
        title=alarm.title,
        details=alarm.details,
        device_id=alarm.device_id,
        last_ok_at=alarm.last_ok_at,
        opened_at=alarm.opened_at,
        last_seen_at=alarm.last_seen_at,
        closed_at=alarm.closed_at,
        acknowledged_at=alarm.acknowledged_at,
        acknowledged_by=acknowledged_by,
    )


@router.get("/{site_id}/alarms", response_model=AlarmListOut)
async def list_alarms(
    site_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(current_auth)],
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
    days: Annotated[int, Query(ge=1, le=365)] = 1,
    state: StateFilter = "all",
    severity: AlarmSeverity | None = None,
) -> AlarmListOut:
    if days not in HISTORY_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Dozwolony okres: 1, 7, 30, 90 albo 365 dni."
        )
    access = await _authorize(db, auth, site_id, authz.SiteAction.READ)
    can_manage = authz.role_allows(access.role, authz.SiteAction.MANAGE)
    if days > 1 and not can_manage:
        raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN_HISTORY)
    window = timedelta(days=days) if days > 1 else CLOSED_WINDOW
    in_period = (Alarm.site_id == access.site.id) & or_(
        Alarm.closed_at.is_(None), Alarm.closed_at >= utcnow() - window
    )
    active = Alarm.closed_at.is_(None)
    counts = (
        await db.execute(
            select(
                func.count().filter(active & (Alarm.severity == AlarmSeverity.CRITICAL.value)),
                func.count().filter(active & (Alarm.severity == AlarmSeverity.WARNING.value)),
                func.count().filter(Alarm.acknowledged_at.is_(None)),
                func.count().filter(Alarm.closed_at.is_not(None)),
            ).where(in_period)
        )
    ).one()
    filters: list[ColumnElement[bool]] = [in_period]
    by_state = _state_filter(state)
    if by_state is not None:
        filters.append(by_state)
    if severity is not None:
        filters.append(Alarm.severity == severity.value)
    total = await db.scalar(select(func.count()).select_from(Alarm).where(*filters)) or 0
    group = case(
        (Alarm.closed_at.is_(None) & Alarm.acknowledged_at.is_(None), 0),
        (Alarm.closed_at.is_(None), 1),
        else_=2,
    )
    rank = case(
        (Alarm.severity == AlarmSeverity.CRITICAL.value, 0),
        (Alarm.severity == AlarmSeverity.WARNING.value, 1),
        else_=2,
    )
    rows = await db.execute(
        select(Alarm, User.display_name)
        .outerjoin(User, User.id == Alarm.acknowledged_by)
        .where(*filters)
        .order_by(group, rank, Alarm.opened_at.desc(), Alarm.id)
        .offset(offset)
        .limit(limit)
    )
    alarms = [_out(alarm, name) for alarm, name in rows.all()]
    return AlarmListOut(
        alarms=alarms,
        can_acknowledge=can_manage,
        can_view_history=can_manage,
        days=days,
        total=total,
        has_more=offset + len(alarms) < total,
        summary=AlarmSummaryOut(
            critical_active=counts[0],
            warning_active=counts[1],
            unacknowledged=counts[2],
            closed=counts[3],
        ),
    )


@router.post("/{site_id}/alarms/{alarm_id}/acknowledge", response_model=AlarmOut)
async def acknowledge_alarm(
    site_id: uuid.UUID,
    alarm_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> AlarmOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    alarm = await db.scalar(
        select(Alarm).where(Alarm.id == alarm_id, Alarm.site_id == access.site.id).with_for_update()
    )
    if alarm is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    if alarm.acknowledged_at is None:
        alarm.acknowledged_at = utcnow()
        alarm.acknowledged_by = auth.user.id
        await auth_service.audit(
            db,
            "ALARM_ACKNOWLEDGED",
            user_id=auth.user.id,
            organization_id=access.site.organization_id,
            target=f"alarm:{alarm.id}",
        )
        await db.commit()
    name = (
        await db.scalar(select(User.display_name).where(User.id == alarm.acknowledged_by))
        if alarm.acknowledged_by is not None
        else None
    )
    return _out(alarm, name)
