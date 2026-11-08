import re

import solargraf_agent


def test_version_is_semver() -> None:
    # Wartość ustawia `tools/release.py version`; spójność wszystkich plików — tools/tests.
    assert re.fullmatch(r"\d+\.\d+\.\d+", solargraf_agent.__version__)
