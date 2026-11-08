"""Symulator (D40): model, mapa rejestrów i serwer Modbus TCP czytany niezależnym klientem."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ConnectionException, ModbusIOException

from solargraf_profiles.codec import decode, encode
from solargraf_profiles.loader import load_profile
from solargraf_profiles.model import Profile, RegisterTable
from solargraf_simulator.cli import main
from solargraf_simulator.plant import Plant, PlantConfig
from solargraf_simulator.registers import ModbusException, RegisterMap
from solargraf_simulator.server import Faults, SimulatorServer

PROFILE_PATH = Path(__file__).resolve().parents[2] / "profiles" / "simulated.hybrid-inverter.yaml"
NOON_UTC = datetime(2026, 6, 21, 11, 0, tzinfo=UTC)  # 12:00 czasu słonecznego (UTC+1)
MIDNIGHT_UTC = datetime(2026, 6, 21, 23, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def profile() -> Profile:
    return load_profile(PROFILE_PATH)


class TestPlant:
    def test_pv_follows_daily_curve(self) -> None:
        plant = Plant(PlantConfig(), now=NOON_UTC)
        assert plant.pv_power(NOON_UTC) == pytest.approx(6000)
        assert plant.pv_power(MIDNIGHT_UTC) == 0

    def test_power_balance_holds_all_day(self) -> None:
        plant = Plant(PlantConfig(), now=MIDNIGHT_UTC)
        for minute in range(0, 24 * 60, 7):
            at = MIDNIGHT_UTC + timedelta(minutes=minute)
            plant.advance(at)
            balance = plant.pv_power(at) + plant.battery_power(at) + plant.grid_power(at)
            assert balance == pytest.approx(plant.load_power(at))
            assert 10 <= float(plant.metrics()["battery_soc"]) <= 100

    def test_counters_only_grow_and_are_deterministic(self) -> None:
        def run() -> list[dict[str, Decimal]]:
            plant = Plant(PlantConfig(), now=MIDNIGHT_UTC)
            out = []
            for hour in range(1, 25):
                plant.advance(MIDNIGHT_UTC + timedelta(hours=hour))
                out.append(plant.metrics())
            return out

        first, second = run(), run()
        assert first == second
        for key in ("pv_energy_total", "grid_import_energy_total", "grid_export_energy_total"):
            values = [m[key] for m in first]
            assert values == sorted(values)
        assert first[-1]["pv_energy_total"] > 0

    def test_noon_charges_battery_and_exports(self) -> None:
        plant = Plant(PlantConfig(), now=NOON_UTC)
        m = plant.metrics()
        assert m["battery_power"] == Decimal(-3000)  # minus = ładowanie
        assert m["grid_power"] < 0  # minus = eksport

    def test_reset_counters_and_clock_going_back(self) -> None:
        plant = Plant(PlantConfig(), now=NOON_UTC)
        plant.advance(NOON_UTC + timedelta(hours=1))
        energy = plant.pv_energy_wh
        plant.advance(NOON_UTC)  # cofnięcie zegara nie zmienia stanu
        assert plant.pv_energy_wh == energy
        plant.reset_counters()
        assert plant.metrics()["pv_energy_total"] == 0

    def test_requires_timezone(self) -> None:
        with pytest.raises(ValueError, match="strefę"):
            Plant(PlantConfig(), now=datetime(2026, 1, 1))


class TestRegisterMap:
    def test_gap_and_outside_profile_are_address_errors(self, profile: Profile) -> None:
        regs, metrics = RegisterMap(profile), Plant(PlantConfig(), now=NOON_UTC).metrics()
        for table, address, count in [
            (RegisterTable.INPUT, 28, 1),  # za ostatnim punktem
            (RegisterTable.INPUT, 27, 2),  # blok wychodzi poza mapę
            (RegisterTable.HOLDING, 0, 1),  # profil nie używa holding
        ]:
            with pytest.raises(ModbusException) as exc:
                regs.read(metrics, table, address, count)
            assert exc.value.code == ModbusException.ILLEGAL_DATA_ADDRESS

    def test_block_limit_from_profile(self, profile: Profile) -> None:
        regs, metrics = RegisterMap(profile), Plant(PlantConfig(), now=NOON_UTC).metrics()
        with pytest.raises(ModbusException) as exc:
            regs.read(metrics, RegisterTable.INPUT, 0, profile.polling.max_block_registers + 1)
        assert exc.value.code == ModbusException.ILLEGAL_DATA_VALUE

    def test_value_outside_register_type_is_device_failure(self, profile: Profile) -> None:
        metrics = Plant(PlantConfig(), now=NOON_UTC).metrics()
        metrics["load_power"] = Decimal(70_000)  # u16 W
        with pytest.raises(ModbusException) as exc:
            RegisterMap(profile).read(metrics, RegisterTable.INPUT, 0, 28)
        assert exc.value.code == ModbusException.SERVER_DEVICE_FAILURE


type ClientTest = Callable[[SimulatorServer, AsyncModbusTcpClient], Awaitable[None]]


def run_with_client(profile: Profile, test: ClientTest, faults: Faults | None = None) -> None:
    async def go() -> None:
        plant = Plant(PlantConfig(), now=NOON_UTC)
        server = SimulatorServer(plant, RegisterMap(profile), faults=faults, clock=lambda: NOON_UTC)
        port = await server.start("127.0.0.1", 0)
        client = AsyncModbusTcpClient("127.0.0.1", port=port, timeout=0.5, retries=0)
        try:
            assert await client.connect()
            await test(server, client)
        finally:
            client.close()
            await server.stop()

    asyncio.run(go())


class TestServer:
    def test_reads_decode_to_model_values(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            result = await client.read_input_registers(0, count=28, device_id=1)
            assert not result.isError(), result
            words = result.registers
            expected = server.plant.metrics()
            for p in profile.points:
                if p.reg is None:
                    continue
                got = decode(p, words[p.reg.address : p.reg.address + p.reg.type.registers])
                assert got == decode(p, encode(p, expected[p.metric])), p.metric
            # sign: invert — urządzenie podaje +ładowanie, po dekodowaniu minus = ładowanie.
            assert words[10] == 3000
            battery = next(p for p in profile.points if p.metric == "battery_power")
            assert decode(battery, [words[10]]) == Decimal(-3000)

        run_with_client(profile, test)

    def test_errors_are_modbus_exceptions_not_zero(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            outside = await client.read_input_registers(28, count=1, device_id=1)
            assert outside.isError()
            assert outside.exception_code == ModbusException.ILLEGAL_DATA_ADDRESS
            wrong_unit = await client.read_input_registers(0, count=1, device_id=7)
            assert wrong_unit.exception_code == 0x0B
            coils = await client.read_coils(0, count=1, device_id=1)
            assert coils.exception_code == ModbusException.ILLEGAL_FUNCTION

        run_with_client(profile, test)

    def test_injected_exception_code(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            result = await client.read_input_registers(0, count=1, device_id=1)
            assert result.exception_code == ModbusException.SERVER_DEVICE_FAILURE
            server.faults.exception_code = None
            assert not (await client.read_input_registers(0, count=1, device_id=1)).isError()

        run_with_client(profile, test, Faults(exception_code=ModbusException.SERVER_DEVICE_FAILURE))

    def test_no_response_is_timeout(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            with pytest.raises(ModbusIOException):
                await client.read_input_registers(0, count=1, device_id=1)

        run_with_client(profile, test, Faults(no_response=True))

    def test_dropped_connection(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            with pytest.raises((ModbusIOException, ConnectionException)):
                await client.read_input_registers(0, count=1, device_id=1)

        run_with_client(profile, test, Faults(drop_connection=True))

    def test_single_client_rejects_second(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            assert not (await client.read_input_registers(0, count=1, device_id=1)).isError()
            assert server.port is not None
            port = server.port
            second = AsyncModbusTcpClient("127.0.0.1", port=port, timeout=0.5, retries=0)
            try:
                await second.connect()
                with pytest.raises((ModbusIOException, ConnectionException)):
                    await second.read_input_registers(0, count=1, device_id=1)
            finally:
                second.close()
            # Pierwszy klient działa dalej.
            assert not (await client.read_input_registers(0, count=1, device_id=1)).isError()

        run_with_client(profile, test, Faults(single_client=True))

    def test_counter_reset_is_visible_to_client(self, profile: Profile) -> None:
        async def test(server: SimulatorServer, client: AsyncModbusTcpClient) -> None:
            server.plant.pv_energy_wh = 1_000_000.0
            before = await client.read_input_registers(4, count=2, device_id=1)
            server.plant.reset_counters()
            after = await client.read_input_registers(4, count=2, device_id=1)
            energy = next(p for p in profile.points if p.metric == "pv_energy_total")
            assert decode(energy, before.registers) == Decimal(1_000_000)
            assert decode(energy, after.registers) == 0

        run_with_client(profile, test)


def test_cli_rejects_invalid_profile(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    broken = tmp_path / "broken.yaml"
    broken.write_text("id: [", encoding="utf-8")
    assert main([str(broken), "--port", "0"]) == 1
    assert "BŁĄD" in capsys.readouterr().err
