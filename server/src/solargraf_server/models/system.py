"""Monitor serwera (D16, D60): próbki metryk hosta, stan składników i ocena stabilności.

Dane globalne dla serwera (nie należą do organizacji ani instalacji); odczyt tylko dla OWNER.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, Float, Index, SmallInteger, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base
from solargraf_server.system.host import METRICS
from solargraf_server.system.stability import COMPONENT_NAMES, ComponentState, Level

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
