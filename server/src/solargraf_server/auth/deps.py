"""Zależności FastAPI: bieżący użytkownik z cookie sesji i weryfikacja CSRF (D30)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.auth import service
from solargraf_server.auth.tokens import tokens_equal
from solargraf_server.config import Settings
from solargraf_server.db import get_db
from solargraf_server.models import User, UserSession

SESSION_COOKIE = "sg_session"
CSRF_HEADER = "X-CSRF-Token"

DbSession = Annotated[AsyncSession, Depends(get_db)]


def utcnow() -> datetime:
    return datetime.now(UTC)


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


@dataclass(frozen=True)
class AuthContext:
    user: User
    session: UserSession


async def current_auth(
    request: Request,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
) -> AuthContext:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wymagane zalogowanie.")
    resolved = await service.resolve_session(db, token=token, settings=settings, now=utcnow())
    if resolved is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wymagane zalogowanie.")
    user, session = resolved
    return AuthContext(user=user, session=session)


async def require_csrf(
    auth: Annotated[AuthContext, Depends(current_auth)],
    csrf: Annotated[str | None, Header(alias=CSRF_HEADER)] = None,
) -> AuthContext:
    """Dla żądań modyfikujących: nagłówek musi odpowiadać tokenowi CSRF sesji."""
    if csrf is None or not tokens_equal(csrf, auth.session.csrf_token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Brak lub nieprawidłowy token CSRF.")
    return auth
