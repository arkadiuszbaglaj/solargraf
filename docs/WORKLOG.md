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

- Etap: P3.7 — symulator na serwerze.
- Zmiany: obraz `solargraf-simulator` (non-root), usługa `simulator` w profilu Compose `symulator` bez portu na hoście; `solargraf simulator on|off` (stan w `.env`, zachowany przy aktualizacji), status pokazuje stan symulatora; `env_set` w instalatorze utrzymuje stały układ `.env`.
- Testy uruchomione i wyniki: lokalnie `bash -n`, walidacja YAML; pełna ścieżka (symulator → agent → API → baza → status OK, pomiary tylko SIMULATED, potem off) w CI instalatora.
- Decyzje zatwierdzone: D45.
- Ryzyka / rzeczy nieweryfikowane: lokalnie brak Dockera i ShellCheck — sprawdza CI.
- Następne małe zadanie: P4 — historia i obliczenia energetyczne (agregaty, retencja, kolejne partycje).

- Etap: P4.1 — agregaty i API historii.
- Zmiany: tabele `aggregates` i `aggregate_dirty` (migracja 0006); czysty moduł obliczeń (przedziały UTC, doba lokalna, pokrycie, łączenie godzin w dobę); ingest oznacza godziny do przeliczenia; usługa `worker` (`solargraf-worker`, Compose prod i dev, instalator); `GET /api/sites/{id}/devices/{did}/history` (limit 2000 punktów, `auto`/`raw`/`5m`/`1h`/`1d`, luki jako `null`, `origins`).
- Testy uruchomione i wyniki: lokalnie pytest server 118 passed (testy z bazą w CI), ruff, mypy --strict; testy z bazą (ingest → worker → agregaty, dane spóźnione, idempotencja, API: VIEWER, 404, 422, luki) i ścieżka symulator → worker → historia w CI instalatora.
- Decyzje zatwierdzone: D46. Doprecyzowanie: `auto` wybiera surowe odczyty tylko dla zakresu do 6 h, bo surowe punkty nie pokazują luk jako `null`.
- Ryzyka / rzeczy nieweryfikowane: strefy z przesunięciem niecałkowitym; brak przeliczenia danych sprzed 0006; worker przetwarza do 200 godzin na transakcję.
- Następne małe zadanie: P4.2 — wykres historii w UI (ECharts, luki jako `null`, oznaczenie SIMULATED).

- Etap: P4.2 — wykres historii w UI.
- Zmiany: `metrics` w `GET /api/sites/{id}/devices` dla każdej roli (z profilu, bez UNSUPPORTED); strona historii urządzenia (wybór pomiaru, okres dzień/tydzień/miesiąc/rok, poprzedni/dziś/następny, granice w strefie instalacji), ECharts ładowany osobno, luki jako przerwy w linii, podpowiedź z min/max/pokryciem, znak SIMULATED/DEMO z `origins`; link z listy urządzeń.
- Testy uruchomione i wyniki: Vitest 146/146, oxlint, tsc, build; pytest server 119 passed (z bazą w CI); ręcznie w przeglądarce z podstawionymi odpowiedziami API (dzień z luką, miesiąc, wąski ekran) — poprawione etykiety osi dla miesiąca i separator dziesiętny.
- Decyzje zatwierdzone: D47.
- Ryzyka / rzeczy nieweryfikowane: wykres z prawdziwym backendem tylko przez CI instalatora (API), nie w przeglądarce; liczniki pokazują stan, nie energię za okres (P4.3).
- Następne małe zadanie: P4.3 — energia za okres i KPI (D27) z obsługą resetów liczników.

- Etap: P4.3a — energia za okres i KPI (API).
- Zmiany: czysty moduł `energy.py` (przyrosty liczników z agregatów godzinowych z resetem i progiem 100 kW, zużycie z mocy 5 min, sumy w przedziały, KPI D27 ze statusami); `GET /api/sites/{id}/devices/{did}/energy` (godziny/doby/miesiące w strefie instalacji, `origins`, definicje wskaźników).
- Testy uruchomione i wyniki: lokalnie pytest server 133 passed (z bazą w CI), ruff, mypy --strict; przykład z makiety (94,4% / 81,5%), reset, luka, skok, mianownik 0, wynik poza zakresem, zmiana czasu.
- Decyzje zatwierdzone: D48.
- Ryzyka / rzeczy nieweryfikowane: profil symulatora nie ma liczników sieci i baterii (symulator je liczy) — KPI na symulatorze „niedostępne”; energia przez przerwę nie jest doliczana.
- Następne małe zadanie: P4.3b — panel „Energia i wskaźniki” na stronie historii.

- Etap: P4.3b — panel „Energia i wskaźniki” w UI.
- Zmiany: klient `GET …/energy` z walidacją; panel pod wykresem historii (ten sam okres): kafelki autokonsumpcji i samowystarczalności z definicją, okresem i ostrzeżeniem (niedostępny / niepełny / niespójny), tabela sum z pokryciem i uwagami (reset, wyliczone z mocy), słupki kWh (brak słupka = brak danych), znak SIMULATED; panel ukryty, gdy urządzenie nie ma źródeł energii. `KpiCard` dostał pole `notice` w kolorze ostrzeżenia; tokeny `--chart-export`, `--chart-battery`.
- Testy uruchomione i wyniki: Vitest 152/152, oxlint, tsc, build; ręcznie w przeglądarce z podstawionymi odpowiedziami API (wąski ekran) — poprawiony kolor ostrzeżeń w kafelkach.
- Decyzje zatwierdzone: D48 (pkt 1 — panel w UI).
- Ryzyka / rzeczy nieweryfikowane: panel z prawdziwym backendem nie sprawdzony w przeglądarce; na symulatorze wskaźniki niedostępne (brak liczników sieci w profilu).
- Następne małe zadanie: P4.4 — retencja (O8) i tworzenie kolejnych partycji; ewentualnie liczniki sieci i baterii w profilu symulatora.

- Etap: P4.4 — retencja i kolejne partycje.
- Zmiany: `maintenance.py` (partycje na 12 miesięcy do przodu z przeniesieniem wierszy z partycji domyślnej; usuwanie całych przeterminowanych partycji z blokadą przy oczekujących agregatach; `DELETE` porcjami dla partycji domyślnej, agregatów 5 min, `polling_runs`, `agent_batches`); worker uruchamia utrzymanie przy starcie i codziennie o 03:00 UTC; ustawienia retencji z minimami w konfiguracji i Compose.
- Testy uruchomione i wyniki: lokalnie pytest server 138 passed (z bazą w CI), ruff, mypy --strict; z bazą: tworzenie i przeniesienie, usunięcie partycji i starych wierszy, blokada przy `aggregate_dirty`.
- Decyzje zatwierdzone: D49 (O8).
- Ryzyka / rzeczy nieweryfikowane: pierwsze usunięcie partycji na prawdziwym serwerze nastąpi dopiero po ~3 miesiącach; test `test_measurements_land_in_monthly_partition` ma na sztywno listopad 2026.
- Następne małe zadanie: P5 — dashboard z danymi na żywo (SSE) albo liczniki sieci i baterii w profilu symulatora.

- Etap: P5.1 — dane na żywo (SSE) i karty bieżących wartości.
- Zmiany: `live.py` (magistrala w procesie, migawka, `GET /api/sites/{id}/live`), publikacja po zapisie partii w `agent_api.py`; w UI `api/live.ts`, `lib/liveValues.ts`, `hooks/useLiveSite.ts`, `widgets/LiveKpiRow.tsx`, `ApiDataSource` (instalacje z API), dashboard z API pokazuje karty na żywo, reszta „dostępne wkrótce”; znak baterii w UI i DEMO wg D39.
- Testy uruchomione i wyniki: lokalnie pytest server 143 passed (testy z bazą w CI), ruff, mypy --strict; web: tsc, oxlint, vitest 165 passed. Przeglądarka: Vite + atrapa API SSE w scratchpadzie — aktualizacje, wiek wartości, ostrzeżenie przy zerwaniu i samodzielny powrót po 502.
- Decyzje zatwierdzone: D50.
- Ryzyka / rzeczy nieweryfikowane: przejście SSE przez Caddy (`encode zstd gzip`) niesprawdzone na prawdziwym serwerze; widok z prawdziwym API i agentem niesprawdzony lokalnie (brak bazy).
- Następne małe zadanie: P5.2 — energia „dziś” i trendy w kartach.

- Etap: P5.2 — energia „dziś”, autokonsumpcja i wykres mocy dziś.
- Zmiany: `GET /api/sites/{id}/energy` (`compute_energy` wspólne z endpointem urządzenia, `device_id` w seriach, `unavailable`); bez ostrzeżenia `Result.tuples()`; UI: `usePeriodic` (odświeżanie co 5 min i po powrocie do karty), `lib/today.ts`, wiersze „Dziś” i karta Autokonsumpcja w `LiveKpiRow`, `TodayPowerChart` (historia 5 min z urządzeń-źródeł), wspólny `singleSource`.
- Testy uruchomione i wyniki: lokalnie pytest server 143 passed (testy z bazą w CI), ruff, mypy --strict; web: tsc, oxlint, vitest 174 passed. Przeglądarka: Vite + atrapa API — karty „Dziś”, autokonsumpcja niedostępna z powodem, wykres od północy z luką.
- Decyzje zatwierdzone: D51.
- Ryzyka / rzeczy nieweryfikowane: na serwerze z symulatorem pobór/oddanie, bateria i autokonsumpcja będą „niedostępne” (profil bez liczników) — zgodnie z D48/D51.
- Następne małe zadanie: P5.3 — status urządzeń i agentów na dashboardzie.

- Etap: P5.3 — status urządzeń i agentów na dashboardzie.
- Zmiany: `agent_status` w `device_status.py`, `GET /api/sites/{id}/agents` i `agent_id` w `DeviceOut` (`devices.py`); UI: `lib/deviceLabels.ts` (etykiety wspólne z listą urządzeń), `listSiteAgents` w `api/devices.ts`, `widgets/SiteDevicesPanel.tsx` zamiast „dostępne wkrótce” na dashboardzie.
- Testy uruchomione i wyniki: lokalnie pytest server 144 passed (testy z bazą w CI), ruff, mypy --strict; web: tsc, oxlint, vitest 178 passed. Przeglądarka: Vite + atrapa API — panel z podsumowaniem, agentem i statusem urządzenia.
- Decyzje zatwierdzone: D52.
- Ryzyka / rzeczy nieweryfikowane: widok z prawdziwym agentem niesprawdzony lokalnie (brak bazy); do sprawdzenia na serwerze.
- Następne małe zadanie: P5 — alarmy albo diagram przepływu energii (do wyboru).

- Etap: test P5.3 na serwerze i wykrywanie rozjechanego zegara (D53).
- Test na serwerze: po aktualizacji panel pokazywał „połączony” i „2 h temu” — zegar serwera spóźniał się o 2 h 13 min (chrony działał, ale korygował powoli); po `sudo chronyc makestep` panel poprawny (heartbeat i odczyt sprzed kilku sekund). Odczyty z ok. 2 h mają przesunięte znaczniki czasu (SIMULATED).
- Zmiany: `server_time` w `/api/health`; UI: `lib/clockSkew.ts`, `api/health.ts`, `layout/ClockSkewBanner.tsx` w powłoce aplikacji; instalator: `check_clock` w kontroli systemu i w `status`.
- Testy uruchomione i wyniki: pytest server (health z `server_time`), ruff, mypy --strict; web: tsc, oxlint, vitest 190 passed; `check_clock` na podstawionym `chronyc` (różnica, zgodność, brak synchronizacji) i na serwerze testowym (OK).
- Decyzje zatwierdzone: D53.
- Ryzyka / rzeczy nieweryfikowane: ShellCheck tylko w CI; baner w przeglądarce sprawdzony na atrapie API.
- Następne małe zadanie: P5 — alarmy albo diagram przepływu energii (do wyboru).

- Etap: P5.4 — diagram przepływu energii.
- Zmiany: `lib/energyFlow.ts` (kierunki, próg 50 W, bilans z tolerancją, warunki rysowania strzałek), `widgets/EnergyFlowPanel.tsx` (SVG, lista wartości dla czytników); dashboard otwiera jeden strumień (`useLiveSite`) i przekazuje go kartom i diagramowi; układ trzech kolumn.
- Testy uruchomione i wyniki: web: tsc, oxlint, vitest 212 passed (bilans, w tym niespójność z makiety; stany panelu). Przeglądarka: Vite + atrapa API (SIMULATED) — strzałki przy domkniętym bilansie, desktop i telefon.
- Decyzje zatwierdzone: D54.
- Ryzyka / rzeczy nieweryfikowane: na serwerze z symulatorem bilans domyka się z definicji (sieć = dom − PV − bateria); prawdziwy sprzęt może częściej pokazywać „bilans się nie domyka”.
- Następne małe zadanie: P5 — alarmy.

- Etap: P5.5 — alarmy instalacji.
- Zmiany: model `Alarm` i migracja 0007; `alarm_rules.py` (warunki ze statusów, histereza, wywołanie w `worker`); `alarms_api.py` (lista, potwierdzanie z audytem); retencja zamkniętych alarmów w `maintenance.py` i `SOLARGRAF_RETENTION_ALARMS_DAYS` w Compose; UI: `api/alarms.ts`, `widgets/SiteAlarmsPanel.tsx` zamiast „dostępne wkrótce”, wspólne `widgets/alarmSeverity.ts`.
- Testy uruchomione i wyniki: lokalnie pytest server 151 passed (testy z bazą — reguły w bazie, uprawnienia, CSRF, audyt, histereza, retencja, `alembic check` — w CI), ruff, mypy --strict; web: tsc, oxlint, vitest 217 passed. Przeglądarka: atrapa API (SIMULATED) — lista, czasy w strefie instalacji, potwierdzenie, telefon bez poziomego przewijania.
- Decyzje zatwierdzone: D55.
- Ryzyka / rzeczy nieweryfikowane: na serwerze testowym — wyłączenie symulatora powinno otworzyć „Dane nieaktualne” po progu świeżości (300 s) + do 60 s; zamknięcie ok. 2 min po powrocie danych.
- Następne małe zadanie: test alarmów na serwerze, potem szczegóły PV/baterii/sieci albo eksport CSV.

- Etap: test P5.4/P5.5 na serwerze testowym (VM VirtualBox).
- Wynik: po przestawieniu zegara chwilowy „Agent lokalny nie odpowiada” (otwarty i zamknięty po 2 min); wyłączenie symulatora → „Błąd odczytu: PV” w ciągu minuty, potwierdzenie przez OWNER, zamknięcie 2 min po powrocie odczytów; zamknięte alarmy zostają na liście. Log `worker` zgodny („Alarmy: otwarte 1 / zamknięte 1”).
- Zegar: VM traciła ok. 1,5 h (uśpienie hosta), a chrony z `makestep 1 3` przestawia skokowo tylko po starcie. Na serwerze testowym dodano `/etc/chrony/conf.d/solargraf-vm.conf` z `makestep 1 -1`. Baner D53 i `solargraf status` wykrywają taki stan.
- Ryzyka / rzeczy nieweryfikowane: czy instalator ma ustawiać `makestep` na maszynach wirtualnych — osobna decyzja (zmiana konfiguracji systemu).
- Następne małe zadanie: szczegóły PV/baterii/sieci albo eksport CSV.

- Etap: P5.6 — szczegóły PV, magazynu i sieci (D56).
- Zmiany: `lib/siteDetails.ts` (panele z metryk profilu, kanały stringów i faz), `siteValue`/`singleSource` z kanałem, `widgets/SiteDetailsPanels.tsx` pod przepływem i wykresem; nagłówek `Panel` zawija się na wąskim ekranie.
- Testy uruchomione i wyniki: oxlint, tsc, Vitest 230/230; podgląd na mocku SIMULATED (desktop 1440 px i telefon 375 px, bez poziomego przewijania).
- Serwer testowy: panele zgodne z profilem symulatora (PV z temperaturą i String 1, magazyn SoC i moc, sieć moc i częstotliwość), wartości zgodne z diagramem. Pusty pas nad panelami (wyższa kolumna urządzeń i alarmów) usunięty: szczegóły w lewej części siatki obok kolumny bocznej; na telefonie kolejność bez zmian.
- Następne małe zadanie: eksport CSV (ostatni punkt P5).

- Etap: P5.7 — eksport CSV historii urządzenia (D57).
- Zmiany: `server/.../export.py` (endpoint strumieniowany, limity, audyt `DATA_EXPORTED`, ochrona przed formułami), `web/src/api/export.ts`, `pages/DeviceCsvExport.tsx` na stronie historii.
- Testy uruchomione i wyniki: ruff, mypy --strict, pytest 157 (bez bazy; testy integracyjne eksportu w CI), oxlint, tsc, Vitest 235; podgląd na mocku: pobranie pliku, komunikat limitu, blokada surowych dla roku, wąski ekran.
- Ryzyka / rzeczy nieweryfikowane: duży eksport (500 000 wierszy) nie mierzony pod kątem czasu i pamięci na RPi; plik trzymany w pamięci przeglądarki przed zapisem.
- Serwer testowy: plik 5 min za dobę zgodny z D57 (BOM, CRLF, `;`, przecinek dziesiętny, 10 metryk × 288 przedziałów, puste pola tylko przy pokryciu 0, zmierzone zera z pokryciem > 0, SIMULATED). Wpis audytu nie sprawdzony (wymaga sudo).
- Decyzja właściciela: liczby w CSV z pełną precyzją, bez zaokrąglania.
- Następne małe zadanie: P6 albo eksport energii i KPI.

- Etap: P6 — plan (D58) i P6.1 poziom wsparcia profilu w UI.
- Zmiany: `support_level` w `DeviceOut`; `SupportLevelLabel` na liście urządzeń, w panelu „Urządzenia” i w formularzu dodawania.
- Testy uruchomione i wyniki: ruff, mypy --strict, pytest 157 (bez bazy; asercja w teście integracyjnym w CI), oxlint, tsc, Vitest 235; podgląd na mocku (lista urządzeń, dashboard).
- Ryzyka / rzeczy nieweryfikowane: O2 nadal otwarte — P6.3/P6.4 czekają na sprzęt i dokumentację producenta.
- Następne małe zadanie: P6.2 ogólny SunSpec — najpierw sprawdzenie licencji definicji modeli.

- Etap: P6.2a — format SunSpec (D59).
- Zmiany: dołączone definicje modeli SunSpec (Apache-2.0, v2026-04-20); `sunspec.py` (wczytywanie, przesunięcia, grupy powtarzane, wartości „nie zaimplementowano”, skale); `addressing` i `sunspec` w profilu z walidacją; `decode_sunspec`/`encode_sunspec` w kodeku; agent i symulator jawnie odmawiają profilu SunSpec do P6.2b.
- Testy uruchomione i wyniki: ruff, mypy --strict (111 plików), pytest 314 passed / 99 skipped (bez bazy); wheel zawiera pliki modeli.
- Ryzyka / rzeczy nieweryfikowane: brak urządzenia SunSpec — wszystko na danych testowych; znak mocy licznika 201/203 do potwierdzenia.
- Następne małe zadanie: P6.2b — wykrywanie modeli i odczyt SunSpec w agencie, symulator SunSpec.

- Etap: P6.2b — odczyt SunSpec w agencie i symulator (D59).
- Zmiany: `agent/sunspec_map.py` (wykrywanie mapy, bloki modeli, adresy punktów i skal); `ModbusPoller` czyta profile SunSpec z zapamiętaną mapą i ponownym wykryciem po zmianie; `simulator/sunspec_map.py` (mapa z profili, kilka profili naraz, `--sunspec-base` w CLI).
- Testy uruchomione i wyniki: ruff, mypy --strict (115 plików), pytest profili/agenta/symulatora 173 passed — w tym agent na symulatorze: falownik i licznik z jednej mapy, adres bazowy 50000, brak modelu/modułu/punktu, „nie zaimplementowano”, urządzenie bez SunSpec, timeout przy wykrywaniu, zmiana mapy, małe bloki.
- Ryzyka / rzeczy nieweryfikowane: brak urządzenia SunSpec; licznik energii 0 jest w SunSpec brakiem wartości; tylko pierwsza instancja modelu.
- Następne małe zadanie: P6.2c — profile falownika i licznika SunSpec, test end-to-end na symulatorze.

- Etap: P6.2c — profile SunSpec (D59 zakończone).
- Zmiany: `profiles/sunspec.pv-inverter-3ph.yaml`, `profiles/sunspec.grid-meter-3ph.yaml` (COMMUNITY, UNVERIFIED); agent rozpoznaje symulator po `Mn` w modelu 1 i oznacza dane SIMULATED; test end-to-end runnera (falownik + licznik na jednym połączeniu → partia do API); test katalogu profili na serwerze obejmuje nowe profile.
- Testy uruchomione i wyniki: ruff, mypy --strict (116 plików), pytest 369 passed / 99 skipped (bez bazy; testy z bazą w CI).
- Ryzyka / rzeczy nieweryfikowane: brak testu na urządzeniu SunSpec; znak mocy licznika; urządzenia z jednym MPPT dają brak danych dla kanału 2, a niezaimplementowane punkty (np. TmpCab) — cykle PARTIAL.
- Następne małe zadanie: O2 (sprzęt i dokumentacja producenta) — odblokowuje P6.3/P6.4; ewentualnie test profili SunSpec na serwerze z symulatorem.

- Etap: P7.1a — monitor serwera: pomiar, ocena i API (D60, O11 rozstrzygnięte).
- Zmiany: `system/host.py` (odczyt /proc, /sys, statvfs), `system/stability.py` (progi O11 z histerezą), `system/monitor.py` (cykl w workerze, składniki przez HTTP/TCP/heartbeat), migracja 0008 (`system_metric_samples`, `system_components`, `system_status`), retencja 30 dni, `GET /api/system/health` tylko dla OWNER; adresy składników w Compose.
- Testy uruchomione i wyniki: ruff, mypy --strict (124 pliki), pytest serwera 169 passed / 102 skipped (testy z bazą — w CI).
- Ryzyka / rzeczy nieweryfikowane: progi i odczyt niedoboru napięcia nie sprawdzone na RPi; pomiar narzutu na RPi niezmierzony; w LXC pamięć może dotyczyć kontenera.
- Następne małe zadanie: P7.1b — strona „Stan serwera” w Ustawieniach.

- Etap: P7.1b — strona „Stan serwera” (D60).
- Zmiany: `web/src/api/system.ts` (walidacja `GET /api/system/health`, 401/403 osobno), `pages/ServerHealthPage.tsx` (ocena, przyczyny, procesor, pamięć, dysk, temperatura/zasilanie, system, składniki; odświeżanie co 60 s; brak pomiaru = „niedostępne”), trasa `/ustawienia/serwer`, link „Ustawienia” w menu tylko dla roli OWNER, `formatBytes` (jednostki binarne), `formatUptime`, `formatNumber`.
- Testy uruchomione i wyniki: oxlint, tsc, vitest 251 passed; podgląd na atrapie API (SIMULATED) — szeroki i wąski ekran.
- Ryzyka / rzeczy nieweryfikowane: strona nie sprawdzona na prawdziwym serwerze; czasy w strefie przeglądarki (dane serwera, nie instalacji).
- Następne małe zadanie: P7.1c — historia 24 h/7 dni/30 dni i czas do zapełnienia dysku.

- Data: 2026-11-08
- Etap: P7.1c — historia monitora serwera i prognoza zapełnienia dysku (D61).
- Zmiany: `system/trends.py` (siatka przedziałów, regresja liniowa, statusy prognozy), `GET /api/system/metrics` (agregacja `date_bin` w SQL, tylko OWNER), `web/src/api/system.ts` (walidacja), `pages/ServerHistory.tsx` (przełącznik 24 h/7 dni/30 dni, 4 wykresy wspólnym `HistoryChartView`, prognoza jako szacunek); podpowiedź wykresu pokazuje samo maksimum, gdy brak minimum.
- Testy uruchomione i wyniki: ruff, mypy --strict, pytest serwera 173 passed / 104 skipped (testy z bazą — w CI); oxlint, tsc, vitest 258 passed; podgląd na atrapie API (SIMULATED) — szeroki i wąski ekran.
- Decyzje zatwierdzone: D61.
- Ryzyka / rzeczy nieweryfikowane: zapytanie agregujące niezmierzone na RPi przy 30 dniach danych; nie sprawdzone na prawdziwym serwerze.
- Następne małe zadanie: P7.1d — alarmy systemowe dla OWNER.

- Data: 2026-11-08
- Etap: P7.2 — backup i restore z testem odtworzenia (D62); zapisane D63 (sprawdzanie aktualizacji, O10 rozstrzygnięte).
- Zmiany: `deploy/install.sh` — `backup` (pg_dump, `.env`, CA Caddy, manifest, SHA256SUMS, 600/700), `restore` (weryfikacja archiwum i rewizji migracji, kopia pre-restore, odtworzenie bazy od zera, migracje, CA i nowe certyfikaty), timer systemd o 3:00 z retencją 7 kopii automatycznych, `--no-auto-backup`/`--auto-backup`, `status` pokazuje ostatnią kopię; `uninstall --purge` zostawia `backups/`. CI: test timera i retencji oraz pełny cykl backup → purge → instalacja → restore.
- Testy uruchomione i wyniki: `bash -n`, poprawność YAML lokalnie; ShellCheck i test instalatora tylko w CI (brak Dockera lokalnie).
- Decyzje zatwierdzone: D62, D63.
- Ryzyka / rzeczy nieweryfikowane: restore nie sprawdzony na RPi i przy dużej bazie (czas pg_restore); kopia na tym samym dysku.
- Następne małe zadanie: P7.3 — sprawdzanie aktualizacji (D63) albo P7.1d.

- Data: 2026-11-08
- Etap: P7.3a — sprawdzanie aktualizacji, backend (D63).
- Zmiany: wersja 0.1.0 we wszystkich pakietach (`tools/release.py version`), `updates/manifest.py` (Ed25519, walidacja, porównanie wersji), `updates/service.py` (pobranie HTTPS przez bibliotekę standardową, zapis wyniku, harmonogram tygodniowy), migracja 0009 (`update_status`), API `/api/system/updates` (OWNER, CSRF, limit 1/min, ukrywanie wersji), zadanie w workerze, `--no-update-check` w instalatorze, `tools/release.py` (keygen, manifest). Zależność `cryptography` 50.0.2 — licencja Apache-2.0 OR BSD-3-Clause (sprawdzona w metadanych PyPI, kontrola licencji OK).
- Testy uruchomione i wyniki: ruff, mypy --strict, pytest 398 passed / 109 skipped (testy z bazą — w CI).
- Ryzyka / rzeczy nieweryfikowane: brak klucza właściciela — do jego wygenerowania sprawdzanie jest wyłączone (NOT_CONFIGURED); pobieranie z GitHuba (przekierowania) nie sprawdzone na żywo.
- Następne małe zadanie: klucz podpisu właściciela, P7.3b — UI.

- Data: 2026-11-08
- Etap: P7.3 — klucz podpisu i UI aktualizacji (P7.3b, D63)
- Zmiany: klucz podpisu wygenerowany przez właściciela (`tools/release.py keygen`, plik poza repozytorium), klucz publiczny w `updates/release_key.py` — sprawdzanie aktywne. Web: klient `api/updates.ts` z walidacją; panel „Aktualizacje” w Stanie serwera (wersja, daty i wynik sprawdzenia, dostępna wersja z opisem i odnośnikiem, przełącznik automatycznego sprawdzania, przycisk „Sprawdź aktualizacje”); baner dla OWNER (zwykła wersja — ukrycie na serwerze, wersja z poprawkami bezpieczeństwa — odłożenie do wylogowania/zamknięcia karty).
- Testy uruchomione i wyniki: web — lint, tsc, vitest 276 passed; podgląd z atrapą API (SIMULATED) na komputerze i telefonie.
- Decyzje zatwierdzone: brak nowych.
- Ryzyka / rzeczy nieweryfikowane: do pierwszego wydania (tag `v0.1.0` + manifest) sprawdzenie kończy się błędem NETWORK — bez alarmu; pobieranie z GitHuba nie sprawdzone na żywo.
- Następne małe zadanie: pierwsze wydanie `v0.1.0` z podpisanym manifestem (za zgodą właściciela).

- Data: 2026-11-08
- Etap: P7.3 — pierwsze wydanie `v0.1.0` (D63)
- Zmiany: wydanie `v0.1.0` na GitHubie (tag na `42522a2`) z `manifest.json` i `manifest.json.sig` podpisanymi kluczem właściciela (`tools/release.py manifest`, notatka „Pierwsze wydanie.”).
- Testy uruchomione i wyniki: pobranie z domyślnego adresu (`releases/latest/download`, z przekierowaniem) kodem aplikacji i weryfikacja wbudowanym kluczem — OK; dla 0.1.0 brak nowszej wersji; zmieniony manifest odrzucony (INVALID_SIGNATURE).
- Decyzje zatwierdzone: publikacja `v0.1.0` — zgoda właściciela 2026-11-08.
- Ryzyka / rzeczy nieweryfikowane: każde kolejne wydanie wymaga podniesienia wersji (`tools/release.py version`), nowego manifestu i oznaczenia jako „latest”; nie sprawdzone na serwerze testowym ani RPi.
- Następne małe zadanie: P7.1d (alarmy systemowe) albo polecenie `update` instalatora.

- Data: 2026-11-08
- Etap: UI — animacja przepływu energii (D64)
- Zmiany: `flowMotion` (prędkość i grubość z mocy, próg IDLE_W) w `energyFlow.ts`; w `EnergyFlowPanel` kropki płyną po liniach ze strzałką (tylko potwierdzony kierunek), linia pod nimi przygaszona; `prefers-reduced-motion` — same strzałki. D54 uzupełniona odnośnikiem do D64.
- Testy uruchomione i wyniki: web — lint, tsc, vitest 286 passed; podgląd tymczasowej strony z danymi SIMULATED (spójny bilans, moc 30 W, dane nieaktualne) na komputerze i telefonie; reguła reduced-motion sprawdzona przez wstrzyknięcie stylu.
- Decyzje zatwierdzone: D64 (zlecenie właściciela).
- Ryzyka / rzeczy nieweryfikowane: nie oglądane na dashboardzie z prawdziwym backendem (tryb DEMO nie pokazuje diagramu); zmiana mocy co sekundę może lekko przeskoczyć fazę animacji (wartości zaokrąglone).
- Następne małe zadanie: P7.1d (alarmy systemowe) albo polecenie `update` instalatora.

- Data: 2026-11-08
- Etap: P7.4a — polecenie `update` instalatora (D65)
- Zmiany: `solargraf-admin update-target` (manifest pobrany od nowa i sprawdzony podpisem; kody 10/11/12) i `upgrade_target` w `updates/manifest.py`; `install.sh update` — wersja z manifestu albo `--ref`/paczka, kopia `pre-update`, `src.previous` i obrazy `:previous`, budowa/migracje/gotowość, powrót w pułapce EXIT (z restore przy zmianie rewizji), sprzątanie D17, blokada `flock`; `SOLARGRAF_HEALTH_TIMEOUT_S` tylko do testów. D15 zmieniona przez D65; README.
- Testy uruchomione i wyniki: server — ruff, mypy --strict, pytest `test_updates_units.py` 12 passed; `bash -n`. ShellCheck i scenariusze aktualizacji (manifest, --dry-run, sukces, obniżenie, nieudana migracja + start → powrót) — w CI.
- Decyzje zatwierdzone: D65 (przycisk w UI, kopia + automatyczny powrót, tag z manifestu, sprzątanie od razu) — właściciel 2026-11-08.
- Ryzyka / rzeczy nieweryfikowane: aktualizacja między różnymi wersjami (np. 0.1.0 → 0.2.0) sprawdzona dopiero przy następnym wydaniu; nie testowane na RPi.
- Następne małe zadanie: P7.4b — plik-flaga, usługa systemd, API i zakładka Ustawienia → Aktualizacje.

## Szablon kolejnego wpisu

- Data:
- Etap:
- Zmiany:
- Testy uruchomione i wyniki:
- Decyzje zatwierdzone:
- Ryzyka / rzeczy nieweryfikowane:
- Następne małe zadanie:

