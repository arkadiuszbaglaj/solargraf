"""Minimalny serwer Modbus TCP symulatora: tylko odczyt (funkcje 0x03 i 0x04), D40.

Wstrzykiwanie błędów (``Faults``) można zmieniać w trakcie działania — testy agenta przełączają
je między odczytami.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol

from solargraf_profiles.model import RegisterTable
from solargraf_simulator.plant import Plant
from solargraf_simulator.registers import ModbusException

MBAP = struct.Struct(">HHHB")  # transakcja, protokół, długość, unit id
FUNCTIONS = {0x03: RegisterTable.HOLDING, 0x04: RegisterTable.INPUT}
GATEWAY_TARGET_FAILED = 0x0B
MAX_PDU = 253


class Registers(Protocol):
    """Źródło rejestrów: mapa z profilu (``RegisterMap``) albo mapa SunSpec."""

    def read(
        self, metrics: dict[str, Decimal], table: RegisterTable, address: int, count: int
    ) -> list[int]: ...


@dataclass
class Faults:
    no_response: bool = False  # klient dostaje timeout
    exception_code: int | None = None  # każda odpowiedź to wyjątek Modbus o tym kodzie
    drop_connection: bool = False  # zerwanie połączenia po otrzymaniu żądania
    single_client: bool = False  # drugi równoczesny klient jest rozłączany (jak loggery Wi-Fi)


def utc_now() -> datetime:
    return datetime.now(UTC)


class SimulatorServer:
    def __init__(
        self,
        plant: Plant,
        registers: Registers,
        *,
        unit_id: int = 1,
        faults: Faults | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.plant = plant
        self.registers = registers
        self.unit_id = unit_id
        self.faults = faults or Faults()
        self.clock = clock
        self._clients = 0
        self.port: int | None = None
        self._server: asyncio.Server | None = None

    async def start(self, host: str = "127.0.0.1", port: int = 5020) -> int:
        """Uruchamia serwer; zwraca faktyczny port (``port=0`` = dowolny wolny, dla testów)."""
        self._server = await asyncio.start_server(self._handle, host, port)
        self.port = int(self._server.sockets[0].getsockname()[1])
        return self.port

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.faults.single_client and self._clients >= 1:
            writer.close()
            return
        self._clients += 1
        try:
            while True:
                header = await reader.readexactly(MBAP.size)
                tid, protocol, length, unit = MBAP.unpack(header)
                if protocol != 0 or not 2 <= length <= MAX_PDU + 1:
                    return  # ramka niezgodna z Modbus TCP — rozłączamy
                pdu = await reader.readexactly(length - 1)
                if self.faults.drop_connection:
                    return
                if self.faults.no_response:
                    continue  # połączenie otwarte, odpowiedzi brak — klient dostaje timeout
                response = self._respond(unit, pdu)
                writer.write(MBAP.pack(tid, 0, len(response) + 1, unit) + response)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self._clients -= 1
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()

    def _respond(self, unit: int, pdu: bytes) -> bytes:
        function = pdu[0]
        if self.faults.exception_code is not None:
            return bytes([function | 0x80, self.faults.exception_code])
        if unit != self.unit_id:
            return bytes([function | 0x80, GATEWAY_TARGET_FAILED])
        table = FUNCTIONS.get(function)
        if table is None or len(pdu) != 5:
            return bytes([function | 0x80, ModbusException.ILLEGAL_FUNCTION])
        address, count = struct.unpack(">HH", pdu[1:])
        self.plant.advance(self.clock())
        try:
            words = self.registers.read(self.plant.metrics(), table, address, count)
        except ModbusException as exc:
            return bytes([function | 0x80, exc.code])
        return bytes([function, 2 * count]) + b"".join(w.to_bytes(2, "big") for w in words)
