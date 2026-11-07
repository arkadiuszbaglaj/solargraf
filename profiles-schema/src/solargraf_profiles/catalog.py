"""Zamknięte listy i katalog metryk kanonicznych (D38, D39).

Jedyne źródło typów urządzeń, protokołów, jednostek i metryk — serwer i agent importują je stąd.
Zmiana klucza metryki albo konwencji znaku to zmiana kontraktu (nowa decyzja).
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from decimal import Decimal


class DeviceKind(enum.StrEnum):
    INVERTER = "INVERTER"
    BATTERY = "BATTERY"
    BMS = "BMS"
    METER = "METER"
    MPPT = "MPPT"
    SENSOR = "SENSOR"
    GATEWAY = "GATEWAY"


class Transport(enum.StrEnum):
    MODBUS_TCP = "MODBUS_TCP"
    MODBUS_RTU = "MODBUS_RTU"
    SOLARMAN_V5 = "SOLARMAN_V5"
    HTTP = "HTTP"
    MQTT = "MQTT"


# Protokoły adresowane rejestrami Modbus — jedyne obsługiwane przez format profilu w P3.1.
REGISTER_TRANSPORTS = frozenset({Transport.MODBUS_TCP, Transport.MODBUS_RTU, Transport.SOLARMAN_V5})


class Quantity(enum.StrEnum):
    POWER = "POWER"
    ENERGY = "ENERGY"
    VOLTAGE = "VOLTAGE"
    CURRENT = "CURRENT"
    FREQUENCY = "FREQUENCY"
    TEMPERATURE = "TEMPERATURE"
    RATIO = "RATIO"


class Unit(enum.StrEnum):
    W = "W"
    KW = "kW"
    WH = "Wh"
    KWH = "kWh"
    MWH = "MWh"
    V = "V"
    A = "A"
    HZ = "Hz"
    DEG_C = "degC"
    PERCENT = "%"


@dataclass(frozen=True)
class UnitInfo:
    quantity: Quantity
    # Mnożnik do jednostki kanonicznej. Tylko przeliczenia liniowe (bez kelwinów i °F).
    to_canonical: Decimal


UNITS: dict[Unit, UnitInfo] = {
    Unit.W: UnitInfo(Quantity.POWER, Decimal(1)),
    Unit.KW: UnitInfo(Quantity.POWER, Decimal(1000)),
    Unit.WH: UnitInfo(Quantity.ENERGY, Decimal(1)),
    Unit.KWH: UnitInfo(Quantity.ENERGY, Decimal(1000)),
    Unit.MWH: UnitInfo(Quantity.ENERGY, Decimal(1_000_000)),
    Unit.V: UnitInfo(Quantity.VOLTAGE, Decimal(1)),
    Unit.A: UnitInfo(Quantity.CURRENT, Decimal(1)),
    Unit.HZ: UnitInfo(Quantity.FREQUENCY, Decimal(1)),
    Unit.DEG_C: UnitInfo(Quantity.TEMPERATURE, Decimal(1)),
    Unit.PERCENT: UnitInfo(Quantity.RATIO, Decimal(1)),
}

CANONICAL_UNIT: dict[Quantity, Unit] = {
    Quantity.POWER: Unit.W,
    Quantity.ENERGY: Unit.WH,
    Quantity.VOLTAGE: Unit.V,
    Quantity.CURRENT: Unit.A,
    Quantity.FREQUENCY: Unit.HZ,
    Quantity.TEMPERATURE: Unit.DEG_C,
    Quantity.RATIO: Unit.PERCENT,
}


@dataclass(frozen=True)
class MetricDefinition:
    key: str
    quantity: Quantity
    display_name: str
    # Wartość ze znakiem; ``sign_convention`` opisuje, co oznacza plus.
    signed: bool = False
    sign_convention: str | None = None
    # Licznik narastający (nie maleje poza resetem urządzenia).
    cumulative: bool = False
    # Metryka ma kanały (string MPPT, faza L1-L3); ``channel`` w punkcie danych jest wtedy wymagany.
    channeled: bool = False

    @property
    def canonical_unit(self) -> Unit:
        return CANONICAL_UNIT[self.quantity]


_IMPORT = "+ pobór z sieci, - eksport do sieci"
_DISCHARGE = "+ rozładowanie, - ładowanie"

_METRICS = (
    MetricDefinition("pv_power", Quantity.POWER, "Moc PV"),
    MetricDefinition("pv_string_power", Quantity.POWER, "Moc stringu PV", channeled=True),
    MetricDefinition("pv_string_voltage", Quantity.VOLTAGE, "Napięcie stringu PV", channeled=True),
    MetricDefinition("pv_string_current", Quantity.CURRENT, "Prąd stringu PV", channeled=True),
    MetricDefinition("pv_energy_total", Quantity.ENERGY, "Produkcja PV (licznik)", cumulative=True),
    MetricDefinition(
        "grid_power", Quantity.POWER, "Moc sieci", signed=True, sign_convention=_IMPORT
    ),
    MetricDefinition(
        "grid_import_energy_total", Quantity.ENERGY, "Pobór z sieci (licznik)", cumulative=True
    ),
    MetricDefinition(
        "grid_export_energy_total", Quantity.ENERGY, "Eksport do sieci (licznik)", cumulative=True
    ),
    MetricDefinition("grid_voltage", Quantity.VOLTAGE, "Napięcie sieci", channeled=True),
    MetricDefinition("grid_frequency", Quantity.FREQUENCY, "Częstotliwość sieci"),
    MetricDefinition("load_power", Quantity.POWER, "Moc zużycia domu"),
    MetricDefinition(
        "battery_power", Quantity.POWER, "Moc baterii", signed=True, sign_convention=_DISCHARGE
    ),
    MetricDefinition(
        "battery_current", Quantity.CURRENT, "Prąd baterii", signed=True, sign_convention=_DISCHARGE
    ),
    MetricDefinition("battery_voltage", Quantity.VOLTAGE, "Napięcie baterii"),
    MetricDefinition("battery_soc", Quantity.RATIO, "Stan naładowania baterii"),
    MetricDefinition("battery_temperature", Quantity.TEMPERATURE, "Temperatura baterii"),
    MetricDefinition(
        "battery_charge_energy_total",
        Quantity.ENERGY,
        "Ładowanie baterii (licznik)",
        cumulative=True,
    ),
    MetricDefinition(
        "battery_discharge_energy_total",
        Quantity.ENERGY,
        "Rozładowanie baterii (licznik)",
        cumulative=True,
    ),
    MetricDefinition("inverter_temperature", Quantity.TEMPERATURE, "Temperatura falownika"),
)

METRICS: dict[str, MetricDefinition] = {m.key: m for m in _METRICS}
