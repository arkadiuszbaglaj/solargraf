"""Modele SunSpec (D59): definicje punktów, adresy i dekodowanie surowych wartości.

Definicje pochodzą z oficjalnych plików JSON SunSpec Alliance dołączonych do pakietu
(``sunspec_models/``, Apache-2.0, wydanie w ``SUNSPEC_RELEASE``). Profil wskazuje tylko model
i nazwę punktu; adres, typ, skala i jednostka wynikają z definicji modelu.

Mapa urządzenia: znacznik „SunS”, potem kolejne modele (``ID``, ``L``, ``L`` rejestrów treści)
aż do znacznika końca. Adres punktu = początek modelu (rejestr ``ID``) + przesunięcie punktu.
Grupa powtarzana (np. ``module`` w modelu 160) ma liczbę powtórzeń wynikającą z ``L``.

Wartość „nie zaimplementowano” (np. ``0x8000`` dla int16, 0 dla liczników) to brak danych,
nigdy liczba. Skala ``sunssf`` to wykładnik potęgi 10 z zakresu -10..10.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from functools import cache
from importlib import resources
from typing import Any

SUNSPEC_RELEASE = "v2026-04-20"
SUNSPEC_COMMIT = "a0b3e732ca9c163889a9c33f41c9315668a2488c"
SUPPORTED_MODELS = (1, 101, 103, 160, 201, 203)

# Znacznik początku mapy: „SunS” (0x53756e53) i typowe adresy bazowe w kolejności sprawdzania.
SUNS_MARKER = (0x5375, 0x6E53)
BASE_ADDRESSES = (40000, 0, 50000)
END_MODEL_ID = 0xFFFF

# Typy punktów, które mogą nieść wartość metryki; rozmiar w rejestrach.
VALUE_TYPES: dict[str, int] = {
    "int16": 1,
    "uint16": 1,
    "acc16": 1,
    "int32": 2,
    "uint32": 2,
    "acc32": 2,
    "float32": 2,
}
# Wartości „nie zaimplementowano” (specyfikacja SunSpec Information Model). Liczniki ``acc*``
# używają 0 — licznik, który naprawdę wskazuje 0, jest więc nieodróżnialny od braku.
NOT_IMPLEMENTED: dict[str, int] = {
    "int16": 0x8000,
    "uint16": 0xFFFF,
    "acc16": 0,
    "int32": 0x8000_0000,
    "uint32": 0xFFFF_FFFF,
    "acc32": 0,
    "sunssf": 0x8000,
}
SCALE_FACTOR_RANGE = range(-10, 11)

# Jednostki z definicji modeli → jednostki katalogu metryk (``solargraf_profiles.catalog.Unit``).
UNIT_NAMES: dict[str, str] = {
    "W": "W",
    "Wh": "Wh",
    "V": "V",
    "A": "A",
    "Hz": "Hz",
    "C": "degC",
}


class SunSpecError(ValueError):
    """Nieznany model albo punkt, albo surowe rejestry niezgodne z definicją."""


@dataclass(frozen=True)
class SunSpecPoint:
    name: str
    type: str
    size: int
    # Przesunięcie od początku grupy (dla grupy głównej — od rejestru ``ID`` modelu).
    offset: int
    sf: str | int | None
    units: str | None


@dataclass(frozen=True)
class SunSpecGroup:
    name: str
    points: dict[str, SunSpecPoint]
    size: int


@dataclass(frozen=True)
class SunSpecModel:
    id: int
    label: str
    fixed: SunSpecGroup
    # Grupy powtarzane po części stałej (np. ``module`` w modelu 160), w kolejności definicji.
    repeating: dict[str, SunSpecGroup]

    def group(self, name: str | None) -> SunSpecGroup:
        if name is None:
            return self.fixed
        group = self.repeating.get(name)
        if group is None:
            raise SunSpecError(f"model {self.id} nie ma grupy {name!r}")
        return group

    def point(self, name: str, group: str | None = None) -> SunSpecPoint:
        found = self.group(group).points.get(name)
        if found is None:
            where = f"grupie {group!r} modelu" if group else "modelu"
            raise SunSpecError(f"w {where} {self.id} nie ma punktu {name!r}")
        return found

    def scale_factor_point(
        self, point: SunSpecPoint, group: str | None = None
    ) -> SunSpecPoint | None:
        """Punkt ``sunssf`` skali wartości — w tej samej grupie albo w części stałej modelu."""
        if not isinstance(point.sf, str):
            return None
        own = self.group(group).points.get(point.sf)
        if own is not None:
            return own
        return self.point(point.sf)

    def repeat_count(self, length: int) -> int:
        """Liczba powtórzeń grupy z długości modelu ``L`` (rejestry treści, bez ``ID`` i ``L``)."""
        if not self.repeating:
            return 0
        rest = length - (self.fixed.size - 2)
        size = sum(g.size for g in self.repeating.values())
        if rest < 0 or rest % size:
            raise SunSpecError(f"długość modelu {self.id} ({length}) nie pasuje do definicji")
        return rest // size

    def address(
        self, model_start: int, name: str, group: str | None = None, index: int | None = None
    ) -> int:
        """Adres punktu. ``index`` (od 0) — numer powtórzenia grupy."""
        point = self.point(name, group)
        if group is None:
            return model_start + point.offset
        if index is None or index < 0:
            raise SunSpecError("punkt grupy powtarzanej wymaga indeksu >= 0")
        group_size = self.group(group).size
        return model_start + self.fixed.size + index * group_size + point.offset


def _group(raw: dict[str, Any]) -> SunSpecGroup:
    points: dict[str, SunSpecPoint] = {}
    offset = 0
    for p in raw.get("points", []):
        size = int(p["size"])
        points[p["name"]] = SunSpecPoint(
            name=p["name"],
            type=p["type"],
            size=size,
            offset=offset,
            sf=p.get("sf"),
            units=p.get("units"),
        )
        offset += size
    return SunSpecGroup(name=raw["name"], points=points, size=offset)


@cache
def load_model(model_id: int) -> SunSpecModel:
    """Definicja modelu z dołączonych plików; tylko modele z ``SUPPORTED_MODELS``."""
    if model_id not in SUPPORTED_MODELS:
        raise SunSpecError(f"model SunSpec {model_id} nie jest obsługiwany")
    text = (
        resources.files("solargraf_profiles")
        .joinpath("sunspec_models", f"model_{model_id}.json")
        .read_text(encoding="utf-8")
    )
    raw = json.loads(text)
    if raw.get("id") != model_id:
        raise SunSpecError(f"plik modelu {model_id} ma inny identyfikator")
    top = raw["group"]
    fixed = _group(top)
    repeating = {g["name"]: _group(g) for g in top.get("groups", [])}
    return SunSpecModel(id=model_id, label=top.get("label", ""), fixed=fixed, repeating=repeating)


def decode_scale_factor(word: int) -> int | None:
    """Rejestr ``sunssf`` → wykładnik; None — skala nie zaimplementowana."""
    if not 0 <= word <= 0xFFFF:
        raise SunSpecError("rejestr spoza zakresu 0..65535")
    if word == NOT_IMPLEMENTED["sunssf"]:
        return None
    value = word - 0x10000 if word >= 0x8000 else word
    if value not in SCALE_FACTOR_RANGE:
        raise SunSpecError(f"skala {value} poza zakresem -10..10")
    return value


def encode_scale_factor(value: int) -> int:
    if value not in SCALE_FACTOR_RANGE:
        raise SunSpecError(f"skala {value} poza zakresem -10..10")
    return value & 0xFFFF


def decode_raw(point_type: str, words: Sequence[int]) -> Decimal | None:
    """Rejestry (big-endian, starsze słowo pierwsze) → liczba bez skali; None — brak wartości."""
    size = VALUE_TYPES.get(point_type)
    if size is None:
        raise SunSpecError(f"typ {point_type!r} nie niesie wartości metryki")
    if len(words) != size:
        raise SunSpecError(f"typ {point_type} wymaga {size} rejestrów, otrzymano {len(words)}")
    if any(not 0 <= w <= 0xFFFF for w in words):
        raise SunSpecError("rejestr spoza zakresu 0..65535")
    data = b"".join(w.to_bytes(2, "big") for w in words)
    if point_type == "float32":
        number = struct.unpack(">f", data)[0]
        # NaN to w SunSpec brak wartości; nieskończoność — błędna odpowiedź.
        if math.isnan(number):
            return None
        if math.isinf(number):
            raise SunSpecError("float32 nie jest liczbą skończoną")
        return Decimal(repr(number))
    unsigned = int.from_bytes(data, "big")
    if unsigned == NOT_IMPLEMENTED[point_type]:
        return None
    signed = point_type in ("int16", "int32")
    return Decimal(int.from_bytes(data, "big", signed=signed))


def encode_raw(point_type: str, value: Decimal | None) -> list[int]:
    """Liczba bez skali → rejestry; None — wartość „nie zaimplementowano” (symulator, testy)."""
    size = VALUE_TYPES.get(point_type)
    if size is None:
        raise SunSpecError(f"typ {point_type!r} nie niesie wartości metryki")
    if point_type == "float32":
        data = struct.pack(">f", math.nan if value is None else float(value))
    else:
        bits = size * 16
        if value is None:
            unsigned = NOT_IMPLEMENTED[point_type]
        else:
            number = int(value)
            signed = point_type in ("int16", "int32")
            low = -(1 << (bits - 1)) if signed else 0
            high = (1 << (bits - 1)) - 1 if signed else (1 << bits) - 1
            if not low <= number <= high:
                raise SunSpecError(f"{value} nie mieści się w {point_type}")
            unsigned = number & ((1 << bits) - 1)
            if unsigned == NOT_IMPLEMENTED[point_type]:
                raise SunSpecError(f"{value} to w {point_type} wartość „nie zaimplementowano”")
        data = unsigned.to_bytes(size * 2, "big")
    return [int.from_bytes(data[i : i + 2], "big") for i in range(0, len(data), 2)]


def scaled(raw: Decimal, scale_factor: int | None) -> Decimal:
    """Liczba x 10^sf; punkt bez skali (``sf`` w definicji brak) — bez zmian."""
    return raw if scale_factor is None else raw.scaleb(scale_factor)
