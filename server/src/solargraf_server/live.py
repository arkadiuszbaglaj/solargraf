"""Dane na żywo instalacji: ``GET /api/sites/{id}/live`` — Server-Sent Events (D50).

- Po połączeniu zdarzenie ``snapshot``: urządzenia instalacji z metrykami z profilu i ostatni
  odczyt każdej metryki (z ostatnich ``SNAPSHOT_WINDOW``), także ``MISSING``/``INVALID``.
- Potem zdarzenia ``readings`` publikowane przez ingest partii agenta (magistrala w procesie,
  bez brokera — API działa jako jeden proces).
- Co ``PING_S`` komentarz podtrzymujący połączenie. Strumień kończy się po ``MAX_STREAM`` (albo
  gdy klient nie nadąża) — przeglądarka łączy się ponownie, a serwer jeszcze raz sprawdza sesję
  i uprawnienia oraz wysyła świeżą migawkę.

Wartości instalacji (np. „produkcja PV”) wylicza UI z odczytów urządzeń — serwer niczego nie
sumuje ani nie uzupełnia. Brak odczytu to brak danych, nigdy zero.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import Counter
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from solargraf_profiles.catalog import DeviceKind
from solargraf_server import authz
from solargraf_server.auth.deps import current_auth, utcnow
from solargraf_server.config import Settings
from solargraf_server.devices import DeviceMetric, device_metrics
from solargraf_server.models import NO_CHANNEL, Device, Measurement
from solargraf_server.profiles import ProfileCatalog
from solargraf_server.sites import NOT_FOUND

router = APIRouter(prefix="/api/sites", tags=["live"])

MAX_STREAM = timedelta(minutes=15)
PING_S = 15.0
QUEUE_SIZE = 256
MAX_STREAMS_PER_SESSION = 4
SNAPSHOT_WINDOW = timedelta(hours=24)
RETRY_MS = 5000


class LiveReading(BaseModel):
    device_id: uuid.UUID
    metric: str
    channel: int | None
    value: float | None
    quality: str
    origin: str
    received_at: datetime


class LiveDevice(BaseModel):
    id: uuid.UUID
    name: str
    kind: DeviceKind
    enabled: bool
    freshness_threshold_seconds: int
    metrics: list[DeviceMetric]


class LiveSnapshot(BaseModel):
    site_id: uuid.UUID
    timezone: str
    server_time: datetime
    devices: list[LiveDevice]
    readings: list[LiveReading]


class LiveUpdate(BaseModel):
    readings: list[LiveReading]


class TooManyStreamsError(Exception):
    """Sesja ma już ``MAX_STREAMS_PER_SESSION`` otwartych strumieni."""


@dataclass(eq=False)
class Subscriber:
    site_id: uuid.UUID
    session_id: uuid.UUID
    queue: asyncio.Queue[LiveUpdate] = field(
        default_factory=lambda: asyncio.Queue(maxsize=QUEUE_SIZE)
    )
    # Klient nie nadążał i zgubił zdarzenia — strumień się kończy, ponowne połączenie da migawkę.
    lagged: bool = False


class LiveBus:
    """Publikacja odczytów do subskrybentów instalacji w obrębie jednego procesu API."""

    def __init__(self) -> None:
        self._subscribers: dict[uuid.UUID, set[Subscriber]] = {}
        self._per_session: Counter[uuid.UUID] = Counter()

    def subscribe(self, site_id: uuid.UUID, session_id: uuid.UUID) -> Subscriber:
        if self._per_session[session_id] >= MAX_STREAMS_PER_SESSION:
            raise TooManyStreamsError
        sub = Subscriber(site_id, session_id)
        self._subscribers.setdefault(site_id, set()).add(sub)
        self._per_session[session_id] += 1
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        subs = self._subscribers.get(sub.site_id)
        if subs is None or sub not in subs:
            return
        subs.discard(sub)
        if not subs:
            del self._subscribers[sub.site_id]
        self._per_session[sub.session_id] -= 1
        if self._per_session[sub.session_id] <= 0:
            del self._per_session[sub.session_id]

    def subscribers(self, site_id: uuid.UUID) -> int:
        return len(self._subscribers.get(site_id, ()))

    def publish(self, site_id: uuid.UUID, readings: list[LiveReading]) -> None:
        if not readings:
            return
        update = LiveUpdate(readings=readings)
        for sub in self._subscribers.get(site_id, ()):
            try:
                sub.queue.put_nowait(update)
            except asyncio.QueueFull:
                sub.lagged = True


def sse(event: str, data: BaseModel) -> bytes:
    # JSON z Pydantic nie zawiera znaków nowej linii — jedna linia ``data:`` wystarcza.
    return f"event: {event}\ndata: {data.model_dump_json()}\n\n".encode()


async def events(
    bus: LiveBus,
    sub: Subscriber,
    snapshot: LiveSnapshot,
    *,
    max_stream: timedelta = MAX_STREAM,
    ping_s: float = PING_S,
) -> AsyncIterator[bytes]:
    """Treść strumienia. Zawsze wypisuje subskrybenta — także po rozłączeniu klienta."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_stream.total_seconds()
    try:
        yield f"retry: {RETRY_MS}\n".encode() + sse("snapshot", snapshot)
        while not sub.lagged:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            try:
                update = await asyncio.wait_for(sub.queue.get(), min(ping_s, remaining))
            except TimeoutError:
                yield b": ping\n\n"
                continue
            yield sse("readings", update)
    finally:
        bus.unsubscribe(sub)


async def load_snapshot(
    db: AsyncSession,
    site_id: uuid.UUID,
    timezone: str,
    catalog: ProfileCatalog | None,
    now: datetime,
) -> LiveSnapshot:
    devices = list(
        await db.scalars(
            select(Device).where(Device.site_id == site_id).order_by(Device.name, Device.id)
        )
    )
    live_devices = []
    for device in devices:
        profile = None
        if catalog is not None and device.profile_id and device.profile_version:
            profile = catalog.get(device.profile_id, device.profile_version)
        live_devices.append(
            LiveDevice(
                id=device.id,
                name=device.name,
                kind=DeviceKind(device.kind),
                enabled=device.enabled,
                freshness_threshold_seconds=device.freshness_threshold_seconds,
                metrics=device_metrics(profile),
            )
        )
    m = Measurement
    rows = await db.execute(
        select(m.device_id, m.metric, m.channel, m.value, m.quality, m.origin, m.received_at)
        .where(m.site_id == site_id, m.received_at >= now - SNAPSHOT_WINDOW)
        .distinct(m.device_id, m.metric, m.channel)
        .order_by(m.device_id, m.metric, m.channel, m.received_at.desc())
    )
    readings = [
        LiveReading(
            device_id=device_id,
            metric=metric,
            channel=None if channel == NO_CHANNEL else channel,
            value=value,
            quality=quality,
            origin=origin,
            received_at=received_at,
        )
        for device_id, metric, channel, value, quality, origin, received_at in rows.all()
    ]
    return LiveSnapshot(
        site_id=site_id,
        timezone=timezone,
        server_time=now,
        devices=live_devices,
        readings=readings,
    )


@router.get(
    "/{site_id}/live",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def live(site_id: uuid.UUID, request: Request) -> StreamingResponse:
    # Bez zależności ``DbSession``: sesja bazy nie może być trzymana przez cały strumień.
    bus: LiveBus = request.app.state.live_bus
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    settings: Settings = request.app.state.settings
    catalog: ProfileCatalog | None = getattr(request.app.state, "profiles", None)
    async with maker() as db:
        auth = await current_auth(request, db, settings)
        try:
            access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
        except authz.NotFoundError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
        try:
            # Subskrypcja przed migawką — odczyt przyjęty w międzyczasie nie zginie.
            sub = bus.subscribe(site_id, auth.session.id)
        except TooManyStreamsError:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, "Za dużo otwartych widoków na żywo."
            ) from None
        try:
            snapshot = await load_snapshot(db, site_id, access.site.timezone, catalog, utcnow())
        except BaseException:
            bus.unsubscribe(sub)
            raise
    return StreamingResponse(
        events(bus, sub, snapshot, max_stream=MAX_STREAM, ping_s=PING_S),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
