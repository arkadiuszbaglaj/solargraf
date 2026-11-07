"""Endpointy /api/setup i /api/auth (D29-D32)."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator

from solargraf_server.auth import passwords, service
from solargraf_server.auth.deps import (
    SESSION_COOKIE,
    AuthContext,
    DbSession,
    current_auth,
    get_settings,
    require_csrf,
    utcnow,
)
from solargraf_server.config import Settings

router = APIRouter(prefix="/api", tags=["auth"])

INVALID_CREDENTIALS = "Nieprawidłowy e-mail lub hasło."


def _check_email(value: str) -> str:
    value = value.strip()
    local, sep, domain = value.partition("@")
    if not sep or not local or "." not in domain or any(c.isspace() for c in value):
        raise ValueError("Nieprawidłowy adres e-mail.")
    return value


class SetupRequest(BaseModel):
    token: str = Field(min_length=1, max_length=200)
    organization_name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=254)
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(max_length=passwords.MAX_LENGTH)

    _email = field_validator("email")(_check_email)


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=passwords.MAX_LENGTH)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str


class MembershipOut(BaseModel):
    organization_id: uuid.UUID
    organization_name: str
    role: Literal["OWNER", "ADMIN", "VIEWER"]


class SessionOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]
    csrf_token: str


_SETUP_ERRORS: dict[str, tuple[int, str]] = {
    "already_configured": (status.HTTP_409_CONFLICT, "System jest już skonfigurowany."),
    "invalid_token": (
        status.HTTP_400_BAD_REQUEST,
        "Token konfiguracji jest nieprawidłowy lub wygasł.",
    ),
    "weak_password": (
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        f"Hasło musi mieć od {passwords.MIN_LENGTH} do {passwords.MAX_LENGTH} znaków.",
    ),
}


@router.post("/setup", status_code=status.HTTP_201_CREATED, response_model=UserOut)
async def setup(body: SetupRequest, db: DbSession) -> UserOut:
    try:
        user = await service.complete_setup(
            db,
            token=body.token,
            organization_name=body.organization_name,
            email=body.email,
            display_name=body.display_name,
            password=body.password,
            now=utcnow(),
        )
    except service.SetupError as exc:
        code, message = _SETUP_ERRORS[exc.code]
        raise HTTPException(code, message) from None
    return UserOut(id=user.id, email=user.email, display_name=user.display_name)


async def _session_out(
    db: DbSession, auth_user_id: uuid.UUID, user: UserOut, csrf: str
) -> SessionOut:
    memberships = await service.memberships_of(db, auth_user_id)
    return SessionOut(
        user=user,
        memberships=[
            MembershipOut(organization_id=o.id, organization_name=o.name, role=m.role)  # type: ignore[arg-type]
            for m, o in memberships
        ],
        csrf_token=csrf,
    )


@router.post("/auth/login", response_model=SessionOut)
async def login(
    body: LoginRequest,
    response: Response,
    db: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
) -> SessionOut:
    result = await service.login(
        db, email=body.email, password=body.password, settings=settings, now=utcnow()
    )
    if result is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_CREDENTIALS)
    user, issued = result
    response.set_cookie(
        SESSION_COOKIE,
        issued.token,
        max_age=int(settings.session_absolute_days * 86400),
        path="/api",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="strict",
    )
    return await _session_out(
        db,
        user.id,
        UserOut(id=user.id, email=user.email, display_name=user.display_name),
        issued.csrf_token,
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    db: DbSession,
    auth: Annotated[AuthContext, Depends(require_csrf)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    await service.logout(db, auth.session)
    response.delete_cookie(
        SESSION_COOKIE,
        path="/api",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="strict",
    )


@router.get("/auth/me", response_model=SessionOut)
async def me(db: DbSession, auth: Annotated[AuthContext, Depends(current_auth)]) -> SessionOut:
    user = auth.user
    return await _session_out(
        db,
        user.id,
        UserOut(id=user.id, email=user.email, display_name=user.display_name),
        auth.session.csrf_token,
    )
