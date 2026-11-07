"""Walidacja profili urządzeń (D39)."""

from __future__ import annotations

import copy
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import yaml

from solargraf_profiles.catalog import CANONICAL_UNIT, METRICS, UNITS
from solargraf_profiles.cli import main
from solargraf_profiles.loader import ProfileError, load_directory, load_profile, parse_profile
from solargraf_profiles.model import Profile

REPO_PROFILES = Path(__file__).resolve().parents[2] / "profiles"


def base() -> dict[str, Any]:
    """Minimalny poprawny profil urządzenia (dane testowe, nie rzeczywisty sprzęt)."""
    return {
        "schema_version": 1,
        "id": "testvendor.meter",
        "version": "1.0.0",
        "name": "Licznik testowy",
        "manufacturer": "Producent testowy",
        "device_kind": "METER",
        "origin": "DEVICE",
        "support_level": "COMMUNITY",
        "models": ["T-1"],
        "transports": ["MODBUS_TCP"],
        "sources": [{"id": "doc", "title": "Dokument testowy", "version": "1.0"}],
        "polling": {
            "interval_seconds": 10,
            "timeout_seconds": 3,
            "retries": 1,
            "max_block_registers": 60,
        },
        "points": [
            {
                "metric": "grid_power",
                "status": "UNVERIFIED",
                "source": "doc",
                "register": {
                    "table": "input",
                    "address": 10,
                    "type": "s32",
                    "word_order": "high_first",
                },
                "unit": "kW",
                "scale": 0.001,
            }
        ],
    }


def errors_of(data: dict[str, Any]) -> str:
    with pytest.raises(ProfileError) as exc:
        parse_profile(yaml.safe_dump(data, allow_unicode=True))
    return str(exc.value)


def with_point(**changes: Any) -> dict[str, Any]:  # noqa: ANN401 — dowolne wartości testowe
    data = base()
    data["points"][0].update(changes)
    return data


def test_base_profile_is_valid() -> None:
    profile = parse_profile(yaml.safe_dump(base()))
    assert profile.points[0].scale == Decimal("0.001")
    assert profile.points[0].reg is not None
    assert list(profile.points[0].reg.span) == [10, 11]


def test_repository_profiles_are_valid() -> None:
    result = load_directory(REPO_PROFILES)
    assert result.errors == []
    assert result.profiles, "katalog profiles/ nie może być pusty"


def test_simulated_profile_is_marked_and_experimental() -> None:
    profile = load_profile(REPO_PROFILES / "simulated.hybrid-inverter.yaml")
    assert profile.origin == "SIMULATED"
    assert profile.support_level == "EXPERIMENTAL"


class TestCatalog:
    def test_every_metric_has_canonical_unit_with_factor_one(self) -> None:
        for metric in METRICS.values():
            assert UNITS[metric.canonical_unit].to_canonical == 1

    def test_canonical_units(self) -> None:
        assert {q.value: u.value for q, u in CANONICAL_UNIT.items()} == {
            "POWER": "W",
            "ENERGY": "Wh",
            "VOLTAGE": "V",
            "CURRENT": "A",
            "FREQUENCY": "Hz",
            "TEMPERATURE": "degC",
            "RATIO": "%",
        }

    def test_sign_conventions(self) -> None:
        assert METRICS["grid_power"].sign_convention == "+ pobór z sieci, - eksport do sieci"
        assert METRICS["battery_power"].sign_convention == "+ rozładowanie, - ładowanie"
        assert not METRICS["pv_power"].signed


class TestPoints:
    def test_unknown_metric(self) -> None:
        assert "nieznana metryka" in errors_of(with_point(metric="grid_magic"))

    def test_unit_must_match_quantity(self) -> None:
        assert "nie pasuje do metryki" in errors_of(with_point(unit="kWh"))

    def test_unknown_unit(self) -> None:
        assert "points.0.unit" in errors_of(with_point(unit="kVA"))

    def test_scale_must_be_positive(self) -> None:
        assert "scale" in errors_of(with_point(scale=0))
        assert "scale" in errors_of(with_point(scale=-1))

    def test_invert_only_for_signed_metric(self) -> None:
        data = with_point(metric="load_power", sign="invert")
        assert "sign: invert" in errors_of(data)
        assert parse_profile(yaml.safe_dump(with_point(sign="invert"))).points[0].sign == "invert"

    def test_point_requires_register_and_unit(self) -> None:
        data = base()
        del data["points"][0]["register"]
        assert "wymaga register i unit" in errors_of(data)

    def test_unsupported_point_has_no_register(self) -> None:
        assert "UNSUPPORTED" in errors_of(with_point(status="UNSUPPORTED"))
        data = base()
        data["points"].append(
            {"metric": "grid_frequency", "status": "UNSUPPORTED", "source": "doc"}
        )
        assert parse_profile(yaml.safe_dump(data)).points[1].reg is None

    def test_channel_rules(self) -> None:
        assert "nie ma kanałów" in errors_of(with_point(channel=1))
        point = with_point(metric="grid_voltage", unit="V")
        assert "wymaga channel" in errors_of(point)

    def test_word_order_required_only_for_32_bit(self) -> None:
        reg32 = {"table": "input", "address": 10, "type": "u32"}
        assert "wymaga word_order" in errors_of(with_point(register=reg32))
        reg16 = {"table": "input", "address": 10, "type": "s16", "word_order": "low_first"}
        assert "nie ma word_order" in errors_of(with_point(register=reg16))

    def test_register_address_range(self) -> None:
        reg = {"table": "input", "address": 65535, "type": "s32", "word_order": "high_first"}
        assert "poza zakres" in errors_of(with_point(register=reg))

    def test_point_without_source_document(self) -> None:
        assert "nieznane źródła" in errors_of(with_point(source="forum"))

    def test_strict_types_reject_coercion(self) -> None:
        reg = {"table": "input", "address": "10", "type": "s16"}
        assert "address" in errors_of(with_point(register=reg))


class TestProfile:
    def test_overlapping_registers(self) -> None:
        data = base()
        data["points"].append(
            {
                "metric": "grid_frequency",
                "status": "UNVERIFIED",
                "source": "doc",
                "register": {"table": "input", "address": 11, "type": "u16"},
                "unit": "Hz",
            }
        )
        assert "nakłada się" in errors_of(data)
        data["points"][1]["register"]["table"] = "holding"
        parse_profile(yaml.safe_dump(data))  # inna tabela — bez konfliktu

    def test_duplicate_point(self) -> None:
        data = base()
        dup = copy.deepcopy(data["points"][0])
        dup["register"]["address"] = 100
        data["points"].append(dup)
        assert "powtórzony punkt grid_power" in errors_of(data)

    def test_sources_must_be_used_and_unique(self) -> None:
        data = base()
        data["sources"].append({"id": "doc", "title": "Duplikat", "version": "1"})
        assert "powtórzony identyfikator źródła" in errors_of(data)
        data["sources"][1]["id"] = "other"
        assert "nieużywane źródła" in errors_of(data)

    def test_source_requires_version(self) -> None:
        data = base()
        del data["sources"][0]["version"]
        assert "sources.0.version" in errors_of(data)

    def test_only_register_transports(self) -> None:
        data = base()
        data["transports"] = ["HTTP"]
        assert "transporty rejestrowe" in errors_of(data)

    def test_timeout_below_interval_and_block_limit(self) -> None:
        data = base()
        data["polling"]["timeout_seconds"] = 10
        assert "timeout_seconds" in errors_of(data)
        data = base()
        data["polling"]["max_block_registers"] = 126
        assert "max_block_registers" in errors_of(data)

    def test_verified_requires_hardware_test_and_verified_points(self) -> None:
        data = base()
        data["support_level"] = "VERIFIED"
        message = errors_of(data)
        assert "hardware_tests" in message
        assert "UNVERIFIED" in message
        data["hardware_tests"] = [{"model": "T-1", "firmware": "1.2", "tested_on": "2026-11-07"}]
        data["points"][0]["status"] = "VERIFIED"
        assert parse_profile(yaml.safe_dump(data)).support_level == "VERIFIED"

    def test_device_profile_requires_models(self) -> None:
        data = base()
        data["models"] = []
        assert "potwierdzonych modeli" in errors_of(data)

    def test_simulated_marking_cannot_be_faked(self) -> None:
        data = base()
        data["origin"] = "SIMULATED"
        assert "prefiksem" in errors_of(data)
        data["id"] = "simulated.meter"
        assert "tylko poziom EXPERIMENTAL" in errors_of(data)
        data = base()
        data["id"] = "simulated.meter"
        assert "prefiksem" in errors_of(data)

    def test_all_unsupported_is_rejected(self) -> None:
        data = base()
        data["points"] = [{"metric": "grid_power", "status": "UNSUPPORTED", "source": "doc"}]
        assert "odczytywalnego punktu" in errors_of(data)

    def test_unknown_field_and_version_format(self) -> None:
        data = base()
        data["registers_guess"] = True
        assert "registers_guess" in errors_of(data)
        data = base()
        data["version"] = "1.0"
        assert "version" in errors_of(data)

    def test_schema_version(self) -> None:
        data = base()
        data["schema_version"] = 2
        assert "schema_version" in errors_of(data)


class TestYaml:
    def test_duplicate_keys_are_rejected(self) -> None:
        text = yaml.safe_dump(base()) + "id: testvendor.other\n"
        with pytest.raises(ProfileError, match="powtórzony klucz 'id'"):
            parse_profile(text)

    def test_unsafe_tags_are_rejected(self) -> None:
        with pytest.raises(ProfileError, match="niepoprawny YAML"):
            parse_profile("!!python/object/apply:os.system ['echo x']")

    def test_top_level_must_be_mapping(self) -> None:
        with pytest.raises(ProfileError, match="mapy"):
            parse_profile("- a\n- b\n")

    def test_file_name_must_match_id(self, tmp_path: Path) -> None:
        path = tmp_path / "wrong-name.yaml"
        path.write_text(yaml.safe_dump(base()), encoding="utf-8")
        with pytest.raises(ProfileError, match=r"testvendor\.meter\.yaml"):
            load_profile(path)

    def test_directory_collects_all_errors(self, tmp_path: Path) -> None:
        (tmp_path / "testvendor.meter.yaml").write_text(yaml.safe_dump(base()), encoding="utf-8")
        (tmp_path / "broken.yaml").write_text("id: [", encoding="utf-8")
        (tmp_path / "x.yml").write_text("", encoding="utf-8")
        result = load_directory(tmp_path)
        assert [p.id for p in result.profiles] == ["testvendor.meter"]
        assert len(result.errors) == 2


class TestCli:
    def test_ok_and_error_exit_codes(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert main(["validate", str(REPO_PROFILES)]) == 0
        (tmp_path / "broken.yaml").write_text("id: [", encoding="utf-8")
        assert main(["validate", str(tmp_path)]) == 1
        assert "BŁĄD" in capsys.readouterr().err
        assert main(["validate", str(tmp_path / "missing")]) == 2


def test_profile_model_is_immutable() -> None:
    profile = parse_profile(yaml.safe_dump(base()))
    with pytest.raises(ValueError, match="frozen"):
        profile.name = "inna"
    assert isinstance(profile, Profile)
