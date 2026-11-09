# Roadmap SolarGraf

Roadmapa jest oparta na etapach i kryteriach akceptacji, a nie na obietnicach kalendarzowych. Każdy etap kończy się działającym, testowalnym rezultatem. Decyzje: `docs/DECISIONS.md`.

## P0 — Decyzje i repozytorium

**Cel:** usunąć niejednoznaczności przed kosztowną implementacją.

- [x] Zatwierdzić model produktu, wdrożenie, stos i zakres (D1–D18).
- [x] Rozstrzygnąć topologię sieci (O1 → D14: wszystkie instalacje w sieci serwera).
- [ ] Rozstrzygnąć O2 (pierwszy sprzęt).
- [x] Repozytorium Git (prywatne, GitHub), PR. Ochrona `main` lokalnym hookiem pre-push (reguły po stronie GitHuba wymagają planu Pro).
- [x] Struktura monorepo: `server/`, `agent/`, `web/`, `profiles/`, `deploy/`, `docs/`.
- [x] ruff, mypy, pytest; oxlint, tsc, Vitest; konfiguracja pre-commit.
- [x] CI: lint, typecheck, testy, kontrola licencji zależności, SBOM (konfiguracja gotowa; pierwsze uruchomienie po utworzeniu repozytorium zdalnego).

**Akceptacja:** czyste repozytorium przechodzi CI; kontrola licencji blokuje niedozwoloną zależność; żadnych sekretów w Git.

## P1 — Szkielet aplikacji i design system

- [x] FastAPI z endpointem health, PostgreSQL i Alembic w Docker Compose (weryfikacja w CI; lokalnie po instalacji Dockera).
- [x] **Instalator jedną komendą, wersja 1** (D18, wersja dev wg D34 — paczka zamiast `curl | bash`; testy na RPi i Debianie ręcznie): sprawdzenie wymagań, instalacja Dockera, generowanie sekretów, uruchomienie Compose, health checks, adres i jednorazowy link do pierwszego konta; polecenia `install`, `status`, `uninstall`. Testowany na Debianie, Ubuntu i Raspberry Pi OS 64-bit.
- [x] React + Vite: layout (sidebar, topbar, siatka), responsywność, przełącznik instalacji.
- [x] Tokeny designu, komponenty KPI, status badge, panel, wykres ECharts, alarm (tabela — gdy pojawi się widok, który jej potrzebuje).
- [x] Stany loading, empty, error, stale/offline.
- [x] Dane demo tylko w odseparowanym providerze i z widocznym oznaczeniem `DEMO`.
- [x] Branding w jednym miejscu (nazwa robocza).
- [x] Testy dostępności klawiaturą i podstawowe testy komponentów.

**Akceptacja:** na czystym Debianie/RPi OS aplikacja uruchamia się jedną komendą i jest dostępna w przeglądarce w LAN; dashboard odpowiada strukturze makiet na desktopie; układ działa na tablecie i telefonie; demo jest jednoznacznie oznaczone.

## P2 — Model domenowy, wiele instalacji i API

- [x] Encje z `docs/DATA_MODEL.md`: Organization, User, Membership, Site, Agent, Connection, Device, Measurement, PollingRun, Alarm, AuditEvent jako tabele; DeviceProfile i MetricDefinition jako pliki profili i katalog metryk w kodzie (D39).
- [x] Partycjonowanie tabeli pomiarów po czasie — miesięczne partycje na 24 miesiące + domyślna (D42); kolejne partycje i retencja — P4.4 (D49).
- [x] Uwierzytelnianie, sesje i role (O6 → D29–D32) — P2.1; autoryzacja per instalacja (D33) — P2.2.
- [x] Testy izolacji danych między organizacjami (instalacje; kolejne zasoby dopisują własne przypadki).
- [x] Endpointy odczytu dashboardu, urządzeń, pomiarów i alarmów; OpenAPI i typy dla frontendu. Urządzenia ze statusem wyliczanym (D38), historia pomiarów (D46), dane na żywo SSE i energia zamiast jednego `/dashboard` (D50, D51), alarmy (D55); OpenAPI z FastAPI, w UI typy z walidacją odpowiedzi w czasie działania (bez generatora).
- [x] Historia: filtrowanie zakresem czasu i limit punktów z automatycznym doborem rozdzielczości zamiast stronicowania (D46); eksport CSV z limitem wierszy (D57).

**Akceptacja:** API zwraca schematowane dane; walidacja i autoryzacja są testowane; brak wartości zastępczych dla brakujących pomiarów.

## P3 — Agent, sterowniki, profile i symulatory

- [x] Format profilu urządzenia i jego walidator (źródło dowodu, status, poziom wsparcia) — P3.1, D39.
- [x] Agent w trybie lokalnym: harmonogram, jedno połączenie na urządzenie, timeouty, retry z backoff, bufor offline — odczyt Modbus TCP (D41) w P3.3; pętla, bufor SQLite 7 dni, usługa `agent` w Compose i token z instalatora (D43) w P3.5.
- [x] Protokół agent ↔ serwer: partie z identyfikatorem, heartbeat, poświadczenie agenta — strona serwera (D42) w P3.4, strona agenta (D43) w P3.5.
- [x] Dodawanie połączeń i urządzeń (API, ekran `/instalacje/{id}/urzadzenia`, katalog profili `GET /api/profiles`) — P3.6, D44.
- [ ] Sterowniki: [x] Modbus TCP, [x] SunSpec (D59), [ ] Solarman V5.
- [ ] Generator symulatora z profilu + profile czasowe PVGIS; wstrzykiwanie błędów. Zrobione: symulator Modbus TCP z profilu, prosty model wartości i wstrzykiwanie błędów (D40) — P3.2; opcjonalna usługa na serwerze (`solargraf simulator on|off`, D45) — P3.7; PVGIS później.
- [ ] Pierwsze profile: ogólny SunSpec oraz pierwszy sprzęt z O2.
- [ ] Zapis `PollingRun`, metryki zdrowia agenta, alarm braku danych.

**Akceptacja:** agent czyta symulator i zapisuje pomiary z jakością; brak połączenia nie tworzy pomiaru zerowego; profile bez testu sprzętowego mają poziom co najwyżej `COMMUNITY`.

## P4 — Historia i obliczenia energetyczne

- [x] Normalizacja jednostek oraz walidacja zakresów (D39, D40, D75; zawężanie granic w profilu — po dokumentacji producenta).
- [x] Agregaty 5 min / godzina / dzień z liczbą próbek i pokryciem; usługa `worker`, API historii (P4.1, D46).
- [x] Wykresy dzień/tydzień/miesiąc/rok — historia urządzenia w UI (P4.2, D47).
- [x] Zakładka „Wykresy i historia” instalacji: moc PV, zużycia, sieci, baterii i SoC, zakres własny (D66).
- [ ] Zatwierdzone wzory KPI (O3) i bilansu energii — KPI D27 i energia za okres w API i UI (P4.3, D48); energia i KPI instalacji z jednego źródła na serię (D51); suma po urządzeniach — po decyzji o rolach.
- [x] Obsługa luk, zmian czasu, strefy czasowej i resetów liczników (D46, D48).
- [x] Retencja przez partycje i tworzenie kolejnych partycji (P4.4, D49).

**Akceptacja:** obliczenia mają testy przypadków brzegowych (w tym niespójności z makiet); wykres odróżnia brak danych od wartości 0.

## P5 — Dashboard produkcyjny z danymi na żywo

- [x] Strumień SSE per instalacja; UI pokazuje wiek każdej wartości (P5.1, D50).
- [x] Karty KPI i trendy — energia dziś, autokonsumpcja i wykres mocy od północy (P5.2, D51).
- [x] Diagram przepływu energii na podstawie spójnego bilansu pomiarów. (P5.4, D54)
- [x] Szczegóły PV/MPPT, baterii/BMS i sieci/faz — tylko jeśli profil je udostępnia (D56; bez komórek BMS — brak metryk w katalogu).
- [x] Status urządzeń i agentów wyliczany z polityki świeżości. (P5.3, D52)
- [x] Zakładka „Urządzenia”: kafle statusów, wyszukiwarka i filtry, panel szczegółów z bieżącymi wartościami, wykresem i połączeniem (D70).
- [x] Alarmy z priorytetem, timestampem i potwierdzaniem. (P5.5, D55; powiadomienia później)
- [x] Strona „Alarmy” z podsumowaniem i filtrami (D74; historia starsza niż 24 h — osobno).
- [x] Strona „Raporty”: bilans energii za miesiąc i rok, KPI, wykres, tabela, CSV i wydruk — OWNER/ADMIN (D74; koszty i taryfy — osobno).
- [x] Eksport CSV (D57: historia urządzenia; eksport energii i KPI — osobno).

**Akceptacja:** każdy widżet ma stany loading/error/no data/stale; UI nie sugeruje dostępności parametrów, których źródło nie dostarcza.

## P6 — Kolejni producenci

- [ ] Kolejne sterowniki (Modbus RTU, HTTP/JSON, MQTT) i mostki do bramek (np. OpenDTU, Victron).
- [ ] Profile kolejnych marek z dokumentacji producentów, każdy z symulatorem.
- [ ] Beta-instalacje na rzeczywistym sprzęcie w celu nadania statusu `VERIFIED`.
- [x] Widoczny w UI poziom wsparcia profilu (D58).
- [x] Ogólny SunSpec (D59): format profilu, definicje modeli i dekodowanie (P6.2a); wykrywanie i odczyt w agencie, symulator (P6.2b); profile falownika i licznika, test end-to-end (P6.2c). Poziom COMMUNITY — test sprzętowy w P6.5.

**Akceptacja:** dodanie marki obsługiwanej istniejącym sterownikiem nie wymaga zmian w kodzie — tylko profil i testy.

## P7 — Wdrożenie, licencja i zgodność

- [ ] Obrazy amd64 + arm64, produkcyjny Docker Compose, health checks.
- [ ] Instalator w wersji produkcyjnej (D18, O13, O14): podpis i suma kontrolna skryptu, obrazy z podpisanego manifestu, polecenia `update`, `backup`/`restore`, `logs`, tryb nieinteraktywny, paczka offline (do decyzji).
- [x] Aktualizacja z backupem przed migracją i rollbackiem (D65): kopia `pre-update` przed migracjami, przy błędzie powrót do poprzedniego kodu i obrazów, a gdy migracje zmieniły bazę — odtworzenie kopii; nieudana migracja i powrót sprawdzane w CI (zadanie „Instalator”).
- [x] Sprzątanie po udanej aktualizacji (D17, D65, D73): [x] stare obrazy aplikacji (zostaje jedna poprzednia wersja, D73); [x] cache budowania starszy niż 7 dni, a przy braku miejsca cały (D65, 0.5.2); [x] pobrane archiwa wydań (katalog tymczasowy); [x] etykiety produktu na obrazach `api`, `agent`, `proxy`; [x] `--dry-run` z planem sprzątania; [x] osierocone obrazy `<none>` z etykietą produktu; [x] raport odzyskanego miejsca (MB przed/po) w wyniku polecenia, `install.log` i w Ustawienia → Stan serwera.
- [x] Monitor serwera w Ustawieniach (D16, D60): [x] pomiar, stan składników, ocena stabilności i API (P7.1a); [x] strona „Stan serwera” (P7.1b); [x] historia i czas do zapełnienia dysku (P7.1c, D61); [x] alarmy systemowe (P7.1d, D68).
- [ ] TLS w LAN (Caddy), instrukcja VPN.
- [ ] Weryfikacja pliku licencji offline i limity (O5).
- [x] Sprawdzanie aktualizacji (D15, D63): wersja 0.1.0 z jednego miejsca, podpisany manifest, sprawdzanie ręczne i co tydzień, API, narzędzie wydania (P7.3a); klucz podpisu właściciela; komunikat i ustawienia w UI (P7.3b); pierwsze wydanie `v0.1.0` z manifestem.
- [x] Aktualizacja (D65): `solargraf update` z kopią, automatycznym powrotem i sprzątaniem (P7.4a); instalacja z aplikacji w Ustawienia → Aktualizacje (P7.4b); wydanie `v0.2.0` (P7.5).
- [x] Backup/restore z testem odtworzenia (P7.2, D62).
- [ ] Wymagania CRA: SBOM w wydaniu, polityka podatności, okres wsparcia (O9), dokumentacja techniczna.
- [ ] Materiały RODO dla klientów; nazwa handlowa (O4).
- [ ] Testy wydajności na RPi 4/5 i ustalenie limitów liczby instalacji.

**Akceptacja:** powtarzalna instalacja na czystym RPi, mini-PC i VM Proxmox; sprawdzony backup/restore; instrukcja operacyjna.

## Poza zakresem

- Sterowanie falownikiem/baterią lub zdalne zmienianie nastaw.
- Aplikacja mobilna.
- Optymalizacja taryf i prognozowanie produkcji.
- Dane pogodowe/nasłonecznienie (wymagają czujnika lub zewnętrznego API).
- Agent zdalny w innej lokalizacji (D14) — architektura go nie blokuje: ten sam obraz agenta, połączenie wychodzące przez VPN, rotacja poświadczeń, test dosyłki po długiej utracie łączności.
- Klaster agentów lub broker wiadomości, jeśli pojedynczy proces wystarcza.

Sterowanie urządzeniami to osobny projekt ryzyka. Nie dodawać go bez jawnych wymagań, ograniczeń bezpieczeństwa i testów producenta.
