"""Katalog profili urządzeń po stronie serwera i ``GET /api/profiles`` (D44).

Serwer czyta te same pliki co agent (``profiles/`` w obrazie), żeby nie przyjąć urządzenia
z profilem, którego agent nie zna. Szczegóły rejestrów nie wychodzą poza serwer.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from solargraf_profiles.catalog import DeviceKind, Transport
from solargraf_profiles.loader import load_directory
from solargraf_profiles.model import Profile, ProfileOrigin, SupportLevel
from solargraf_server.auth.deps import AuthContext, current_auth

log = logging.getLogger("solargraf_server")

router = APIRouter(prefix="/api/profiles", tags=["profiles"])

ProfileKey = tuple[str, str]


class ProfileCatalog:
    def __init__(self, profiles: list[Profile]) -> None:
        self._by_key: dict[ProfileKey, Profile] = {(p.id, p.version): p for p in profiles}

    @classmethod
    def load(cls, directory: Path) -> ProfileCatalog:
        if not directory.is_dir():
            log.warning("Brak katalogu profili %s — katalog pusty", directory)
            return cls([])
        result = load_directory(directory)
        for error in result.errors:
            log.warning("Profil pominięty: %s", error)
        return cls(result.profiles)

    def get(self, profile_id: str, version: str) -> Profile | None:
        return self._by_key.get((profile_id, version))

    def all(self) -> list[Profile]:
        return sorted(self._by_key.values(), key=lambda p: (p.name, p.id, p.version))


def get_catalog(request: Request) -> ProfileCatalog:
    catalog: ProfileCatalog = request.app.state.profiles
    return catalog


Catalog = Annotated[ProfileCatalog, Depends(get_catalog)]


class ProfileOut(BaseModel):
    id: str
    version: str
    name: str
    manufacturer: str
    device_kind: DeviceKind
    origin: ProfileOrigin
    support_level: SupportLevel
    models: list[str]
    transports: list[Transport]
    poll_interval_seconds: int
    live_interval_seconds: float | None = None


@router.get("", response_model=list[ProfileOut])
async def list_profiles(
    catalog: Catalog, _auth: Annotated[AuthContext, Depends(current_auth)]
) -> list[ProfileOut]:
    return [
        ProfileOut(
            id=p.id,
            version=p.version,
            name=p.name,
            manufacturer=p.manufacturer,
            device_kind=p.device_kind,
            origin=p.origin,
            support_level=p.support_level,
            models=p.models,
            transports=p.transports,
            poll_interval_seconds=p.polling.interval_seconds,
            live_interval_seconds=p.polling.live_interval_seconds,
        )
        for p in catalog.all()
    ]
