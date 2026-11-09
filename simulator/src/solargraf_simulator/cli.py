"""Uruchomienie symulatora z linii poleceń (D40).

Przykład: ``uv run solargraf-sim profiles/simulated.hybrid-inverter.yaml --port 5020``

Profile SunSpec (D59) można podać razem (np. falownik i licznik) — trafiają do jednej mapy.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import sys
from pathlib import Path

from solargraf_profiles import sunspec
from solargraf_profiles.loader import ProfileError, load_profile
from solargraf_profiles.model import Addressing, Profile
from solargraf_simulator import pvgis
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import Faults, Registers, SimulatorServer, utc_now
from solargraf_simulator.sunspec_map import SunSpecRegisterMap

# Produkcja PV: dane PVGIS lokalizacji (D77) albo prosta krzywa z D40.
DEFAULT_LOCATION = "warszawa"
SINE = "sinus"


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="solargraf-sim", description="Symulator urządzenia (SIMULATED)"
    )
    p.add_argument(
        "profile", type=Path, nargs="+", help="plik profilu YAML (kilka — tylko profile SunSpec)"
    )
    p.add_argument(
        "--sunspec-base",
        type=int,
        choices=sunspec.BASE_ADDRESSES,
        default=sunspec.BASE_ADDRESSES[0],
        help="adres bazowy mapy SunSpec",
    )
    p.add_argument("--host", default="127.0.0.1", help="adres nasłuchu (domyślnie tylko lokalnie)")
    p.add_argument("--port", type=int, default=5020)
    p.add_argument("--unit-id", type=int, default=1)
    p.add_argument("--pv-peak-w", type=int, default=PlantConfig.pv_peak_w)
    p.add_argument(
        "--pv-location",
        choices=[*pvgis.available(), SINE],
        default=DEFAULT_LOCATION,
        help="produkcja PV z danych PVGIS dla lokalizacji albo prosta krzywa (sinus)",
    )
    faults = p.add_argument_group("wstrzykiwanie błędów")
    faults.add_argument("--no-response", action="store_true", help="brak odpowiedzi (timeout)")
    faults.add_argument("--exception-code", type=int, help="każda odpowiedź to ten wyjątek Modbus")
    faults.add_argument("--drop-connection", action="store_true", help="zrywanie połączenia")
    faults.add_argument("--single-client", action="store_true", help="tylko jeden klient naraz")
    faults.add_argument(
        "--reset-counters-every", type=int, metavar="S", help="reset liczników energii co S sekund"
    )
    return p


def registers_for(profiles: list[Profile], args: argparse.Namespace) -> Registers:
    if all(p.addressing is Addressing.SUNSPEC for p in profiles):
        return SunSpecRegisterMap(profiles, base=args.sunspec_base, unit_id=args.unit_id)
    if len(profiles) != 1:
        raise ProfileError("kilka profili naraz tylko dla adresowania SunSpec")
    return RegisterMap(profiles[0])


async def _run(args: argparse.Namespace) -> None:
    profiles = [load_profile(path) for path in args.profile]
    registers = registers_for(profiles, args)
    profile = None if args.pv_location == SINE else pvgis.load(args.pv_location)
    plant = Plant(PlantConfig(pv_peak_w=args.pv_peak_w, pv_profile=profile), now=utc_now())
    faults = Faults(
        no_response=args.no_response,
        exception_code=args.exception_code,
        drop_connection=args.drop_connection,
        single_client=args.single_client,
    )
    server = SimulatorServer(plant, registers, unit_id=args.unit_id, faults=faults)
    port = await server.start(args.host, args.port)
    names = ", ".join(f"{p.id} {p.version}" for p in profiles)
    print(f"SIMULATED: {names} na {args.host}:{port}, unit {args.unit_id}", flush=True)
    if profile is not None:
        print(f"SIMULATED: PV {profile.name} {profile.year} — {profile.attribution}", flush=True)
    try:
        while True:
            await asyncio.sleep(args.reset_counters_every or 3600)
            if args.reset_counters_every:
                plant.reset_counters()
                print("SIMULATED: reset liczników energii", flush=True)
    finally:
        await server.stop()


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        loopback = ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        loopback = args.host == "localhost"
    if not loopback:
        print(f"Uwaga: symulator nasłuchuje poza localhost ({args.host}).", file=sys.stderr)
    try:
        asyncio.run(_run(args))
    except ProfileError as exc:
        print(f"BŁĄD {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
