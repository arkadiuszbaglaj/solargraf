"""Izolacja danych między organizacjami i zawężenie członkostwa (D29, D33) — PostgreSQL w CI."""

import asyncio
import os
import subprocess
import sys
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from solargraf_server.auth.passwords import hash_password
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.main import create_app
from solargraf_server.models import Membership, MembershipSite, Organization, Role, Site, User

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "haslo-testowe-izolacji"
TABLES = (
    "devices, connections, agents, membership_sites, sites, audit_events, auth_sessions, "
    "setup_tokens, memberships, users, organizations"
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
        "INSERT INTO agents (id, name, mode, enabled, last_heartbeat_at) "
        "VALUES (:id, 'agent', 'LOCAL', true, now())",
        id=agent,
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
