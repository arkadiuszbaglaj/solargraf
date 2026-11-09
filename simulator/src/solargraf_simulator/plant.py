"""Deterministyczny model instalacji PV z baterią (D40). Wszystkie wartości są SIMULATED.

Model jest celowo prosty: służy do testów agenta i UI, nie do prognoz. Produkcja PV pochodzi
z godzinowych danych PVGIS dla wybranej lokalizacji (D77) albo, bez danych, z krzywej sinus
od 6 do 18. Ta sama sekwencja wywołań ``advance`` daje zawsze te same wartości. Konwencje
znaków jak w katalogu metryk: ``grid_power`` + pobór, ``battery_power`` + rozładowanie.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal

from solargraf_simulator.pvgis import PvProfile

# Dłuższe przerwy między odczytami całkujemy krokami, żeby bateria nie „przeskakiwała”.
MAX_STEP = timedelta(seconds=60)
# Umowna liczba cykli baterii na starcie symulacji (wartość SIMULATED).
CYCLES_AT_START = 400


@dataclass(frozen=True)
class PlantConfig:
    pv_peak_w: int = 6000
    load_base_w: int = 350
    battery_capacity_wh: int = 10_000
    battery_max_power_w: int = 3000
    battery_reserve_soc: int = 10
    initial_soc: int = 50
    # Lokalny czas słoneczny = UTC + przesunięcie (bez stref i zmiany czasu — wystarcza do testów).
    utc_offset_hours: int = 1
    # Produkcja z danych PVGIS (moc na 1 kWp razy pv_peak_w / 1000); None = krzywa sinus.
    pv_profile: PvProfile | None = None


@dataclass
class Plant:
    config: PlantConfig
    now: datetime
    soc_wh: float = field(init=False)
    pv_energy_wh: float = 0.0
    import_energy_wh: float = 0.0
    export_energy_wh: float = 0.0
    charge_energy_wh: float = 0.0
    discharge_energy_wh: float = 0.0

    def __post_init__(self) -> None:
        if self.now.tzinfo is None:
            raise ValueError("czas symulacji musi mieć strefę (UTC)")
        self.soc_wh = self.config.battery_capacity_wh * self.config.initial_soc / 100

    # --- moce chwilowe (funkcje czasu i stanu) ---

    def _local_hour(self, at: datetime) -> float:
        local = at + timedelta(hours=self.config.utc_offset_hours)
        return local.hour + local.minute / 60 + local.second / 3600

    def pv_power(self, at: datetime) -> float:
        profile = self.config.pv_profile
        if profile is not None:
            return profile.per_kwp(at) * self.config.pv_peak_w / 1000
        h = self._local_hour(at)
        if not 6 <= h <= 18:
            return 0.0
        return self.config.pv_peak_w * math.sin(math.pi * (h - 6) / 12)

    def load_power(self, at: datetime) -> float:
        h = self._local_hour(at)
        morning = 400.0 if 6 <= h < 8 else 0.0
        evening = 900.0 if 18 <= h < 22 else 0.0
        return self.config.load_base_w + morning + evening

    def battery_power(self, at: datetime) -> float:
        """+ rozładowanie, - ładowanie; bateria pokrywa bilans w granicach mocy i SOC."""
        cfg = self.config
        surplus = self.pv_power(at) - self.load_power(at)
        reserve_wh = cfg.battery_capacity_wh * cfg.battery_reserve_soc / 100
        if surplus > 0 and self.soc_wh < cfg.battery_capacity_wh:
            return -min(surplus, cfg.battery_max_power_w)
        if surplus < 0 and self.soc_wh > reserve_wh:
            return min(-surplus, cfg.battery_max_power_w)
        return 0.0

    def grid_power(self, at: datetime) -> float:
        # Bilans: PV + bateria(+rozładowanie) + sieć(+pobór) = zużycie.
        return self.load_power(at) - self.pv_power(at) - self.battery_power(at)

    # --- upływ czasu ---

    def advance(self, to: datetime) -> None:
        """Całkuje energię od ``now`` do ``to``. Cofnięcie zegara jest ignorowane."""
        while self.now < to:
            step_end = min(to, self.now + MAX_STEP)
            hours = (step_end - self.now).total_seconds() / 3600
            self._integrate(self.now, hours)
            self.now = step_end

    def _integrate(self, at: datetime, hours: float) -> None:
        cfg = self.config
        pv, battery, grid = self.pv_power(at), self.battery_power(at), self.grid_power(at)
        self.pv_energy_wh += pv * hours
        if grid > 0:
            self.import_energy_wh += grid * hours
        else:
            self.export_energy_wh += -grid * hours
        if battery > 0:
            self.discharge_energy_wh += battery * hours
        else:
            self.charge_energy_wh += -battery * hours
        reserve_wh = cfg.battery_capacity_wh * cfg.battery_reserve_soc / 100
        self.soc_wh = min(cfg.battery_capacity_wh, max(reserve_wh, self.soc_wh - battery * hours))

    def reset_counters(self) -> None:
        """Symuluje reset liczników energii w urządzeniu (np. po aktualizacji firmware)."""
        self.pv_energy_wh = self.import_energy_wh = self.export_energy_wh = 0.0
        self.charge_energy_wh = self.discharge_energy_wh = 0.0

    # --- wartości metryk kanonicznych ---

    def metrics(self) -> dict[str, Decimal]:
        """Bieżące wartości w jednostkach kanonicznych, zaokrąglone do 0.01."""
        at = self.now
        pv = self.pv_power(at)
        battery = self.battery_power(at)
        string_voltage = 380.0 if pv > 0 else 0.0
        battery_voltage = 51.2
        soc = 100 * self.soc_wh / self.config.battery_capacity_wh
        values = {
            "pv_power": pv,
            "pv_string_power": pv,
            "pv_string_voltage": string_voltage,
            "pv_string_current": pv / string_voltage if string_voltage else 0.0,
            "pv_energy_total": self.pv_energy_wh,
            "grid_power": self.grid_power(at),
            "grid_import_energy_total": self.import_energy_wh,
            "grid_export_energy_total": self.export_energy_wh,
            "grid_voltage": 230.0,
            "grid_frequency": 50.0,
            "load_power": self.load_power(at),
            "battery_power": battery,
            "battery_current": battery / battery_voltage,
            "battery_voltage": battery_voltage,
            "battery_soc": soc,
            "battery_temperature": 25.0,
            "battery_charge_energy_total": self.charge_energy_wh,
            "battery_discharge_energy_total": self.discharge_energy_wh,
            "inverter_temperature": 25.0 + 20.0 * pv / self.config.pv_peak_w,
            "pv_module_temperature": 10.0 + 30.0 * pv / self.config.pv_peak_w,
            # Jedna wartość dla każdej fazy (model nie rozróżnia faz).
            "grid_current": abs(self.grid_power(at)) / 3 / 230.0,
            "battery_capacity": float(self.config.battery_capacity_wh),
            "battery_cell_voltage_min": 3.2 + 0.15 * soc / 100 - 0.015,
            "battery_cell_voltage_max": 3.2 + 0.15 * soc / 100 + 0.015,
            "battery_cell_temperature_min": 24.0,
            "battery_cell_temperature_max": 27.0,
            # Pełne cykle: energia rozładowania / pojemność, od umownego stanu początkowego.
            "battery_cycle_count": float(
                CYCLES_AT_START + int(self.discharge_energy_wh // self.config.battery_capacity_wh)
            ),
        }
        return {k: Decimal(repr(round(v, 2))) for k, v in values.items()}
