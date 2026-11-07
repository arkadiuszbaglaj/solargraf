"""Testy z prawdziwym PostgreSQL. Uruchamiane, gdy ustawiono ``SOLARGRAF_TEST_DB=1``
(CI: usługa postgres; lokalnie: baza z compose.dev.yaml i zmienne SOLARGRAF_DB_*)."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from solargraf_server.config import Settings
from solargraf_server.db import create_engine
from solargraf_server.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent


def _alembic(*args: str) -> None:
    subprocess.run(  # noqa: S603 — stała lista argumentów
        [sys.executable, "-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), *args],
        check=True,
        timeout=120,
    )


async def _current_revision(settings: Settings) -> str | None:
    engine = create_engine(settings)
    try:
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT version_num FROM alembic_version"))
            return result.scalar_one_or_none()
    finally:
        await engine.dispose()


def test_migrations_upgrade_and_downgrade() -> None:
    settings = Settings()  # type: ignore[call-arg]
    _alembic("upgrade", "head")
    assert asyncio.run(_current_revision(settings)) == "0007"
    _alembic("downgrade", "base")
    assert asyncio.run(_current_revision(settings)) is None
    _alembic("upgrade", "head")


def test_readiness_ok_with_real_database() -> None:
    with TestClient(create_app(Settings())) as client:  # type: ignore[call-arg]
        resp = client.get("/api/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
