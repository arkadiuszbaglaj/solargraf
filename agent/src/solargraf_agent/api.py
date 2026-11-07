"""Klient API serwera dla agenta (D42, D43). Token tylko w nagłówku — nigdy w logach."""

from __future__ import annotations

import uuid
from typing import Any

import httpx2
from pydantic import BaseModel, ConfigDict, ValidationError

from solargraf_profiles.catalog import DeviceKind, Transport

REQUEST_TIMEOUT_S = 10.0


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
    devices: tuple[DeviceConfig, ...]


class AgentConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    agent_id: uuid.UUID
    connections: tuple[ConnectionConfig, ...]


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
