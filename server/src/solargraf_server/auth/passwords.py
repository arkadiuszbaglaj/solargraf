"""Hashowanie haseł Argon2id (D32)."""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_LENGTH = 12
MAX_LENGTH = 128

# RFC 9106, druga rekomendowana konfiguracja (mniejsza pamięć): 64 MiB, t=3, p=4.
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)

# Hash zastępczy do wyrównania czasu odpowiedzi, gdy konto nie istnieje.
_DUMMY_HASH = _hasher.hash("konto-nie-istnieje-wyrownanie-czasu")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def burn_verification_time(password: str) -> None:
    """Wykonuje weryfikację na hashu zastępczym (brak konta nie skraca odpowiedzi)."""
    verify_password(_DUMMY_HASH, password)


def password_problem(password: str) -> str | None:
    """Powód odrzucenia hasła albo ``None``. Bez reguł składu (NIST SP 800-63B)."""
    if len(password) < MIN_LENGTH:
        return f"Hasło musi mieć co najmniej {MIN_LENGTH} znaków."
    if len(password) > MAX_LENGTH:
        return f"Hasło może mieć najwyżej {MAX_LENGTH} znaków."
    return None
