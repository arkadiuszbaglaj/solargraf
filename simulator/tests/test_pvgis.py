"""Produkcja PV z danych PVGIS (D77): walidacja plików, odwzorowanie czasu i model instalacji."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solargraf_simulator import pvgis
from solargraf_simulator.cli import _parser
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.pvgis import HOURS, PvProfile, parse


def synthetic(values: list[int], offset_s: int = 600) -> PvProfile:
    """Profil testowy niezależny od dołączonych danych."""
    return PvProfile("test", "Test", 2023, "test", offset_s, tuple(values))


def raw(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "origin": "SIMULATED",
        "attribution": "PVGIS © European Communities, 2001-2026",
        "location": {"key": "x", "name": "X"},
        "year": 2023,
        "start": "2023-01-01T00:10:00Z",
        "step_s": 3600,
        "unit": "W/kWp",
        "values": [0] * HOURS,
    }
    return data | overrides


class TestBundledData:
    def test_four_polish_locations_with_attribution_and_plausible_yield(self) -> None:
        assert pvgis.available() == ["gdansk", "krakow", "warszawa", "wroclaw"]
        for key in pvgis.available():
            profile = pvgis.load(key)
            assert profile.attribution == "PVGIS © European Communities, 2001-2026"
            assert 0 <= profile.first_offset_s < 3600  # PVGIS: hh:mm w pierwszej godzinie
            # Roczny uzysk w Polsce: ok. 900 do 1200 kWh z 1 kWp.
            assert 900 <= sum(profile.values) / 1000 <= 1200
            # Noc zimą bez produkcji, lato w południe z produkcją.
            assert profile.per_kwp(datetime(2026, 12, 21, 23, 10, tzinfo=UTC)) == 0
            june_noons = [
                profile.per_kwp(datetime(2026, 6, day, 10, 10, tzinfo=UTC)) for day in range(1, 31)
            ]
            assert max(june_noons) > 500

    def test_unknown_location(self) -> None:
        with pytest.raises(ValueError, match="brak danych"):
            pvgis.load("berlin")


class TestTimeMapping:
    def test_sample_times_and_linear_interpolation(self) -> None:
        values = [0] * HOURS
        values[12] = 600  # 2023-01-01 12:10 UTC
        values[13] = 300
        p = synthetic(values)
        assert p.per_kwp(datetime(2026, 1, 1, 12, 10, tzinfo=UTC)) == 600
        assert p.per_kwp(datetime(2026, 1, 1, 12, 40, tzinfo=UTC)) == pytest.approx(450)
        assert p.per_kwp(datetime(2026, 1, 1, 11, 40, tzinfo=UTC)) == pytest.approx(300)
        # Ta sama chwila w innym roku daje tę samą wartość; strefa wejścia nie ma znaczenia.
        other = datetime(2030, 1, 1, 13, 10, tzinfo=UTC) + timedelta(hours=-1)
        assert p.per_kwp(other) == 600

    def test_year_wraps_and_leap_day_repeats_february_28(self) -> None:
        values = list(range(HOURS))
        p = synthetic([v % 1000 for v in values])
        # Przed pierwszą próbką (00:00) — między ostatnią godziną roku a pierwszą.
        last = (HOURS - 1) % 1000
        assert p.per_kwp(datetime(2026, 1, 1, 0, 10, tzinfo=UTC) - timedelta(minutes=30)) == (
            pytest.approx(last + (0 - last) * 0.5)
        )
        feb28 = p.per_kwp(datetime(2028, 2, 28, 12, 10, tzinfo=UTC))
        assert p.per_kwp(datetime(2028, 2, 29, 12, 10, tzinfo=UTC)) == feb28
        # Po dniu przestępnym kalendarz wraca do zwykłego: 1 marca jak w roku danych.
        assert p.per_kwp(datetime(2028, 3, 1, 12, 10, tzinfo=UTC)) == p.per_kwp(
            datetime(2026, 3, 1, 12, 10, tzinfo=UTC)
        )


class TestParse:
    def test_valid_file(self) -> None:
        profile = parse(raw())
        assert (profile.key, profile.year, profile.first_offset_s) == ("x", 2023, 600)

    @pytest.mark.parametrize(
        "overrides",
        [
            {"values": [0] * (HOURS - 1)},
            {"values": [-1] + [0] * (HOURS - 1)},
            {"values": [1201] + [0] * (HOURS - 1)},
            {"values": [0.5] + [0] * (HOURS - 1)},
            {"unit": "kW"},
            {"origin": "DEVICE"},
            {"step_s": 900},
            {"start": "2023-01-01T01:10:00Z"},
            {"start": "2022-12-31T23:10:00Z"},
            {"location": None},
        ],
    )
    def test_rejects_invalid(self, overrides: dict[str, object]) -> None:
        with pytest.raises(ValueError, match="dane PVGIS"):
            parse(raw(**overrides))


class TestPlantWithProfile:
    def test_power_scales_with_peak_and_balance_holds(self) -> None:
        values = [0] * HOURS
        values[12] = 800
        cfg = PlantConfig(pv_peak_w=5000, pv_profile=synthetic(values))
        at = datetime(2026, 1, 1, 12, 10, tzinfo=UTC)
        plant = Plant(cfg, now=at)
        assert plant.pv_power(at) == pytest.approx(4000)  # 800 W/kWp x 5 kWp
        load = plant.pv_power(at) + plant.battery_power(at) + plant.grid_power(at)
        assert load == pytest.approx(plant.load_power(at))
        assert plant.pv_power(at + timedelta(hours=6)) == 0

    def test_energy_counter_integrates_profile(self) -> None:
        values = [0] * HOURS
        values[10] = values[11] = 1000  # 10:10 i 11:10 — godzina stałej mocy
        at = datetime(2026, 1, 1, 10, 10, tzinfo=UTC)
        plant = Plant(PlantConfig(pv_peak_w=2000, pv_profile=synthetic(values)), now=at)
        plant.advance(at + timedelta(hours=1))
        assert plant.pv_energy_wh == pytest.approx(2000)  # 2 kW przez 1 h


def test_cli_location_choice() -> None:
    assert _parser().parse_args(["p.yaml"]).pv_location == "warszawa"
    assert _parser().parse_args(["p.yaml", "--pv-location", "sinus"]).pv_location == "sinus"
    with pytest.raises(SystemExit):
        _parser().parse_args(["p.yaml", "--pv-location", "berlin"])
