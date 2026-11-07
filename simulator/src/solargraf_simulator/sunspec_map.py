"""Mapa SunSpec symulatora budowana z profili (D59) — dane SIMULATED, nie rzeczywiste urządzenie.

Układ: znacznik „SunS” pod adresem bazowym, model 1 (Common) z tekstem ``SIMULATED``, potem
modele wymagane przez profile w kolejności numerów i znacznik końca. Punkty, których profile nie
używają, mają wartość „nie zaimplementowano” — tak jak w urządzeniu, które ich nie obsługuje.
Liczba powtórzeń grupy (np. moduły MPPT modelu 160) = najwyższy kanał w profilach.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from solargraf_profiles import sunspec
from solargraf_profiles.codec import CodecError, encode_sunspec
from solargraf_profiles.model import MODBUS_MAX_BLOCK, Addressing, DataPoint, Profile, RegisterTable
from solargraf_simulator.registers import SPLIT_BY_STRINGS, ModbusException

COMMON_MODEL = 1
SIMULATED_TEXT = "SIMULATED"

# Skala (wykładnik) zapisywana przez symulator dla jednostek z definicji modeli.
SCALE_BY_UNIT: dict[str, int] = {"W": 0, "Wh": 0, "V": -1, "A": -2, "Hz": -2, "C": -1}

# Wartość „nie zaimplementowano” dla typów bez wartości metryki (specyfikacja SunSpec).
_FILL_BY_TYPE: dict[str, int] = {
    "int16": 0x8000,
    "sunssf": 0x8000,
    "pad": 0x8000,
    "uint16": 0xFFFF,
    "count": 0xFFFF,
    "enum16": 0xFFFF,
    "bitfield16": 0xFFFF,
    "int32": 0x8000_0000,
    "uint32": 0xFFFF_FFFF,
    "enum32": 0xFFFF_FFFF,
    "bitfield32": 0xFFFF_FFFF,
}


@dataclass(frozen=True)
class _Placed:
    model: sunspec.SunSpecModel
    start: int
    repeats: int

    @property
    def length(self) -> int:
        groups = sum(g.size for g in self.model.repeating.values())
        return self.model.fixed.size - 2 + self.repeats * groups


def _fill(point: sunspec.SunSpecPoint) -> list[int]:
    value = _FILL_BY_TYPE.get(point.type, 0)  # string, acc*: 0
    data = value.to_bytes(point.size * 2, "big")
    return [int.from_bytes(data[i : i + 2], "big") for i in range(0, len(data), 2)]


def _text(text: str, size: int) -> list[int]:
    data = text.encode("ascii")[: size * 2].ljust(size * 2, b"\0")
    return [int.from_bytes(data[i : i + 2], "big") for i in range(0, len(data), 2)]


class SunSpecRegisterMap:
    def __init__(
        self,
        profiles: Sequence[Profile],
        *,
        base: int = sunspec.BASE_ADDRESSES[0],
        unit_id: int = 1,
        max_block_registers: int = MODBUS_MAX_BLOCK,
    ) -> None:
        if not profiles or any(p.addressing is not Addressing.SUNSPEC for p in profiles):
            raise ValueError("mapa SunSpec wymaga profili z addressing: sunspec")
        if base not in sunspec.BASE_ADDRESSES:
            raise ValueError(f"adres bazowy {base} spoza standardu SunSpec")
        self.profiles = list(profiles)
        self.base = base
        self.unit_id = unit_id
        self.max_block = min(MODBUS_MAX_BLOCK, max_block_registers)
        self._points = [p for profile in profiles for p in profile.points if p.sunspec is not None]
        strings = {p.channel for p in self._points if p.metric in SPLIT_BY_STRINGS}
        self._strings = len(strings)
        self.models = self._layout()

    def _layout(self) -> list[_Placed]:
        repeats: Counter[int] = Counter()
        for p in self._points:
            assert p.sunspec is not None  # noqa: S101 — przefiltrowane w __init__
            if p.sunspec.group is not None:
                repeats[p.sunspec.model] = max(repeats[p.sunspec.model], p.channel or 1)
        ids = sorted({COMMON_MODEL} | {p.sunspec.model for p in self._points if p.sunspec})
        placed: list[_Placed] = []
        address = self.base + 2
        for model_id in ids:
            item = _Placed(sunspec.load_model(model_id), address, repeats[model_id])
            placed.append(item)
            address += 2 + item.length
        return placed

    @property
    def end(self) -> int:
        """Adres znacznika końca mapy."""
        last = self.models[-1]
        return last.start + 2 + last.length

    def snapshot(self, metrics: dict[str, Decimal]) -> dict[int, int]:
        """Rejestry holding całej mapy dla bieżącego stanu modelu instalacji."""
        words: dict[int, int] = {
            self.base: sunspec.SUNS_MARKER[0],
            self.base + 1: sunspec.SUNS_MARKER[1],
        }
        for placed in self.models:
            self._defaults(words, placed)
        for p in self._points:
            self._value(words, p, metrics)
        words[self.end] = sunspec.END_MODEL_ID
        words[self.end + 1] = 0
        return words

    def _defaults(self, words: dict[int, int], placed: _Placed) -> None:
        model = placed.model
        groups = [(None, model.fixed, None)] + [
            (name, group, index)
            for index in range(placed.repeats)
            for name, group in model.repeating.items()
        ]
        for name, group, index in groups:
            for point in group.points.values():
                address = model.address(placed.start, point.name, name, index)
                for offset, word in enumerate(_fill(point)):
                    words[address + offset] = word
        words[placed.start] = model.id
        words[placed.start + 1] = placed.length
        fixed = model.fixed.points
        if "N" in fixed and model.repeating:
            words[model.address(placed.start, "N")] = placed.repeats
        if model.id == COMMON_MODEL:
            for text_point in ("Mn", "Md", "SN"):
                start = model.address(placed.start, text_point)
                size = fixed[text_point].size
                for offset, word in enumerate(_text(SIMULATED_TEXT, size)):
                    words[start + offset] = word
            words[model.address(placed.start, "DA")] = self.unit_id

    def _value(self, words: dict[int, int], point: DataPoint, metrics: dict[str, Decimal]) -> None:
        ref = point.sunspec
        assert ref is not None  # noqa: S101 — przefiltrowane w __init__
        placed = next(m for m in self.models if m.model.id == ref.model)
        model = placed.model
        index = None if ref.group is None else (point.channel or 1) - 1
        definition = model.point(ref.point, ref.group)
        scale = SCALE_BY_UNIT.get(definition.units or "", 0)
        sf_address = model.scale_factor_address(placed.start, ref.point, ref.group, index)
        if sf_address is not None:
            words[sf_address] = sunspec.encode_scale_factor(scale)
        value: Decimal | None = metrics[point.metric]
        if point.metric in SPLIT_BY_STRINGS and self._strings:
            value = metrics[point.metric] / self._strings
        if definition.type.startswith("acc") and value == 0:
            value = None  # licznik równy 0 jest w SunSpec nieodróżnialny od braku
        try:
            encoded = encode_sunspec(point, value, scale)
        except CodecError:
            # Model wyszedł poza zakres typu — urządzenie zgłasza awarię, nie zero.
            raise ModbusException(ModbusException.SERVER_DEVICE_FAILURE) from None
        address = model.address(placed.start, ref.point, ref.group, index)
        for offset, word in enumerate(encoded):
            words[address + offset] = word

    def read(
        self, metrics: dict[str, Decimal], table: RegisterTable, address: int, count: int
    ) -> list[int]:
        if not 1 <= count <= self.max_block:
            raise ModbusException(ModbusException.ILLEGAL_DATA_VALUE)
        if table is not RegisterTable.HOLDING:
            raise ModbusException(ModbusException.ILLEGAL_DATA_ADDRESS)
        words = self.snapshot(metrics)
        keys = range(address, address + count)
        # Rejestr spoza mapy to błąd adresu — nigdy zero.
        if any(k not in words for k in keys):
            raise ModbusException(ModbusException.ILLEGAL_DATA_ADDRESS)
        return [words[k] for k in keys]
