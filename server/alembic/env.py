"""Środowisko migracji Alembic (asyncpg). Uruchamiane przez usługę ``migrate`` (D26)."""

from __future__ import annotations

import asyncio
import re
from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

from solargraf_server.config import Settings
from solargraf_server.db import create_engine
from solargraf_server.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Wszystkie modele rejestrują się w Base.metadata (import pakietu models).
target_metadata = Base.metadata


# Partycje tabeli measurements (D42) tworzy migracja; nie są modelami ORM.
_PARTITION = re.compile(r"^measurements_(y\d{4}m\d{2}|default)$")


def _include_name(name: str | None, type_: str, parent_names: object) -> bool:
    return not (type_ == "table" and name is not None and _PARTITION.match(name))


def _run(connection: Connection) -> None:
    context.configure(
        connection=connection, target_metadata=target_metadata, include_name=_include_name
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run_online() -> None:
    engine = create_engine(Settings())  # type: ignore[call-arg]  # pola z env
    try:
        async with engine.connect() as conn:
            await conn.run_sync(_run)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    raise SystemExit("Tryb offline (--sql) nie jest wspierany.")
asyncio.run(_run_online())
