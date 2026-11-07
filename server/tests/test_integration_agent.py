"""Agent ↔ serwer (D42): poświadczenie, izolacja, idempotencja partii, pomiary — PostgreSQL w CI."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine
from solargraf_server.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-agenta"
TABLES = (
    "aggregates, aggregate_dirty, measurements, polling_runs, agent_batches, devices, "
    "connections, agents, "
    "membership_sites, sites, audit_events, auth_sessions, setup_tokens, memberships, users, "
    "organizations"
)


def _sql(statement: str, **params: object) -> list[tuple[Any, ...]]:
    async def go() -> list[tuple[Any, ...]]:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(statement), params)
                return [tuple(r) for r in result] if result.returns_rows else []
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _admin(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 — stała lista argumentów
        [sys.executable, "-m", "solargraf_server.cli", *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.fixture(scope="module", autouse=True)
def _schema() -> None:
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), "upgrade", "head"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr


@dataclass
class World:
    token_a: str
    token_b: str
    site_a: uuid.UUID
    device_a: uuid.UUID
    device_b: uuid.UUID
    connection_a: uuid.UUID


def _agent(name: str) -> tuple[str, uuid.UUID]:
    done = _admin("agent", "create", "--name", name)
    assert done.returncode == 0, done.stderr
    token = done.stdout.strip()
    [(agent_id,)] = _sql("SELECT id FROM agents WHERE name = :n", n=name)
    return token, agent_id


def _device(site: uuid.UUID, agent: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    conn, dev = uuid.uuid4(), uuid.uuid4()
    _sql(
        "INSERT INTO connections (id, site_id, agent_id, name, transport, host, port, unit_id) "
        "VALUES (:id, :s, :a, 'Logger', 'MODBUS_TCP', 'logger.lan', 502, 1)",
        id=conn,
        s=site,
        a=agent,
    )
    _sql(
        "INSERT INTO devices (id, site_id, connection_id, name, kind, profile_id, profile_version, "
        "enabled, freshness_threshold_seconds) "
        "VALUES (:id, :s, :c, 'Falownik', 'INVERTER', 'simulated.hybrid-inverter', '0.1.0', "
        "true, 300)",
        id=dev,
        s=site,
        c=conn,
    )
    return conn, dev


@pytest.fixture
def world() -> World:
    _sql(f"TRUNCATE {TABLES} CASCADE")
    org_a, org_b, site_a, site_b, user = (uuid.uuid4() for _ in range(5))
    _sql("INSERT INTO organizations (id, name) VALUES (:a, 'A'), (:b, 'B')", a=org_a, b=org_b)
    _sql(
        "INSERT INTO sites (id, organization_id, name, timezone) "
        "VALUES (:a, :oa, 'A1', 'Europe/Warsaw'), (:b, :ob, 'B1', 'Europe/Warsaw')",
        a=site_a,
        oa=org_a,
        b=site_b,
        ob=org_b,
    )
    _sql(
        "INSERT INTO users (id, email, display_name, password_hash, is_active, failed_login_count) "
        "VALUES (:id, 'owner@example.pl', 'Owner', :pw, true, 0)",
        id=user,
        pw=hash_password(PASSWORD),
    )
    _sql(
        "INSERT INTO memberships (id, user_id, organization_id, role, all_sites) "
        "VALUES (:id, :u, :o, 'OWNER', true)",
        id=uuid.uuid4(),
        u=user,
        o=org_a,
    )
    token_a, agent_a = _agent("agent-a")
    token_b, agent_b = _agent("agent-b")
    conn_a, dev_a = _device(site_a, agent_a)
    _, dev_b = _device(site_b, agent_b)
    return World(token_a, token_b, site_a, dev_a, dev_b, conn_a)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
        yield c


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def batch(device: uuid.UUID, at: datetime, **run: Any) -> dict[str, Any]:  # noqa: ANN401
    readings = run.pop(
        "readings",
        [
            {
                "metric": "pv_power",
                "value": 1234.5,
                "quality": "GOOD",
                "origin": "SIMULATED",
                "received_at": at.isoformat(),
            },
            {
                "metric": "pv_string_voltage",
                "channel": 1,
                "value": None,
                "quality": "MISSING",
                "origin": "SIMULATED",
                "received_at": at.isoformat(),
            },
        ],
    )
    return {
        "batch_id": str(uuid.uuid4()),
        "runs": [
            {
                "device_id": str(device),
                "started_at": at.isoformat(),
                "finished_at": at.isoformat(),
                "result": "PARTIAL",
                "readings": readings,
            }
            | run
        ],
    }


def now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


class TestAuth:
    def test_missing_wrong_and_disabled_tokens(self, world: World, client: TestClient) -> None:
        assert client.get("/api/agent/config").status_code == 401
        assert client.get("/api/agent/config", headers=bearer("x" * 43)).status_code == 401
        assert client.get("/api/agent/config", headers=bearer(world.token_a)).status_code == 200
        assert _admin("agent", "disable", "--name", "agent-a").returncode == 0
        assert client.get("/api/agent/config", headers=bearer(world.token_a)).status_code == 401

    def test_token_is_stored_only_as_hash(self, world: World) -> None:
        hashes = [h for (h,) in _sql("SELECT token_hash FROM agents")]
        assert world.token_a not in hashes
        assert all(len(h) == 64 for h in hashes)
        assert ("AGENT_CREATED",) in _sql("SELECT action FROM audit_events")

    def test_user_session_and_agent_token_are_not_interchangeable(
        self, world: World, client: TestClient
    ) -> None:
        login = client.post(
            "/api/auth/login", json={"email": "owner@example.pl", "password": PASSWORD}
        )
        assert login.status_code == 200
        assert client.get("/api/agent/config").status_code == 401  # cookie sesji nie wystarcza
        client.cookies.clear()
        assert client.get("/api/sites", headers=bearer(world.token_a)).status_code == 401


class TestConfigAndHeartbeat:
    def test_config_lists_only_own_devices_with_etag(
        self, world: World, client: TestClient
    ) -> None:
        resp = client.get("/api/agent/config", headers=bearer(world.token_a))
        body = resp.json()
        [conn] = body["connections"]
        assert conn["id"] == str(world.connection_a)
        assert [d["id"] for d in conn["devices"]] == [str(world.device_a)]
        assert conn["devices"][0]["profile_id"] == "simulated.hybrid-inverter"
        etag = resp.headers["etag"]
        again = client.get(
            "/api/agent/config", headers=bearer(world.token_a) | {"If-None-Match": etag}
        )
        assert again.status_code == 304

    def test_heartbeat_records_time_and_version(self, world: World, client: TestClient) -> None:
        resp = client.post(
            "/api/agent/heartbeat", json={"version": "0.0.0"}, headers=bearer(world.token_a)
        )
        assert resp.status_code == 204
        [(seen, version)] = _sql(
            "SELECT last_heartbeat_at, version FROM agents WHERE name = 'agent-a'"
        )
        assert seen is not None
        assert version == "0.0.0"


class TestBatches:
    def post(self, client: TestClient, token: str, body: dict[str, Any]) -> Any:  # noqa: ANN401
        return client.post("/api/agent/batches", json=body, headers=bearer(token))

    def test_accepts_batch_stores_missing_as_null_and_updates_status(
        self, world: World, client: TestClient
    ) -> None:
        login = client.post(
            "/api/auth/login", json={"email": "owner@example.pl", "password": PASSWORD}
        )
        assert login.status_code == 200
        devices = f"/api/sites/{world.site_a}/devices"
        client.post("/api/agent/heartbeat", json={}, headers=bearer(world.token_a))
        assert client.get(devices).json()[0]["status"] == "UNKNOWN"  # nigdy nieodczytane

        resp = self.post(client, world.token_a, batch(world.device_a, now()))
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"duplicate": False, "runs": 1, "readings": 2}
        rows = _sql("SELECT metric, channel, value, quality FROM measurements ORDER BY metric")
        assert rows == [("pv_power", 0, 1234.5, "GOOD"), ("pv_string_voltage", 1, None, "MISSING")]
        [(result, ok, failed)] = _sql("SELECT result, ok_points, failed_points FROM polling_runs")
        assert (result, ok, failed) == ("PARTIAL", 1, 1)
        assert client.get(devices).json()[0]["status"] == "OK"

        failed_run = batch(world.device_a, now() + timedelta(seconds=1), result="FAILED")
        failed_run["runs"][0]["error_code"] = "TIMEOUT"
        failed_run["runs"][0]["readings"] = []
        assert self.post(client, world.token_a, failed_run).status_code == 200
        assert client.get(devices).json()[0]["status"] == "ERROR"

    def test_duplicate_batch_is_idempotent(self, world: World, client: TestClient) -> None:
        body = batch(world.device_a, now())
        assert self.post(client, world.token_a, body).json()["duplicate"] is False
        assert self.post(client, world.token_a, body).json() == {
            "duplicate": True,
            "runs": 0,
            "readings": 0,
        }
        assert _sql("SELECT count(*) FROM measurements") == [(2,)]
        assert _sql("SELECT count(*) FROM polling_runs") == [(1,)]

    def test_foreign_device_rejects_whole_batch(self, world: World, client: TestClient) -> None:
        body = batch(world.device_a, now())
        body["runs"] += batch(world.device_b, now())["runs"]
        resp = self.post(client, world.token_a, body)
        assert resp.status_code == 422
        assert _sql("SELECT count(*) FROM measurements") == [(0,)]
        assert _sql("SELECT count(*) FROM agent_batches") == [(0,)]
        missing = batch(uuid.uuid4(), now())
        assert self.post(client, world.token_a, missing).json() == resp.json()

    @pytest.mark.parametrize(
        "change",
        [
            {"metric": "grid_magic"},
            {"value": None},  # GOOD bez wartości
            {"quality": "MISSING"},  # MISSING z wartością
            {"origin": "DEMO"},  # agent nie wysyła danych DEMO
            {"value": float("nan")},
            {"received_at": "2026-11-07T12:00:00"},  # bez strefy
        ],
        ids=["metric", "good-null", "missing-value", "demo", "nan", "naive-time"],
    )
    def test_invalid_reading_rejects_batch(
        self, world: World, client: TestClient, change: dict[str, Any]
    ) -> None:
        reading = {
            "metric": "pv_power",
            "value": 1.0,
            "quality": "GOOD",
            "origin": "DEVICE",
            "received_at": now().isoformat(),
        } | change
        body = batch(world.device_a, now(), readings=[reading])
        resp = client.post(
            "/api/agent/batches",
            content=json.dumps(body, allow_nan=True),
            headers=bearer(world.token_a) | {"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        assert _sql("SELECT count(*) FROM measurements") == [(0,)]

    def test_future_time_and_size_limit(self, world: World, client: TestClient) -> None:
        future = batch(world.device_a, now() + timedelta(minutes=10))
        assert self.post(client, world.token_a, future).status_code == 422
        huge = b'{"batch_id": "' + b"x" * 1_000_001 + b'"}'
        resp = client.post(
            "/api/agent/batches",
            content=huge,
            headers=bearer(world.token_a) | {"Content-Type": "application/json"},
        )
        assert resp.status_code == 413

    def test_measurements_land_in_monthly_partition(self, world: World, client: TestClient) -> None:
        at = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)  # przeszłość, partycja listopadowa
        assert self.post(client, world.token_a, batch(world.device_a, at)).status_code == 200
        partitions = _sql("SELECT DISTINCT tableoid::regclass::text FROM measurements")
        assert partitions == [("measurements_y2026m11",)]
