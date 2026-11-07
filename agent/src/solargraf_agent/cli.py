"""Ręczne sprawdzenie odczytu urządzenia (D41). Bez wysyłania danych do serwera.

Przykład: ``uv run solargraf-agent poll profiles/simulated.hybrid-inverter.yaml --port 5020 --once``
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from solargraf_agent.modbus import ModbusPoller, Target
from solargraf_agent.readings import PollingRun
from solargraf_profiles.loader import ProfileError, load_profile


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solargraf-agent")
    sub = parser.add_subparsers(dest="command", required=True)
    poll = sub.add_parser("poll", help="odczytaj urządzenie według profilu i wypisz wynik")
    poll.add_argument("profile", type=Path)
    poll.add_argument("--host", default="127.0.0.1")
    poll.add_argument("--port", type=int, default=502)
    poll.add_argument("--unit-id", type=int, default=1)
    poll.add_argument("--once", action="store_true", help="jeden cykl i koniec")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_poll(args))
    except ProfileError as exc:
        print(f"BŁĄD {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
