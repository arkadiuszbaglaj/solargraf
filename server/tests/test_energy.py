"""Energia za okres i wskaźniki D27 (D48): liczniki, resety, luki, moc, KPI."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solargraf_server.aggregation import H1, M5
from solargraf_server.energy import (
    MAX_POWER_W,
    HourEnergy,
    HourStatus,
    KpiStatus,
    counter_hours,
    hour_starts,
    power_hours,
    ratio_kpi,
    total,
)

T0 = datetime(2026, 11, 7, 0, 0, tzinfo=UTC)


def hours(n: int) -> list[datetime]:
    return [T0 + i * H1 for i in range(n)]


def ok(wh: float, i: int = 0) -> HourEnergy:
    return HourEnergy(T0 + i * H1, wh, 1.0, HourStatus.OK)


def gap(i: int = 0) -> HourEnergy:
    return HourEnergy(T0 + i * H1, None, 0.0, HourStatus.GAP)


class TestCounters:
    def test_deltas_between_consecutive_hours(self) -> None:
        last = {T0 - H1: 1000.0, T0: 1500.0, T0 + H1: 1500.0, T0 + 2 * H1: 2700.0}
        result = counter_hours(hours(3), last)
        assert [h.wh for h in result] == [500.0, 0.0, 1200.0]  # 0 Wh to prawdziwa wartość
        assert all(h.status is HourStatus.OK for h in result)

    def test_gap_is_not_bridged(self) -> None:
        last = {T0 - H1: 1000.0, T0 + H1: 3000.0}  # brak odczytu w godzinie T0
        result = counter_hours(hours(2), last)
        assert [h.status for h in result] == [HourStatus.GAP, HourStatus.GAP]
        assert [h.wh for h in result] == [None, None]

    def test_reset_and_implausible_jump_are_skipped(self) -> None:
        last = {
            T0 - H1: 50_000.0,
            T0: 120.0,  # reset licznika
            T0 + H1: 620.0,
            T0 + 2 * H1: 620.0 + MAX_POWER_W + 1,  # skok > 100 kWh w godzinę
        }
        result = counter_hours(hours(3), last)
        assert [h.status for h in result] == [HourStatus.RESET, HourStatus.OK, HourStatus.INVALID]
        assert [h.wh for h in result] == [None, 500.0, None]

    def test_totals_buckets_and_reset_flag(self) -> None:
        last = {T0 - H1: 0.0, T0: 100.0, T0 + H1: 50.0, T0 + 2 * H1: 350.0, T0 + 3 * H1: 400.0}
        per_hour = counter_hours(hours(4), last)
        result = total(per_hour, lambda h: T0 if h < T0 + 2 * H1 else T0 + 2 * H1)
        assert (result.wh, result.coverage, result.reset_detected) == (450.0, 0.75, True)
        assert [(b.start, b.wh, b.coverage) for b in result.buckets] == [
            (T0, 100.0, 0.5),
            (T0 + 2 * H1, 350.0, 1.0),
        ]

    def test_no_data_total_is_none(self) -> None:
        result = total(counter_hours(hours(2), {}), lambda h: T0)
        assert (result.wh, result.coverage) == (None, 0.0)


class TestPower:
    def test_power_integrated_from_five_minute_averages(self) -> None:
        # 12 przedziałów po 600 W = 600 Wh; drugi godzina: 6 przedziałów po 1200 W, pokrycie 0.5
        first = [(T0 + i * M5, 600.0, 1.0) for i in range(12)]
        second = [(T0 + H1 + i * M5, 1200.0, 1.0) for i in range(6)]
        empty = [(T0 + H1 + 6 * M5, None, 0.0)]
        result = power_hours(hours(3), [*first, *second, *empty])
        assert result[0].wh == pytest.approx(600.0)
        assert (result[0].coverage, result[0].status) == (1.0, HourStatus.OK)
        assert result[1].wh == pytest.approx(600.0)
        assert result[1].coverage == pytest.approx(0.5)
        assert (result[2].wh, result[2].status) == (None, HourStatus.GAP)


class TestKpi:
    def test_mockup_day_example(self) -> None:
        # Makieta: PV 28,4, zużycie 22,7, import 4,2, eksport 1,6 kWh — makieta podaje 89% dla obu.
        sc = ratio_kpi([ok(28_400)], [ok(1_600)], "brak produkcji")
        ss = ratio_kpi([ok(22_700)], [ok(4_200)], "brak zużycia")
        assert sc.value == pytest.approx((28.4 - 1.6) / 28.4)
        assert round((sc.value or 0) * 100, 1) == 94.4
        assert round((ss.value or 0) * 100, 1) == 81.5
        assert sc.status is ss.status is KpiStatus.OK

    def test_only_hours_with_both_sources_count(self) -> None:
        # Godzina 1 bez eksportu: nie liczymy jej produkcji (inaczej wskaźnik zawyżony).
        kpi = ratio_kpi([ok(1000, 0), ok(1000, 1)], [ok(200, 0), gap(1)], "x")
        assert kpi.value == pytest.approx(0.8)
        assert (kpi.status, kpi.coverage) == (KpiStatus.INCOMPLETE, 0.5)

    def test_zero_base_is_unavailable_not_zero_or_full(self) -> None:
        kpi = ratio_kpi([ok(0)], [ok(0)], "Brak produkcji PV w tym okresie.")
        assert (kpi.value, kpi.status) == (None, KpiStatus.UNAVAILABLE)
        assert kpi.reason == "Brak produkcji PV w tym okresie."

    def test_missing_source_and_no_data(self) -> None:
        assert ratio_kpi(None, [ok(1)], "x").status is KpiStatus.UNAVAILABLE
        assert ratio_kpi([gap()], [gap()], "x").reason == "Brak danych w tym okresie."

    def test_out_of_range_is_inconsistent_without_value(self) -> None:
        kpi = ratio_kpi([ok(1000)], [ok(1500)], "x")  # eksport > produkcja
        assert (kpi.value, kpi.status) == (None, KpiStatus.INCONSISTENT)

    def test_reset_marks_incomplete(self) -> None:
        reset = HourEnergy(T0 + H1, None, 0.0, HourStatus.RESET)
        kpi = ratio_kpi([ok(1000), reset], [ok(100), ok(0, 1)], "x")
        assert (kpi.status, kpi.reason) == (KpiStatus.INCOMPLETE, "Wykryto reset licznika.")


def test_hour_starts_cover_partial_edges() -> None:
    starts = hour_starts(T0 + timedelta(minutes=30), T0 + 2 * H1)
    assert starts == [T0, T0 + H1]
    assert hour_starts(T0, T0 + 2 * H1) == [T0, T0 + H1]


def test_bucket_size_and_local_month() -> None:
    from zoneinfo import ZoneInfo

    from solargraf_server.energy_api import bucket_size, local_month_start

    assert bucket_size(T0, T0 + 25 * H1) == "1h"
    assert bucket_size(T0, T0 + timedelta(days=31)) == "1d"
    assert bucket_size(T0, T0 + timedelta(days=365)) == "1mo"
    warsaw = ZoneInfo("Europe/Warsaw")
    # 31.10 23:30 UTC = 1.11 00:30 w Warszawie → miesiąc listopad, start 31.10 23:00 UTC.
    at = datetime(2026, 10, 31, 23, 30, tzinfo=UTC)
    assert local_month_start(at, warsaw) == datetime(2026, 10, 31, 23, 0, tzinfo=UTC)
