"""Odpytywanie urządzenia przez Modbus TCP (D41). Agent jest jedynym klientem urządzenia.

Jedno połączenie na urządzenie, bloki czytane po kolei. Ponawiamy tylko błędy przejściowe
(timeout, zerwane połączenie); wyjątek Modbus to odpowiedź urządzenia, więc nie ponawiamy.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ModbusException

from solargraf_agent.plan import Block, plan_blocks
from solargraf_agent.readings import (
    ErrorCode,
    Origin,
    PollError,
    PollingRun,
    Quality,
    Reading,
    RunResult,
)
from solargraf_profiles.catalog import METRICS
from solargraf_profiles.codec import CodecError, decode
from solargraf_profiles.model import DataPoint, Profile, ProfileOrigin, RegisterTable

BACKOFF_START_S = 0.5

# Granice wiarygodności w jednostkach kanonicznych; poza nimi jakość INVALID.
PLAUSIBLE: dict[str, tuple[Decimal, Decimal]] = {
    "battery_soc": (Decimal(0), Decimal(100)),
}


@dataclass(frozen=True)
class Target:
    host: str
    port: int = 502
    unit_id: int = 1


def utc_now() -> datetime:
    return datetime.now(UTC)


class _BlockFailed(Exception):
    def __init__(self, error: PollError) -> None:
        super().__init__(error.detail)
        self.error = error


class ModbusPoller:
    def __init__(
        self,
        profile: Profile,
        target: Target,
        *,
        clock: Callable[[], datetime] = utc_now,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.profile = profile
        self.target = target
        self.blocks = plan_blocks(profile)
        self.clock = clock
        self.sleep = sleep
        self.origin = (
            Origin.SIMULATED if profile.origin is ProfileOrigin.SIMULATED else Origin.DEVICE
        )
        # Ponawianie robimy sami (z odstępami); wbudowane w pymodbus wyłączone.
        self.client = AsyncModbusTcpClient(
            target.host,
            port=target.port,
            timeout=profile.polling.timeout_seconds,
            retries=0,
            reconnect_delay=0,
        )

    def close(self) -> None:
        self.client.close()

    async def poll(self) -> PollingRun:
        run = PollingRun(started_at=self.clock())
        for block in self.blocks:
            try:
                words = await self._read_with_retries(block)
            except _BlockFailed as failed:
                run.errors.append(failed.error)
                run.readings.extend(self._missing(p, failed.error.code) for p in block.points)
                continue
            run.readings.extend(self._decode(block, p, words) for p in block.points)
        run.finished_at = self.clock()
        run.result = _result(run)
        return run

    # --- odczyt ---

    async def _read_with_retries(self, block: Block) -> list[int]:
        polling = self.profile.polling
        delay = BACKOFF_START_S
        attempt = 0
        while True:
            try:
                return await self._read_once(block)
            except _BlockFailed as failed:
                transient = failed.error.code in (ErrorCode.TIMEOUT, ErrorCode.CONNECTION_LOST)
                if not transient or attempt >= polling.retries:
                    raise
            attempt += 1
            await self.sleep(min(delay, polling.interval_seconds))
            delay *= 2

    async def _read_once(self, block: Block) -> list[int]:
        if not self.client.connected and not await self.client.connect():
            raise _BlockFailed(
                PollError(ErrorCode.CONNECTION_REFUSED, "Nie można połączyć się z urządzeniem.")
            )
        read = (
            self.client.read_holding_registers
            if block.table is RegisterTable.HOLDING
            else self.client.read_input_registers
        )
        try:
            result = await read(block.address, count=block.count, device_id=self.target.unit_id)
        except ModbusException:
            if self.client.connected:
                raise _BlockFailed(
                    PollError(ErrorCode.TIMEOUT, "Urządzenie nie odpowiedziało w czasie.")
                ) from None
            raise _BlockFailed(
                PollError(ErrorCode.CONNECTION_LOST, "Połączenie z urządzeniem zostało przerwane.")
            ) from None
        if result.isError():
            code = getattr(result, "exception_code", None)
            raise _BlockFailed(
                PollError(ErrorCode.MODBUS_EXCEPTION, "Urządzenie odrzuciło odczyt.", code)
            )
        words = list(getattr(result, "registers", []))
        if len(words) != block.count:
            raise _BlockFailed(
                PollError(ErrorCode.INVALID_RESPONSE, "Odpowiedź urządzenia ma złą długość.")
            )
        return words

    # --- odczyty ---

    def _reading(
        self,
        point: DataPoint,
        value: Decimal | None,
        quality: Quality,
        error: ErrorCode | None = None,
    ) -> Reading:
        channel = "" if point.channel is None else f"[{point.channel}]"
        return Reading(
            metric=point.metric,
            channel=point.channel,
            value=value,
            unit=METRICS[point.metric].canonical_unit.value,
            quality=quality,
            received_at=self.clock(),
            origin=self.origin,
            source_reference=f"{self.profile.id}@{self.profile.version}:{point.metric}{channel}",
            error=error,
        )

    def _missing(self, point: DataPoint, code: ErrorCode) -> Reading:
        return self._reading(point, None, Quality.MISSING, code)

    def _decode(self, block: Block, point: DataPoint, words: list[int]) -> Reading:
        try:
            value = decode(point, block.words_for(point, words))
        except CodecError:
            return self._reading(point, None, Quality.INVALID, ErrorCode.INVALID_RESPONSE)
        bounds = PLAUSIBLE.get(point.metric)
        if bounds is not None and not bounds[0] <= value <= bounds[1]:
            # Wartość odczytana, ale niewiarygodna — nie przekazujemy jej dalej jako liczby.
            return self._reading(point, None, Quality.INVALID)
        return self._reading(point, value, Quality.GOOD)


def _result(run: PollingRun) -> RunResult:
    if not run.readings or run.ok_points == 0:
        return RunResult.FAILED
    if run.failed_points == 0:
        return RunResult.OK
    return RunResult.PARTIAL
