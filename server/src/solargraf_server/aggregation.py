"""Obliczenia agregatów (D46) — czyste funkcje, bez bazy i bez UI.

Zasady (docs/DATA_MODEL.md): liczymy tylko próbki GOOD; brak próbek GOOD to wartości ``None``,
nigdy zero; pokrycie mówi, jaka część przedziału ma dane. Przedziały 5 min i 1 h są wyrównane
w UTC, doba — w strefie instalacji (23 albo 25 h przy zmianie czasu).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

M5 = timedelta(minutes=5)
H1 = timedelta(hours=1)
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def floor_utc(ts: datetime, step: timedelta) -> datetime:
    """Początek przedziału ``step`` (wyrównanego w UTC), w którym leży ``ts``."""
    if ts.tzinfo is None:
        raise ValueError("czas musi mieć strefę")
    elapsed = ts.astimezone(UTC) - _EPOCH
    return _EPOCH + (elapsed // step) * step


def local_day_start(ts: datetime, tz: ZoneInfo) -> datetime:
    """Północ (w strefie instalacji) doby, w której leży ``ts`` — jako czas UTC."""
    local = ts.astimezone(tz)
    return datetime(local.year, local.month, local.day, tzinfo=tz).astimezone(UTC)


def next_local_day(day_start: datetime, tz: ZoneInfo) -> datetime:
    """Północ następnej doby lokalnej (UTC). Działa także w dniach zmiany czasu."""
    local = day_start.astimezone(tz)
    following = local.date() + timedelta(days=1)
    return datetime(following.year, following.month, following.day, tzinfo=tz).astimezone(UTC)


def local_days(start: datetime, end: datetime, tz: ZoneInfo) -> list[datetime]:
    """Początki dób lokalnych przecinających ``[start, end)``."""
    days = []
    day = local_day_start(start, tz)
    while day < end:
        days.append(day)
        day = next_local_day(day, tz)
    return days


@dataclass(frozen=True)
class Sample:
    at: datetime
    value: float | None
    good: bool


@dataclass(frozen=True)
class Summary:
    avg: float | None
    min: float | None
    max: float | None
    last: float | None
    samples: int
    good_samples: int
    coverage: float


def coverage(good_samples: int, interval_s: float, bucket: timedelta) -> float:
    """Pokrycie przedziału: próbki GOOD * interwał / długość przedziału, w zakresie 0..1."""
    if good_samples <= 0 or interval_s <= 0:
        return 0.0
    return min(1.0, good_samples * interval_s / bucket.total_seconds())


def summarize(samples: Sequence[Sample], bucket: timedelta, interval_s: float) -> Summary:
    """Agregat próbek jednego przedziału (próbki w kolejności czasu)."""
    good = [s.value for s in samples if s.good and s.value is not None]
    if not good:
        return Summary(None, None, None, None, len(samples), 0, 0.0)
    return Summary(
        avg=sum(good) / len(good),
        min=min(good),
        max=max(good),
        last=good[-1],
        samples=len(samples),
        good_samples=len(good),
        coverage=coverage(len(good), interval_s, bucket),
    )


def combine(parts: Sequence[Summary], bucket: timedelta, interval_s: float) -> Summary:
    """Agregat dłuższego przedziału z krótszych (w kolejności czasu), np. doba z godzin.

    Średnia ważona liczbą próbek GOOD — wynik równy średniej ze wszystkich próbek.
    """
    samples = sum(p.samples for p in parts)
    with_values = [p for p in parts if p.good_samples > 0 and p.avg is not None]
    if not with_values:
        return Summary(None, None, None, None, samples, 0, 0.0)
    good = sum(p.good_samples for p in with_values)
    weighted = sum(p.avg * p.good_samples for p in with_values if p.avg is not None)
    return Summary(
        avg=weighted / good,
        min=min(p.min for p in with_values if p.min is not None),
        max=max(p.max for p in with_values if p.max is not None),
        last=with_values[-1].last,
        samples=samples,
        good_samples=good,
        coverage=coverage(good, interval_s, bucket),
    )


def group_by_bucket(samples: Iterable[Sample], step: timedelta) -> dict[datetime, list[Sample]]:
    """Próbki pogrupowane po przedziałach UTC (kolejność wewnątrz zachowana)."""
    groups: dict[datetime, list[Sample]] = {}
    for sample in samples:
        groups.setdefault(floor_utc(sample.at, step), []).append(sample)
    return groups
