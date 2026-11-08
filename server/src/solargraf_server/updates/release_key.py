"""Klucz publiczny podpisu manifestu wersji (D63): 32 bajty Ed25519 w base64.

Klucz prywatny jest u właściciela produktu (``tools/release.py keygen``) i jako sekret repozytorium
``RELEASE_SIGNING_KEY`` dla workflow wydania (D67) — nigdy w plikach repozytorium.
``None`` — klucz nie wygenerowany: aplikacja nie sprawdza aktualizacji (stan NOT_CONFIGURED)
i nie wykonuje żadnych połączeń wychodzących w tym celu.
Zmiana klucza oznacza, że instalacje ze starym kluczem odrzucą nowe manifesty — tylko po utracie
lub ujawnieniu klucza prywatnego.
"""

from __future__ import annotations

# Wygenerowany 2026-11-08 (tools/release.py keygen).
RELEASE_PUBLIC_KEY: str | None = "NdqWQvfOU3e9YmmE4nvzfHjX7qQdWAIXYBov+AH2RJ4="
