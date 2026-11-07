"""Historia metryk serwera i prognoza zapełnienia dysku (D61) — obliczenia bez bazy.

Przedział bez próbek to luka (``None``), nigdy 0. Prognoza to szacunek z regresji liniowej
średnich godzinowych zajętości dysku; nie jest wyliczana z niepełnych danych.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

# Początek siatki przedziałów — ten sam co w ``date_bin`` w zapytaniu.
ORIGIN = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class Range:
    span: timedelta
    step: timedelta


RANGES: Mapping[str, Range] = {
    "24h": Range(timedelta(hours=24), timedelta(minutes=5)),
    "7d": Range(timedelta(days=7), timedelta(hours=1)),
    "30d": Range(timedelta(days=30), timedelta(hours=6)),
}

# Prognoza: średnie godzinowe z 7 dni, co najmniej 3 dni danych; powyżej roku — „ponad rok”.
FORECAST_WINDOW = timedelta(days=7)
FORECAST_MIN_SPAN = timedelta(days=3)
FORECAST_HORIZON = timedelta(days=365)


@dataclass(frozen=True)
class Bucket:
    avg: float | None
    max: float | None


EMPTY = Bucket(None, None)


def floor_to(t: datetime, step: timedelta) -> datetime:
    return ORIGIN + ((t - ORIGIN) // step) * step


def bucket_starts(start: datetime, end: datetime, step: timedelta) -> list[datetime]:
    """Początki przedziałów pokrywających ``[start, end]`` (pierwszy może być częściowy)."""
    out: list[datetime] = []
    t = floor_to(start, step)
    while t <= end:
        out.append(t)
        t += step
    return out


def fill(
    found: Mapping[datetime, Bucket], start: datetime, end: datetime, step: timedelta
) -> list[tuple[datetime, Bucket]]:
    """Pełna siatka przedziałów; brakujące są puste (luka na wykresie)."""
    return [(t, found.get(t, EMPTY)) for t in bucket_starts(start, end, step)]


class ForecastStatus(StrEnum):
    OK = "OK"
    OVER_YEAR = "OVER_YEAR"
    NOT_GROWING = "NOT_GROWING"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass(frozen=True)
class Forecast:
    status: ForecastStatus
    full_at: datetime | None = None
    # Przyrost z regresji, bajty na dobę; None — nie wyliczono.
    growth_bytes_per_day: float | None = None


def slope_per_second(points: Sequence[tuple[datetime, float]]) -> float | None:
    """Nachylenie prostej najmniejszych kwadratów (jednostka/s); None dla < 2 różnych chwil."""
    if len(points) < 2:
        return None
    t0 = points[0][0]
    xs = [(t - t0).total_seconds() for t, _ in points]
    ys = [v for _, v in points]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / sxx


def disk_forecast(
    hourly_used: Sequence[tuple[datetime, float]], total: float | None, now: datetime
) -> Forecast:
    """Kiedy zajętość dysku osiągnie ``total`` przy obecnym trendzie (szacunek)."""
    points = sorted(hourly_used)
    if total is None or total <= 0 or len(points) < 2:
        return Forecast(ForecastStatus.INSUFFICIENT_DATA)
    if points[-1][0] - points[0][0] < FORECAST_MIN_SPAN:
        return Forecast(ForecastStatus.INSUFFICIENT_DATA)
    slope = slope_per_second(points)
    if slope is None:
        return Forecast(ForecastStatus.INSUFFICIENT_DATA)
    growth = slope * 86400
    if slope <= 0:
        return Forecast(ForecastStatus.NOT_GROWING, growth_bytes_per_day=growth)
    last_t, last_used = points[-1]
    remaining_s = max(0.0, total - last_used) / slope
    if remaining_s > (now - last_t + FORECAST_HORIZON).total_seconds():
        return Forecast(ForecastStatus.OVER_YEAR, growth_bytes_per_day=growth)
    full_at = max(now, last_t + timedelta(seconds=remaining_s))
    return Forecast(ForecastStatus.OK, full_at=full_at, growth_bytes_per_day=growth)
