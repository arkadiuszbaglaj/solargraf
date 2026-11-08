"""Narzędzie wydania (D63): wersja aplikacji, klucz podpisu i podpisany manifest wersji.

    uv run python tools/release.py version            # bieżąca wersja i spójność plików
    uv run python tools/release.py version 0.2.0      # ustawia wersję we wszystkich pakietach
    uv run python tools/release.py keygen --out ŚCIEŻKA_POZA_REPOZYTORIUM
    uv run python tools/release.py manifest --key KLUCZ --notes "…" --info-url https://… --out dist/

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

from solargraf_server.updates.manifest import Manifest, manifest_json, parse_version

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "server/src/solargraf_server/__init__.py"
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
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit("To nie jest klucz Ed25519.")
    return key


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
    p_manifest.add_argument("--key", type=Path, required=True)
    p_manifest.add_argument("--notes", required=True)
    p_manifest.add_argument("--info-url", required=True)
    p_manifest.add_argument("--min-upgrade-from", default="0.1.0")
    p_manifest.add_argument("--security", action="store_true")
    p_manifest.add_argument("--out", type=Path, default=ROOT / "dist")
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
    manifest_path, signature_path = sign_manifest(
        load_private_key(args.key),
        version=version,
        min_upgrade_from=args.min_upgrade_from,
        notes=args.notes,
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
