"""Testy kont i sesji na prawdziwym PostgreSQL (``SOLARGRAF_TEST_DB=1``, w CI)."""

import asyncio
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx2
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
TABLES = (
    "membership_sites, sites, audit_events, auth_sessions, setup_tokens, memberships, users, "
    "organizations"
)
PASSWORD = "bardzo-dlugie-haslo-1"


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 — stała lista argumentów
        [sys.executable, *args], capture_output=True, text=True, timeout=120, check=False
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
    done = _run(["-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), "upgrade", "head"])
    assert done.returncode == 0, done.stderr


@pytest.fixture(autouse=True)
def _clean() -> None:
    _sql(f"TRUNCATE {TABLES} CASCADE")


@pytest.fixture
def client() -> Iterator[TestClient]:
    # https — cookie sesji ma flagę Secure.
    with TestClient(create_app(Settings()), base_url="https://testserver") as c:  # type: ignore[call-arg]
        yield c


def setup_token() -> str:
    done = _run(["-m", "solargraf_server.cli", "setup-token"])
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def do_setup(
    client: TestClient, token: str, email: str = "Wlasciciel@Example.pl"
) -> httpx2.Response:
    return client.post(
        "/api/setup",
        json={
            "token": token,
            "organization_name": "Organizacja testowa",
            "email": email,
            "display_name": "Właściciel",
            "password": PASSWORD,
        },
    )


def login(
    client: TestClient, email: str = "wlasciciel@example.pl", password: str = PASSWORD
) -> httpx2.Response:
    return client.post("/api/auth/login", json={"email": email, "password": password})


@pytest.fixture
def configured(client: TestClient) -> TestClient:
    assert do_setup(client, setup_token()).status_code == 201
    return client


def test_alembic_models_match_migrations() -> None:
    done = _run(["-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), "check"])
    assert done.returncode == 0, done.stdout + done.stderr


class TestSetup:
    def test_creates_owner_and_token_is_single_use(self, client: TestClient) -> None:
        token = setup_token()
        resp = do_setup(client, token)
        assert resp.status_code == 201
        assert resp.json()["email"] == "wlasciciel@example.pl"
        assert do_setup(client, token, email="drugi@example.pl").status_code == 409
        rows = _sql("SELECT role FROM memberships")
        assert rows == [("OWNER",)]

    def test_no_new_setup_token_after_configuration(self, configured: TestClient) -> None:
        done = _run(["-m", "solargraf_server.cli", "setup-token"])
        assert done.returncode == 1
        assert done.stdout == ""

    def test_invalid_and_expired_token(self, client: TestClient) -> None:
        assert do_setup(client, "zly-token").status_code == 400
        token = setup_token()
        _sql("UPDATE setup_tokens SET expires_at = now() - interval '1 second'")
        assert do_setup(client, token).status_code == 400
        assert _sql("SELECT count(*) FROM users") == [(0,)]

    def test_weak_password_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/setup",
            json={
                "token": setup_token(),
                "organization_name": "Org",
                "email": "a@example.pl",
                "display_name": "A",
                "password": "krotkie",
            },
        )
        assert resp.status_code == 422
        assert _sql("SELECT count(*) FROM users") == [(0,)]

    def test_token_stored_only_as_hash(self, client: TestClient) -> None:
        token = setup_token()
        rows = _sql("SELECT token_hash FROM setup_tokens")
        assert len(rows) == 1
        assert rows[0][0] != token


class TestLogin:
    def test_success_sets_hardened_cookie_and_returns_memberships(
        self, configured: TestClient
    ) -> None:
        resp = login(configured, email="WLASCICIEL@example.PL")
        assert resp.status_code == 200
        cookie = resp.headers["set-cookie"].lower()
        for attr in ("httponly", "secure", "samesite=strict", "path=/api"):
            assert attr in cookie
        body = resp.json()
        assert body["memberships"][0]["role"] == "OWNER"
        assert body["csrf_token"]
        me = configured.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"]["email"] == "wlasciciel@example.pl"

    def test_wrong_password_and_unknown_user_look_the_same(self, configured: TestClient) -> None:
        wrong = login(configured, password="zle-haslo-123456")
        unknown = login(configured, email="nikt@example.pl")
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json() == unknown.json()

    def test_lockout_after_five_failures_blocks_correct_password(
        self, configured: TestClient
    ) -> None:
        for _ in range(5):
            assert login(configured, password="zle-haslo-123456").status_code == 401
        assert login(configured).status_code == 401
        actions = [a for (a,) in _sql("SELECT action FROM audit_events ORDER BY at")]
        assert "ACCOUNT_LOCKED" in actions
        assert "LOGIN_REJECTED_LOCKED" in actions
        # Po upływie blokady logowanie znów działa.
        _sql("UPDATE users SET locked_until = now() - interval '1 second'")
        assert login(configured).status_code == 200

    def test_audit_contains_no_password_or_email(self, configured: TestClient) -> None:
        login(configured, password="zle-haslo-123456")
        login(configured, email="nikt@example.pl")
        login(configured)
        rows = _sql("SELECT action, coalesce(target, '') FROM audit_events")
        dump = repr(rows)
        assert PASSWORD not in dump
        assert "zle-haslo" not in dump
        assert "example.pl" not in dump

    def test_session_token_stored_only_as_hash(self, configured: TestClient) -> None:
        resp = login(configured)
        raw = resp.cookies.get("sg_session")
        assert raw
        hashes = [h for (h,) in _sql("SELECT token_hash FROM auth_sessions")]
        assert raw not in hashes


class TestSession:
    def test_me_requires_login(self, client: TestClient) -> None:
        assert client.get("/api/auth/me").status_code == 401

    def test_logout_requires_csrf_and_invalidates_session(self, configured: TestClient) -> None:
        csrf = login(configured).json()["csrf_token"]
        assert configured.post("/api/auth/logout").status_code == 403
        assert (
            configured.post("/api/auth/logout", headers={"X-CSRF-Token": "zly"}).status_code == 403
        )
        assert (
            configured.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
        )
        assert _sql("SELECT count(*) FROM auth_sessions") == [(0,)]
        assert configured.get("/api/auth/me").status_code == 401

    def test_idle_session_expires(self, configured: TestClient) -> None:
        login(configured)
        _sql("UPDATE auth_sessions SET last_seen_at = now() - interval '25 hours'")
        assert configured.get("/api/auth/me").status_code == 401
        assert _sql("SELECT count(*) FROM auth_sessions") == [(0,)]

    def test_absolute_expiry(self, configured: TestClient) -> None:
        login(configured)
        _sql("UPDATE auth_sessions SET expires_at = now() - interval '1 second'")
        assert configured.get("/api/auth/me").status_code == 401

    def test_inactive_user_cannot_use_session(self, configured: TestClient) -> None:
        login(configured)
        _sql("UPDATE users SET is_active = false")
        assert configured.get("/api/auth/me").status_code == 401
