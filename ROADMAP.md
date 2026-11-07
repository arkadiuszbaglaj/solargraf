# Roadmap SolarGraf

Roadmapa jest oparta na etapach i kryteriach akceptacji, a nie na obietnicach kalendarzowych. Każdy etap kończy się działającym, testowalnym rezultatem. Decyzje: `docs/DECISIONS.md`.

## P0 — Decyzje i repozytorium

**Cel:** usunąć niejednoznaczności przed kosztowną implementacją.

- [x] Zatwierdzić model produktu, wdrożenie, stos i zakres (D1–D18).
- [x] Rozstrzygnąć topologię sieci (O1 → D14: wszystkie instalacje w sieci serwera).
- [ ] Rozstrzygnąć O2 (pierwszy sprzęt).
- [ ] Repozytorium Git (prywatne), reguły gałęzi i PR.
- [ ] Struktura monorepo: `server/`, `agent/`, `web/`, `profiles/`, `deploy/`, `docs/`.
- [ ] ruff, mypy, pytest; ESLint, tsc, Vitest; konfiguracja pre-commit.
- [ ] CI: lint, typecheck, testy, kontrola licencji zależności, SBOM.

**Akceptacja:** czyste repozytorium przechodzi CI; kontrola licencji blokuje niedozwoloną zależność; żadnych sekretów w Git.

## P1 — Szkielet aplikacji i design system

- [ ] FastAPI z endpointem health, PostgreSQL i Alembic w Docker Compose.
- [ ] **Instalator jedną komendą, wersja 1** (D18): sprawdzenie wymagań, instalacja Dockera, generowanie sekretów, uruchomienie Compose, health checks, adres i jednorazowy link do pierwszego konta; polecenia `install`, `status`, `uninstall`. Testowany na Debianie, Ubuntu i Raspberry Pi OS 64-bit.
- [ ] React + Vite: layout (sidebar, topbar, siatka), responsywność, przełącznik instalacji.
- [ ] Tokeny designu, komponenty KPI, status badge, panel, wykres ECharts, tabela, alarm.
- [ ] Stany loading, empty, error, stale/offline.
- [ ] Dane demo tylko w odseparowanym providerze i z widocznym oznaczeniem `DEMO`.
- [ ] Branding w jednym miejscu (nazwa robocza).
- [ ] Testy dostępności klawiaturą i podstawowe testy komponentów.

**Akceptacja:** na czystym Debianie/RPi OS aplikacja uruchamia się jedną komendą i jest dostępna w przeglądarce w LAN; dashboard odpowiada strukturze makiet na desktopie; układ działa na tablecie i telefonie; demo jest jednoznacznie oznaczone.

## P2 — Model domenowy, wiele instalacji i API

- [ ] Encje z `docs/DATA_MODEL.md`: Organization, User, Membership, Site, Agent, Connection, Device, DeviceProfile, MetricDefinition, Measurement, PollingRun, Alarm, AuditEvent.
- [ ] Partycjonowanie tabeli pomiarów po czasie.
- [ ] Uwierzytelnianie, sesje i role (O6); autoryzacja per instalacja.
- [ ] Testy izolacji danych między organizacjami.
- [ ] Endpointy odczytu dashboardu, urządzeń, pomiarów i alarmów; OpenAPI i typy dla frontendu.
- [ ] Paginacja historii, filtrowanie zakresem czasu i limitami.

**Akceptacja:** API zwraca schematowane dane; walidacja i autoryzacja są testowane; brak wartości zastępczych dla brakujących pomiarów.

## P3 — Agent, sterowniki, profile i symulatory

- [ ] Format profilu urządzenia i jego walidator (źródło dowodu, status, poziom wsparcia).
- [ ] Agent w trybie lokalnym: harmonogram, jedno połączenie na urządzenie, timeouty, retry z backoff, bufor offline.
- [ ] Protokół agent ↔ serwer: partie z identyfikatorem, heartbeat, poświadczenie agenta.
- [ ] Sterowniki: Modbus TCP, SunSpec, Solarman V5.
- [ ] Generator symulatora z profilu + profile czasowe PVGIS; wstrzykiwanie błędów.
- [ ] Pierwsze profile: ogólny SunSpec oraz pierwszy sprzęt z O2.
- [ ] Zapis `PollingRun`, metryki zdrowia agenta, alarm braku danych.

**Akceptacja:** agent czyta symulator i zapisuje pomiary z jakością; brak połączenia nie tworzy pomiaru zerowego; profile bez testu sprzętowego mają poziom co najwyżej `COMMUNITY`.

## P4 — Historia i obliczenia energetyczne

- [ ] Normalizacja jednostek oraz walidacja zakresów.
- [ ] Agregaty 5 min / godzina / dzień z liczbą próbek i pokryciem.
- [ ] Wykresy dzień/tydzień/miesiąc/rok.
- [ ] Zatwierdzone wzory KPI (O3) i bilansu energii.
- [ ] Obsługa luk, zmian czasu, strefy czasowej i resetów liczników.
- [ ] Retencja przez partycje (O8).

**Akceptacja:** obliczenia mają testy przypadków brzegowych (w tym niespójności z makiet); wykres odróżnia brak danych od wartości 0.

## P5 — Dashboard produkcyjny z danymi na żywo

- [ ] Strumień SSE per instalacja; UI pokazuje wiek każdej wartości.
- [ ] Karty KPI i trendy.
- [ ] Diagram przepływu energii na podstawie spójnego bilansu pomiarów.
- [ ] Szczegóły PV/MPPT, baterii/BMS i sieci/faz — tylko jeśli profil je udostępnia.
- [ ] Status urządzeń i agentów wyliczany z polityki świeżości.
- [ ] Alarmy z priorytetem, timestampem i potwierdzaniem.
- [ ] Eksport CSV.

**Akceptacja:** każdy widżet ma stany loading/error/no data/stale; UI nie sugeruje dostępności parametrów, których źródło nie dostarcza.

## P6 — Kolejni producenci

- [ ] Kolejne sterowniki (Modbus RTU, HTTP/JSON, MQTT) i mostki do bramek (np. OpenDTU, Victron).
- [ ] Profile kolejnych marek z dokumentacji producentów, każdy z symulatorem.
- [ ] Beta-instalacje na rzeczywistym sprzęcie w celu nadania statusu `VERIFIED`.
- [ ] Widoczny w UI poziom wsparcia profilu.

**Akceptacja:** dodanie marki obsługiwanej istniejącym sterownikiem nie wymaga zmian w kodzie — tylko profil i testy.

## P7 — Wdrożenie, licencja i zgodność

- [ ] Obrazy amd64 + arm64, produkcyjny Docker Compose, health checks.
- [ ] Instalator w wersji produkcyjnej (D18, O13, O14): podpis i suma kontrolna skryptu, obrazy z podpisanego manifestu, polecenia `update`, `backup`/`restore`, `logs`, tryb nieinteraktywny, paczka offline (do decyzji).
- [ ] Aktualizacja z backupem przed migracją i rollbackiem.
- [ ] Sprzątanie po udanej aktualizacji (D17, O12): stare obrazy aplikacji, osierocone warstwy, cache budowania, archiwa wydań; etykiety produktu na obrazach; `--dry-run`; raport odzyskanego miejsca.
- [ ] Monitor serwera w Ustawieniach (D16, O11): CPU, RAM, dysk, temperatura, stan komponentów, ocena stabilności, historia, alarmy systemowe.
- [ ] TLS w LAN (Caddy), instrukcja VPN.
- [ ] Weryfikacja pliku licencji offline i limity (O5).
- [ ] Sprawdzanie aktualizacji (D15, O10): ręcznie i automatycznie raz w tygodniu, podpisany manifest wersji, komunikat w UI o nowej wersji, ustawienie włącz/wyłącz; proces publikacji manifestu przy każdym wydaniu.
- [ ] Backup/restore z testem odtworzenia.
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
