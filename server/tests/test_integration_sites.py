"""Izolacja danych między organizacjami i zawężenie członkostwa (D29, D33) — PostgreSQL w CI."""

import asyncio
import base64
import json
import os
import subprocess
import sys
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from solargraf_server import alarm_rules
from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.main import create_app
from solargraf_server.maintenance import Retention, apply_retention
from solargraf_server.models import Membership, MembershipSite, Organization, Role, Site, User
from solargraf_server.system.host import METRICS, HostSampler
from solargraf_server.system.monitor import MonitorTargets, run_monitor
from solargraf_server.updates.install import InstallDirs
from solargraf_server.updates.service import Fetch, run_scheduled

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-izolacji"
TABLES = (
    "update_status, system_alarms, system_metric_samples, system_components, system_status, "
    "alarms, aggregates, aggregate_dirty, measurements, polling_runs, agent_batches, devices, "
    "connections, agents, "
    "membership_sites, sites, audit_events, auth_sessions, setup_tokens, memberships, users, "
    "organizations"
)

type AsUser = Callable[[str], tuple[TestClient, str]]


@dataclass
class World:
    org_a: uuid.UUID
    org_b: uuid.UUID
    a1: uuid.UUID
    a2: uuid.UUID
    b1: uuid.UUID
    scoped_viewer_membership: uuid.UUID
    owner_a_membership: uuid.UUID


def _sql(statement: str, **params: object) -> list[tuple[object, ...]]:
    async def go() -> list[tuple[object, ...]]:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(statement), params)
                return [tuple(r) for r in result] if result.returns_rows else []
        finally:
            await engine.dispose()

    return asyncio.run(go())


async def _build() -> World:
    engine = create_engine(Settings())  # type: ignore[call-arg]
    pw = hash_password(PASSWORD)
    try:
        async with create_sessionmaker(engine)() as db:
            org_a, org_b = Organization(name="Org A"), Organization(name="Org B")
            db.add_all([org_a, org_b])
            await db.flush()
            a1 = Site(organization_id=org_a.id, name="A1", timezone="Europe/Warsaw")
            a2 = Site(organization_id=org_a.id, name="A2", timezone="Europe/Warsaw")
            b1 = Site(organization_id=org_b.id, name="B1", timezone="Europe/Warsaw")
            db.add_all([a1, a2, b1])
            users = {
                name: User(
                    email=f"{name}@example.pl",
                    display_name=name,
                    password_hash=pw,
                    is_active=True,
                    failed_login_count=0,
                )
                for name in ("owner_a", "admin_a", "scoped_admin_a", "scoped_viewer_a", "owner_b")
            }
            db.add_all(users.values())
            await db.flush()

            def member(
                user: str, org: Organization, role: Role, all_sites: bool = True
            ) -> Membership:
                m = Membership(
                    user_id=users[user].id,
                    organization_id=org.id,
                    role=role.value,
                    all_sites=all_sites,
                )
                db.add(m)
                return m

            owner_a = member("owner_a", org_a, Role.OWNER)
            member("admin_a", org_a, Role.ADMIN)
            scoped_admin = member("scoped_admin_a", org_a, Role.ADMIN, all_sites=False)
            scoped_viewer = member("scoped_viewer_a", org_a, Role.VIEWER, all_sites=False)
            member("owner_b", org_b, Role.OWNER)
            await db.flush()
            db.add_all(
                [
                    MembershipSite(membership_id=scoped_admin.id, site_id=a1.id),
                    MembershipSite(membership_id=scoped_viewer.id, site_id=a1.id),
                ]
            )
            await db.commit()
            return World(org_a.id, org_b.id, a1.id, a2.id, b1.id, scoped_viewer.id, owner_a.id)
    finally:
        await engine.dispose()


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


@pytest.fixture
def world() -> World:
    _sql(f"TRUNCATE {TABLES} CASCADE")
    return asyncio.run(_build())


@pytest.fixture
def as_user() -> Iterator[AsUser]:
    clients: list[TestClient] = []

    def make(name: str) -> tuple[TestClient, str]:
        c = TestClient(create_app(Settings()), base_url="https://testserver")  # type: ignore[call-arg]
        c.__enter__()
        clients.append(c)
        resp = c.post("/api/auth/login", json={"email": f"{name}@example.pl", "password": PASSWORD})
        assert resp.status_code == 200, resp.text
        return c, str(resp.json()["csrf_token"])

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def names(resp_json: list[dict[str, object]]) -> list[object]:
    return [s["name"] for s in resp_json]


class TestReadIsolation:
    def test_owner_sees_only_own_organization(self, world: World, as_user: AsUser) -> None:
        c, _ = as_user("owner_a")
        assert names(c.get("/api/sites").json()) == ["A1", "A2"]
        c, _ = as_user("owner_b")
        assert names(c.get("/api/sites").json()) == ["B1"]

    def test_foreign_and_missing_site_are_indistinguishable(
        self, world: World, as_user: AsUser
    ) -> None:
        c, _ = as_user("owner_b")
        foreign = c.get(f"/api/sites/{world.a1}")
        missing = c.get(f"/api/sites/{uuid.uuid4()}")
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()

    def test_scoped_viewer_sees_only_assigned_site(self, world: World, as_user: AsUser) -> None:
        c, _ = as_user("scoped_viewer_a")
        assert names(c.get("/api/sites").json()) == ["A1"]
        assert c.get(f"/api/sites/{world.a1}").json()["role"] == "VIEWER"
        assert c.get(f"/api/sites/{world.a2}").status_code == 404
        assert c.get(f"/api/sites/{world.b1}").status_code == 404

    def test_removing_last_assignment_does_not_grant_full_access(
        self, world: World, as_user: AsUser
    ) -> None:
        _sql(
            "DELETE FROM membership_sites WHERE membership_id = :m",
            m=world.scoped_viewer_membership,
        )
        c, _ = as_user("scoped_viewer_a")
        assert c.get("/api/sites").json() == []

    def test_owner_is_never_scoped(self, world: World, as_user: AsUser) -> None:
        _sql("UPDATE memberships SET all_sites = false WHERE id = :m", m=world.owner_a_membership)
        c, _ = as_user("owner_a")
        assert names(c.get("/api/sites").json()) == ["A1", "A2"]

    def test_requires_login(self, world: World) -> None:
        with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
            assert c.get("/api/sites").status_code == 401
            assert c.get(f"/api/sites/{world.a1}").status_code == 401


class TestCreate:
    def body(self, org: uuid.UUID, **extra: str) -> dict[str, str]:
        return {"organization_id": str(org), "name": "Nowa", **extra}

    def test_admin_creates_site_with_default_timezone_and_audit(
        self, world: World, as_user: AsUser
    ) -> None:
        c, csrf = as_user("admin_a")
        resp = c.post("/api/sites", json=self.body(world.org_a), headers={"X-CSRF-Token": csrf})
        assert resp.status_code == 201, resp.text
        assert resp.json()["timezone"] == "Europe/Warsaw"
        assert ("SITE_CREATED",) in _sql("SELECT action FROM audit_events")
        # Zawężony podgląd nie widzi nowej instalacji bez przypisania.
        v, _ = as_user("scoped_viewer_a")
        assert names(v.get("/api/sites").json()) == ["A1"]

    def test_foreign_organization_is_404(self, world: World, as_user: AsUser) -> None:
        c, csrf = as_user("owner_b")
        resp = c.post("/api/sites", json=self.body(world.org_a), headers={"X-CSRF-Token": csrf})
        assert resp.status_code == 404
        assert _sql("SELECT count(*) FROM sites WHERE organization_id = :o", o=world.org_a) == [
            (2,)
        ]

    def test_viewer_and_scoped_admin_cannot_create(self, world: World, as_user: AsUser) -> None:
        for user in ("scoped_viewer_a", "scoped_admin_a"):
            c, csrf = as_user(user)
            resp = c.post("/api/sites", json=self.body(world.org_a), headers={"X-CSRF-Token": csrf})
            assert resp.status_code == 403, user

    def test_requires_csrf_and_valid_timezone(self, world: World, as_user: AsUser) -> None:
        c, csrf = as_user("owner_a")
        assert c.post("/api/sites", json=self.body(world.org_a)).status_code == 403
        bad_tz = self.body(world.org_a, timezone="Mars/Olympus")
        assert c.post("/api/sites", json=bad_tz, headers={"X-CSRF-Token": csrf}).status_code == 422


def _seed_devices(world: World) -> None:
    """Agent z świeżym heartbeatem, po jednym połączeniu i urządzeniu w A1 i B1."""
    agent = uuid.uuid4()
    _sql(
        "INSERT INTO agents (id, name, mode, token_hash, enabled, last_heartbeat_at) "
        "VALUES (:id, 'agent', 'LOCAL', :h, true, now())",
        id=agent,
        h="0" * 64,
    )
    for site, name in ((world.a1, "Falownik A1"), (world.b1, "Falownik B1")):
        conn = uuid.uuid4()
        _sql(
            "INSERT INTO connections (id, site_id, agent_id, name, transport, host, port, unit_id) "
            "VALUES (:id, :site, :agent, 'Logger', 'MODBUS_TCP', 'logger.lan', 502, 1)",
            id=conn,
            site=site,
            agent=agent,
        )
        _sql(
            "INSERT INTO devices (id, site_id, connection_id, name, kind, serial_number, "
            "enabled, last_attempt_at, last_success_at, freshness_threshold_seconds) "
            "VALUES (:id, :site, :conn, :name, 'INVERTER', 'SN-TEST', true, now(), now(), 300)",
            id=uuid.uuid4(),
            site=site,
            conn=conn,
            name=name,
        )


class TestDevices:
    def test_owner_sees_own_devices_with_details(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        c, _ = as_user("owner_a")
        resp = c.get(f"/api/sites/{world.a1}/devices")
        assert resp.status_code == 200, resp.text
        [device] = resp.json()
        assert device["name"] == "Falownik A1"
        assert device["status"] == "OK"
        assert device["details"]["serial_number"] == "SN-TEST"
        assert device["details"]["connection"]["port"] == 502

    def test_viewer_sees_devices_without_details(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        c, _ = as_user("scoped_viewer_a")
        [device] = c.get(f"/api/sites/{world.a1}/devices").json()
        assert device["details"] is None
        assert "SN-TEST" not in c.get(f"/api/sites/{world.a1}/devices").text

    def test_foreign_scoped_and_missing_sites_are_404(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        c, _ = as_user("owner_b")
        foreign = c.get(f"/api/sites/{world.a1}/devices")
        missing = c.get(f"/api/sites/{uuid.uuid4()}/devices")
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()
        v, _ = as_user("scoped_viewer_a")
        assert v.get(f"/api/sites/{world.a2}/devices").status_code == 404

    def test_lost_agent_gives_unknown(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        _sql("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour'")
        c, _ = as_user("owner_a")
        [device] = c.get(f"/api/sites/{world.a1}/devices").json()
        assert device["status"] == "UNKNOWN"

    def test_requires_login(self, world: World) -> None:
        with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
            assert c.get(f"/api/sites/{world.a1}/devices").status_code == 401
            assert c.get(f"/api/sites/{world.a1}/agents").status_code == 401

    def test_site_agents_status_and_version_by_role(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        _sql("UPDATE agents SET version = '0.1.0'")
        c, _ = as_user("owner_a")
        [agent] = c.get(f"/api/sites/{world.a1}/agents").json()
        assert (agent["name"], agent["status"], agent["version"]) == ("agent", "ONLINE", "0.1.0")
        [device] = c.get(f"/api/sites/{world.a1}/devices").json()
        assert device["agent_id"] == agent["id"]
        v, _ = as_user("scoped_viewer_a")
        [seen] = v.get(f"/api/sites/{world.a1}/agents").json()
        assert seen["version"] is None  # wersja tylko dla OWNER/ADMIN
        assert "token" not in str(seen)
        _sql("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour'")
        [late] = c.get(f"/api/sites/{world.a1}/agents").json()
        assert late["status"] == "UNREACHABLE"
        _sql("UPDATE agents SET enabled = false")
        [off] = c.get(f"/api/sites/{world.a1}/agents").json()
        assert off["status"] == "DISABLED"

    def test_site_agents_hide_foreign_sites(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        c, _ = as_user("owner_b")
        assert c.get(f"/api/sites/{world.a1}/agents").status_code == 404
        _sql("UPDATE connections SET agent_id = NULL")
        own, _ = as_user("owner_a")
        assert own.get(f"/api/sites/{world.a1}/agents").json() == []
        [device] = own.get(f"/api/sites/{world.a1}/devices").json()
        assert (device["agent_id"], device["status"]) == (None, "UNKNOWN")

    def test_device_cannot_use_connection_of_another_site(self, world: World) -> None:
        _seed_devices(world)
        [(conn_b,)] = _sql("SELECT id FROM connections WHERE site_id = :s", s=world.b1)
        with pytest.raises(IntegrityError, match="fk_devices_connection_site_connections"):
            _sql(
                "INSERT INTO devices (id, site_id, connection_id, name, kind, enabled, "
                "freshness_threshold_seconds) "
                "VALUES (:id, :site, :conn, 'X', 'METER', true, 300)",
                id=uuid.uuid4(),
                site=world.a1,
                conn=conn_b,
            )


def _local_agent() -> uuid.UUID:
    agent = uuid.uuid4()
    _sql(
        "INSERT INTO agents (id, name, mode, token_hash, enabled, last_heartbeat_at) "
        "VALUES (:id, 'lokalny', 'LOCAL', :h, true, now())",
        id=agent,
        h="1" * 64,
    )
    return agent


NEW_DEVICE = {
    "name": "Falownik (symulator)",
    "profile_id": "simulated.hybrid-inverter",
    "profile_version": "0.1.0",
}
SETTINGS: dict[str, object] = {"name": "Logger w garażu", "host": "192.168.1.50"}
NEW_CONNECTION: dict[str, object] = SETTINGS | {"device": NEW_DEVICE}


def _headers(csrf: str) -> dict[str, str]:
    return {"X-CSRF-Token": csrf}


class TestDeviceWrites:
    def test_admin_creates_connection_with_device_visible_to_agent(
        self, world: World, as_user: AsUser
    ) -> None:
        agent = _local_agent()
        c, csrf = as_user("admin_a")
        resp = c.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf)
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["connection"]["port"] == 502
        assert body["connection"]["unit_id"] == 1
        device = body["device"]
        assert device["kind"] == "INVERTER"
        assert device["status"] == "UNKNOWN"  # jeszcze nieodczytane
        assert device["details"]["profile_id"] == "simulated.hybrid-inverter"
        [(conn_agent,)] = _sql(
            "SELECT agent_id FROM connections WHERE id = :c", c=uuid.UUID(body["connection"]["id"])
        )
        assert conn_agent == agent
        # Próg świeżości: max(300 s, 3 * interwał z profilu = 10 s).
        [(threshold,)] = _sql(
            "SELECT freshness_threshold_seconds FROM devices WHERE id = :d",
            d=uuid.UUID(device["id"]),
        )
        assert threshold == 300
        actions = {r[0] for r in _sql("SELECT action FROM audit_events")}
        assert {"CONNECTION_CREATED", "DEVICE_CREATED"} <= actions
        listed = c.get(f"/api/sites/{world.a1}/devices").json()
        assert [d["id"] for d in listed] == [device["id"]]
        # Metryki z profilu (D47) — także dla VIEWER, bez szczegółów technicznych.
        viewer, _ = as_user("scoped_viewer_a")
        [seen] = viewer.get(f"/api/sites/{world.a1}/devices").json()
        assert seen["details"] is None
        assert {
            "key": "pv_power",
            "channel": None,
            "name": "Moc PV",
            "unit": "W",
            "cumulative": False,
        } in seen["metrics"]
        # Poziom wsparcia profilu (D58) — także dla VIEWER; symulator jest EXPERIMENTAL.
        assert seen["support_level"] == "EXPERIMENTAL"

    def test_viewer_forbidden_foreign_and_missing_404(self, world: World, as_user: AsUser) -> None:
        _local_agent()
        v, csrf = as_user("scoped_viewer_a")
        resp = v.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf)
        )
        assert resp.status_code == 403
        b, csrf_b = as_user("owner_b")
        foreign = b.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf_b)
        )
        missing = b.post(
            f"/api/sites/{uuid.uuid4()}/connections", json=NEW_CONNECTION, headers=_headers(csrf_b)
        )
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()
        no_csrf = b.post(f"/api/sites/{world.b1}/connections", json=NEW_CONNECTION)
        assert no_csrf.status_code == 403
        assert _sql("SELECT count(*) FROM connections") == [(0,)]

    @pytest.mark.parametrize(
        ("change", "fragment"),
        [
            ({"host": "8.8.8.8"}, "prywatne"),
            ({"host": "127.0.0.1"}, "prywatne"),
            ({"host": "169.254.169.254"}, "prywatne"),
            ({"host": "localhost"}, "lokalny"),
            ({"transport": "MODBUS_RTU"}, "MODBUS_TCP"),
            ({"poll_interval_seconds": 5, "timeout_seconds": 5}, "krótszy"),
        ],
    )
    def test_invalid_connection_rejected(
        self, world: World, as_user: AsUser, change: dict[str, object], fragment: str
    ) -> None:
        _local_agent()
        c, csrf = as_user("owner_a")
        resp = c.post(
            f"/api/sites/{world.a1}/connections",
            json=NEW_CONNECTION | change,
            headers=_headers(csrf),
        )
        assert resp.status_code == 422, resp.text
        assert fragment in resp.text

    def test_unknown_profile_and_missing_agent(self, world: World, as_user: AsUser) -> None:
        c, csrf = as_user("owner_a")
        no_agent = c.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf)
        )
        assert no_agent.status_code == 409
        _local_agent()
        unknown = SETTINGS | {
            "device": {"name": "X", "profile_id": "vendor.unknown", "profile_version": "1.0.0"}
        }
        resp = c.post(f"/api/sites/{world.a1}/connections", json=unknown, headers=_headers(csrf))
        assert resp.status_code == 422
        assert "Nieznany profil" in resp.text

    def test_update_disable_and_delete(self, world: World, as_user: AsUser) -> None:
        _local_agent()
        c, csrf = as_user("owner_a")
        created = c.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf)
        ).json()
        conn_id, dev_id = created["connection"]["id"], created["device"]["id"]

        second = c.post(
            f"/api/sites/{world.a1}/connections/{conn_id}/devices",
            json=NEW_DEVICE | {"name": "Drugi"},
            headers=_headers(csrf),
        )
        assert second.status_code == 201, second.text
        second_id = second.json()["id"]

        upd = c.patch(
            f"/api/sites/{world.a1}/connections/{conn_id}",
            json=SETTINGS | {"host": "inverter.lan", "poll_interval_seconds": 600},
            headers=_headers(csrf),
        )
        assert upd.status_code == 200, upd.text
        assert upd.json()["host"] == "inverter.lan"
        thresholds = {r[0] for r in _sql("SELECT freshness_threshold_seconds FROM devices")}
        assert thresholds == {1800}

        off = c.patch(
            f"/api/sites/{world.a1}/devices/{dev_id}",
            json={"enabled": False},
            headers=_headers(csrf),
        )
        assert off.status_code == 200, off.text
        assert off.json()["status"] == "DISABLED"

        # Urządzenie z danymi: tylko wyłączenie.
        _sql(
            "INSERT INTO polling_runs (id, site_id, device_id, batch_id, started_at, finished_at, "
            "result, ok_points, failed_points) "
            "VALUES (:id, :s, :d, :b, now(), now(), 'OK', 1, 0)",
            id=uuid.uuid4(),
            s=world.a1,
            d=uuid.UUID(dev_id),
            b=uuid.uuid4(),
        )
        busy = c.delete(f"/api/sites/{world.a1}/devices/{dev_id}", headers=_headers(csrf))
        assert busy.status_code == 409
        assert "wyłącz" in busy.text

        gone = c.delete(f"/api/sites/{world.a1}/devices/{second_id}", headers=_headers(csrf))
        assert gone.status_code == 204
        assert _sql("SELECT count(*) FROM connections") == [(1,)]

        _sql("DELETE FROM polling_runs")
        last = c.delete(f"/api/sites/{world.a1}/devices/{dev_id}", headers=_headers(csrf))
        assert last.status_code == 204
        # Ostatnie urządzenie zabiera puste połączenie.
        assert _sql("SELECT count(*) FROM connections") == [(0,)]
        actions = {r[0] for r in _sql("SELECT action FROM audit_events")}
        assert {"CONNECTION_UPDATED", "DEVICE_UPDATED", "DEVICE_DELETED"} <= actions
        assert "CONNECTION_DELETED" in actions

    def test_cannot_touch_other_sites_resources(self, world: World, as_user: AsUser) -> None:
        _local_agent()
        a, csrf_a = as_user("owner_a")
        created = a.post(
            f"/api/sites/{world.a1}/connections", json=NEW_CONNECTION, headers=_headers(csrf_a)
        ).json()
        dev_id, conn_id = created["device"]["id"], created["connection"]["id"]
        # Urządzenie z A1 pod adresem A2 (ten sam właściciel) — nie istnieje.
        moved = a.patch(
            f"/api/sites/{world.a2}/devices/{dev_id}",
            json={"enabled": False},
            headers=_headers(csrf_a),
        )
        assert moved.status_code == 404
        add_to_foreign = a.post(
            f"/api/sites/{world.a2}/connections/{conn_id}/devices",
            json=NEW_DEVICE,
            headers=_headers(csrf_a),
        )
        assert add_to_foreign.status_code == 404
        b, csrf_b = as_user("owner_b")
        foreign = b.delete(f"/api/sites/{world.b1}/devices/{dev_id}", headers=_headers(csrf_b))
        assert foreign.status_code == 404

    def test_profiles_catalog(self, world: World, as_user: AsUser) -> None:
        v, _ = as_user("scoped_viewer_a")
        resp = v.get("/api/profiles")
        assert resp.status_code == 200
        profiles = {p["id"]: p for p in resp.json()}
        assert set(profiles) == {
            "simulated.hybrid-inverter",
            "sunspec.pv-inverter-3ph",
            "sunspec.grid-meter-3ph",
        }
        assert profiles["simulated.hybrid-inverter"]["origin"] == "SIMULATED"
        assert profiles["sunspec.grid-meter-3ph"]["origin"] == "DEVICE"
        assert profiles["sunspec.grid-meter-3ph"]["support_level"] == "COMMUNITY"
        assert all("points" not in p for p in profiles.values())


# --- alarmy (D55) ---


def _evaluate_alarms() -> tuple[int, int]:
    async def go() -> tuple[int, int]:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                changes = await alarm_rules.evaluate(db, datetime.now(UTC))
                return changes.opened, changes.closed
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _retention(now: datetime) -> dict[str, int]:
    async def go() -> dict[str, int]:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                policy = Retention(raw_days=90, m5_days=730, runs_days=90, months_ahead=2)
                return (await apply_retention(db, now, policy)).deleted
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _stale(world: World) -> None:
    _sql(
        "UPDATE devices SET last_attempt_at = now() - interval '1 hour', "
        "last_success_at = now() - interval '1 hour' WHERE site_id = :s",
        s=world.a1,
    )


class TestAlarms:
    def test_stale_device_opens_alarm_visible_only_in_its_site(
        self, world: World, as_user: AsUser
    ) -> None:
        _seed_devices(world)
        assert _evaluate_alarms() == (0, 0)
        _stale(world)
        assert _evaluate_alarms() == (1, 0)
        assert _evaluate_alarms() == (0, 0)  # kolejne wykrycie tylko odświeża
        c, _ = as_user("owner_a")
        body = c.get(f"/api/sites/{world.a1}/alarms").json()
        assert body["can_acknowledge"] is True
        [alarm] = body["alarms"]
        assert (alarm["code"], alarm["severity"], alarm["title"]) == (
            "DEVICE_STALE",
            "WARNING",
            "Dane nieaktualne: Falownik A1",
        )
        assert alarm["closed_at"] is None
        assert alarm["last_ok_at"] is not None  # czas ostatniego odczytu jako pole, nie tekst
        assert alarm["acknowledged_at"] is None
        assert "logger.lan" not in str(body)  # bez adresów urządzeń
        v, _ = as_user("scoped_viewer_a")
        seen = v.get(f"/api/sites/{world.a1}/alarms").json()
        assert (len(seen["alarms"]), seen["can_acknowledge"]) == (1, False)
        b, _ = as_user("owner_b")
        assert b.get(f"/api/sites/{world.a1}/alarms").status_code == 404
        assert b.get(f"/api/sites/{world.b1}/alarms").json()["alarms"] == []

    def test_acknowledge_by_role_with_csrf_and_audit(self, world: World, as_user: AsUser) -> None:
        _seed_devices(world)
        _stale(world)
        _evaluate_alarms()
        [(alarm_id,)] = _sql("SELECT id FROM alarms")
        url = f"/api/sites/{world.a1}/alarms/{alarm_id}/acknowledge"
        v, v_csrf = as_user("scoped_viewer_a")
        assert v.post(url, headers=_headers(v_csrf)).status_code == 403
        o, o_csrf = as_user("owner_a")
        assert o.post(url).status_code == 403  # bez CSRF
        resp = o.post(url, headers=_headers(o_csrf))
        assert resp.status_code == 200, resp.text
        assert resp.json()["acknowledged_by"] == "owner_a"
        assert resp.json()["closed_at"] is None  # potwierdzenie nie zamyka
        a, a_csrf = as_user("admin_a")
        again = a.post(url, headers=_headers(a_csrf)).json()
        assert (again["acknowledged_by"], again["acknowledged_at"]) == (
            "owner_a",
            resp.json()["acknowledged_at"],
        )
        assert _sql("SELECT count(*) FROM audit_events WHERE action = 'ALARM_ACKNOWLEDGED'") == [
            (1,)
        ]
        b, b_csrf = as_user("owner_b")
        foreign = b.post(url, headers=_headers(b_csrf))
        other_site = o.post(
            f"/api/sites/{world.a2}/alarms/{alarm_id}/acknowledge", headers=_headers(o_csrf)
        )
        assert foreign.status_code == other_site.status_code == 404

    def test_alarm_closes_after_two_clear_checks_and_stays_listed(
        self, world: World, as_user: AsUser
    ) -> None:
        _seed_devices(world)
        _stale(world)
        _evaluate_alarms()
        _sql("UPDATE devices SET last_attempt_at = now(), last_success_at = now()")
        assert _evaluate_alarms() == (0, 0)  # histereza: jeszcze otwarty
        assert _evaluate_alarms() == (0, 1)
        c, _ = as_user("owner_a")
        [alarm] = c.get(f"/api/sites/{world.a1}/alarms").json()["alarms"]
        assert alarm["closed_at"] is not None
        _stale(world)
        assert _evaluate_alarms() == (1, 0)  # nowy alarm, zamknięty zostaje w historii
        listed = c.get(f"/api/sites/{world.a1}/alarms").json()["alarms"]
        assert [a["closed_at"] is None for a in listed] == [True, False]  # otwarte najpierw

    def test_unreachable_agent_replaces_device_alarms_per_site(
        self, world: World, as_user: AsUser
    ) -> None:
        _seed_devices(world)
        _stale(world)
        _sql("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour'")
        assert _evaluate_alarms() == (2, 0)  # po jednym w A1 i B1, bez alarmów urządzeń
        c, _ = as_user("owner_a")
        [alarm] = c.get(f"/api/sites/{world.a1}/alarms").json()["alarms"]
        assert (alarm["code"], alarm["severity"], alarm["device_id"]) == (
            "AGENT_UNREACHABLE",
            "CRITICAL",
            None,
        )

    def test_retention_removes_only_old_closed_alarms(self, world: World) -> None:
        _seed_devices(world)
        for days in (400, 10, None):
            _sql(
                "INSERT INTO alarms (id, site_id, subject, code, severity, title, rule_version, "
                "opened_at, last_seen_at, closed_at, clear_count) VALUES (:id, :s, :subj, "
                "'DEVICE_STALE', 'WARNING', 't', 1, now() - interval '500 days', "
                "now() - interval '500 days', now() - make_interval(days => :d), 0)",
                id=uuid.uuid4(),
                s=world.a1,
                subj=f"device:{uuid.uuid4()}",
                d=days,
            )
        assert _retention(datetime.now(UTC))["alarms"] == 1
        assert _sql("SELECT count(*) FROM alarms") == [(2,)]

    def test_requires_login(self, world: World) -> None:
        with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
            assert c.get(f"/api/sites/{world.a1}/alarms").status_code == 401


# --- monitor serwera (D60) ---


def _fake_host(root: Path) -> HostSampler:
    """Host testowy bez czujników; wartości nie pochodzą z prawdziwego hosta."""
    proc = root / "proc"
    proc.mkdir()
    (proc / "stat").write_text("cpu  100 0 100 700 100 0 0 0 0 0\n", encoding="ascii")
    (proc / "meminfo").write_text(
        "MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
        encoding="ascii",
    )
    return HostSampler(proc, root / "sys", root)


def _monitor(sampler: HostSampler) -> None:
    async def go() -> None:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                await run_monitor(db, sampler, MonitorTargets(), datetime.now(UTC))
        finally:
            await engine.dispose()

    asyncio.run(go())


class TestSystemMonitor:
    def test_owner_sees_health_others_do_not(
        self, world: World, as_user: AsUser, tmp_path: Path
    ) -> None:
        owner, _ = as_user("owner_a")
        assert owner.get("/api/system/health").json()["level"] == "UNKNOWN"
        _monitor(_fake_host(tmp_path))
        body = owner.get("/api/system/health").json()
        assert (body["level"], body["stale"], body["reasons"]) == ("STABLE", False, [])
        assert body["metrics"]["mem_used_bytes"] == 2_000_000 * 1024
        assert body["percent"]["memory"] == 25.0
        assert body["metrics"]["cpu_temp_c"] is None  # brak czujnika — niedostępne, nie 0
        assert body["metrics"]["db_size_bytes"] > 0
        states = {c["component"]: c["state"] for c in body["components"]}
        assert states == {
            "api": "UNKNOWN",  # niemonitorowany bez adresu
            "worker": "UP",
            "agent": "UNKNOWN",  # brak włączonego agenta lokalnego
            "proxy": "UNKNOWN",
            "db": "UP",
        }
        for user in ("admin_a", "scoped_viewer_a"):
            c, _ = as_user(user)
            assert c.get("/api/system/health").status_code == 403
        with TestClient(create_app(Settings())) as anonymous:  # type: ignore[call-arg]
            assert anonymous.get("/api/system/health").status_code == 401

    def test_stale_evaluation_means_worker_down(
        self, world: World, as_user: AsUser, tmp_path: Path
    ) -> None:
        _monitor(_fake_host(tmp_path))
        _sql("UPDATE system_status SET evaluated_at = now() - interval '10 minutes'")
        owner, _ = as_user("owner_a")
        body = owner.get("/api/system/health").json()
        assert (body["level"], body["stale"]) == ("CRITICAL", True)
        assert body["reasons"][0]["code"] == "COMPONENT_DOWN:worker"
        worker = next(c for c in body["components"] if c["component"] == "worker")
        assert worker["state"] == "DOWN"

    def test_history_buckets_percent_and_gaps(self, world: World, as_user: AsUser) -> None:
        # Dwie próbki w jednym przedziale 5 min; temperatura niedostępna (NULL).
        gib = 1024**3
        for minutes, cpu, mem_used in ((7, 10.0, 2 * gib), (8, 30.0, 4 * gib)):
            for metric, value in (
                ("cpu_percent", cpu),
                ("mem_used_bytes", mem_used),
                ("mem_total_bytes", 8 * gib),
                ("cpu_temp_c", None),
            ):
                _sql(
                    "INSERT INTO system_metric_samples (sampled_at, metric, value) VALUES "
                    "(date_bin('5 minutes', now(), TIMESTAMPTZ '1970-01-01Z') "
                    "- make_interval(mins => 10) + make_interval(secs => :s), :m, :v)",
                    s=minutes * 30,
                    m=metric,
                    v=value,
                )
        owner, _ = as_user("owner_a")
        body = owner.get("/api/system/metrics?range=24h").json()
        assert (body["range"], body["step_s"]) == ("24h", 300)
        cpu_points = [p for p in body["series"]["cpu_percent"]["points"] if p["avg"] is not None]
        assert [(p["avg"], p["max"]) for p in cpu_points] == [(20.0, 30.0)]
        memory = [p for p in body["series"]["memory_percent"]["points"] if p["avg"] is not None]
        assert [(p["avg"], p["max"]) for p in memory] == [(37.5, 50.0)]
        temps = body["series"]["cpu_temp_c"]["points"]
        assert len(temps) >= 288
        assert all(p["avg"] is None for p in temps)  # luki, nie 0
        assert body["series"]["disk_percent"]["unit"] == "%"
        assert body["disk_forecast"]["status"] == "INSUFFICIENT_DATA"
        assert owner.get("/api/system/metrics?range=1y").status_code == 422
        admin, _ = as_user("admin_a")
        assert admin.get("/api/system/metrics").status_code == 403

    def test_disk_forecast_from_hourly_trend(self, world: World, as_user: AsUser) -> None:
        # 4 dni, +1 GiB/dobę od 50 GiB, dysk 100 GiB → ok. 46 dni do zapełnienia.
        _sql(
            "INSERT INTO system_metric_samples (sampled_at, metric, value) "
            "SELECT now() - make_interval(hours => h), 'disk_used_bytes', "
            "(54 - h / 24.0) * 1073741824 FROM generate_series(0, 96) AS h"
        )
        _sql(
            "INSERT INTO system_metric_samples (sampled_at, metric, value) "
            "VALUES (now(), 'disk_total_bytes', 100 * 1073741824.0)"
        )
        owner, _ = as_user("owner_a")
        forecast = owner.get("/api/system/metrics?range=7d").json()["disk_forecast"]
        assert forecast["status"] == "OK"
        assert forecast["growth_bytes_per_day"] == pytest.approx(1024**3, rel=0.01)
        days = (datetime.fromisoformat(forecast["full_at"]) - datetime.now(UTC)).days
        assert 44 <= days <= 46

    def test_old_samples_are_removed_by_retention(self, world: World, tmp_path: Path) -> None:
        _monitor(_fake_host(tmp_path))
        _sql(
            "INSERT INTO system_metric_samples (sampled_at, metric, value) "
            "VALUES (now() - interval '40 days', 'cpu_percent', 5)"
        )
        deleted = _retention(datetime.now(UTC))
        assert deleted["system_metric_samples"] == 1
        [(count,)] = _sql("SELECT count(*) FROM system_metric_samples")
        assert count == len(METRICS)  # bieżąca próbka zostaje


# --- alarmy systemowe (P7.1d, D68) ---


class _MemorySampler(HostSampler):
    """Host testowy z zadaną zajętością RAM (%); inne metryki niedostępne (None)."""

    def __init__(self) -> None:
        super().__init__()
        self.memory_percent: float | None = 50.0

    def sample(self) -> dict[str, float | None]:
        values: dict[str, float | None] = dict.fromkeys(METRICS)
        if self.memory_percent is not None:
            values["mem_total_bytes"] = 1000.0
            values["mem_used_bytes"] = self.memory_percent * 10
        return values


def _system_alarms() -> list[tuple[object, ...]]:
    return _sql("SELECT code, severity, closed_at IS NULL FROM system_alarms ORDER BY opened_at")


class TestSystemAlarms:
    def test_alarm_follows_condition_with_hysteresis(self, world: World) -> None:
        sampler = _MemorySampler()
        _monitor(sampler)
        assert _system_alarms() == []
        sampler.memory_percent = 95.0  # > 90% — warunek włącza się od razu
        _monitor(sampler)
        _monitor(sampler)  # kolejne wykrycie odświeża, nie dubluje
        assert _system_alarms() == [("MEMORY_HIGH", "WARNING", True)]
        sampler.memory_percent = None  # brak pomiaru nie zamyka
        _monitor(sampler)
        sampler.memory_percent = 50.0  # < 85% — zamknięcie po 2 pomiarach
        _monitor(sampler)
        assert _system_alarms() == [("MEMORY_HIGH", "WARNING", True)]
        _monitor(sampler)
        assert _system_alarms() == [("MEMORY_HIGH", "WARNING", False)]
        sampler.memory_percent = 95.0  # ponowne wystąpienie — nowy alarm
        _monitor(sampler)
        assert _system_alarms() == [
            ("MEMORY_HIGH", "WARNING", False),
            ("MEMORY_HIGH", "WARNING", True),
        ]

    def test_owner_lists_and_acknowledges(self, world: World, as_user: AsUser) -> None:
        sampler = _MemorySampler()
        sampler.memory_percent = 95.0
        _monitor(sampler)
        owner, csrf = as_user("owner_a")
        body = owner.get("/api/system/alarms").json()
        assert body["worker_stale"] is False
        [alarm] = body["alarms"]
        assert (alarm["code"], alarm["severity"], alarm["closed_at"]) == (
            "MEMORY_HIGH",
            "WARNING",
            None,
        )
        assert alarm["acknowledged_at"] is None
        url = f"/api/system/alarms/{alarm['id']}/acknowledge"
        assert owner.post(url).status_code == 403  # bez CSRF
        acked = owner.post(url, headers=_headers(csrf)).json()
        assert acked["acknowledged_at"] is not None
        assert acked["acknowledged_by"]
        again = owner.post(url, headers=_headers(csrf)).json()
        assert again["acknowledged_at"] == acked["acknowledged_at"]  # autor i czas bez zmian
        actions = [r[0] for r in _sql("SELECT action FROM audit_events")]
        assert actions.count("SYSTEM_ALARM_ACKNOWLEDGED") == 1
        # Potwierdzenie nie zamyka alarmu.
        assert _system_alarms() == [("MEMORY_HIGH", "WARNING", True)]
        missing = f"/api/system/alarms/{uuid.uuid4()}/acknowledge"
        assert owner.post(missing, headers=_headers(csrf)).status_code == 404
        for user in ("admin_a", "scoped_viewer_a"):
            c, user_csrf = as_user(user)
            assert c.get("/api/system/alarms").status_code == 403
            assert c.post(url, headers=_headers(user_csrf)).status_code == 403
        with TestClient(create_app(Settings())) as anonymous:  # type: ignore[call-arg]
            assert anonymous.get("/api/system/alarms").status_code == 401

    def test_stale_worker_is_reported(self, world: World, as_user: AsUser) -> None:
        _monitor(_MemorySampler())
        _sql("UPDATE system_status SET evaluated_at = now() - interval '10 minutes'")
        owner, _ = as_user("owner_a")
        body = owner.get("/api/system/alarms").json()
        assert body["worker_stale"] is True
        assert body["worker_stale_since"] is not None

    def test_retention_removes_only_old_closed(self, world: World) -> None:
        _sql(
            "INSERT INTO system_alarms (id, code, severity, message, opened_at, last_seen_at, "
            "closed_at) VALUES "
            "(gen_random_uuid(), 'DISK_HIGH', 'WARNING', 'stary', now() - interval '400 days', "
            "now() - interval '400 days', now() - interval '399 days'), "
            "(gen_random_uuid(), 'DISK_FULL', 'CRITICAL', 'otwarty', now() - interval '400 days', "
            "now(), NULL)"
        )
        assert _retention(datetime.now(UTC))["system_alarms"] == 1
        assert _sql("SELECT code FROM system_alarms") == [("DISK_FULL",)]


# --- sprawdzanie aktualizacji (D63) ------------------------------------------------------

UPDATE_KEY = Ed25519PrivateKey.generate()  # tylko do testów, nigdzie nie zapisywany
UPDATE_PUBLIC = base64.b64encode(
    UPDATE_KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
).decode()


def _manifest(version: str, *, security: bool = False) -> bytes:
    return json.dumps(
        {
            "product": "solargraf",
            "channel": "stable",
            "version": version,
            "released_at": "2026-12-01T10:00:00Z",
            "min_upgrade_from": "0.0.1",
            "security": security,
            "notes": "Poprawki.",
            "info_url": "https://example.com/wydanie",
        }
    ).encode()


def _fake_fetch(body: bytes, *, tamper: bool = False) -> tuple[Fetch, list[str]]:
    calls: list[str] = []
    signature = base64.b64encode(UPDATE_KEY.sign(body))

    async def fetch(url: str, timeout_s: float, limit: int) -> bytes:
        calls.append(url)
        if url.endswith(".sig"):
            return signature
        return body + (b" " if tamper else b"")

    return fetch, calls


def _configure(client: TestClient, fetch: Fetch, key: str | None = UPDATE_PUBLIC) -> None:
    app = cast(FastAPI, client.app)
    app.state.update_public_key = key
    app.state.update_fetch = fetch


def _no_jitter(limit: timedelta) -> timedelta:
    return timedelta(0)


def _scheduled(at: datetime, fetch: Fetch | None = None, *, automatic_default: bool = True) -> bool:
    async def go() -> bool:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                if fetch is None:
                    return await run_scheduled(
                        db,
                        automatic_default=automatic_default,
                        url="https://example.com/manifest.json",
                        timeout_s=1,
                        public_key=UPDATE_PUBLIC,
                        now=at,
                        jitter=_no_jitter,
                    )
                return await run_scheduled(
                    db,
                    automatic_default=automatic_default,
                    url="https://example.com/manifest.json",
                    timeout_s=1,
                    public_key=UPDATE_PUBLIC,
                    now=at,
                    fetch=fetch,
                    jitter=_no_jitter,
                )
        finally:
            await engine.dispose()

    return asyncio.run(go())


class TestUpdateCheck:
    def test_without_key_nothing_is_fetched(self, world: World, as_user: AsUser) -> None:
        owner, csrf = as_user("owner_a")
        fetch, calls = _fake_fetch(_manifest("9.0.0"))
        _configure(owner, fetch, key=None)
        body = owner.get("/api/system/updates").json()
        assert (body["configured"], body["automatic"], body["available"]) == (False, True, None)
        resp = owner.post("/api/system/updates/check", headers={"X-CSRF-Token": csrf})
        assert resp.json()["last_error"] == "NOT_CONFIGURED"
        assert calls == []

    def test_manual_check_dismiss_and_security(self, world: World, as_user: AsUser) -> None:
        owner, csrf = as_user("owner_a")
        headers = {"X-CSRF-Token": csrf}
        fetch, calls = _fake_fetch(_manifest("9.0.0"))
        _configure(owner, fetch)
        body = owner.post("/api/system/updates/check", headers=headers).json()
        assert calls[0].endswith("/manifest.json")
        assert calls[1].endswith("/manifest.json.sig")
        assert body["last_error"] is None
        assert body["available"]["version"] == "9.0.0"
        assert body["available"]["direct_upgrade"] is True
        assert body["dismissed"] is False
        resp = owner.post("/api/system/updates/dismiss", json={"version": "9.0.0"}, headers=headers)
        assert resp.json()["dismissed"] is True
        assert owner.get("/api/system/updates").json()["dismissed"] is True
        # Limit częstotliwości: ponowne kliknięcie od razu nie łączy się z siecią.
        owner.post("/api/system/updates/check", headers=headers)
        assert len(calls) == 2
        _sql("UPDATE update_status SET last_checked_at = now() - interval '2 minutes'")
        # Zły podpis: błąd zapisany, ostatni poprawny manifest zostaje.
        bad, _ = _fake_fetch(_manifest("9.1.0"), tamper=True)
        _configure(owner, bad)
        body = owner.post("/api/system/updates/check", headers=headers).json()
        assert body["last_error"] == "INVALID_SIGNATURE"
        assert body["available"]["version"] == "9.0.0"
        _sql("UPDATE update_status SET last_checked_at = now() - interval '2 minutes'")
        # Wersja z poprawkami bezpieczeństwa: nowa, nieukryta i nie da się jej ukryć.
        secure, _ = _fake_fetch(_manifest("9.2.0", security=True))
        _configure(owner, secure)
        body = owner.post("/api/system/updates/check", headers=headers).json()
        assert (body["available"]["version"], body["dismissed"]) == ("9.2.0", False)
        resp = owner.post("/api/system/updates/dismiss", json={"version": "9.2.0"}, headers=headers)
        assert resp.status_code == 409
        actions = {a for (a,) in _sql("SELECT action FROM audit_events")}
        assert {"UPDATES_CHECKED", "UPDATE_DISMISSED"} <= actions

    def test_install_request(self, world: World, as_user: AsUser, tmp_path: Path) -> None:
        owner, csrf = as_user("owner_a")
        headers = {"X-CSRF-Token": csrf}
        url = "/api/system/updates/install"
        fetch, _ = _fake_fetch(_manifest("9.0.0"))
        _configure(owner, fetch)
        app = cast(FastAPI, owner.app)
        app.state.update_dirs = None
        idle = {"supported": False, "requested": False, "running": False, "last": None}
        assert owner.get("/api/system/updates").json()["install"] == idle
        owner.post("/api/system/updates/check", headers=headers)
        # Serwer bez usługi hosta: tylko polecenie w terminalu.
        assert owner.post(url, json={"version": "9.0.0"}, headers=headers).status_code == 409
        dirs = InstallDirs(request=tmp_path / "request", status=tmp_path / "status")
        dirs.request.mkdir()
        dirs.status.mkdir()
        app.state.update_dirs = dirs
        assert owner.post(url, json={"version": "9.0.0"}).status_code == 403  # bez CSRF
        assert owner.post(url, json={"version": "8.0.0"}, headers=headers).status_code == 409
        flag = dirs.request / "update"
        assert not flag.exists()
        resp = owner.post(url, json={"version": "9.0.0"}, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["install"]["requested"] is True
        assert flag.read_bytes() == b""
        assert owner.post(url, json={"version": "9.0.0"}, headers=headers).status_code == 409
        assert ("UPDATE_INSTALL_REQUESTED",) in _sql("SELECT action FROM audit_events")
        # Usługa hosta zabrała flagę i zapisuje stan; trwająca aktualizacja blokuje kolejne.
        flag.unlink()
        started = datetime.now(UTC).isoformat()
        status_file = dirs.status / "status.json"
        status_file.write_text(
            json.dumps(
                {
                    "state": "RUNNING",
                    "step": "BUILD",
                    "from_version": "0.1.0",
                    "to_version": "9.0.0",
                    "started_at": started,
                    "finished_at": None,
                }
            )
        )
        body = owner.get("/api/system/updates").json()["install"]
        assert (body["supported"], body["requested"], body["running"]) == (True, False, True)
        assert (body["last"]["step"], body["last"]["to_version"]) == ("BUILD", "9.0.0")
        assert owner.post(url, json={"version": "9.0.0"}, headers=headers).status_code == 409
        # Nieczytelny plik stanu — brak danych, nie zgadujemy.
        status_file.write_text('{"state": "HACKED"}')
        assert owner.get("/api/system/updates").json()["install"]["last"] is None
        admin, admin_csrf = as_user("admin_a")
        resp = admin.post(url, json={"version": "9.0.0"}, headers={"X-CSRF-Token": admin_csrf})
        assert resp.status_code == 403

    def test_settings_and_permissions(self, world: World, as_user: AsUser) -> None:
        owner, csrf = as_user("owner_a")
        resp = owner.put("/api/system/updates/settings", json={"automatic": False})
        assert resp.status_code == 403  # bez CSRF
        resp = owner.put(
            "/api/system/updates/settings",
            json={"automatic": False},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.json()["automatic"] is False
        assert ("UPDATES_SETTINGS_CHANGED",) in _sql("SELECT action FROM audit_events")
        admin, admin_csrf = as_user("admin_a")
        assert admin.get("/api/system/updates").status_code == 403
        resp = admin.post("/api/system/updates/check", headers={"X-CSRF-Token": admin_csrf})
        assert resp.status_code == 403

    def test_worker_schedule(self, world: World) -> None:
        fetch, calls = _fake_fetch(_manifest("9.0.0"))
        now = datetime.now(UTC)
        # Pierwsze wywołanie wyznacza termin, drugie (w terminie) sprawdza.
        assert _scheduled(now, fetch) is False
        assert _scheduled(now, fetch) is True
        assert len(calls) == 2
        [(next_check,)] = _sql("SELECT next_check_at FROM update_status")
        assert next_check == now + timedelta(days=7)
        assert _scheduled(now + timedelta(days=1), fetch) is False
        # Wyłączone automatyczne sprawdzanie — bez połączeń.
        _sql("UPDATE update_status SET automatic = false, next_check_at = now()")
        assert _scheduled(now + timedelta(days=8), fetch) is False
        assert len(calls) == 2

    def test_installer_default_disables_automatic(self, world: World) -> None:
        assert _scheduled(datetime.now(UTC), automatic_default=False) is False
        assert _sql("SELECT automatic FROM update_status") == [(False,)]
