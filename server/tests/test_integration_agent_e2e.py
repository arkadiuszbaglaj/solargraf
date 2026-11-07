"""End-to-end (D43): symulator → agent (bufor, wysyłka) → API → PostgreSQL. Tylko w CI z bazą."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import httpx2
import pytest
from sqlalchemy import text

from solargraf_agent.api import ApiClient, AuthRejected
from solargraf_agent.buffer import Buffer
from solargraf_agent.cli import load_profiles
from solargraf_agent.runner import AgentRunner
from solargraf_server.config import Settings
from solargraf_server.db import create_engine
from solargraf_server.main import create_app
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import SimulatorServer, utc_now

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PROFILES_DIR = SERVER_DIR.parent / "profiles"
PROFILE = ("simulated.hybrid-inverter", "0.1.0")
TABLES = (
    "measurements, polling_runs, agent_batches, devices, connections, agents, "
    "membership_sites, sites, audit_events, auth_sessions, setup_tokens, memberships, users, "
    "organizations"
)


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 — stała lista argumentów
        [sys.executable, *args], capture_output=True, text=True, timeout=120, check=False
    )


@pytest.fixture(scope="module", autouse=True)
def _schema() -> None:
    done = _run("-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), "upgrade", "head")
    assert done.returncode == 0, done.stderr


async def _sql(statement: str, **params: object) -> list[tuple[Any, ...]]:
    engine = create_engine(Settings())  # type: ignore[call-arg]
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(statement), params)
            return [tuple(r) for r in result] if result.returns_rows else []
    finally:
        await engine.dispose()


def test_simulator_to_database_through_agent(tmp_path: Path) -> None:
    asyncio.run(_sql(f"TRUNCATE {TABLES} CASCADE"))
    done = _run("-m", "solargraf_server.cli", "agent", "create", "--name", "lokalny-e2e")
    assert done.returncode == 0, done.stderr
    token = done.stdout.strip()

    async def go() -> None:
        [(agent_id,)] = await _sql("SELECT id FROM agents WHERE name = 'lokalny-e2e'")
        org, site, conn, dev = (uuid.uuid4() for _ in range(4))
        await _sql("INSERT INTO organizations (id, name) VALUES (:o, 'E2E')", o=org)
        await _sql(
            "INSERT INTO sites (id, organization_id, name, timezone) "
            "VALUES (:s, :o, 'E2E', 'Europe/Warsaw')",
            s=site,
            o=org,
        )
        profiles = load_profiles(PROFILES_DIR)
        sim = SimulatorServer(Plant(PlantConfig(), now=utc_now()), RegisterMap(profiles[PROFILE]))
        port = await sim.start("127.0.0.1", 0)
        await _sql(
            "INSERT INTO connections (id, site_id, agent_id, name, transport, host, port, unit_id) "
            "VALUES (:c, :s, :a, 'Symulator', 'MODBUS_TCP', '127.0.0.1', :p, 1)",
            c=conn,
            s=site,
            a=agent_id,
            p=port,
        )
        await _sql(
            "INSERT INTO devices (id, site_id, connection_id, name, kind, profile_id, "
            "profile_version, enabled, freshness_threshold_seconds) "
            "VALUES (:d, :s, :c, 'Falownik (symulator)', 'INVERTER', :pid, :pv, true, 300)",
            d=dev,
            s=site,
            c=conn,
            pid=PROFILE[0],
            pv=PROFILE[1],
        )

        app = create_app(Settings())  # type: ignore[call-arg]
        transport = httpx2.ASGITransport(app=app)
        api = ApiClient("http://api", token, transport=transport)
        buffer = Buffer(tmp_path / "buffer.sqlite3")
        runner = AgentRunner(api, buffer, profiles)
        try:
            async with app.router.lifespan_context(app):
                await api.heartbeat("e2e")
                await runner.sync_config(start=False)
                [worker] = runner.workers.values()
                for _ in range(2):
                    await worker.poll_cycle()
                assert await runner.send_pending() == 2
                assert await buffer.count() == 0

                bad = ApiClient("http://api", "x" * 43, transport=transport)
                with pytest.raises(AuthRejected):
                    await bad.heartbeat("e2e")
                await bad.aclose()
        finally:
            await runner.aclose()
            await api.aclose()
            buffer.close()
            await sim.stop()

        [(heartbeat, version)] = await _sql(
            "SELECT last_heartbeat_at, version FROM agents WHERE id = :a", a=agent_id
        )
        assert heartbeat is not None
        assert version == "e2e"
        runs = await _sql("SELECT result, ok_points FROM polling_runs WHERE device_id = :d", d=dev)
        assert [r[0] for r in runs] == ["OK", "OK"]
        rows = await _sql(
            "SELECT metric, quality, origin, value FROM measurements WHERE device_id = :d", d=dev
        )
        assert len(rows) == sum(r[1] for r in runs)
        assert {r[1] for r in rows} == {"GOOD"}
        assert {r[2] for r in rows} == {"SIMULATED"}
        assert "pv_power" in {r[0] for r in rows}
        [(success,)] = await _sql("SELECT last_success_at FROM devices WHERE id = :d", d=dev)
        assert success is not None

    asyncio.run(go())
