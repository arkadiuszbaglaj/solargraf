"""Pętla agenta (D43) na symulatorze (D40) i atrapie API: konfiguracja, bufor, wysyłka, logi."""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx2
import pytest

from solargraf_agent.api import AgentConfig, ApiClient, ApiUnavailable
from solargraf_agent.buffer import Buffer
from solargraf_agent.cli import load_profiles, main
from solargraf_agent.runner import AgentRunner, _profile_live_interval
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import SimulatorServer

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"
PROFILE = ("simulated.hybrid-inverter", "0.1.0")
NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
TOKEN = "token-testowy-agenta-abcdefghijklmnop"


def device(profile: tuple[str, str] = PROFILE, *, enabled: bool = True) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "name": "Falownik",
        "kind": "INVERTER",
        "enabled": enabled,
        "profile_id": profile[0],
        "profile_version": profile[1],
    }


def connection(port: int, *devices: dict[str, Any], **extra: Any) -> dict[str, Any]:  # noqa: ANN401
    return {
        "id": str(uuid.uuid4()),
        "transport": "MODBUS_TCP",
        "host": "127.0.0.1",
        "port": port,
        "unit_id": 1,
        "poll_interval_seconds": None,
        "timeout_seconds": 1,
        "devices": list(devices),
    } | extra


def config(*connections: dict[str, Any]) -> AgentConfig:
    return AgentConfig.model_validate({"agent_id": str(uuid.uuid4()), "connections": connections})


@dataclass
class FakeServer:
    """Atrapa ``/api/agent/*``: zapisuje partie, może być niedostępna albo gubić odpowiedź."""

    online: bool = True
    lose_response: bool = False
    reject: bool = False
    batches: list[dict[str, Any]] = field(default_factory=list)
    live: list[dict[str, Any]] = field(default_factory=list)
    heartbeats: int = 0
    test_jobs: list[dict[str, Any]] = field(default_factory=list)
    test_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    test_status: int = 204

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if not self.online:
            raise httpx2.ConnectError("down", request=request)
        if request.url.path == "/api/agent/heartbeat":
            self.heartbeats += 1
            return httpx2.Response(204)
        if request.url.path == "/api/agent/config":
            return httpx2.Response(304)
        if request.url.path == "/api/agent/connection-tests":
            jobs, self.test_jobs = self.test_jobs, []
            return httpx2.Response(200, json=jobs)
        if request.url.path == "/api/agent/live":
            self.live.append(json.loads(request.content))
            return httpx2.Response(204)
        if request.url.path.startswith("/api/agent/connection-tests/"):
            self.test_results[request.url.path.split("/")[-2]] = json.loads(request.content)
            return httpx2.Response(self.test_status)
        if self.reject:
            return httpx2.Response(422, json={"detail": "x"})
        self.batches.append(json.loads(request.content))
        if self.lose_response:
            raise httpx2.ReadTimeout("lost", request=request)
        return httpx2.Response(200, json={"duplicate": False, "runs": 1, "readings": 1})


@dataclass
class Env:
    runner: AgentRunner
    server: FakeServer
    buffer: Buffer
    port: int


def run(tmp_path: Path, test: Callable[[Env], Awaitable[None]]) -> None:
    async def go() -> None:
        profiles = load_profiles(PROFILES_DIR)
        sim = SimulatorServer(
            Plant(PlantConfig(), now=NOON_UTC),
            RegisterMap(profiles[PROFILE]),
            clock=lambda: NOON_UTC,
        )
        port = await sim.start("127.0.0.1", 0)
        server = FakeServer()
        api = ApiClient("http://api:8000", TOKEN, transport=httpx2.MockTransport(server))
        buffer = Buffer(tmp_path / "buffer.sqlite3")
        runner = AgentRunner(api, buffer, profiles, clock=lambda: NOON_UTC)
        try:
            await test(Env(runner, server, buffer, port))
        finally:
            await runner.aclose()
            await api.aclose()
            buffer.close()
            await sim.stop()

    asyncio.run(go())


class TestConfig:
    def test_one_shared_client_per_connection_and_profile_settings(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            conn = connection(env.port, device(), device())
            env.runner.apply_config(config(conn), start=False)
            worker = env.runner.workers[uuid.UUID(conn["id"])]
            assert len(worker.pollers) == 2
            assert len({id(p.client) for _, p in worker.pollers}) == 1
            assert worker.interval_s == 10  # z profilu, bo połączenie nie ustawia interwału

        run(tmp_path, test)

    def test_connection_overrides_interval(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            conn = connection(env.port, device(), poll_interval_seconds=30)
            env.runner.apply_config(config(conn), start=False)
            assert env.runner.workers[uuid.UUID(conn["id"])].interval_s == 30

        run(tmp_path, test)

    def test_unknown_profile_and_disabled_device_are_skipped(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        unknown = device(("vendor.unknown", "1.0.0"))

        async def test(env: Env) -> None:
            good = connection(env.port, device(), unknown, device(enabled=False))
            only_unknown = connection(env.port, device(("vendor.unknown", "1.0.0")))
            serial = connection(env.port, device(), transport="MODBUS_RTU")
            env.runner.apply_config(config(good, only_unknown, serial), start=False)
            assert set(env.runner.workers) == {uuid.UUID(good["id"])}
            assert len(env.runner.workers[uuid.UUID(good["id"])].pollers) == 1

        with caplog.at_level(logging.WARNING, logger="solargraf_agent"):
            run(tmp_path, test)
        assert f"Urządzenie {unknown['id']}: nieznany profil vendor.unknown@1.0.0" in caplog.text

    def test_change_restarts_only_changed_connections(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            same = connection(env.port, device(), poll_interval_seconds=3600)
            changed = connection(env.port, device(), poll_interval_seconds=3600)
            removed = connection(env.port, device(), poll_interval_seconds=3600)
            env.runner.apply_config(config(same, changed, removed))
            tasks = dict(env.runner._tasks)
            await asyncio.sleep(0)

            env.runner.apply_config(config(same, changed | {"timeout_seconds": 2}))
            await asyncio.sleep(0)
            same_id, changed_id, removed_id = (uuid.UUID(c["id"]) for c in (same, changed, removed))
            assert env.runner._tasks[same_id] is tasks[same_id]
            assert not tasks[same_id].done()
            assert env.runner._tasks[changed_id] is not tasks[changed_id]
            assert tasks[changed_id].cancelled()
            assert tasks[removed_id].cancelled()
            assert removed_id not in env.runner.workers

        run(tmp_path, test)


class TestLivePreview:
    """Szybki podgląd (D78): każdy cykl na żywo, do bufora średnio jeden na interwał zapisu."""

    def test_live_interval_from_profile_or_connection(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            default = connection(env.port, device())
            override = connection(env.port, device(), live_interval_seconds=2.5)
            slower = connection(env.port, device(), live_interval_seconds=60)
            env.runner.apply_config(config(default, override, slower), start=False)
            workers = env.runner.workers
            assert workers[uuid.UUID(default["id"])].tick_s == 1.5  # z profilu
            assert workers[uuid.UUID(override["id"])].tick_s == 2.5
            # Podgląd rzadszy niż zapis nie ma sensu — zostaje sam zapis co 10 s.
            assert not workers[uuid.UUID(slower["id"])].live
            assert workers[uuid.UUID(slower["id"])].tick_s == 10

        run(tmp_path, test)

    def test_shared_connection_without_live_profile_has_no_preview(self) -> None:
        profiles = load_profiles(PROFILES_DIR)
        fast = profiles[PROFILE]
        slow = fast.model_copy(
            update={"polling": fast.polling.model_copy(update={"live_interval_seconds": None})}
        )
        assert _profile_live_interval([fast]) == 1.5
        assert _profile_live_interval([fast, slow]) is None

    def test_every_cycle_goes_live_only_due_cycles_are_buffered(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            dev = device()
            env.runner.apply_config(config(connection(env.port, dev)), start=False)
            [worker] = env.runner.workers.values()
            await worker.poll_cycle(store=False)
            assert await env.buffer.count() == 0
            await worker.poll_cycle()
            assert await env.buffer.count() == 1
            assert len(env.server.live) == 2
            [run_] = env.server.live[0]["runs"]
            assert run_["device_id"] == dev["id"]
            assert {r["origin"] for r in run_["readings"]} == {"SIMULATED"}
            assert env.server.batches == []  # podgląd nie jest partią

            env.server.online = False
            await worker.poll_cycle()  # niedostępny podgląd nie przerywa zapisu
            assert await env.buffer.count() == 2

        run(tmp_path, test)

    def test_store_cadence_matches_interval(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(env.port, device())), start=False)
            [worker] = env.runner.workers.values()
            ticks = [NOON_UTC + timedelta(seconds=1.5 * i) for i in range(80)]  # 120 s
            stored = [t for t in ticks if worker.store_due(t)]
            assert len(stored) == 12  # średnio co 10 s
            gaps = {(b - a).total_seconds() for a, b in itertools.pairwise(stored)}
            assert gaps <= {9.0, 10.5}
            # Po dłuższej przerwie (np. zawieszony odczyt) bez nadrabiania zaległych zapisów.
            later = ticks[-1] + timedelta(minutes=5)
            assert worker.store_due(later)
            assert not worker.store_due(later + timedelta(seconds=1.5))

        run(tmp_path, test)

    def test_fixed_rate_counts_from_cycle_start(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(env.port, device())), start=False)
            [worker] = env.runner.workers.values()
            now = [NOON_UTC]
            sleeps: list[float] = []

            async def fake_poll_cycle(*, store: bool = True) -> None:
                now[0] += timedelta(seconds=0.4)  # cykl trwa 0,4 s

            async def fake_sleep(seconds: float) -> None:
                sleeps.append(seconds)
                now[0] += timedelta(seconds=seconds)
                if len(sleeps) == 3:
                    raise asyncio.CancelledError

            worker.clock = lambda: now[0]
            worker.sleep = fake_sleep
            worker.poll_cycle = fake_poll_cycle  # type: ignore[method-assign]
            with pytest.raises(asyncio.CancelledError):
                await worker.run_forever()
            assert sleeps == pytest.approx([1.1, 1.1, 1.1])

        run(tmp_path, test)


class TestSending:
    def test_runs_buffered_while_offline_then_sent_oldest_first(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            dev = device()
            env.runner.apply_config(config(connection(env.port, dev)), start=False)
            [worker] = env.runner.workers.values()
            env.server.online = False
            for _ in range(3):
                await worker.poll_cycle()
                with pytest.raises(ApiUnavailable):
                    await env.runner.send_pending()
            assert await env.buffer.count() == 3

            env.server.online = True
            assert await env.runner.send_pending() == 3
            assert await env.buffer.count() == 0
            # Pierwsza partia ma stały skład od pierwszej próby; reszta idzie w następnej.
            assert [len(b["runs"]) for b in env.server.batches] == [1, 2]
            runs = [r for b in env.server.batches for r in b["runs"]]
            assert [r["device_id"] for r in runs] == [dev["id"]] * 3
            first = runs[0]
            assert first["result"] == "OK"
            assert {r["origin"] for r in first["readings"]} == {"SIMULATED"}
            assert all(r["value"] is not None for r in first["readings"])

        run(tmp_path, test)

    def test_lost_response_resends_same_batch_id(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(env.port, device())), start=False)
            [worker] = env.runner.workers.values()
            await worker.poll_cycle()
            env.server.lose_response = True
            with pytest.raises(ApiUnavailable):
                await env.runner.send_pending()
            env.server.lose_response = False
            await worker.poll_cycle()
            await env.runner.send_pending()
            first, retry, *rest = env.server.batches
            # Serwer rozpozna powtórkę po batch_id i nie zdubluje danych (D42).
            assert retry == first
            assert [len(b["runs"]) for b in rest] == [1]
            assert await env.buffer.count() == 0

        run(tmp_path, test)

    def test_rejected_batch_is_dropped_not_blocking(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(env.port, device())), start=False)
            [worker] = env.runner.workers.values()
            await worker.poll_cycle()
            env.server.reject = True
            assert await env.runner.send_pending() == 1
            assert await env.buffer.count() == 0

        run(tmp_path, test)

    def test_device_down_is_recorded_as_failed_run_not_zero(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(1, device())), start=False)
            [worker] = env.runner.workers.values()
            await worker.poll_cycle()
            await env.runner.send_pending()
            [run_] = env.server.batches[0]["runs"]
            assert run_["result"] == "FAILED"
            assert run_["error_code"] == "CONNECTION_REFUSED"
            assert {r["value"] for r in run_["readings"]} == {None}
            assert {r["quality"] for r in run_["readings"]} == {"MISSING"}

        run(tmp_path, test)


def job(port: int, profile: tuple[str, str] = PROFILE, **extra: Any) -> dict[str, Any]:  # noqa: ANN401
    return {
        "id": str(uuid.uuid4()),
        "host": "127.0.0.1",
        "port": port,
        "unit_id": 1,
        "profile_id": profile[0],
        "profile_version": profile[1],
    } | extra


class TestConnectionTests:
    def test_reads_profile_once_and_reports_simulated_values(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            ok = job(env.port)
            env.server.test_jobs = [ok]
            assert await env.runner.check_tests() == 1
            result = env.server.test_results[ok["id"]]
            assert result["result"] == "OK"
            assert result["error_code"] is None
            assert result["origin"] == "SIMULATED"
            values = {r["metric"]: r["value"] for r in result["readings"] if r["channel"] is None}
            assert values["pv_power"] is not None
            assert set(result["readings"][0]) == {"metric", "channel", "value", "quality"}
            # Test nie zostawia zadań ani danych w buforze — to nie jest odczyt urządzenia.
            assert env.runner.workers == {}
            assert await env.buffer.count() == 0
            assert await env.runner.check_tests() == 0

        run(tmp_path, test)

    def test_unreachable_device_is_failed_with_missing_values(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            down = job(1)
            env.server.test_jobs = [down]
            await env.runner.check_tests()
            result = env.server.test_results[down["id"]]
            assert result["result"] == "FAILED"
            assert result["error_code"] == "CONNECTION_REFUSED"
            assert {r["value"] for r in result["readings"]} == {None}
            assert result["origin"] is None  # nic nie odczytano — nie ma czego oznaczać

        run(tmp_path, test)

    def test_unknown_profile_and_target_in_use(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.runner.apply_config(config(connection(env.port, device())), start=False)
            unknown = job(env.port, ("vendor.unknown", "1.0.0"))
            busy = job(env.port)
            other_port = job(1)
            env.server.test_jobs = [unknown, busy, other_port]
            assert await env.runner.check_tests() == 3
            results = env.server.test_results
            assert results[unknown["id"]]["error_code"] == "UNKNOWN_PROFILE"
            assert results[busy["id"]] == {
                "result": "FAILED",
                "error_code": "TARGET_IN_USE",
                "origin": None,
                "readings": [],
            }
            assert results[other_port["id"]]["error_code"] == "CONNECTION_REFUSED"

        run(tmp_path, test)

    def test_rejected_result_is_not_retried(self, tmp_path: Path) -> None:
        async def test(env: Env) -> None:
            env.server.test_status = 409
            env.server.test_jobs = [job(env.port)]
            assert await env.runner.check_tests() == 1  # bez wyjątku — zlecenie wygasło

        run(tmp_path, test)


class TestLoop:
    def test_run_sends_heartbeat_and_data_and_never_logs_token(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        async def test(env: Env) -> None:
            env.server.online = False
            env.runner.apply_config(config(connection(env.port, device())))
            env.runner.heartbeat_interval_s = env.runner.send_interval_s = 0.05
            loop = asyncio.create_task(env.runner.run())
            await asyncio.sleep(0.2)
            env.server.online = True
            for _ in range(100):
                if env.server.heartbeats and env.server.batches:
                    break
                await asyncio.sleep(0.05)
            loop.cancel()
            with pytest.raises(asyncio.CancelledError):
                await loop
            assert env.server.heartbeats
            assert env.server.batches

        with caplog.at_level(logging.DEBUG):
            run(tmp_path, test)
        assert "Serwer niedostępny" in caplog.text
        assert TOKEN not in caplog.text


def test_run_without_token_exits_with_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("SOLARGRAF_AGENT_TOKEN", raising=False)
    assert main(["run"]) == 2
    assert "SOLARGRAF_AGENT_TOKEN" in capsys.readouterr().err
