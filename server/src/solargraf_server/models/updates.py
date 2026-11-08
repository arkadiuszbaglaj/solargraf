"""Stan sprawdzania aktualizacji (D15, D63): jeden wiersz dla serwera, odczyt tylko dla OWNER."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, SmallInteger, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base
from solargraf_server.updates.manifest import CheckError

UPDATE_ROW_ID = 1


class UpdateStatus(Base):
    __tablename__ = "update_status"
    __table_args__ = (
        CheckConstraint(f"id = {UPDATE_ROW_ID}", name="single_row"),
        CheckConstraint(
            "last_error IS NULL OR last_error IN ("
            + ", ".join(repr(c.value) for c in CheckError)
            + ")",
            name="last_error",
        ),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    # Automatyczne sprawdzanie raz w tygodniu; ręczne działa zawsze.
    automatic: Mapped[bool]
    next_check_at: Mapped[datetime | None]
    last_checked_at: Mapped[datetime | None]
    last_success_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(String(32))
    # Ostatni zweryfikowany manifest (``Manifest.model_dump(mode="json")``).
    manifest: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Ukryta przez administratora zwykła wersja (do pojawienia się kolejnej).
    dismissed_version: Mapped[str | None] = mapped_column(String(32))
