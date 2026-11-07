"""Urządzenia i połączenia instalacji (D38, D44). Dostęp wyłącznie przez moduł ``authz``.

Odczyt: każdy członek z dostępem do instalacji. Zapis: OWNER/ADMIN; VIEWER → 403, cudza
instalacja albo cudze połączenie/urządzenie → 404. Agent jest jedynym klientem urządzenia —
serwer tylko zapisuje konfigurację, którą agent pobiera przez ``/api/agent/config``.
"""

from __future__ import annotations

import ipaddress
import re
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Literal, Self

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_profiles.catalog import METRICS
from solargraf_profiles.model import PointStatus, Profile, SupportLevel
from solargraf_server import authz
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, require_csrf, utcnow
from solargraf_server.device_status import (
    AgentState,
    AgentStatus,
    DeviceState,
    DeviceStatus,
    agent_status,
    device_status,
)
from solargraf_server.models import (
    DEFAULT_FRESHNESS_THRESHOLD_S,
    Agent,
    AgentMode,
    Connection,
    Device,
    DeviceKind,
    Measurement,
    PollingRun,
    Transport,
)
from solargraf_server.profiles import Catalog, ProfileCatalog
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["devices"])

MODBUS_TCP_PORT = 502
FRESHNESS_INTERVALS = 3
NOT_FOUND_DEVICE = "Nie znaleziono urządzenia."
NOT_FOUND_CONNECTION = "Nie znaleziono połączenia."
FORBIDDEN = "Brak uprawnień."

# --- adres urządzenia (D44) ---

_PRIVATE_V4 = tuple(
    ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
_LABEL = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$")


def validate_host(value: str) -> str:
    """Prywatny IPv4 albo nazwa hosta w LAN; reszta odrzucona (agent łączy się z tym adresem)."""
    host = value.strip().rstrip(".").lower()
    if not host or len(host) > 253:
        raise ValueError("Podaj adres urządzenia.")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if ip.version != 4 or not any(ip in net for net in _PRIVATE_V4):
            raise ValueError(
                "Dozwolone są adresy prywatne IPv4 (10.x, 172.16-31.x, 192.168.x) albo nazwa hosta."
            )
        return host
    labels = host.split(".")
    if not all(_LABEL.match(label) for label in labels):
        raise ValueError("Nieprawidłowa nazwa hosta.")
    if labels[-1].isdigit():
        raise ValueError("Nieprawidłowy adres IP.")
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("Adres lokalny serwera jest niedozwolony.")
    return host


def _clean_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Nazwa nie może być pusta.")
    return value


# --- modele ---


class ConnectionOut(BaseModel):
    id: uuid.UUID
    name: str
    transport: Transport
    host: str | None
    port: int | None
    unit_id: int | None
    poll_interval_seconds: int | None
    timeout_seconds: int | None


class DeviceDetails(BaseModel):
    """Szczegóły techniczne — tylko dla OWNER/ADMIN (D38)."""

    firmware_version: str | None
    serial_number: str | None
    profile_id: str | None
    profile_version: str | None
    connection: ConnectionOut


class DeviceMetric(BaseModel):
    """Metryka z profilu urządzenia (D47) — bez rejestrów i innych szczegółów technicznych."""

    key: str
    channel: int | None
    name: str
    unit: str
    cumulative: bool


def device_metrics(profile: Profile | None) -> list[DeviceMetric]:
    """Metryki, które profil udostępnia (bez UNSUPPORTED), w kolejności katalogu."""
    if profile is None:
        return []
    order = {key: i for i, key in enumerate(METRICS)}
    keys = sorted(
        {(p.metric, p.channel) for p in profile.points if p.status is not PointStatus.UNSUPPORTED},
        key=lambda k: (order.get(k[0], len(order)), k[1] or 0),
    )
    return [
        DeviceMetric(
            key=key,
            channel=channel,
            name=METRICS[key].display_name,
            unit=METRICS[key].canonical_unit.value,
            cumulative=METRICS[key].cumulative,
        )
        for key, channel in keys
        if key in METRICS
    ]


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
    # Agent połączenia urządzenia (tylko identyfikator, D52); None — połączenie bez agenta.
    agent_id: uuid.UUID | None = None
    details: DeviceDetails | None
    metrics: list[DeviceMetric] = []
    # Poziom wsparcia profilu (D58) dla wszystkich ról; None — profil spoza katalogu serwera.
    support_level: SupportLevel | None = None


class AgentOut(BaseModel):
    id: uuid.UUID
    name: str
    status: AgentStatus
    last_heartbeat_at: datetime | None
    # Wersja agenta tylko dla OWNER/ADMIN (D52); token i adresy nigdy.
    version: str | None


Name = Annotated[str, Field(min_length=1, max_length=200)]
Interval = Annotated[int, Field(ge=1, le=3600)]
Timeout = Annotated[int, Field(ge=1, le=60)]


class DeviceIn(BaseModel):
    name: Name
    profile_id: str = Field(max_length=100)
    profile_version: str = Field(max_length=32)

    _name = field_validator("name")(_clean_name)


class ConnectionSettings(BaseModel):
    name: Name
    host: str = Field(max_length=253)
    port: int = Field(default=MODBUS_TCP_PORT, ge=1, le=65535)
    unit_id: int = Field(default=1, ge=0, le=255)
    poll_interval_seconds: Interval | None = None
    timeout_seconds: Timeout | None = None

    _name = field_validator("name")(_clean_name)
    _host = field_validator("host")(validate_host)

    @model_validator(mode="after")
    def _timeout_below_interval(self) -> Self:
        interval, timeout = self.poll_interval_seconds, self.timeout_seconds
        if interval is not None and timeout is not None and timeout >= interval:
            raise ValueError("Limit czasu musi być krótszy niż interwał odczytu.")
        return self


class ConnectionCreate(ConnectionSettings):
    transport: Literal["MODBUS_TCP"] = "MODBUS_TCP"
    device: DeviceIn


class DeviceUpdate(BaseModel):
    name: Name | None = None
    enabled: bool | None = None

    _name = field_validator("name")(_clean_name)


class CreatedOut(BaseModel):
    connection: ConnectionOut
    device: DeviceOut


# --- pomocnicze ---


def _connection_out(conn: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        name=conn.name,
        transport=Transport(conn.transport),
        host=conn.host,
        port=conn.port,
        unit_id=conn.unit_id,
        poll_interval_seconds=conn.poll_interval_seconds,
        timeout_seconds=conn.timeout_seconds,
    )


def _device_out(
    device: Device,
    conn: Connection,
    agent: Agent | None,
    *,
    details: bool,
    now: datetime,
    catalog: ProfileCatalog | None = None,
) -> DeviceOut:
    state = DeviceState(
        enabled=device.enabled,
        last_attempt_at=device.last_attempt_at,
        last_success_at=device.last_success_at,
        freshness_threshold=timedelta(seconds=device.freshness_threshold_seconds),
    )
    agent_state = None if agent is None else AgentState(agent.enabled, agent.last_heartbeat_at)
    profile = _device_profile(catalog, device)
    return DeviceOut(
        id=device.id,
        parent_device_id=device.parent_device_id,
        name=device.name,
        kind=DeviceKind(device.kind),
        manufacturer=device.manufacturer,
        model=device.model,
        enabled=device.enabled,
        status=device_status(state, agent_state, now),
        last_success_at=device.last_success_at,
        agent_id=conn.agent_id,
        details=DeviceDetails(
            firmware_version=device.firmware_version,
            serial_number=device.serial_number,
            profile_id=device.profile_id,
            profile_version=device.profile_version,
            connection=_connection_out(conn),
        )
        if details
        else None,
        metrics=device_metrics(profile),
        support_level=profile.support_level if profile is not None else None,
    )


def _device_profile(catalog: ProfileCatalog | None, device: Device) -> Profile | None:
    if catalog is None or device.profile_id is None or device.profile_version is None:
        return None
    return catalog.get(device.profile_id, device.profile_version)


async def _authorize(
    db: AsyncSession, auth: AuthContext, site_id: uuid.UUID, action: authz.SiteAction
) -> authz.SiteAccess:
    try:
        return await authz.authorize_site(db, auth.user.id, site_id, action)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    except authz.ForbiddenError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN) from None


def _profile(catalog: Catalog, body: DeviceIn) -> Profile:
    profile = catalog.get(body.profile_id, body.profile_version)
    if profile is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Nieznany profil urządzenia.")
    if Transport.MODBUS_TCP not in profile.transports:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Profil nie obsługuje połączenia Modbus TCP."
        )
    return profile


def freshness_threshold(conn: Connection, profile: Profile | None) -> int:
    """Próg świeżości: max(300 s, 3 * interwał odczytu) (D44)."""
    interval = conn.poll_interval_seconds or (profile.polling.interval_seconds if profile else 0)
    return max(DEFAULT_FRESHNESS_THRESHOLD_S, FRESHNESS_INTERVALS * interval)


async def _local_agent(db: AsyncSession) -> Agent:
    agents = (
        await db.scalars(
            select(Agent).where(Agent.mode == AgentMode.LOCAL.value, Agent.enabled.is_(True))
        )
    ).all()
    if len(agents) != 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Brak jednoznacznego agenta lokalnego — uruchom ponownie instalator albo "
            "sprawdź `solargraf-admin agent list`.",
        )
    return agents[0]


async def _connection(db: AsyncSession, site_id: uuid.UUID, conn_id: uuid.UUID) -> Connection:
    conn = await db.scalar(
        select(Connection).where(Connection.id == conn_id, Connection.site_id == site_id)
    )
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_CONNECTION)
    return conn


async def _device_row(
    db: AsyncSession, site_id: uuid.UUID, device_id: uuid.UUID
) -> tuple[Device, Connection, Agent | None]:
    row = (
        await db.execute(
            select(Device, Connection, Agent)
            .join(
                Connection,
                (Connection.id == Device.connection_id) & (Connection.site_id == Device.site_id),
            )
            .outerjoin(Agent, Agent.id == Connection.agent_id)
            .where(Device.id == device_id, Device.site_id == site_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND_DEVICE)
    device, conn, agent = row
    return device, conn, agent


def _new_device(site_id: uuid.UUID, conn: Connection, body: DeviceIn, profile: Profile) -> Device:
    return Device(
        site_id=site_id,
        connection_id=conn.id,
        name=body.name,
        kind=profile.device_kind.value,
        manufacturer=profile.manufacturer,
        profile_id=profile.id,
        profile_version=profile.version,
        enabled=True,
        freshness_threshold_seconds=freshness_threshold(conn, profile),
    )


async def _audit(
    db: AsyncSession, auth: AuthContext, access: authz.SiteAccess, action: str, target: str
) -> None:
    await auth_service.audit(
        db,
        action,
        user_id=auth.user.id,
        organization_id=access.site.organization_id,
        target=target,
    )


# --- odczyt ---


@router.get("/{site_id}/devices", response_model=list[DeviceOut])
async def list_devices(
    site_id: uuid.UUID,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(current_auth)],
) -> list[DeviceOut]:
    access = await _authorize(db, auth, site_id, authz.SiteAction.READ)
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
    return [
        _device_out(d, c, a, details=show_details, now=now, catalog=catalog) for d, c, a in rows
    ]


@router.get("/{site_id}/agents", response_model=list[AgentOut])
async def list_site_agents(
    site_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(current_auth)],
) -> list[AgentOut]:
    """Agenci obsługujący połączenia instalacji ze statusem z heartbeatu (D52)."""
    access = await _authorize(db, auth, site_id, authz.SiteAction.READ)
    show_version = authz.role_allows(access.role, authz.SiteAction.MANAGE)
    agents = await db.scalars(
        select(Agent)
        .where(
            exists().where(Connection.agent_id == Agent.id, Connection.site_id == access.site.id)
        )
        .order_by(Agent.name, Agent.id)
    )
    now = utcnow()
    return [
        AgentOut(
            id=a.id,
            name=a.name,
            status=agent_status(AgentState(a.enabled, a.last_heartbeat_at), now),
            last_heartbeat_at=a.last_heartbeat_at,
            version=a.version if show_version else None,
        )
        for a in agents
    ]


# --- zapis (D44) ---


@router.post(
    "/{site_id}/connections", status_code=status.HTTP_201_CREATED, response_model=CreatedOut
)
async def create_connection(
    site_id: uuid.UUID,
    body: ConnectionCreate,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> CreatedOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    profile = _profile(catalog, body.device)
    agent = await _local_agent(db)
    conn = Connection(
        site_id=access.site.id,
        agent_id=agent.id,
        name=body.name,
        transport=Transport.MODBUS_TCP.value,
        host=body.host,
        port=body.port,
        unit_id=body.unit_id,
        poll_interval_seconds=body.poll_interval_seconds,
        timeout_seconds=body.timeout_seconds,
    )
    db.add(conn)
    await db.flush()
    device = _new_device(access.site.id, conn, body.device, profile)
    db.add(device)
    await db.flush()
    await _audit(db, auth, access, "CONNECTION_CREATED", f"connection:{conn.id}")
    await _audit(db, auth, access, "DEVICE_CREATED", f"device:{device.id}")
    await db.commit()
    return CreatedOut(
        connection=_connection_out(conn),
        device=_device_out(device, conn, agent, details=True, now=utcnow()),
    )


@router.post(
    "/{site_id}/connections/{conn_id}/devices",
    status_code=status.HTTP_201_CREATED,
    response_model=DeviceOut,
)
async def add_device(
    site_id: uuid.UUID,
    conn_id: uuid.UUID,
    body: DeviceIn,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> DeviceOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    conn = await _connection(db, access.site.id, conn_id)
    profile = _profile(catalog, body)
    device = _new_device(access.site.id, conn, body, profile)
    db.add(device)
    await db.flush()
    await _audit(db, auth, access, "DEVICE_CREATED", f"device:{device.id}")
    await db.commit()
    agent = await db.get(Agent, conn.agent_id) if conn.agent_id else None
    return _device_out(device, conn, agent, details=True, now=utcnow())


@router.patch("/{site_id}/connections/{conn_id}", response_model=ConnectionOut)
async def update_connection(
    site_id: uuid.UUID,
    conn_id: uuid.UUID,
    body: ConnectionSettings,
    db: DbSession,
    catalog: Catalog,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> ConnectionOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    conn = await _connection(db, access.site.id, conn_id)
    conn.name = body.name
    conn.host = body.host
    conn.port = body.port
    conn.unit_id = body.unit_id
    conn.poll_interval_seconds = body.poll_interval_seconds
    conn.timeout_seconds = body.timeout_seconds
    for device in (await db.scalars(select(Device).where(Device.connection_id == conn.id))).all():
        profile = catalog.get(device.profile_id or "", device.profile_version or "")
        device.freshness_threshold_seconds = freshness_threshold(conn, profile)
    await _audit(db, auth, access, "CONNECTION_UPDATED", f"connection:{conn.id}")
    await db.commit()
    return _connection_out(conn)


@router.patch("/{site_id}/devices/{device_id}", response_model=DeviceOut)
async def update_device(
    site_id: uuid.UUID,
    device_id: uuid.UUID,
    body: DeviceUpdate,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> DeviceOut:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    device, conn, agent = await _device_row(db, access.site.id, device_id)
    if body.name is not None:
        device.name = body.name
    if body.enabled is not None:
        device.enabled = body.enabled
    await _audit(db, auth, access, "DEVICE_UPDATED", f"device:{device.id}")
    await db.commit()
    return _device_out(device, conn, agent, details=True, now=utcnow())


@router.delete("/{site_id}/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(
    site_id: uuid.UUID,
    device_id: uuid.UUID,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(require_csrf)],
) -> Response:
    access = await _authorize(db, auth, site_id, authz.SiteAction.MANAGE)
    device, conn, _ = await _device_row(db, access.site.id, device_id)
    has_data = await db.scalar(
        select(
            exists().where(Measurement.device_id == device.id)
            | exists().where(PollingRun.device_id == device.id)
        )
    )
    if has_data:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Urządzenie ma zapisane dane — wyłącz je zamiast usuwać.",
        )
    await db.delete(device)
    await db.flush()
    await _audit(db, auth, access, "DEVICE_DELETED", f"device:{device_id}")
    remaining = await db.scalar(
        select(func.count()).select_from(Device).where(Device.connection_id == conn.id)
    )
    if not remaining:
        await db.delete(conn)
        await _audit(db, auth, access, "CONNECTION_DELETED", f"connection:{conn.id}")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
