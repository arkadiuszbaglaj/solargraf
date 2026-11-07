"""Endpointy /api/sites (D33). Dostęp wyłącznie przez moduł ``authz``."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from solargraf_server import authz
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, current_auth, require_csrf
from solargraf_server.models import DEFAULT_TIMEZONE, Site

router = APIRouter(prefix="/api/sites", tags=["sites"])

NOT_FOUND = "Nie znaleziono instalacji."


def validate_timezone(value: str) -> str:
    """Tylko identyfikatory IANA w postaci Obszar/Miejsce lub UTC (bez ścieżek i skrótów)."""
    if value != "UTC" and ("/" not in value or ".." in value or value.startswith("/")):
        raise ValueError("Nieprawidłowa strefa czasowa (oczekiwano identyfikatora IANA).")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Nieznana strefa czasowa.") from None
    return value


class SiteOut(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    timezone: str
    role: Literal["OWNER", "ADMIN", "VIEWER"]


class SiteCreate(BaseModel):
    organization_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    timezone: str = Field(default=DEFAULT_TIMEZONE, max_length=64)

    _tz = field_validator("timezone")(validate_timezone)

    @field_validator("name")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Nazwa nie może być pusta.")
        return value


def _out(access: authz.SiteAccess) -> SiteOut:
    s = access.site
    return SiteOut(
        id=s.id,
        organization_id=s.organization_id,
        name=s.name,
        timezone=s.timezone,
        role=access.role.value,
    )


@router.get("", response_model=list[SiteOut])
async def list_sites(
    db: DbSession, auth: Annotated[AuthContext, Depends(current_auth)]
) -> list[SiteOut]:
    return [_out(a) for a in await authz.accessible_sites(db, auth.user.id)]


@router.get("/{site_id}", response_model=SiteOut)
async def get_site(
    site_id: uuid.UUID, db: DbSession, auth: Annotated[AuthContext, Depends(current_auth)]
) -> SiteOut:
    try:
        access = await authz.authorize_site(db, auth.user.id, site_id, authz.SiteAction.READ)
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    return _out(access)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SiteOut)
async def create_site(
    body: SiteCreate, db: DbSession, auth: Annotated[AuthContext, Depends(require_csrf)]
) -> SiteOut:
    try:
        org, role = await authz.authorize_organization(
            db, auth.user.id, body.organization_id, authz.SiteAction.MANAGE
        )
    except authz.NotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono organizacji.") from None
    except authz.ForbiddenError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Brak uprawnień.") from None
    site = Site(organization_id=org.id, name=body.name, timezone=body.timezone)
    db.add(site)
    await db.flush()
    await auth_service.audit(
        db, "SITE_CREATED", user_id=auth.user.id, organization_id=org.id, target=f"site:{site.id}"
    )
    await db.commit()
    return _out(authz.SiteAccess(site=site, role=role))
