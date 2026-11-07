"""Ocena stabilności serwera z progów O11 z histerezą (D60).

Warunek włącza się po ``enter_samples`` kolejnych pomiarach powyżej progu i wyłącza po
``clear_samples`` kolejnych pomiarach poniżej progu wyłączenia (niższego) — status nie miga.
Pomiar niedostępny (``None``) nie zmienia stanu warunku: brak danych to nie „w normie”.
Stan warunków jest zapisywany w bazie, więc restart workera nie gubi histerezy.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any

from solargraf_server.system import host


class Level(enum.StrEnum):
    STABLE = "STABLE"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"
    UNKNOWN = "UNKNOWN"  # brak oceny (np. worker jeszcze nie mierzył)


class Severity(enum.StrEnum):
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class ComponentState(enum.StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    UNKNOWN = "UNKNOWN"  # nie monitorowany albo brak danych


@dataclass(frozen=True)
class Rule:
    code: str
    severity: Severity
    message: str
    enter_above: float
    clear_below: float
    enter_samples: int = 1
    clear_samples: int = 2


# O11 (D60). Pomiar co 60 s, więc 15 próbek = 15 minut.
CPU_HIGH = Rule(
    "CPU_HIGH", Severity.WARNING, "Procesor obciążony powyżej 85% od 15 min", 85, 80, 15
)
MEMORY_HIGH = Rule("MEMORY_HIGH", Severity.WARNING, "Pamięć RAM zajęta powyżej 90%", 90, 85)
DISK_HIGH = Rule("DISK_HIGH", Severity.WARNING, "Dysk zajęty powyżej 85%", 85, 80)
DISK_FULL = Rule("DISK_FULL", Severity.CRITICAL, "Dysk zajęty powyżej 95%", 95, 90)
TEMPERATURE_HIGH = Rule(
    "TEMPERATURE_HIGH", Severity.WARNING, "Temperatura procesora powyżej 75 °C", 75, 70
)
UNDERVOLTAGE = Rule("UNDERVOLTAGE", Severity.CRITICAL, "Niedobór napięcia zasilania", 0.5, 0.5)
# Składnik niedostępny w 2 kolejnych sprawdzeniach (restart kontenera nie podnosi alarmu).
COMPONENT_ENTER_SAMPLES = 2
COMPONENT_CLEAR_SAMPLES = 2

COMPONENT_NAMES: dict[str, str] = {
    "api": "API",
    "worker": "Usługa obliczeń (worker)",
    "agent": "Agent urządzeń",
    "proxy": "Serwer WWW (proxy)",
    "db": "Baza danych",
}


def percent(used: float | None, total: float | None) -> float | None:
    if used is None or not total:
        return None
    return round(100 * used / total, 2)


def rule_inputs(values: Mapping[str, float | None]) -> dict[str, float | None]:
    """Wartość porównywana z progiem dla każdej reguły (procenty z bajtów)."""
    disk = percent(values.get(host.DISK_USED), values.get(host.DISK_TOTAL))
    return {
        CPU_HIGH.code: values.get(host.CPU_PERCENT),
        MEMORY_HIGH.code: percent(values.get(host.MEM_USED), values.get(host.MEM_TOTAL)),
        DISK_HIGH.code: disk,
        DISK_FULL.code: disk,
        TEMPERATURE_HIGH.code: values.get(host.CPU_TEMP),
        UNDERVOLTAGE.code: values.get(host.UNDERVOLTAGE),
    }


RULES = (CPU_HIGH, MEMORY_HIGH, DISK_HIGH, DISK_FULL, TEMPERATURE_HIGH, UNDERVOLTAGE)


@dataclass(frozen=True)
class Condition:
    active: bool = False
    since: datetime | None = None  # od kiedy aktywny
    enter_streak: int = 0
    clear_streak: int = 0

    def step(
        self, above: bool | None, below: bool | None, enter: int, clear: int, now: datetime
    ) -> Condition:
        if above is None or below is None:
            return self  # brak pomiaru nie zmienia stanu
        if not self.active:
            streak = self.enter_streak + 1 if above else 0
            if streak >= enter:
                return Condition(active=True, since=now)
            return replace(self, enter_streak=streak)
        streak = self.clear_streak + 1 if below else 0
        if streak >= clear:
            return Condition()
        return replace(self, clear_streak=streak)

    def to_json(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "since": self.since.isoformat() if self.since else None,
            "enter_streak": self.enter_streak,
            "clear_streak": self.clear_streak,
        }

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> Condition:
        since = raw.get("since")
        return cls(
            active=bool(raw.get("active", False)),
            since=datetime.fromisoformat(since) if isinstance(since, str) else None,
            enter_streak=int(raw.get("enter_streak", 0)),
            clear_streak=int(raw.get("clear_streak", 0)),
        )


@dataclass(frozen=True)
class Reason:
    code: str
    severity: Severity
    message: str
    since: datetime | None


@dataclass
class Evaluation:
    conditions: dict[str, Condition] = field(default_factory=dict)

    def step(
        self,
        values: Mapping[str, float | None],
        components: Mapping[str, ComponentState],
        now: datetime,
    ) -> None:
        inputs = rule_inputs(values)
        for rule in RULES:
            value = inputs[rule.code]
            current = self.conditions.get(rule.code, Condition())
            above = None if value is None else value > rule.enter_above
            below = None if value is None else value < rule.clear_below
            self.conditions[rule.code] = current.step(
                above, below, rule.enter_samples, rule.clear_samples, now
            )
        for name, state in components.items():
            code = component_code(name)
            current = self.conditions.get(code, Condition())
            known = None if state is ComponentState.UNKNOWN else True
            down = None if known is None else state is ComponentState.DOWN
            up = None if known is None else state is ComponentState.UP
            self.conditions[code] = current.step(
                down, up, COMPONENT_ENTER_SAMPLES, COMPONENT_CLEAR_SAMPLES, now
            )

    def reasons(self) -> list[Reason]:
        found: list[Reason] = []
        for rule in RULES:
            condition = self.conditions.get(rule.code)
            if condition and condition.active:
                found.append(Reason(rule.code, rule.severity, rule.message, condition.since))
        for name, label in COMPONENT_NAMES.items():
            condition = self.conditions.get(component_code(name))
            if condition and condition.active:
                message = f"Składnik niedostępny: {label}"
                found.append(
                    Reason(component_code(name), Severity.CRITICAL, message, condition.since)
                )
        return sorted(found, key=lambda r: (r.severity is not Severity.CRITICAL, r.code))

    def to_json(self) -> dict[str, Any]:
        return {code: c.to_json() for code, c in sorted(self.conditions.items())}

    @classmethod
    def from_json(cls, raw: Mapping[str, Any] | None) -> Evaluation:
        if not raw:
            return cls()
        return cls({code: Condition.from_json(value) for code, value in raw.items()})


def component_code(name: str) -> str:
    return f"COMPONENT_DOWN:{name}"


def level_of(reasons: list[Reason]) -> Level:
    if any(r.severity is Severity.CRITICAL for r in reasons):
        return Level.CRITICAL
    if reasons:
        return Level.WARNING
    return Level.STABLE
