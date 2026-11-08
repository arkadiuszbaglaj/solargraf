"""Klucz publiczny podpisu manifestu wersji (D63): 32 bajty Ed25519 w base64.

Klucz prywatny jest tylko u właściciela produktu (``tools/release.py keygen``) — nigdy
w repozytorium.
``None`` — klucz jeszcze nie wygenerowany: aplikacja nie sprawdza aktualizacji (stan NOT_CONFIGURED)
i nie wykonuje żadnych połączeń wychodzących w tym celu.
"""

from __future__ import annotations

RELEASE_PUBLIC_KEY: str | None = None
