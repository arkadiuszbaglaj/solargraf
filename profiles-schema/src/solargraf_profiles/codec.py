"""Zamiana rejestrów Modbus na wartości kanoniczne i odwrotnie (D40).

Wspólne dla agenta (dekodowanie) i symulatora (kodowanie), żeby obie strony czytały profil
tak samo. Bajty w słowie: big-endian (standard Modbus); kolejność słów z profilu.

Wartość kanoniczna = surowa liczba x ``scale`` x mnożnik jednostki x znak.

Punkty SunSpec (D59): surowa liczba x 10^sf (rejestr skali z urządzenia) x mnożnik jednostki
x znak; wartość „nie zaimplementowano” albo brak skali to ``None`` — brak danych, nie zero.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Sequence
from decimal import ROUND_HALF_EVEN, Decimal

from solargraf_profiles import sunspec
from solargraf_profiles.catalog import UNITS
from solargraf_profiles.model import DataPoint, DataType, Register, Sign, WordOrder

_INT_RANGES: dict[DataType, tuple[int, int]] = {
    DataType.U16: (0, 0xFFFF),
    DataType.S16: (-0x8000, 0x7FFF),
    DataType.U32: (0, 0xFFFF_FFFF),
    DataType.S32: (-0x8000_0000, 0x7FFF_FFFF),
}


class CodecError(ValueError):
    """Wartości nie da się zakodować albo rejestry nie dają poprawnej liczby."""


def _factor(point: DataPoint) -> Decimal:
    if point.unit is None:
        raise CodecError(f"punkt {point.metric} nie ma jednostki (UNSUPPORTED)")
    factor = point.scale * UNITS[point.unit].to_canonical
    return -factor if point.sign is Sign.INVERT else factor


def _readable(point: DataPoint) -> tuple[Register, Decimal]:
    factor = _factor(point)
    if point.reg is None:
        raise CodecError(f"punkt {point.metric} nie ma rejestru (adresowanie SunSpec)")
    return point.reg, factor


def _sunspec_point(point: DataPoint) -> sunspec.SunSpecPoint:
    if point.sunspec is None:
        raise CodecError(f"punkt {point.metric} nie jest punktem SunSpec")
    return point.sunspec.resolve()


def _scale_factor(definition: sunspec.SunSpecPoint, sf_word: int | None) -> tuple[bool, int | None]:
    """(czy wartość jest dostępna, wykładnik). Skala w definicji może być stałą liczbą."""
    if isinstance(definition.sf, int):
        return True, definition.sf
    if definition.sf is None:
        return True, None
    if sf_word is None:
        raise CodecError(f"punkt SunSpec {definition.name} wymaga rejestru skali {definition.sf}")
    try:
        value = sunspec.decode_scale_factor(sf_word)
    except sunspec.SunSpecError as exc:
        raise CodecError(str(exc)) from None
    return value is not None, value


def _words_to_bytes(reg: Register, words: Sequence[int]) -> bytes:
    if len(words) != reg.type.registers:
        raise CodecError(f"oczekiwano {reg.type.registers} rejestrów, otrzymano {len(words)}")
    if any(not 0 <= w <= 0xFFFF for w in words):
        raise CodecError("rejestr spoza zakresu 0..65535")
    ordered = list(words)
    if reg.word_order is WordOrder.LOW_FIRST:
        ordered.reverse()
    return b"".join(w.to_bytes(2, "big") for w in ordered)


def _bytes_to_words(reg: Register, data: bytes) -> list[int]:
    words = [int.from_bytes(data[i : i + 2], "big") for i in range(0, len(data), 2)]
    if reg.word_order is WordOrder.LOW_FIRST:
        words.reverse()
    return words


def decode(point: DataPoint, words: Sequence[int]) -> Decimal:
    """Rejestry → wartość w jednostce kanonicznej metryki."""
    reg, factor = _readable(point)
    data = _words_to_bytes(reg, words)
    if reg.type is DataType.F32:
        number = struct.unpack(">f", data)[0]
        if not math.isfinite(number):
            raise CodecError("f32 nie jest liczbą skończoną")
        return Decimal(repr(number)) * factor
    signed = reg.type in (DataType.S16, DataType.S32)
    return Decimal(int.from_bytes(data, "big", signed=signed)) * factor


def decode_sunspec(
    point: DataPoint, words: Sequence[int], sf_word: int | None = None
) -> Decimal | None:
    """Rejestry punktu SunSpec (+ rejestr skali) → wartość kanoniczna; None — brak wartości."""
    definition = _sunspec_point(point)
    factor = _factor(point)
    available, scale_factor = _scale_factor(definition, sf_word)
    try:
        raw = sunspec.decode_raw(definition.type, words)
    except sunspec.SunSpecError as exc:
        raise CodecError(str(exc)) from None
    if raw is None or not available:
        return None
    return sunspec.scaled(raw, scale_factor) * factor


def encode_sunspec(point: DataPoint, value: Decimal | None, scale_factor: int) -> list[int]:
    """Wartość kanoniczna → rejestry punktu SunSpec przy podanej skali (symulator, testy).

    ``None`` daje wartość „nie zaimplementowano”. Skala stała z definicji ma pierwszeństwo.
    """
    definition = _sunspec_point(point)
    factor = _factor(point)
    if isinstance(definition.sf, int):
        scale_factor = definition.sf
    elif definition.sf is None:
        scale_factor = 0
    raw: Decimal | None = None
    if value is not None:
        raw = (value / factor).scaleb(-scale_factor)
        if definition.type != "float32":
            raw = raw.to_integral_value(rounding=ROUND_HALF_EVEN)
    try:
        return sunspec.encode_raw(definition.type, raw)
    except sunspec.SunSpecError as exc:
        raise CodecError(f"{point.metric}: {exc}") from None


def encode(point: DataPoint, value: Decimal) -> list[int]:
    """Wartość w jednostce kanonicznej → rejestry (zaokrąglenie do rozdzielczości rejestru)."""
    reg, factor = _readable(point)
    raw = value / factor
    if reg.type is DataType.F32:
        data = struct.pack(">f", float(raw))
    else:
        number = int(raw.to_integral_value(rounding=ROUND_HALF_EVEN))
        low, high = _INT_RANGES[reg.type]
        if not low <= number <= high:
            raise CodecError(f"{point.metric}: {value} nie mieści się w {reg.type}")
        data = number.to_bytes(reg.type.registers * 2, "big", signed=low < 0)
    return _bytes_to_words(reg, data)
