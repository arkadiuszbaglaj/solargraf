"""Sesje użytkowników i jednorazowe tokeny pierwszej konfiguracji (D30, D31)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, created_at, uuid_pk


class UserSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # SHA-256 (hex) tokenu z cookie; sam token nie jest przechowywany.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at()
    last_seen_at: Mapped[datetime]
    expires_at: Mapped[datetime]


class SetupToken(Base):
    __tablename__ = "setup_tokens"

    id: Mapped[uuid.UUID] = uuid_pk()
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = created_at()
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
