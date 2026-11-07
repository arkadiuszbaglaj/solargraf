"""Bufor offline agenta w SQLite (D43).

Każdy cykl odczytu trafia tu przed wysyłką i znika dopiero po potwierdzeniu serwera.
Partia ma trwały ``batch_id`` zapisany w buforze — ponowienie po zerwanym połączeniu wysyła
dokładnie te same cykle pod tym samym identyfikatorem, więc serwer niczego nie duplikuje.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

MAX_AGE = timedelta(days=7)
DEFAULT_BATCH_RUNS = 50

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    batch_id TEXT,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_runs_batch ON runs (batch_id, id);
"""


@dataclass(frozen=True)
class PendingBatch:
    batch_id: uuid.UUID
    row_ids: list[int]
    runs: list[dict[str, Any]]


class Buffer:
    def __init__(self, path: Path, *, max_age: timedelta = MAX_AGE) -> None:
        self.path = path
        self.max_age = max_age
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._lock = asyncio.Lock()

    def close(self) -> None:
        self._db.close()

    async def _run[T](self, fn: Any, *args: Any) -> T:  # noqa: ANN401 — wywołanie w wątku
        async with self._lock:
            result: T = await asyncio.to_thread(fn, *args)
            return result

    # --- operacje ---

    async def add(self, run: dict[str, Any], now: datetime) -> None:
        await self._run(self._add, run, now)

    def _add(self, run: dict[str, Any], now: datetime) -> None:
        self._db.execute(
            "INSERT INTO runs (created_at, payload) VALUES (?, ?)",
            (now.isoformat(), json.dumps(run)),
        )

    async def next_batch(self, max_runs: int = DEFAULT_BATCH_RUNS) -> PendingBatch | None:
        """Najstarsza niewysłana partia; jeśli nie ma — nowa z najstarszych cykli."""
        return await self._run(self._next_batch, max_runs)

    def _next_batch(self, max_runs: int) -> PendingBatch | None:
        db = self._db
        row = db.execute(
            "SELECT batch_id FROM runs WHERE batch_id IS NOT NULL ORDER BY id LIMIT 1"
        ).fetchone()
        if row is None:
            ids = [r[0] for r in db.execute("SELECT id FROM runs ORDER BY id LIMIT ?", (max_runs,))]
            if not ids:
                return None
            batch_id = str(uuid.uuid4())
            db.executemany(
                "UPDATE runs SET batch_id = ? WHERE id = ?", [(batch_id, i) for i in ids]
            )
        else:
            batch_id = row[0]
        rows = db.execute(
            "SELECT id, payload FROM runs WHERE batch_id = ? ORDER BY id", (batch_id,)
        ).fetchall()
        return PendingBatch(
            uuid.UUID(batch_id), [r[0] for r in rows], [json.loads(r[1]) for r in rows]
        )

    async def remove(self, batch: PendingBatch) -> None:
        await self._run(self._remove, str(batch.batch_id))

    def _remove(self, batch_id: str) -> None:
        self._db.execute("DELETE FROM runs WHERE batch_id = ?", (batch_id,))

    async def prune(self, now: datetime) -> int:
        """Usuwa cykle starsze niż limit; zwraca liczbę utraconych cykli (do logu)."""
        return await self._run(self._prune, now)

    def _prune(self, now: datetime) -> int:
        cursor = self._db.execute(
            "DELETE FROM runs WHERE created_at < ?", ((now - self.max_age).isoformat(),)
        )
        return cursor.rowcount

    async def count(self) -> int:
        return await self._run(self._count)

    def _count(self) -> int:
        return int(self._db.execute("SELECT count(*) FROM runs").fetchone()[0])
