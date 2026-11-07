"""Losowe tokeny i ich skróty. W bazie przechowujemy tylko skrót tokenu sesji/konfiguracji."""

from __future__ import annotations

import hashlib
import hmac
import secrets

TOKEN_BYTES = 32


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def normalize_email(email: str) -> str:
    return email.strip().lower()
