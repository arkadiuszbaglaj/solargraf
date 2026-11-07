"""Przedziały historii (D46) — bez bazy."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from solargraf_server.history import HistoryResolution, bucket_count, bucket_starts

WARSAW = ZoneInfo("Europe/Warsaw")
START = datetime(2026, 10, 24, 10, 7, tzinfo=UTC)


def test_five_minute_buckets_cover_partial_edges() -> None:
    end = START + timedelta(minutes=10)
    starts = bucket_starts(HistoryResolution.M5, START, end, WARSAW)
    assert starts[0] == datetime(2026, 10, 24, 10, 5, tzinfo=UTC)
    assert len(starts) == 3 == bucket_count(HistoryResolution.M5, START, end, WARSAW)


def test_days_follow_local_midnight_across_dst() -> None:
    end = START + timedelta(days=2)
    starts = bucket_starts(HistoryResolution.D1, START, end, WARSAW)
    assert [d.astimezone(WARSAW).hour for d in starts] == [0, 0, 0]
    assert starts[2] - starts[1] == timedelta(hours=25)  # 25.10 — zmiana na czas zimowy
    assert bucket_count(HistoryResolution.D1, START, end, WARSAW) >= len(starts)
