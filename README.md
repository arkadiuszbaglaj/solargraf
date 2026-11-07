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
- [`LICENSE`](LICENSE) — licencja zastrzeżona: kod publiczny tylko do wglądu, wszelkie prawa zastrzeżone (D35).
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

Struktura: `server/` (API, pakiet `solargraf_server`), `agent/` (kolektor, `solargraf_agent`), `profiles-schema/` (format i walidator profili, `solargraf_profiles`; `uv run solargraf-profiles validate profiles/`), `agent/`: `uv run solargraf-agent poll <profil> --port 5020 --once` czyta urządzenie lub symulator i wypisuje wynik; `simulator/` (symulator urządzeń dla testów, dane SIMULATED; `uv run solargraf-sim profiles/simulated.hybrid-inverter.yaml --port 5020`), `web/` (React + Vite), `profiles/` (profile urządzeń), `deploy/` (Compose, instalator), `tools/` (kontrola licencji), `docs/`.

```bash
uv sync --locked                       # środowisko Python (workspace server + agent + narzędzia dev)
npm --prefix web ci                    # zależności frontendu
uv run pre-commit install              # hooki pre-commit i pre-push
```

Hooki wywołują `uv` i `npm`, więc oba muszą być w `PATH` (także w terminalu, z którego robisz `git push`).

**Ochrona `main` (lokalna).** Prywatne repozytorium na GitHubie bez planu Pro nie ma reguł ochrony gałęzi, dlatego hook pre-push blokuje bezpośredni push na `main` i przed każdym pushem uruchamia pytest, Vitest oraz (przy zmianie zależności) kontrolę licencji. Zmiany trafiają na `main` przez gałąź i PR:

```bash
git switch -c feat/nazwa-zmiany
git push -u origin feat/nazwa-zmiany   # potem PR na GitHubie, merge po zielonym CI
```

Świadome obejście blokady: `SOLARGRAF_ALLOW_PUSH_MAIN=1 git push`. Hook działa tylko tam, gdzie go zainstalowano, i można go pominąć przez `--no-verify` — CI na GitHubie sprawdza każdy push niezależnie.

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

### Frontend (dev)

```bash
npm --prefix web run dev                # http://localhost:5173 — wymaga logowania (API przez proxy Vite)
VITE_SKIP_AUTH=1 npm --prefix web run dev   # bez backendu: dashboard DEMO bez logowania (tylko dev)
```

Serwer deweloperski przekazuje `/api` do `http://127.0.0.1:8000` (backend z `deploy/compose.dev.yaml`). Ścieżki: `/login`, `/setup?token=…`, `/instalacje` (D37), pozostałe za logowaniem (D36). W Claude Code konfiguracja podglądu `web-dev-demo` uruchamia tryb bez backendu.

Do czasu API (P2/P5) jedynym źródłem danych jest `web/src/data/demo/DemoDataSource.ts`, oznaczone w UI badge'em `DEMO`. Instalacja demonstracyjna B symuluje utratę agenta (stan „nieaktualne” i `UNKNOWN`).

### Backend w Docker Compose (dev)

Wymaga Dockera z Compose (D23: Docker Engine w WSL2 lub na Linuksie).

```bash
cp deploy/.env.example deploy/.env     # potem ustaw SOLARGRAF_DB_PASSWORD
docker compose -f deploy/compose.dev.yaml up -d --build
curl http://127.0.0.1:8000/api/health/ready
docker compose -f deploy/compose.dev.yaml down
```

Pierwsze konto (D31) — jednorazowy token ważny 1 h, potem `POST /api/setup`:

```bash
docker compose -f deploy/compose.dev.yaml exec api solargraf-admin setup-token
```

Usługi: `db` (PostgreSQL 18, bez portu na hoście), `migrate` (jednorazowo `alembic upgrade head`), `api` (FastAPI na `127.0.0.1:8000`). W dev działa Swagger UI pod `/api/docs`. Testy integracyjne z bazą: `SOLARGRAF_TEST_DB=1` oraz zmienne `SOLARGRAF_DB_*` wskazujące na działającego PostgreSQL.

### Instalacja na serwerze (wersja dev, D34, D35)

Jedną komendą z GitHuba (Debian 12/13, Ubuntu 24.04/26.04, Raspberry Pi OS 64-bit; amd64/arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/solargraf/main/deploy/install.sh | sudo bash -s install
```

Najpierw sam plan i kontrola: `… | sudo bash -s install --dry-run`; inna gałąź lub tag: `--ref <nazwa>`.

Jeśli `sudo` nie daje skryptowi dostępu do terminala (np. sudo-rs w Ubuntu 26.04), pytania (instalacja Dockera) nie zadziałają w potoku — wtedy pobierz skrypt i uruchom z pliku albo dodaj `--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/solargraf/main/deploy/install.sh -o install.sh && sudo bash install.sh install
```

Bez dostępu serwera do GitHuba — paczka offline. Na komputerze deweloperskim (Git Bash/Linux) — paczka z zatwierdzonego `HEAD`:

```bash
./tools/make-bundle.sh                 # dist/solargraf-<wersja>.tar.gz + .sha256
```

Na serwerze (Debian 12/13, Ubuntu 24.04/26.04, Raspberry Pi OS 64-bit; amd64/arm64), po skopiowaniu paczki:

```bash
tar -xzf solargraf-<wersja>.tar.gz
sudo ./solargraf/deploy/install.sh install --dry-run   # tylko kontrola i plan
sudo ./solargraf/deploy/install.sh install
```

Instalator sprawdza system, RAM, dysk i porty 80/443, po potwierdzeniu instaluje Dockera z oficjalnego repozytorium, tworzy `/opt/solargraf` (sekrety w `.env`, 600), buduje obrazy, uruchamia `db`, `migrate`, `api` i `proxy` (Caddy, TLS z lokalnego CA) i wypisuje jednorazowy link `https://<adres>/setup?token=…` do pierwszego konta. Certyfikat CA do zaimportowania w przeglądarce: `/opt/solargraf/solargraf-ca.crt`. Dalej: `sudo solargraf status`, `sudo solargraf setup-link`, `sudo solargraf uninstall` (dane zostają) i `uninstall --purge` (usuwa dane). Log: `/opt/solargraf/install.log` (bez sekretów).

Lista dozwolonych licencji: `tools/license-policy.json` (zgodna z `docs/COMPLIANCE.md`). Kontrola obejmuje zależności produkcyjne wraz z przechodnimi; narzędzia deweloperskie nie trafiają do produktu. SBOM (CycloneDX) generuje CI jako artefakt.

## Uruchomienie z Claude Code

1. Uruchom Claude Code w katalogu `SolarGraf/` — wtedy wczytany zostanie `CLAUDE.md` i skille.
2. Postępuj według [`docs/IMPLEMENTATION_GUIDE.md`](docs/IMPLEMENTATION_GUIDE.md), jeden etap na raz.
