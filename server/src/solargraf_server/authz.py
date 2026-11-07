"""Autoryzacja po stronie serwera (D29, D33). Jedyne miejsce decydujące o dostępie do instalacji.

Zasady:
- dostęp wynika wyłącznie z członkostwa użytkownika — ``site_id`` z żądania nie jest dowodem;
- cudza i nieistniejąca instalacja dają ten sam wynik (404), żeby nie ujawniać ich istnienia;
- 403 tylko, gdy użytkownik widzi instalację, ale nie może jej zarządzać.
"""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass

from sqlalchemy import ColumnElement, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.models import Membership, MembershipSite, Organization, Role, Site


class SiteAction(enum.Enum):
    READ = "READ"
    MANAGE = "MANAGE"


# D29: kto może wykonać akcję na instalacji.
_ALLOWED: dict[SiteAction, frozenset[Role]] = {
    SiteAction.READ: frozenset({Role.OWNER, Role.ADMIN, Role.VIEWER}),
    SiteAction.MANAGE: frozenset({Role.OWNER, Role.ADMIN}),
}


class NotFoundError(Exception):
    """Zasób nie istnieje albo użytkownik nie ma do niego dostępu (nie rozróżniamy)."""


class ForbiddenError(Exception):
    """Użytkownik widzi zasób, ale jego rola nie pozwala na akcję."""


@dataclass(frozen=True)
class SiteAccess:
    site: Site
    role: Role


def role_allows(role: Role, action: SiteAction) -> bool:
    return role in _ALLOWED[action]


def _visible_condition(user_id: uuid.UUID) -> ColumnElement[bool]:
    """Warunek: członkostwo użytkownika w organizacji instalacji obejmuje tę instalację."""
    scoped = exists().where(
        MembershipSite.membership_id == Membership.id, MembershipSite.site_id == Site.id
    )
    return (
        (Membership.organization_id == Site.organization_id)
        & (Membership.user_id == user_id)
        & or_(Membership.role == Role.OWNER.value, Membership.all_sites.is_(True), scoped)
    )


async def accessible_sites(db: AsyncSession, user_id: uuid.UUID) -> list[SiteAccess]:
    rows = await db.execute(
        select(Site, Membership.role)
        .join(Membership, _visible_condition(user_id))
        .order_by(Site.name, Site.id)
    )
    return [SiteAccess(site=site, role=Role(role)) for site, role in rows]


async def authorize_site(
    db: AsyncSession, user_id: uuid.UUID, site_id: uuid.UUID, action: SiteAction
) -> SiteAccess:
    row = (
        await db.execute(
            select(Site, Membership.role)
            .join(Membership, _visible_condition(user_id))
            .where(Site.id == site_id)
        )
    ).first()
    if row is None:
        raise NotFoundError
    site, role_value = row
    role = Role(role_value)
    if not role_allows(role, action):
        raise ForbiddenError
    return SiteAccess(site=site, role=role)


async def authorize_organization(
    db: AsyncSession, user_id: uuid.UUID, organization_id: uuid.UUID, action: SiteAction
) -> tuple[Organization, Role]:
    """Uprawnienie do akcji na poziomie organizacji (np. utworzenie instalacji)."""
    row = (
        await db.execute(
            select(Organization, Membership.role, Membership.all_sites)
            .join(Membership, Membership.organization_id == Organization.id)
            .where(Organization.id == organization_id, Membership.user_id == user_id)
        )
    ).first()
    if row is None:
        raise NotFoundError
    org, role_value, all_sites = row
    role = Role(role_value)
    if not role_allows(role, action):
        raise ForbiddenError
    # Zawężony członek (all_sites = false) nie zarządza organizacją, nawet jako ADMIN.
    if action is SiteAction.MANAGE and role is not Role.OWNER and not all_sites:
        raise ForbiddenError
    return org, role
