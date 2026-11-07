# SolarGraf (nazwa robocza)

SolarGraf to planowana **komercyjna** aplikacja webowa do monitorowania instalacji PV, magazynów energii, falowników, liczników sieciowych i zużycia domu. Działa na serwerze klienta w sieci lokalnej (LAN) i jest dostępna w przeglądarce lub przez VPN. Jeden serwer obsługuje wiele instalacji.

Projekt zaczyna się od dokumentacji oraz kontrolowanego MVP; nie zakłada jeszcze potwierdzonej kompatybilności z konkretnymi urządzeniami.

> Nazwy „SolarGraf” i „SolarFlow” (z makiet) są już używane w branży PV. Przed sprzedażą trzeba wybrać i zweryfikować nazwę handlową — patrz [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

## Cele

- Dashboard zgodny funkcjonalnie z makietami w [`graf/`](graf/).
- Pomiary na żywo (z opóźnieniem zależnym od urządzenia) i dane historyczne.
- Przepływ energii, wykresy, stan urządzeń, alarmy i raporty.
- Obsługa wielu producentów przez sterowniki protokołów i deklaratywne profile urządzeń.
- Wiele instalacji i użytkowników na jednym serwerze, z izolacją danych.
- Instalacja na Linuksie (VM/LXC w Proxmox, mini-PC, Raspberry Pi 4/5) **jedną komendą w terminalu**; to samo narzędzie do aktualizacji, backupu i odinstalowania.
- Sprawdzanie dostępności nowej wersji (ręcznie lub automatycznie raz w tygodniu) z komunikatem w UI.
- Monitor stanu serwera w Ustawieniach: stabilność, CPU, RAM, dysk, temperatura, komponenty.
- Aktualizacja, która po sukcesie usuwa nieaktualne pliki instalacyjne (stare obrazy Dockera), zostawiając poprzednią wersję do rollbacku.
- Brak udawanych pomiarów w trybie produkcyjnym.

## Poza zakresem (na teraz)

- Aplikacja mobilna. UI jest responsywne, ale aplikacji mobilnej nie planujemy.
- Sterowanie falownikiem/baterią.
- Hosting jako usługa w chmurze (SaaS).

## Stan projektu

**Faza: P0 — fundament repozytorium.** Istnieje szkielet monorepo z narzędziami jakości i CI; nie ma jeszcze funkcji aplikacji ani zweryfikowanej integracji z urządzeniami.

## Dokumenty

- [`ROADMAP.md`](ROADMAP.md) — etapy, kryteria ukończenia i priorytety.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — decyzje zatwierdzone i otwarte.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architektura.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — encje, pomiary i reguły obliczeń.
- [`docs/SECURITY.md`](docs/SECURITY.md) — bezpieczeństwo.
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — licencje, CRA, RODO, nazwa handlowa.
- [`docs/TESTING.md`](docs/TESTING.md) — strategia testów, w tym symulatory.
- [`docs/IMPLEMENTATION_GUIDE.md`](docs/IMPLEMENTATION_GUIDE.md) — instrukcja krok po kroku i praca z Claude Code.
- [`docs/REFERENCES.md`](docs/REFERENCES.md) — dokumentacja techniczna i źródła.
- [`graf/`](graf/) — makiety ekranów: dashboard, historia, urządzenia, instalacja.
- [`CLAUDE.md`](CLAUDE.md) — reguły dla Claude Code.
- [`.claude/skills/`](.claude/skills/) — lokalne umiejętności Claude Code.

## Stos technologiczny

Zatwierdzony kierunek. Konkretne wersje zostaną przypięte w lockfile w etapie P1.

| Warstwa | Technologia | Licencja |
|---|---|---|
| Backend API | Python, FastAPI, Pydantic | MIT |
| Agent (kolektor) | Python asyncio, pymodbus, pysolarmanv5, httpx | BSD-3 / MIT / BSD-3 |
| Baza danych | PostgreSQL (natywne partycjonowanie + własne agregaty) | PostgreSQL |
| ORM i migracje | SQLAlchemy 2, Alembic | MIT |
| Dane na żywo | Server-Sent Events (SSE) | — |
| Frontend | React + TypeScript + Vite (SPA jako pliki statyczne) | MIT |
| Wykresy | Apache ECharts | Apache-2.0 |
| Reverse proxy / TLS | Caddy | Apache-2.0 |
| Wdrożenie | Docker Compose, obrazy amd64 + arm64 | — |
| Jakość | ruff, mypy, pytest; oxlint, Vitest, Playwright | MIT / Apache-2.0 |

Licencje należy potwierdzić ponownie w momencie dodawania zależności. Node.js jest potrzebny tylko do budowania frontendu, nie na serwerze klienta.

## Wymagania sprzętowe (wstępne)

- Raspberry Pi 4/5 z min. 4 GB RAM i **dyskiem SSD** — karta SD szybko się zużywa przy ciągłym zapisie. RPi 3 i systemy 32-bitowe nie są wspierane.
- Mini-PC albo VM/LXC w Proxmox z Dockerem.
- Urządzenia RS485: bramka RS485↔Ethernet albo adapter USB (w Proxmox wymaga passthrough USB).
- Limity liczby instalacji na danym sprzęcie zostaną ustalone pomiarami.

## Zasady danych

- Wartości z makiet są wyłącznie przykładami UI i zawierają niespójności (patrz `docs/DATA_MODEL.md`).
- Dane demonstracyjne mają oznaczenie `DEMO`, symulowane — `SIMULATED`.
- Brak pomiaru nie oznacza zera.
- Każdy odczyt ma timestamp, źródło, jednostkę i informację o jakości.
- W produkcji nie wolno podstawiać wartości przykładowych, gdy urządzenie nie odpowiada.
- Każdy profil urządzenia ma status weryfikacji; `VERIFIED` wymaga testu na rzeczywistym modelu i firmware.

## Praca deweloperska

Wymagania: Git, [uv](https://docs.astral.sh/uv/) 0.13.x (instaluje Pythona 3.12 z `.python-version`), Node.js 26 (`.nvmrc`) z npm.

Struktura: `server/` (API, pakiet `solargraf_server`), `agent/` (kolektor, `solargraf_agent`), `web/` (React + Vite), `profiles/` (profile urządzeń), `deploy/` (Compose, instalator), `tools/` (kontrola licencji), `docs/`.

```bash
uv sync --locked                       # środowisko Python (workspace server + agent + narzędzia dev)
npm --prefix web ci                    # zależności frontendu
uv run pre-commit install              # hooki przed commitem
```

Kontrole (te same co w CI, `.github/workflows/ci.yml`):

```bash
uv run ruff format --check . && uv run ruff check .
uv run mypy                            # mypy --strict
uv run pytest
npm --prefix web run lint              # oxlint
npm --prefix web run typecheck         # tsc -b
npm --prefix web test                  # Vitest
npm --prefix web run build
uv run python tools/check_licenses.py python   # licencje zależności produkcyjnych Pythona
uv run python tools/check_licenses.py npm      # licencje zależności produkcyjnych web/
uv run pre-commit run --all-files
```

Lista dozwolonych licencji: `tools/license-policy.json` (zgodna z `docs/COMPLIANCE.md`). Kontrola obejmuje zależności produkcyjne wraz z przechodnimi; narzędzia deweloperskie nie trafiają do produktu. SBOM (CycloneDX) generuje CI jako artefakt.

## Uruchomienie z Claude Code

1. Uruchom Claude Code w katalogu `SolarGraf/` — wtedy wczytany zostanie `CLAUDE.md` i skille.
2. Postępuj według [`docs/IMPLEMENTATION_GUIDE.md`](docs/IMPLEMENTATION_GUIDE.md), jeden etap na raz.
