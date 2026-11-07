"""End-to-end SunSpec (D59): profile z repozytorium → agent → symulator → partia do API.

Falownik i licznik na jednym połączeniu (jeden klient, D43) i jednej mapie SunSpec symulatora.
To test na symulatorze, nie test sprzętowy — profile zostają na poziomie COMMUNITY.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx2

from solargraf_agent.api import AgentConfig, ApiClient
from solargraf_agent.buffer import Buffer
from solargraf_agent.cli import load_profiles
from solargraf_agent.runner import AgentRunner
from solargraf_profiles.model import Addressing, PointStatus, SupportLevel
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.server import SimulatorServer
from solargraf_simulator.sunspec_map import SunSpecRegisterMap

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"
INVERTER = ("sunspec.pv-inverter-3ph", "1.0.0")
METER = ("sunspec.grid-meter-3ph", "1.0.0")
NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
# Start o północy z pustą baterią — wszystkie liczniki energii dodatnie (0 to w SunSpec brak).
MIDNIGHT_UTC = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
TOKEN = "token-testowy-agenta-abcdefghijklmnop"


def test_repository_sunspec_profiles_are_generic_and_unverified() -> None:
    profiles = load_profiles(PROFILES_DIR)
    for key in (INVERTER, METER):
        profile = profiles[key]
        assert profile.addressing is Addressing.SUNSPEC
        assert profile.support_level is SupportLevel.COMMUNITY
        assert profile.hardware_tests == []
        assert {p.status for p in profile.points} == {PointStatus.UNVERIFIED}
    assert profiles[INVERTER].sunspec_models == [103, 160]
    assert profiles[METER].sunspec_models == [203]


def device(profile: tuple[str, str], kind: str) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "name": kind,
        "kind": kind,
        "enabled": True,
        "profile_id": profile[0],
        "profile_version": profile[1],
    }


def test_inverter_and_meter_from_simulator_reach_api_as_simulated(tmp_path: Path) -> None:
    batches: list[dict[str, Any]] = []

    def api(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/api/agent/batches":
            batches.append(json.loads(request.content))
            return httpx2.Response(200, json={"duplicate": False, "runs": 2, "readings": 1})
        return httpx2.Response(404)

    async def go() -> None:
        profiles = load_profiles(PROFILES_DIR)
        plant = Plant(PlantConfig(initial_soc=0), now=MIDNIGHT_UTC)
        registers = SunSpecRegisterMap([profiles[INVERTER], profiles[METER]])
        sim = SimulatorServer(plant, registers, clock=lambda: NOON_UTC)
        port = await sim.start("127.0.0.1", 0)
        client = ApiClient("http://api:8000", TOKEN, transport=httpx2.MockTransport(api))
        buffer = Buffer(tmp_path / "buffer.sqlite3")
        runner = AgentRunner(client, buffer, profiles, clock=lambda: NOON_UTC)
        inverter, meter = device(INVERTER, "INVERTER"), device(METER, "METER")
        connection = {
            "id": str(uuid.uuid4()),
            "transport": "MODBUS_TCP",
            "host": "127.0.0.1",
            "port": port,
            "unit_id": 1,
            "poll_interval_seconds": None,
            "timeout_seconds": 1,
            "devices": [inverter, meter],
        }
        config = {"agent_id": str(uuid.uuid4()), "connections": [connection]}
        try:
            runner.apply_config(AgentConfig.model_validate(config), start=False)
            [worker] = runner.workers.values()
            await worker.poll_cycle()
            assert await runner.send_pending() == 2
        finally:
            await runner.aclose()
            await client.aclose()
            buffer.close()
            await sim.stop()

        runs = {r["device_id"]: r for b in batches for r in b["runs"]}
        metrics = plant.metrics()
        for dev, profile in ((inverter, INVERTER), (meter, METER)):
            run = runs[dev["id"]]
            assert run["result"] == "OK", run.get("errors")
            readings = run["readings"]
            assert len(readings) == len(profiles[profile].points)
            # Ogólny profil ma origin DEVICE, ale symulator przedstawia się w modelu 1.
            assert {r["origin"] for r in readings} == {"SIMULATED"}
            assert all(r["quality"] == "GOOD" and r["value"] is not None for r in readings)
        meter_values = {
            r["metric"]: Decimal(str(r["value"])) for r in runs[meter["id"]]["readings"]
        }
        assert meter_values["grid_power"] == metrics["grid_power"]
        assert (
            abs(meter_values["grid_export_energy_total"] - metrics["grid_export_energy_total"]) <= 1
        )

    asyncio.run(go())
