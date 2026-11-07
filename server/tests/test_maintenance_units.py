"""Utrzymanie bazy (D49) — daty partycji, progi retencji, harmonogram; bez bazy."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from solargraf_server.config import Settings
from solargraf_server.maintenance import (
    expired_partitions,
    months_to_ensure,
    next_maintenance,
    partition_month,
    partition_name,
)


def test_partition_names_round_trip() -> None:
    assert partition_name(date(2027, 1, 1)) == "measurements_y2027m01"
    assert partition_month("measurements_y2027m01") == date(2027, 1, 1)
    assert partition_month("measurements_default") is None
    assert partition_month("measurements_y2027m1") is None


def test_months_to_ensure_cross_year() -> None:
    now = datetime(2027, 11, 30, 23, 30, tzinfo=UTC)
    assert months_to_ensure(now, 2) == [date(2027, 11, 1), date(2027, 12, 1), date(2028, 1, 1)]


def test_only_fully_expired_months_are_dropped() -> None:
    names = ["measurements_default", "measurements_y2026m11", "measurements_y2026m12"]
    # Retencja sięga do 1.12 00:00 — listopad cały starszy, grudzień jeszcze nie.
    assert expired_partitions(names, datetime(2026, 12, 1, tzinfo=UTC)) == ["measurements_y2026m11"]
    assert expired_partitions(names, datetime(2026, 11, 30, 23, 59, tzinfo=UTC)) == []


def test_next_maintenance_is_three_utc() -> None:
    assert next_maintenance(datetime(2026, 11, 7, 2, 0, tzinfo=UTC)) == datetime(
        2026, 11, 7, 3, 0, tzinfo=UTC
    )
    assert next_maintenance(datetime(2026, 11, 7, 3, 0, tzinfo=UTC)) == datetime(
        2026, 11, 8, 3, 0, tzinfo=UTC
    )


def test_retention_minimums_guard_against_typos() -> None:
    with pytest.raises(ValidationError):
        Settings(db_password="x", retention_raw_days=3)  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        Settings(db_password="x", retention_m5_days=30)  # type: ignore[arg-type]
    defaults = Settings(db_password="x")  # type: ignore[arg-type]
    assert (defaults.retention_raw_days, defaults.retention_m5_days) == (90, 730)
    assert (defaults.retention_runs_days, defaults.partition_months_ahead) == (90, 12)
