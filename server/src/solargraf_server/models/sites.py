"""Instalacje (site) i zawężenie członkostwa do wybranych instalacji (D33)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from solargraf_server.models.base import Base, created_at, uuid_pk

DEFAULT_TIMEZONE = "Europe/Warsaw"


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[uuid.UUID] = uuid_pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    # Strefa IANA, w której UI prezentuje czas instalacji (D13).
    timezone: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = created_at()


class MembershipSite(Base):
    """Instalacja przypisana do członkostwa z ``all_sites = false``."""

    __tablename__ = "membership_sites"

    membership_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("memberships.id", ondelete="CASCADE"), primary_key=True
    )
    site_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True, index=True
    )
