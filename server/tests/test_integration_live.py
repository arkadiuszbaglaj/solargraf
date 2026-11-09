"""Strumień na żywo instalacji (D50): uprawnienia, migawka, publikacja z ingestu — w CI."""

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

from solargraf_server import live
from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine
from solargraf_server.live import LiveBus
from solargraf_server.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-na-zywo"
TABLES = (
    "aggregates, aggregate_dirty, measurements, polling_runs, agent_batches, devices, "
    "connections, agents, membership_sites, sites, audit_events, auth_sessions, setup_tokens, "
    "memberships, users, organizations"
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
    token: str
    site_a: uuid.UUID
    site_b: uuid.UUID
    device_a: uuid.UUID


def _user(email: str, org: uuid.UUID, role: str) -> None:
    user = uuid.uuid4()
    _sql(
        "INSERT INTO users (id, email, display_name, password_hash, is_active, failed_login_count) "
        "VALUES (:id, :e, 'U', :pw, true, 0)",
        id=user,
        e=email,
        pw=hash_password(PASSWORD),
    )
    _sql(
        "INSERT INTO memberships (id, user_id, organization_id, role, all_sites) "
        "VALUES (:id, :u, :o, :r, true)",
        id=uuid.uuid4(),
        u=user,
        o=org,
        r=role,
    )


@pytest.fixture
def world() -> World:
    _sql(f"TRUNCATE {TABLES} CASCADE")
    org_a, org_b, site_a, site_b = (uuid.uuid4() for _ in range(4))
    _sql("INSERT INTO organizations (id, name) VALUES (:a, 'A'), (:b, 'B')", a=org_a, b=org_b)
    _sql(
        "INSERT INTO sites (id, organization_id, name, timezone) "
        "VALUES (:a, :oa, 'A1', 'Europe/Warsaw'), (:b, :ob, 'B1', 'Europe/Warsaw')",
        a=site_a,
        oa=org_a,
        b=site_b,
        ob=org_b,
    )
    _user("viewer@example.pl", org_a, "VIEWER")
    _user("obcy@example.pl", org_b, "OWNER")
    done = subprocess.run(
        [sys.executable, "-m", "solargraf_server.cli", "agent", "create", "--name", "agent-a"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    [(agent,)] = _sql("SELECT id FROM agents WHERE name = 'agent-a'")
    conn, dev = uuid.uuid4(), uuid.uuid4()
    _sql(
        "INSERT INTO connections (id, site_id, agent_id, name, transport, host, port, unit_id) "
        "VALUES (:id, :s, :a, 'Logger', 'MODBUS_TCP', 'logger.lan', 502, 1)",
        id=conn,
        s=site_a,
        a=agent,
    )
    _sql(
        "INSERT INTO devices (id, site_id, connection_id, name, kind, profile_id, profile_version, "
        "enabled, freshness_threshold_seconds) "
        "VALUES (:id, :s, :c, 'Falownik', 'INVERTER', 'simulated.hybrid-inverter', '0.1.0', "
        "true, 300)",
        id=dev,
        s=site_a,
        c=conn,
    )
    return World(done.stdout.strip(), site_a, site_b, dev)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Klient testowy czyta całą odpowiedź — strumień musi się szybko zakończyć.
    monkeypatch.setattr(live, "MAX_STREAM", timedelta(seconds=0.2))
    monkeypatch.setattr(live, "PING_S", 0.1)
    with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
        yield c


def login(client: TestClient, email: str) -> None:
    resp = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200


def post_batch(client: TestClient, world: World, at: datetime) -> None:
    body = {
        "batch_id": str(uuid.uuid4()),
        "runs": [
            {
                "device_id": str(world.device_a),
                "started_at": at.isoformat(),
                "finished_at": at.isoformat(),
                "result": "PARTIAL",
                "readings": [
                    {
                        "metric": "pv_power",
                        "value": 2500.0,
                        "quality": "GOOD",
                        "origin": "SIMULATED",
                        "received_at": at.isoformat(),
                    },
                    {
                        "metric": "battery_soc",
                        "value": None,
                        "quality": "MISSING",
                        "origin": "SIMULATED",
                        "received_at": at.isoformat(),
                    },
                ],
            }
        ],
    }
    resp = client.post(
        "/api/agent/batches", json=body, headers={"Authorization": f"Bearer {world.token}"}
    )
    assert resp.status_code == 200, resp.text


def live_body(world: World, at: datetime, device: uuid.UUID | None = None) -> dict[str, Any]:
    return {
        "runs": [
            {
                "device_id": str(device or world.device_a),
                "started_at": at.isoformat(),
                "finished_at": at.isoformat(),
                "result": "OK",
                "readings": [
                    {
                        "metric": "pv_power",
                        "value": 2600.0,
                        "quality": "GOOD",
                        "origin": "SIMULATED",
                        "received_at": at.isoformat(),
                    }
                ],
            }
        ]
    }


def snapshot_of(body: str) -> dict[str, Any]:
    for block in body.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if lines.get("event") == "snapshot":
            data: dict[str, Any] = json.loads(lines["data"])
            return data
    raise AssertionError("brak zdarzenia snapshot")


class TestLive:
    def test_requires_login_and_hides_foreign_site(self, world: World, client: TestClient) -> None:
        assert client.get(f"/api/sites/{world.site_a}/live").status_code == 401
        login(client, "obcy@example.pl")
        assert client.get(f"/api/sites/{world.site_a}/live").status_code == 404

    def test_snapshot_has_devices_metrics_and_latest_readings(
        self, world: World, client: TestClient
    ) -> None:
        now = datetime.now(UTC).replace(microsecond=0)
        post_batch(client, world, now - timedelta(minutes=2))
        post_batch(client, world, now - timedelta(minutes=1))
        login(client, "viewer@example.pl")
        resp = client.get(f"/api/sites/{world.site_a}/live")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        data = snapshot_of(resp.text)
        [device] = data["devices"]
        assert device["id"] == str(world.device_a)
        assert device["freshness_threshold_seconds"] == 300
        assert any(m["key"] == "pv_power" for m in device["metrics"])
        by_metric = {r["metric"]: r for r in data["readings"]}
        assert set(by_metric) == {"pv_power", "battery_soc"}
        # Tylko najnowszy odczyt każdej metryki; brak odczytu zostaje brakiem (null), nie zerem.
        assert by_metric["pv_power"]["value"] == 2500.0
        received = datetime.fromisoformat(by_metric["pv_power"]["received_at"])
        assert received == now - timedelta(minutes=1)
        assert by_metric["battery_soc"]["value"] is None
        assert by_metric["battery_soc"]["quality"] == "MISSING"
        assert by_metric["pv_power"]["channel"] is None

    def test_ingest_publishes_to_site_subscribers_after_commit(
        self, world: World, client: TestClient
    ) -> None:
        bus: LiveBus = client.app.state.live_bus  # type: ignore[attr-defined]
        mine = bus.subscribe(world.site_a, uuid.uuid4())
        other = bus.subscribe(world.site_b, uuid.uuid4())
        post_batch(client, world, datetime.now(UTC).replace(microsecond=0))
        update = mine.queue.get_nowait()
        assert {r.metric for r in update.readings} == {"pv_power", "battery_soc"}
        assert all(r.device_id == world.device_a for r in update.readings)
        assert other.queue.empty()

    def test_live_readings_reach_subscribers_without_being_stored(
        self, world: World, client: TestClient
    ) -> None:
        """Szybki podgląd (D78): tylko magistrala — bez pomiarów, cykli i zmiany statusu."""
        bus: LiveBus = client.app.state.live_bus  # type: ignore[attr-defined]
        mine = bus.subscribe(world.site_a, uuid.uuid4())
        other = bus.subscribe(world.site_b, uuid.uuid4())
        auth = {"Authorization": f"Bearer {world.token}"}
        at = datetime.now(UTC).replace(microsecond=0)
        resp = client.post("/api/agent/live", json=live_body(world, at), headers=auth)
        assert resp.status_code == 204, resp.text
        [reading] = mine.queue.get_nowait().readings
        assert (reading.metric, reading.value, reading.origin) == ("pv_power", 2600.0, "SIMULATED")
        assert other.queue.empty()
        assert _sql("SELECT count(*) FROM measurements") == [(0,)]
        assert _sql("SELECT count(*) FROM polling_runs") == [(0,)]
        assert _sql("SELECT last_success_at FROM devices") == [(None,)]

    def test_live_rejects_foreign_device_future_time_and_user_session(
        self, world: World, client: TestClient
    ) -> None:
        auth = {"Authorization": f"Bearer {world.token}"}
        now = datetime.now(UTC)
        foreign = live_body(world, now, device=uuid.uuid4())
        assert client.post("/api/agent/live", json=foreign, headers=auth).status_code == 422
        future = live_body(world, now + timedelta(minutes=10))
        assert client.post("/api/agent/live", json=future, headers=auth).status_code == 422
        login(client, "viewer@example.pl")
        assert client.post("/api/agent/live", json=live_body(world, now)).status_code == 401
