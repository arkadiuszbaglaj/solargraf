"""Reguły zapisu urządzeń bez bazy (D44): adres, ustawienia połączenia, próg świeżości."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from solargraf_server.devices import (
    ConnectionCreate,
    ConnectionSettings,
    device_metrics,
    freshness_threshold,
    validate_host,
)
from solargraf_server.models import Connection
from solargraf_server.profiles import ProfileCatalog

PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"


@pytest.mark.parametrize(
    "host",
    ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.50", "inverter", "logger.lan", "In-1."],
)
def test_allowed_hosts(host: str) -> None:
    assert validate_host(host) == host.lower().rstrip(".")


@pytest.mark.parametrize(
    "host",
    [
        "",
        "8.8.8.8",
        "172.32.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "224.0.0.1",
        "0.0.0.0",  # noqa: S104 — wartość testowa
        "::1",
        "fd00::1",
        "localhost",
        "api.localhost",
        "2130706433",
        "10.0.0.256",
        "a_b.lan",
        "-bad.lan",
        "x" * 254,
    ],
)
def test_rejected_hosts(host: str) -> None:
    with pytest.raises(ValueError, match=r"\w"):
        validate_host(host)


def test_connection_defaults_and_limits() -> None:
    body = ConnectionCreate.model_validate(
        {
            "name": "  Logger ",
            "host": "192.168.1.2",
            "device": {"name": "F", "profile_id": "p", "profile_version": "1.0.0"},
        }
    )
    assert (body.name, body.port, body.unit_id, body.transport) == ("Logger", 502, 1, "MODBUS_TCP")
    for bad in (
        {"port": 0},
        {"unit_id": 256},
        {"poll_interval_seconds": 0},
        {"timeout_seconds": 61},
        {"poll_interval_seconds": 5, "timeout_seconds": 5},
        {"name": "   "},
    ):
        with pytest.raises(ValidationError):
            ConnectionSettings.model_validate({"name": "L", "host": "10.0.0.1"} | bad)


def test_freshness_threshold() -> None:
    profile = ProfileCatalog.load(PROFILES_DIR).get("simulated.hybrid-inverter", "0.1.0")
    assert profile is not None
    conn = Connection(poll_interval_seconds=None)
    assert freshness_threshold(conn, profile) == 300
    conn.poll_interval_seconds = 600
    assert freshness_threshold(conn, profile) == 1800
    assert freshness_threshold(Connection(poll_interval_seconds=None), None) == 300


def test_catalog_missing_directory_is_empty(tmp_path: Path) -> None:
    assert ProfileCatalog.load(tmp_path / "brak").all() == []


def test_device_metrics_come_from_profile_without_unsupported() -> None:
    catalog = ProfileCatalog.load(PROFILES_DIR)
    profile = catalog.get("simulated.hybrid-inverter", "0.1.0")
    assert profile is not None
    metrics = device_metrics(profile)
    keys = [(m.key, m.channel) for m in metrics]
    assert keys[0] == ("pv_power", None)
    assert ("pv_string_voltage", 1) in keys
    assert ("battery_temperature", None) not in keys  # UNSUPPORTED w profilu
    assert len(keys) == len(set(keys))
    energy = next(m for m in metrics if m.key == "pv_energy_total")
    assert (energy.unit, energy.cumulative) == ("Wh", True)
    assert device_metrics(None) == []
