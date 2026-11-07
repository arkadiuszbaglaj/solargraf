"""Modele SunSpec (D59): definicje, adresy, wartości „nie zaimplementowano”, skale, profil."""

from __future__ import annotations

import copy
from decimal import Decimal
from typing import Any

import pytest
import yaml

from solargraf_profiles import sunspec
from solargraf_profiles.codec import CodecError, decode_sunspec, encode_sunspec
from solargraf_profiles.loader import ProfileError, parse_profile
from solargraf_profiles.model import Addressing, DataPoint, Profile

# Pierwszy model zaczyna się zaraz za znacznikiem „SunS” (2 rejestry) pod adresem bazowym 40000.
MODEL_START = 40002


# --- definicje modeli ---------------------------------------------------------------------


@pytest.mark.parametrize("model_id", sunspec.SUPPORTED_MODELS)
def test_bundled_models_load_with_header(model_id: int) -> None:
    model = sunspec.load_model(model_id)
    assert model.id == model_id
    assert model.point("ID").offset == 0
    assert model.point("L").offset == 1


def test_unsupported_model_is_rejected() -> None:
    with pytest.raises(sunspec.SunSpecError, match="nie jest obsługiwany"):
        sunspec.load_model(802)


def test_offsets_follow_definition_order() -> None:
    model = sunspec.load_model(103)
    w = model.point("W")
    assert (w.type, w.units, w.sf) == ("int16", "W", "W_SF")
    assert model.address(MODEL_START, "W") == MODEL_START + 14
    assert model.address(MODEL_START, "WH") == MODEL_START + 24
    assert model.point("WH").size == 2
    # Część stała = ID + L + L rejestrów treści; model 103 ma L = 50.
    assert model.fixed.size == 52


def test_unknown_point_and_group() -> None:
    model = sunspec.load_model(103)
    with pytest.raises(sunspec.SunSpecError, match="nie ma punktu"):
        model.point("Wmax")
    with pytest.raises(sunspec.SunSpecError, match="nie ma grupy"):
        model.point("DCW", "module")


def test_repeating_group_count_and_address() -> None:
    model = sunspec.load_model(160)
    assert model.fixed.size == 10
    assert model.repeating["module"].size == 20
    # L = 8 rejestrów części stałej po ID i L + 2 moduły po 20.
    assert model.repeat_count(48) == 2
    assert model.repeat_count(8) == 0
    with pytest.raises(sunspec.SunSpecError, match="nie pasuje"):
        model.repeat_count(50)
    second = model.address(MODEL_START, "DCW", "module", 1)
    assert second == MODEL_START + 10 + 20 + 11
    with pytest.raises(sunspec.SunSpecError, match="indeksu"):
        model.address(MODEL_START, "DCW", "module")


def test_scale_factor_point_in_group_or_fixed_part() -> None:
    model = sunspec.load_model(160)
    dcw = model.point("DCW", "module")
    sf = model.scale_factor_point(dcw, "module")
    assert sf is not None
    assert (sf.name, sf.type) == ("DCW_SF", "sunssf")
    assert model.scale_factor_point(model.point("N")) is None


# --- surowe wartości ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("point_type", "words"),
    [
        ("int16", [0x8000]),
        ("uint16", [0xFFFF]),
        ("acc16", [0]),
        ("int32", [0x8000, 0x0000]),
        ("uint32", [0xFFFF, 0xFFFF]),
        ("acc32", [0, 0]),
        ("float32", [0x7FC0, 0x0000]),  # NaN
    ],
)
def test_not_implemented_is_missing_not_zero(point_type: str, words: list[int]) -> None:
    assert sunspec.decode_raw(point_type, words) is None
    assert sunspec.encode_raw(point_type, None) == words


@pytest.mark.parametrize(
    ("point_type", "words", "expected"),
    [
        ("int16", [0xFFFF], Decimal(-1)),
        ("int16", [0x7FFF], Decimal(32767)),
        ("uint16", [0], Decimal(0)),  # zmierzone zero w uint16 to wartość
        ("int32", [0xFFFF, 0xFFFE], Decimal(-2)),
        ("uint32", [0x0001, 0x0000], Decimal(65536)),
        ("acc32", [0x0012, 0xD687], Decimal(1234567)),
        ("float32", [0x3FC0, 0x0000], Decimal("1.5")),
    ],
)
def test_decode_and_encode_raw_roundtrip(
    point_type: str, words: list[int], expected: Decimal
) -> None:
    assert sunspec.decode_raw(point_type, words) == expected
    assert sunspec.encode_raw(point_type, expected) == words


def test_raw_rejects_wrong_input() -> None:
    with pytest.raises(sunspec.SunSpecError, match="wymaga 2 rejestrów"):
        sunspec.decode_raw("uint32", [1])
    with pytest.raises(sunspec.SunSpecError, match="nie niesie"):
        sunspec.decode_raw("string", [1])
    with pytest.raises(sunspec.SunSpecError, match="skończoną"):
        sunspec.decode_raw("float32", [0x7F80, 0x0000])  # +inf
    with pytest.raises(sunspec.SunSpecError, match="nie mieści"):
        sunspec.encode_raw("int16", Decimal(40000))
    with pytest.raises(sunspec.SunSpecError, match="nie zaimplementowano"):
        sunspec.encode_raw("int16", Decimal(-32768))


def test_scale_factor_range_and_missing() -> None:
    assert sunspec.decode_scale_factor(0xFFFE) == -2
    assert sunspec.decode_scale_factor(3) == 3
    assert sunspec.decode_scale_factor(0x8000) is None
    with pytest.raises(sunspec.SunSpecError, match="poza zakresem"):
        sunspec.decode_scale_factor(11)
    assert sunspec.encode_scale_factor(-2) == 0xFFFE
    assert sunspec.scaled(Decimal(2305), -1) == Decimal("230.5")


# --- dekodowanie punktu profilu -----------------------------------------------------------


def sunspec_point(
    metric: str,
    model: int,
    name: str,
    unit: str,
    *,
    group: str | None = None,
    **extra: Any,  # noqa: ANN401 — dowolne pola testowe punktu
) -> DataPoint:
    ref: dict[str, Any] = {"model": model, "point": name}
    if group:
        ref["group"] = group
    return DataPoint.model_validate(
        {
            "metric": metric,
            "status": "UNVERIFIED",
            "source": "doc",
            "sunspec": ref,
            "unit": unit,
            **extra,
        }
    )


def test_decode_point_with_scale_factor() -> None:
    voltage = sunspec_point("grid_voltage", 103, "PhVphA", "V", channel=1)
    assert decode_sunspec(voltage, [2305], 0xFFFF) == Decimal("230.5")
    energy = sunspec_point("pv_energy_total", 103, "WH", "Wh")
    assert decode_sunspec(energy, [0x0012, 0xD687], 0) == Decimal(1234567)


def test_decode_point_missing_value_or_scale_is_none() -> None:
    power = sunspec_point("pv_power", 103, "DCW", "W")
    assert decode_sunspec(power, [0x8000], 0) is None
    assert decode_sunspec(power, [1200], 0x8000) is None
    with pytest.raises(CodecError, match="rejestru skali"):
        decode_sunspec(power, [1200])


def test_decode_point_with_inverted_sign() -> None:
    grid = sunspec_point("grid_power", 203, "W", "W", sign="invert")
    assert decode_sunspec(grid, [0xFF9C], 1) == Decimal(1000)  # -100 x 10, odwrócone


def test_encode_point_roundtrip_and_missing() -> None:
    string_power = sunspec_point("pv_string_power", 160, "DCW", "W", group="module", channel=2)
    words = encode_sunspec(string_power, Decimal("1234.5"), -1)
    assert words == [12345]
    assert decode_sunspec(string_power, words, sunspec.encode_scale_factor(-1)) == Decimal("1234.5")
    assert encode_sunspec(string_power, None, 0) == [0xFFFF]
    with pytest.raises(CodecError, match="nie mieści"):
        encode_sunspec(string_power, Decimal(70000), 0)


# --- walidacja profilu --------------------------------------------------------------------


def sunspec_profile() -> dict[str, Any]:
    """Minimalny poprawny profil SunSpec (dane testowe, nie rzeczywisty sprzęt)."""
    return {
        "schema_version": 1,
        "id": "test.sunspec-inverter",
        "version": "1.0.0",
        "name": "Falownik SunSpec testowy",
        "manufacturer": "Producent testowy",
        "device_kind": "INVERTER",
        "origin": "DEVICE",
        "support_level": "COMMUNITY",
        "models": ["T-1"],
        "transports": ["MODBUS_TCP"],
        "addressing": "sunspec",
        "sources": [{"id": "doc", "title": "Dokument testowy", "version": "1.0"}],
        "polling": {
            "interval_seconds": 10,
            "timeout_seconds": 3,
            "retries": 1,
            "max_block_registers": 60,
        },
        "points": [
            {
                "metric": "pv_power",
                "status": "UNVERIFIED",
                "source": "doc",
                "sunspec": {"model": 103, "point": "DCW"},
                "unit": "W",
            },
            {
                "metric": "pv_string_power",
                "channel": 1,
                "status": "UNVERIFIED",
                "source": "doc",
                "sunspec": {"model": 160, "group": "module", "point": "DCW"},
                "unit": "W",
            },
        ],
    }


def parse(data: dict[str, Any]) -> Profile:
    return parse_profile(yaml.safe_dump(data, allow_unicode=True))


def sunspec_errors(data: dict[str, Any]) -> str:
    with pytest.raises(ProfileError) as exc:
        parse(data)
    return str(exc.value)


def with_first(**changes: Any) -> dict[str, Any]:  # noqa: ANN401 — dowolne wartości testowe
    data = sunspec_profile()
    data["points"][0].update(changes)
    return data


def test_sunspec_profile_is_valid() -> None:
    profile = parse(sunspec_profile())
    assert profile.addressing is Addressing.SUNSPEC
    assert profile.sunspec_models == [103, 160]
    assert profile.points[0].reg is None


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"sunspec": {"model": 802, "point": "W"}}, "nie jest obsługiwany"),
        ({"sunspec": {"model": 103, "point": "Nope"}}, "nie ma punktu"),
        ({"sunspec": {"model": 103, "point": "W_SF"}}, "bez wartości metryki"),
        ({"unit": "kW"}, "nie zgadza się"),
        ({"scale": 0.1}, "stałej skali"),
        ({"sunspec": {"model": 103, "group": "module", "point": "DCW"}}, "nie ma grupy"),
        (
            {"register": {"table": "holding", "address": 1, "type": "s16"}},
            "dokładnie jednego",
        ),
    ],
)
def test_invalid_sunspec_point(changes: dict[str, Any], message: str) -> None:
    assert message in sunspec_errors(with_first(**changes))


def test_group_point_requires_channeled_metric() -> None:
    data = with_first(sunspec={"model": 160, "group": "module", "point": "DCW"})
    assert "wymaga metryki z kanałami" in sunspec_errors(data)


def test_addressing_must_match_points() -> None:
    data = sunspec_profile()
    data["addressing"] = "registers"
    assert "niezgodny z addressing" in sunspec_errors(data)


def test_same_sunspec_point_twice_is_rejected() -> None:
    data = sunspec_profile()
    second = copy.deepcopy(data["points"][0])
    second["metric"] = "grid_power"
    data["points"].append(second)
    assert "ten sam punkt SunSpec" in sunspec_errors(data)


def test_unsupported_point_has_no_sunspec_ref() -> None:
    data = with_first(status="UNSUPPORTED", unit=None)
    data["points"][0].pop("unit")
    assert "UNSUPPORTED" in sunspec_errors(data)
