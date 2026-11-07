"""Polecenia agenta.

``run`` — praca ciągła (D43): konfiguracja i token ze zmiennych środowiskowych.
``poll`` — ręczne sprawdzenie odczytu urządzenia (D41), bez wysyłania danych do serwera.

Przykład: ``uv run solargraf-agent poll profiles/simulated.hybrid-inverter.yaml --port 5020 --once``
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from solargraf_agent.api import ApiClient
from solargraf_agent.buffer import Buffer
from solargraf_agent.modbus import ModbusPoller, Target
from solargraf_agent.readings import PollingRun
from solargraf_agent.runner import AgentRunner, ProfileKey
from solargraf_profiles.loader import ProfileError, load_directory, load_profile
from solargraf_profiles.model import Addressing, Profile

DEFAULT_API_URL = "http://api:8000"
DEFAULT_BUFFER = "/var/lib/solargraf-agent/buffer.sqlite3"
DEFAULT_PROFILES = "/app/profiles"

log = logging.getLogger("solargraf_agent")


def format_run(run: PollingRun) -> str:
    lines = [
        f"{run.started_at.isoformat()} wynik={run.result} "
        f"ok={run.ok_points} błędy={run.failed_points}"
        + (f" kod={run.error_code}" if run.error_code else "")
    ]
    for r in run.readings:
        name = r.metric if r.channel is None else f"{r.metric}[{r.channel}]"
        value = "brak" if r.value is None else f"{r.value} {r.unit}"
        lines.append(f"  {name:<32} {value:<20} {r.quality} {r.origin}")
    return "\n".join(lines)


async def _poll(args: argparse.Namespace) -> int:
    profile = load_profile(args.profile)
    poller = ModbusPoller(profile, Target(args.host, args.port, args.unit_id))
    try:
        while True:
            run = await poller.poll()
            print(format_run(run), flush=True)
            if args.once:
                return 0 if run.result == "OK" else 1
            await asyncio.sleep(profile.polling.interval_seconds)
    finally:
        poller.close()


def load_profiles(directory: Path) -> dict[ProfileKey, Profile]:
    result = load_directory(directory)
    for error in result.errors:
        log.warning("Profil pominięty: %s", error)
    usable = {}
    for p in result.profiles:
        if p.addressing is not Addressing.REGISTERS:
            log.warning(
                "Profil pominięty: %s — adresowanie %s jeszcze nieobsługiwane", p.id, p.addressing
            )
            continue
        usable[(p.id, p.version)] = p
    return usable


async def _run(env: dict[str, str]) -> int:
    token = env.get("SOLARGRAF_AGENT_TOKEN", "").strip()
    if not token:
        print(
            "BŁĄD brak SOLARGRAF_AGENT_TOKEN — instalator zapisuje go w .env "
            "(solargraf-admin agent create/rotate)",
            file=sys.stderr,
        )
        return 2
    profiles = load_profiles(Path(env.get("SOLARGRAF_PROFILES_DIR", DEFAULT_PROFILES)))
    log.info("Wczytano %d profili urządzeń", len(profiles))
    api = ApiClient(env.get("SOLARGRAF_API_URL", DEFAULT_API_URL), token)
    buffer = Buffer(Path(env.get("SOLARGRAF_AGENT_BUFFER", DEFAULT_BUFFER)))
    try:
        await AgentRunner(api, buffer, profiles).run()
    finally:
        await api.aclose()
        buffer.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solargraf-agent")
    sub = parser.add_subparsers(dest="command", required=True)
    poll = sub.add_parser("poll", help="odczytaj urządzenie według profilu i wypisz wynik")
    poll.add_argument("profile", type=Path)
    poll.add_argument("--host", default="127.0.0.1")
    poll.add_argument("--port", type=int, default=502)
    poll.add_argument("--unit-id", type=int, default=1)
    poll.add_argument("--once", action="store_true", help="jeden cykl i koniec")
    sub.add_parser("run", help="praca ciągła: odczyt, bufor i wysyłka do serwera")
    args = parser.parse_args(argv)
    try:
        if args.command == "run":
            _configure_logging()
            return asyncio.run(_run(dict(os.environ)))
        return asyncio.run(_poll(args))
    except ProfileError as exc:
        print(f"BŁĄD {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


def _configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Biblioteki HTTP/Modbus tylko ostrzeżenia — bez adresów zapytań i szczegółów urządzeń.
    for name in ("httpx", "httpx2", "httpcore", "pymodbus"):
        logging.getLogger(name).setLevel(logging.WARNING)


if __name__ == "__main__":
    sys.exit(main())
