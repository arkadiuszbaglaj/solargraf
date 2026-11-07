"""Zamknięte listy w bazie (migracja 0004) muszą odpowiadać katalogowi w solargraf-profiles."""

import importlib.util
from pathlib import Path
from types import ModuleType

from solargraf_profiles.catalog import DeviceKind, Transport

MIGRATION = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0004_devices.py"


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("migration_0004", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _values(sql_list: str) -> list[str]:
    return [v.strip().strip("'") for v in sql_list.strip("()").split(",")]


def test_migration_lists_match_catalog() -> None:
    # Nowa wartość w katalogu wymaga nowej migracji zmieniającej CHECK.
    m = _migration()
    assert _values(m.TRANSPORTS) == [t.value for t in Transport]
    assert _values(m.KINDS) == [k.value for k in DeviceKind]
