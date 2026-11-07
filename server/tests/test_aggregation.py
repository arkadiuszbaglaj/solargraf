"""Obliczenia agregatów (D46): przedziały, zmiana czasu, pokrycie, brak danych ≠ zero."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from solargraf_server.aggregation import (
    H1,
    M5,
    Sample,
    Summary,
    combine,
    coverage,
    floor_utc,
    group_by_bucket,
    local_day_start,
    local_days,
    next_local_day,
    summarize,
)

WARSAW = ZoneInfo("Europe/Warsaw")
T0 = datetime(2026, 6, 21, 10, 0, tzinfo=UTC)


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


class TestBuckets:
    def test_floor_utc(self) -> None:
        assert floor_utc(at(7.5), M5) == at(5)
        assert floor_utc(at(5), M5) == at(5)
        assert floor_utc(at(59.9), H1) == T0
        # Czas w innej strefie trafia do tego samego przedziału UTC.
        assert floor_utc(at(7).astimezone(WARSAW), M5) == at(5)

    def test_naive_time_rejected(self) -> None:
        with pytest.raises(ValueError, match="strefę"):
            floor_utc(datetime(2026, 1, 1), M5)  # celowo bez strefy

    def test_local_day_in_summer_and_winter(self) -> None:
        # 21.06 00:30 w Warszawie = 20.06 22:30 UTC → doba 21.06 zaczyna się 20.06 22:00 UTC.
        summer = datetime(2026, 6, 20, 22, 30, tzinfo=UTC)
        assert local_day_start(summer, WARSAW) == datetime(2026, 6, 20, 22, 0, tzinfo=UTC)
        winter = datetime(2026, 1, 10, 12, 0, tzinfo=UTC)
        assert local_day_start(winter, WARSAW) == datetime(2026, 1, 9, 23, 0, tzinfo=UTC)

    @pytest.mark.parametrize(
        ("day", "hours"),
        [
            (datetime(2026, 3, 29, tzinfo=WARSAW), 23),  # zmiana na czas letni
            (datetime(2026, 10, 25, tzinfo=WARSAW), 25),  # zmiana na czas zimowy
            (datetime(2026, 6, 21, tzinfo=WARSAW), 24),
        ],
    )
    def test_day_length_across_dst(self, day: datetime, hours: int) -> None:
        start = day.astimezone(UTC)
        assert next_local_day(start, WARSAW) - start == timedelta(hours=hours)

    def test_local_days_cover_range(self) -> None:
        start = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
        end = datetime(2026, 10, 26, 0, 0, tzinfo=UTC)
        days = local_days(start, end, WARSAW)
        assert [d.astimezone(WARSAW).day for d in days] == [24, 25, 26]


class TestSummaries:
    def test_only_good_samples_count(self) -> None:
        samples = [
            Sample(at(0), 100.0, True),
            Sample(at(1), None, False),  # MISSING
            Sample(at(2), 9999.0, False),  # INVALID — pomijana
            Sample(at(3), 300.0, True),
        ]
        s = summarize(samples, M5, interval_s=60)
        assert s == Summary(200.0, 100.0, 300.0, 300.0, 4, 2, 0.4)

    def test_no_good_samples_is_none_not_zero(self) -> None:
        s = summarize([Sample(at(0), None, False)], M5, interval_s=10)
        assert (s.avg, s.min, s.max, s.last) == (None, None, None, None)
        assert (s.samples, s.good_samples, s.coverage) == (1, 0, 0.0)

    def test_zero_is_a_real_value(self) -> None:
        s = summarize([Sample(at(0), 0.0, True)], M5, interval_s=300)
        assert (s.avg, s.coverage) == (0.0, 1.0)

    def test_coverage_is_capped(self) -> None:
        assert coverage(100, 10, M5) == 1.0
        assert coverage(15, 10, M5) == 0.5
        assert coverage(0, 10, M5) == 0.0
        assert coverage(5, 0, M5) == 0.0

    def test_combine_equals_direct_summary(self) -> None:
        samples = [Sample(at(m), float(m), True) for m in range(0, 60, 2)]
        hours = [
            summarize(group, M5, interval_s=120)
            for _, group in sorted(group_by_bucket(samples, M5).items())
        ]
        combined = combine(hours, H1, interval_s=120)
        direct = summarize(samples, H1, interval_s=120)
        assert combined.avg == pytest.approx(direct.avg)
        assert (combined.min, combined.max, combined.last) == (direct.min, direct.max, direct.last)
        assert (combined.good_samples, combined.coverage) == (30, 1.0)

    def test_combine_skips_empty_parts_and_keeps_last_value(self) -> None:
        full = Summary(10.0, 5.0, 15.0, 12.0, 6, 6, 1.0)
        empty = Summary(None, None, None, None, 3, 0, 0.0)
        combined = combine([full, empty], timedelta(minutes=10), interval_s=50)
        assert (combined.last, combined.samples, combined.good_samples) == (12.0, 9, 6)
        assert combined.coverage == 0.5
        assert combine([empty], H1, interval_s=10).avg is None

    def test_group_by_bucket(self) -> None:
        groups = group_by_bucket([Sample(at(m), 1.0, True) for m in (0, 4, 5, 11)], M5)
        assert {k: len(v) for k, v in groups.items()} == {at(0): 2, at(5): 1, at(10): 1}
