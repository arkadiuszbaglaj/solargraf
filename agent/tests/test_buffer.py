"""Bufor offline agenta (D43): kolejność, trwały identyfikator partii, limit 7 dni."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from solargraf_agent.buffer import MAX_AGE, Buffer

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)


def with_buffer(path: Path, test: Callable[[Buffer], Awaitable[None]]) -> None:
    async def go() -> None:
        buffer = Buffer(path)
        try:
            await test(buffer)
        finally:
            buffer.close()

    asyncio.run(go())


def test_empty_buffer_has_no_batch(tmp_path: Path) -> None:
    async def test(buffer: Buffer) -> None:
        assert await buffer.next_batch() is None
        assert await buffer.count() == 0

    with_buffer(tmp_path / "b.sqlite3", test)


def test_oldest_first_and_batch_is_stable_until_removed(tmp_path: Path) -> None:
    async def test(buffer: Buffer) -> None:
        for i in range(5):
            await buffer.add({"n": i}, T0 + timedelta(seconds=i))
        first = await buffer.next_batch(max_runs=2)
        assert first is not None
        assert first.runs == [{"n": 0}, {"n": 1}]
        # Bez potwierdzenia serwera ta sama partia wraca z tym samym identyfikatorem.
        again = await buffer.next_batch(max_runs=3)
        assert again == first
        await buffer.remove(first)
        second = await buffer.next_batch(max_runs=10)
        assert second is not None
        assert second.batch_id != first.batch_id
        assert second.runs == [{"n": 2}, {"n": 3}, {"n": 4}]
        await buffer.remove(second)
        assert await buffer.count() == 0

    with_buffer(tmp_path / "b.sqlite3", test)


def test_batch_id_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite3"
    seen = []

    async def before(buffer: Buffer) -> None:
        await buffer.add({"n": 1}, T0)
        seen.append(await buffer.next_batch())

    async def after(buffer: Buffer) -> None:
        await buffer.add({"n": 2}, T0)
        assert await buffer.next_batch() == seen[0]

    with_buffer(path, before)
    with_buffer(path, after)


def test_seven_days_offline_loses_nothing_older_is_pruned(tmp_path: Path) -> None:
    async def test(buffer: Buffer) -> None:
        await buffer.add({"n": "old"}, T0)
        await buffer.add({"n": "new"}, T0 + timedelta(days=1))
        assert await buffer.prune(T0 + MAX_AGE) == 0
        assert await buffer.count() == 2
        assert await buffer.prune(T0 + MAX_AGE + timedelta(seconds=1)) == 1
        batch = await buffer.next_batch()
        assert batch is not None
        assert batch.runs == [{"n": "new"}]

    with_buffer(tmp_path / "b.sqlite3", test)
