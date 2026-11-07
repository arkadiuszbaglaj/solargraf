"""Pomiary, cykle odczytu i partie od agentów (D42).

Brak odczytu to wiersz z ``value = NULL`` i jakością ``MISSING`` — nigdy zero.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    Double,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    SmallInteger,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, created_at, uuid_pk


class Quality(enum.StrEnum):
    GOOD = "GOOD"
    ESTIMATED = "ESTIMATED"
    STALE = "STALE"
    INVALID = "INVALID"
    MISSING = "MISSING"


class MeasurementOrigin(enum.StrEnum):
    DEVICE = "DEVICE"
    DERIVED = "DERIVED"
    SIMULATED = "SIMULATED"
    DEMO = "DEMO"


class RunResult(enum.StrEnum):
    OK = "OK"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


class PollErrorCode(enum.StrEnum):
    TIMEOUT = "TIMEOUT"
    CONNECTION_REFUSED = "CONNECTION_REFUSED"
    CONNECTION_LOST = "CONNECTION_LOST"
    MODBUS_EXCEPTION = "MODBUS_EXCEPTION"
    INVALID_RESPONSE = "INVALID_RESPONSE"


def _in(values: type[enum.StrEnum], column: str) -> str:
    return f"{column} IN ({', '.join(repr(v.value) for v in values)})"


# Kanał 0 = metryka bez kanałów (NULL nie może być częścią klucza głównego).
NO_CHANNEL = 0


class AgentBatch(Base):
    """Przyjęte partie — ponowne wysłanie tej samej partii niczego nie duplikuje."""

    __tablename__ = "agent_batches"
    __table_args__ = (PrimaryKeyConstraint("agent_id", "batch_id", name="pk_agent_batches"),)

    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    batch_id: Mapped[uuid.UUID]
    received_at: Mapped[datetime] = created_at()


class PollingRun(Base):
    __tablename__ = "polling_runs"
    __table_args__ = (
        CheckConstraint(_in(RunResult, "result"), name="result"),
        CheckConstraint(f"error_code IS NULL OR {_in(PollErrorCode, 'error_code')}", name="error"),
        CheckConstraint("ok_points >= 0 AND failed_points >= 0", name="points"),
        Index("ix_polling_runs_device_id_started_at", "device_id", "started_at"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"))
    batch_id: Mapped[uuid.UUID]
    started_at: Mapped[datetime]
    finished_at: Mapped[datetime]
    result: Mapped[str] = mapped_column(String(16))
    error_code: Mapped[str | None] = mapped_column(String(32))
    error_detail: Mapped[str | None] = mapped_column(String(200))
    ok_points: Mapped[int] = mapped_column(Integer)
    failed_points: Mapped[int] = mapped_column(Integer)


class Measurement(Base):
    """Tabela partycjonowana miesięcznie po ``received_at`` (partycje w migracji 0005)."""

    __tablename__ = "measurements"
    __table_args__ = (
        PrimaryKeyConstraint(
            "device_id", "metric", "channel", "received_at", name="pk_measurements"
        ),
        CheckConstraint(_in(Quality, "quality"), name="quality"),
        CheckConstraint(_in(MeasurementOrigin, "origin"), name="origin"),
        CheckConstraint("channel >= 0", name="channel"),
        CheckConstraint(
            "(quality = 'MISSING' AND value IS NULL) OR (quality = 'GOOD' AND value IS NOT NULL) "
            "OR quality NOT IN ('MISSING', 'GOOD')",
            name="value_quality",
        ),
        Index("ix_measurements_site_id_received_at", "site_id", "received_at"),
        {"postgresql_partition_by": "RANGE (received_at)"},
    )

    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    metric: Mapped[str] = mapped_column(String(64))
    channel: Mapped[int] = mapped_column(SmallInteger, default=NO_CHANNEL)
    received_at: Mapped[datetime]
    observed_at: Mapped[datetime | None]
    value: Mapped[float | None] = mapped_column(Double)
    quality: Mapped[str] = mapped_column(String(16))
    origin: Mapped[str] = mapped_column(String(16))
    batch_id: Mapped[uuid.UUID]


class Resolution(enum.StrEnum):
    M5 = "5m"
    H1 = "1h"
    D1 = "1d"


class Aggregate(Base):
    """Agregat metryki urządzenia w przedziale (D46). Liczony przez ``worker`` z próbek GOOD."""

    __tablename__ = "aggregates"
    __table_args__ = (
        PrimaryKeyConstraint(
            "device_id", "metric", "channel", "resolution", "bucket_start", name="pk_aggregates"
        ),
        CheckConstraint(_in(Resolution, "resolution"), name="resolution"),
        CheckConstraint("good_samples >= 0 AND samples >= good_samples", name="samples"),
        CheckConstraint("coverage >= 0 AND coverage <= 1", name="coverage"),
        CheckConstraint("(good_samples = 0) = (avg IS NULL)", name="values_need_good"),
    )

    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    metric: Mapped[str] = mapped_column(String(64))
    channel: Mapped[int] = mapped_column(SmallInteger)
    resolution: Mapped[str] = mapped_column(String(4))
    bucket_start: Mapped[datetime]
    avg: Mapped[float | None] = mapped_column(Double)
    min: Mapped[float | None] = mapped_column(Double)
    max: Mapped[float | None] = mapped_column(Double)
    last: Mapped[float | None] = mapped_column(Double)
    samples: Mapped[int] = mapped_column(Integer)
    good_samples: Mapped[int] = mapped_column(Integer)
    coverage: Mapped[float] = mapped_column(Double)
    computed_at: Mapped[datetime] = created_at()


class AggregateDirty(Base):
    """Godziny urządzenia do przeliczenia — oznaczane przy przyjęciu partii (D46)."""

    __tablename__ = "aggregate_dirty"
    __table_args__ = (PrimaryKeyConstraint("device_id", "hour_start", name="pk_aggregate_dirty"),)

    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    hour_start: Mapped[datetime]
    marked_at: Mapped[datetime] = created_at()
