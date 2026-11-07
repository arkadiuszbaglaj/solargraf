"""Usługa ``solargraf-worker`` — przeliczanie agregatów (D46) i reguły alarmów (D55).

Worker nie łączy się z urządzeniami; czyta tylko bazę. Co ``INTERVAL_S`` sekund pobiera godziny
oznaczone przy przyjęciu partii (``aggregate_dirty``), przelicza dla nich agregaty 5 min i 1 h
z surowych pomiarów, a potem doby (w strefie instalacji) z agregatów godzinowych. Przeliczenie
jest idempotentne: usuwa agregaty przedziału i wstawia je od nowa.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import delete, insert, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from solargraf_server import alarm_rules
from solargraf_server.aggregation import (
    H1,
    M5,
    Sample,
    Summary,
    combine,
    group_by_bucket,
    local_day_start,
    next_local_day,
    summarize,
)
from solargraf_server.config import Settings
from solargraf_server.db import create_engine, create_sessionmaker
from solargraf_server.maintenance import Retention, next_maintenance, run_maintenance
from solargraf_server.models import (
    Aggregate,
    AggregateDirty,
    Connection,
    Device,
    Measurement,
    Quality,
    Resolution,
    Site,
)
from solargraf_server.profiles import ProfileCatalog

log = logging.getLogger("solargraf_server.worker")

INTERVAL_S = 60
BATCH_SIZE = 200

SeriesKey = tuple[str, int]  # (metryka, kanał)


@dataclass(frozen=True)
class DeviceContext:
    site_id: uuid.UUID
    tz: ZoneInfo
    # Interwał odczytu [s]: z połączenia, inaczej z profilu; brak = pokrycie 0.
    interval_s: float


async def _device_contexts(
    db: AsyncSession, catalog: ProfileCatalog, device_ids: set[uuid.UUID]
) -> dict[uuid.UUID, DeviceContext]:
    rows = await db.execute(
        select(
            Device.id,
            Device.site_id,
            Device.profile_id,
            Device.profile_version,
            Connection.poll_interval_seconds,
            Site.timezone,
        )
        .join(Connection, Connection.id == Device.connection_id)
        .join(Site, Site.id == Device.site_id)
        .where(Device.id.in_(device_ids))
    )
    contexts: dict[uuid.UUID, DeviceContext] = {}
    for device_id, site_id, profile_id, profile_version, conn_interval, tz in rows.all():
        interval = conn_interval
        if interval is None and profile_id is not None and profile_version is not None:
            profile = catalog.get(profile_id, profile_version)
            interval = profile.polling.interval_seconds if profile else None
        if interval is None:
            log.warning("Urządzenie %s bez interwału odczytu — pokrycie 0", device_id)
        contexts[device_id] = DeviceContext(site_id, ZoneInfo(tz), float(interval or 0))
    return contexts


def _row(
    ctx: DeviceContext,
    device_id: uuid.UUID,
    key: SeriesKey,
    resolution: Resolution,
    start: datetime,
    s: Summary,
) -> dict[str, object]:
    return {
        "site_id": ctx.site_id,
        "device_id": device_id,
        "metric": key[0],
        "channel": key[1],
        "resolution": resolution.value,
        "bucket_start": start,
        "avg": s.avg,
        "min": s.min,
        "max": s.max,
        "last": s.last,
        "samples": s.samples,
        "good_samples": s.good_samples,
        "coverage": s.coverage,
    }


async def recompute_hour(
    db: AsyncSession, device_id: uuid.UUID, hour: datetime, ctx: DeviceContext
) -> None:
    """Agregaty 5 min i 1 h jednej godziny urządzenia z surowych pomiarów."""
    end = hour + H1
    rows = await db.execute(
        select(
            Measurement.metric,
            Measurement.channel,
            Measurement.received_at,
            Measurement.value,
            Measurement.quality,
        )
        .where(
            Measurement.device_id == device_id,
            Measurement.received_at >= hour,
            Measurement.received_at < end,
        )
        .order_by(Measurement.received_at)
    )
    series: dict[SeriesKey, list[Sample]] = defaultdict(list)
    for metric, channel, at, value, quality in rows.all():
        series[(metric, channel)].append(Sample(at, value, quality == Quality.GOOD))

    await db.execute(
        delete(Aggregate).where(
            Aggregate.device_id == device_id,
            Aggregate.resolution.in_([Resolution.M5.value, Resolution.H1.value]),
            Aggregate.bucket_start >= hour,
            Aggregate.bucket_start < end,
        )
    )
    values: list[dict[str, object]] = []
    for key, samples in series.items():
        for start, group in group_by_bucket(samples, M5).items():
            summary = summarize(group, M5, ctx.interval_s)
            values.append(_row(ctx, device_id, key, Resolution.M5, start, summary))
        summary = summarize(samples, H1, ctx.interval_s)
        values.append(_row(ctx, device_id, key, Resolution.H1, hour, summary))
    if values:
        await db.execute(insert(Aggregate), values)


async def recompute_day(
    db: AsyncSession, device_id: uuid.UUID, day: datetime, ctx: DeviceContext
) -> None:
    """Agregat doby lokalnej (23/24/25 h) z agregatów godzinowych."""
    end = next_local_day(day, ctx.tz)
    hours = await db.scalars(
        select(Aggregate)
        .where(
            Aggregate.device_id == device_id,
            Aggregate.resolution == Resolution.H1.value,
            Aggregate.bucket_start >= day,
            Aggregate.bucket_start < end,
        )
        .order_by(Aggregate.bucket_start)
    )
    series: dict[SeriesKey, list[Summary]] = defaultdict(list)
    for h in hours:
        series[(h.metric, h.channel)].append(
            Summary(h.avg, h.min, h.max, h.last, h.samples, h.good_samples, h.coverage)
        )
    await db.execute(
        delete(Aggregate).where(
            Aggregate.device_id == device_id,
            Aggregate.resolution == Resolution.D1.value,
            Aggregate.bucket_start == day,
        )
    )
    length = end - day
    values = [
        _row(ctx, device_id, key, Resolution.D1, day, combine(parts, length, ctx.interval_s))
        for key, parts in series.items()
    ]
    if values:
        await db.execute(insert(Aggregate), values)


async def process_dirty(db: AsyncSession, catalog: ProfileCatalog, limit: int = BATCH_SIZE) -> int:
    """Przelicza do ``limit`` oznaczonych godzin w jednej transakcji. Zwraca ich liczbę."""
    dirty = (
        await db.execute(
            select(AggregateDirty.device_id, AggregateDirty.hour_start, AggregateDirty.marked_at)
            .order_by(AggregateDirty.device_id, AggregateDirty.hour_start)
            .limit(limit)
        )
    ).all()
    if not dirty:
        return 0
    contexts = await _device_contexts(db, catalog, {d for d, _, _ in dirty})
    days: set[tuple[uuid.UUID, datetime]] = set()
    for device_id, hour, _ in dirty:
        ctx = contexts.get(device_id)
        if ctx is None:  # urządzenie usunięte — wiersz zniknie kaskadowo
            continue
        await recompute_hour(db, device_id, hour, ctx)
        days.add((device_id, local_day_start(hour, ctx.tz)))
    for device_id, day in sorted(days):
        await recompute_day(db, device_id, day, contexts[device_id])
    # Wiersz oznaczony ponownie w trakcie przeliczenia (nowszy marked_at) zostaje na kolejny cykl.
    for device_id, hour, marked_at in dirty:
        await db.execute(
            delete(AggregateDirty).where(
                AggregateDirty.device_id == device_id,
                AggregateDirty.hour_start == hour,
                AggregateDirty.marked_at <= marked_at,
            )
        )
    await db.commit()
    return len(dirty)


async def run_cycle(maker: async_sessionmaker[AsyncSession], catalog: ProfileCatalog) -> int:
    """Przelicza wszystkie oznaczone godziny (partiami). Zwraca łączną liczbę."""
    total = 0
    while True:
        async with maker() as db:
            done = await process_dirty(db, catalog)
        total += done
        if done < BATCH_SIZE:
            return total


async def run(settings: Settings, interval_s: float = INTERVAL_S) -> None:
    catalog = ProfileCatalog.load(settings.profiles_dir)
    engine = create_engine(settings)
    maker = create_sessionmaker(engine)
    policy = Retention(
        raw_days=settings.retention_raw_days,
        m5_days=settings.retention_m5_days,
        runs_days=settings.retention_runs_days,
        months_ahead=settings.partition_months_ahead,
        alarms_days=settings.retention_alarms_days,
    )
    log.info("Worker agregatów uruchomiony (co %ss)", interval_s)
    maintenance_at = datetime.now(UTC)  # przy starcie, potem codziennie o 03:00 UTC
    try:
        while True:
            now = datetime.now(UTC)
            if now >= maintenance_at:
                try:
                    async with maker() as db:
                        await run_maintenance(db, now, policy)
                except (SQLAlchemyError, OSError) as exc:
                    log.warning("Utrzymanie bazy nieudane: %s", type(exc).__name__)
                maintenance_at = next_maintenance(now)
            try:
                done = await run_cycle(maker, catalog)
                if done:
                    log.info("Przeliczono godzin: %d", done)
            except (SQLAlchemyError, OSError) as exc:
                # Szczegóły połączenia nie trafiają do logu; ponowienie w kolejnym cyklu.
                log.warning("Cykl agregatów nieudany: %s", type(exc).__name__)
            try:
                async with maker() as db:
                    changes = await alarm_rules.evaluate(db, datetime.now(UTC))
                if changes.opened or changes.closed:
                    log.info("Alarmy: otwarte %d, zamknięte %d", changes.opened, changes.closed)
            except (SQLAlchemyError, OSError) as exc:
                log.warning("Sprawdzenie alarmów nieudane: %s", type(exc).__name__)
            await asyncio.sleep(interval_s)
    finally:
        await engine.dispose()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    asyncio.run(run(Settings()))  # type: ignore[call-arg]  # pola z env
