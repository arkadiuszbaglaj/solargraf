from email.message import Message
from importlib import metadata
from typing import cast

import pytest

from tools.check_licenses import (
    Policy,
    evaluate,
    expression_allowed,
    load_policy,
    npm_license,
    python_license,
)

ALLOWED = frozenset({"MIT", "Apache-2.0", "BSD-3-Clause", "ISC"})
POLICY = Policy(allowed=ALLOWED, exceptions={})


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("MIT", True),
        ("Apache-2.0", True),
        ("MIT OR GPL-3.0-only", True),
        ("GPL-3.0-only OR MIT", True),
        ("MIT AND Apache-2.0", True),
        ("MIT AND GPL-3.0-only", False),
        ("GPL-3.0-only", False),
        ("AGPL-3.0-or-later", False),
        ("LGPL-2.1-only", False),
        ("SSPL-1.0", False),
        ("BUSL-1.1", False),
        ("(MIT OR GPL-2.0-only) AND ISC", True),
        ("(GPL-2.0-only OR LGPL-3.0-only) AND MIT", False),
        ("Apache-2.0 WITH LLVM-exception", False),
        ("(MIT", False),
        ("", False),
        ("apache 2.0", False),  # alias wielowyrazowy nie jest poprawnym wyrażeniem SPDX
    ],
)
def test_expression_allowed(expression: str, expected: bool) -> None:
    assert expression_allowed(expression, ALLOWED) is expected


def test_alias_is_normalized() -> None:
    assert expression_allowed("BSD", ALLOWED)


def _meta(**fields: str | list[str]) -> metadata.PackageMetadata:
    msg = Message()
    for key, value in fields.items():
        header = key.replace("_", "-")
        for v in value if isinstance(value, list) else [value]:
            msg[header] = v
    return cast(metadata.PackageMetadata, msg)


def test_python_license_prefers_expression() -> None:
    meta = _meta(License_Expression="MIT", License="GPL", Classifier=[])
    assert python_license(meta) == "MIT"


def test_python_license_falls_back_to_classifiers() -> None:
    meta = _meta(
        License="Copyright (c) X\n\nLong license text...",
        Classifier=["License :: OSI Approved :: GNU General Public License v3 (GPLv3)"],
    )
    assert python_license(meta) == "GPL-3.0"


def test_python_license_unknown_is_none() -> None:
    assert python_license(_meta(License="UNKNOWN")) is None


def test_gpl_dependency_is_blocked() -> None:
    finding = evaluate("evil-lib", "1.0", "GPL-3.0-only", POLICY)
    assert not finding.ok


def test_unknown_license_is_blocked() -> None:
    assert not evaluate("mystery", "1.0", None, POLICY).ok


def test_exception_overrides_metadata() -> None:
    policy = Policy(allowed=ALLOWED, exceptions={"odd-lib": "MIT"})
    assert evaluate("odd-lib", "1.0", None, policy).ok


@pytest.mark.parametrize(
    ("package", "expected"),
    [
        ({"license": "MIT"}, "MIT"),
        ({"license": {"type": "ISC"}}, "ISC"),
        ({"licenses": [{"type": "MIT"}, {"type": "Apache-2.0"}]}, "MIT OR Apache-2.0"),
        ({}, None),
    ],
)
def test_npm_license(package: dict[str, object], expected: str | None) -> None:
    assert npm_license(package) == expected


def test_repository_policy_matches_compliance_doc() -> None:
    policy = load_policy()
    assert {"MIT", "BSD-3-Clause", "Apache-2.0", "ISC", "PostgreSQL", "Zlib"} <= policy.allowed
    assert not any(x.startswith(("GPL", "AGPL", "LGPL", "SSPL", "BUSL")) for x in policy.allowed)
    # Wyjątek może tylko potwierdzić licencję z listy dozwolonych, nie dopuścić innej.
    assert all(expression_allowed(lic, policy.allowed) for lic in policy.exceptions.values())
