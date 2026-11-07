"""Czyste reguły: blokada po nieudanych próbach i ważność sesji (D30, D32). Bez I/O."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

MAX_FAILED_ATTEMPTS = 5
FAILED_WINDOW = timedelta(minutes=15)
LOCK_DURATION = timedelta(minutes=15)


@dataclass(frozen=True)
class LockoutState:
    failed_count: int
    window_started_at: datetime | None
    locked_until: datetime | None


def is_locked(state: LockoutState, now: datetime) -> bool:
    return state.locked_until is not None and now < state.locked_until


def after_failure(state: LockoutState, now: datetime) -> LockoutState:
    """Stan po nieudanej próbie. Okno liczone od pierwszej porażki; po upływie — od nowa."""
    window = state.window_started_at
    count = state.failed_count
    if window is None or now - window >= FAILED_WINDOW:
        window, count = now, 0
    count += 1
    locked_until = now + LOCK_DURATION if count >= MAX_FAILED_ATTEMPTS else state.locked_until
    if locked_until is not None and locked_until <= now:
        locked_until = None
    return LockoutState(failed_count=count, window_started_at=window, locked_until=locked_until)


def after_success() -> LockoutState:
    return LockoutState(failed_count=0, window_started_at=None, locked_until=None)


def session_valid(
    last_seen_at: datetime, expires_at: datetime, now: datetime, idle: timedelta
) -> bool:
    """Sesja ważna przed bezwzględnym wygaśnięciem i bez przekroczenia czasu bezczynności."""
    return now < expires_at and now - last_seen_at < idle
