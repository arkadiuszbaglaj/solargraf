"""Odczyt SunSpec przez agenta na symulatorze (D59): wykrywanie, dekodowanie, braki, błędy."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from solargraf_agent.modbus import ModbusPoller, Target
from solargraf_agent.readings import ErrorCode, Origin, PollingRun, Quality, Reading, RunResult
from solargraf_agent.sunspec_map import MapError, ModelInstance, chunks, discover
from solargraf_profiles.model import Profile
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import RegisterMap
from solargraf_simulator.server import Faults, Registers, SimulatorServer
from solargraf_simulator.sunspec_map import SunSpecRegisterMap

NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)
# Model startuje o północy z pustą baterią, żeby wszystkie liczniki energii były dodatnie
# (licznik równy 0 to w SunSpec brak wartości).
MIDNIGHT_UTC = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
# Rozdzielczość po skali zapisanej przez symulator (``SCALE_BY_UNIT``), wg jednostki kanonicznej.
RESOLUTION = {
    "W": Decimal(1),
    "Wh": Decimal(1),
    "V": Decimal("0.1"),
    "A": Decimal("0.01"),
    "Hz": Decimal("0.01"),
    "degC": Decimal("0.1"),
}


def point(metric: str, model: int, name: str, unit: str, **extra: Any) -> dict[str, Any]:  # noqa: ANN401
    ref: dict[str, Any] = {"model": model, "point": name}
    if "group" in extra:
        ref["group"] = extra.pop("group")
    return {
        "metric": metric,
        "status": "UNVERIFIED",
        "source": "sunspec",
        "sunspec": ref,
        "unit": unit,
        **extra,
    }


INVERTER_POINTS = [
    point("pv_power", 103, "DCW", "W"),
    point("pv_energy_total", 103, "WH", "Wh"),
    point("grid_frequency", 103, "Hz", "Hz"),
    point("inverter_temperature", 103, "TmpCab", "degC"),
    *(
        point("grid_voltage", 103, f"PhVph{phase}", "V", channel=n)
        for n, phase in enumerate("ABC", start=1)
    ),
    *(
        point(metric, 160, name, unit, group="module", channel=n)
        for n in (1, 2)
        for metric, name, unit in (
            ("pv_string_power", "DCW", "W"),
            ("pv_string_voltage", "DCV", "V"),
            ("pv_string_current", "DCA", "A"),
        )
    ),
]
METER_POINTS = [
    point("grid_power", 203, "W", "W"),
    point("grid_import_energy_total", 203, "TotWhImp", "Wh"),
    point("grid_export_energy_total", 203, "TotWhExp", "Wh"),
]


def profile(points: list[dict[str, Any]], *, kind: str = "INVERTER", **polling: int) -> Profile:
    """Profil testowy SunSpec (SIMULATED) — nie opisuje rzeczywistego urządzenia."""
    return Profile.model_validate(
        {
            "schema_version": 1,
            "id": f"simulated.sunspec-{kind.lower()}",
            "version": "1.0.0",
            "name": "SunSpec testowy",
            "manufacturer": "SIMULATED",
            "device_kind": kind,
            "origin": "SIMULATED",
            "support_level": "EXPERIMENTAL",
            "models": ["SIM"],
            "transports": ["MODBUS_TCP"],
            "addressing": "sunspec",
            "sources": [{"id": "sunspec", "title": "Modele SunSpec", "version": "v2026-04-20"}],
            "polling": {
                "interval_seconds": 10,
                "timeout_seconds": 1,
                "retries": 1,
                "max_block_registers": 125,
            }
            | polling,
            "points": points,
        }
    )


INVERTER = profile(INVERTER_POINTS)
METER = profile(METER_POINTS, kind="METER")


@dataclass
class Env:
    server: SimulatorServer
    plant: Plant
    port: int
    sleeps: list[float] = field(default_factory=list)

    def poller(self, agent_profile: Profile) -> ModbusPoller:
        async def fake_sleep(seconds: float) -> None:
            self.sleeps.append(seconds)

        return ModbusPoller(
            agent_profile,
            Target("127.0.0.1", self.port, 1),
            clock=lambda: NOON_UTC,
            sleep=fake_sleep,
        )


def run(test: Callable[[Env], Awaitable[None]], registers: Registers | None = None) -> None:
    async def go() -> None:
        plant = Plant(PlantConfig(initial_soc=0), now=MIDNIGHT_UTC)
        server = SimulatorServer(
            plant,
            registers or SunSpecRegisterMap([INVERTER, METER]),
            clock=lambda: NOON_UTC,
        )
        port = await server.start("127.0.0.1", 0)
        try:
            await test(Env(server, plant, port))
        finally:
            await server.stop()

    asyncio.run(go())


async def poll(env: Env, agent_profile: Profile) -> PollingRun:
    poller = env.poller(agent_profile)
    try:
        return await poller.poll()
    finally:
        poller.close()


def by_key(result: PollingRun) -> dict[tuple[str, int | None], Reading]:
    return {(r.metric, r.channel): r for r in result.readings}


def expected(plant: Plant, metric: str) -> Decimal:
    value = plant.metrics()[metric]
    return value / 2 if metric in ("pv_string_power", "pv_string_current") else value


def test_reads_inverter_and_meter_from_one_map() -> None:
    async def test(env: Env) -> None:
        for agent_profile in (INVERTER, METER):
            result = await poll(env, agent_profile)
            assert result.result is RunResult.OK, result.errors
            assert len(result.readings) == len(agent_profile.points)
            for reading in result.readings:
                assert reading.quality is Quality.GOOD
                assert reading.origin is Origin.SIMULATED
                assert reading.value is not None
                want = expected(env.plant, reading.metric)
                assert abs(reading.value - want) <= RESOLUTION[reading.unit], reading

    run(test)


def test_discovers_map_at_other_base_address() -> None:
    async def test(env: Env) -> None:
        poller = env.poller(METER)
        try:
            result = await poller.poll()
            assert result.result is RunResult.OK
            assert poller.device_map is not None
            assert poller.device_map.base == 50000
            assert [m.id for m in poller.device_map.models] == [1, 203]
        finally:
            poller.close()

    run(test, SunSpecRegisterMap([METER], base=50000))


def test_point_device_does_not_implement_is_missing_without_error() -> None:
    # Symulator zna tylko licznik; temperatura falownika w modelu 103 nie istnieje — model brak.
    # Drugi przypadek: profil chce trzeciego modułu MPPT, a urządzenie ma dwa.
    extra = point("pv_string_power", 160, "DCW", "W", group="module", channel=3)
    agent = profile([*INVERTER_POINTS, extra])

    async def test(env: Env) -> None:
        result = await poll(env, agent)
        readings = by_key(result)
        third = readings[("pv_string_power", 3)]
        assert (third.quality, third.value, third.error) == (Quality.MISSING, None, None)
        assert readings[("pv_power", None)].quality is Quality.GOOD
        assert result.result is RunResult.PARTIAL
        assert result.errors == []

    run(test)


def test_not_implemented_value_is_missing_not_zero() -> None:
    # Mapa z samym licznikiem: punkty modelu 103, których profil symulatora nie używa,
    # mają wartość „nie zaimplementowano”.
    sim = profile([*METER_POINTS, point("pv_power", 103, "DCW", "W")], kind="METER")
    agent = profile([point("pv_power", 103, "DCW", "W"), point("grid_frequency", 103, "Hz", "Hz")])

    async def test(env: Env) -> None:
        readings = by_key(await poll(env, agent))
        assert readings[("pv_power", None)].quality is Quality.GOOD
        frequency = readings[("grid_frequency", None)]
        assert (frequency.quality, frequency.value, frequency.error) == (
            Quality.MISSING,
            None,
            None,
        )

    run(test, SunSpecRegisterMap([sim]))


def test_model_absent_on_device_is_missing() -> None:
    async def test(env: Env) -> None:
        result = await poll(env, METER)
        assert result.result is RunResult.FAILED
        assert {r.quality for r in result.readings} == {Quality.MISSING}
        assert {r.error for r in result.readings} == {None}

    run(test, SunSpecRegisterMap([INVERTER]))


def test_device_without_sunspec_is_reported() -> None:
    registers_profile = Profile.model_validate(
        INVERTER.model_dump(by_alias=True, mode="json", exclude={"addressing", "points"})
        | {
            "points": [
                {
                    "metric": "pv_power",
                    "status": "UNVERIFIED",
                    "source": "sunspec",
                    "register": {"table": "holding", "address": 0, "type": "u16"},
                    "unit": "W",
                }
            ]
        }
    )

    async def test(env: Env) -> None:
        result = await poll(env, INVERTER)
        assert result.result is RunResult.FAILED
        assert [e.code for e in result.errors] == [ErrorCode.INVALID_RESPONSE]
        assert "nie udostępnia mapy SunSpec" in result.errors[0].detail
        assert all(r.error is ErrorCode.INVALID_RESPONSE for r in result.readings)

    run(test, RegisterMap(registers_profile))


def test_timeout_during_discovery_then_recovery() -> None:
    async def test(env: Env) -> None:
        poller = env.poller(METER)
        try:
            env.server.faults = Faults(no_response=True)
            failed = await poller.poll()
            assert failed.result is RunResult.FAILED
            assert failed.error_code is ErrorCode.TIMEOUT
            assert poller.device_map is None
            env.server.faults = Faults()
            assert (await poller.poll()).result is RunResult.OK
        finally:
            poller.close()

    run(test)


def test_changed_map_is_detected_and_rediscovered() -> None:
    async def test(env: Env) -> None:
        poller = env.poller(METER)
        try:
            assert (await poller.poll()).result is RunResult.OK
            # „Aktualizacja firmware”: model 103 przed licznikiem przesuwa adresy.
            env.server.registers = SunSpecRegisterMap([INVERTER, METER])
            changed = await poller.poll()
            assert changed.result is RunResult.FAILED
            assert changed.error_code is ErrorCode.INVALID_RESPONSE
            assert poller.device_map is None
            assert (await poller.poll()).result is RunResult.OK
        finally:
            poller.close()

    run(test, SunSpecRegisterMap([METER]))


def test_small_block_limit_reads_model_in_parts() -> None:
    agent = profile(METER_POINTS, kind="METER", max_block_registers=20)

    async def test(env: Env) -> None:
        result = await poll(env, agent)
        assert result.result is RunResult.OK
        export = by_key(result)[("grid_export_energy_total", None)].value
        assert export is not None
        assert abs(export - expected(env.plant, "grid_export_energy_total")) <= 1

    run(test)


# --- wykrywanie mapy bez sieci ---------------------------------------------------------------


def fake_device(words: dict[int, int]) -> Callable[[int, int], Awaitable[list[int] | None]]:
    async def read(address: int, count: int) -> list[int] | None:
        keys = range(address, address + count)
        return None if any(k not in words for k in keys) else [words[k] for k in keys]

    return read


def test_discover_without_marker_or_end() -> None:
    assert asyncio.run(discover(fake_device({}))) is None
    endless = {0: 0x5375, 1: 0x6E53} | {a: 1 if a % 2 == 0 else 0 for a in range(2, 400)}
    with pytest.raises(MapError, match="końca"):
        asyncio.run(discover(fake_device(endless)))
    cut = {0: 0x5375, 1: 0x6E53, 2: 1, 3: 66}
    with pytest.raises(MapError, match="nagłówka"):
        asyncio.run(discover(fake_device(cut)))


def test_chunks_cover_model_without_overlap() -> None:
    model = ModelInstance(203, 40002, 105)
    assert chunks(model, 50) == [(40002, 50), (40052, 50), (40102, 7)]
    assert chunks(model, 125) == [(40002, 107)]


def common_map(manufacturer: str) -> dict[int, int]:
    """Znacznik, model 1 z podanym ``Mn`` (dane testowe), koniec mapy."""
    words = {0: 0x5375, 1: 0x6E53, 2: 1, 3: 66} | dict.fromkeys(range(4, 70), 0)
    text = manufacturer.encode("ascii").ljust(32, b"\0")
    words |= {4 + i // 2: int.from_bytes(text[i : i + 2], "big") for i in range(0, 32, 2)}
    return words | {70: 0xFFFF, 71: 0}


def test_simulator_is_recognised_by_common_model_only() -> None:
    simulated = asyncio.run(discover(fake_device(common_map("SIMULATED"))))
    assert simulated is not None
    assert (simulated.manufacturer, simulated.simulated) == ("SIMULATED", True)
    device = asyncio.run(discover(fake_device(common_map("Producent testowy"))))
    assert device is not None
    assert (device.manufacturer, device.simulated) == ("Producent testowy", False)
