"""Wyliczanie statusu urządzenia (D38). Czysta funkcja — bez bazy i bez zegara systemowego.

Kolejność reguł:
1. ``DISABLED`` — urządzenie wyłączone przez użytkownika;
2. ``UNKNOWN`` — brak agenta, agent wyłączony albo bez świeżego heartbeatu
   (nie wiemy, co się dzieje z urządzeniem — nie zgłaszamy ``OFFLINE``);
3. ``UNKNOWN`` — urządzenie nigdy nie było odpytywane;
4. ``ERROR`` — ostatnia próba odczytu jest nowsza niż ostatni sukces (albo sukcesu nie było);
5. ``STALE`` — ostatni sukces starszy niż próg świeżości urządzenia;
6. ``OK``.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from datetime import datetime, timedelta

# Agent wysyła heartbeat częściej; po tym czasie bez heartbeatu stan urządzeń jest nieznany.
AGENT_HEARTBEAT_TIMEOUT = timedelta(seconds=120)


class DeviceStatus(enum.StrEnum):
    DISABLED = "DISABLED"
    UNKNOWN = "UNKNOWN"
    ERROR = "ERROR"
    STALE = "STALE"
    OK = "OK"


@dataclass(frozen=True)
class AgentState:
    enabled: bool
    last_heartbeat_at: datetime | None


@dataclass(frozen=True)
class DeviceState:
    enabled: bool
    last_attempt_at: datetime | None
    last_success_at: datetime | None
    freshness_threshold: timedelta


def device_status(device: DeviceState, agent: AgentState | None, now: datetime) -> DeviceStatus:
    """Wszystkie daty muszą być świadome strefy (UTC)."""
    if not device.enabled:
        return DeviceStatus.DISABLED
    if (
        agent is None
        or not agent.enabled
        or agent.last_heartbeat_at is None
        or now - agent.last_heartbeat_at > AGENT_HEARTBEAT_TIMEOUT
    ):
        return DeviceStatus.UNKNOWN
    attempt, success = device.last_attempt_at, device.last_success_at
    if attempt is None and success is None:
        return DeviceStatus.UNKNOWN
    if success is None or (attempt is not None and attempt > success):
        return DeviceStatus.ERROR
    if now - success > device.freshness_threshold:
        return DeviceStatus.STALE
    return DeviceStatus.OK


class AgentStatus(enum.StrEnum):
    DISABLED = "DISABLED"
    UNREACHABLE = "UNREACHABLE"
    ONLINE = "ONLINE"


def agent_status(agent: AgentState, now: datetime) -> AgentStatus:
    """Próg jak dla statusu urządzeń (D52): bez świeżego heartbeatu agent jest nieosiągalny."""
    if not agent.enabled:
        return AgentStatus.DISABLED
    if agent.last_heartbeat_at is None or now - agent.last_heartbeat_at > AGENT_HEARTBEAT_TIMEOUT:
        return AgentStatus.UNREACHABLE
    return AgentStatus.ONLINE
