"""Narzędzie administracyjne ``solargraf-admin`` (uruchamiane w kontenerze ``api``).

solargraf-admin setup-token   — jednorazowy token pierwszej konfiguracji, ważny 1 h (D31)
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime

from solargraf_server.auth import service
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker


async def _setup_token() -> int:
    engine = create_engine(Settings())  # type: ignore[call-arg]  # pola z env
    try:
        async with create_sessionmaker(engine)() as db:
            try:
                token = await service.create_setup_token(db, datetime.now(UTC))
            except service.SetupError:
                print("System jest już skonfigurowany — token nie został wydany.", file=sys.stderr)
                return 1
    finally:
        await engine.dispose()
    # Token trafia tylko na standardowe wyjście operatora, nie do logów aplikacji.
    print(token)
    print(
        f"Ważny {int(service.SETUP_TOKEN_TTL.total_seconds() // 3600)} h, jednorazowy. "
        "Użyj go w POST /api/setup.",
        file=sys.stderr,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solargraf-admin")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup-token", help="wydaj jednorazowy token pierwszej konfiguracji")
    args = parser.parse_args(argv)
    if args.command == "setup-token":
        return asyncio.run(_setup_token())
    return 2


if __name__ == "__main__":
    sys.exit(main())
