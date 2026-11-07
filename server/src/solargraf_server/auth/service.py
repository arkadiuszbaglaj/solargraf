"""Operacje na kontach i sesjach. Komunikaty dla klienta są ogólne; szczegóły tylko w audycie.

Argon2id jest kosztowny obliczeniowo — wykonujemy go w wątku, żeby nie blokować pętli zdarzeń.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from solargraf_server.auth import passwords, policy
from solargraf_server.auth.tokens import new_token, normalize_email, token_hash
from solargraf_server.config import Settings
from solargraf_server.models import (
    AuditEvent,
    Membership,
    Organization,
    Role,
    SetupToken,
    User,
    UserSession,
)

SETUP_TOKEN_TTL = timedelta(hours=1)
# Stały klucz blokady doradczej serializującej pierwszą konfigurację.
_SETUP_LOCK_KEY = 0x5347_0001


class SetupError(Exception):
    """Błąd pierwszej konfiguracji z kodem do mapowania na odpowiedź HTTP."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class IssuedSession:
    token: str
    csrf_token: str
    expires_at: datetime


async def audit(
    db: AsyncSession,
    action: str,
    *,
    user_id: uuid.UUID | None = None,
    organization_id: uuid.UUID | None = None,
    target: str | None = None,
) -> None:
    db.add(
        AuditEvent(action=action, user_id=user_id, organization_id=organization_id, target=target)
    )


async def users_exist(db: AsyncSession) -> bool:
    count = await db.scalar(select(func.count()).select_from(User))
    return bool(count)


async def create_setup_token(db: AsyncSession, now: datetime) -> str:
    if await users_exist(db):
        raise SetupError("already_configured")
    token = new_token()
    db.add(SetupToken(token_hash=token_hash(token), expires_at=now + SETUP_TOKEN_TTL))
    await audit(db, "SETUP_TOKEN_ISSUED")
    await db.commit()
    return token


async def complete_setup(
    db: AsyncSession,
    *,
    token: str,
    organization_name: str,
    email: str,
    display_name: str,
    password: str,
    now: datetime,
) -> User:
    problem = passwords.password_problem(password)
    if problem is not None:
        raise SetupError("weak_password")
    # Serializacja równoległych prób konfiguracji w obrębie transakcji.
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _SETUP_LOCK_KEY})
    if await users_exist(db):
        raise SetupError("already_configured")
    setup = await db.scalar(
        select(SetupToken).where(SetupToken.token_hash == token_hash(token)).with_for_update()
    )
    if setup is None or setup.used_at is not None or setup.expires_at <= now:
        raise SetupError("invalid_token")
    setup.used_at = now
    org = Organization(name=organization_name.strip())
    user = User(
        email=normalize_email(email),
        display_name=display_name.strip(),
        password_hash=await asyncio.to_thread(passwords.hash_password, password),
        is_active=True,
        failed_login_count=0,
    )
    db.add_all([org, user])
    await db.flush()
    db.add(Membership(user_id=user.id, organization_id=org.id, role=Role.OWNER.value))
    await audit(db, "SETUP_COMPLETED", user_id=user.id, organization_id=org.id)
    await db.commit()
    return user


async def login(
    db: AsyncSession, *, email: str, password: str, settings: Settings, now: datetime
) -> tuple[User, IssuedSession] | None:
    """Zwraca użytkownika i nową sesję albo ``None`` (jedna, ogólna przyczyna dla klienta)."""
    user = await db.scalar(
        select(User).where(User.email == normalize_email(email)).with_for_update()
    )
    if user is None:
        await asyncio.to_thread(passwords.burn_verification_time, password)
        await audit(db, "LOGIN_FAILED")
        await db.commit()
        return None

    state = policy.LockoutState(
        user.failed_login_count, user.failed_window_started_at, user.locked_until
    )
    if policy.is_locked(state, now):
        await asyncio.to_thread(passwords.burn_verification_time, password)
        await audit(db, "LOGIN_REJECTED_LOCKED", user_id=user.id)
        await db.commit()
        return None

    if not user.is_active or not await asyncio.to_thread(
        passwords.verify_password, user.password_hash, password
    ):
        new_state = policy.after_failure(state, now)
        user.failed_login_count = new_state.failed_count
        user.failed_window_started_at = new_state.window_started_at
        user.locked_until = new_state.locked_until
        await audit(db, "LOGIN_FAILED", user_id=user.id)
        if policy.is_locked(new_state, now):
            await audit(db, "ACCOUNT_LOCKED", user_id=user.id)
        await db.commit()
        return None

    if passwords.needs_rehash(user.password_hash):
        user.password_hash = await asyncio.to_thread(passwords.hash_password, password)
    reset = policy.after_success()
    user.failed_login_count = reset.failed_count
    user.failed_window_started_at = reset.window_started_at
    user.locked_until = reset.locked_until
    user.last_login_at = now

    issued = IssuedSession(
        token=new_token(),
        csrf_token=new_token(),
        expires_at=now + timedelta(days=settings.session_absolute_days),
    )
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=token_hash(issued.token),
            csrf_token=issued.csrf_token,
            last_seen_at=now,
            expires_at=issued.expires_at,
        )
    )
    await audit(db, "LOGIN_SUCCEEDED", user_id=user.id)
    await db.commit()
    return user, issued


async def resolve_session(
    db: AsyncSession, *, token: str, settings: Settings, now: datetime
) -> tuple[User, UserSession] | None:
    session = await db.scalar(
        select(UserSession).where(UserSession.token_hash == token_hash(token))
    )
    if session is None:
        return None
    idle = timedelta(hours=settings.session_idle_hours)
    if not policy.session_valid(session.last_seen_at, session.expires_at, now, idle):
        await db.delete(session)
        await db.commit()
        return None
    user = await db.get(User, session.user_id)
    if user is None or not user.is_active:
        return None
    session.last_seen_at = now
    await db.commit()
    return user, session


async def logout(db: AsyncSession, session: UserSession) -> None:
    await db.execute(delete(UserSession).where(UserSession.id == session.id))
    await audit(db, "LOGOUT", user_id=session.user_id)
    await db.commit()


async def memberships_of(
    db: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Membership, Organization]]:
    rows = await db.execute(
        select(Membership, Organization)
        .join(Organization, Organization.id == Membership.organization_id)
        .where(Membership.user_id == user_id)
        .order_by(Organization.name)
    )
    return [(m, o) for m, o in rows]
