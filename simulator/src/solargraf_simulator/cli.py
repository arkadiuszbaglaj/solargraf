"""Uruchomienie symulatora z linii poleceń (D40).

Przykład: ``uv run solargraf-sim profiles/simulated.hybrid-inverter.yaml --port 5020``
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import sys
from pathlib import Path

from solargraf_profiles.loader import ProfileError, load_profile
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import Faults, SimulatorServer, utc_now


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="solargraf-sim", description="Symulator urządzenia (SIMULATED)"
    )
    p.add_argument("profile", type=Path, help="plik profilu YAML")
    p.add_argument("--host", default="127.0.0.1", help="adres nasłuchu (domyślnie tylko lokalnie)")
    p.add_argument("--port", type=int, default=5020)
    p.add_argument("--unit-id", type=int, default=1)
    p.add_argument("--pv-peak-w", type=int, default=PlantConfig.pv_peak_w)
    faults = p.add_argument_group("wstrzykiwanie błędów")
    faults.add_argument("--no-response", action="store_true", help="brak odpowiedzi (timeout)")
    faults.add_argument("--exception-code", type=int, help="każda odpowiedź to ten wyjątek Modbus")
    faults.add_argument("--drop-connection", action="store_true", help="zrywanie połączenia")
    faults.add_argument("--single-client", action="store_true", help="tylko jeden klient naraz")
    faults.add_argument(
        "--reset-counters-every", type=int, metavar="S", help="reset liczników energii co S sekund"
    )
    return p


async def _run(args: argparse.Namespace) -> None:
    profile = load_profile(args.profile)
    plant = Plant(PlantConfig(pv_peak_w=args.pv_peak_w), now=utc_now())
    faults = Faults(
        no_response=args.no_response,
        exception_code=args.exception_code,
        drop_connection=args.drop_connection,
        single_client=args.single_client,
    )
    server = SimulatorServer(plant, RegisterMap(profile), unit_id=args.unit_id, faults=faults)
    port = await server.start(args.host, args.port)
    print(
        f"SIMULATED: {profile.id} {profile.version} na {args.host}:{port}, unit {args.unit_id}",
        flush=True,
    )
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
