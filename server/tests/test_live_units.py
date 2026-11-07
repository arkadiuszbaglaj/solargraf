"""Magistrala i strumień SSE na żywo (D50) — bez bazy."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from solargraf_server import live
from solargraf_server.live import LiveBus, LiveReading, LiveSnapshot, TooManyStreamsError, events

SITE = uuid.uuid4()
NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


def reading(value: float | None = 1500.0, quality: str = "GOOD") -> LiveReading:
    return LiveReading(
        device_id=uuid.uuid4(),
        metric="pv_power",
        channel=None,
        value=value,
        quality=quality,
        origin="SIMULATED",
        received_at=NOW,
    )


def snapshot() -> LiveSnapshot:
    return LiveSnapshot(
        site_id=SITE, timezone="Europe/Warsaw", server_time=NOW, devices=[], readings=[reading()]
    )


def parse(chunk: bytes) -> tuple[str, dict[str, object]]:
    lines = dict(
        line.split(": ", 1) for line in chunk.decode().strip().splitlines() if ": " in line
    )
    return lines["event"], json.loads(lines["data"])


def test_publish_reaches_only_subscribers_of_the_site() -> None:
    bus = LiveBus()
    mine = bus.subscribe(SITE, uuid.uuid4())
    other = bus.subscribe(uuid.uuid4(), uuid.uuid4())
    bus.publish(SITE, [reading()])
    assert mine.queue.qsize() == 1
    assert other.queue.qsize() == 0
    bus.publish(SITE, [])  # pusta lista niczego nie wysyła
    assert mine.queue.qsize() == 1


def test_streams_per_session_are_limited_and_released() -> None:
    bus = LiveBus()
    session = uuid.uuid4()
    subs = [bus.subscribe(SITE, session) for _ in range(live.MAX_STREAMS_PER_SESSION)]
    with pytest.raises(TooManyStreamsError):
        bus.subscribe(SITE, session)
    bus.unsubscribe(subs[0])
    bus.unsubscribe(subs[0])  # drugi raz bez skutku
    bus.subscribe(SITE, session)
    assert bus.subscribers(SITE) == live.MAX_STREAMS_PER_SESSION


def test_full_queue_marks_subscriber_as_lagged() -> None:
    bus = LiveBus()
    sub = bus.subscribe(SITE, uuid.uuid4())
    for _ in range(live.QUEUE_SIZE + 1):
        bus.publish(SITE, [reading()])
    assert sub.lagged


def test_stream_sends_snapshot_updates_pings_and_ends() -> None:
    async def go() -> list[bytes]:
        bus = LiveBus()
        sub = bus.subscribe(SITE, uuid.uuid4())
        chunks: list[bytes] = []
        stream = events(bus, sub, snapshot(), max_stream=timedelta(seconds=0.3), ping_s=0.1)
        async for chunk in stream:
            chunks.append(chunk)
            if len(chunks) == 1:
                bus.publish(SITE, [reading(None, "MISSING")])
        assert bus.subscribers(SITE) == 0
        return chunks

    chunks = asyncio.run(go())
    assert chunks[0].startswith(b"retry: ")
    first = chunks[0].split(b"\n", 1)[1]
    event, data = parse(first)
    assert event == "snapshot"
    assert data["timezone"] == "Europe/Warsaw"
    event, data = parse(chunks[1])
    assert event == "readings"
    readings = data["readings"]
    assert isinstance(readings, list)
    # Brak odczytu zostaje brakiem — nigdy zerem.
    assert readings[0]["value"] is None
    assert readings[0]["quality"] == "MISSING"
    assert b": ping\n\n" in chunks[2:]


def test_lagged_stream_ends_after_snapshot() -> None:
    async def go() -> int:
        bus = LiveBus()
        sub = bus.subscribe(SITE, uuid.uuid4())
        sub.lagged = True
        count = 0
        async for _ in events(bus, sub, snapshot(), max_stream=timedelta(seconds=5)):
            count += 1
        return count

    assert asyncio.run(go()) == 1
