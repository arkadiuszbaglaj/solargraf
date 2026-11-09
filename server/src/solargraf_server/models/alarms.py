"""Alarmy instalacji (D55): otwiera i zamyka je ``worker``, potwierdza użytkownik."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, SmallInteger, String, text
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, uuid_pk


class AlarmSeverity(enum.StrEnum):
    CRITICAL = "CRITICAL"
    WARNING = "WARNING"
    INFO = "INFO"


class AlarmCode(enum.StrEnum):
    AGENT_UNREACHABLE = "AGENT_UNREACHABLE"
    DEVICE_READ_ERROR = "DEVICE_READ_ERROR"
    DEVICE_STALE = "DEVICE_STALE"
    DEVICE_PARTIAL_READ = "DEVICE_PARTIAL_READ"


def _in(values: type[enum.StrEnum], column: str) -> str:
    return f"{column} IN ({', '.join(repr(v.value) for v in values)})"


class Alarm(Base):
    __tablename__ = "alarms"
    __table_args__ = (
        CheckConstraint(_in(AlarmSeverity, "severity"), name="severity"),
        CheckConstraint(_in(AlarmCode, "code"), name="code"),
        CheckConstraint("clear_count >= 0", name="clear_count"),
        CheckConstraint("closed_at IS NULL OR closed_at >= opened_at", name="closed_after_opened"),
        # Najwyżej jeden otwarty alarm na (instalacja, kod, przedmiot).
        Index(
            "uq_alarms_open_subject",
            "site_id",
            "code",
            "subject",
            unique=True,
            postgresql_where=text("closed_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), index=True
    )
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), index=True
    )
    # Przedmiot alarmu, np. ``device:<uuid>`` albo ``agent:<uuid>`` — klucz deduplikacji.
    subject: Mapped[str] = mapped_column(String(64))
    code: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(300))
    details: Mapped[str | None] = mapped_column(String(500))
    # Ostatni udany odczyt urządzenia albo heartbeat agenta (UTC); null = nigdy. UI formatuje czas.
    last_ok_at: Mapped[datetime | None]
    rule_version: Mapped[int] = mapped_column(SmallInteger)
    opened_at: Mapped[datetime]
    last_seen_at: Mapped[datetime]
    closed_at: Mapped[datetime | None] = mapped_column(index=True)
    # Liczba kolejnych sprawdzeń bez warunku (histereza zamykania, D55).
    clear_count: Mapped[int] = mapped_column(Integer, default=0)
    acknowledged_at: Mapped[datetime | None]
    acknowledged_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
