import re

import solargraf_server


def test_version_is_semver() -> None:
    # Wartość ustawia `tools/release.py version`; spójność wszystkich plików — tools/tests.
    assert re.fullmatch(r"\d+\.\d+\.\d+", solargraf_server.__version__)
