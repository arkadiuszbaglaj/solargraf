"""Wczytywanie profili z YAML (D39). Tylko ``safe_load``; zduplikowane klucze to błąd."""

from __future__ import annotations

from collections.abc import Hashable
from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import ValidationError

from solargraf_profiles.model import Profile

MAX_PROFILE_BYTES = 1_000_000


class ProfileError(Exception):
    """Profil nieczytelny albo niezgodny ze schematem. Komunikat zawiera ścieżkę pliku."""


class _UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader, który nie nadpisuje po cichu powtórzonych kluczy (PyYAML domyślnie tak robi)."""


def _mapping_without_duplicates(
    loader: yaml.SafeLoader, node: yaml.MappingNode, deep: bool = False
) -> dict[Hashable, object]:
    seen: set[Hashable] = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"powtórzony klucz {key!r}", key_node.start_mark
            )
        seen.add(key)
    return loader.construct_mapping(node, deep=deep)


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping_without_duplicates
)


def parse_profile(text: str, *, name: str = "<profil>") -> Profile:
    try:
        data = yaml.load(text, Loader=_UniqueKeyLoader)  # noqa: S506 — SafeLoader z kontrolą kluczy
    except yaml.YAMLError as exc:
        raise ProfileError(f"{name}: niepoprawny YAML: {exc}") from None
    if not isinstance(data, dict):
        raise ProfileError(f"{name}: oczekiwano mapy na najwyższym poziomie")
    try:
        return Profile.model_validate(data)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or '(profil)'}: {e['msg']}" for e in exc.errors()
        )
        raise ProfileError(f"{name}: {details}") from None


def load_profile(path: Path) -> Profile:
    if path.stat().st_size > MAX_PROFILE_BYTES:
        raise ProfileError(f"{path}: plik większy niż {MAX_PROFILE_BYTES} B")
    profile = parse_profile(path.read_text(encoding="utf-8"), name=str(path))
    if path.stem != profile.id:
        raise ProfileError(f"{path}: nazwa pliku musi być równa id profilu ({profile.id}.yaml)")
    return profile


@dataclass(frozen=True)
class DirectoryResult:
    profiles: list[Profile]
    errors: list[str]


def load_directory(directory: Path) -> DirectoryResult:
    """Wczytuje wszystkie ``*.yaml`` w katalogu; zbiera wszystkie błędy naraz."""
    profiles: list[Profile] = []
    errors: list[str] = []
    for path in sorted(directory.glob("*.yml")):
        errors.append(f"{path}: używaj rozszerzenia .yaml")
    for path in sorted(directory.glob("*.yaml")):
        try:
            profiles.append(load_profile(path))
        except ProfileError as exc:
            errors.append(str(exc))
    return DirectoryResult(profiles, errors)
