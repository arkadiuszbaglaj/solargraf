"""Instalacja aktualizacji z aplikacji (D65): plik-flaga dla usługi hosta i stan aktualizacji.

API nie ma uprawnień do hosta. Zlecenie to pusty plik ``update`` w katalogu zapisywalnym przez
kontener API; usługa systemd hosta (``solargraf-update.path``) uruchamia wtedy
``install.sh update --from-request``, która ignoruje treść flagi i bierze wersję wyłącznie
z podpisanego manifestu. Wynik zapisuje skrypt (root) w osobnym katalogu, który API tylko czyta.
"""

from __future__ import annotations

import errno
import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from pathlib import Path

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

REQUEST_NAME = "update"
STATUS_NAME = "status.json"
MAX_STATUS_BYTES = 4096
# Stan RUNNING starszy niż tyle uznajemy za przerwany (np. restart serwera w trakcie).
RUNNING_STALE_AFTER = timedelta(hours=3)

_VERSION = r"^\d+\.\d+\.\d+$"
# Linux (kontener API); na innych systemach (testy lokalne) flaga bez ochrony przed dowiązaniem.
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class JobState(StrEnum):
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"  # błąd przed zmianą wersji albo nieudany powrót
    ROLLED_BACK = "ROLLED_BACK"  # błąd po zmianie, przywrócono poprzednią wersję
    NO_UPDATE = "NO_UPDATE"  # manifest nie ma nowszej wersji do bezpośredniej instalacji


class JobStep(StrEnum):
    CHECK = "CHECK"
    BACKUP = "BACKUP"
    BUILD = "BUILD"
    START = "START"
    ROLLBACK = "ROLLBACK"
    CLEANUP = "CLEANUP"
    DONE = "DONE"


class JobReason(StrEnum):
    """Znana przyczyna błędu, którą UI opisuje konkretnie (zamiast samego etapu)."""

    LOW_DISK = "LOW_DISK"  # za mało miejsca w /var/lib także po usunięciu cache budowania


class Job(BaseModel):
    """Plik stanu zapisany przez ``install.sh`` — walidowany jak każda dana z granicy systemu."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    state: JobState
    step: JobStep
    from_version: str | None = Field(default=None, pattern=_VERSION)
    to_version: str | None = Field(default=None, pattern=_VERSION)
    started_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    # Starsze wersje skryptu nie zapisują tych pól — wtedy None.
    reason: JobReason | None = None
    # MB (MiB z ``df -Pm``) w /var/lib; tylko przy ``LOW_DISK``.
    free_mb: int | None = Field(default=None, ge=0)
    required_mb: int | None = Field(default=None, ge=0)
    # MB odzyskane przy sprzątaniu po udanej aktualizacji (D17); brak u starszych wersji skryptu.
    reclaimed_mb: int | None = Field(default=None, ge=0)


@dataclass(frozen=True)
class InstallDirs:
    request: Path
    status: Path


def supported(dirs: InstallDirs | None) -> bool:
    """Instalator przygotował katalogi (host z systemd) i kontener może zapisać flagę."""
    return (
        dirs is not None
        and dirs.request.is_dir()
        and os.access(dirs.request, os.W_OK)
        and dirs.status.is_dir()
    )


def requested(dirs: InstallDirs | None) -> bool:
    """Flaga czeka na usługę hosta (lexists — także dowiązanie, którego nie śledzimy)."""
    return dirs is not None and os.path.lexists(dirs.request / REQUEST_NAME)


def read_job(dirs: InstallDirs | None) -> Job | None:
    """Ostatnia aktualizacja; brak albo nieczytelny plik — None (nie zgadujemy stanu)."""
    if dirs is None:
        return None
    try:
        fd = os.open(dirs.status / STATUS_NAME, os.O_RDONLY | _NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as handle:
        raw = handle.read(MAX_STATUS_BYTES + 1)
    if len(raw) > MAX_STATUS_BYTES:
        return None
    try:
        return Job.model_validate(json.loads(raw))
    except (ValueError, ValidationError):
        return None


def running(job: Job | None, now: datetime) -> bool:
    return (
        job is not None
        and job.state is JobState.RUNNING
        and now - job.started_at < RUNNING_STALE_AFTER
    )


def request_install(dirs: InstallDirs) -> bool:
    """Tworzy pustą flagę (bez nadpisywania i bez podążania za dowiązaniem). False — już jest."""
    try:
        fd = os.open(
            dirs.request / REQUEST_NAME,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW,
            0o600,
        )
    except OSError as exc:
        if exc.errno in (errno.EEXIST, errno.ELOOP):
            return False
        raise
    os.close(fd)
    return True
