"""Pętla agenta (D43): konfiguracja z serwera, zadania połączeń, bufor, wysyłka, heartbeat.

Każde połączenie ma jedno zadanie i jednego klienta Modbus; jego urządzenia są czytane po kolei.
Zmiana konfiguracji restartuje tylko zadania, których dotyczy.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from solargraf_agent import __version__
from solargraf_agent.api import (
    AgentConfig,
    ApiClient,
    ApiUnavailable,
    AuthRejected,
    BatchRejected,
    ConnectionConfig,
)
from solargraf_agent.buffer import Buffer
from solargraf_agent.modbus import ModbusPoller, Target, new_client, utc_now
from solargraf_agent.readings import PollingRun
from solargraf_profiles.catalog import Transport
from solargraf_profiles.model import Profile

log = logging.getLogger("solargraf_agent")

HEARTBEAT_INTERVAL_S = 30.0
CONFIG_INTERVAL_S = 60.0
SEND_INTERVAL_S = 5.0
MODBUS_TCP_PORT = 502

ProfileKey = tuple[str, str]
Sleep = Callable[[float], Awaitable[None]]


def run_payload(device_id: uuid.UUID, run: PollingRun) -> dict[str, Any]:
    """Cykl odczytu w kształcie API ``/api/agent/batches`` (D42)."""
    first = run.errors[0] if run.errors else None
    return {
        "device_id": str(device_id),
        "started_at": run.started_at.isoformat(),
        "finished_at": (run.finished_at or run.started_at).isoformat(),
        "result": run.result.value,
        "error_code": first.code.value if first else None,
        "error_detail": first.detail if first else None,
        "readings": [
            {
                "metric": r.metric,
                "channel": r.channel,
                "value": None if r.value is None else float(r.value),
                "quality": r.quality.value,
                "origin": r.origin.value,
                "received_at": r.received_at.isoformat(),
                "observed_at": r.observed_at.isoformat() if r.observed_at else None,
            }
            for r in run.readings
        ],
    }


@dataclass
class ConnectionWorker:
    """Jedno połączenie fizyczne: wspólny klient, urządzenia odpytywane po kolei."""

    connection: ConnectionConfig
    pollers: list[tuple[uuid.UUID, ModbusPoller]]
    interval_s: float
    buffer: Buffer
    clock: Callable[[], datetime] = utc_now
    sleep: Sleep = asyncio.sleep

    async def poll_cycle(self) -> None:
        for device_id, poller in self.pollers:
            run = await poller.poll()
            await self.buffer.add(run_payload(device_id, run), self.clock())

    async def run_forever(self) -> None:
        try:
            while True:
                await self.poll_cycle()
                await self.sleep(self.interval_s)
        finally:
            self.close()

    def close(self) -> None:
        """Zamyka wspólne połączenie z urządzeniem (wywołanie wielokrotne jest bezpieczne)."""
        if self.pollers:
            self.pollers[0][1].client.close()


@dataclass
class AgentRunner:
    api: ApiClient
    buffer: Buffer
    profiles: dict[ProfileKey, Profile]
    clock: Callable[[], datetime] = utc_now
    sleep: Sleep = asyncio.sleep
    heartbeat_interval_s: float = HEARTBEAT_INTERVAL_S
    config_interval_s: float = CONFIG_INTERVAL_S
    send_interval_s: float = SEND_INTERVAL_S
    workers: dict[uuid.UUID, ConnectionWorker] = field(default_factory=dict)
    _tasks: dict[uuid.UUID, asyncio.Task[None]] = field(default_factory=dict)
    _configs: dict[uuid.UUID, ConnectionConfig] = field(default_factory=dict)
    _etag: str | None = None

    # --- konfiguracja ---

    def build_worker(self, conn: ConnectionConfig) -> ConnectionWorker | None:
        if conn.transport is not Transport.MODBUS_TCP:
            log.warning("Połączenie %s: transport %s nieobsługiwany", conn.id, conn.transport)
            return None
        if not conn.host:
            log.warning("Połączenie %s: brak adresu urządzenia", conn.id)
            return None
        devices: list[tuple[uuid.UUID, Profile]] = []
        for device in conn.devices:
            if not device.enabled:
                continue
            key = (device.profile_id or "", device.profile_version or "")
            profile = self.profiles.get(key)
            if profile is None:
                log.warning("Urządzenie %s: nieznany profil %s@%s — pomijam", device.id, *key)
                continue
            devices.append((device.id, profile))
        if not devices:
            return None
        timeout = conn.timeout_seconds or max(p.polling.timeout_seconds for _, p in devices)
        interval = conn.poll_interval_seconds or max(p.polling.interval_seconds for _, p in devices)
        target = Target(conn.host, conn.port or MODBUS_TCP_PORT, conn.unit_id or 1)
        client = new_client(target, timeout)
        pollers = [
            (
                device_id,
                ModbusPoller(profile, target, clock=self.clock, sleep=self.sleep, client=client),
            )
            for device_id, profile in devices
        ]
        return ConnectionWorker(conn, pollers, interval, self.buffer, self.clock, self.sleep)

    def apply_config(self, config: AgentConfig, *, start: bool = True) -> None:
        wanted = {c.id: c for c in config.connections}
        for conn_id in list(self._configs):
            if wanted.get(conn_id) != self._configs[conn_id]:
                self._stop(conn_id)
        for conn_id, conn in wanted.items():
            if conn_id in self._configs:
                continue
            self._configs[conn_id] = conn
            worker = self.build_worker(conn)
            if worker is None:
                continue
            self.workers[conn_id] = worker
            if start:
                self._tasks[conn_id] = asyncio.create_task(worker.run_forever())

    def _stop(self, conn_id: uuid.UUID) -> None:
        self._configs.pop(conn_id, None)
        worker = self.workers.pop(conn_id, None)
        task = self._tasks.pop(conn_id, None)
        if task is not None:
            task.cancel()  # zadanie zamyka połączenie w ``finally``
        elif worker is not None:
            worker.close()

    async def aclose(self) -> None:
        """Zatrzymuje zadania połączeń i zamyka połączenia z urządzeniami."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for worker in self.workers.values():
            worker.close()
        self._tasks.clear()
        self.workers.clear()
        self._configs.clear()

    async def sync_config(self, *, start: bool = True) -> None:
        config, self._etag = await self.api.config(self._etag)
        if config is not None:
            self.apply_config(config, start=start)
            total, active = len(config.connections), len(self.workers)
            log.info("Konfiguracja: %d połączeń, %d aktywnych", total, active)

    # --- wysyłka ---

    async def send_pending(self) -> int:
        """Wysyła zaległe partie od najstarszej; zwraca liczbę wysłanych cykli."""
        dropped = await self.buffer.prune(self.clock())
        if dropped:
            log.warning("Bufor: usunięto %d cykli starszych niż limit (utracone dane)", dropped)
        sent = 0
        while (batch := await self.buffer.next_batch()) is not None:
            try:
                await self.api.send_batch(batch.batch_id, batch.runs)
            except BatchRejected as exc:
                # Ponowienie nic nie zmieni (np. urządzenie odpięte od agenta) — nie blokujemy
                # kolejki.
                log.error("Partia %s odrzucona przez serwer (%s) — usuwam", batch.batch_id, exc)
            await self.buffer.remove(batch)
            sent += len(batch.runs)
        return sent

    # --- pętle ---

    async def _every(self, interval: float, action: Callable[[], Awaitable[Any]]) -> None:
        while True:
            try:
                await action()
            except ApiUnavailable as exc:
                log.warning("Serwer niedostępny (%s) — ponowię", exc)
            except AuthRejected:
                log.error("Serwer odrzucił token agenta — sprawdź SOLARGRAF_AGENT_TOKEN")
            await self.sleep(interval)

    async def run(self) -> None:
        loops = [
            asyncio.create_task(
                self._every(self.heartbeat_interval_s, lambda: self.api.heartbeat(__version__))
            ),
            asyncio.create_task(self._every(self.config_interval_s, self.sync_config)),
            asyncio.create_task(self._every(self.send_interval_s, self.send_pending)),
        ]
        try:
            await asyncio.gather(*loops)
        finally:
            for task in loops:
                task.cancel()
            await asyncio.gather(*loops, return_exceptions=True)
            await self.aclose()
