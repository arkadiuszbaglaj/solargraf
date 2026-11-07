# Model danych i semantyka pomiarów

## Encje: organizacje i dostęp

### Organization
- `id`, `name`
- właściciel danych (np. instalator lub właściciel domu); granica izolacji danych

### User
- `id`, `email`, `display_name`, `password_hash` (algorytm wg `SECURITY.md`), `is_active`
- `last_login_at`

### Membership
- `user_id`, `organization_id`, `role` (do zatwierdzenia — `DECISIONS.md` O6: np. `OWNER`, `ADMIN`, `VIEWER`)
- opcjonalne zawężenie do wybranych instalacji (`site_ids`)

Każde zapytanie o dane instalacji sprawdza członkostwo i rolę po stronie serwera. `site_id` od klienta nie jest dowodem uprawnień.

## Encje: instalacje i urządzenia

### Site
- `id`, `organization_id`, `name`
- `timezone` — identyfikator IANA, np. `Europe/Warsaw`
- dane opisowe wpisywane ręcznie: moc szczytowa, liczba paneli, data uruchomienia, instalator, gwarancja, uwagi
- dane opcjonalne bez ujawniania dokładnego adresu, jeśli nie jest potrzebny

### Agent
- `id`, `name`, `mode` (`LOCAL` / `REMOTE`) — komponent serwera, nie organizacji (D38, D14)
- `version`, `last_heartbeat_at`, `enabled`
- poświadczenie przechowywane jako skrót, z datą wydania i odwołania (P3)

### Connection
Fizyczny punkt dostępu, z którym rozmawia agent (np. logger Wi-Fi, port Modbus TCP falownika, bramka RS485).
- `id`, `site_id`, `agent_id` (nullable — połączenie bez przypisanego agenta nie jest odczytywane)
- `name`, `transport` (`MODBUS_TCP`, `MODBUS_RTU`, `SOLARMAN_V5`, `HTTP`, `MQTT`)
- parametry połączenia: `host`, `port`, `unit_id` — walidowane; sekrety (np. numer seryjny loggera Solarman) oddzielnie (P3)
- `poll_interval_seconds`, `timeout_seconds` (domyślne z profilu)

### Device
- `id`, `site_id`, `connection_id`, `parent_device_id` (nullable)
- `name`, `kind` (`INVERTER`, `BATTERY`, `BMS`, `METER`, `MPPT`, `SENSOR`, …)
- `manufacturer`, `model`, `firmware_version`, `serial_number` — nullable, dopóki nieznane
- `profile_id`, `profile_version`
- `enabled`, `last_attempt_at`, `last_success_at`, `freshness_threshold_seconds`
- status wyliczany, a nie ręcznie ustawiany (D38): `DISABLED`, `UNKNOWN`, `ERROR`, `STALE`, `OK`; bez `OFFLINE`
- `site_id` urządzenia jest zawsze równy `site_id` jego połączenia (klucz złożony)

**Urządzenie fizyczne a podurządzenie logiczne.** MPPT, BMS czy licznik podłączony do falownika po RS485 zwykle nie mają własnego połączenia w LAN — ich dane przychodzą przez to samo połączenie co falownik. Modelujemy je jako `Device` z `parent_device_id` i tym samym `connection_id`. Makieta „Urządzenia” pokazuje każde z nich z osobnym adresem IP i firmware — to nie odpowiada typowej instalacji i nie jest wymaganiem.

### DeviceProfile
- `id` (np. `vendor.model-family`), `version`
- `transport`, `support_level` (`VERIFIED` / `COMMUNITY` / `EXPERIMENTAL`)
- lista punktów danych ze źródłem dowodu i statusem weryfikacji (`ARCHITECTURE.md`)
- zakres modeli i firmware, których dotyczy (tylko potwierdzone)

## Encje: pomiary i zdarzenia

### MetricDefinition
- `id`, `key`, `display_name`
- `canonical_unit`
- `quantity_kind` (power, energy, voltage, current, temperature, ratio, frequency, state)
- `source_device_kind`
- definicja/wersja obliczenia, jeśli jest metryką pochodną

### Measurement
- `site_id`, `device_id`, `metric_definition_id`
- `observed_at` — czas pomiaru, jeśli źródło go wiarygodnie podaje
- `received_at` — czas otrzymania przez agenta (UTC, z zegara synchronizowanego NTP)
- `value` — typ numeryczny o odpowiedniej precyzji; nullable tylko przy jawnej reprezentacji braku/awarii
- `unit`
- `quality` — `GOOD`, `ESTIMATED`, `STALE`, `INVALID`, `MISSING`
- `origin` — `DEVICE`, `DERIVED`, `SIMULATED`, `DEMO`
- `source_reference` — bez sekretów; np. identyfikator punktu danych w profilu
- `batch_id` — partia od agenta (idempotentność)

Tabela partycjonowana po czasie. Unikalność: (`device_id`, `metric_definition_id`, `observed_at` lub `received_at`) — do potwierdzenia w P2.

### PollingRun
- `id`, `device_id` lub `connection_id`, `agent_id`, `started_at`, `finished_at`
- `result`, `error_code`, `error_summary`
- liczba parametrów udanych/nieudanych

### Alarm
- `id`, `site_id`, `device_id` opcjonalne
- `code`, `severity`, `title`, `details`
- `opened_at`, `last_seen_at`, `closed_at`, `acknowledged_at`, `acknowledged_by`
- wersja reguły alarmu

### UpdateCheck
- `id`, `checked_at`, `trigger` (`MANUAL` / `SCHEDULED`), `triggered_by` (użytkownik, jeśli ręcznie)
- `result` (`UP_TO_DATE`, `UPDATE_AVAILABLE`, `FAILED`), `error_code`
- `current_version`, `latest_version`, `is_security_update`, `release_notes_url`

Ustawienia systemowe (np. `auto_update_check_enabled`) są globalne dla serwera, nie per instalacja. Ukrycie komunikatu o danej wersji zapisujemy per użytkownik.

### SystemMetricSample
- `sampled_at`, `metric` (np. `cpu_percent`, `load_1m`, `mem_used_bytes`, `mem_total_bytes`, `swap_used_bytes`, `disk_used_bytes`, `disk_total_bytes`, `db_size_bytes`, `cpu_temp_c`)
- `value` — nullable, gdy metryka jest niedostępna na danym sprzęcie
- jednostki kanoniczne (bajty, %, °C); tabela partycjonowana po czasie, retencja wg O11

### ComponentStatus
- `component` (`api`, `worker`, `agent`, `db`, `proxy`), `status`, `last_heartbeat_at`, `version`, `restart_count` (nullable)

### SystemAlarm
- jak `Alarm`, ale bez `site_id` — dotyczy serwera; widoczny tylko dla administratorów

### UpdateRun
- `id`, `started_at`, `finished_at`, `from_version`, `to_version`, `result` (`SUCCESS`, `FAILED`, `ROLLED_BACK`)
- `cleanup_freed_bytes`, `cleanup_items` (liczba usuniętych obrazów/plików) — zapisywane przez skrypt aktualizacji

### AuditEvent
- `id`, `organization_id`, `user_id`/`agent_id`, `action`, `target`, `at`
- bez nadmiarowych danych osobowych i bez sekretów

## Jednostki

Normalizuj do jednostek kanonicznych: moc W, energia Wh, napięcie V, prąd A, temperatura °C, częstotliwość Hz, stan naładowania jako ułamek lub % (jedno, zapisane w definicji). UI może prezentować kW/kWh, ale konwersja musi być jawna i testowana. Kierunek przepływu (import/eksport, ładowanie/rozładowanie) zapisujemy jawną konwencją znaku, opisaną w definicji metryki.

## Pomiary i agregacje

- Moc jest wielkością chwilową; energia jest wielkością zliczaną lub integrowaną w czasie.
- Nie sumuj próbek mocy jak energii.
- Licznik energii: uwzględnij reset, rollover i kierunek importu/eksportu.
- Autokonsumpcja i samowystarczalność muszą mieć zatwierdzoną definicję oraz zakres czasu (`DECISIONS.md` O3).
- Bilans energii uwzględnia straty, różnice synchronizacji i brakujące źródła, zamiast ukrywać rozbieżności.
- Brak pomiaru to brak danych, nie `0`.
- Nie interpoluj luk bez jawnie wybranej metody i oznaczenia wartości jako `ESTIMATED`.
- Agregaty przechowują liczbę próbek i pokrycie okresu, żeby UI mogło pokazać niepełne dane.

## Wymagane metadane każdego pomiaru

1. Nazwa metryki.
2. Wartość i jednostka.
3. Czas obserwacji i czas odebrania.
4. Urządzenie/źródło.
5. Jakość i status weryfikacji punktu danych.
6. Pochodzenie: surowe, przeliczone, szacowane, symulowane lub demo.

## Wartości pochodne dashboardu

Proponowane definicje (do zatwierdzenia — `DECISIONS.md` O3), liczone z energii w okresie:
- **autokonsumpcja** = (produkcja PV − eksport) / produkcja PV;
- **samowystarczalność** = (zużycie domu − import) / zużycie domu.

Do zatwierdzenia także: ładowanie/rozładowanie baterii, sprawność falownika, energia dzienna i miesięczna.

Nie zakładaj, że każdy falownik lub BMS dostarcza te same dane. Widżet jest ukryty albo pokazuje „parametr niedostępny”, gdy nie ma źródła. Przykłady często niedostępnych bez dodatkowego sprzętu: napięcia min/max ogniw, temperatura paneli, nasłonecznienie, pogoda.

## Niespójności w makietach (`graf/`) — przypadki testowe

Makiety są referencją układu, nie danych. Zawierają sprzeczności, które dobrze nadają się na testy walidacji i obliczeń:
- Dane dzienne: PV 28,4 kWh, zużycie 22,7 kWh, import 4,2 kWh, eksport 1,6 kWh dają autokonsumpcję ≈ 94% i samowystarczalność ≈ 81%; makieta pokazuje 89% dla obu pojęć.
- Bilans chwilowy się nie domyka: moc AC falownika 4,56 kW + import 0,68 kW ≠ dom 3,12 kW + ładowanie 2,4 kW.
- Różne wartości tej samej wielkości na różnych ekranach: pojemność baterii 10 i 15,36 kWh, cykle 412 i 312, eksport 1,6 i 2,1 kWh, zużycie 22,7 i 18,2 kWh.
- Różny sprzęt: Solis S6-EH1P + Pylontech US5000 (Dashboard) oraz Deye SUN-12K-SG05LP3 + BOS-G16 (Instalacja, Urządzenia).
- Nasłonecznienie 684 W/m² i „Słonecznie” o 21:35 w październiku — fizycznie niemożliwe.
