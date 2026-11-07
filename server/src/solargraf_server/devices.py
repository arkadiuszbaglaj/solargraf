"""Endpoint /api/sites/{id}/devices (D38). Dostęp wyłącznie przez moduł ``authz``."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from solargraf_server import authz
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, utcnow
from solargraf_server.device_status import AgentState, DeviceState, DeviceStatus, device_status
from solargraf_server.models import Agent, Connection, Device, DeviceKind, Transport
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["devices"])


class ConnectionOut(BaseModel):
    id: uuid.UUID
    name: str
    transport: Transport
    host: str | None
    port: int | None
    unit_id: int | None
    poll_interval_seconds: int | None


class DeviceDetails(BaseModel):
    """Szczegóły techniczne — tylko dla OWNER/ADMIN (D38)."""

    firmware_version: str | None
    serial_number: str | None
    profile_id: str | None
    profile_version: str | None
    connection: ConnectionOut


class DeviceOut(BaseModel):
    id: uuid.UUID
    parent_device_id: uuid.UUID | None
    name: str
    kind: DeviceKind
    manufacturer: str | None
    model: str | None
    enabled: bool
    status: DeviceStatus
    last_success_at: datetime | None
    details: DeviceDetails | None


def _details(device: Device, conn: Connection) -> DeviceDetails:
    return DeviceDetails(
        firmware_version=device.firmware_version,
        serial_number=device.serial_number,
        profile_id=device.profile_id,
        profile_version=device.profile_version,
        connection=ConnectionOut(
            id=conn.id,
            name=conn.name,
            transport=Transport(conn.transport),
            host=conn.host,
            port=conn.port,
            unit_id=conn.unit_id,
            poll_interval_seconds=conn.poll_interval_seconds,
        ),
    )


@router.get("/{site_id}/devices", response_model=list[DeviceOut])
async def list_devices(
    site_id: uuid.UUID, db: DbSession, auth: Annotated[AuthContext, Depends(current_auth)]
) -> list[DeviceOut]:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    show_details = authz.role_allows(access.role, authz.SiteAction.MANAGE)
    rows = await db.execute(
        select(Device, Connection, Agent)
        .join(
            Connection,
            (Connection.id == Device.connection_id) & (Connection.site_id == Device.site_id),
        )
        .outerjoin(Agent, Agent.id == Connection.agent_id)
        .where(Device.site_id == access.site.id)
        .order_by(Device.name, Device.id)
    )
    now = utcnow()
    result: list[DeviceOut] = []
    for device, conn, agent in rows:
        state = DeviceState(
            enabled=device.enabled,
            last_attempt_at=device.last_attempt_at,
            last_success_at=device.last_success_at,
            freshness_threshold=timedelta(seconds=device.freshness_threshold_seconds),
        )
        agent_state = None if agent is None else AgentState(agent.enabled, agent.last_heartbeat_at)
        result.append(
            DeviceOut(
                id=device.id,
                parent_device_id=device.parent_device_id,
                name=device.name,
                kind=DeviceKind(device.kind),
                manufacturer=device.manufacturer,
                model=device.model,
                enabled=device.enabled,
                status=device_status(state, agent_state, now),
                last_success_at=device.last_success_at,
                details=_details(device, conn) if show_details else None,
            )
        )
    return result
