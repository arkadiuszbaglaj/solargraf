"""Odpytywanie urządzenia przez Modbus TCP (D41). Agent jest jedynym klientem urządzenia.

Jedno połączenie na urządzenie, bloki czytane po kolei. Ponawiamy tylko błędy przejściowe
(timeout, zerwane połączenie); wyjątek Modbus to odpowiedź urządzenia, więc nie ponawiamy.

Profil SunSpec (D59): przy pierwszym odczycie agent wykrywa mapę modeli urządzenia i ją
zapamiętuje; potem czyta w całości tylko modele potrzebne profilowi. Nagłówek modelu niezgodny
z zapamiętaną mapą (np. po aktualizacji firmware) unieważnia mapę — kolejny cykl wykrywa ją
od nowa. Punkt, którego urządzenie nie ma albo nie implementuje, to brak danych bez kodu błędu.
"""

from __future__ import annotations

import asyncio
import logging
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
from solargraf_agent.sunspec_map import DeviceMap, MapError, ModelInstance, chunks, discover, locate
from solargraf_profiles import sunspec
from solargraf_profiles.catalog import METRICS, is_plausible
from solargraf_profiles.codec import CodecError, decode, decode_sunspec
from solargraf_profiles.model import Addressing, DataPoint, Profile, ProfileOrigin, RegisterTable

log = logging.getLogger(__name__)

BACKOFF_START_S = 0.5


# Granice wiarygodności w jednostkach kanonicznych; poza nimi jakość INVALID.
@dataclass(frozen=True)
class Target:
    host: str
    port: int = 502
    unit_id: int = 1


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_client(target: Target, timeout_seconds: float) -> AsyncModbusTcpClient:
    # Ponawianie robimy sami (z odstępami); wbudowane w pymodbus wyłączone.
    return AsyncModbusTcpClient(
        target.host, port=target.port, timeout=timeout_seconds, retries=0, reconnect_delay=0
    )


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
        client: AsyncModbusTcpClient | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        """``client`` — wspólny klient połączenia (D43: jedno połączenie na urządzenie fizyczne)."""
        self.profile = profile
        self.target = target
        self.blocks = plan_blocks(profile) if profile.addressing is Addressing.REGISTERS else []
        self.device_map: DeviceMap | None = None
        self.clock = clock
        self.sleep = sleep
        self.origin = (
            Origin.SIMULATED if profile.origin is ProfileOrigin.SIMULATED else Origin.DEVICE
        )
        self._profile_origin = self.origin
        self._owns_client = client is None
        self.client = client or new_client(
            target, timeout_seconds or profile.polling.timeout_seconds
        )

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    async def poll(self) -> PollingRun:
        run = PollingRun(started_at=self.clock())
        if self.profile.addressing is Addressing.SUNSPEC:
            await self._poll_sunspec(run)
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

    # --- SunSpec ---

    async def _poll_sunspec(self, run: PollingRun) -> None:
        points = [p for p in self.profile.points if p.sunspec is not None]
        device_map = self.device_map or await self._discover(run, points)
        if device_map is None:
            return
        for model_id in self.profile.sunspec_models:
            model_points = [p for p in points if p.sunspec and p.sunspec.model == model_id]
            model = device_map.find(model_id)
            if model is None:
                run.readings.extend(self._missing(p) for p in model_points)
                continue
            words = await self._read_model(run, model, model_points)
            if words is not None:
                run.readings.extend(self._decode_sunspec(p, model, words) for p in model_points)

    async def _discover(self, run: PollingRun, points: list[DataPoint]) -> DeviceMap | None:
        error: PollError | None = None
        try:
            found = await discover(self._read_or_reject)
        except _BlockFailed as failed:
            found, error = None, failed.error
        except MapError:
            found = None
            error = PollError(
                ErrorCode.INVALID_RESPONSE, "Mapa SunSpec urządzenia jest niepoprawna."
            )
        if found is None:
            error = error or PollError(
                ErrorCode.INVALID_RESPONSE, "Urządzenie nie udostępnia mapy SunSpec."
            )
            run.errors.append(error)
            run.readings.extend(self._missing(p, error.code) for p in points)
            return None
        absent = [m for m in self.profile.sunspec_models if found.find(m) is None]
        if absent:
            log.warning("Profil %s: urządzenie nie ma modeli SunSpec %s", self.profile.id, absent)
        self.device_map = found
        # Symulator SunSpec przedstawia się w modelu 1 — jego dane nigdy nie są DEVICE.
        self.origin = Origin.SIMULATED if found.simulated else self._profile_origin
        return found

    async def _read_or_reject(self, address: int, count: int) -> list[int] | None:
        """Odczyt podczas wykrywania: wyjątek Modbus = brak rejestrów pod tym adresem."""
        try:
            return await self._read_with_retries(Block(RegisterTable.HOLDING, address, count, ()))
        except _BlockFailed as failed:
            if failed.error.code is ErrorCode.MODBUS_EXCEPTION:
                return None
            raise

    async def _read_model(
        self, run: PollingRun, model: ModelInstance, points: list[DataPoint]
    ) -> dict[int, int] | None:
        words: dict[int, int] = {}
        limit = self.profile.polling.max_block_registers
        error: PollError | None = None
        for address, count in chunks(model, limit):
            try:
                block = await self._read_with_retries(
                    Block(RegisterTable.HOLDING, address, count, ())
                )
            except _BlockFailed as failed:
                error = failed.error
                break
            words.update(zip(range(address, address + count), block, strict=True))
        header = (words.get(model.start), words.get(model.start + 1))
        if error is None and header != (model.id, model.length):
            self.device_map = None
            error = PollError(ErrorCode.INVALID_RESPONSE, "Mapa SunSpec urządzenia zmieniła się.")
        if error is not None:
            run.errors.append(error)
            run.readings.extend(self._missing(p, error.code) for p in points)
            return None
        return words

    def _decode_sunspec(
        self, point: DataPoint, model: ModelInstance, words: dict[int, int]
    ) -> Reading:
        try:
            where = locate(point, model)
            if where is None:
                return self._missing(point)
            values = [words[a] for a in range(where.value, where.value + where.size)]
            sf_word = None if where.scale_factor is None else words[where.scale_factor]
            value = decode_sunspec(point, values, sf_word)
        except (CodecError, sunspec.SunSpecError):
            return self._reading(point, None, Quality.INVALID, ErrorCode.INVALID_RESPONSE)
        if value is None:
            return self._missing(point)  # urządzenie nie implementuje punktu albo skali
        return self._checked(point, value)

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

    def _missing(self, point: DataPoint, code: ErrorCode | None = None) -> Reading:
        return self._reading(point, None, Quality.MISSING, code)

    def _decode(self, block: Block, point: DataPoint, words: list[int]) -> Reading:
        try:
            value = decode(point, block.words_for(point, words))
        except CodecError:
            return self._reading(point, None, Quality.INVALID, ErrorCode.INVALID_RESPONSE)
        return self._checked(point, value)

    def _checked(self, point: DataPoint, value: Decimal) -> Reading:
        if not is_plausible(point.metric, value):
            # Wartość odczytana, ale fizycznie niemożliwa (D75) — nie przekazujemy jej jako liczby.
            return self._reading(point, None, Quality.INVALID)
        return self._reading(point, value, Quality.GOOD)


def _result(run: PollingRun) -> RunResult:
    if not run.readings or run.ok_points == 0:
        return RunResult.FAILED
    if run.failed_points == 0:
        return RunResult.OK
    return RunResult.PARTIAL
