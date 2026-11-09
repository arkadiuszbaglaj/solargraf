"""Raport energii (D74): zakres okresu, wiersze CSV i nazwa pliku — bez bazy."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from solargraf_server.energy_api import (
    EnergyBucketOut,
    EnergySeriesOut,
    KpiOut,
    KpisOut,
    UnavailableSeriesOut,
)
from solargraf_server.reports import ReportOut, kwh, report_filename, report_range, report_rows

WARSAW = ZoneInfo("Europe/Warsaw")


def test_month_range_in_site_timezone() -> None:
    # Marzec 2026 ma zmianę czasu: start 1.03 00:00 CET = 28.02 23:00 UTC, koniec CEST.
    start, end = report_range(2026, 3, WARSAW)
    assert start == datetime(2026, 2, 28, 23, tzinfo=UTC)
    assert end == datetime(2026, 3, 31, 22, tzinfo=UTC)


def test_december_and_year_ranges() -> None:
    start, end = report_range(2026, 12, WARSAW)
    assert (start, end) == (
        datetime(2026, 11, 30, 23, tzinfo=UTC),
        datetime(2026, 12, 31, 23, tzinfo=UTC),
    )
    start, end = report_range(2026, None, WARSAW)
    assert (start, end) == (
        datetime(2025, 12, 31, 23, tzinfo=UTC),
        datetime(2026, 12, 31, 23, tzinfo=UTC),
    )


def test_kwh_keeps_missing_as_empty() -> None:
    assert kwh(None) == ""
    assert kwh(0.0) == "0,0"
    assert kwh(1234.5678) == "1,235"


def _kpi(value: float | None, status: str) -> KpiOut:
    return KpiOut(value=value, status=status, reason=None, coverage=1.0, definition="x")  # type: ignore[arg-type]


def _series(key: str, values: list[float | None], total: float | None) -> EnergySeriesOut:
    days = [datetime(2026, 10, 31, 23, tzinfo=UTC), datetime(2026, 11, 1, 23, tzinfo=UTC)]
    return EnergySeriesOut(
        key=key,
        metric=f"{key}_metric",
        device_id=uuid.uuid4(),
        source="COUNTER",
        total_wh=total,
        coverage=1.0,
        reset_detected=False,
        buckets=[
            EnergyBucketOut(t=t, wh=v, coverage=1.0) for t, v in zip(days, values, strict=True)
        ],
    )


def _report(origins: list[str]) -> ReportOut:
    return ReportOut(
        timezone="Europe/Warsaw",
        bucket="1d",
        origins=origins,
        # Kolejność serii z API inna niż kolumn — raport układa kolumny stałą kolejnością.
        series=[_series("load", [2000.0, None], 2000.0), _series("pv", [5000.0, 1500.0], 6500.0)],
        kpis=KpisOut(self_consumption=_kpi(0.75, "OK"), self_sufficiency=_kpi(None, "UNAVAILABLE")),
        unavailable=[
            UnavailableSeriesOut(key="grid_import", metric="m", reason="NOT_PROVIDED", sources=0)
        ],
        period="month",
        year=2026,
        month=11,
        start=datetime(2026, 10, 31, 23, tzinfo=UTC),
        end=datetime(2026, 11, 30, 23, tzinfo=UTC),
    )


def test_rows_in_local_days_with_gaps_totals_and_kpis() -> None:
    rows = list(report_rows(_report(["SIMULATED"])))
    assert rows[0] == ["okres", "Produkcja PV [kWh]", "Zużycie domu [kWh]"]
    assert rows[1] == ["2026-11-01", "5,0", "2,0"]
    assert rows[2] == ["2026-11-02", "1,5", ""]  # brak danych — puste pole, nie 0
    assert rows[3] == ["Razem", "6,5", "2,0"]
    assert ["Autokonsumpcja [%]", "75,0"] in rows
    assert ["Samowystarczalność [%]", ""] in rows
    assert ["Niedostępne serie", "Pobór z sieci"] in rows
    assert ["Pochodzenie danych", "SIMULATED"] in rows


def test_filename_marks_simulated_data() -> None:
    simulated = report_filename("Dom Łąka", _report(["SIMULATED"]))
    assert simulated == "raport_dom-laka_2026-11_SIMULATED.csv"
    assert report_filename("Dom", _report(["DEVICE"])) == "raport_dom_2026-11.csv"
