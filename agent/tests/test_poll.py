"""Odczyt urządzenia przez agenta (D41) — testy na symulatorze (D40), nie na sprzęcie."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import yaml
from pymodbus.client import AsyncModbusTcpClient

from solargraf_agent.cli import format_run, main
from solargraf_agent.modbus import ModbusPoller, Target
from solargraf_agent.plan import plan_blocks
from solargraf_agent.readings import ErrorCode, Origin, PollingRun, Quality, RunResult
from solargraf_profiles.codec import decode, encode
from solargraf_profiles.model import Profile
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import Faults, SimulatorServer

PROFILE_PATH = Path(__file__).resolve().parents[2] / "profiles" / "simulated.hybrid-inverter.yaml"
NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
RAW: dict[str, Any] = yaml.safe_load(PROFILE_PATH.read_text(encoding="utf-8"))


def profile(**polling: int) -> Profile:
    data = copy.deepcopy(RAW)
    data["polling"].update(polling)
    return Profile.model_validate(data)


def with_extra_point(base: dict[str, Any], address: int, table: str = "input") -> Profile:
    data = copy.deepcopy(base)
    data["points"].append(
        {
            "metric": "pv_string_voltage",
            "channel": 2,
            "status": "UNVERIFIED",
            "source": "simulator-map",
            "register": {"table": table, "address": address, "type": "u16"},
            "unit": "V",
        }
    )
    return Profile.model_validate(data)


class Env:
    def __init__(self, server: SimulatorServer, poller: ModbusPoller, sleeps: list[float]) -> None:
        self.server, self.poller, self.sleeps = server, poller, sleeps


def run(
    test: Callable[[Env], Awaitable[None]],
    *,
    agent_profile: Profile | None = None,
    faults: Faults | None = None,
) -> None:
    """Symulator z profilem testowym + agent (domyślnie z tym samym profilem)."""

    async def go() -> None:
        sim_profile = profile()
        server = SimulatorServer(
            Plant(PlantConfig(), now=NOON_UTC),
            RegisterMap(sim_profile),
            faults=faults,
            clock=lambda: NOON_UTC,
        )
        port = await server.start("127.0.0.1", 0)
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        poller = ModbusPoller(
            agent_profile or sim_profile,
            Target("127.0.0.1", port, 1),
            clock=lambda: NOON_UTC,
            sleep=fake_sleep,
        )
        try:
            await test(Env(server, poller, sleeps))
        finally:
            poller.close()
            await server.stop()

    asyncio.run(go())


def by_metric(result: PollingRun) -> dict[str, Any]:
    return {r.metric: r for r in result.readings}


class TestPlan:
    def test_contiguous_points_form_one_block(self) -> None:
        blocks = plan_blocks(profile())
        assert [(b.table, b.address, b.count) for b in blocks] == [("input", 0, 28)]
        assert len(blocks[0].points) == 25  # bez punktu UNSUPPORTED

    def test_gap_and_table_split_blocks(self) -> None:
        gap = with_extra_point(RAW, 40)
        assert [(b.address, b.count) for b in plan_blocks(gap)] == [(0, 28), (40, 1)]
        holding = with_extra_point(RAW, 28, table="holding")
        assert [(b.table, b.address) for b in plan_blocks(holding)] == [
            ("holding", 28),
            ("input", 0),
        ]

    def test_block_limit(self) -> None:
        blocks = plan_blocks(profile(max_block_registers=4))
        assert all(b.count <= 4 for b in blocks)
        assert sum(b.count for b in blocks) == 28
        # Wartość 32-bitowa nigdy nie jest dzielona między bloki.
        assert [(b.address, b.count) for b in blocks][:2] == [(0, 4), (4, 4)]

    def test_sunspec_profile_is_not_planned_as_fixed_registers(self) -> None:
        # D59: adresy SunSpec zna dopiero mapa urządzenia (``sunspec_map``), nie stały plan.
        data = copy.deepcopy(RAW)
        data["addressing"] = "sunspec"
        data["points"] = [
            {
                "metric": "pv_power",
                "status": "UNVERIFIED",
                "source": "simulator-map",
                "sunspec": {"model": 103, "point": "DCW"},
                "unit": "W",
            }
        ]
        sunspec_profile = Profile.model_validate(data)
        with pytest.raises(ValueError, match="adresowanie sunspec"):
            plan_blocks(sunspec_profile)
        with pytest.raises(ValueError, match="adresowanie sunspec"):
            RegisterMap(sunspec_profile)


class TestPoll:
    def test_values_match_simulator_model(self) -> None:
        async def test(env: Env) -> None:
            result = await env.poller.poll()
            assert result.result is RunResult.OK, result.errors
            expected = env.server.plant.metrics()
            for r in result.readings:
                point = next(p for p in env.poller.profile.points if p.metric == r.metric)
                assert r.value == decode(point, encode(point, expected[r.metric])), r.metric
                assert r.quality is Quality.GOOD
                assert r.origin is Origin.SIMULATED
                assert r.observed_at is None
                assert r.received_at == NOON_UTC
            readings = by_metric(result)
            assert readings["battery_power"].value == Decimal(-3000)  # sign: invert
            assert readings["pv_energy_total"].unit == "Wh"
            assert readings["pv_power"].source_reference == (
                "simulated.hybrid-inverter@0.1.0:pv_power"
            )
            assert readings["pv_string_voltage"].source_reference.endswith("pv_string_voltage[1]")
            assert "battery_temperature" not in readings  # UNSUPPORTED nie jest odczytywany

        run(test)

    def test_failed_block_gives_missing_not_zero(self) -> None:
        async def test(env: Env) -> None:
            result = await env.poller.poll()
            assert result.result is RunResult.PARTIAL
            missing = next(
                r for r in result.readings if r.metric == "pv_string_voltage" and r.channel == 2
            )
            assert missing.value is None
            assert missing.quality is Quality.MISSING
            assert missing.error is ErrorCode.MODBUS_EXCEPTION
            assert result.errors[0].modbus_code == 0x02
            assert result.ok_points == 25
            assert env.sleeps == []  # wyjątek Modbus bez ponawiania

        run(test, agent_profile=with_extra_point(RAW, 40))

    def test_injected_modbus_exception(self) -> None:
        async def test(env: Env) -> None:
            result = await env.poller.poll()
            assert result.result is RunResult.FAILED
            assert result.error_code is ErrorCode.MODBUS_EXCEPTION
            assert result.errors[0].modbus_code == 0x04
            assert all(r.value is None for r in result.readings)

        run(test, faults=Faults(exception_code=0x04))

    def test_timeout_is_retried_with_backoff(self) -> None:
        async def test(env: Env) -> None:
            result = await env.poller.poll()
            assert result.result is RunResult.FAILED
            assert result.error_code is ErrorCode.TIMEOUT
            assert env.sleeps == [0.5, 1.0]
            assert all(r.quality is Quality.MISSING for r in result.readings)

        run(
            test,
            agent_profile=profile(timeout_seconds=1, retries=2),
            faults=Faults(no_response=True),
        )

    def test_dropped_connection_then_recovery(self) -> None:
        async def test(env: Env) -> None:
            result = await env.poller.poll()
            assert result.error_code is ErrorCode.CONNECTION_LOST
            assert len(env.sleeps) == env.poller.profile.polling.retries
            env.server.faults.drop_connection = False
            assert (await env.poller.poll()).result is RunResult.OK

        run(test, agent_profile=profile(timeout_seconds=1), faults=Faults(drop_connection=True))

    def test_connection_refused(self) -> None:
        async def go() -> None:
            server = SimulatorServer(Plant(PlantConfig(), now=NOON_UTC), RegisterMap(profile()))
            port = await server.start("127.0.0.1", 0)
            await server.stop()  # port wolny — nikt nie nasłuchuje
            poller = ModbusPoller(profile(), Target("127.0.0.1", port, 1))
            try:
                result = await poller.poll()
            finally:
                poller.close()
            assert result.result is RunResult.FAILED
            assert result.error_code is ErrorCode.CONNECTION_REFUSED
            assert all(r.value is None for r in result.readings)

        asyncio.run(go())

    def test_second_client_rejected_until_first_leaves(self) -> None:
        async def test(env: Env) -> None:
            port = env.server.port
            assert port is not None
            other = AsyncModbusTcpClient("127.0.0.1", port=port, timeout=1, retries=0)
            assert await other.connect()
            await asyncio.sleep(0.05)
            result = await env.poller.poll()
            assert result.result is RunResult.FAILED
            assert result.error_code is ErrorCode.CONNECTION_LOST
            other.close()
            await asyncio.sleep(0.05)
            assert (await env.poller.poll()).result is RunResult.OK

        run(test, agent_profile=profile(timeout_seconds=1), faults=Faults(single_client=True))

    def test_counter_reset_is_reported_as_read(self) -> None:
        async def test(env: Env) -> None:
            env.server.plant.pv_energy_wh = 500_000.0
            before = by_metric(await env.poller.poll())["pv_energy_total"]
            env.server.plant.reset_counters()
            after = by_metric(await env.poller.poll())["pv_energy_total"]
            # Agent nie ukrywa resetu — wykrycie i obsługa resetu liczników należy do P4.
            assert before.value == Decimal(500_000)
            assert after.value == 0
            assert after.quality is Quality.GOOD

        run(test)

    def test_implausible_soc_is_invalid(self) -> None:
        async def test(env: Env) -> None:
            plant = env.server.plant
            plant.soc_wh = 2.0 * plant.config.battery_capacity_wh  # 200 %
            soc = by_metric(await env.poller.poll())["battery_soc"]
            assert soc.quality is Quality.INVALID
            assert soc.value is None

        run(test)


class TestCli:
    def test_format_run(self) -> None:
        async def test(env: Env) -> None:
            text = format_run(await env.poller.poll())
            assert "wynik=OK" in text
            assert "battery_power" in text
            assert "SIMULATED" in text

        run(test)

    def test_invalid_profile(self, tmp_path: Path) -> None:
        broken = tmp_path / "broken.yaml"
        broken.write_text("id: [", encoding="utf-8")
        assert main(["poll", str(broken), "--once"]) == 2
