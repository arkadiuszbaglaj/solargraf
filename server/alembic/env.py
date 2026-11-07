"""Środowisko migracji Alembic (asyncpg). Uruchamiane przez usługę ``migrate`` (D26)."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import MetaData
from sqlalchemy.engine import Connection

from solargraf_server.config import Settings
from solargraf_server.db import create_engine

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Metadane modeli dojdą w P2; na razie pusta baza odniesienia.
target_metadata = MetaData()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
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
