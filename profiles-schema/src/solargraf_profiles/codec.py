"""Zamiana rejestrów Modbus na wartości kanoniczne i odwrotnie (D40).

Wspólne dla agenta (dekodowanie) i symulatora (kodowanie), żeby obie strony czytały profil
tak samo. Bajty w słowie: big-endian (standard Modbus); kolejność słów z profilu.

Wartość kanoniczna = surowa liczba x ``scale`` x mnożnik jednostki x znak.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Sequence
from decimal import ROUND_HALF_EVEN, Decimal

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


def _readable(point: DataPoint) -> tuple[Register, Decimal]:
    if point.reg is None or point.unit is None:
        raise CodecError(f"punkt {point.metric} nie ma rejestru (UNSUPPORTED)")
    factor = point.scale * UNITS[point.unit].to_canonical
    if point.sign is Sign.INVERT:
        factor = -factor
    return point.reg, factor


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
