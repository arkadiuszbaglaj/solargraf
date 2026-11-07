"""Alarmy instalacji w API (D55): lista i potwierdzanie. Uprawnienia przez ``authz``.

- ``GET /api/sites/{id}/alarms`` — otwarte i zamknięte w ostatnich ``CLOSED_WINDOW``, najwyżej
  ``limit``; kolejność: otwarte niepotwierdzone, otwarte potwierdzone, zamknięte; w grupie
  priorytet, potem najnowsze. VIEWER czyta; ``can_acknowledge`` mówi UI, czy pokazać przycisk.
- ``POST /api/sites/{id}/alarms/{alarm_id}/acknowledge`` — OWNER/ADMIN, z CSRF. Nie zamyka
  alarmu (zamyka go ``worker``, gdy warunek ustąpi); można potwierdzić także zamknięty.
  Ponowne potwierdzenie nie zmienia, kto i kiedy potwierdził. Wpis w dzienniku audytu.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import case, or_, select
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


class AlarmListOut(BaseModel):
    alarms: list[AlarmOut]
    can_acknowledge: bool


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
) -> AlarmListOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.READ)
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
        .where(
            Alarm.site_id == access.site.id,
            or_(Alarm.closed_at.is_(None), Alarm.closed_at >= utcnow() - CLOSED_WINDOW),
        )
        .order_by(group, rank, Alarm.opened_at.desc(), Alarm.id)
        .limit(limit)
    )
    return AlarmListOut(
        alarms=[_out(alarm, name) for alarm, name in rows.all()],
        can_acknowledge=authz.role_allows(access.role, authz.SiteAction.MANAGE),
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
