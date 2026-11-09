"""Klient API serwera dla agenta (D42, D43). Token tylko w nagłówku — nigdy w logach."""

from __future__ import annotations

import uuid
from typing import Any

import httpx2
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from solargraf_profiles.catalog import DeviceKind, Transport

REQUEST_TIMEOUT_S = 10.0
# Podgląd na żywo (D78) — krótko: spóźniony odczyt i tak zastąpi następny.
LIVE_TIMEOUT_S = 2.0


class DeviceConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: uuid.UUID
    name: str
    kind: DeviceKind
    enabled: bool
    profile_id: str | None
    profile_version: str | None


class ConnectionConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: uuid.UUID
    transport: Transport
    host: str | None
    port: int | None
    unit_id: int | None
    poll_interval_seconds: int | None
    timeout_seconds: int | None
    # Brak u starszego serwera — wtedy z profilu (D78).
    live_interval_seconds: float | None = None
    devices: tuple[DeviceConfig, ...]


class AgentConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    agent_id: uuid.UUID
    connections: tuple[ConnectionConfig, ...]


class TestJob(BaseModel):
    """Zlecenie testu połączenia z kreatora (D72): jeden odczyt profilu pod wskazanym adresem."""

    __test__ = False
    model_config = ConfigDict(frozen=True)

    id: uuid.UUID
    host: str
    port: int
    unit_id: int
    profile_id: str
    profile_version: str


class ApiUnavailable(Exception):
    """Serwer nieosiągalny albo odpowiedział błędem przejściowym — spróbujemy później."""


class AuthRejected(Exception):
    """Serwer odrzucił token agenta (401) — wymaga działania administratora."""


class BatchRejected(Exception):
    """Serwer odrzucił partię jako niepoprawną (422/413) — ponowienie nic nie zmieni."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx2.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=REQUEST_TIMEOUT_S,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx2.Response:  # noqa: ANN401
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx2.HTTPError as exc:
            raise ApiUnavailable(type(exc).__name__) from None
        if response.status_code == 401:
            raise AuthRejected
        if response.status_code >= 500:
            raise ApiUnavailable(f"HTTP {response.status_code}")
        return response

    async def heartbeat(self, version: str) -> None:
        response = await self._request("POST", "/api/agent/heartbeat", json={"version": version})
        if response.status_code != 204:
            raise ApiUnavailable(f"HTTP {response.status_code}")

    async def config(self, etag: str | None) -> tuple[AgentConfig | None, str | None]:
        """``(None, etag)`` gdy konfiguracja się nie zmieniła."""
        headers = {"If-None-Match": etag} if etag else {}
        response = await self._request("GET", "/api/agent/config", headers=headers)
        if response.status_code == 304:
            return None, etag
        if response.status_code != 200:
            raise ApiUnavailable(f"HTTP {response.status_code}")
        try:
            config = AgentConfig.model_validate_json(response.content)
        except ValidationError:
            raise ApiUnavailable("niepoprawna konfiguracja z serwera") from None
        return config, response.headers.get("etag")

    async def send_batch(self, batch_id: uuid.UUID, runs: list[dict[str, Any]]) -> None:
        response = await self._request(
            "POST", "/api/agent/batches", json={"batch_id": str(batch_id), "runs": runs}
        )
        if response.status_code in (413, 422):
            raise BatchRejected(f"HTTP {response.status_code}")
        if response.status_code != 200:
            raise ApiUnavailable(f"HTTP {response.status_code}")

    async def send_live(self, runs: list[dict[str, Any]]) -> None:
        """Odczyty tylko do podglądu na żywo (D78): bez bufora i bez ponawiania."""
        response = await self._request(
            "POST", "/api/agent/live", json={"runs": runs}, timeout=LIVE_TIMEOUT_S
        )
        if response.status_code in (413, 422):
            raise BatchRejected(f"HTTP {response.status_code}")
        if response.status_code != 204:
            raise ApiUnavailable(f"HTTP {response.status_code}")

    async def connection_tests(self) -> list[TestJob]:
        """Odbiera oczekujące zlecenia testu połączenia (serwer oznacza je jako odebrane)."""
        response = await self._request("GET", "/api/agent/connection-tests")
        if response.status_code != 200:
            raise ApiUnavailable(f"HTTP {response.status_code}")
        try:
            return TypeAdapter(list[TestJob]).validate_json(response.content)
        except ValidationError:
            raise ApiUnavailable("niepoprawne zlecenia testu z serwera") from None

    async def report_test(self, test_id: uuid.UUID, result: dict[str, Any]) -> None:
        """Wynik testu; 404/409/422 (zlecenie wygasło albo wynik odrzucony) — bez ponawiania."""
        response = await self._request(
            "POST", f"/api/agent/connection-tests/{test_id}/result", json=result
        )
        if response.status_code in (404, 409, 422):
            raise BatchRejected(f"HTTP {response.status_code}")
        if response.status_code != 204:
            raise ApiUnavailable(f"HTTP {response.status_code}")
