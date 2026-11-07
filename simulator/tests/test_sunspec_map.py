"""Mapa SunSpec symulatora (D59): układ modeli, wartości „nie zaimplementowano”, błędy adresu."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from solargraf_profiles import sunspec
from solargraf_profiles.codec import decode_sunspec
from solargraf_profiles.model import Profile, RegisterTable
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import ModbusException
from solargraf_simulator.sunspec_map import SunSpecRegisterMap

NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
BASE = 40000


def sunspec_profile(points: list[dict[str, Any]]) -> Profile:
    """Profil testowy SunSpec (SIMULATED) — nie opisuje rzeczywistego urządzenia."""
    return Profile.model_validate(
        {
            "schema_version": 1,
            "id": "simulated.sunspec-test",
            "version": "1.0.0",
            "name": "SunSpec testowy",
            "manufacturer": "SIMULATED",
            "device_kind": "INVERTER",
            "origin": "SIMULATED",
            "support_level": "EXPERIMENTAL",
            "models": ["SIM"],
            "transports": ["MODBUS_TCP"],
            "addressing": "sunspec",
            "sources": [{"id": "sunspec", "title": "Modele SunSpec", "version": "v2026-04-20"}],
            "polling": {
                "interval_seconds": 10,
                "timeout_seconds": 1,
                "retries": 0,
                "max_block_registers": 125,
            },
            "points": points,
        }
    )


def ref(metric: str, model: int, name: str, unit: str, **extra: Any) -> dict[str, Any]:  # noqa: ANN401
    sunspec_ref: dict[str, Any] = {"model": model, "point": name}
    if "group" in extra:
        sunspec_ref["group"] = extra.pop("group")
    return {
        "metric": metric,
        "status": "UNVERIFIED",
        "source": "sunspec",
        "sunspec": sunspec_ref,
        "unit": unit,
        **extra,
    }


PROFILE = sunspec_profile(
    [
        ref("pv_power", 103, "DCW", "W"),
        ref("pv_string_power", 160, "DCW", "W", group="module", channel=1),
        ref("pv_string_power", 160, "DCW", "W", group="module", channel=2),
    ]
)


@pytest.fixture
def metrics() -> dict[str, Decimal]:
    return Plant(PlantConfig(), now=NOON_UTC).metrics()


def test_layout_marker_models_and_end(metrics: dict[str, Decimal]) -> None:
    regs = SunSpecRegisterMap([PROFILE])
    words = regs.snapshot(metrics)
    assert (words[BASE], words[BASE + 1]) == sunspec.SUNS_MARKER
    starts = [(m.model.id, m.start, m.length) for m in regs.models]
    # Common (L=66), falownik 103 (L=50), MPPT 160 z dwoma modułami (8 + 2 x 20).
    assert starts == [(1, 40002, 66), (103, 40070, 50), (160, 40122, 48)]
    for model_id, start, length in starts:
        assert (words[start], words[start + 1]) == (model_id, length)
    assert (words[regs.end], words[regs.end + 1]) == (sunspec.END_MODEL_ID, 0)
    assert words[sunspec.load_model(160).address(40122, "N")] == 2


def test_values_scale_and_not_implemented(metrics: dict[str, Decimal]) -> None:
    regs = SunSpecRegisterMap([PROFILE])
    words = regs.snapshot(metrics)
    model = sunspec.load_model(103)
    dcw = model.address(40070, "DCW")
    sf = model.scale_factor_address(40070, "DCW")
    assert sf is not None
    assert decode_sunspec(PROFILE.points[0], [words[dcw]], words[sf]) == metrics["pv_power"]
    # Punkty, których profil nie używa: „nie zaimplementowano”, nigdy zero.
    assert words[model.address(40070, "W")] == 0x8000  # int16
    assert words[model.address(40070, "Hz")] == 0xFFFF  # uint16
    wh = model.address(40070, "WH")
    assert (words[wh], words[wh + 1]) == (0, 0)  # acc32
    assert words[model.address(40070, "Hz_SF")] == 0x8000


def test_common_model_is_marked_simulated(metrics: dict[str, Decimal]) -> None:
    regs = SunSpecRegisterMap([PROFILE], unit_id=7)
    words = regs.snapshot(metrics)
    common = sunspec.load_model(1)
    mn = common.address(40002, "Mn")
    text = b"".join(words[a].to_bytes(2, "big") for a in range(mn, mn + 16)).rstrip(b"\0")
    assert text == b"SIMULATED"
    assert words[common.address(40002, "DA")] == 7


def test_address_errors_never_zero(metrics: dict[str, Decimal]) -> None:
    regs = SunSpecRegisterMap([PROFILE])
    with pytest.raises(ModbusException) as exc:
        regs.read(metrics, RegisterTable.HOLDING, regs.end, 3)  # za znacznikiem końca
    assert exc.value.code == ModbusException.ILLEGAL_DATA_ADDRESS
    with pytest.raises(ModbusException) as exc:
        regs.read(metrics, RegisterTable.INPUT, BASE, 2)
    assert exc.value.code == ModbusException.ILLEGAL_DATA_ADDRESS
    with pytest.raises(ModbusException) as exc:
        regs.read(metrics, RegisterTable.HOLDING, BASE, 126)
    assert exc.value.code == ModbusException.ILLEGAL_DATA_VALUE
    assert regs.read(metrics, RegisterTable.HOLDING, BASE, 2) == list(sunspec.SUNS_MARKER)


def test_rejects_register_profile_and_unknown_base() -> None:
    with pytest.raises(ValueError, match="adres bazowy"):
        SunSpecRegisterMap([PROFILE], base=1234)
    with pytest.raises(ValueError, match="addressing: sunspec"):
        SunSpecRegisterMap([])
