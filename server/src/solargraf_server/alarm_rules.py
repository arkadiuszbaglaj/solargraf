"""Reguły alarmów instalacji (D55). Liczy je ``worker`` co cykl; nie łączy się z urządzeniami.

Reguły (wersja ``RULE_VERSION``) wynikają ze statusów D38/D52 — tych samych, które widzi UI:
- ``AGENT_UNREACHABLE`` (krytyczny) — włączony agent obsługujący połączenie instalacji nie ma
  świeżego heartbeatu. Jego urządzenia nie dostają własnych alarmów — jeden alarm wskazuje
  przyczynę;
- ``DEVICE_READ_ERROR`` (ostrzeżenie) — włączone urządzenie z osiągalnym agentem ma status ERROR;
- ``DEVICE_STALE`` (ostrzeżenie) — jak wyżej, status STALE;
- ``DEVICE_PARTIAL_READ`` (ostrzeżenie, D76) — urządzenie odpowiada (status OK), ale w ostatnich
  ``PARTIAL_WINDOW`` każdy z co najmniej ``PARTIAL_MIN_RUNS`` przebiegów odczytu pominął część
  parametrów (``failed_points > 0``). Nie otwiera się obok alarmu agenta, błędu ani nieaktualności.

Wyłączony agent albo urządzenie nie dają alarmu (decyzja użytkownika). Alarm otwiera się przy
pierwszym wykryciu, zamyka po ``CLOSE_AFTER`` kolejnych sprawdzeniach bez warunku (histereza).
Czasy z zegara serwera (UTC); czas ostatniego odczytu/heartbeatu w ``last_ok_at``, nie w tekście.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.device_status import (
    AgentState,
    AgentStatus,
    DeviceState,
    DeviceStatus,
    agent_status,
    device_status,
)
from solargraf_server.models import (
    Agent,
    Alarm,
    AlarmCode,
    AlarmSeverity,
    Connection,
    Device,
    PollingRun,
)

RULE_VERSION = 2
CLOSE_AFTER = 2
PARTIAL_WINDOW = timedelta(minutes=15)
PARTIAL_MIN_RUNS = 2


@dataclass(frozen=True)
class RecentRuns:
    """Przebiegi odczytu urządzenia w oknie ``PARTIAL_WINDOW``."""

    runs: int
    partial_runs: int  # przebiegi z ``failed_points > 0``
    max_failed: int
    max_points: int  # ok + failed w przebiegu z największą liczbą punktów


@dataclass(frozen=True)
class AgentInfo:
    id: uuid.UUID
    name: str
    state: AgentState


@dataclass(frozen=True)
class DeviceInfo:
    id: uuid.UUID
    site_id: uuid.UUID
    name: str
    agent_id: uuid.UUID | None
    state: DeviceState
    recent: RecentRuns | None = None


def partial_reads(recent: RecentRuns | None) -> bool:
    """Każdy z co najmniej ``PARTIAL_MIN_RUNS`` ostatnich przebiegów pominął parametry."""
    return (
        recent is not None
        and recent.runs >= PARTIAL_MIN_RUNS
        and recent.partial_runs == recent.runs
    )


@dataclass(frozen=True)
class Condition:
    site_id: uuid.UUID
    code: AlarmCode
    subject: str
    severity: AlarmSeverity
    title: str
    details: str | None
    last_ok_at: datetime | None
    device_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None

    @property
    def key(self) -> tuple[uuid.UUID, str, str]:
        return (self.site_id, self.code.value, self.subject)


def conditions(
    devices: Iterable[DeviceInfo], agents: dict[uuid.UUID, AgentInfo], now: datetime
) -> list[Condition]:
    """Warunki alarmów w chwili ``now``. Czysta funkcja — bez bazy i zegara."""
    found: dict[tuple[uuid.UUID, str, str], Condition] = {}
    for device in devices:
        if not device.state.enabled:
            continue
        agent = agents.get(device.agent_id) if device.agent_id is not None else None
        if agent is not None and agent_status(agent.state, now) is AgentStatus.UNREACHABLE:
            c = Condition(
                site_id=device.site_id,
                code=AlarmCode.AGENT_UNREACHABLE,
                subject=f"agent:{agent.id}",
                severity=AlarmSeverity.CRITICAL,
                title=f"Agent {agent.name} nie odpowiada",
                details="Statusy urządzeń obsługiwanych przez agenta są nieznane.",
                last_ok_at=agent.state.last_heartbeat_at,
                agent_id=agent.id,
            )
            found[c.key] = c
            continue
        status = device_status(device.state, agent.state if agent else None, now)
        if status is DeviceStatus.ERROR:
            code, title = AlarmCode.DEVICE_READ_ERROR, f"Błąd odczytu: {device.name}"
        elif status is DeviceStatus.STALE:
            code, title = AlarmCode.DEVICE_STALE, f"Dane nieaktualne: {device.name}"
        elif status is DeviceStatus.OK and partial_reads(device.recent):
            code, title = AlarmCode.DEVICE_PARTIAL_READ, f"Niepełne odczyty: {device.name}"
        else:
            continue
        details = None
        if code is AlarmCode.DEVICE_PARTIAL_READ and device.recent is not None:
            details = (
                f"Każdy odczyt z ostatnich {int(PARTIAL_WINDOW.total_seconds() // 60)} min pominął "
                f"parametry (do {device.recent.max_failed} z {device.recent.max_points}). "
                "Sprawdź profil urządzenia i jego adres."
            )
        c = Condition(
            site_id=device.site_id,
            code=code,
            subject=f"device:{device.id}",
            severity=AlarmSeverity.WARNING,
            title=title,
            details=details,
            last_ok_at=device.state.last_success_at,
            device_id=device.id,
        )
        found[c.key] = c
    return list(found.values())


@dataclass
class Changes:
    opened: int = 0
    closed: int = 0


def apply(
    open_alarms: Iterable[Alarm], found: Iterable[Condition], now: datetime
) -> tuple[list[Alarm], Changes]:
    """Aktualizuje otwarte alarmy i zwraca nowe do dodania. Czysta funkcja na obiektach ORM."""
    by_key = {c.key: c for c in found}
    changes = Changes()
    for alarm in open_alarms:
        condition = by_key.pop((alarm.site_id, alarm.code, alarm.subject), None)
        if condition is not None:
            alarm.last_seen_at = now
            alarm.last_ok_at = condition.last_ok_at
            alarm.clear_count = 0
            continue
        alarm.clear_count += 1
        if alarm.clear_count >= CLOSE_AFTER:
            alarm.closed_at = now
            changes.closed += 1
    new = [
        Alarm(
            site_id=c.site_id,
            device_id=c.device_id,
            agent_id=c.agent_id,
            subject=c.subject,
            code=c.code.value,
            severity=c.severity.value,
            title=c.title[:300],
            details=c.details[:500] if c.details else None,
            last_ok_at=c.last_ok_at,
            rule_version=RULE_VERSION,
            opened_at=now,
            last_seen_at=now,
            clear_count=0,
        )
        for c in by_key.values()
    ]
    changes.opened = len(new)
    return new, changes


async def evaluate(db: AsyncSession, now: datetime) -> Changes:
    """Jedno sprawdzenie reguł dla wszystkich instalacji w jednej transakcji."""
    agents = {
        a.id: AgentInfo(a.id, a.name, AgentState(a.enabled, a.last_heartbeat_at))
        for a in await db.scalars(select(Agent))
    }
    rows = await db.execute(
        select(Device, Connection.agent_id).join(Connection, Connection.id == Device.connection_id)
    )
    recent_rows = await db.execute(
        select(
            PollingRun.device_id,
            func.count(),
            func.count().filter(PollingRun.failed_points > 0),
            func.max(PollingRun.failed_points),
            func.max(PollingRun.ok_points + PollingRun.failed_points),
        )
        .where(PollingRun.started_at >= now - PARTIAL_WINDOW)
        .group_by(PollingRun.device_id)
    )
    recent = {row[0]: RecentRuns(row[1], row[2], row[3], row[4]) for row in recent_rows.all()}
    devices = [
        DeviceInfo(
            id=d.id,
            site_id=d.site_id,
            name=d.name,
            agent_id=agent_id,
            state=DeviceState(
                d.enabled,
                d.last_attempt_at,
                d.last_success_at,
                timedelta(seconds=d.freshness_threshold_seconds),
            ),
            recent=recent.get(d.id),
        )
        for d, agent_id in rows.all()
    ]
    open_alarms = list(await db.scalars(select(Alarm).where(Alarm.closed_at.is_(None))))
    new, changes = apply(open_alarms, conditions(devices, agents, now), now)
    db.add_all(new)
    await db.commit()
    return changes
