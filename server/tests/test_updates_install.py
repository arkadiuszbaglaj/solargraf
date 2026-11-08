"""Plik-flaga i stan aktualizacji (D65) bez bazy i bez hosta."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from solargraf_server.updates import install

NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)


def _dirs(tmp_path: Path) -> install.InstallDirs:
    dirs = install.InstallDirs(request=tmp_path / "request", status=tmp_path / "status")
    dirs.request.mkdir()
    dirs.status.mkdir()
    return dirs


def _write_status(dirs: install.InstallDirs, **fields: object) -> None:
    body = {"state": "SUCCESS", "step": "DONE", "started_at": NOW.isoformat()} | fields
    (dirs.status / install.STATUS_NAME).write_text(json.dumps(body))


def test_supported_requires_both_dirs(tmp_path: Path) -> None:
    assert install.supported(None) is False
    dirs = install.InstallDirs(request=tmp_path / "request", status=tmp_path / "status")
    assert install.supported(dirs) is False
    dirs.request.mkdir()
    assert install.supported(dirs) is False
    dirs.status.mkdir()
    assert install.supported(dirs) is True


def test_request_is_created_once(tmp_path: Path) -> None:
    dirs = _dirs(tmp_path)
    assert install.requested(dirs) is False
    assert install.request_install(dirs) is True
    assert install.requested(dirs) is True
    assert install.request_install(dirs) is False
    assert (dirs.request / install.REQUEST_NAME).read_bytes() == b""


@pytest.mark.skipif(sys.platform == "win32", reason="dowiązania i O_NOFOLLOW — Linux")
def test_request_does_not_follow_symlink(tmp_path: Path) -> None:
    dirs = _dirs(tmp_path)
    target = tmp_path / "elsewhere"
    os.symlink(target, dirs.request / install.REQUEST_NAME)
    assert install.request_install(dirs) is False
    assert not target.exists()
    assert install.requested(dirs) is True


def test_read_job_validates_status_file(tmp_path: Path) -> None:
    dirs = _dirs(tmp_path)
    assert install.read_job(dirs) is None
    _write_status(dirs, from_version="0.1.0", to_version="0.2.0", finished_at=NOW.isoformat())
    job = install.read_job(dirs)
    assert job is not None
    assert (job.state, job.step, job.to_version) == (
        install.JobState.SUCCESS,
        install.JobStep.DONE,
        "0.2.0",
    )
    assert (job.reason, job.free_mb, job.required_mb, job.reclaimed_mb) == (None, None, None, None)
    _write_status(dirs, finished_at=NOW.isoformat(), reclaimed_mb=812)
    job = install.read_job(dirs)
    assert job is not None
    assert job.reclaimed_mb == 812
    for bad in (
        {"state": "OTHER"},
        {"reason": "OTHER"},
        {"reason": "LOW_DISK", "free_mb": -1},
        {"reclaimed_mb": -5},
        {"to_version": "v0.2.0; rm -rf /"},
        {"started_at": "2026-11-08T12:00:00"},  # bez strefy
    ):
        _write_status(dirs, **bad)
        assert install.read_job(dirs) is None
    (dirs.status / install.STATUS_NAME).write_text("x" * (install.MAX_STATUS_BYTES + 1))
    assert install.read_job(dirs) is None


def test_read_job_low_disk_reason(tmp_path: Path) -> None:
    """Plik stanu z ``install.sh`` po braku miejsca (D65): przyczyna i liczby dla UI."""
    dirs = _dirs(tmp_path)
    _write_status(
        dirs,
        state="FAILED",
        step="CHECK",
        from_version="0.5.0",
        to_version="0.5.1",
        finished_at=NOW.isoformat(),
        reason="LOW_DISK",
        free_mb=4964,
        required_mb=5120,
    )
    job = install.read_job(dirs)
    assert job is not None
    assert (job.state, job.reason, job.free_mb, job.required_mb) == (
        install.JobState.FAILED,
        install.JobReason.LOW_DISK,
        4964,
        5120,
    )


def test_running_expires(tmp_path: Path) -> None:
    dirs = _dirs(tmp_path)
    _write_status(dirs, state="RUNNING", step="BUILD")
    job = install.read_job(dirs)
    assert install.running(job, NOW + timedelta(minutes=30)) is True
    assert install.running(job, NOW + install.RUNNING_STALE_AFTER) is False
    _write_status(dirs, state="ROLLED_BACK", step="DONE")
    assert install.running(install.read_job(dirs), NOW) is False
