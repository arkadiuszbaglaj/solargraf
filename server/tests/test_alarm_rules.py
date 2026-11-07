"""Reguły alarmów (D55) bez bazy: warunki ze statusów D38/D52 i histereza zamykania."""

import uuid
from datetime import UTC, datetime, timedelta

from solargraf_server.alarm_rules import (
    CLOSE_AFTER,
    RULE_VERSION,
    AgentInfo,
    Condition,
    DeviceInfo,
    apply,
    conditions,
)
from solargraf_server.device_status import AgentState, DeviceState
from solargraf_server.models import Alarm, AlarmCode, AlarmSeverity

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
SITE = uuid.UUID("11111111-1111-1111-1111-111111111111")
AGENT = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
FRESH = timedelta(seconds=300)


def agent(heartbeat_ago: float | None = 10, enabled: bool = True) -> dict[uuid.UUID, AgentInfo]:
    at = None if heartbeat_ago is None else NOW - timedelta(seconds=heartbeat_ago)
    return {AGENT: AgentInfo(AGENT, "lokalny", AgentState(enabled, at))}


def device(
    name: str,
    *,
    success_ago: float | None = 20,
    attempt_ago: float | None = 20,
    enabled: bool = True,
    agent_id: uuid.UUID | None = AGENT,
) -> DeviceInfo:
    def ago(s: float | None) -> datetime | None:
        return None if s is None else NOW - timedelta(seconds=s)

    return DeviceInfo(
        id=uuid.uuid5(uuid.NAMESPACE_DNS, name),
        site_id=SITE,
        name=name,
        agent_id=agent_id,
        state=DeviceState(enabled, ago(attempt_ago), ago(success_ago), FRESH),
    )


def codes(found: list[Condition]) -> list[tuple[str, str]]:
    return sorted((c.code.value, c.title) for c in found)


def test_healthy_devices_have_no_alarms() -> None:
    assert conditions([device("Falownik")], agent(), NOW) == []


def test_read_error_and_stale_are_warnings_with_last_success() -> None:
    found = conditions(
        [
            device("Falownik", success_ago=400, attempt_ago=5),
            device("Licznik", success_ago=400, attempt_ago=400),
        ],
        agent(),
        NOW,
    )
    assert codes(found) == [
        ("DEVICE_READ_ERROR", "Błąd odczytu: Falownik"),
        ("DEVICE_STALE", "Dane nieaktualne: Licznik"),
    ]
    assert all(c.severity is AlarmSeverity.WARNING for c in found)
    assert found[0].last_ok_at == NOW - timedelta(seconds=400)
    assert found[0].details is None
    assert {c.subject for c in found} == {f"device:{c.device_id}" for c in found}


def test_unreachable_agent_is_one_critical_alarm_instead_of_device_alarms() -> None:
    found = conditions(
        [device("Falownik", success_ago=900, attempt_ago=900), device("Licznik")],
        agent(heartbeat_ago=121),
        NOW,
    )
    assert len(found) == 1
    (alarm,) = found
    assert alarm.code is AlarmCode.AGENT_UNREACHABLE
    assert alarm.severity is AlarmSeverity.CRITICAL
    assert alarm.subject == f"agent:{AGENT}"
    assert alarm.title == "Agent lokalny nie odpowiada"
    assert alarm.details == "Statusy urządzeń obsługiwanych przez agenta są nieznane."
    assert alarm.last_ok_at == NOW - timedelta(seconds=121)


def test_agent_without_heartbeat_is_unreachable() -> None:
    found = conditions([device("Falownik")], agent(heartbeat_ago=None), NOW)
    assert [c.code for c in found] == [AlarmCode.AGENT_UNREACHABLE]
    assert found[0].last_ok_at is None


def test_disabled_agent_device_or_missing_agent_give_no_alarm() -> None:
    assert conditions([device("Falownik", success_ago=900)], agent(enabled=False), NOW) == []
    assert (
        conditions(
            [device("Falownik", success_ago=900, enabled=False)], agent(heartbeat_ago=900), NOW
        )
        == []
    )
    # Połączenie bez agenta: stan nieznany (D38) — panel pokazuje „brak agenta”, alarmu nie ma.
    assert conditions([device("Falownik", success_ago=900, agent_id=None)], agent(), NOW) == []


def _alarm(subject: str, code: AlarmCode, clear_count: int = 0) -> Alarm:
    return Alarm(
        site_id=SITE,
        subject=subject,
        code=code.value,
        severity=AlarmSeverity.WARNING.value,
        title="t",
        rule_version=RULE_VERSION,
        opened_at=NOW - timedelta(minutes=10),
        last_seen_at=NOW - timedelta(minutes=1),
        clear_count=clear_count,
    )


def test_apply_opens_new_refreshes_existing_and_closes_after_two_clear_checks() -> None:
    stale = device("Falownik", success_ago=400, attempt_ago=400)
    found = conditions([stale], agent(), NOW)
    subject = f"device:{stale.id}"

    new, changes = apply([], found, NOW)
    assert (changes.opened, changes.closed) == (1, 0)
    (opened,) = new
    assert (opened.code, opened.subject, opened.opened_at, opened.closed_at) == (
        "DEVICE_STALE",
        subject,
        NOW,
        None,
    )

    existing = _alarm(subject, AlarmCode.DEVICE_STALE, clear_count=1)
    new, changes = apply([existing], found, NOW)
    assert new == []
    assert changes.opened == 0
    assert (existing.last_seen_at, existing.clear_count, existing.closed_at) == (NOW, 0, None)

    # Warunek ustąpił: pierwsze sprawdzenie — jeszcze otwarty, drugie — zamknięty.
    assert CLOSE_AFTER == 2
    apply([existing], [], NOW)
    assert (existing.clear_count, existing.closed_at) == (1, None)
    _, changes = apply([existing], [], NOW + timedelta(minutes=1))
    assert existing.closed_at == NOW + timedelta(minutes=1)
    assert changes.closed == 1


def test_apply_distinguishes_codes_for_the_same_subject() -> None:
    erroring = device("Falownik", success_ago=400, attempt_ago=5)
    open_stale = _alarm(f"device:{erroring.id}", AlarmCode.DEVICE_STALE)
    new, _ = apply([open_stale], conditions([erroring], agent(), NOW), NOW)
    # STALE przeszedł w ERROR: nowy alarm błędu, stary liczy sprawdzenie bez warunku.
    assert [a.code for a in new] == ["DEVICE_READ_ERROR"]
    assert open_stale.clear_count == 1
