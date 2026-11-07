"""Agenci, połączenia i urządzenia (docs/DATA_MODEL.md, D38)."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_profiles.catalog import DeviceKind, Transport
from solargraf_server.models.base import Base, created_at, uuid_pk

__all__ = [
    "DEFAULT_FRESHNESS_THRESHOLD_S",
    "Agent",
    "AgentMode",
    "Connection",
    "Device",
    "DeviceKind",
    "Transport",
]


class AgentMode(enum.StrEnum):
    LOCAL = "LOCAL"
    REMOTE = "REMOTE"


def _in(values: type[enum.StrEnum], column: str) -> str:
    return f"{column} IN ({', '.join(repr(v.value) for v in values)})"


# Domyślny próg świeżości urządzenia [s]; profil urządzenia (P3) może go nadpisać.
DEFAULT_FRESHNESS_THRESHOLD_S = 300


class Agent(Base):
    """Jedyny klient urządzeń (D11). Komponent serwera — nie należy do organizacji (D38)."""

    __tablename__ = "agents"
    __table_args__ = (CheckConstraint(_in(AgentMode, "mode"), name="mode"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(100))
    mode: Mapped[str] = mapped_column(String(16))
    version: Mapped[str | None] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(default=True)
    last_heartbeat_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = created_at()


class Connection(Base):
    """Fizyczny punkt dostępu w LAN (logger, port Modbus TCP, bramka RS485)."""

    __tablename__ = "connections"
    __table_args__ = (
        CheckConstraint(_in(Transport, "transport"), name="transport"),
        CheckConstraint("port IS NULL OR (port BETWEEN 1 AND 65535)", name="port"),
        CheckConstraint("unit_id IS NULL OR (unit_id BETWEEN 0 AND 255)", name="unit_id"),
        CheckConstraint(
            "poll_interval_seconds IS NULL OR poll_interval_seconds > 0", name="poll_interval"
        ),
        CheckConstraint("timeout_seconds IS NULL OR timeout_seconds > 0", name="timeout"),
        # Cel klucza złożonego z devices: urządzenie i połączenie w tej samej instalacji.
        UniqueConstraint("id", "site_id", name="uq_connections_id_site_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), index=True
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="SET NULL"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    transport: Mapped[str] = mapped_column(String(32))
    host: Mapped[str | None] = mapped_column(String(253))
    port: Mapped[int | None] = mapped_column(Integer)
    unit_id: Mapped[int | None] = mapped_column(Integer)
    # Puste = wartości z profilu urządzenia (P3).
    poll_interval_seconds: Mapped[int | None] = mapped_column(Integer)
    timeout_seconds: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = created_at()


class Device(Base):
    """Urządzenie fizyczne albo podurządzenie logiczne (MPPT, BMS za falownikiem)."""

    __tablename__ = "devices"
    __table_args__ = (
        CheckConstraint(_in(DeviceKind, "kind"), name="kind"),
        CheckConstraint("freshness_threshold_seconds > 0", name="freshness_threshold"),
        ForeignKeyConstraint(
            ["connection_id", "site_id"],
            ["connections.id", "connections.site_id"],
            name="fk_devices_connection_site_connections",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), index=True
    )
    connection_id: Mapped[uuid.UUID] = mapped_column(index=True)
    parent_device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))
    # Nieznane do czasu odczytu z urządzenia albo wpisania — nigdy zgadywane.
    manufacturer: Mapped[str | None] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(100))
    firmware_version: Mapped[str | None] = mapped_column(String(100))
    serial_number: Mapped[str | None] = mapped_column(String(100))
    profile_id: Mapped[str | None] = mapped_column(String(100))
    profile_version: Mapped[str | None] = mapped_column(String(32))
    enabled: Mapped[bool] = mapped_column(default=True)
    last_attempt_at: Mapped[datetime | None]
    last_success_at: Mapped[datetime | None]
    freshness_threshold_seconds: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_FRESHNESS_THRESHOLD_S
    )
    created_at: Mapped[datetime] = created_at()
