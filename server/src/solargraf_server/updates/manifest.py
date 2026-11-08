"""Manifest wersji i jego podpis (D15, D63) — bez sieci i bazy.

Manifest to plik JSON publikowany przy wydaniu; podpis Ed25519 obejmuje dokładnie jego bajty
(osobny plik ``.sig`` z podpisem w base64). Manifest bez ważnego podpisu jest odrzucany.
Tylko kanał stabilny: wersja ``MAJOR.MINOR.PATCH`` bez sufiksów.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime
from enum import StrEnum
from typing import Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, field_validator

PRODUCT = "solargraf"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_SIGNATURE_BYTES = 1024

_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

Version = tuple[int, int, int]


def parse_version(text: str) -> Version | None:
    """Wersja stabilna ``MAJOR.MINOR.PATCH``; inne (np. ``1.0.0-rc.1``, ``github:main``) — None."""
    m = _SEMVER.match(text.strip())
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


class CheckError(StrEnum):
    NOT_CONFIGURED = "NOT_CONFIGURED"  # brak klucza publicznego w tej wersji aplikacji
    NETWORK = "NETWORK"
    TOO_LARGE = "TOO_LARGE"
    INVALID_SIGNATURE = "INVALID_SIGNATURE"
    INVALID_MANIFEST = "INVALID_MANIFEST"


class ManifestRejected(Exception):
    def __init__(self, code: CheckError) -> None:
        super().__init__(code.value)
        self.code = code


class Manifest(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    product: Literal["solargraf"]
    channel: Literal["stable"]
    version: str
    released_at: AwareDatetime
    min_upgrade_from: str
    security: bool
    notes: str = Field(max_length=2000)
    info_url: str = Field(max_length=500)

    @field_validator("version", "min_upgrade_from")
    @classmethod
    def _stable(cls, value: str) -> str:
        if parse_version(value) is None:
            raise ValueError("wersja musi mieć postać MAJOR.MINOR.PATCH")
        return value

    @field_validator("info_url")
    @classmethod
    def _https(cls, value: str) -> str:
        if not value.startswith("https://"):
            raise ValueError("adres informacji o wydaniu musi używać HTTPS")
        return value


def load_public_key(encoded: str) -> Ed25519PublicKey:
    """Klucz publiczny Ed25519: 32 bajty w base64."""
    raw = base64.b64decode(encoded, validate=True)
    return Ed25519PublicKey.from_public_bytes(raw)


def verify(manifest_bytes: bytes, signature_text: bytes, key: Ed25519PublicKey) -> Manifest:
    """Sprawdza podpis, potem treść. Kolejność ważna: niepodpisanej treści nie parsujemy."""
    if len(manifest_bytes) > MAX_MANIFEST_BYTES or len(signature_text) > MAX_SIGNATURE_BYTES:
        raise ManifestRejected(CheckError.TOO_LARGE)
    try:
        signature = base64.b64decode(signature_text.strip(), validate=True)
        key.verify(signature, manifest_bytes)
    except (binascii.Error, ValueError, InvalidSignature):
        raise ManifestRejected(CheckError.INVALID_SIGNATURE) from None
    try:
        return Manifest.model_validate(json.loads(manifest_bytes))
    except (ValueError, ValidationError):
        raise ManifestRejected(CheckError.INVALID_MANIFEST) from None


def manifest_json(manifest: Manifest) -> bytes:
    """Kanoniczna postać manifestu do podpisania (narzędzie wydania)."""
    return (
        json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n"
    ).encode()


class Availability(BaseModel):
    version: str
    released_at: datetime
    security: bool
    notes: str
    info_url: str
    # False — bieżąca wersja jest starsza niż ``min_upgrade_from`` (aktualizacja pośrednia).
    direct_upgrade: bool


def availability(manifest: Manifest, current: str) -> Availability | None:
    """Nowsza wersja niż bieżąca albo None. Bieżąca bez numeru stabilnego — nie porównujemy."""
    latest = parse_version(manifest.version)
    mine = parse_version(current)
    minimum = parse_version(manifest.min_upgrade_from)
    if latest is None or mine is None or minimum is None or latest <= mine:
        return None
    return Availability(
        version=manifest.version,
        released_at=manifest.released_at,
        security=manifest.security,
        notes=manifest.notes,
        info_url=manifest.info_url,
        direct_upgrade=mine >= minimum,
    )


class TargetRefused(StrEnum):
    """Dlaczego polecenie ``update`` nie ma czego instalować (D65)."""

    NO_NEWER = "NO_NEWER"  # manifest nie ma wersji nowszej niż bieżąca (albo bieżąca bez numeru)
    INTERMEDIATE = "INTERMEDIATE"  # bieżąca starsza niż ``min_upgrade_from``


def upgrade_target(manifest: Manifest, current: str) -> str | TargetRefused:
    """Wersja do zainstalowania przez ``update`` z podpisanego manifestu albo powód odmowy."""
    found = availability(manifest, current)
    if found is None:
        return TargetRefused.NO_NEWER
    if not found.direct_upgrade:
        return TargetRefused.INTERMEDIATE
    return found.version
