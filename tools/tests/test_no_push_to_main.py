import pytest

from tools.hooks.no_push_to_main import OVERRIDE_ENV, is_blocked


@pytest.mark.parametrize(
    ("env", "blocked"),
    [
        ({"PRE_COMMIT_REMOTE_BRANCH": "refs/heads/main"}, True),
        ({"PRE_COMMIT_REMOTE_BRANCH": "main"}, True),
        ({"PRE_COMMIT_REMOTE_BRANCH": "refs/heads/chore/x"}, False),
        ({"PRE_COMMIT_REMOTE_BRANCH": "refs/heads/main-old"}, False),
        ({"PRE_COMMIT_REMOTE_BRANCH": "refs/heads/main", OVERRIDE_ENV: "1"}, False),
        ({"PRE_COMMIT_REMOTE_BRANCH": "refs/heads/main", OVERRIDE_ENV: "yes"}, True),
        ({}, False),
    ],
)
def test_is_blocked(env: dict[str, str], blocked: bool) -> None:
    assert is_blocked(env) is blocked
