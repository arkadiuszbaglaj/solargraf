"""Kodowanie i dekodowanie rejestrów (D40)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from solargraf_profiles.codec import CodecError, decode, encode
from solargraf_profiles.model import DataPoint


def point(
    type_: str,
    *,
    metric: str = "grid_power",
    unit: str = "W",
    scale: str = "1",
    word_order: str | None = None,
    sign: str = "normal",
) -> DataPoint:
    reg: dict[str, Any] = {"table": "input", "address": 0, "type": type_}
    if word_order:
        reg["word_order"] = word_order
    return DataPoint.model_validate(
        {
            "metric": metric,
            "status": "UNVERIFIED",
            "source": "doc",
            "register": reg,
            "unit": unit,
            "scale": Decimal(scale),
            "sign": sign,
        }
    )


@pytest.mark.parametrize(
    ("p", "words", "expected"),
    [
        (point("u16"), [0xFFFF], Decimal(65535)),
        (point("s16"), [0xFFFF], Decimal(-1)),
        (point("s16"), [0x8000], Decimal(-32768)),
        (point("u32", word_order="high_first"), [0x0001, 0x0002], Decimal(0x0001_0002)),
        (point("u32", word_order="low_first"), [0x0002, 0x0001], Decimal(0x0001_0002)),
        (point("s32", word_order="high_first"), [0xFFFF, 0xFFFE], Decimal(-2)),
        (point("s32", word_order="low_first"), [0xFFFE, 0xFFFF], Decimal(-2)),
        (point("f32", word_order="high_first"), [0x4049, 0x0FDB], Decimal("3.1415927410125732")),
        (point("f32", word_order="low_first"), [0x0FDB, 0x4049], Decimal("3.1415927410125732")),
    ],
)
def test_decode_types_and_word_order(p: DataPoint, words: list[int], expected: Decimal) -> None:
    assert decode(p, words) == expected


def test_scale_unit_and_sign() -> None:
    # 1234 x 0.01 kW = 12.34 kW = 12340 W
    assert decode(point("u16", unit="kW", scale="0.01"), [1234]) == Decimal("12340.00")
    # Urządzenie: + ładowanie; katalog: + rozładowanie → invert.
    battery = point("s16", metric="battery_power", sign="invert")
    assert decode(battery, [1500]) == Decimal(-1500)
    assert encode(battery, Decimal(-1500)) == [1500]


@pytest.mark.parametrize(
    ("p", "value"),
    [
        (point("u16", metric="pv_power", scale="0.1"), Decimal("1234.5")),
        (point("s16", scale="10"), Decimal(-32760)),
        (
            point("u32", metric="pv_energy_total", unit="kWh", scale="0.1", word_order="low_first"),
            Decimal(123_456_700),
        ),
        (point("s32", word_order="high_first"), Decimal(-100_000)),
        (
            point("f32", metric="grid_frequency", unit="Hz", word_order="high_first"),
            Decimal("50.0"),
        ),
    ],
)
def test_round_trip(p: DataPoint, value: Decimal) -> None:
    assert decode(p, encode(p, value)) == value


def test_encode_rounds_to_register_resolution() -> None:
    p = point("u16", metric="pv_power", scale="0.1")
    assert decode(p, encode(p, Decimal("12.34"))) == Decimal("12.3")


@pytest.mark.parametrize(
    ("p", "value"),
    [
        (point("u16", metric="pv_power"), Decimal(-1)),
        (point("u16", metric="pv_power"), Decimal(65536)),
        (point("s16"), Decimal(40000)),
    ],
)
def test_encode_out_of_range(p: DataPoint, value: Decimal) -> None:
    with pytest.raises(CodecError, match="nie mieści się"):
        encode(p, value)


def test_decode_rejects_bad_input() -> None:
    with pytest.raises(CodecError, match="oczekiwano 2"):
        decode(point("u32", word_order="high_first"), [1])
    with pytest.raises(CodecError, match="zakresu"):
        decode(point("u16"), [70000])
    with pytest.raises(CodecError, match="skończoną"):
        decode(point("f32", word_order="high_first"), [0x7FC0, 0x0000])  # NaN


def test_unsupported_point_cannot_be_coded() -> None:
    p = DataPoint.model_validate({"metric": "pv_power", "status": "UNSUPPORTED", "source": "doc"})
    with pytest.raises(CodecError, match="UNSUPPORTED"):
        decode(p, [0])
