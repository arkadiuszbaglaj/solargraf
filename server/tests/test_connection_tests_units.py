"""Test połączenia (D72): stan wygaśnięcia i walidacja wyników agenta — bez bazy."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from solargraf_server.connection_tests import (
    PENDING_TTL,
    RUNNING_TTL,
    TestIn,
    TestReading,
    TestReadingOut,
    TestResultIn,
    effective_state,
)
from solargraf_server.models import ConnectionTest, RunResult, TestError, TestState

NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)


def _test(state: TestState, created: datetime, claimed: datetime | None = None) -> ConnectionTest:
    return ConnectionTest(
        id=uuid.uuid4(),
        state=state.value,
        created_at=created,
        claimed_at=claimed,
        host="192.168.1.2",
        port=502,
        unit_id=1,
        profile_id="p",
        profile_version="1",
    )


class TestEffectiveState:
    def test_pending_expires_after_ttl(self) -> None:
        assert effective_state(_test(TestState.PENDING, NOW - PENDING_TTL), NOW) == "PENDING"
        late = NOW - PENDING_TTL - timedelta(seconds=1)
        assert effective_state(_test(TestState.PENDING, late), NOW) == "EXPIRED"

    def test_running_counts_from_claim(self) -> None:
        old = NOW - timedelta(hours=1)
        assert effective_state(_test(TestState.RUNNING, old, NOW - RUNNING_TTL), NOW) == "RUNNING"
        late = NOW - RUNNING_TTL - timedelta(seconds=1)
        assert effective_state(_test(TestState.RUNNING, old, late), NOW) == "EXPIRED"

    def test_done_never_expires(self) -> None:
        old = NOW - timedelta(hours=5)
        assert effective_state(_test(TestState.DONE, old, old), NOW) == "DONE"


class TestValidation:
    def test_request_rejects_public_address_and_bad_unit(self) -> None:
        ok = TestIn(host="Falownik.LAN", profile_id="p", profile_version="1")
        assert (ok.host, ok.port, ok.unit_id) == ("falownik.lan", 502, 1)
        with pytest.raises(ValidationError):
            TestIn(host="1.1.1.1", profile_id="p", profile_version="1")
        with pytest.raises(ValidationError):
            TestIn(host="10.0.0.2", unit_id=256, profile_id="p", profile_version="1")

    def test_reading_missing_is_null_not_zero(self) -> None:
        TestReading(metric="pv_power", value=None, quality="MISSING")
        with pytest.raises(ValidationError):
            TestReading(metric="pv_power", value=0.0, quality="MISSING")
        with pytest.raises(ValidationError):
            TestReading(metric="pv_power", value=None, quality="GOOD")
        with pytest.raises(ValidationError):
            TestReading(metric="nie_ma_takiej", value=1.0, quality="GOOD")
        with pytest.raises(ValidationError):
            TestReading(metric="pv_string_voltage", value=1.0, quality="GOOD")  # brak kanału

    def test_result_and_error_code_consistent(self) -> None:
        TestResultIn(result=RunResult.OK)
        TestResultIn(result=RunResult.FAILED, error_code=TestError.TIMEOUT)
        with pytest.raises(ValidationError):
            TestResultIn(result=RunResult.FAILED)
        with pytest.raises(ValidationError):
            TestResultIn(result=RunResult.OK, error_code=TestError.TIMEOUT)

    def test_output_reading_has_catalog_name_and_unit(self) -> None:
        out = TestReadingOut.of(TestReading(metric="pv_power", value=1500.0, quality="GOOD"))
        assert (out.name, out.unit, out.value) == ("Moc PV", "W", 1500.0)
