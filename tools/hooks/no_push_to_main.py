"""Hook pre-push: blokuje bezpośredni push na chronione gałęzie.

GitHub bez planu Pro nie pozwala chronić gałęzi w prywatnym repozytorium, więc ochrona
jest lokalna. Zmiany trafiają na ``main`` przez gałąź i PR.

pre-commit przekazuje docelową gałąź w zmiennej ``PRE_COMMIT_REMOTE_BRANCH``
(np. ``refs/heads/main``). Świadome obejście: ``SOLARGRAF_ALLOW_PUSH_MAIN=1``
albo ``git push --no-verify``.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping

PROTECTED_BRANCHES = frozenset({"main"})
OVERRIDE_ENV = "SOLARGRAF_ALLOW_PUSH_MAIN"


def target_branch(remote_ref: str) -> str:
    return remote_ref.removeprefix("refs/heads/")


def is_blocked(env: Mapping[str, str]) -> bool:
    remote_ref = env.get("PRE_COMMIT_REMOTE_BRANCH", "")
    if not remote_ref:
        return False
    if env.get(OVERRIDE_ENV) == "1":
        return False
    return target_branch(remote_ref) in PROTECTED_BRANCHES


def main() -> int:
    if is_blocked(os.environ):
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
        branch = target_branch(os.environ["PRE_COMMIT_REMOTE_BRANCH"])
        print(
            f"Bezpośredni push na '{branch}' jest zablokowany. Wypchnij gałąź i otwórz PR.\n"
            f"Świadome obejście: {OVERRIDE_ENV}=1 git push",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
