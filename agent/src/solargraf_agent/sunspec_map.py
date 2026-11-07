"""Mapa SunSpec urządzenia (D59): wykrywanie modeli i planowanie odczytu.

Wykrywanie robi tylko to, co definiuje standard: szuka znacznika „SunS” pod adresami bazowymi
(40000, 0, 50000) na adresie i unit ID z konfiguracji połączenia — nie skanuje sieci. Potem
czyta nagłówki modeli (``ID``, ``L``) aż do znacznika końca. Rejestry: holding (funkcja 0x03).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace

from solargraf_profiles import sunspec
from solargraf_profiles.model import DataPoint

# Producent (``Mn`` w modelu 1), którym przedstawia się symulator SolarGraf — odczyty z takiego
# urządzenia są zawsze SIMULATED, niezależnie od profilu (D59).
SIMULATED_MANUFACTURER = "SIMULATED"
COMMON_MODEL = 1

# Ochrona przed zapętloną albo uszkodzoną mapą.
MAX_MODELS = 64
MAX_ADDRESS = 0xFFFF

# Odczyt ``count`` rejestrów od ``address``; None — urządzenie odrzuciło adres (wyjątek Modbus).
ReadFn = Callable[[int, int], Awaitable[list[int] | None]]


class MapError(Exception):
    """Znacznik „SunS” jest, ale dalsza część mapy jest niezgodna ze standardem."""


@dataclass(frozen=True)
class ModelInstance:
    id: int
    start: int  # adres rejestru ``ID``
    length: int  # ``L`` — rejestry treści bez ``ID`` i ``L``

    @property
    def end(self) -> int:
        return self.start + 2 + self.length


@dataclass(frozen=True)
class DeviceMap:
    base: int
    models: tuple[ModelInstance, ...]
    manufacturer: str | None = None

    @property
    def simulated(self) -> bool:
        return self.manufacturer == SIMULATED_MANUFACTURER

    def find(self, model_id: int) -> ModelInstance | None:
        """Pierwsze wystąpienie modelu (kolejne instancje, np. drugi licznik — poza zakresem)."""
        return next((m for m in self.models if m.id == model_id), None)


async def discover(read: ReadFn) -> DeviceMap | None:
    """Mapa modeli urządzenia; None — urządzenie nie ma znacznika „SunS” pod żadnym adresem."""
    for base in sunspec.BASE_ADDRESSES:
        marker = await read(base, 2)
        if marker is None or tuple(marker) != sunspec.SUNS_MARKER:
            continue
        found = DeviceMap(base, await _walk(read, base + 2))
        return replace(found, manufacturer=await _manufacturer(read, found))
    return None


async def _manufacturer(read: ReadFn, device_map: DeviceMap) -> str | None:
    """Tekst ``Mn`` z modelu 1 (Common); None — brak modelu albo odczytu."""
    common = device_map.find(COMMON_MODEL)
    if common is None:
        return None
    model = sunspec.load_model(COMMON_MODEL)
    point = model.point("Mn")
    address = model.address(common.start, "Mn")
    if address + point.size > common.end:
        return None
    words = await read(address, point.size)
    if words is None:
        return None
    data = b"".join(w.to_bytes(2, "big") for w in words).split(b"\0")[0]
    return data.decode("ascii", errors="replace").strip() or None


async def _walk(read: ReadFn, address: int) -> tuple[ModelInstance, ...]:
    models: list[ModelInstance] = []
    for _ in range(MAX_MODELS + 1):
        if address + 2 > MAX_ADDRESS + 1:
            break
        header = await read(address, 2)
        if header is None:
            raise MapError("urządzenie odrzuciło odczyt nagłówka modelu")
        model_id, length = header
        if model_id == sunspec.END_MODEL_ID:
            return tuple(models)
        models.append(ModelInstance(model_id, address, length))
        address += 2 + length
    raise MapError("brak znacznika końca mapy")


def chunks(model: ModelInstance, limit: int) -> list[tuple[int, int]]:
    """Cały model (z nagłówkiem) w blokach (adres, liczba) nie dłuższych niż ``limit``."""
    return [(a, min(limit, model.end - a)) for a in range(model.start, model.end, limit)]


@dataclass(frozen=True)
class PointAddress:
    value: int
    size: int
    scale_factor: int | None


def locate(point: DataPoint, model: ModelInstance) -> PointAddress | None:
    """Adresy punktu profilu w modelu urządzenia; None — urządzenie nie ma tego punktu
    (np. mniej modułów MPPT niż kanałów w profilu). Błąd ``SunSpecError`` — ``L`` niezgodne
    z definicją modelu."""
    ref = point.sunspec
    if ref is None:
        raise ValueError(f"punkt {point.metric} nie jest punktem SunSpec")
    definition = sunspec.load_model(ref.model)
    index: int | None = None
    if ref.group is not None:
        index = (point.channel or 1) - 1
        if index >= definition.repeat_count(model.length):
            return None
    found = definition.point(ref.point, ref.group)
    address = definition.address(model.start, ref.point, ref.group, index)
    scale_factor = definition.scale_factor_address(model.start, ref.point, ref.group, index)
    # Model krótszy niż definicja (starsze urządzenia): punktu za końcem modelu nie ma.
    if address + found.size > model.end or (scale_factor is not None and scale_factor >= model.end):
        return None
    return PointAddress(value=address, size=found.size, scale_factor=scale_factor)
