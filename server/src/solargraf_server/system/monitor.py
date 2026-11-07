"""Cykl monitora serwera w ``worker`` (D60): próbka metryk, stan składników, ocena stabilności.

Składniki sprawdzamy bez gniazda Dockera: API przez jego endpoint gotowości (HTTP), proxy przez
połączenie TCP, agenta z heartbeatu w bazie. Baza i worker działają, skoro ten kod zapisuje
wynik — ich awarię wykrywa API (brak świeżej oceny = worker niedostępny).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.device_status import AGENT_HEARTBEAT_TIMEOUT
from solargraf_server.models import Agent, AgentMode
from solargraf_server.models.system import (
    STATUS_ROW_ID,
    SystemComponent,
    SystemMetricSample,
    SystemStatus,
)
from solargraf_server.system import host
from solargraf_server.system.stability import ComponentState, Evaluation, level_of

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class MonitorTargets:
    """Adresy w sieci Compose; None — składnik nie jest monitorowany (np. dev bez proxy)."""

    api_url: str | None = None  # np. http://api:8000/api/health/ready
    proxy_address: str | None = None  # np. proxy:443
    timeout_s: float = 2.0


async def http_ok(url: str, timeout_s: float) -> bool:
    """GET przez zwykłe HTTP; sukces = odpowiedź 2xx/3xx w czasie ``timeout_s``."""
    parts = urlsplit(url)
    if parts.scheme != "http" or not parts.hostname:
        raise ValueError("monitor obsługuje tylko adresy http://host[:port]/ścieżka")
    port = parts.port or 80
    request = (
        f"GET {parts.path or '/'} HTTP/1.1\r\nHost: {parts.hostname}\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    try:
        async with asyncio.timeout(timeout_s):
            reader, writer = await asyncio.open_connection(parts.hostname, port)
            try:
                writer.write(request)
                await writer.drain()
                status_line = await reader.readline()
            finally:
                writer.close()
    except (OSError, TimeoutError):
        return False
    fields = status_line.split()
    return len(fields) >= 2 and fields[1][:1] in (b"2", b"3")


async def tcp_ok(address: str, timeout_s: float) -> bool:
    hostname, _, port = address.rpartition(":")
    if not hostname or not port.isdigit():
        raise ValueError("adres proxy w postaci host:port")
    try:
        async with asyncio.timeout(timeout_s):
            _, writer = await asyncio.open_connection(hostname, int(port))
            writer.close()
    except (OSError, TimeoutError):
        return False
    return True


def _state(ok: bool) -> ComponentState:
    return ComponentState.UP if ok else ComponentState.DOWN


async def agent_state(db: AsyncSession, now: datetime) -> ComponentState:
    """Lokalny agent: UP przy świeżym heartbeacie; bez włączonego agenta — UNKNOWN."""
    beats = (
        await db.scalars(
            select(Agent.last_heartbeat_at).where(
                Agent.enabled.is_(True), Agent.mode == AgentMode.LOCAL.value
            )
        )
    ).all()
    if not beats:
        return ComponentState.UNKNOWN
    fresh = any(b is not None and now - b <= AGENT_HEARTBEAT_TIMEOUT for b in beats)
    return _state(fresh)


async def check_components(
    db: AsyncSession, targets: MonitorTargets, now: datetime
) -> dict[str, ComponentState]:
    states = {"db": ComponentState.UP, "worker": ComponentState.UP}
    states["api"] = (
        _state(await http_ok(targets.api_url, targets.timeout_s))
        if targets.api_url
        else ComponentState.UNKNOWN
    )
    states["proxy"] = (
        _state(await tcp_ok(targets.proxy_address, targets.timeout_s))
        if targets.proxy_address
        else ComponentState.UNKNOWN
    )
    states["agent"] = await agent_state(db, now)
    return states


async def db_size(db: AsyncSession) -> float | None:
    size = await db.scalar(text("SELECT pg_database_size(current_database())"))
    return None if size is None else float(size)


async def run_monitor(
    db: AsyncSession, sampler: host.HostSampler, targets: MonitorTargets, now: datetime
) -> Evaluation:
    """Jeden pomiar: zapis próbek, stanu składników i oceny. Zwraca ocenę (dla logu i testów)."""
    values = sampler.sample()
    values[host.DB_SIZE] = await db_size(db)
    components = await check_components(db, targets, now)

    await db.execute(
        insert(SystemMetricSample)
        .values([{"sampled_at": now, "metric": m, "value": values.get(m)} for m in host.METRICS])
        .on_conflict_do_nothing()
    )
    for name, state in components.items():
        row = {
            "component": name,
            "state": state.value,
            "checked_at": now,
            "last_ok_at": now if state is ComponentState.UP else None,
        }
        statement = insert(SystemComponent).values(row)
        update = {"state": state.value, "checked_at": now}
        if state is ComponentState.UP:
            update["last_ok_at"] = now
        await db.execute(statement.on_conflict_do_update(index_elements=["component"], set_=update))

    status = await db.get(SystemStatus, STATUS_ROW_ID)
    evaluation = Evaluation.from_json(status.conditions if status else None)
    evaluation.step(values, components, now)
    reasons = evaluation.reasons()
    payload = {
        "evaluated_at": now,
        "level": level_of(reasons).value,
        "reasons": [
            {
                "code": r.code,
                "severity": r.severity.value,
                "message": r.message,
                "since": r.since.isoformat() if r.since else None,
            }
            for r in reasons
        ],
        "conditions": evaluation.to_json(),
    }
    await db.execute(
        insert(SystemStatus)
        .values(id=STATUS_ROW_ID, **payload)
        .on_conflict_do_update(index_elements=["id"], set_=payload)
    )
    await db.commit()
    return evaluation
