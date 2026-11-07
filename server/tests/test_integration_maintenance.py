"""Utrzymanie bazy (D49): partycje i retencja na PostgreSQL — w CI.

Test używa miesięcy daleko od bieżących (2020 i 2029+), żeby nie ruszać partycji innych testów.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.maintenance import Retention, apply_retention, ensure_partitions

pytestmark = pytest.mark.skipif(
    os.environ.get("SOLARGRAF_TEST_DB") != "1", reason="wymaga SOLARGRAF_TEST_DB=1 i bazy"
)

SERVER_DIR = Path(__file__).resolve().parent.parent
POLICY = Retention(raw_days=90, m5_days=730, runs_days=90, months_ahead=2)


def _run[T](work: Callable[[AsyncSession], Awaitable[T]]) -> T:
    async def go() -> T:
        engine = create_engine(Settings())  # type: ignore[call-arg]
        try:
            async with create_sessionmaker(engine)() as db:
                return await work(db)
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _sql(statement: str, **params: object) -> list[tuple[Any, ...]]:
    async def work(db: AsyncSession) -> list[tuple[Any, ...]]:
        result = await db.execute(text(statement), params)
        select = statement.lstrip().upper().startswith("SELECT")
        rows = [tuple(r) for r in result.all()] if select else []
        await db.commit()
        return rows

    return _run(work)


@pytest.fixture(scope="module", autouse=True)
def _schema() -> None:
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "alembic", "-c", str(SERVER_DIR / "alembic.ini"), "upgrade", "head"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr


@pytest.fixture
def device() -> tuple[uuid.UUID, uuid.UUID]:
    _sql(
        "TRUNCATE aggregates, aggregate_dirty, measurements, polling_runs, agent_batches, devices, "
        "connections, agents, membership_sites, sites, audit_events, auth_sessions, setup_tokens, "
        "memberships, users, organizations CASCADE"
    )
    for (name,) in _sql(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid "
        "JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'measurements' "
        "AND (c.relname LIKE 'measurements_y2020%' OR c.relname >= 'measurements_y2029')"
    ):
        _sql(f"DROP TABLE {name}")
    org, site, conn, dev = (uuid.uuid4() for _ in range(4))
    _sql("INSERT INTO organizations (id, name) VALUES (:o, 'O')", o=org)
    _sql(
        "INSERT INTO sites (id, organization_id, name, timezone) "
        "VALUES (:s, :o, 'S', 'Europe/Warsaw')",
        s=site,
        o=org,
    )
    _sql(
        "INSERT INTO connections (id, site_id, name, transport) VALUES (:c, :s, 'L', 'MODBUS_TCP')",
        c=conn,
        s=site,
    )
    _sql(
        "INSERT INTO devices (id, site_id, connection_id, name, kind, enabled, "
        "freshness_threshold_seconds) VALUES (:d, :s, :c, 'F', 'INVERTER', true, 300)",
        d=dev,
        s=site,
        c=conn,
    )
    return site, dev


def measure(site: uuid.UUID, dev: uuid.UUID, at: datetime) -> None:
    _sql(
        "INSERT INTO measurements (site_id, device_id, metric, channel, received_at, value, "
        "quality, origin, batch_id) VALUES (:s, :d, 'pv_power', 0, :t, 1, 'GOOD', 'SIMULATED', :b)",
        s=site,
        d=dev,
        t=at,
        b=uuid.uuid4(),
    )


def located(at: datetime) -> list[tuple[Any, ...]]:
    return _sql("SELECT tableoid::regclass::text FROM measurements WHERE received_at = :t", t=at)


class TestPartitions:
    def test_creates_future_months_and_moves_rows_from_default(
        self, device: tuple[uuid.UUID, uuid.UUID]
    ) -> None:
        site, dev = device
        waiting = datetime(2029, 2, 10, 12, 0, tzinfo=UTC)
        measure(site, dev, waiting)
        assert located(waiting) == [("measurements_default",)]
        report = _run(
            lambda db: ensure_partitions(db, datetime(2029, 1, 15, tzinfo=UTC), months_ahead=2)
        )
        assert report.created == [
            "measurements_y2029m01",
            "measurements_y2029m02",
            "measurements_y2029m03",
        ]
        assert report.moved_rows == 1
        assert located(waiting) == [("measurements_y2029m02",)]
        # Ponowne uruchomienie niczego nie zmienia; nowe wiersze trafiają do nowej partycji.
        again = _run(lambda db: ensure_partitions(db, datetime(2029, 1, 15, tzinfo=UTC), 2))
        assert again.created == []
        later = datetime(2029, 3, 31, 23, 59, tzinfo=UTC)
        measure(site, dev, later)
        assert located(later) == [("measurements_y2029m03",)]


class TestRetention:
    def test_drops_expired_partition_and_old_rows(
        self, device: tuple[uuid.UUID, uuid.UUID]
    ) -> None:
        site, dev = device
        _sql(
            "CREATE TABLE measurements_y2020m01 PARTITION OF measurements "
            "FOR VALUES FROM ('2020-01-01T00:00:00+00:00') TO ('2020-02-01T00:00:00+00:00')"
        )
        old = datetime(2020, 1, 15, tzinfo=UTC)
        stray = datetime(2019, 6, 1, tzinfo=UTC)  # w partycji domyślnej
        measure(site, dev, old)
        measure(site, dev, stray)
        _sql(
            "INSERT INTO aggregates (site_id, device_id, metric, channel, resolution, "
            "bucket_start, avg, min, max, last, samples, good_samples, coverage) VALUES "
            "(:s, :d, 'pv_power', 0, '5m', :t, 1, 1, 1, 1, 1, 1, 1), "
            "(:s, :d, 'pv_power', 0, '1h', :t, 1, 1, 1, 1, 1, 1, 1)",
            s=site,
            d=dev,
            t=old,
        )
        report = _run(lambda db: apply_retention(db, datetime.now(UTC), POLICY))
        assert "measurements_y2020m01" in report.dropped
        assert report.deleted["measurements_default"] >= 1
        assert located(old) == []
        assert located(stray) == []
        # Agregaty godzinowe zostają bez limitu, 5-minutowe starsze niż 2 lata znikają.
        assert _sql("SELECT resolution FROM aggregates") == [("1h",)]

    def test_pending_aggregates_keep_raw_data(self, device: tuple[uuid.UUID, uuid.UUID]) -> None:
        site, dev = device
        _sql(
            "CREATE TABLE measurements_y2020m02 PARTITION OF measurements "
            "FOR VALUES FROM ('2020-02-01T00:00:00+00:00') TO ('2020-03-01T00:00:00+00:00')"
        )
        old = datetime(2020, 2, 10, 5, 0, tzinfo=UTC)
        measure(site, dev, old)
        _sql("INSERT INTO aggregate_dirty (device_id, hour_start) VALUES (:d, :h)", d=dev, h=old)
        report = _run(lambda db: apply_retention(db, datetime.now(UTC), POLICY))
        assert "measurements_y2020m02" in report.skipped
        assert report.dropped == []
        assert located(old) == [("measurements_y2020m02",)]
