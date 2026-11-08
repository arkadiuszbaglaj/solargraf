"""API sprawdzania aktualizacji (D15, D63) — tylko rola OWNER; zmiany z tokenem CSRF.

- ``GET /api/system/updates`` — bieżąca wersja, ustawienie, wynik ostatniego sprawdzenia
  i dostępna wersja.
- ``POST /api/system/updates/check`` — sprawdzenie teraz (także przy wyłączonym automatycznym).
- ``PUT /api/system/updates/settings`` — automatyczne sprawdzanie raz w tygodniu: włącz/wyłącz.
- ``POST /api/system/updates/dismiss`` — ukrycie zwykłej wersji; wersji z poprawkami bezpieczeństwa
  nie da się ukryć trwale (UI odkłada komunikat tylko do kolejnego logowania).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from solargraf_server import __version__
from solargraf_server.auth import service as auth_service
from solargraf_server.auth.deps import AuthContext, DbSession, get_settings, utcnow
from solargraf_server.config import Settings
from solargraf_server.models.updates import UpdateStatus
from solargraf_server.system.api import require_owner, require_owner_csrf
from solargraf_server.updates import manifest as mf
from solargraf_server.updates import service

router = APIRouter(prefix="/api/system/updates", tags=["system"])

MANUAL_CHECK_INTERVAL = timedelta(minutes=1)


class UpdatesOut(BaseModel):
    current_version: str
    # False — ta wersja aplikacji nie ma klucza podpisu; sprawdzanie niemożliwe.
    configured: bool
    automatic: bool
    last_checked_at: datetime | None
    last_success_at: datetime | None
    last_error: mf.CheckError | None
    next_check_at: datetime | None
    available: mf.Availability | None
    dismissed: bool


class SettingsIn(BaseModel):
    automatic: bool


class DismissIn(BaseModel):
    version: str = Field(max_length=32)


def _out(row: UpdateStatus, public_key: str | None) -> UpdatesOut:
    manifest = service.current_manifest(row)
    available = mf.availability(manifest, __version__) if manifest else None
    return UpdatesOut(
        current_version=__version__,
        configured=public_key is not None,
        automatic=row.automatic,
        last_checked_at=row.last_checked_at,
        last_success_at=row.last_success_at,
        last_error=mf.CheckError(row.last_error) if row.last_error else None,
        next_check_at=row.next_check_at if row.automatic and public_key else None,
        available=available,
        dismissed=available is not None
        and not available.security
        and row.dismissed_version == available.version,
    )


def _public_key(request: Request) -> str | None:
    key: str | None = request.app.state.update_public_key
    return key


@router.get("", response_model=UpdatesOut)
async def get_updates(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    _: Annotated[AuthContext, Depends(require_owner)],
) -> UpdatesOut:
    row = await service.status_row(db, settings.update_check)
    await db.commit()
    return _out(row, _public_key(request))


@router.post("/check", response_model=UpdatesOut)
async def check_updates(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthContext, Depends(require_owner_csrf)],
) -> UpdatesOut:
    row = await service.status_row(db, settings.update_check)
    now = utcnow()
    # Limit częstotliwości: wcześniejsze kliknięcie zwraca ostatni wynik bez połączenia.
    if row.last_checked_at is not None and now - row.last_checked_at < MANUAL_CHECK_INTERVAL:
        await db.commit()
        return _out(row, _public_key(request))
    await auth_service.audit(db, "UPDATES_CHECKED", user_id=auth.user.id)
    await service.check_now(
        db,
        row,
        url=settings.update_manifest_url,
        timeout_s=settings.update_timeout_s,
        public_key=_public_key(request),
        now=now,
        fetch=request.app.state.update_fetch,
    )
    return _out(row, _public_key(request))


@router.put("/settings", response_model=UpdatesOut)
async def update_settings(
    body: SettingsIn,
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthContext, Depends(require_owner_csrf)],
) -> UpdatesOut:
    row = await service.status_row(db, settings.update_check)
    if row.automatic != body.automatic:
        row.automatic = body.automatic
        # Po włączeniu worker wyznaczy termin od nowa (losowo w ciągu godziny).
        row.next_check_at = None
        await auth_service.audit(
            db,
            "UPDATES_SETTINGS_CHANGED",
            user_id=auth.user.id,
            target=f"automatic={body.automatic}",
        )
    await db.commit()
    return _out(row, _public_key(request))


@router.post("/dismiss", response_model=UpdatesOut)
async def dismiss_update(
    body: DismissIn,
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
    auth: Annotated[AuthContext, Depends(require_owner_csrf)],
) -> UpdatesOut:
    row = await service.status_row(db, settings.update_check)
    manifest = service.current_manifest(row)
    available = mf.availability(manifest, __version__) if manifest else None
    if available is None or available.version != body.version:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ta wersja nie jest dostępna do ukrycia.")
    if available.security:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Wersji z poprawkami bezpieczeństwa nie można ukryć."
        )
    row.dismissed_version = body.version
    await auth_service.audit(db, "UPDATE_DISMISSED", user_id=auth.user.id, target=body.version)
    await db.commit()
    return _out(row, _public_key(request))
