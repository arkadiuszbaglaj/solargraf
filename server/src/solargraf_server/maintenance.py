"""Utrzymanie bazy (D49): kolejne partycje pomiarów i retencja (O8). Uruchamia ``worker``.

- Partycje miesięczne ``measurements_yYYYYmMM`` (granice w UTC) tworzone na ``months_ahead``
  miesięcy do przodu. Wiersze z partycji domyślnej z tego miesiąca są przenoszone w tej samej
  transakcji (inaczej PostgreSQL odmówi utworzenia partycji).
- Surowe pomiary: usuwana cała partycja, gdy jej miesiąc jest w całości starszy niż retencja;
  starsze wiersze partycji domyślnej — ``DELETE`` porcjami. Nic nie jest usuwane, dopóki starsze
  godziny czekają na przeliczenie agregatów (``aggregate_dirty``).
- Agregaty 5 min, ``polling_runs`` i ``agent_batches`` — ``DELETE`` porcjami. Agregaty
  godzinowe i dobowe bez limitu.
- Alarmy zamknięte dawniej niż retencja — ``DELETE`` porcjami; otwarte nigdy (D55).

Nazwy tabel w SQL to stałe albo nazwy partycji zbudowane z dat — nigdy dane wejściowe.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("solargraf_server.maintenance")

DEFAULT_PARTITION = "measurements_default"
BATCH = 10_000
MAINTENANCE_HOUR_UTC = 3
_NAME = re.compile(r"^measurements_y(\d{4})m(\d{2})$")


def month_start(day: date) -> date:
    return date(day.year, day.month, 1)


def next_month(day: date) -> date:
    return date(day.year + day.month // 12, day.month % 12 + 1, 1)


def partition_name(month: date) -> str:
    return f"measurements_y{month.year:04d}m{month.month:02d}"


def partition_month(name: str) -> date | None:
    m = _NAME.match(name)
    return date(int(m[1]), int(m[2]), 1) if m else None


def utc(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def months_to_ensure(now: datetime, months_ahead: int) -> list[date]:
    """Bieżący miesiąc (UTC) i ``months_ahead`` kolejnych."""
    month = month_start(now.astimezone(UTC).date())
    out = []
    for _ in range(months_ahead + 1):
        out.append(month)
        month = next_month(month)
    return out


def expired_partitions(names: list[str], cutoff: datetime) -> list[str]:
    """Partycje, których cały miesiąc kończy się nie później niż ``cutoff``."""
    out = []
    for name in sorted(names):
        month = partition_month(name)
        if month is not None and utc(next_month(month)) <= cutoff:
            out.append(name)
    return out


def next_maintenance(now: datetime) -> datetime:
    """Najbliższa 03:00 UTC po ``now``."""
    at = now.astimezone(UTC).replace(hour=MAINTENANCE_HOUR_UTC, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


@dataclass
class Retention:
    raw_days: int
    m5_days: int
    runs_days: int
    months_ahead: int
    alarms_days: int = 365
    system_days: int = 30


@dataclass
class Report:
    created: list[str] = field(default_factory=list)
    moved_rows: int = 0
    dropped: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    deleted: dict[str, int] = field(default_factory=dict)


async def _partitions(db: AsyncSession) -> list[str]:
    rows = await db.execute(
        text(
            "SELECT c.relname FROM pg_inherits i "
            "JOIN pg_class c ON c.oid = i.inhrelid "
            "JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'measurements'"
        )
    )
    return [name for (name,) in rows.all()]


async def ensure_partitions(db: AsyncSession, now: datetime, months_ahead: int) -> Report:
    report = Report()
    existing = set(await _partitions(db))
    for month in months_to_ensure(now, months_ahead):
        name = partition_name(month)
        if name in existing:
            continue
        lower, upper = utc(month).isoformat(), utc(next_month(month)).isoformat()
        bounds = {"lo": utc(month), "hi": utc(next_month(month))}
        waiting = await db.scalar(
            text(
                f"SELECT count(*) FROM {DEFAULT_PARTITION} "  # noqa: S608 — stała nazwa
                "WHERE received_at >= :lo AND received_at < :hi"
            ),
            bounds,
        )
        if not waiting:
            await db.execute(
                text(
                    f"CREATE TABLE {name} PARTITION OF measurements "
                    f"FOR VALUES FROM ('{lower}') TO ('{upper}')"
                )
            )
        else:
            # Przeniesienie wierszy z partycji domyślnej, potem dołączenie nowej partycji.
            await db.execute(
                text(
                    f"CREATE TABLE {name} "
                    "(LIKE measurements INCLUDING DEFAULTS INCLUDING CONSTRAINTS)"
                )
            )
            await db.execute(
                text(
                    f"WITH moved AS (DELETE FROM {DEFAULT_PARTITION} "  # noqa: S608 — nazwy z dat
                    "WHERE received_at >= :lo AND received_at < :hi RETURNING *) "
                    f"INSERT INTO {name} SELECT * FROM moved"
                ),
                bounds,
            )
            await db.execute(
                text(
                    f"ALTER TABLE measurements ATTACH PARTITION {name} "
                    f"FOR VALUES FROM ('{lower}') TO ('{upper}')"
                )
            )
            report.moved_rows += int(waiting)
        await db.commit()
        report.created.append(name)
    return report


# Usuwanie porcjami: klucz → (tabela, warunek z :c). Tylko stałe, bez danych wejściowych.
_DELETES: dict[str, tuple[str, str]] = {
    DEFAULT_PARTITION: (DEFAULT_PARTITION, "received_at < :c"),
    "aggregates_5m": ("aggregates", "resolution = '5m' AND bucket_start < :c"),
    "polling_runs": ("polling_runs", "started_at < :c"),
    "agent_batches": ("agent_batches", "received_at < :c"),
    "alarms": ("alarms", "closed_at IS NOT NULL AND closed_at < :c"),
    "system_metric_samples": ("system_metric_samples", "sampled_at < :c"),
}


async def _delete_batches(db: AsyncSession, key: str, cutoff: datetime) -> int:
    table, condition = _DELETES[key]
    statement = text(
        f"DELETE FROM {table} WHERE ctid IN "  # noqa: S608 — stałe z _DELETES
        f"(SELECT ctid FROM {table} WHERE {condition} LIMIT {BATCH})"
    )
    total = 0
    while True:
        result = await db.execute(statement, {"c": cutoff})
        await db.commit()
        count = int(getattr(result, "rowcount", 0) or 0)
        total += count
        if count < BATCH:
            return total


async def apply_retention(db: AsyncSession, now: datetime, policy: Retention) -> Report:
    report = Report()
    raw_cutoff = now - timedelta(days=policy.raw_days)
    pending = await db.scalar(
        text("SELECT count(*) FROM aggregate_dirty WHERE hour_start < :c"), {"c": raw_cutoff}
    )
    expired = expired_partitions(await _partitions(db), raw_cutoff)
    if pending:
        # Agregaty tych godzin nie są jeszcze policzone — surowe dane zostają do następnego dnia.
        log.warning("Retencja: %d godzin czeka na agregaty — surowe dane zostają", pending)
        report.skipped = expired
    else:
        for name in expired:
            await db.execute(text(f"DROP TABLE {name}"))
            await db.commit()
            report.dropped.append(name)
        report.deleted[DEFAULT_PARTITION] = await _delete_batches(db, DEFAULT_PARTITION, raw_cutoff)
    m5_cutoff = now - timedelta(days=policy.m5_days)
    runs_cutoff = now - timedelta(days=policy.runs_days)
    report.deleted["aggregates_5m"] = await _delete_batches(db, "aggregates_5m", m5_cutoff)
    report.deleted["polling_runs"] = await _delete_batches(db, "polling_runs", runs_cutoff)
    report.deleted["agent_batches"] = await _delete_batches(db, "agent_batches", runs_cutoff)
    alarms_cutoff = now - timedelta(days=policy.alarms_days)
    report.deleted["alarms"] = await _delete_batches(db, "alarms", alarms_cutoff)
    system_cutoff = now - timedelta(days=policy.system_days)
    report.deleted["system_metric_samples"] = await _delete_batches(
        db, "system_metric_samples", system_cutoff
    )
    return report


async def run_maintenance(db: AsyncSession, now: datetime, policy: Retention) -> Report:
    created = await ensure_partitions(db, now, policy.months_ahead)
    report = await apply_retention(db, now, policy)
    report.created, report.moved_rows = created.created, created.moved_rows
    log.info(
        "Utrzymanie: nowe partycje %s (przeniesiono %d wierszy), usunięte partycje %s, "
        "pominięte %s, usunięte wiersze %s",
        report.created,
        report.moved_rows,
        report.dropped,
        report.skipped,
        report.deleted,
    )
    return report
