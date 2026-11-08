# Architektura SolarGraf

Status: kierunek zatwierdzony (`DECISIONS.md` D2–D11). Szczegóły oznaczone „do potwierdzenia” rozstrzygamy w odpowiednim etapie.

## Zasada: modularny monolit + agent

Serwer to modularny monolit w Pythonie (API + logika domenowa) z bazą PostgreSQL. Odczyt urządzeń wykonuje osobny komponent — **agent** — który jest jedynym klientem każdego urządzenia. Wszystkie obsługiwane instalacje są w sieci serwera (D14), więc agent działa na serwerze (tryb lokalny). Tryb zdalny (agent w innej lokalizacji, „Lokalizacja B” na diagramie) jest poza MVP; kontrakt agent ↔ serwer pozostaje sieciowy, żeby go nie blokować.

```text
            Lokalizacja A (LAN)                     Lokalizacja B (poza MVP)
  Falownik / logger / licznik / BMS          Falownik / logger / licznik / BMS
        │ Modbus TCP/RTU, Solarman V5,              │
        │ HTTP/JSON, MQTT                           │
        ▼                                           ▼
  ┌──────────────┐                           ┌──────────────┐
  │ Agent        │                           │ Agent (RPi)  │
  │ sterowniki + │                           │ bufor offline│
  │ profile      │                           └──────┬───────┘
  └──────┬───────┘                                  │ HTTPS przez VPN,
         │ HTTP (lokalnie)                          │ połączenie wychodzące
         ▼                                          ▼
  ┌──────────────────────────────────────────────────────────┐
  │ Serwer SolarGraf (Docker Compose)                        │
  │  Caddy (TLS) → FastAPI: API, SSE, ingest od agentów      │
  │                 └ moduły domenowe                        │
  │  PostgreSQL: konfiguracja, pomiary, agregaty, alarmy     │
  │  Statyczny frontend React (serwowany przez Caddy)        │
  └──────────────────────────────────────────────────────────┘
         ▲
         │ HTTPS w LAN lub przez VPN
     Przeglądarka
```

To diagram logiczny, nie potwierdzenie obsługi określonych protokołów przez konkretne urządzenia.

## Komponenty

| Komponent | Odpowiedzialność | Technologia |
|---|---|---|
| `web` | SPA: dashboard, wykresy, urządzenia, instalacje, alarmy, ustawienia | React + TypeScript + Vite, ECharts |
| `api` | REST + SSE dla UI, ingest od agentów, uwierzytelnianie, autoryzacja | FastAPI, Pydantic |
| `worker` | agregacje, reguły alarmów, retencja, raporty (osobny proces tego samego kodu) | Python asyncio |
| `agent` | odczyt urządzeń, normalizacja, bufor, wysyłka do serwera | Python asyncio, pymodbus, pysolarmanv5, httpx |
| `db` | trwałe dane | PostgreSQL |
| `proxy` | TLS, serwowanie frontendu, nagłówki bezpieczeństwa | Caddy |

Bez Redis/Kafka/brokera, dopóki pomiary obciążenia tego nie uzasadnią.

## Moduły serwera

- `orgs` — organizacje, użytkownicy, członkostwa i role.
- `sites` — instalacje, strefa czasowa, dane opisowe (wpisywane ręcznie, np. data uruchomienia, gwarancja).
- `devices` — urządzenia fizyczne, połączenia i podurządzenia logiczne (MPPT, BMS, licznik za falownikiem).
- `profiles` — rejestr profili urządzeń z wersją i poziomem wsparcia.
- `agents` — rejestracja agentów, poświadczenia, heartbeat, wersja.
- `ingest` — przyjmowanie partii pomiarów od agentów, idempotentność, walidacja.
- `measurements` — zapis, odczyt historii, agregaty.
- `energy` — jawnie zdefiniowane obliczenia bilansu i KPI.
- `alarms` — reguły, otwieranie, potwierdzanie, zamykanie.
- `reports` — raporty i eksport CSV.
- `licensing` — weryfikacja pliku licencji offline i limitów.
- `updates` — sprawdzanie dostępności nowej wersji i komunikat w UI (D15).
- `system` — monitor wydajności i stabilności serwera (D16).
- `dashboard` — kompozycja danych dla widżetów, bez ukrytej logiki domenowej.

## Agent: sterowniki i profile

Obsługę „wszystkich producentów” budujemy z dwóch warstw, żeby nowa marka nie wymagała nowego kodu:

1. **Sterowniki transportu** (kod Python, nieliczne): Modbus TCP, Modbus RTU (bramka lub USB), Solarman V5, SunSpec (odkrywanie modeli zgodnie ze standardem), HTTP/JSON, MQTT. Mostki do istniejących bramek (np. OpenDTU, Victron Venus) to profile oparte na HTTP/MQTT.
2. **Profile urządzeń** (pliki deklaratywne, np. YAML, wersjonowane): mapują parametry urządzenia na metryki kanoniczne.

Każdy punkt danych w profilu zawiera co najmniej:
- metrykę kanoniczną (`MetricDefinition.key`);
- adres/rejestr/endpoint, typ danych, kolejność bajtów/słów, skalę i jednostkę źródłową;
- **źródło dowodu** (dokument producenta z wersją lub inne wiarygodne źródło);
- status weryfikacji: `VERIFIED`, `PARTIALLY_VERIFIED`, `UNVERIFIED`, `UNSUPPORTED`.

Profil jako całość ma poziom wsparcia widoczny w UI:
- `VERIFIED` — przetestowany na rzeczywistym modelu i firmware;
- `COMMUNITY` — zbudowany z dokumentacji, przetestowany na symulatorze;
- `EXPERIMENTAL` — niepełny lub bez potwierdzonej dokumentacji.

Z tego samego profilu generowane są testy parsera i **symulator urządzenia** (patrz `TESTING.md`). Profili nie kopiujemy z projektów copyleft (`COMPLIANCE.md`).

Nie projektujemy autodiscovery, które „samo wymyśla” rejestry. Odkrywanie jest dozwolone tylko tam, gdzie protokół je definiuje (np. modele SunSpec), a semantykę i tak weryfikujemy.

## Agent: zasady pracy z urządzeniem

- Jedno połączenie na urządzenie fizyczne; agent kolejkuje odczyty, nie otwiera równoległych sesji. Część urządzeń (np. niektóre dongle i falowniki) akceptuje tylko jednego klienta Modbus TCP.
- Interwał, timeouty, liczba ponowień i maksymalny rozmiar bloku rejestrów pochodzą z profilu — loggery Wi-Fi zawieszają się przy zbyt częstym odpytywaniu.
- Retry z backoff dla błędów przejściowych; rozróżnienie timeoutu, błędu protokołu, błędnej odpowiedzi i braku parametru.
- Wynik każdego cyklu zapisywany jako `PollingRun`.
- Lokalny bufor (np. SQLite) na czas braku łączności z serwerem; wysyłka po przywróceniu połączenia.

## Agent ↔ serwer (do potwierdzenia w P3)

Propozycja:
- agent inicjuje połączenie wychodzące (w trybie zdalnym przez VPN); serwer nie łączy się do lokalizacji klienta;
- partie pomiarów przez HTTPS z identyfikatorem partii (idempotentność) i heartbeat;
- każdy agent ma własne poświadczenie z możliwością odwołania i rotacji;
- konfiguracja urządzeń pobierana przez agenta z serwera, sekrety urządzeń przechowywane po stronie agenta lub szyfrowane.

## Aktualność danych i status urządzeń

Status urządzenia nie opiera się na pojedynczym polu „online”. Polityka per urządzenie/parametr:
- `last_success_at`, `last_attempt_at`, `consecutive_failures`;
- `freshness_threshold` (wynikający z interwału profilu);
- `quality` / `status` ostatniego odczytu.

Statusy: `ONLINE`, `STALE`, `OFFLINE`, `UNKNOWN`, `DISABLED`. Status agenta (heartbeat) jest osobny od statusu urządzeń — utrata agenta oznacza `UNKNOWN`, nie `OFFLINE` urządzeń.

## API — szkic, nie ostateczny kontrakt

UI:
- `GET /api/sites`
- `GET /api/sites/{site_id}/dashboard?from=...&to=...`
- `GET /api/sites/{site_id}/devices`
- `GET /api/sites/{site_id}/measurements?metric=...&from=...&to=...&resolution=...`
- `GET /api/sites/{site_id}/alarms`
- `POST /api/sites/{site_id}/alarms/{alarm_id}/acknowledge`
- `GET /api/sites/{site_id}/live` — strumień SSE z ostatnimi wartościami

Agent:
- `POST /api/agent/v1/measurements` — partia pomiarów
- `POST /api/agent/v1/heartbeat`
- `GET /api/agent/v1/config`

Wszystkie endpointy wymagają uwierzytelnienia; endpointy instalacji sprawdzają uprawnienia do `site_id` po stronie serwera. Zakres czasu jest walidowany i ograniczony, odpowiedzi paginowane. Kontrakt publikowany jako OpenAPI, z którego frontend generuje typy.

## Dane na żywo

Agent wysyła pomiary → API zapisuje je i publikuje do subskrybentów SSE danej instalacji (w procesie; bez brokera w MVP). UI pokazuje wiek każdej wartości. Rzeczywiste opóźnienie zależy od urządzenia (zwykle sekundy–dziesiątki sekund) i nie obiecujemy odświeżania szybszego niż interwał profilu.

Szczegóły kontraktu i ograniczenia (jeden proces API, ponowne łączenie, wartości instalacji z jednego źródła): `DECISIONS.md` D50.

## Sprawdzanie aktualizacji

Decyzja: `DECISIONS.md` D15; otwarte szczegóły: O10.

**Tryby:**
- **Ręczny** — przycisk „Sprawdź aktualizacje” w Ustawieniach (rola administratora).
- **Automatyczny** — zadanie `worker` raz w tygodniu, z losowym przesunięciem godziny (żeby wiele serwerów nie pytało jednocześnie). Administrator może je wyłączyć, np. na serwerze bez dostępu do Internetu.

**Przebieg:**
1. Serwer pobiera przez HTTPS statyczny **manifest wersji** z serwera producenta (adres w konfiguracji, timeout, limit rozmiaru odpowiedzi).
2. Weryfikuje podpis manifestu (np. Ed25519, kluczem publicznym wbudowanym w aplikację; osobny klucz niż dla licencji). Manifest bez ważnego podpisu jest odrzucany.
3. Porównuje wersje lokalnie (wersjonowanie semantyczne, ignoruje wersje testowe, jeśli kanał tego nie dopuszcza).
4. Zapisuje wynik i ewentualnie tworzy powiadomienie.

Manifest zawiera co najmniej: numer najnowszej wersji, datę wydania, minimalną wersję, z której można aktualizować, flagę „zawiera poprawki bezpieczeństwa”, krótki opis zmian i adres informacji o wydaniu.

**Prywatność:** żądanie nie zawiera danych instalacji, identyfikatora licencji ani numerów seryjnych. Porównanie wersji odbywa się po stronie serwera klienta.

**Komunikat w UI:**
- baner dla administratorów: „Dostępna jest wersja X.Y.Z” z opisem zmian i odnośnikiem do instrukcji aktualizacji;
- wersja z poprawkami bezpieczeństwa ma wyższy priorytet i nie da się jej trwale ukryć (można odłożyć komunikat do kolejnego logowania);
- zwykłą wersję administrator może ukryć — do pojawienia się kolejnej;
- w Ustawieniach: bieżąca wersja, data ostatniego sprawdzenia i jego wynik.

**Błędy:** brak połączenia lub niepoprawny manifest nie są alarmem instalacji. UI pokazuje „Nie udało się sprawdzić aktualizacji” z datą ostatniego udanego sprawdzenia.

**Poza zakresem:** automatyczne pobieranie i instalowanie aktualizacji. Aktualizacja odbywa się ręcznie według procedury z P7 (backup bazy przed migracją, rollback).

API (D63, tylko OWNER, zmiany z CSRF):
- `GET /api/system/updates` — wersja bieżąca, dostępna (z flagą bezpieczeństwa i możliwością bezpośredniej aktualizacji), data i wynik sprawdzenia, ustawienie automatycznego sprawdzania;
- `POST /api/system/updates/check` — sprawdzenie ręczne (najwyżej raz na minutę);
- `PUT /api/system/updates/settings` — włączenie/wyłączenie sprawdzania automatycznego;
- `POST /api/system/updates/dismiss` — ukrycie zwykłej wersji (wersji z poprawkami bezpieczeństwa — nie).

UI (P7.3b): panel „Aktualizacje” na stronie Ustawienia → Stan serwera i baner nad treścią każdej strony — oba tylko dla roli OWNER (jak API). Ukrycie zwykłej wersji zapisuje serwer (dla wszystkich właścicieli); odłożenie wersji z poprawkami bezpieczeństwa trzyma przeglądarka w `sessionStorage` do zamknięcia karty albo wylogowania.

Wydanie: `tools/release.py version X.Y.Z` (wersja we wszystkich pakietach), tag `vX.Y.Z`, `tools/release.py manifest --key …` i dołączenie `manifest.json` oraz `manifest.json.sig` do wydania na GitHubie.

## Monitor serwera

Decyzje: `DECISIONS.md` D16 i D60 (progi, histereza, sposób pomiaru). Widok „Stan serwera” w Ustawieniach, tylko dla roli OWNER.

**Co pokazujemy:**

| Obszar | Metryki |
|---|---|
| Ocena ogólna | `STABILNY` / `OSTRZEŻENIE` / `KRYTYCZNY` z listą przyczyn |
| Procesor | zużycie %, średnie obciążenie (1/5/15 min), liczba rdzeni |
| Pamięć | RAM użyty / całkowity, swap |
| Dysk | zajętość i wolne miejsce wolumenu danych, rozmiar bazy, szacowany czas do zapełnienia (z trendu przyrostu) |
| Temperatura | temperatura CPU, jeśli host ją udostępnia (np. RPi) |
| Zasilanie RPi | niedobór napięcia (hwmon `rpi_volt`), jeśli host to udostępnia; dławienie taktowania — później |
| System | czas pracy od uruchomienia, wersja aplikacji, data ostatniej aktualizacji |
| Komponenty | `api`, `worker`, `agent`, `db`, `proxy`: stan, czas ostatniego heartbeatu, liczba restartów (jeśli dostępna) |
| Aplikacja | opóźnienie zapisu pomiarów, rozmiar bufora agenta, czas odpowiedzi API |

Historia: wykresy 24 h / 7 dni / 30 dni (ECharts, te same komponenty co dashboard).

**Jak zbieramy dane:**
- Zadanie w `worker` co 60 s (D60) odczytuje metryki hosta własnym kodem z `/proc` i `/sys` (w kontenerze Dockera pokazują wartości hosta; `/sys` jest tylko do odczytu) — bez dodatkowej zależności, montowań i uprawnień.
- Zajętość dysku mierzymy na systemie plików katalogu danych Dockera (`/` kontenera workera), na którym leżą wolumeny bazy; rozmiar bazy z `pg_database_size`.
- Stan komponentów pochodzi z ich endpointów health i heartbeatów — **bez montowania gniazda Dockera** w kontenerach aplikacji (dawałoby to uprawnienia równoważne rootowi na hoście): `api` przez HTTP, `proxy` przez TCP, `agent` z heartbeatu, `worker` — wiek ostatniej oceny.
- Metryki niedostępne na danym sprzęcie (np. temperatura w VM Proxmox) pokazujemy jako „niedostępne”, nie jako 0.
- Pomiar musi być lekki: cel < 1% CPU na RPi 4.

**Ocena stabilności:** wyliczana z progów (D60) z histerezą, żeby status nie migał. Przekroczenie progu krytycznego tworzy alarm systemowy widoczny dla administratorów (oddzielny od alarmów instalacji).

API (szkic):
- `GET /api/system/health` — bieżący stan i ocena;
- `GET /api/system/metrics?range=24h|7d|30d` — historia 4 serii (średnia i maksimum w przedziale) i prognoza zapełnienia dysku (D61).

## Instalator jedną komendą

Decyzja: `DECISIONS.md` D18; otwarte: O13 (źródło pobierania), O14 (wspierane systemy).

**Komenda (docelowa postać, domena do ustalenia):**

```bash
curl -fsSL https://<domena-producenta>/install.sh | sudo bash
```

Dla ostrożnych administratorów ta sama instalacja w wersji z weryfikacją: pobranie skryptu, sprawdzenie sumy kontrolnej i podpisu opublikowanych obok, przejrzenie i dopiero uruchomienie. Obie ścieżki opisuje instrukcja instalacji.

**Co robi instalator:**
1. Sprawdza system i architekturę (O14): 64-bit, RAM, wolne miejsce, wolne porty 80/443, dostęp do Internetu. Na RPi ostrzega przy instalacji na karcie SD. W LXC na Proxmox sprawdza, czy Docker może działać (nesting).
2. Jeśli brak Dockera — po potwierdzeniu instaluje Docker Engine i Compose z oficjalnego repozytorium Dockera.
3. Tworzy katalog instalacji (np. `/opt/<produkt>`) i użytkownika systemowego, jeśli potrzebny.
4. Generuje losowe sekrety (hasło bazy, klucze sesji) do pliku z uprawnieniami `600`; nigdy nie używa haseł domyślnych.
5. Pobiera obrazy w wersji wskazanej przez podpisany manifest (ten sam co w D15) i uruchamia Docker Compose.
6. Czeka na health checks wszystkich komponentów.
7. Wypisuje adres aplikacji w LAN i **jednorazowy link** do utworzenia pierwszego konta administratora (ważny ograniczony czas).
8. Instaluje narzędzie wiersza poleceń na hoście (np. `/usr/local/bin/<produkt>`).

**Narzędzie na hoście (jedno dla całego cyklu życia):**

| Polecenie | Działanie |
|---|---|
| `install` | instalacja jak wyżej |
| `update` | aktualizacja z backupem, health checks, rollbackiem i sprzątaniem (sekcja niżej) |
| `status` | wersja, stan komponentów, miejsce na dysku |
| `backup` / `restore` | kopia i odtworzenie bazy, `.env` i CA proxy; kopia automatyczna codziennie o 3:00, retencja 7 (D62) |
| `logs` | logi komponentów (bez sekretów) |
| `uninstall` | usunięcie aplikacji; dane i kopie zostają, chyba że podano `--purge` i potwierdzono |

**Zasady:**
- Idempotentność: ponowne uruchomienie instalacji na istniejącej instalacji nic nie psuje — wykrywa ją i proponuje `update` albo naprawę.
- Tryb nieinteraktywny (`--yes`) z parametrami (`--version`, `--dir`, `--no-update-check`) dla instalatorów wdrażających wiele serwerów.
- `--dry-run` pokazuje plan bez zmian w systemie.
- Instalacja bez Internetu: paczka offline (obrazy + skrypt + manifest) przenoszona na serwer — do decyzji w P7.
- Log instalacji zapisywany na hoście, bez sekretów.
- Instalator jest skryptem powłoki POSIX/Bash z minimalnymi zależnościami (curl, coreutils) i testowany na każdym wspieranym systemie.

## Aktualizacja i sprzątanie plików instalacyjnych

Decyzja: `DECISIONS.md` D17; liczba zachowanych wersji: O12.

Aktualizację wykonuje polecenie `update` narzędzia na hoście (sekcja wyżej), uruchamiane przez administratora (aplikacja w kontenerze tylko informuje o nowej wersji — D15). Kolejność:

1. Backup bazy.
2. Pobranie nowych obrazów (gotowe obrazy multi-arch; budowanie na serwerze klienta tylko jako wyjątek).
3. Migracje i uruchomienie nowej wersji.
4. Health checks wszystkich komponentów.
5. **Tylko jeśli health checks przeszły** — sprzątanie:
   - obrazy Dockera aplikacji starsze niż poprzednia wersja (poprzednia zostaje do rollbacku);
   - osierocone (dangling) warstwy obrazów aplikacji;
   - cache budowania, jeśli obraz był budowany lokalnie;
   - pobrane archiwa i pliki tymczasowe wydań w katalogu instalacyjnym.
6. Raport: usunięte elementy i odzyskane miejsce — w logu skryptu i w widoku „Stan serwera” (data ostatniej aktualizacji, odzyskane miejsce).

**Czego nigdy nie usuwamy:** wolumenów z danymi, kopii zapasowych (mają własną retencję), plików konfiguracyjnych i sekretów, obrazów i kontenerów innych aplikacji na tym samym hoście. Dlatego sprzątanie wybiera obrazy po **etykiecie produktu** nadawanej przy budowaniu (np. `org.opencontainers.image.vendor` / własna etykieta produktu), a nie przez ogólne `docker system prune`.

Jeśli health checks nie przejdą, skrypt nie sprząta i proponuje rollback do poprzedniej wersji. Tryb `--dry-run` pokazuje, co zostałoby usunięte.

## Przechowywanie

- PostgreSQL z partycjonowaniem tabel pomiarów po czasie (natywne partycje deklaratywne).
- Własne tabele agregatów (np. 5 min, godzina, dzień) liczone przez `worker`.
- Retencja przez usuwanie całych partycji (`DECISIONS.md` O8).
- Przed zmianą podejścia zmierz: liczbę instalacji, urządzeń i metryk, interwał, retencję i obciążenie zapytań.

## Wdrożenie

- Docker Compose: `proxy`, `api`, `worker`, `agent`, `db`; obrazy wieloarchitekturowe (amd64, arm64) z przypiętymi wersjami.
- Kontenery jako użytkownik nieuprzywilejowany, health checks, logi bez sekretów.
- Raspberry Pi 4/5 z SSD, mini-PC lub VM/LXC w Proxmox. Urządzenia USB-RS485 wymagają przekazania urządzenia do kontenera (a w Proxmox — passthrough USB do VM/LXC).
- Instalacja jedną komendą i narzędzie na hoście do aktualizacji (z backupem bazy przed migracją i sprzątaniem starych plików instalacyjnych), backupu i odinstalowania — sekcje wyżej.
- Obrazy mają etykietę produktu, żeby skrypty mogły bezpiecznie rozpoznać i usuwać wyłącznie własne obrazy.
- Synchronizacja czasu (NTP) na serwerze i agentach; zegarom loggerów nie ufamy domyślnie.
- Agent zdalny (poza MVP): ten sam obraz, uruchamiany samodzielnie na RPi w lokalizacji instalacji.
- Instalacje w różnych podsieciach tej samej sieci wymagają routingu do serwera; zalecana izolacja urządzeń w osobnym VLAN z dostępem tylko z serwera.
