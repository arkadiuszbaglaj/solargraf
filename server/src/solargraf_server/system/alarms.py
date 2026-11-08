"""Alarmy systemowe (P7.1d, D68) z oceny monitora serwera (D60).

Alarm odpowiada aktywnemu warunkowi oceny: otwiera się, gdy warunek się włącza, i zamyka, gdy
się wyłącza. Histereza i „brak pomiaru nie zmienia stanu” są już w ``stability.Evaluation``,
więc tu tylko odwzorowujemy listę przyczyn na wiersze — bez drugiej histerezy.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.models.system import SystemAlarm
from solargraf_server.system.stability import Reason


async def sync_alarms(db: AsyncSession, reasons: Sequence[Reason], now: datetime) -> None:
    """Otwiera alarmy nowych przyczyn, odświeża trwające i zamyka ustąpione (bez commita)."""
    open_alarms = {
        a.code: a
        for a in (
            await db.scalars(
                select(SystemAlarm).where(SystemAlarm.closed_at.is_(None)).with_for_update()
            )
        ).all()
    }
    for reason in reasons:
        alarm = open_alarms.pop(reason.code, None)
        if alarm is None:
            db.add(
                SystemAlarm(
                    code=reason.code,
                    severity=reason.severity.value,
                    message=reason.message,
                    opened_at=min(reason.since or now, now),
                    last_seen_at=now,
                )
            )
        else:
            alarm.last_seen_at = now
            alarm.severity = reason.severity.value
            alarm.message = reason.message
    for alarm in open_alarms.values():
        alarm.closed_at = max(now, alarm.opened_at)
