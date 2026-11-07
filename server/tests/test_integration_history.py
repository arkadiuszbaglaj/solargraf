"""Agregaty i historia (D46): ingest → oznaczenie godzin → worker → API — PostgreSQL w CI."""

from __future__ import annotations

import asyncio
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

from solargraf_server.aggregation import H1, floor_utc
from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.main import create_app
from solargraf_server.profiles import ProfileCatalog
from solargraf_server.worker import process_dirty

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-historii"
TABLES = (
    "aggregates, aggregate_dirty, measurements, polling_runs, agent_batches, devices, "
    "connections, agents, "
    "membership_sites, sites, audit_events, auth_sessions, setup_tokens, memberships, users, "
    "organizations"
)
# Interwał połączenia 60 s: przedział 5 min ma pełne pokrycie przy 5 próbkach GOOD.
INTERVAL_S = 60


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


def _work() -> int:
    async def go() -> int:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                return await process_dirty(db, ProfileCatalog([]))
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
    device_b: uuid.UUID


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


def _device(site: uuid.UUID, agent: uuid.UUID | None) -> uuid.UUID:
    conn, dev = uuid.uuid4(), uuid.uuid4()
    _sql(
        "INSERT INTO connections (id, site_id, agent_id, name, transport, host, port, unit_id, "
        "poll_interval_seconds) VALUES (:id, :s, :a, 'Logger', 'MODBUS_TCP', 'logger.lan', 502, "
        "1, :i)",
        id=conn,
        s=site,
        a=agent,
        i=INTERVAL_S,
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
    return dev


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
    _user("owner@example.pl", org_a, "OWNER")
    _user("viewer@example.pl", org_a, "VIEWER")
    done = subprocess.run(
        [sys.executable, "-m", "solargraf_server.cli", "agent", "create", "--name", "agent-a"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    [(agent,)] = _sql("SELECT id FROM agents WHERE name = 'agent-a'")
    return World(done.stdout.strip(), site_a, site_b, _device(site_a, agent), _device(site_b, None))


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
        yield c


# Pełna godzina sprzed kilku godzin — dane nie są „z przyszłości”.
HOUR = floor_utc(datetime.now(UTC) - timedelta(hours=3), H1)


def reading(minutes: float, value: float | None, quality: str = "GOOD") -> dict[str, Any]:
    return {
        "metric": "pv_power",
        "value": value,
        "quality": quality,
        "origin": "SIMULATED",
        "received_at": (HOUR + timedelta(minutes=minutes)).isoformat(),
    }


def send(client: TestClient, world: World, readings: list[dict[str, Any]]) -> None:
    at = HOUR.isoformat()
    body = {
        "batch_id": str(uuid.uuid4()),
        "runs": [
            {
                "device_id": str(world.device_a),
                "started_at": at,
                "finished_at": at,
                "result": "OK",
                "readings": readings,
            }
        ],
    }
    resp = client.post(
        "/api/agent/batches", json=body, headers={"Authorization": f"Bearer {world.token}"}
    )
    assert resp.status_code == 200, resp.text


FIRST = [
    reading(0, 100.0),
    reading(1, 200.0),
    reading(2, 9999.0, "INVALID"),  # odrzucona przez walidację zakresu w agencie
    reading(3, None, "MISSING"),
    reading(6, 400.0),
]


def aggregates(resolution: str) -> list[tuple[Any, ...]]:
    return _sql(
        "SELECT bucket_start, avg, min, max, last, samples, good_samples, coverage "
        "FROM aggregates WHERE resolution = :r ORDER BY bucket_start",
        r=resolution,
    )


class TestWorker:
    def test_ingest_marks_hour_and_worker_builds_aggregates(
        self, world: World, client: TestClient
    ) -> None:
        send(client, world, FIRST)
        assert _sql("SELECT device_id, hour_start FROM aggregate_dirty") == [(world.device_a, HOUR)]
        assert _work() == 1
        assert _sql("SELECT count(*) FROM aggregate_dirty") == [(0,)]

        five = aggregates("5m")
        assert five == [
            (HOUR, 150.0, 100.0, 200.0, 200.0, 4, 2, 2 * INTERVAL_S / 300),
            (HOUR + timedelta(minutes=5), 400.0, 400.0, 400.0, 400.0, 1, 1, INTERVAL_S / 300),
        ]
        [hour] = aggregates("1h")
        assert hour[0] == HOUR
        assert hour[1] == pytest.approx(700 / 3)
        assert hour[5:] == (5, 3, 3 * INTERVAL_S / 3600)
        [day] = aggregates("1d")
        assert day[1] == pytest.approx(700 / 3)
        assert day[6] == 3
        assert 0 < day[7] < hour[7]  # doba dłuższa niż godzina — mniejsze pokrycie

    def test_late_data_recomputes_hour_and_day(self, world: World, client: TestClient) -> None:
        send(client, world, FIRST)
        _work()
        send(client, world, [reading(30, 1000.0)])  # spóźniona partia z bufora agenta
        assert _work() == 1
        [hour] = aggregates("1h")
        assert hour[1] == pytest.approx(1700 / 4)
        assert hour[4] == 1000.0  # ostatnia wartość
        [day] = aggregates("1d")
        assert day[1] == pytest.approx(1700 / 4)
        assert len(aggregates("5m")) == 3

    def test_recompute_is_idempotent(self, world: World, client: TestClient) -> None:
        send(client, world, FIRST)
        _work()
        before = _sql(
            "SELECT resolution, bucket_start, avg, coverage FROM aggregates ORDER BY 1, 2"
        )
        _sql(
            "INSERT INTO aggregate_dirty (device_id, hour_start) VALUES (:d, :h)",
            d=world.device_a,
            h=HOUR,
        )
        _work()
        after = _sql("SELECT resolution, bucket_start, avg, coverage FROM aggregates ORDER BY 1, 2")
        assert after == before

    def test_bucket_without_good_samples_has_null_values(
        self, world: World, client: TestClient
    ) -> None:
        send(client, world, [reading(0, None, "MISSING"), reading(1, 5.0, "INVALID")])
        _work()
        [five] = aggregates("5m")
        assert five[1:] == (None, None, None, None, 2, 0, 0.0)


class TestHistoryApi:
    @staticmethod
    def login(client: TestClient, email: str) -> None:
        resp = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
        assert resp.status_code == 200

    @staticmethod
    def url(site: uuid.UUID, device: uuid.UUID) -> str:
        return f"/api/sites/{site}/devices/{device}/history"

    def get(self, client: TestClient, world: World, **params: str) -> Any:  # noqa: ANN401
        query = {
            "metric": "pv_power",
            "from": HOUR.isoformat(),
            "to": (HOUR + H1).isoformat(),
        } | params
        return client.get(self.url(world.site_a, world.device_a), params=query)

    def test_requires_login(self, world: World, client: TestClient) -> None:
        assert self.get(client, world).status_code == 401

    def test_buckets_with_gaps_as_null(self, world: World, client: TestClient) -> None:
        send(client, world, FIRST)
        _work()
        self.login(client, "viewer@example.pl")  # VIEWER może czytać
        resp = self.get(client, world, resolution="5m")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert (body["unit"], body["resolution"], body["origins"]) == ("W", "5m", ["SIMULATED"])
        points = body["points"]
        assert len(points) == 12
        assert (points[0]["value"], points[0]["coverage"]) == (150.0, 0.4)
        assert (points[2]["value"], points[2]["coverage"]) == (None, 0.0)
        assert points[0]["t"].startswith(HOUR.strftime("%Y-%m-%dT%H:%M:%S"))

    def test_auto_picks_raw_for_short_range_and_hides_bad_values(
        self, world: World, client: TestClient
    ) -> None:
        send(client, world, FIRST)
        self.login(client, "owner@example.pl")
        body = self.get(client, world).json()
        assert body["resolution"] == "raw"
        assert [p["value"] for p in body["points"]] == [100.0, 200.0, None, None, 400.0]

    def test_auto_and_explicit_limits(self, world: World, client: TestClient) -> None:
        self.login(client, "owner@example.pl")
        month = {"from": (HOUR - timedelta(days=30)).isoformat(), "to": HOUR.isoformat()}
        auto = self.get(client, world, **month)
        assert auto.json()["resolution"] == "1h"
        assert len(auto.json()["points"]) == 720
        assert self.get(client, world, resolution="5m", **month).status_code == 422
        day = self.get(client, world, resolution="1d", **month).json()
        assert all(p["value"] is None and p["coverage"] == 0.0 for p in day["points"])

    def test_validation(self, world: World, client: TestClient) -> None:
        self.login(client, "owner@example.pl")
        assert self.get(client, world, metric="nieznana").status_code == 422
        assert self.get(client, world, channel="1").status_code == 422  # pv_power bez kanałów
        assert self.get(client, world, metric="pv_string_voltage").status_code == 422
        swapped = {"from": (HOUR + H1).isoformat(), "to": HOUR.isoformat()}
        assert self.get(client, world, **swapped).status_code == 422
        assert self.get(client, world, **{"from": "2026-01-01T00:00:00"}).status_code == 422

    def test_foreign_site_and_device_are_404(self, world: World, client: TestClient) -> None:
        self.login(client, "owner@example.pl")
        params = {"metric": "pv_power", "from": HOUR.isoformat(), "to": (HOUR + H1).isoformat()}
        foreign_site = client.get(self.url(world.site_b, world.device_b), params=params)
        assert foreign_site.status_code == 404
        mixed = client.get(self.url(world.site_a, world.device_b), params=params)
        assert mixed.status_code == 404


class TestExportCsv:
    """Eksport CSV historii urządzenia (D57)."""

    @staticmethod
    def url(site: uuid.UUID, device: uuid.UUID) -> str:
        return f"/api/sites/{site}/devices/{device}/export.csv"

    def get(self, client: TestClient, world: World, **params: str) -> Any:  # noqa: ANN401
        query = {"from": HOUR.isoformat(), "to": (HOUR + H1).isoformat()} | params
        return client.get(self.url(world.site_a, world.device_a), params=query)

    @staticmethod
    def rows(resp: Any) -> list[list[str]]:  # noqa: ANN401
        assert resp.content.startswith(b"\xef\xbb\xbf")  # UTF-8 z BOM dla Excela
        text_body = resp.content.decode("utf-8-sig")
        assert "\r\n" in text_body
        return [line.split(";") for line in text_body.removesuffix("\r\n").split("\r\n")]

    def test_requires_login(self, world: World, client: TestClient) -> None:
        assert self.get(client, world).status_code == 401

    def test_aggregates_all_profile_metrics_gaps_empty_and_audit(
        self, world: World, client: TestClient
    ) -> None:
        send(client, world, FIRST)
        _work()
        TestHistoryApi.login(client, "viewer@example.pl")  # VIEWER może eksportować
        resp = self.get(client, world, resolution="5m")
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/csv")
        disposition = resp.headers["content-disposition"]
        assert disposition.startswith('attachment; filename="historia_a1_falownik_')
        assert disposition.endswith('_5m_SIMULATED.csv"')
        header, *data = self.rows(resp)
        assert header[:5] == ["czas_utc", "czas_lokalny", "metryka", "kanał", "jednostka"]
        assert header[5:] == ["średnia", "min", "max", "ostatnia", "pokrycie", "pochodzenie"]
        metrics = {(r[2], r[3]) for r in data}
        assert ("pv_power", "") in metrics
        assert ("pv_string_voltage", "1") in metrics
        assert all(m != "battery_temperature" for m, _ in metrics)  # UNSUPPORTED pominięta
        assert len(data) == 12 * len(metrics)  # każdy przedział, także pusty
        pv = [r for r in data if r[2] == "pv_power"]
        assert pv[0][0] == HOUR.strftime("%Y-%m-%dT%H:%M:%SZ")
        assert pv[0][4:] == ["W", "150,0", "100,0", "200,0", "200,0", "0,4", "SIMULATED"]
        assert pv[2][5:] == ["", "", "", "", "0,0", "SIMULATED"]  # brak danych nigdy jako 0
        [(target,)] = _sql("SELECT target FROM audit_events WHERE action = 'DATA_EXPORTED'")
        assert str(target).startswith(f"device:{world.device_a};5m;")

    def test_raw_rows_with_quality(self, world: World, client: TestClient) -> None:
        send(client, world, FIRST)
        TestHistoryApi.login(client, "owner@example.pl")
        resp = self.get(client, world, resolution="raw")
        assert resp.status_code == 200, resp.text
        header, *data = self.rows(resp)
        assert header[5:] == ["wartość", "jakość", "pochodzenie"]
        assert [r[5:] for r in data] == [
            ["100,0", "GOOD", "SIMULATED"],
            ["200,0", "GOOD", "SIMULATED"],
            ["", "INVALID", "SIMULATED"],
            ["", "MISSING", "SIMULATED"],
            ["400,0", "GOOD", "SIMULATED"],
        ]

    def test_limits_and_validation(self, world: World, client: TestClient) -> None:
        TestHistoryApi.login(client, "owner@example.pl")
        eight_days = {"from": (HOUR - timedelta(days=8)).isoformat(), "to": HOUR.isoformat()}
        assert self.get(client, world, resolution="raw", **eight_days).status_code == 422
        year = {"from": (HOUR - timedelta(days=400)).isoformat(), "to": HOUR.isoformat()}
        assert self.get(client, world, resolution="5m", **year).status_code == 422  # > 500 000
        assert self.get(client, world, resolution="1d", **year).status_code == 200
        too_long = {"from": (HOUR - timedelta(days=401)).isoformat(), "to": HOUR.isoformat()}
        assert self.get(client, world, resolution="1d", **too_long).status_code == 422
        swapped = {"from": (HOUR + H1).isoformat(), "to": HOUR.isoformat()}
        assert self.get(client, world, **swapped).status_code == 422
        assert self.get(client, world, resolution="2h").status_code == 422
        assert _sql("SELECT count(*) FROM audit_events WHERE action = 'DATA_EXPORTED'") == [(1,)]

    def test_foreign_site_and_device_are_404(self, world: World, client: TestClient) -> None:
        TestHistoryApi.login(client, "owner@example.pl")
        params = {"from": HOUR.isoformat(), "to": (HOUR + H1).isoformat()}
        assert client.get(self.url(world.site_b, world.device_b), params=params).status_code == 404
        assert client.get(self.url(world.site_a, world.device_b), params=params).status_code == 404
