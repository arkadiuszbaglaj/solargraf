"""Sprawdzanie aktualizacji (D63) bez sieci i bazy: podpis, treść manifestu, porównanie wersji."""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from solargraf_server import cli
from solargraf_server.updates import manifest as mf
from solargraf_server.updates import service
from solargraf_server.updates.release_key import RELEASE_PUBLIC_KEY

# Klucz tylko do testów — generowany przy każdym uruchomieniu, nigdzie nie zapisywany.
KEY = Ed25519PrivateKey.generate()
PUBLIC = base64.b64encode(
    KEY.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
).decode()

MANIFEST = {
    "product": "solargraf",
    "channel": "stable",
    "version": "0.3.0",
    "released_at": "2026-12-01T10:00:00Z",
    "min_upgrade_from": "0.2.0",
    "security": False,
    "notes": "Poprawki.",
    "info_url": "https://example.com/wydanie",
}


def signed(body: dict[str, object] | bytes) -> tuple[bytes, bytes]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return raw, base64.b64encode(KEY.sign(raw))


def manifest(**overrides: object) -> mf.Manifest:
    return mf.Manifest.model_validate(MANIFEST | overrides)


def test_parse_version_accepts_only_stable() -> None:
    assert mf.parse_version("1.20.3") == (1, 20, 3)
    for text in ("1.0", "1.0.0-rc.1", "01.0.0", "github:main", "v1.0.0", ""):
        assert mf.parse_version(text) is None, text


def test_valid_signature_and_manifest() -> None:
    body, sig = signed(MANIFEST)
    result = mf.verify(body, sig, mf.load_public_key(PUBLIC))
    assert result.version == "0.3.0"
    assert result.released_at == datetime(2026, 12, 1, 10, tzinfo=UTC)


def test_tampered_body_or_other_key_is_rejected() -> None:
    body, sig = signed(MANIFEST)
    with pytest.raises(mf.ManifestRejected) as exc:
        mf.verify(body.replace(b"0.3.0", b"9.9.9"), sig, mf.load_public_key(PUBLIC))
    assert exc.value.code is mf.CheckError.INVALID_SIGNATURE
    other = Ed25519PrivateKey.generate().public_key()
    with pytest.raises(mf.ManifestRejected):
        mf.verify(body, sig, other)
    with pytest.raises(mf.ManifestRejected):
        mf.verify(body, b"nie-base64!", mf.load_public_key(PUBLIC))


def test_signed_but_invalid_content_is_rejected() -> None:
    key = mf.load_public_key(PUBLIC)
    for bad in (
        MANIFEST | {"version": "1.0.0-rc.1"},
        MANIFEST | {"product": "inny"},
        MANIFEST | {"info_url": "http://example.com"},
        MANIFEST | {"released_at": "2026-12-01T10:00:00"},  # bez strefy
        b"{nie json",
    ):
        body, sig = signed(bad)
        with pytest.raises(mf.ManifestRejected) as exc:
            mf.verify(body, sig, key)
        assert exc.value.code is mf.CheckError.INVALID_MANIFEST


def test_too_large_is_rejected_before_parsing() -> None:
    body = b" " * (mf.MAX_MANIFEST_BYTES + 1)
    with pytest.raises(mf.ManifestRejected) as exc:
        mf.verify(body, b"", mf.load_public_key(PUBLIC))
    assert exc.value.code is mf.CheckError.TOO_LARGE


def test_availability_compares_locally() -> None:
    newer = mf.availability(manifest(), "0.2.5")
    assert newer is not None
    assert newer.direct_upgrade
    assert not mf.availability(manifest(), "0.1.0").direct_upgrade  # type: ignore[union-attr]
    assert mf.availability(manifest(), "0.3.0") is None
    assert mf.availability(manifest(), "0.10.0") is None  # 0.10 > 0.3 liczbowo
    assert mf.availability(manifest(), "github:main") is None


def test_upgrade_target_only_direct_newer() -> None:
    assert mf.upgrade_target(manifest(), "0.2.5") == "0.3.0"
    assert mf.upgrade_target(manifest(), "0.2.0") == "0.3.0"
    assert mf.upgrade_target(manifest(), "0.1.0") is mf.TargetRefused.INTERMEDIATE
    assert mf.upgrade_target(manifest(), "0.3.0") is mf.TargetRefused.NO_NEWER
    assert mf.upgrade_target(manifest(), "github:main") is mf.TargetRefused.NO_NEWER


def _serving(files: dict[str, bytes]) -> service.Fetch:
    async def fetch(url: str, timeout_s: float, limit: int) -> bytes:
        if url not in files:
            raise service.FetchError(mf.CheckError.NETWORK)
        return files[url]

    return fetch


URL = "https://example.com/manifest.json"


def _target(
    files: dict[str, bytes],
    current: str,
    capsys: pytest.CaptureFixture[str],
    key: str | None = PUBLIC,
) -> tuple[int, str, str]:
    fetch = _serving(files)
    code = asyncio.run(
        cli.update_target(url=URL, timeout_s=1, public_key=key, current=current, fetch=fetch)
    )
    out = capsys.readouterr()
    return code, out.out, out.err


def test_update_target_prints_only_verified_version(capsys: pytest.CaptureFixture[str]) -> None:
    body, sig = signed(MANIFEST)
    assert _target({URL: body, URL + ".sig": sig}, "0.2.0", capsys) == (0, "0.3.0\n", "")


def test_update_target_refusals(capsys: pytest.CaptureFixture[str]) -> None:
    body, sig = signed(MANIFEST)
    files = {URL: body, URL + ".sig": sig}
    code, out, err = _target(files, "0.3.0", capsys)
    assert (code, out) == (cli.EXIT_NO_NEWER, "")
    assert "Brak nowszej wersji" in err
    code, out, err = _target(files, "0.1.0", capsys)
    assert (code, out) == (cli.EXIT_INTERMEDIATE, "")
    assert "0.2.0" in err
    # Zmieniona treść albo brak sieci — nic na stdout, skrypt nie dostaje wersji.
    tampered = {URL: body.replace(b"0.3.0", b"9.0.0"), URL + ".sig": sig}
    code, out, err = _target(tampered, "0.2.0", capsys)
    assert (code, out) == (cli.EXIT_CHECK_FAILED, "")
    assert "INVALID_SIGNATURE" in err
    assert _target({}, "0.2.0", capsys)[:2] == (cli.EXIT_CHECK_FAILED, "")
    assert _target(files, "0.2.0", capsys, key=None)[:2] == (cli.EXIT_CHECK_FAILED, "")


def test_fetch_refuses_plain_http() -> None:
    with pytest.raises(service.FetchError) as exc:
        asyncio.run(service.fetch_https("http://example.com/manifest.json", 1, 100))
    assert exc.value.code is mf.CheckError.NETWORK


def test_canonical_manifest_roundtrip() -> None:
    body, sig = signed(mf.manifest_json(manifest()))
    assert mf.verify(body, sig, mf.load_public_key(PUBLIC)) == manifest()


def test_release_key_is_valid_or_absent() -> None:
    # Brak klucza = sprawdzanie wyłączone (NOT_CONFIGURED); obecny musi być poprawnym kluczem.
    if RELEASE_PUBLIC_KEY is not None:
        mf.load_public_key(RELEASE_PUBLIC_KEY)
