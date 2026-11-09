"""Walidacja partii agenta bez bazy (D42)."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError

from solargraf_server.agent_api import BatchIn, LiveIn, ReadingIn

AT = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


def reading(**change: Any) -> dict[str, Any]:  # noqa: ANN401
    return {
        "metric": "pv_power",
        "value": 1.0,
        "quality": "GOOD",
        "origin": "DEVICE",
        "received_at": AT,
    } | change


def test_valid_readings() -> None:
    assert ReadingIn.model_validate(reading()).value == 1.0
    assert ReadingIn.model_validate(reading(quality="MISSING", value=None)).value is None
    assert ReadingIn.model_validate(reading(quality="INVALID", value=None)).quality == "INVALID"
    voltage = reading(metric="grid_voltage", channel=2, value=230.0)
    assert ReadingIn.model_validate(voltage).channel == 2


@pytest.mark.parametrize(
    "change",
    [
        {"metric": "grid_magic"},
        {"value": None},
        {"quality": "MISSING"},
        {"quality": "STALE"},
        {"origin": "DEMO"},
        {"channel": 1},
        {"metric": "grid_voltage", "value": 230.0},
        {"received_at": datetime(2026, 11, 7, 12, 0)},
        {"value": float("inf")},
        {"extra": 1},
    ],
)
def test_invalid_readings(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ReadingIn.model_validate(reading(**change))


def test_batch_latest_time_and_run_order() -> None:
    run = {
        "device_id": "00000000-0000-0000-0000-000000000001",
        "started_at": AT,
        "finished_at": AT + timedelta(seconds=2),
        "result": "OK",
        "readings": [reading(received_at=AT + timedelta(seconds=5))],
    }
    batch = BatchIn.model_validate(
        {"batch_id": "00000000-0000-0000-0000-000000000002", "runs": [run]}
    )
    assert batch.latest_time() == AT + timedelta(seconds=5)
    with pytest.raises(ValidationError, match="finished_at"):
        BatchIn.model_validate(
            {
                "batch_id": "00000000-0000-0000-0000-000000000002",
                "runs": [run | {"finished_at": AT - timedelta(seconds=1)}],
            }
        )
    with pytest.raises(ValidationError):
        BatchIn.model_validate({"batch_id": "00000000-0000-0000-0000-000000000002", "runs": []})


def test_live_preview_limits() -> None:
    run = {
        "device_id": "00000000-0000-0000-0000-000000000001",
        "started_at": AT,
        "finished_at": AT,
        "result": "OK",
        "readings": [reading()],
    }
    assert len(LiveIn.model_validate({"runs": [run]}).runs) == 1
    bad_bodies: list[dict[str, Any]] = [
        {"runs": []},
        {"runs": [run] * 51},
        {"runs": [run], "batch_id": "x"},
    ]
    for bad in bad_bodies:
        with pytest.raises(ValidationError):
            LiveIn.model_validate(bad)
