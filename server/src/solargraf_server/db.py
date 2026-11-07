"""Dostęp do bazy danych: silnik asynchroniczny i sprawdzenie gotowości."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from solargraf_server.config import Settings

logger = logging.getLogger(__name__)


def create_engine(settings: Settings) -> AsyncEngine:
    return create_async_engine(
        settings.database_url(),
        pool_pre_ping=True,
        connect_args={"timeout": settings.db_timeout_s},
    )


def create_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """Zależność FastAPI: sesja bazy na czas żądania; wycofanie przy wyjątku."""
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with maker() as session:
        try:
            yield session
        except BaseException:
            await session.rollback()
            raise


async def database_ready(engine: AsyncEngine, timeout_s: float) -> bool:
    """``True``, jeśli baza odpowiada na ``SELECT 1`` w zadanym czasie.

    Szczegóły błędu trafiają tylko do logu serwera (bez danych połączenia), nigdy do klienta.
    """
    try:
        async with asyncio.timeout(timeout_s), engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except (TimeoutError, SQLAlchemyError, OSError) as exc:
        logger.warning("Baza danych niegotowa: %s", type(exc).__name__)
        return False
    return True
