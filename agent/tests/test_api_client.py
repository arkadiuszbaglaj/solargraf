"""Klient API agenta (D43) na atrapie transportu HTTP — kody odpowiedzi i ochrona tokenu."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable

import httpx2
import pytest

from solargraf_agent.api import (
    AgentConfig,
    ApiClient,
    ApiUnavailable,
    AuthRejected,
    BatchRejected,
)

TOKEN = "token-testowy-agenta-0123456789"
CONFIG = {
    "agent_id": str(uuid.uuid4()),
    "connections": [
        {
            "id": str(uuid.uuid4()),
            "transport": "MODBUS_TCP",
            "host": "127.0.0.1",
            "port": 5020,
            "unit_id": 1,
            "poll_interval_seconds": None,
            "timeout_seconds": None,
            "devices": [],
        }
    ],
}

Handler = Callable[[httpx2.Request], httpx2.Response]


def call[T](handler: Handler, action: Callable[[ApiClient], Awaitable[T]]) -> T:
    async def go() -> T:
        api = ApiClient("http://api:8000", TOKEN, transport=httpx2.MockTransport(handler))
        try:
            return await action(api)
        finally:
            await api.aclose()

    return asyncio.run(go())


def status(code: int) -> Handler:
    return lambda _request: httpx2.Response(code)


def test_heartbeat_sends_bearer_token_and_version() -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(204)

    call(handler, lambda api: api.heartbeat("1.2.3"))
    assert seen[0].url.path == "/api/agent/heartbeat"
    assert seen[0].headers["authorization"] == f"Bearer {TOKEN}"
    assert json.loads(seen[0].content) == {"version": "1.2.3"}


@pytest.mark.parametrize(
    ("code", "error"),
    [(401, AuthRejected), (500, ApiUnavailable), (503, ApiUnavailable), (404, ApiUnavailable)],
)
def test_heartbeat_errors(code: int, error: type[Exception]) -> None:
    with pytest.raises(error):
        call(status(code), lambda api: api.heartbeat("1"))


def test_network_error_is_unavailable_without_token_in_message() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    with pytest.raises(ApiUnavailable) as caught:
        call(handler, lambda api: api.heartbeat("1"))
    assert TOKEN not in str(caught.value)
    assert caught.value.__cause__ is None


def test_config_with_etag_and_not_modified() -> None:
    seen: list[str | None] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.headers.get("if-none-match"))
        if request.headers.get("if-none-match") == '"v1"':
            return httpx2.Response(304)
        return httpx2.Response(200, json=CONFIG, headers={"ETag": '"v1"'})

    config, etag = call(handler, lambda api: api.config(None))
    assert isinstance(config, AgentConfig)
    assert etag == '"v1"'
    assert call(handler, lambda api: api.config('"v1"')) == (None, '"v1"')
    assert seen == [None, '"v1"']


def test_invalid_config_is_unavailable() -> None:
    with pytest.raises(ApiUnavailable):
        call(lambda _r: httpx2.Response(200, json={"x": 1}), lambda api: api.config(None))


def test_send_batch_body_and_rejections() -> None:
    seen: list[dict[str, object]] = []
    batch_id = uuid.uuid4()

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(200, json={"duplicate": False, "runs": 1, "readings": 0})

    call(handler, lambda api: api.send_batch(batch_id, [{"n": 1}]))
    assert seen == [{"batch_id": str(batch_id), "runs": [{"n": 1}]}]
    for code in (413, 422):
        with pytest.raises(BatchRejected):
            call(status(code), lambda api: api.send_batch(batch_id, []))
    with pytest.raises(ApiUnavailable):
        call(status(502), lambda api: api.send_batch(batch_id, []))
