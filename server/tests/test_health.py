from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from solargraf_server.config import Settings
from solargraf_server.main import create_app


def _settings(**overrides: object) -> Settings:
    return Settings(db_password=SecretStr("test-only"), **overrides)  # type: ignore[arg-type]


def _client(ready: bool, **settings: object) -> TestClient:
    async def check() -> bool:
        return ready

    return TestClient(create_app(_settings(**settings), readiness_check=check))


@pytest.fixture
def ready_client() -> Iterator[TestClient]:
    with _client(ready=True) as client:
        yield client


def test_liveness_ok_with_server_time(ready_client: TestClient) -> None:
    before = datetime.now(UTC)
    resp = ready_client.get("/api/health")
    after = datetime.now(UTC)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"status", "server_time"}
    assert body["status"] == "ok"
    server_time = datetime.fromisoformat(body["server_time"])
    assert server_time.utcoffset() == timedelta(0)
    assert before <= server_time <= after


def test_readiness_ok_when_database_ready(ready_client: TestClient) -> None:
    resp = ready_client.get("/api/health/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_readiness_503_when_database_unavailable() -> None:
    with _client(ready=False) as client:
        resp = client.get("/api/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}


def test_liveness_does_not_depend_on_database() -> None:
    with _client(ready=False) as client:
        assert client.get("/api/health").status_code == 200


def test_api_docs_disabled_by_default(ready_client: TestClient) -> None:
    assert ready_client.get("/api/docs").status_code == 404
    assert ready_client.get("/api/openapi.json").status_code == 404


def test_api_docs_can_be_enabled_for_dev() -> None:
    with _client(ready=True, api_docs=True) as client:
        assert client.get("/api/openapi.json").status_code == 200


def test_unreachable_database_is_not_ready_and_hides_details() -> None:
    # Port 1 na localhost — brak serwera; prawdziwy silnik, bez podmiany sprawdzenia.
    settings = _settings(db_port=1, db_timeout_s=1.0)
    with TestClient(create_app(settings)) as client:
        resp = client.get("/api/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}
    assert "test-only" not in resp.text
