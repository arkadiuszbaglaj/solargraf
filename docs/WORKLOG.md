# Dziennik pracy

Utrzymuj ten plik krótki. Nie zapisuj tutaj pełnych rozmów ani długich podsumowań.

## Stan początkowy

- Status: dokumentacja bazowa przygotowana; aplikacja nie została jeszcze zaimplementowana.
- Referencja: makiety dashboardu (nazwa robocza SolarFlow) dostarczone przez właściciela projektu, w `graf/`.

## 2026-11-04

- Etap: P0 — decyzje.
- Zmiany: pakiet dokumentacji przeniesiony do katalogu projektu (`CLAUDE.md` i `.claude/skills/` w katalogu głównym, dokumenty w `docs/`); skille przemianowane na `solargraf-*`; dokumentacja przepisana pod stos Python + React; dodany `docs/COMPLIANCE.md`.
- Testy uruchomione i wyniki: brak (tylko dokumentacja).
- Decyzje zatwierdzone: D1–D13 w `docs/DECISIONS.md` — produkt komercyjny, Linux (Proxmox/mini-PC/RPi), LAN + VPN, bez aplikacji mobilnej, wiele instalacji, wszyscy producenci przez profile, Python/FastAPI, React/ECharts, SSE, PostgreSQL bez TimescaleDB, agent jako jedyny klient urządzeń, tylko odczyt.
- Ryzyka / rzeczy nieweryfikowane: nazwy SolarGraf i SolarFlow są zajęte w branży PV; `huawei-solar` ma licencję AGPL (zakaz użycia); makiety zawierają sprzeczne wartości i dwa różne zestawy sprzętu; brak dostępu do sprzętu — profile do czasu testów sprzętowych najwyżej `COMMUNITY`.
- Porządki: usunięty duplikat makiety i `CLAUDE_CODE_WORKFLOW.md` (treść przeniesiona do `IMPLEMENTATION_GUIDE.md`); makiety przemianowane na `graf/01-dashboard.png` … `04-instalacja.png`.
- Rozstrzygnięte później tego dnia: O1 → D14 (wszystkie instalacje w sieci serwera; agent zdalny poza MVP).
- Następne małe zadanie: rozstrzygnąć O2 (pierwszy sprzęt), następnie `git init` i fundament repozytorium (etap 2 w `docs/IMPLEMENTATION_GUIDE.md`).

## 2026-11-05

- Etap: P0 — decyzje.
- Zmiany: dodana funkcja sprawdzania aktualizacji (D15) w DECISIONS, ARCHITECTURE, DATA_MODEL, SECURITY, COMPLIANCE, TESTING, ROADMAP (P7) i README.
- Testy uruchomione i wyniki: brak (tylko dokumentacja).
- Dodane także: monitor serwera w Ustawieniach (D16), sprzątanie plików instalacyjnych po udanej aktualizacji (D17) i instalacja jedną komendą z narzędziem na hoście (D18, wersja 1 w P1).
- Ryzyka / rzeczy nieweryfikowane: O10 — adres publikacji manifestu i domyślne włączenie sprawdzania automatycznego; O11 — progi stabilności i retencja metryk; O12 — liczba wersji do rollbacku; licencja psutil do sprawdzenia przy dodaniu; O13 — źródło pobierania skryptu i obrazów; O14 — lista wspieranych systemów.
- Następne małe zadanie: O2 (pierwszy sprzęt), `git init`, fundament repozytorium.

## 2026-11-07

- Etap: P0 — fundament repozytorium.
- Zmiany: `git init` (gałąź `main`, commit dokumentacji); workspace uv (`server/`, `agent/`, Python 3.12); ruff, mypy --strict, pytest, pre-commit (hooki lokalne); `web/` — Vite 8 + React 19 + TypeScript 7 strict, oxlint, Vitest; `tools/check_licenses.py` + `tools/license-policy.json` (Python przez `uv export --no-dev`, npm przez `npm query .prod`); CI GitHub Actions z SBOM CycloneDX; katalogi `profiles/`, `deploy/`.
- Testy uruchomione i wyniki: ruff, mypy (10 plików), pytest 31/31, oxlint, tsc, Vitest 1/1, build, kontrola licencji (Python 0 zależności produkcyjnych, npm 3/3 MIT), pre-commit — wszystko zielone lokalnie na Windows. CI nieuruchomione (brak repozytorium zdalnego).
- Decyzje zatwierdzone: D19–D23 (Python 3.12, uv, GitHub Actions w prywatnym repo, npm + Node 26, Docker bez Docker Desktop). Odstępstwo: oxlint zamiast ESLint — typescript-eslint nie wspiera TypeScript 7.
- Ryzyka / rzeczy nieweryfikowane: nazwy pakietów `solargraf_*` zawierają nazwę roboczą; uv zainstalowany przez `pip --user` (poza PATH); Docker niezainstalowany (potrzebny w P1).
- Później tego dnia: prywatne repozytorium `arkadiuszbaglaj/solargraf` utworzone przez właściciela; pierwszy przebieg CI zielony; akcje GitHub podniesione do wersji na Node.js 24 i przypięte do SHA.
- Ochrona `main`: reguły GitHub wymagają planu Pro dla repozytoriów prywatnych — zamiast tego lokalny hook pre-push (`tools/hooks/no_push_to_main.py`: blokada pushu na `main`, pytest, Vitest, licencje). Od teraz zmiany przez gałąź i PR.
- Następne małe zadanie: P1 — Compose z FastAPI `/health`, PostgreSQL i Alembic.

## 2026-11-07 (P1, wycinek 1)

- Etap: P1 — backend w Compose.
- Zmiany: FastAPI (`create_app`, konfiguracja `SOLARGRAF_*` przez pydantic-settings, `/api/health`, `/api/health/ready` z timeoutem bazy), SQLAlchemy async + asyncpg, Alembic z pustą migracją `0001`, `server/Dockerfile` (użytkownik 10001, bez narzędzi budowania w obrazie), `deploy/compose.dev.yaml` (db/migrate/api, kontenery read-only, `cap_drop: ALL`, baza bez portu), CI: testy z PostgreSQL 18 i job Compose. Swagger tylko przy `SOLARGRAF_API_DOCS=true`.
- Testy uruchomione i wyniki: lokalnie (Windows, bez Dockera) ruff, mypy, pytest 50 OK + 2 integracyjne pominięte, licencje 22/22 OK. Compose i testy z bazą — w CI.
- Decyzje zatwierdzone: D24 (PostgreSQL 18, asyncpg), D25 (health bez uwierzytelnienia, tylko status), D26 (usługa `migrate`).
- Ryzyka / rzeczy nieweryfikowane: obrazy przypięte tagami, nie digestami (P7); stałe hasło `ci-only-password` dla efemerycznej bazy w CI; brak Dockera lokalnie (WSL niezainstalowany).
- Następne małe zadanie: P1 wycinek 2 — layout UI z danymi DEMO.

## 2026-11-07 (P1, wycinek 2)

- Etap: P1 — dashboard na danych DEMO.
- Zmiany: layout (sidebar z nieaktywnymi pozycjami „wkrótce”, topbar z przełącznikiem instalacji i czasem w strefie instalacji, link „Przejdź do treści”, menu na małych ekranach); tokeny CSS (jasny/ciemny); komponenty Panel, WidgetState, KpiCard, StatusBadge, DemoBadge, wykres ECharts (SVG, ładowany leniwie, luki jako null); widżety KPI, wykres dnia, status urządzeń, alarmy; kontrakt `DashboardDataSource` i `DemoDataSource` (model PV/zużycia/baterii, luka 13:00–13:45, licznik bez odpowiedzi, instalacja B z utraconym agentem); branding w `src/branding.ts`.
- Testy uruchomione i wyniki: Vitest 44/44 (jednostki i konwersje, strefa i zmiana czasu, świeżość i status urządzeń, źródło DEMO z bilansem mocy i D27, opcje wykresu, stany widżetu, klawiatura); oxlint, tsc, build; licencje npm 9/9. Ręcznie w przeglądarce: desktop i wąski ekran, instalacja A i B, brak błędów w konsoli.
- Decyzje zatwierdzone: D27 (definicje KPI z O3), D28 (biblioteki UI).
- Ryzyka / rzeczy nieweryfikowane: brak porównania pikselowego z makietą (układ wzorowany, nie kopiowany); paczka ECharts ~180 kB gzip (ładowana leniwie); nie sprawdzono czytnikiem ekranu; widok dzienny w demo zależy od pory dnia.
- Następne małe zadanie: P1 wycinek 3 — instalator v1 (wymaga Linuksa/WSL2 do testów).

## 2026-11-07 (P2, wycinek 1)

- Etap: P2 — konta i logowanie.
- Zmiany: modele i migracja `0002` (organizations, users, memberships, auth_sessions, setup_tokens, audit_events; konwencja nazw ograniczeń); Argon2id w wątku; polityka blokady i ważności sesji jako czyste funkcje; `POST /api/setup`, `POST /api/auth/login`, `POST /api/auth/logout` (CSRF), `GET /api/auth/me`; `solargraf-admin setup-token`; audyt logowań bez haseł/e-maili/IP.
- Testy uruchomione i wyniki: lokalnie ruff, mypy, pytest 70 OK (polityka, hasła, tokeny, DDL) + testy z bazą pominięte; licencje 26/26. Testy z PostgreSQL (setup, login, blokada, CSRF, wygasanie sesji, `alembic check`) — w CI.
- Decyzje zatwierdzone: D29 (role, zamyka O6), D30 (sesje i CSRF), D31 (pierwsze konto), D32 (hasła i limit prób).
- Ryzyka / rzeczy nieweryfikowane: czas Argon2id na RPi niezmierzony; blokada konta pozwala zablokować cudze konto znając e-mail (świadomy kompromis; ograniczony do 15 min); brak zmiany hasła i UI logowania; brak sprzątania wygasłych sesji (do workera).
- Następne małe zadanie: P2.2 — instalacje (`Site`), autoryzacja per instalacja i testy izolacji.

## 2026-11-07 (P2, wycinek 2)

- Etap: P2 — instalacje i autoryzacja per instalacja.
- Zmiany: modele i migracja `0003` (`sites`, `membership_sites`, `memberships.all_sites`); centralny moduł `authz` (widoczność instalacji z członkostwa, 404 dla cudzej/nieistniejącej, 403 dla braku prawa zarządzania, zawężony ADMIN nie tworzy instalacji); `GET /api/sites`, `GET /api/sites/{id}`, `POST /api/sites` (CSRF, audyt `SITE_CREATED`, walidacja strefy IANA); zależność `tzdata` (Apache-2.0).
- Testy uruchomione i wyniki: lokalnie ruff, mypy, pytest 87 OK (macierz ról, walidacja strefy i nazwy, DDL) + testy z bazą pominięte; licencje 27/27. Testy izolacji z PostgreSQL (dwie organizacje, zawężony VIEWER/ADMIN, OWNER bez zawężenia, CSRF, 401) — w CI.
- Decyzje zatwierdzone: D33 (zakres dostępu do instalacji).
- Ryzyka / rzeczy nieweryfikowane: brak edycji/usuwania instalacji i zarządzania przypisaniami (`membership_sites` tylko przez bazę); brak UI wyboru instalacji z API.
- Następne małe zadanie: P2.3 — agenci i urządzenia (modele) oraz `GET /api/sites/{id}/devices` przez `authz`.

## Szablon kolejnego wpisu

- Data:
- Etap:
- Zmiany:
- Testy uruchomione i wyniki:
- Decyzje zatwierdzone:
- Ryzyka / rzeczy nieweryfikowane:
- Następne małe zadanie:
