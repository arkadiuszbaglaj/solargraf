from datetime import UTC, datetime
from pathlib import Path

import pytest

from solargraf_server.updates import manifest as mf
from tools import release


def test_all_version_files_match_server_version() -> None:
    versions = release.read_versions()
    assert len(set(versions.values())) == 1, versions
    assert mf.parse_version(versions[release.SOURCE]) is not None


def test_keygen_refuses_repository_and_existing_file(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="repozytorium"):
        release.keygen(release.ROOT / "dist" / "klucz.pem")
    out = tmp_path / "klucz.pem"
    release.keygen(out)
    with pytest.raises(SystemExit, match="istnieje"):
        release.keygen(out)


def test_signed_manifest_verifies_with_server_code(tmp_path: Path) -> None:
    public = release.keygen(tmp_path / "klucz.pem")
    key = release.load_private_key(tmp_path / "klucz.pem")
    manifest_path, signature_path = release.sign_manifest(
        key,
        version="0.2.0",
        min_upgrade_from="0.1.0",
        notes="Test.",
        info_url="https://example.com/wydanie",
        security=True,
        released_at=datetime(2026, 12, 1, tzinfo=UTC),
        out=tmp_path / "dist",
    )
    verified = mf.verify(
        manifest_path.read_bytes(), signature_path.read_bytes(), mf.load_public_key(public)
    )
    assert (verified.version, verified.security) == ("0.2.0", True)
    # Wyłącznie klucz publiczny w wyniku — prywatny nie trafia do pliku manifestu ani podpisu.
    assert b"PRIVATE" not in manifest_path.read_bytes()


def test_invalid_version_is_refused() -> None:
    with pytest.raises(SystemExit, match="MAJOR"):
        release.set_version("1.0")
