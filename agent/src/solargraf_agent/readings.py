"""Wynik odczytu urządzenia (D41). Brak odczytu to ``value=None`` z jakością, nigdy zero."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal


class Quality(enum.StrEnum):
    GOOD = "GOOD"
    INVALID = "INVALID"  # odczytano, ale wartość niewiarygodna albo nie do zdekodowania
    MISSING = "MISSING"  # nie odczytano


class Origin(enum.StrEnum):
    DEVICE = "DEVICE"
    SIMULATED = "SIMULATED"


class ErrorCode(enum.StrEnum):
    TIMEOUT = "TIMEOUT"
    CONNECTION_REFUSED = "CONNECTION_REFUSED"
    CONNECTION_LOST = "CONNECTION_LOST"
    MODBUS_EXCEPTION = "MODBUS_EXCEPTION"
    INVALID_RESPONSE = "INVALID_RESPONSE"


class RunResult(enum.StrEnum):
    OK = "OK"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


@dataclass(frozen=True)
class Reading:
    metric: str
    channel: int | None
    value: Decimal | None  # w jednostce kanonicznej metryki
    unit: str
    quality: Quality
    received_at: datetime
    origin: Origin
    source_reference: str
    observed_at: datetime | None = None  # Modbus nie podaje czasu pomiaru
    error: ErrorCode | None = None


@dataclass(frozen=True)
class PollError:
    code: ErrorCode
    # Krótki opis bez adresów i danych urządzenia — może trafić do UI.
    detail: str
    modbus_code: int | None = None


@dataclass
class PollingRun:
    started_at: datetime
    finished_at: datetime | None = None
    result: RunResult = RunResult.FAILED
    errors: list[PollError] = field(default_factory=list)
    readings: list[Reading] = field(default_factory=list)

    @property
    def ok_points(self) -> int:
        return sum(r.quality is Quality.GOOD for r in self.readings)

    @property
    def failed_points(self) -> int:
        return len(self.readings) - self.ok_points

    @property
    def error_code(self) -> ErrorCode | None:
        return self.errors[0].code if self.errors else None
