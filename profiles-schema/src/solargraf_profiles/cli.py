"""Walidacja profili z linii poleceń.

Użycie: ``uv run solargraf-profiles validate profiles/``
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from solargraf_profiles.loader import load_directory


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="solargraf-profiles")
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate", help="sprawdź wszystkie profile w katalogu")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args(argv)

    directory: Path = args.directory
    if not directory.is_dir():
        print(f"Brak katalogu {directory}", file=sys.stderr)
        return 2
    result = load_directory(directory)
    for error in result.errors:
        print(f"BŁĄD {error}", file=sys.stderr)
    for profile in result.profiles:
        print(f"OK   {profile.id} {profile.version} [{profile.support_level}]")
    if result.errors:
        return 1
    print(f"Profile poprawne: {len(result.profiles)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
