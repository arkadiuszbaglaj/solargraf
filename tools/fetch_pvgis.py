"""Godzinowa produkcja PV z PVGIS dla lokalizacji symulatora (D77). Narzędzie deweloperskie.

Uruchamiane ręcznie, nie w produkcie: wynik trafia do repo jako dane symulatora (SIMULATED), więc
serwer klienta nigdy nie łączy się z PVGIS. Źródło i atrybucja zapisane w każdym pliku.

    uv run python tools/fetch_pvgis.py            # wszystkie lokalizacje
    uv run python tools/fetch_pvgis.py warszawa   # jedna
"""

from __future__ import annotations

import itertools
import json
import sys
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

API = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc"
ATTRIBUTION = "PVGIS © European Communities, 2001-2026"
YEAR = 2023
TIMEOUT_S = 120
OUT_DIR = Path(__file__).resolve().parents[1] / "simulator/src/solargraf_simulator/data"

# Współrzędne centrów miast (stopnie dziesiętne); moduły na południe, nachylenie 35°, straty 14 %.
LOCATIONS: dict[str, tuple[str, float, float]] = {
    "gdansk": ("Gdańsk", 54.35, 18.65),
    "warszawa": ("Warszawa", 52.23, 21.01),
    "wroclaw": ("Wrocław", 51.11, 17.03),
    "krakow": ("Kraków", 50.06, 19.94),
}
PARAMS = {"peakpower": 1, "loss": 14, "angle": 35, "aspect": 0, "pvcalculation": 1}


def _time(value: str) -> datetime:
    # PVGIS: „20230101:0010” w UTC.
    return datetime.strptime(value, "%Y%m%d:%H%M").replace(tzinfo=UTC)


def fetch(key: str) -> tuple[dict[str, object], list[int]]:
    name, lat, lon = LOCATIONS[key]
    query = {"lat": lat, "lon": lon, "startyear": YEAR, "endyear": YEAR, "outputformat": "json"}
    url = f"{API}?{urllib.parse.urlencode(query | PARAMS)}"
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:  # noqa: S310 — stały adres https
        body = json.load(resp)
    hourly = body["outputs"]["hourly"]
    times = [_time(h["time"]) for h in hourly]
    if len(times) != 8760 or any(
        (b - a).total_seconds() != 3600 for a, b in itertools.pairwise(times)
    ):
        raise ValueError(f"{key}: oczekiwano 8760 kolejnych godzin")
    values = [round(float(h["P"])) for h in hourly]
    if any(v < 0 or v > 1200 for v in values):
        raise ValueError(f"{key}: moc spoza 0..1200 W/kWp")
    data: dict[str, object] = {
        "origin": "SIMULATED",
        "source": "PVGIS 5.3 seriescalc",
        "attribution": ATTRIBUTION,
        "radiation_db": body["inputs"]["meteo_data"]["radiation_db"],
        "location": {"key": key, "name": name, "latitude": lat, "longitude": lon},
        "mounting": {
            "tilt_deg": PARAMS["angle"],
            "azimuth_deg": PARAMS["aspect"],
            "loss_pct": PARAMS["loss"],
        },
        "year": YEAR,
        "start": times[0].isoformat().replace("+00:00", "Z"),
        "step_s": 3600,
        "unit": "W/kWp",
        "values": values,
    }
    return data, values


def main(argv: list[str]) -> int:
    keys = argv or list(LOCATIONS)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key in keys:
        data, values = fetch(key)
        path = OUT_DIR / f"pvgis_{key}.json"
        path.write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        kwh = sum(values) / 1000
        print(f"{key}: {kwh:.0f} kWh/kWp w {YEAR} -> {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
