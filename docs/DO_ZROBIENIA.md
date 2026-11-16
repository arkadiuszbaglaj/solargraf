# Do zrobienia

Lista zadań z analizy wersji 0.17.0 (2026-11-16). Kolejność jest rekomendowana: najpierw małe i odwracalne, potem zadania wymagające decyzji właściciela. Etapy i kryteria ukończenia: `ROADMAP.md`; decyzje: `docs/DECISIONS.md`. Po wykonaniu zadania zaznacz je tutaj i odnotuj w `docs/WORKLOG.md`.

## 1. Szybkie poprawki

- [ ] **README zgodne z kodem.** `README.md` nadal mówi „Faza P0, nie ma jeszcze funkcji aplikacji” i że jedynym źródłem danych jest `DemoDataSource`. Opisać faktyczny stan (P1–P5 w większości gotowe, P6–P7 w toku).
- [ ] **Wersja frontendu.** `web/package.json` ma `0.0.0` — dołączyć do `tools/release.py version` albo jawnie opisać, że wersję niesie tylko backend.
- [ ] **ECharts poza główną paczką.** `ReportsPage` importuje `EnergyBarsView` bez `lazy()`, przez co ECharts trafia do głównej paczki (976 KB, gzip 312 KB). Cel: główna paczka bez ECharts, wykresy ładowane leniwie.
- [ ] **Limit logów Dockera.** Usługi w `deploy/compose.yaml` nie mają limitu logów (`logging.options.max-size` / `max-file`). Ważne na Raspberry Pi z SSD.
- [ ] **Koszt healthchecków.** `containerd-shim` zużywa 4,5% rdzenia (więcej niż API) — sprawdzić interwały healthchecków (np. `5s` przy `db`).

## 2. Wydajność (po pomiarze bazowym 0.17.0)

- [ ] **Migawka widoku na żywo.** `load_snapshot` w `server/src/solargraf_server/live.py` szuka ostatniego odczytu w 24 h surowych pomiarów: 108 ms i 102 tys. buforów przy jednym urządzeniu; rośnie z liczbą urządzeń. Rozważyć tabelę ostatnich wartości aktualizowaną przy ingeście albo indeks dopasowany do zapytania. Zmiana schematu — przedstawić plan przed implementacją.
- [ ] **Zapis na dysk ~4 GB/dobę.** Ustalić źródło (WAL, logi, pomiary, healthchecki) i ograniczyć.
- [ ] **Build cache Dockera 7,9 GB** na serwerze testowym — sprawdzić, czy sprzątanie po aktualizacji (D65) działa zgodnie z założeniem.
- [ ] **Pomiar porównawczy.** Po optymalizacjach uruchomić `tools/perf/measure.sh` i zapisać wyniki obok bazowych w `tools/perf/wyniki/`.

## 3. Pierwszy prawdziwy sprzęt (blokuje status VERIFIED)

- [ ] **Decyzja O2** — pierwszy sprzęt docelowy (propozycja: Deye SUN-12K-SG05LP3 + BOS-G16 przez logger Solarman V5, licznik Eastron SDM630).
- [ ] **Sterownik Solarman V5** w agencie (licencja `pysolarmanv5` do potwierdzenia przy dodaniu).
- [ ] **Profile z dokumentacji producenta** (ze źródłem dowodu) i symulator dla każdego profilu.
- [ ] **Test na prawdziwym urządzeniu** i nadanie statusu `VERIFIED`; sprawdzenie progów alarmu „Niepełne odczyty” i obciążenia loggera przy podglądzie co 1,5 s (D78).

## 4. Licencja i dystrybucja (P7)

- [ ] **Zatwierdzić 5 decyzji z `docs/LICENSING.md`** (O5), potem etap 1 licencjonowania.
- [ ] **Decyzja O13** — skąd instalator pobiera skrypt i obrazy (domena, rejestr, czy dostęp wymaga licencji).
- [ ] **Gotowe obrazy amd64/arm64** przypięte po digest z podpisanego manifestu zamiast budowania z kodu źródłowego na serwerze klienta.
- [ ] **TLS w LAN i instrukcja VPN** (otwarta pozycja P7).

## 5. Zgodność i sprzedaż

- [ ] **Nazwa handlowa (O4)** — sprawdzenie w EUIPO/UPRP przed materiałami sprzedażowymi.
- [ ] **Okres wsparcia (O9)** i pozostałe wymagania CRA: SBOM w wydaniu, polityka podatności, dokumentacja techniczna.
- [ ] **Materiały RODO** dla klientów.
- [ ] **Limity sprzętowe** — testy wydajności na RPi 4/5 i ustalenie liczby instalacji/urządzeń na serwer (O7).

## 6. Architektura — do obserwacji

- [ ] **Magistrala SSE w jednym procesie API** (D50). Działa przy jednym procesie; przy skalowaniu API na kilka procesów potrzebna zmiana (np. `LISTEN/NOTIFY` w PostgreSQL). Decyzja dopiero, gdy pomiary pokażą potrzebę.
- [ ] **Weryfikacja na serwerze testowym** funkcji oznaczonych w `WORKLOG.md` jako „niezweryfikowane” (m.in. raport na prawdziwych danych, Ustawienia → Falownik z prawdziwym agentem, wykres magazynu na dashboardzie).

## Propozycje właściciela (z `Propozycje.txt`)

Wymagają decyzji przed implementacją:

- [ ] **Interwał zapisu danych do wykresów ustawiany w aplikacji** (propozycje: 5/10/15 s albo 30/60/90/120 s). Wpływa na rozmiar bazy, obciążenie urządzenia i retencję — powiązane z O7.
- [ ] **Szacowany czas naładowania / rozładowania magazynu energii** — wymaga pojemności magazynu i definicji (z bieżącej mocy czy ze średniej).
- [ ] **Tryb kiosk** — zablokowany ekran pokazujący wybrany widok. Do ustalenia: uwierzytelnienie bez sesji użytkownika (osobna rola lub token tylko do odczytu jednej instalacji) i zakres danych.
- [x] Instalator jednym poleceniem (D18, D34).
- [x] Kreator dodawania falownika z testem komunikacji (D72). Automatyczne wykrywanie — tylko tam, gdzie definiuje je protokół (SunSpec, D59).
