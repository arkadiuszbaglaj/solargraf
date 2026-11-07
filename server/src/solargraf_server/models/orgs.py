"""Organizacje, użytkownicy i członkostwa (docs/DATA_MODEL.md, D29)."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, created_at, uuid_pk


class Role(enum.StrEnum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    VIEWER = "VIEWER"


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = created_at()


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = uuid_pk()
    # Zapisywany znormalizowany (małe litery) — porównanie bez rozróżniania wielkości liter.
    email: Mapped[str] = mapped_column(String(254), unique=True)
    display_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = created_at()
    last_login_at: Mapped[datetime | None]
    failed_login_count: Mapped[int] = mapped_column(default=0)
    failed_window_started_at: Mapped[datetime | None]
    locked_until: Mapped[datetime | None]


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "organization_id"),
        CheckConstraint("role IN ('OWNER', 'ADMIN', 'VIEWER')", name="role"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = created_at()
