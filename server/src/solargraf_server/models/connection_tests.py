"""Test komunikacji z urządzeniem przed dodaniem (D72): zlecenie dla agenta i jego wynik.

API nigdy nie łączy się z urządzeniem (D11) — zapisuje zlecenie, które agent odbiera, wykonuje
jeden odczyt profilu (tylko odczyt, bez zapisu pomiarów) i odsyła wynik. Wiersze są krótkotrwałe
(sprzątane po dobie); nieodebrane albo niezakończone zlecenie wygasa w odczycie, bez zapisu.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, created_at, uuid_pk

__all__ = ["ConnectionTest", "TestError", "TestState"]


class TestState(enum.StrEnum):
    __test__ = False  # nie jest klasą testów pytest

    PENDING = "PENDING"  # czeka na agenta
    RUNNING = "RUNNING"  # agent odebrał zlecenie
    DONE = "DONE"  # wynik zapisany


class TestError(enum.StrEnum):
    """Błąd testu — zamknięty zbiór; UI tłumaczy go na tekst bez szczegółów urządzenia."""

    __test__ = False

    TIMEOUT = "TIMEOUT"
    CONNECTION_REFUSED = "CONNECTION_REFUSED"
    CONNECTION_LOST = "CONNECTION_LOST"
    MODBUS_EXCEPTION = "MODBUS_EXCEPTION"
    INVALID_RESPONSE = "INVALID_RESPONSE"
    # Agent nie zna profilu (inna wersja agenta niż serwera).
    UNKNOWN_PROFILE = "UNKNOWN_PROFILE"
    # Pod tym adresem i portem agent już czyta urządzenie — drugie połączenie mogłoby je zakłócić.
    TARGET_IN_USE = "TARGET_IN_USE"


def _in(values: type[enum.StrEnum], column: str) -> str:
    return f"{column} IN ({', '.join(repr(v.value) for v in values)})"


class ConnectionTest(Base):
    __tablename__ = "connection_tests"
    __table_args__ = (
        CheckConstraint(_in(TestState, "state"), name="state"),
        CheckConstraint("result IS NULL OR result IN ('OK', 'PARTIAL', 'FAILED')", name="result"),
        CheckConstraint(f"error_code IS NULL OR {_in(TestError, 'error_code')}", name="error_code"),
        CheckConstraint("origin IS NULL OR origin IN ('DEVICE', 'SIMULATED')", name="origin"),
        CheckConstraint("port BETWEEN 1 AND 65535", name="port"),
        CheckConstraint("unit_id BETWEEN 0 AND 255", name="unit_id"),
        Index("ix_connection_tests_agent_id_state", "agent_id", "state"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), index=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    requested_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    host: Mapped[str] = mapped_column(String(253))
    port: Mapped[int] = mapped_column(Integer)
    unit_id: Mapped[int] = mapped_column(Integer)
    profile_id: Mapped[str] = mapped_column(String(100))
    profile_version: Mapped[str] = mapped_column(String(32))
    state: Mapped[str] = mapped_column(String(16), default=TestState.PENDING.value)
    created_at: Mapped[datetime] = created_at()
    claimed_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    result: Mapped[str | None] = mapped_column(String(16))
    error_code: Mapped[str | None] = mapped_column(String(32))
    origin: Mapped[str | None] = mapped_column(String(16))
    # Odczytane wartości: [{metric, channel, value, quality}] — tylko dla OWNER/ADMIN instalacji.
    readings: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
