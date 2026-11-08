"""Narzędzie administracyjne ``solargraf-admin`` (uruchamiane w kontenerze ``api``).

solargraf-admin setup-token            — jednorazowy token pierwszej konfiguracji, ważny 1 h (D31)
solargraf-admin agent create --name N  — nowy agent; token wypisany raz na stdout (D42)
solargraf-admin agent rotate --name N  — nowy token agenta (stary przestaje działać), wypisany raz
solargraf-admin agent disable --name N — wyłączenie agenta (token przestaje działać)
solargraf-admin agent list             — lista agentów bez tokenów
solargraf-admin update-target          — wersja do instalacji z podpisanego manifestu (D65)
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server import __version__
from solargraf_server.auth import service
from solargraf_server.auth.tokens import new_token, token_hash
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.models import Agent, AgentMode
from solargraf_server.updates import manifest as mf
from solargraf_server.updates import service as updates
from solargraf_server.updates.release_key import RELEASE_PUBLIC_KEY

# Kody wyjścia ``update-target`` czytane przez ``install.sh update`` (D65).
EXIT_NO_NEWER = 10
EXIT_INTERMEDIATE = 11
EXIT_CHECK_FAILED = 12


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


async def _with_db(action: Callable[[AsyncSession], Awaitable[int]]) -> int:
    engine = create_engine(Settings())  # type: ignore[call-arg]  # pola z env
    try:
        async with create_sessionmaker(engine)() as db:
            return await action(db)
    finally:
        await engine.dispose()


async def agent_create(db: AsyncSession, name: str, mode: AgentMode) -> int:
    if await db.scalar(select(Agent.id).where(Agent.name == name)) is not None:
        print(f"Agent o nazwie {name!r} już istnieje.", file=sys.stderr)
        return 1
    token = new_token()
    agent = Agent(name=name, mode=mode.value, token_hash=token_hash(token), enabled=True)
    db.add(agent)
    await db.flush()
    await service.audit(db, "AGENT_CREATED", target=f"agent:{agent.id}")
    await db.commit()
    # Token tylko na stdout operatora (np. do .env agenta), nie do logów i nie do bazy.
    print(token)
    print(f"Agent {name!r} ({agent.id}) utworzony. Token jest pokazany tylko raz.", file=sys.stderr)
    return 0


async def agent_rotate(db: AsyncSession, name: str) -> int:
    agent = await db.scalar(select(Agent).where(Agent.name == name))
    if agent is None:
        print(f"Brak agenta {name!r}.", file=sys.stderr)
        return 1
    token = new_token()
    agent.token_hash = token_hash(token)
    agent.enabled = True
    await service.audit(db, "AGENT_TOKEN_ROTATED", target=f"agent:{agent.id}")
    await db.commit()
    print(token)
    print(f"Nowy token agenta {name!r}; poprzedni przestał działać.", file=sys.stderr)
    return 0


async def agent_disable(db: AsyncSession, name: str) -> int:
    agent = await db.scalar(select(Agent).where(Agent.name == name))
    if agent is None:
        print(f"Brak agenta {name!r}.", file=sys.stderr)
        return 1
    agent.enabled = False
    await service.audit(db, "AGENT_DISABLED", target=f"agent:{agent.id}")
    await db.commit()
    print(f"Agent {name!r} wyłączony.", file=sys.stderr)
    return 0


async def agent_list(db: AsyncSession) -> int:
    for a in (await db.scalars(select(Agent).order_by(Agent.name))).all():
        seen = a.last_heartbeat_at.isoformat() if a.last_heartbeat_at else "nigdy"
        state = "włączony" if a.enabled else "wyłączony"
        print(f"{a.name} | {a.mode} | {state} | heartbeat: {seen} | wersja: {a.version or '-'}")
    return 0


async def update_target(
    *,
    url: str,
    timeout_s: float,
    public_key: str | None,
    current: str = __version__,
    fetch: updates.Fetch = updates.fetch_https,
) -> int:
    """Pobiera manifest i podpis od nowa (bez bazy), sprawdza podpis i wypisuje wersję docelową.

    Na stdout trafia wyłącznie numer wersji ``MAJOR.MINOR.PATCH`` — skrypt aktualizacji ufa
    tylko temu, co przeszło weryfikację podpisu kluczem wbudowanym w zainstalowaną wersję.
    """
    if public_key is None:
        print(
            f"Sprawdzanie aktualizacji niedostępne: {mf.CheckError.NOT_CONFIGURED}.",
            file=sys.stderr,
        )
        return EXIT_CHECK_FAILED
    try:
        body = await fetch(url, timeout_s, mf.MAX_MANIFEST_BYTES)
        signature = await fetch(url + ".sig", timeout_s, mf.MAX_SIGNATURE_BYTES)
        verified = mf.verify(body, signature, mf.load_public_key(public_key))
    except (updates.FetchError, mf.ManifestRejected) as exc:
        print(f"Nie udało się sprawdzić aktualizacji: {exc.code}.", file=sys.stderr)
        return EXIT_CHECK_FAILED
    target = mf.upgrade_target(verified, current)
    if target is mf.TargetRefused.NO_NEWER:
        print(
            f"Brak nowszej wersji (zainstalowana {current}, najnowsza {verified.version}).",
            file=sys.stderr,
        )
        return EXIT_NO_NEWER
    if target is mf.TargetRefused.INTERMEDIATE:
        print(
            f"Wersja {verified.version} wymaga najpierw aktualizacji do "
            f"{verified.min_upgrade_from} (zainstalowana {current}).",
            file=sys.stderr,
        )
        return EXIT_INTERMEDIATE
    print(target)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solargraf-admin")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup-token", help="wydaj jednorazowy token pierwszej konfiguracji")
    agent = sub.add_parser("agent", help="zarządzanie agentami").add_subparsers(
        dest="agent_command", required=True
    )
    create = agent.add_parser("create", help="utwórz agenta i wypisz jego token")
    create.add_argument("--name", required=True)
    create.add_argument("--mode", choices=[m.value for m in AgentMode], default="LOCAL")
    rotate = agent.add_parser("rotate", help="wydaj nowy token agenta (unieważnia poprzedni)")
    rotate.add_argument("--name", required=True)
    disable = agent.add_parser("disable", help="wyłącz agenta")
    disable.add_argument("--name", required=True)
    agent.add_parser("list", help="lista agentów")
    sub.add_parser("update-target", help="wersja do instalacji z podpisanego manifestu")
    args = parser.parse_args(argv)
    if args.command == "update-target":
        settings = Settings()  # type: ignore[call-arg]  # pola z env
        return asyncio.run(
            update_target(
                url=settings.update_manifest_url,
                timeout_s=settings.update_timeout_s,
                public_key=RELEASE_PUBLIC_KEY,
            )
        )
    if args.command == "setup-token":
        return asyncio.run(_setup_token())
    if args.command == "agent":
        name = getattr(args, "name", "").strip()
        if args.agent_command != "list" and not 1 <= len(name) <= 100:
            print("Nazwa agenta: 1-100 znaków.", file=sys.stderr)
            return 2
        actions: dict[str, Callable[[AsyncSession], Awaitable[int]]] = {
            "create": lambda db: agent_create(db, name, AgentMode(args.mode)),
            "rotate": lambda db: agent_rotate(db, name),
            "disable": lambda db: agent_disable(db, name),
            "list": agent_list,
        }
        return asyncio.run(_with_db(actions[args.agent_command]))
    return 2


if __name__ == "__main__":
    sys.exit(main())
