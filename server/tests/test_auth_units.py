from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from solargraf_server.auth import passwords, policy
from solargraf_server.auth.tokens import new_token, normalize_email, token_hash, tokens_equal
from solargraf_server.models import Base

T0 = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
EMPTY = policy.LockoutState(0, None, None)


def fail_times(
    n: int, start: datetime = T0, step: timedelta = timedelta(seconds=10)
) -> policy.LockoutState:
    state = EMPTY
    for i in range(n):
        state = policy.after_failure(state, start + i * step)
    return state


class TestLockout:
    def test_four_failures_do_not_lock(self) -> None:
        state = fail_times(4)
        assert state.failed_count == 4
        assert not policy.is_locked(state, T0 + timedelta(minutes=1))

    def test_fifth_failure_locks_for_15_minutes(self) -> None:
        state = fail_times(5)
        last = T0 + timedelta(seconds=40)
        assert policy.is_locked(state, last)
        assert policy.is_locked(state, last + timedelta(minutes=14, seconds=59))
        assert not policy.is_locked(state, last + timedelta(minutes=15))

    def test_window_resets_after_15_minutes(self) -> None:
        state = fail_times(4)
        later = T0 + timedelta(minutes=16)
        state = policy.after_failure(state, later)
        assert state.failed_count == 1
        assert state.window_started_at == later
        assert not policy.is_locked(state, later)

    def test_failures_spread_beyond_window_never_lock(self) -> None:
        state = fail_times(10, step=timedelta(minutes=4))
        assert not policy.is_locked(state, T0 + timedelta(minutes=40))

    def test_success_resets(self) -> None:
        assert policy.after_success() == EMPTY


class TestSessionValidity:
    IDLE = timedelta(hours=24)

    def test_valid_when_recent_and_before_expiry(self) -> None:
        assert policy.session_valid(T0, T0 + timedelta(days=14), T0 + timedelta(hours=1), self.IDLE)

    def test_idle_timeout(self) -> None:
        assert not policy.session_valid(T0, T0 + timedelta(days=14), T0 + self.IDLE, self.IDLE)

    def test_absolute_expiry_even_when_active(self) -> None:
        now = T0 + timedelta(days=14)
        assert not policy.session_valid(now - timedelta(minutes=1), now, now, self.IDLE)


class TestPasswords:
    def test_hash_is_argon2id_with_rfc9106_low_memory_parameters(self) -> None:
        h = passwords.hash_password("poprawne-haslo-123")
        assert h.startswith("$argon2id$")
        assert "m=65536,t=3,p=4" in h

    def test_verify(self) -> None:
        h = passwords.hash_password("poprawne-haslo-123")
        assert passwords.verify_password(h, "poprawne-haslo-123")
        assert not passwords.verify_password(h, "inne-haslo-12345")
        assert not passwords.verify_password("nie-hash", "cokolwiek")

    @pytest.mark.parametrize(
        ("password", "ok"),
        [
            ("a" * 11, False),
            ("a" * 12, True),
            ("zażółć gęślą", True),
            ("a" * 128, True),
            ("a" * 129, False),
        ],
    )
    def test_length_policy_without_composition_rules(self, password: str, ok: bool) -> None:
        assert (passwords.password_problem(password) is None) is ok


class TestTokens:
    def test_tokens_are_random_and_long(self) -> None:
        a, b = new_token(), new_token()
        assert a != b
        assert len(a) >= 43

    def test_hash_is_sha256_hex_and_not_the_token(self) -> None:
        t = new_token()
        assert len(token_hash(t)) == 64
        assert token_hash(t) == token_hash(t)
        assert t not in token_hash(t)

    def test_constant_time_compare(self) -> None:
        assert tokens_equal("abc", "abc")
        assert not tokens_equal("abc", "abd")

    def test_email_normalization(self) -> None:
        assert normalize_email("  Jan.Kowalski@Example.PL ") == "jan.kowalski@example.pl"


def test_schema_compiles_for_postgresql_with_conventional_names() -> None:
    ddl = {
        t.name: str(CreateTable(t).compile(dialect=postgresql.dialect()))  # type: ignore[no-untyped-call]
        for t in Base.metadata.sorted_tables
    }
    assert set(ddl) == {
        "organizations",
        "users",
        "memberships",
        "auth_sessions",
        "setup_tokens",
        "audit_events",
    }
    assert "CONSTRAINT uq_users_email UNIQUE (email)" in ddl["users"]
    assert "CONSTRAINT ck_memberships_role CHECK" in ddl["memberships"]
    assert "TIMESTAMP WITH TIME ZONE" in ddl["auth_sessions"]
    # Sesja nie przechowuje samego tokenu — tylko skrót.
    assert "token_hash" in ddl["auth_sessions"]
    assert " token " not in ddl["auth_sessions"]
