"""Godzinowa produkcja PV z PVGIS dla symulatora (D77). Wartości są SIMULATED.

Dane (moc na 1 kWp, co godzinę przez jeden rok) leżą w ``data/pvgis_<lokalizacja>.json``;
przygotowuje je ``tools/fetch_pvgis.py``. Symulator nie łączy się z PVGIS. Chwila symulacji jest
odwzorowana na ten sam dzień i godzinę roku danych (29 lutego jak 28 lutego), między pełnymi
godzinami wartość jest interpolowana liniowo.

Źródło danych: PVGIS © European Communities, 2001-2026.
"""

from __future__ import annotations

import calendar
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from importlib import resources

HOURS = 8760
STEP_S = 3600
# Najwyższa wiarygodna moc na 1 kWp (W); wartość powyżej oznacza uszkodzony plik danych.
MAX_W_PER_KWP = 1200


@dataclass(frozen=True)
class PvProfile:
    key: str
    name: str
    year: int
    attribution: str
    # Przesunięcie pierwszej próbki od początku roku (PVGIS: hh:10 UTC).
    first_offset_s: int
    values: tuple[int, ...]

    def per_kwp(self, at: datetime) -> float:
        """Moc PV w W na 1 kWp w chwili ``at`` (UTC)."""
        at = at.astimezone(UTC)
        year_start = datetime(at.year, 1, 1, tzinfo=UTC)
        elapsed = (at - year_start).total_seconds()
        if calendar.isleap(at.year) and at >= datetime(at.year, 2, 29, tzinfo=UTC):
            elapsed -= 86_400
        position = (elapsed - self.first_offset_s) / STEP_S
        index = int(position // 1)
        fraction = position - index
        a = self.values[index % HOURS]
        b = self.values[(index + 1) % HOURS]
        return a + (b - a) * fraction


def available() -> list[str]:
    """Klucze lokalizacji z dołączonymi danymi, np. ``warszawa``."""
    names = (p.name for p in resources.files("solargraf_simulator").joinpath("data").iterdir())
    return sorted(n[len("pvgis_") : -len(".json")] for n in names if n.startswith("pvgis_"))


def parse(data: object) -> PvProfile:
    """Waliduje plik danych PVGIS; błąd struktury to ``ValueError``."""
    if not isinstance(data, dict):
        raise ValueError("dane PVGIS: oczekiwano obiektu")
    try:
        location = data["location"]
        values = data["values"]
        start = datetime.fromisoformat(str(data["start"]).replace("Z", "+00:00"))
        year = int(data["year"])
        key, name = str(location["key"]), str(location["name"])
        attribution = str(data["attribution"])
        step = int(data["step_s"])
    except (KeyError, TypeError) as exc:
        raise ValueError("dane PVGIS: brak wymaganego pola") from exc
    if data.get("origin") != "SIMULATED" or data.get("unit") != "W/kWp" or step != STEP_S:
        raise ValueError("dane PVGIS: zły rodzaj, jednostka albo krok")
    if not isinstance(values, list) or len(values) != HOURS:
        raise ValueError(f"dane PVGIS: oczekiwano {HOURS} wartości godzinowych")
    if not all(isinstance(v, int) and 0 <= v <= MAX_W_PER_KWP for v in values):
        raise ValueError("dane PVGIS: moc spoza zakresu")
    offset = start - datetime(year, 1, 1, tzinfo=UTC)
    if start.year != year or not timedelta(0) <= offset < timedelta(seconds=STEP_S):
        raise ValueError("dane PVGIS: pierwsza próbka nie jest w pierwszej godzinie roku")
    return PvProfile(
        key=key,
        name=name,
        year=year,
        attribution=attribution,
        first_offset_s=int(offset.total_seconds()),
        values=tuple(values),
    )


def load(key: str) -> PvProfile:
    """Dane dołączonej lokalizacji; nieznany klucz to ``ValueError``."""
    if key not in available():
        raise ValueError(f"brak danych PVGIS dla lokalizacji {key!r}")
    path = resources.files("solargraf_simulator").joinpath("data", f"pvgis_{key}.json")
    return parse(json.loads(path.read_text(encoding="utf-8")))
