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


CHANGELOG_SAMPLE = """# Zmiany

Wstęp.

## 0.3.0

- Wykresy.
- Luki.

## 0.2.0 (2026-11-08)

- Przepływ.
"""


def test_changelog_notes_take_only_the_version_section() -> None:
    assert release.changelog_notes("0.3.0", CHANGELOG_SAMPLE) == "- Wykresy.\n- Luki."
    assert release.changelog_notes("0.2.0", CHANGELOG_SAMPLE) == "- Przepływ."
    with pytest.raises(SystemExit, match=r"Brak opisu wersji 0\.4\.0"):
        release.changelog_notes("0.4.0", CHANGELOG_SAMPLE)
    with pytest.raises(SystemExit, match="ponad 2000"):
        release.changelog_notes("0.3.0", "## 0.3.0\n" + "x" * 2001)


def test_changelog_describes_current_version() -> None:
    """Workflow wydania (D67) nie opublikuje wersji bez opisu — pilnujemy tego w PR."""
    assert release.changelog_notes(release.read_versions()[release.SOURCE])


def test_key_from_environment_signs_verifiable_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    public = release.keygen(tmp_path / "klucz.pem")
    # Sekret w CI bywa wklejony bez końcowej nowej linii albo z CRLF.
    pem = (tmp_path / "klucz.pem").read_text().strip().replace("\n", "\r\n")
    monkeypatch.setenv("TEST_SIGNING_KEY", pem)
    release.sign_manifest(
        release.load_private_key_env("TEST_SIGNING_KEY"),
        version="0.3.0",
        min_upgrade_from="0.1.0",
        notes="Test.",
        info_url="https://example.com/wydanie",
        security=False,
        released_at=datetime(2026, 12, 1, tzinfo=UTC),
        out=tmp_path / "dist",
    )
    assert release.verify_release(tmp_path / "dist", "0.3.0", public).version == "0.3.0"
    with pytest.raises(SystemExit, match=r"oczekiwano 0\.4\.0"):
        release.verify_release(tmp_path / "dist", "0.4.0", public)
    other = release.keygen(tmp_path / "inny.pem")
    with pytest.raises(SystemExit, match="INVALID_SIGNATURE"):
        release.verify_release(tmp_path / "dist", "0.3.0", other)
    with pytest.raises(SystemExit, match="klucza publicznego"):
        release.verify_release(tmp_path / "dist", "0.3.0", None)


def test_missing_or_broken_key_in_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TEST_SIGNING_KEY", raising=False)
    with pytest.raises(SystemExit, match="Brak klucza podpisu"):
        release.load_private_key_env("TEST_SIGNING_KEY")
    monkeypatch.setenv("TEST_SIGNING_KEY", "nie-klucz")
    with pytest.raises(SystemExit, match="Nie udało się odczytać"):
        release.load_private_key_env("TEST_SIGNING_KEY")
