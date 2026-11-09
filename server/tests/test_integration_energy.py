"""Energia za okres i wskaźniki (D48): agregaty → API — PostgreSQL w CI."""

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
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from solargraf_server.aggregation import H1
from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.energy_api import compute_energy
from solargraf_server.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-energii"
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


DAY = datetime(2026, 6, 21, tzinfo=ZoneInfo("Europe/Warsaw")).astimezone(UTC)  # 20.06 22:00 UTC


def aggregate(world: World, metric: str, resolution: str, at: datetime, **values: object) -> None:
    row: dict[str, object] = {
        "avg": None,
        "min": None,
        "max": None,
        "last": None,
        "samples": 1,
        "good": 1,
        "cov": 1.0,
    }
    row |= values
    if row["avg"] is None:
        row["avg"] = row["last"]
    _sql(
        "INSERT INTO aggregates (site_id, device_id, metric, channel, resolution, bucket_start, "
        "avg, min, max, last, samples, good_samples, coverage) "
        "VALUES (:s, :d, :m, 0, :r, :t, :avg, :min, :max, :last, :samples, :good, :cov)",
        s=world.site_a,
        d=world.device_a,
        m=metric,
        r=resolution,
        t=at,
        **row,
    )


def login(client: TestClient, email: str = "owner@example.pl") -> None:
    resp = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200


def get(
    client: TestClient,
    world: World,
    start: datetime,
    end: datetime,
    device: uuid.UUID | None = None,
) -> Any:  # noqa: ANN401
    url = f"/api/sites/{world.site_a}/devices/{device or world.device_a}/energy"
    return client.get(url, params={"from": start.isoformat(), "to": end.isoformat()})


class TestEnergyApi:
    def test_counter_and_power_energy_with_gap_and_reset(
        self, world: World, client: TestClient
    ) -> None:
        # Licznik PV: 1000 → 1500 → (reset) 100 → 400 Wh; godzina przed zakresem daje punkt startu.
        for i, last in enumerate([1000.0, 1500.0, 100.0, 400.0]):
            aggregate(world, "pv_energy_total", "1h", DAY + (i - 1) * H1, last=last)
        # Zużycie: 12 przedziałów 5 min po 600 W w pierwszej godzinie = 600 Wh.
        for i in range(12):
            aggregate(world, "load_power", "5m", DAY + i * timedelta(minutes=5), avg=600.0, cov=1.0)
        login(client, "viewer@example.pl")  # VIEWER może czytać
        resp = get(client, world, DAY, DAY + 4 * H1)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert (body["bucket"], body["timezone"]) == ("1h", "Europe/Warsaw")
        series = {s["key"]: s for s in body["series"]}
        assert set(series) == {"pv", "load"}  # profil symulatora nie ma liczników sieci
        pv = series["pv"]
        assert (pv["source"], pv["total_wh"], pv["reset_detected"]) == ("COUNTER", 800.0, True)
        assert [b["wh"] for b in pv["buckets"]] == [500.0, None, 300.0, None]
        assert pv["coverage"] == 0.5
        load = series["load"]
        assert load["source"] == "POWER"
        assert load["total_wh"] == pytest.approx(600.0)
        assert load["buckets"][1]["wh"] is None  # brak danych to luka, nie zero
        kpis = body["kpis"]
        for kpi in kpis.values():
            assert (kpi["value"], kpi["status"]) == (None, "UNAVAILABLE")
            assert kpi["reason"] == "Urządzenie nie dostarcza wymaganych pomiarów."
        assert kpis["self_consumption"]["definition"].startswith("Autokonsumpcja")

    def test_days_in_local_time_across_dst(self, world: World, client: TestClient) -> None:
        start = datetime(2026, 10, 24, tzinfo=ZoneInfo("Europe/Warsaw")).astimezone(UTC)
        end = datetime(2026, 10, 27, tzinfo=ZoneInfo("Europe/Warsaw")).astimezone(UTC)
        login(client)
        body = get(client, world, start, end).json()
        assert body["bucket"] == "1d"
        [pv] = [s for s in body["series"] if s["key"] == "pv"]
        starts = [datetime.fromisoformat(b["t"]) for b in pv["buckets"]]
        assert [t.astimezone(ZoneInfo("Europe/Warsaw")).hour for t in starts] == [0, 0, 0]
        assert starts[1] - starts[0] == timedelta(hours=24)
        assert starts[2] - starts[1] == timedelta(hours=25)  # 25.10 — zmiana na czas zimowy
        assert all(b["wh"] is None and b["coverage"] == 0 for b in pv["buckets"])

    def test_access_and_validation(self, world: World, client: TestClient) -> None:
        assert get(client, world, DAY, DAY + H1).status_code == 401
        login(client)
        assert get(client, world, DAY + H1, DAY).status_code == 422
        assert get(client, world, DAY, DAY + timedelta(days=401)).status_code == 422
        assert get(client, world, DAY, DAY + H1, device=world.device_b).status_code == 404
        foreign = client.get(
            f"/api/sites/{world.site_b}/devices/{world.device_b}/energy",
            params={"from": DAY.isoformat(), "to": (DAY + H1).isoformat()},
        )
        assert foreign.status_code == 404


def site_get(client: TestClient, site: uuid.UUID, start: datetime, end: datetime) -> Any:  # noqa: ANN401
    return client.get(
        f"/api/sites/{site}/energy", params={"from": start.isoformat(), "to": end.isoformat()}
    )


class TestSiteEnergy:
    def test_single_source_series_and_unavailable_reasons(
        self, world: World, client: TestClient
    ) -> None:
        for i, last in enumerate([1000.0, 1500.0]):
            aggregate(world, "pv_energy_total", "1h", DAY + (i - 1) * H1, last=last)
        login(client, "viewer@example.pl")
        body = site_get(client, world.site_a, DAY, DAY + H1).json()
        series = {s["key"]: s for s in body["series"]}
        assert set(series) == {"pv", "load"}
        assert series["pv"]["device_id"] == str(world.device_a)
        assert series["pv"]["total_wh"] == 500.0
        assert series["load"]["total_wh"] is None  # brak agregatów mocy — brak danych, nie 0
        reasons = {u["key"]: (u["reason"], u["sources"]) for u in body["unavailable"]}
        assert reasons["grid_import"] == ("NOT_PROVIDED", 0)
        assert body["kpis"]["self_consumption"]["status"] == "UNAVAILABLE"
        assert body["origins"] == []

    def test_two_devices_with_same_metric_are_ambiguous_until_one_is_disabled(
        self, world: World, client: TestClient
    ) -> None:
        [(agent,)] = _sql("SELECT id FROM agents WHERE name = 'agent-a'")
        second = _device(world.site_a, agent)
        login(client)
        body = site_get(client, world.site_a, DAY, DAY + H1).json()
        assert body["series"] == []
        reasons = {u["key"]: (u["reason"], u["sources"]) for u in body["unavailable"]}
        assert reasons["pv"] == ("AMBIGUOUS", 2)
        assert reasons["load"] == ("AMBIGUOUS", 2)
        _sql("UPDATE devices SET enabled = false WHERE id = :d", d=second)
        body = site_get(client, world.site_a, DAY, DAY + H1).json()
        assert {s["key"] for s in body["series"]} == {"pv", "load"}

    def test_kpi_from_series_of_different_devices(self, world: World) -> None:
        # PV z falownika, eksport z drugiego urządzenia (np. licznika) — D51.
        [(agent,)] = _sql("SELECT id FROM agents WHERE name = 'agent-a'")
        meter = _device(world.site_a, agent)
        for i, last in enumerate([1000.0, 2000.0]):
            aggregate(world, "pv_energy_total", "1h", DAY + (i - 1) * H1, last=last)
        for i, last in enumerate([50.0, 450.0]):
            _sql(
                "INSERT INTO aggregates (site_id, device_id, metric, channel, resolution, "
                "bucket_start, avg, min, max, last, samples, good_samples, coverage) "
                "VALUES (:s, :d, 'grid_export_energy_total', 0, '1h', :t, :v, :v, :v, :v, 1, 1, 1)",
                s=world.site_a,
                d=meter,
                t=DAY + (i - 1) * H1,
                v=last,
            )

        async def go() -> Any:  # noqa: ANN401
            engine = create_engine(Settings())  # type: ignore[call-arg]
            try:
                async with create_sessionmaker(engine)() as db:
                    return await compute_energy(
                        db,
                        {"pv": world.device_a, "grid_export": meter},
                        DAY,
                        DAY + H1,
                        "Europe/Warsaw",
                    )
            finally:
                await engine.dispose()

        energy = asyncio.run(go())
        kpi = energy.kpis.self_consumption
        # (1000 - 400) / 1000 = 0,6
        assert (kpi.value, kpi.status) == (pytest.approx(0.6), "OK")

    def test_access_and_validation(self, world: World, client: TestClient) -> None:
        assert site_get(client, world.site_a, DAY, DAY + H1).status_code == 401
        login(client)
        assert site_get(client, world.site_a, DAY + H1, DAY).status_code == 422
        assert site_get(client, world.site_b, DAY, DAY + H1).status_code == 404


def report_get(client: TestClient, site: uuid.UUID, csv: bool = False, **params: int) -> Any:  # noqa: ANN401
    path = "energy.csv" if csv else "energy"
    return client.get(f"/api/sites/{site}/reports/{path}", params=params)


class TestEnergyReport:
    def test_month_report_in_local_days(self, world: World, client: TestClient) -> None:
        for i, last in enumerate([1000.0, 1500.0]):
            aggregate(world, "pv_energy_total", "1h", DAY + (i - 1) * H1, last=last)
        login(client)
        body = report_get(client, world.site_a, year=2026, month=6).json()
        assert (body["period"], body["year"], body["month"], body["bucket"]) == (
            "month",
            2026,
            6,
            "1d",
        )
        assert body["start"].startswith("2026-05-31T22:00:00")
        pv = next(s for s in body["series"] if s["key"] == "pv")
        assert len(pv["buckets"]) == 30
        assert pv["total_wh"] == 500.0
        year = report_get(client, world.site_a, year=2026).json()
        assert (year["period"], year["bucket"], year["month"]) == ("year", "1mo", None)

    def test_csv_with_audit(self, world: World, client: TestClient) -> None:
        for i, last in enumerate([1000.0, 1500.0]):
            aggregate(world, "pv_energy_total", "1h", DAY + (i - 1) * H1, last=last)
        login(client)
        resp = report_get(client, world.site_a, csv=True, year=2026, month=6)
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert 'filename="raport_a1_2026-06' in resp.headers["content-disposition"]
        assert resp.content.startswith("﻿".encode())
        text_body = resp.content.decode("utf-8-sig")
        assert "2026-06-21;0,5;" in text_body
        assert "2026-06-20;;" in text_body  # brak danych — puste pole, nie 0
        [(target,)] = _sql("SELECT target FROM audit_events WHERE action = 'DATA_EXPORTED'")
        assert str(target).startswith(f"report:{world.site_a};month;")

    def test_access_and_validation(self, world: World, client: TestClient) -> None:
        assert report_get(client, world.site_a, year=2026).status_code == 401
        login(client, "viewer@example.pl")
        assert report_get(client, world.site_a, year=2026).status_code == 403  # tylko OWNER/ADMIN
        assert report_get(client, world.site_a, csv=True, year=2026).status_code == 403
        login(client)
        assert report_get(client, world.site_b, year=2026).status_code == 404
        assert report_get(client, world.site_a, year=2026, month=13).status_code == 422
        assert report_get(client, world.site_a, year=2099).status_code == 422  # przyszły okres
