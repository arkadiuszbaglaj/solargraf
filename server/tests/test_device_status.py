"""Status urządzenia (D38) — czysta funkcja, bez bazy."""

from datetime import UTC, datetime, timedelta

import pytest

from solargraf_server.device_status import (
    AGENT_HEARTBEAT_TIMEOUT,
    AgentState,
    DeviceState,
    DeviceStatus,
    device_status,
)

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
THRESHOLD = timedelta(seconds=300)
LIVE_AGENT = AgentState(enabled=True, last_heartbeat_at=NOW - timedelta(seconds=10))


def dev(
    *,
    enabled: bool = True,
    attempt: timedelta | None = timedelta(seconds=5),
    success: timedelta | None = timedelta(seconds=5),
) -> DeviceState:
    """``attempt``/``success`` to wiek zdarzenia względem NOW (None = nigdy)."""
    return DeviceState(
        enabled=enabled,
        last_attempt_at=None if attempt is None else NOW - attempt,
        last_success_at=None if success is None else NOW - success,
        freshness_threshold=THRESHOLD,
    )


def test_ok_with_fresh_success_and_live_agent() -> None:
    assert device_status(dev(), LIVE_AGENT, NOW) is DeviceStatus.OK


def test_disabled_wins_over_everything() -> None:
    assert device_status(dev(enabled=False), None, NOW) is DeviceStatus.DISABLED


@pytest.mark.parametrize(
    "agent",
    [
        None,
        AgentState(enabled=False, last_heartbeat_at=NOW),
        AgentState(enabled=True, last_heartbeat_at=None),
        AgentState(
            enabled=True,
            last_heartbeat_at=NOW - AGENT_HEARTBEAT_TIMEOUT - timedelta(seconds=1),
        ),
    ],
    ids=["no-agent", "agent-disabled", "no-heartbeat", "heartbeat-stale"],
)
def test_unknown_without_live_agent_never_offline_or_ok(agent: AgentState | None) -> None:
    # Utrata agenta to brak wiedzy, nie awaria urządzenia (D38) — także przy świeżym sukcesie.
    assert device_status(dev(), agent, NOW) is DeviceStatus.UNKNOWN


def test_heartbeat_exactly_at_timeout_is_still_live() -> None:
    agent = AgentState(enabled=True, last_heartbeat_at=NOW - AGENT_HEARTBEAT_TIMEOUT)
    assert device_status(dev(), agent, NOW) is DeviceStatus.OK


def test_never_polled_is_unknown() -> None:
    assert device_status(dev(attempt=None, success=None), LIVE_AGENT, NOW) is DeviceStatus.UNKNOWN


def test_attempts_without_any_success_is_error() -> None:
    assert device_status(dev(success=None), LIVE_AGENT, NOW) is DeviceStatus.ERROR


def test_failed_attempt_newer_than_success_is_error() -> None:
    d = dev(attempt=timedelta(seconds=5), success=timedelta(seconds=60))
    assert device_status(d, LIVE_AGENT, NOW) is DeviceStatus.ERROR


def test_error_takes_precedence_over_stale() -> None:
    d = dev(attempt=timedelta(seconds=5), success=timedelta(hours=2))
    assert device_status(d, LIVE_AGENT, NOW) is DeviceStatus.ERROR


def test_success_without_recorded_attempt_is_ok() -> None:
    assert device_status(dev(attempt=None), LIVE_AGENT, NOW) is DeviceStatus.OK


def test_stale_after_threshold_boundary() -> None:
    at = dev(attempt=THRESHOLD, success=THRESHOLD)
    past = dev(attempt=THRESHOLD + timedelta(seconds=1), success=THRESHOLD + timedelta(seconds=1))
    assert device_status(at, LIVE_AGENT, NOW) is DeviceStatus.OK
    assert device_status(past, LIVE_AGENT, NOW) is DeviceStatus.STALE
