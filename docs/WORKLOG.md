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

## 2026-11-07 (P1, wycinek 3)

- Etap: P1 — instalator v1 (wersja dev).
- Zmiany: `deploy/install.sh` (`install`, `status`, `setup-link`, `uninstall [--purge]`, `--dry-run`, `--yes`, `--dir`, `--address`; kontrola systemu, RAM, dysku, portów, LXC i karty SD; Docker z oficjalnego repozytorium po potwierdzeniu; sekrety w `.env` 600; log bez sekretów); `tools/make-bundle.sh` (paczka z `git archive`); produkcyjny `deploy/compose.yaml` z proxy Caddy (TLS `internal`, CSP i nagłówki, frontend + `/api`); strona `/setup` w web (token usuwany z adresu).
- Testy uruchomione i wyniki: lokalnie Vitest, oxlint, tsc, build; `bash -n` skryptów. ShellCheck, `--dry-run` w kontenerach i pełna instalacja — w CI.
- Decyzje zatwierdzone: D34 (instalator v1 w wersji dev).
- Ryzyka / rzeczy nieweryfikowane: nie testowano na arm64/RPi ani w LXC; ostrzeżenie przeglądarki o certyfikacie do czasu importu CA; brak UI logowania (po utworzeniu konta panel nadal na DEMO); obrazy budowane na serwerze (wolno na RPi), przypięte tagami, nie digestami (P7).
- Następne małe zadanie: UI logowania albo P2.3 (agenci i urządzenia).

## 2026-11-07 (P1, wycinek 4)

- Etap: P1 — instalacja z GitHuba (`curl | sudo bash`).
- Zmiany: instalator wykrywa uruchomienie przez potok i pobiera kod z `codeload.github.com` (`--ref`, tylko HTTPS; `SOLARGRAF_SOURCE_URL` do testów/lustra); potwierdzenia przez `/dev/tty`; skan historii Git przed upublicznieniem (brak sekretów i plików `.env`/kluczy; hasła tylko testowe).
- Testy uruchomione i wyniki: `bash -n`; w CI pełna instalacja przez potok z lokalnie serwowanego archiwum, `--dry-run` przez potok, odrzucenie źródła bez HTTPS.
- Decyzje zatwierdzone: D35 (repozytorium publiczne, instalacja z GitHuba).
- Ryzyka / rzeczy nieweryfikowane: prawdziwe pobranie z GitHuba możliwe dopiero po upublicznieniu repozytorium i merge do `main`; brak pliku licencji zastrzeżonej w repozytorium; brak sumy kontrolnej i podpisu skryptu (P7).
- Następne małe zadanie: test na serwerze użytkownika; potem UI logowania albo P2.3.

## 2026-11-07 (UI, wycinek: logowanie)

- Etap: P2 — logowanie w interfejsie.
- Zmiany: `/login` (komunikat wspólny dla złego hasła i blokady), bramka sesji dla całego UI (start, co 5 min, powrót do karty), wylogowanie w topbarze, przycisk „Zaloguj się” po `/setup`, walidacja odpowiedzi `/api/auth/*`, ochrona `next` przed przekierowaniem na inny host, proxy `/api` w Vite; poprawka proxy: certyfikat przy wejściu po IP (`default_sni`, PR #10) po zgłoszeniu z serwera.
- Testy uruchomione i wyniki: Vitest 97/97, oxlint, tsc, build; ręcznie w przeglądarce `/login` (także `reason=expired`) i bramka bez backendu (błąd z ponowieniem). Pełne logowanie przez proxy — w CI (job instalatora) i na serwerze użytkownika.
- Decyzje zatwierdzone: D36 (logowanie w UI).
- Ryzyka / rzeczy nieweryfikowane: logowania w przeglądarce z prawdziwym backendem nie sprawdzono lokalnie (brak Dockera); dashboard po zalogowaniu nadal na DEMO.
- Następne małe zadanie: ekran „Instalacje” (lista i dodawanie przez `/api/sites`) albo P2.3.

## 2026-11-07 (UI, wycinek: instalacje)

- Etap: P2 — ekran „Instalacje”.
- Zmiany: `/instalacje` z tabelą instalacji i formularzem dodawania (OWNER/ADMIN, CSRF, walidacja nazwy i strefy IANA), stany ładowania/pusty/błąd/wygasła sesja; menu boczne z linkami i `aria-current`; topbar z tytułem strony, bez przełącznika DEMO na tej stronie.
- Testy uruchomione i wyniki: Vitest 110/110, oxlint, tsc; ręcznie w przeglądarce (tryb bez backendu): układ strony, aktywne menu, stan błędu.
- Decyzje zatwierdzone: D37.
- Ryzyka / rzeczy nieweryfikowane: dodawanie przez przeglądarkę z prawdziwym backendem — do sprawdzenia na serwerze; lista stref zależy od przeglądarki (serwer i tak waliduje).
- Następne małe zadanie: P2.3 — agenci i urządzenia (modele) oraz `GET /api/sites/{id}/devices`.

- Etap: P2.3 — agenci, połączenia i urządzenia.
- Zmiany: tabele `agents`, `connections`, `devices` (migracja 0004; klucz złożony wymusza wspólną instalację urządzenia i połączenia); czysta funkcja statusu (DISABLED/UNKNOWN/ERROR/STALE/OK, heartbeat agenta 120 s); `GET /api/sites/{id}/devices` przez `authz` — szczegóły techniczne i połączenie tylko dla OWNER/ADMIN.
- Testy uruchomione i wyniki: lokalnie pytest 63 passed (testy z bazą tylko w CI), ruff, mypy --strict; testy izolacji urządzeń i klucza złożonego w CI.
- Decyzje zatwierdzone: D38.
- Ryzyka / rzeczy nieweryfikowane: brak endpointu tworzenia urządzeń (P3 z profilami), więc w UI lista będzie pusta do czasu agenta; próg heartbeatu do potwierdzenia przy protokole agenta.
- Następne małe zadanie: P3 — format profilu urządzenia i walidator albo widok urządzeń w UI.

- Etap: P3.1 — format profilu urządzenia i walidator.
- Zmiany: pakiet `solargraf-profiles` (`profiles-schema/`): katalog metryk kanonicznych z jednostkami i konwencją znaków, model profilu (Pydantic, ścisłe typy), wczytywanie YAML (`safe_load`, zduplikowane klucze odrzucane), CLI `solargraf-profiles validate`; serwer bierze `DeviceKind`/`Transport` z katalogu; profil testowy `simulated.hybrid-inverter` (SIMULATED, EXPERIMENTAL).
- Testy uruchomione i wyniki: lokalnie pytest 138 passed (testy z bazą w CI), ruff, mypy --strict, kontrola licencji (PyYAML MIT).
- Decyzje zatwierdzone: D39.
- Ryzyka / rzeczy nieweryfikowane: brak prawdziwego profilu sprzętowego — czeka na O2 i dokumentację Modbus producenta; reguły poziomu COMMUNITY doprecyzujemy przy symulatorze.
- Następne małe zadanie: symulator Modbus generowany z profilu albo pierwszy profil sprzętowy (po O2).

- Etap: P3.2 — symulator urządzeń z profilu.
- Zmiany: kodowanie/dekodowanie rejestrów w `solargraf-profiles` (`codec.py`); pakiet `solargraf-simulator`: model instalacji (PV, zużycie, bateria, liczniki), mapa rejestrów z profilu, własny serwer Modbus TCP (FC 03/04) z wstrzykiwaniem błędów, CLI `solargraf-sim`. pymodbus 3.16.2 (BSD-3-Clause) jako klient w testach (grupa dev).
- Testy uruchomione i wyniki: lokalnie pytest 176 passed (testy z bazą w CI), ruff, mypy --strict, licencje; ręcznie: `solargraf-sim` + odczyt pymodbus 13 rejestrów.
- Decyzje zatwierdzone: D40 (serwer własny zamiast serwera pymodbus — API serwera pymodbus zmienia się przed v4).
- Ryzyka / rzeczy nieweryfikowane: symulator potwierdza tylko nasze odczytanie profilu, nie zgodność ze sprzętem; brak PVGIS.
- Następne małe zadanie: agent w trybie lokalnym — odczyt urządzenia przez pymodbus, timeouty, retry, `PollingRun`, testy na symulatorze.

- Etap: P3.3 — agent: odczyt urządzenia.
- Zmiany: `solargraf_agent`: planowanie bloków (ciągłe rejestry, limit z profilu), `ModbusPoller` (pymodbus 3.16.2 jako zależność produkcyjna agenta, jedno połączenie, ponawianie TIMEOUT/CONNECTION_LOST z rosnącym odstępem, wyjątki Modbus bez ponawiania), odczyty z jakością GOOD/INVALID/MISSING, `PollingRun` OK/PARTIAL/FAILED, CLI `solargraf-agent poll`.
- Testy uruchomione i wyniki: lokalnie pytest 190 passed (testy z bazą w CI), ruff, mypy --strict, licencje (29 zależności, 0 niezgodnych); ręcznie `solargraf-sim` + `solargraf-agent poll --once` → wynik OK, 10 punktów.
- Decyzje zatwierdzone: D41.
- Ryzyka / rzeczy nieweryfikowane: pymodbus wykrywa zerwane połączenie dopiero po timeoucie; test tylko na symulatorze, nie na sprzęcie.
- Następne małe zadanie: P3.4 — protokół agent ↔ serwer (poświadczenie agenta, heartbeat, partie pomiarów, tabela pomiarów, bufor offline).

- Etap: P3.4 — agent ↔ serwer, strona serwera.
- Zmiany: migracja 0005 (token agenta jako skrót, `agent_batches`, `polling_runs`, `measurements` partycjonowane miesięcznie); `/api/agent/heartbeat`, `/api/agent/config` (ETag), `/api/agent/batches` (idempotentne, walidacja, tylko urządzenia agenta, aktualizacja `last_attempt_at`/`last_success_at`); `solargraf-admin agent create|disable|list`; proxy zwraca 404 dla `/api/agent/*`.
- Testy uruchomione i wyniki: lokalnie pytest 202 passed (testy z bazą w CI), ruff, mypy --strict; testy integracyjne agenta i sprawdzenie proxy w CI.
- Decyzje zatwierdzone: D42.
- Ryzyka / rzeczy nieweryfikowane: kody błędów cyklu są zdefiniowane osobno w agencie i serwerze (kontrakt pilnowany walidacją API); partycje kończą się w 2028-10 — przed tym P4 musi dodać tworzenie kolejnych.
- Następne małe zadanie: P3.5 — pętla agenta (konfiguracja, harmonogram, bufor SQLite, wysyłka, heartbeat) i usługa `agent` w Compose.

- Etap: P3.5 — pętla agenta i wdrożenie.
- Zmiany: `solargraf-agent run`: konfiguracja z serwera (ETag), jedno zadanie i jeden klient Modbus na połączenie, restart tylko zmienionych połączeń, bufor SQLite (7 dni, trwały `batch_id`), wysyłka od najstarszych, heartbeat; obraz `solargraf-agent` i usługa `agent` w Compose; instalator tworzy agenta `lokalny` i zapisuje token w `.env`; `solargraf-admin agent rotate`; httpx2 (BSD-3-Clause) w agencie.
- Testy uruchomione i wyniki: lokalnie pytest 225 passed (testy z bazą, w tym e2e symulator → agent → API → PostgreSQL, w CI), ruff, mypy --strict, licencje (33 zależności, 0 niezgodnych). Obraz agenta i heartbeat z kontenera sprawdza job instalatora w CI.
- Decyzje zatwierdzone: D43.
- Ryzyka / rzeczy nieweryfikowane: jedynym profilem jest profil symulatora — bez połączeń i urządzeń w bazie agent tylko wysyła heartbeat; agent w kontenerze sięga do LAN przez NAT sieci Dockera (do potwierdzenia na sprzęcie).
- Następne małe zadanie: P3.6 — dodawanie połączeń i urządzeń przez API i UI.

- Etap: P3.6 — dodawanie połączeń i urządzeń.
- Zmiany: katalog profili w obrazie API i `GET /api/profiles`; `POST /api/sites/{id}/connections` (z pierwszym urządzeniem), `POST …/connections/{cid}/devices`, `PATCH …/connections/{cid}`, `PATCH …/devices/{did}`, `DELETE …/devices/{did}` (tylko bez danych; puste połączenie znika), audyt; walidacja adresu (prywatny IPv4 lub nazwa hosta), przypisanie do jedynego agenta lokalnego, próg świeżości z interwału; UI `/instalacje/{id}/urzadzenia` (tabela, formularz, włącz/wyłącz, oznaczenie SIMULATED).
- Testy uruchomione i wyniki: lokalnie pytest (serwer 102 passed, testy z bazą w CI), ruff, mypy --strict; web vitest 128 passed, tsc, oxlint, build; ręcznie podgląd ekranu urządzeń z atrapą API.
- Decyzje zatwierdzone: D44.
- Ryzyka / rzeczy nieweryfikowane: nazwy hosta nie są sprawdzane po stronie serwera (rozwiązuje je agent); edycja połączenia i usuwanie są tylko w API, nie w UI.
- Następne małe zadanie: P3.7 — opcjonalna usługa symulatora w Compose (domyślnie wyłączona, SIMULATED), żeby przejść całą ścieżkę na serwerze bez sprzętu.

## Szablon kolejnego wpisu

- Data:
- Etap:
- Zmiany:
- Testy uruchomione i wyniki:
- Decyzje zatwierdzone:
- Ryzyka / rzeczy nieweryfikowane:
- Następne małe zadanie:
