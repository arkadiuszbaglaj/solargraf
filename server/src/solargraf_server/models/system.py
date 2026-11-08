"""Monitor serwera (D16, D60): próbki metryk hosta, stan składników i ocena stabilności.

Dane globalne dla serwera (nie należą do organizacji ani instalacji); odczyt tylko dla OWNER.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, Float, ForeignKey, Index, SmallInteger, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, uuid_pk
from solargraf_server.system.host import METRICS
from solargraf_server.system.stability import COMPONENT_NAMES, ComponentState, Level, Severity

STATUS_ROW_ID = 1


def _in(values: tuple[str, ...] | list[str], column: str) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class SystemMetricSample(Base):
    __tablename__ = "system_metric_samples"
    __table_args__ = (
        CheckConstraint(_in(METRICS, "metric"), name="metric"),
        Index("ix_system_metric_samples_metric_sampled_at", "metric", "sampled_at"),
    )

    sampled_at: Mapped[datetime] = mapped_column(primary_key=True)
    metric: Mapped[str] = mapped_column(String(32), primary_key=True)
    # None — metryka niedostępna na tym hoście (nigdy 0).
    value: Mapped[float | None] = mapped_column(Float)


class SystemComponent(Base):
    __tablename__ = "system_components"
    __table_args__ = (
        CheckConstraint(_in(list(COMPONENT_NAMES), "component"), name="component"),
        CheckConstraint(_in([s.value for s in ComponentState], "state"), name="state"),
    )

    component: Mapped[str] = mapped_column(String(16), primary_key=True)
    state: Mapped[str] = mapped_column(String(16))
    checked_at: Mapped[datetime]
    last_ok_at: Mapped[datetime | None]


class SystemStatus(Base):
    """Jeden wiersz: ostatnia ocena workera. ``evaluated_at`` jest też heartbeatem workera."""

    __tablename__ = "system_status"
    __table_args__ = (
        CheckConstraint(f"id = {STATUS_ROW_ID}", name="single_row"),
        CheckConstraint(_in([v.value for v in Level], "level"), name="level"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    evaluated_at: Mapped[datetime]
    level: Mapped[str] = mapped_column(String(16))
    # Aktywne przyczyny: [{code, severity, message, since}].
    reasons: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    # Stan histerezy warunków (``stability.Evaluation.to_json``).
    conditions: Mapped[dict[str, Any]] = mapped_column(JSONB)


class SystemAlarm(Base):
    """Alarm systemowy (P7.1d, D68): przyczyna oceny D60 od włączenia do wyłączenia warunku.

    Otwiera i zamyka ``worker`` razem z oceną (histereza jest w ocenie); najwyżej jeden otwarty
    alarm na kod. Potwierdza OWNER — potwierdzenie nie zamyka alarmu.
    """

    __tablename__ = "system_alarms"
    __table_args__ = (
        CheckConstraint(_in([s.value for s in Severity], "severity"), name="severity"),
        CheckConstraint("closed_at IS NULL OR closed_at >= opened_at", name="closed_after_opened"),
        Index(
            "uq_system_alarms_open_code",
            "code",
            unique=True,
            postgresql_where=text("closed_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    # Kod przyczyny z oceny, np. ``DISK_FULL`` albo ``COMPONENT_DOWN:agent``.
    code: Mapped[str] = mapped_column(String(48))
    severity: Mapped[str] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(String(300))
    opened_at: Mapped[datetime]
    last_seen_at: Mapped[datetime]
    closed_at: Mapped[datetime | None] = mapped_column(index=True)
    acknowledged_at: Mapped[datetime | None]
    acknowledged_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
