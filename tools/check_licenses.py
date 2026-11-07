"""Kontrola licencji zależności produkcyjnych (docs/COMPLIANCE.md).

Użycie:
    uv run python tools/check_licenses.py python   # zależności Pythona bez grupy dev
    uv run python tools/check_licenses.py npm      # zależności produkcyjne web/ (npm query .prod)

Kończy się kodem 1, jeśli którakolwiek zależność ma licencję spoza listy dozwolonych
albo licencji nie da się jednoznacznie ustalić. Pakiety własne (prefiks ``solargraf``)
są pomijane.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = ROOT / "tools" / "license-policy.json"
OWN_PREFIX = "solargraf"
SUBPROCESS_TIMEOUT_S = 120

# Mapowanie klasyfikatorów PyPI na identyfikatory SPDX (tylko jednoznaczne przypadki).
CLASSIFIER_TO_SPDX: dict[str, str] = {
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: MIT No Attribution License (MIT-0)": "MIT-0",
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
    "License :: OSI Approved :: zlib/libpng License": "Zlib",
    "License :: OSI Approved :: PostgreSQL License": "PostgreSQL",
    "License :: OSI Approved :: GNU General Public License (GPL)": "GPL",
    "License :: OSI Approved :: GNU General Public License v2 (GPLv2)": "GPL-2.0",
    "License :: OSI Approved :: GNU General Public License v3 (GPLv3)": "GPL-3.0",
    "License :: OSI Approved :: GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0",
    "License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0",
    "License :: OSI Approved :: GNU Affero General Public License v3": "AGPL-3.0",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
}
# "BSD License" nie mówi, czy to 2- czy 3-Clause; obie są dozwolone, więc traktujemy jako BSD-3.
CLASSIFIER_TO_SPDX["License :: OSI Approved :: BSD License"] = "BSD-3-Clause"

# Popularne nieformalne zapisy w polu License / package.json.
ALIASES: dict[str, str] = {
    "MIT LICENSE": "MIT",
    "APACHE 2.0": "Apache-2.0",
    "APACHE-2": "Apache-2.0",
    "APACHE LICENSE 2.0": "Apache-2.0",
    "APACHE SOFTWARE LICENSE": "Apache-2.0",
    "BSD": "BSD-3-Clause",
    "BSD-3": "BSD-3-Clause",
    "BSD-2": "BSD-2-Clause",
    "PSF": "PSF-2.0",
}


@dataclass(frozen=True)
class Policy:
    allowed: frozenset[str]
    exceptions: dict[str, str]  # nazwa pakietu -> zweryfikowana licencja SPDX


@dataclass(frozen=True)
class Finding:
    package: str
    version: str
    license: str | None
    ok: bool


def load_policy(path: Path = POLICY_PATH) -> Policy:
    raw = json.loads(path.read_text(encoding="utf-8"))
    allowed = frozenset(str(x) for x in raw["allowed"])
    exceptions = {str(k): str(v["license"]) for k, v in dict(raw.get("exceptions", {})).items()}
    return Policy(allowed=allowed, exceptions=exceptions)


def normalize(identifier: str) -> str:
    ident = identifier.strip()
    return ALIASES.get(ident.upper(), ident)


_TOKEN = re.compile(r"\(|\)|[^\s()]+")


def expression_allowed(expression: str, allowed: frozenset[str]) -> bool:
    """Ocena wyrażenia SPDX z operatorami AND/OR i nawiasami.

    ``OR`` — wystarczy jedna dozwolona licencja; ``AND`` — wszystkie muszą być dozwolone.
    ``WITH`` (wyjątki) jest odrzucane, bo wymaga ręcznej oceny.
    """
    tokens = _TOKEN.findall(expression)
    if not tokens:
        return False
    pos = 0

    def parse_or() -> bool:
        nonlocal pos
        result = parse_and()
        while pos < len(tokens) and tokens[pos].upper() == "OR":
            pos += 1
            rhs = parse_and()
            result = result or rhs
        return result

    def parse_and() -> bool:
        nonlocal pos
        result = parse_atom()
        while pos < len(tokens) and tokens[pos].upper() == "AND":
            pos += 1
            rhs = parse_atom()
            result = result and rhs
        return result

    def parse_atom() -> bool:
        nonlocal pos
        if pos >= len(tokens):
            raise ValueError("niepełne wyrażenie")
        tok = tokens[pos]
        pos += 1
        if tok == "(":
            value = parse_or()
            if pos >= len(tokens) or tokens[pos] != ")":
                raise ValueError("brak nawiasu zamykającego")
            pos += 1
            return value
        if tok.upper() in {"AND", "OR", "WITH", ")"}:
            raise ValueError(f"nieoczekiwany token {tok!r}")
        return normalize(tok) in allowed

    try:
        value = parse_or()
    except ValueError:
        return False
    if pos != len(tokens):  # np. "WITH" lub nadmiarowe tokeny
        return False
    return value


def python_license(meta: metadata.PackageMetadata) -> str | None:
    """Licencja z metadanych.

    Kolejność: License-Expression (PEP 639) > krótkie pole License > klasyfikatory.
    """
    expression = meta.get("License-Expression")
    if expression:
        return str(expression).strip()
    field = meta.get("License")
    if field and "\n" not in field and len(field) <= 64 and field.strip().upper() != "UNKNOWN":
        return normalize(field)
    spdx = sorted(
        {CLASSIFIER_TO_SPDX[c] for c in meta.get_all("Classifier") or [] if c in CLASSIFIER_TO_SPDX}
    )
    if spdx:
        # Wiele klasyfikatorów zwykle oznacza wybór licencji (dual licensing).
        return " OR ".join(spdx)
    return None


def npm_license(package: dict[str, object]) -> str | None:
    value = package.get("license")
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        typ = value.get("type")
        if isinstance(typ, str):
            return typ.strip()
    legacy = package.get("licenses")
    if isinstance(legacy, list):
        types = [str(x["type"]) for x in legacy if isinstance(x, dict) and "type" in x]
        if types:
            return " OR ".join(types)
    return None


def evaluate(name: str, version: str, license_: str | None, policy: Policy) -> Finding:
    if name in policy.exceptions:
        license_ = policy.exceptions[name]
    ok = license_ is not None and expression_allowed(license_, policy.allowed)
    return Finding(package=name, version=version, license=license_, ok=ok)


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def python_production_packages() -> list[tuple[str, str]]:
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("nie znaleziono uv w PATH")
    out = subprocess.run(  # noqa: S603 — stała lista argumentów
        [uv, "export", "--no-dev", "--no-hashes", "--no-header", "--frozen", "--no-emit-project"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=SUBPROCESS_TIMEOUT_S,
    ).stdout
    packages: list[tuple[str, str]] = []
    for line in out.splitlines():
        line = line.split(";")[0].strip()
        if not line or line.startswith(("#", "-e", "-")):
            continue
        name, _, version = line.partition("==")
        packages.append((name.strip(), version.strip()))
    return packages


def check_python(policy: Policy) -> list[Finding]:
    findings: list[Finding] = []
    for name, version in python_production_packages():
        if _canonical(name).startswith(OWN_PREFIX):
            continue
        try:
            meta = metadata.metadata(name)
        except metadata.PackageNotFoundError:
            findings.append(Finding(name, version, None, ok=False))
            continue
        findings.append(evaluate(name, version, python_license(meta), policy))
    return findings


def check_npm(policy: Policy, web_dir: Path = ROOT / "web") -> list[Finding]:
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("nie znaleziono npm w PATH")
    out = subprocess.run(  # noqa: S603 — stała lista argumentów
        [npm, "query", ".prod"],
        cwd=web_dir,
        capture_output=True,
        text=True,
        check=True,
        timeout=SUBPROCESS_TIMEOUT_S,
    ).stdout
    data = json.loads(out)
    if not isinstance(data, list):
        raise RuntimeError("nieoczekiwany format wyniku npm query")
    findings: list[Finding] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "?"))
        if _canonical(name).startswith(OWN_PREFIX):
            continue
        findings.append(evaluate(name, str(item.get("version", "?")), npm_license(item), policy))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("ecosystem", choices=["python", "npm"])
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    policy = load_policy()
    findings = check_python(policy) if args.ecosystem == "python" else check_npm(policy)
    bad = [f for f in findings if not f.ok]
    for f in sorted(findings, key=lambda f: f.package.lower()):
        mark = "OK  " if f.ok else "FAIL"
        print(f"{mark} {f.package}=={f.version}  [{f.license or 'nieznana'}]")
    print(f"\n{args.ecosystem}: {len(findings)} zależności, {len(bad)} niezgodnych.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
