"""Narzędzie wydania (D63): wersja aplikacji, klucz podpisu i podpisany manifest wersji.

    uv run python tools/release.py version            # bieżąca wersja i spójność plików
    uv run python tools/release.py version 0.2.0      # ustawia wersję we wszystkich pakietach
    uv run python tools/release.py keygen --out ŚCIEŻKA_POZA_REPOZYTORIUM
    uv run python tools/release.py manifest --key KLUCZ --info-url https://… --out dist/
    uv run python tools/release.py manifest --key-env RELEASE_SIGNING_KEY --info-url https://…
    uv run python tools/release.py verify --dir dist/   # podpis kluczem wbudowanym w aplikację
    uv run python tools/release.py notes                # opis bieżącej wersji z CHANGELOG.md

Wydanie publikuje workflow `.github/workflows/release.yml` (D67) po zmianie wersji w `main`;
klucz prywatny jest wtedy sekretem repozytorium i trafia do narzędzia tylko przez zmienną
środowiskową (nigdy na dysk). Opis wydania i manifestu pochodzi z sekcji wersji w CHANGELOG.md.

Źródłem wersji jest ``solargraf_server.__version__``; pozostałe pliki muszą mieć tę samą wartość
(sprawdza to test). Klucz prywatny nigdy nie trafia do repozytorium ani na ekran.
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from solargraf_server.updates import manifest as mf
from solargraf_server.updates.manifest import Manifest, manifest_json, parse_version
from solargraf_server.updates.release_key import RELEASE_PUBLIC_KEY

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server/src/solargraf_server/__init__.py"
CHANGELOG = ROOT / "CHANGELOG.md"
NOTES_MAX = 2000  # jak ``Manifest.notes``
# (plik, wzorzec z jedną grupą na numer wersji)
VERSION_FILES: tuple[tuple[Path, str], ...] = (
    (SOURCE, r'^__version__ = "([^"]+)"$'),
    (ROOT / "agent/src/solargraf_agent/__init__.py", r'^__version__ = "([^"]+)"$'),
    (ROOT / "pyproject.toml", r'^version = "([^"]+)"$'),
    (ROOT / "server/pyproject.toml", r'^version = "([^"]+)"$'),
    (ROOT / "agent/pyproject.toml", r'^version = "([^"]+)"$'),
    (ROOT / "profiles-schema/pyproject.toml", r'^version = "([^"]+)"$'),
    (ROOT / "simulator/pyproject.toml", r'^version = "([^"]+)"$'),
)


def read_versions() -> dict[Path, str]:
    found: dict[Path, str] = {}
    for path, pattern in VERSION_FILES:
        match = re.search(pattern, path.read_text(encoding="utf-8"), re.MULTILINE)
        if match is None:
            raise SystemExit(f"Brak numeru wersji w {path.relative_to(ROOT)}")
        found[path] = match[1]
    return found


def set_version(version: str) -> None:
    if parse_version(version) is None:
        raise SystemExit("Wersja musi mieć postać MAJOR.MINOR.PATCH.")
    for path, pattern in VERSION_FILES:
        text = path.read_text(encoding="utf-8")
        new, count = re.subn(
            pattern,
            lambda m: m[0].replace(m[1], version),
            text,
            count=1,
            flags=re.MULTILINE,
        )
        if count != 1:
            raise SystemExit(f"Brak numeru wersji w {path.relative_to(ROOT)}")
        path.write_text(new, encoding="utf-8", newline="\n")


def public_key_text(key: Ed25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def keygen(out: Path) -> str:
    out = out.resolve()
    if out.is_relative_to(ROOT):
        raise SystemExit("Klucz prywatny nie może leżeć w repozytorium — wskaż ścieżkę poza nim.")
    if out.exists():
        raise SystemExit(f"Plik {out} istnieje — nie nadpisuję klucza.")
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(pem)
    return public_key_text(key)


def load_private_key(path: Path) -> Ed25519PrivateKey:
    return load_private_key_pem(path.read_bytes())


def load_private_key_env(name: str) -> Ed25519PrivateKey:
    """Klucz PEM ze zmiennej środowiskowej (sekret CI) — bez zapisu na dysk."""
    pem = os.environ.get(name, "").strip()
    if not pem:
        raise SystemExit(f"Brak klucza podpisu w zmiennej {name} (sekret repozytorium).")
    return load_private_key_pem(pem.encode() + b"\n")


def load_private_key_pem(data: bytes) -> Ed25519PrivateKey:
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except (ValueError, TypeError):
        raise SystemExit("Nie udało się odczytać klucza prywatnego (PEM bez hasła).") from None
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit("To nie jest klucz Ed25519.")
    return key


def changelog_notes(version: str, text: str | None = None) -> str:
    """Treść sekcji ``## X.Y.Z`` z CHANGELOG.md (bez nagłówka), do następnej sekcji ``## ``."""
    if text is None:
        text = CHANGELOG.read_text(encoding="utf-8")
    lines: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("## "):
            if lines is not None:
                break
            if line[3:].strip().split()[0:1] == [version]:
                lines = []
            continue
        if lines is not None:
            lines.append(line)
    notes = "\n".join(lines or []).strip()
    if not notes:
        raise SystemExit(f"Brak opisu wersji {version} w CHANGELOG.md (sekcja „## {version}”).")
    if len(notes) > NOTES_MAX:
        raise SystemExit(f"Opis wersji {version} w CHANGELOG.md ma ponad {NOTES_MAX} znaków.")
    return notes


def verify_release(directory: Path, version: str, public_key: str | None) -> Manifest:
    """Sprawdza manifest i podpis tak jak aplikacja (klucz wbudowany) oraz numer wersji."""
    if public_key is None:
        raise SystemExit("Aplikacja nie ma klucza publicznego — manifest nie zostałby przyjęty.")
    try:
        manifest = mf.verify(
            (directory / "manifest.json").read_bytes(),
            (directory / "manifest.json.sig").read_bytes(),
            mf.load_public_key(public_key),
        )
    except mf.ManifestRejected as exc:
        raise SystemExit(f"Manifest odrzucony: {exc.code.value}.") from None
    if manifest.version != version:
        raise SystemExit(f"Manifest ma wersję {manifest.version}, oczekiwano {version}.")
    return manifest


def sign_manifest(
    key: Ed25519PrivateKey,
    *,
    version: str,
    min_upgrade_from: str,
    notes: str,
    info_url: str,
    security: bool,
    released_at: datetime,
    out: Path,
) -> tuple[Path, Path]:
    manifest = Manifest(
        product="solargraf",
        channel="stable",
        version=version,
        released_at=released_at,
        min_upgrade_from=min_upgrade_from,
        security=security,
        notes=notes,
        info_url=info_url,
    )
    body = manifest_json(manifest)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    signature_path = out / "manifest.json.sig"
    manifest_path.write_bytes(body)
    signature_path.write_bytes(base64.b64encode(key.sign(body)) + b"\n")
    return manifest_path, signature_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_version = sub.add_parser("version", help="pokaż albo ustaw wersję aplikacji")
    p_version.add_argument("new", nargs="?")
    p_keygen = sub.add_parser("keygen", help="nowy klucz podpisu (tylko raz, poza repozytorium)")
    p_keygen.add_argument("--out", type=Path, required=True)
    p_manifest = sub.add_parser("manifest", help="podpisany manifest bieżącej wersji")
    key_source = p_manifest.add_mutually_exclusive_group(required=True)
    key_source.add_argument("--key", type=Path, help="plik PEM klucza prywatnego")
    key_source.add_argument("--key-env", help="zmienna środowiskowa z kluczem PEM (CI)")
    p_manifest.add_argument("--notes", help="domyślnie sekcja wersji z CHANGELOG.md")
    p_manifest.add_argument("--info-url", required=True)
    p_manifest.add_argument("--min-upgrade-from", default="0.1.0")
    p_manifest.add_argument("--security", action="store_true")
    p_manifest.add_argument("--out", type=Path, default=ROOT / "dist")
    p_verify = sub.add_parser("verify", help="sprawdź podpisany manifest kluczem aplikacji")
    p_verify.add_argument("--dir", type=Path, default=ROOT / "dist")
    sub.add_parser("notes", help="opis bieżącej wersji z CHANGELOG.md")
    args = parser.parse_args(argv)

    if args.command == "version":
        if args.new:
            set_version(args.new)
        versions = read_versions()
        for path, value in versions.items():
            print(f"{value:10} {path.relative_to(ROOT)}")
        if len(set(versions.values())) != 1:
            print("Niespójne numery wersji.", file=sys.stderr)
            return 1
        return 0
    if args.command == "keygen":
        public = keygen(args.out)
        print(f"Klucz prywatny zapisany: {args.out} (600). Zrób jego kopię offline.")
        print("Klucz publiczny do server/src/solargraf_server/updates/release_key.py:")
        print(public)
        return 0
    version = read_versions()[SOURCE]
    if args.command == "notes":
        print(changelog_notes(version))
        return 0
    if args.command == "verify":
        verify_release(args.dir, version, RELEASE_PUBLIC_KEY)
        print(f"Manifest {version}: podpis zgodny z kluczem aplikacji.")
        return 0
    key = load_private_key(args.key) if args.key else load_private_key_env(args.key_env)
    manifest_path, signature_path = sign_manifest(
        key,
        version=version,
        min_upgrade_from=args.min_upgrade_from,
        notes=args.notes if args.notes else changelog_notes(version),
        info_url=args.info_url,
        security=args.security,
        released_at=datetime.now(UTC).replace(microsecond=0),
        out=args.out,
    )
    print(f"Manifest {version}: {manifest_path}, podpis: {signature_path}")
    print("Dołącz oba pliki do wydania na GitHubie (tag v" + version + ").")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
