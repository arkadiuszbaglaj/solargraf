"""Energia za okres i wskaźniki D27 (D48) — czyste funkcje, bez bazy i bez UI.

Jednostki: energia w Wh, moc w W, pokrycie 0..1. Brak danych to ``None``, nigdy zero.

Źródła energii:
- licznik narastający (np. ``pv_energy_total``): energia godziny = ostatni odczyt godziny minus
  ostatni odczyt godziny poprzedniej. Tylko sąsiednie godziny — przerwa w danych to luka, nie
  energia „doliczona” do jednej godziny. Spadek licznika to reset (godzina pominięta, flaga),
  przyrost większy niż ``MAX_POWER_W`` * 1 h to wartość niewiarygodna (godzina pominięta);
- moc (``load_power``, brak licznika zużycia): energia przedziału 5 min = średnia moc * 5 min,
  tylko przedziały z próbkami GOOD; pokrycie godziny = średnie pokrycie jej przedziałów.
"""

from __future__ import annotations

import enum
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from solargraf_server.aggregation import H1, M5, floor_utc

# Górna granica wiarygodnego przyrostu licznika: 100 kW przez godzinę (instalacje domowe
# i małe komercyjne). Większy przyrost uznajemy za błąd odczytu, nie za energię.
MAX_POWER_W = 100_000.0
# Poniżej tego pokrycia wskaźnik jest „niepełny” (pokazywany z ostrzeżeniem).
COMPLETE_COVERAGE = 0.95

_M5_PER_HOUR = int(H1 / M5)


class HourStatus(enum.StrEnum):
    OK = "OK"
    GAP = "GAP"
    RESET = "RESET"
    INVALID = "INVALID"


@dataclass(frozen=True)
class HourEnergy:
    start: datetime
    wh: float | None
    coverage: float
    status: HourStatus


def counter_hours(
    hours: Sequence[datetime], last_by_hour: Mapping[datetime, float | None]
) -> list[HourEnergy]:
    """Energia godzin ``hours`` z ostatnich odczytów licznika (także godziny poprzedzającej)."""
    out = []
    for hour in hours:
        current = last_by_hour.get(hour)
        previous = last_by_hour.get(hour - H1)
        if current is None or previous is None:
            out.append(HourEnergy(hour, None, 0.0, HourStatus.GAP))
            continue
        delta = current - previous
        if delta < 0:
            out.append(HourEnergy(hour, None, 0.0, HourStatus.RESET))
        elif delta > MAX_POWER_W:
            out.append(HourEnergy(hour, None, 0.0, HourStatus.INVALID))
        else:
            out.append(HourEnergy(hour, delta, 1.0, HourStatus.OK))
    return out


def power_hours(
    hours: Sequence[datetime], m5: Iterable[tuple[datetime, float | None, float]]
) -> list[HourEnergy]:
    """Energia godzin z agregatów 5 min mocy: (początek, średnia W, pokrycie)."""
    sums: dict[datetime, float] = {}
    covered: dict[datetime, float] = {}
    for start, avg, cov in m5:
        if avg is None:
            continue
        hour = floor_utc(start, H1)
        sums[hour] = sums.get(hour, 0.0) + avg * (M5 / H1)
        covered[hour] = covered.get(hour, 0.0) + cov
    return [
        HourEnergy(h, sums[h], min(1.0, covered[h] / _M5_PER_HOUR), HourStatus.OK)
        if h in sums
        else HourEnergy(h, None, 0.0, HourStatus.GAP)
        for h in hours
    ]


@dataclass(frozen=True)
class Bucket:
    start: datetime
    wh: float | None
    coverage: float


@dataclass(frozen=True)
class EnergyTotal:
    wh: float | None
    coverage: float
    reset_detected: bool
    buckets: list[Bucket]


def total(hours: Sequence[HourEnergy], bucket_of: Callable[[datetime], datetime]) -> EnergyTotal:
    """Suma godzin w przedziały (``bucket_of`` mapuje godzinę na początek przedziału)."""
    grouped: dict[datetime, list[HourEnergy]] = {}
    for h in hours:
        grouped.setdefault(bucket_of(h.start), []).append(h)
    buckets = [_sum(start, group) for start, group in grouped.items()]
    whole = _sum(hours[0].start if hours else datetime.min, list(hours))
    return EnergyTotal(
        wh=whole.wh,
        coverage=whole.coverage,
        reset_detected=any(h.status is HourStatus.RESET for h in hours),
        buckets=buckets,
    )


def _sum(start: datetime, hours: Sequence[HourEnergy]) -> Bucket:
    values = [h.wh for h in hours if h.wh is not None]
    coverage = sum(h.coverage for h in hours) / len(hours) if hours else 0.0
    return Bucket(start, sum(values) if values else None, coverage)


class KpiStatus(enum.StrEnum):
    OK = "OK"
    INCOMPLETE = "INCOMPLETE"
    UNAVAILABLE = "UNAVAILABLE"
    INCONSISTENT = "INCONSISTENT"


@dataclass(frozen=True)
class Kpi:
    value: float | None
    status: KpiStatus
    reason: str | None
    coverage: float


def _unavailable(reason: str) -> Kpi:
    return Kpi(None, KpiStatus.UNAVAILABLE, reason, 0.0)


def ratio_kpi(
    base: Sequence[HourEnergy] | None, minus: Sequence[HourEnergy] | None, zero_reason: str
) -> Kpi:
    """(base - minus) / base — tylko z godzin, w których oba źródła mają wartość (D27).

    Autokonsumpcja: base = produkcja PV, minus = eksport. Samowystarczalność: base = zużycie
    domu, minus = import. Brak źródła, brak danych albo base = 0 → niedostępny; wynik poza 0..1 →
    niespójny (bez wartości); pokrycie < ``COMPLETE_COVERAGE`` albo reset licznika → niepełny.
    """
    if base is None or minus is None:
        return _unavailable("Urządzenie nie dostarcza wymaganych pomiarów.")
    pairs = [
        (b, m) for b, m in zip(base, minus, strict=True) if b.wh is not None and m.wh is not None
    ]
    if not pairs:
        return _unavailable("Brak danych w tym okresie.")
    base_wh = sum(b.wh for b, _ in pairs if b.wh is not None)
    minus_wh = sum(m.wh for _, m in pairs if m.wh is not None)
    coverage = sum(min(b.coverage, m.coverage) for b, m in pairs) / len(base)
    if base_wh <= 0:
        return Kpi(None, KpiStatus.UNAVAILABLE, zero_reason, coverage)
    value = (base_wh - minus_wh) / base_wh
    if not 0.0 <= value <= 1.0:
        return Kpi(None, KpiStatus.INCONSISTENT, "Pomiary są ze sobą niespójne.", coverage)
    reset = any(h.status is HourStatus.RESET for h in (*base, *minus))
    if reset:
        return Kpi(value, KpiStatus.INCOMPLETE, "Wykryto reset licznika.", coverage)
    if coverage < COMPLETE_COVERAGE:
        return Kpi(value, KpiStatus.INCOMPLETE, "Niepełne dane w tym okresie.", coverage)
    return Kpi(value, KpiStatus.OK, None, coverage)


def hour_starts(start: datetime, end: datetime) -> list[datetime]:
    """Pełne godziny UTC przecinające ``[start, end)``."""
    first = floor_utc(start, H1)
    count = int((end - first) / H1) + (0 if (end - first) % H1 == timedelta(0) else 1)
    return [first + i * H1 for i in range(count)]
