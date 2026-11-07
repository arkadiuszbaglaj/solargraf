# Decyzje

Claude Code zadaje pytania dotyczące pozycji otwartych, proponuje domyślną opcję i czeka na odpowiedź. Nie trzeba rozstrzygać wszystkich pozycji naraz, jeśli część można odłożyć.

## Zatwierdzone

Data zatwierdzenia: 2026-11-04 (właściciel projektu).

| # | Obszar | Decyzja | Konsekwencja |
|---|---|---|---|
| D1 | Model produktu | Produkt komercyjny, zamknięty, sprzedawany na licencji. | Tylko zależności permisywne; kontrola licencji w CI; obowiązki CRA i RODO (`COMPLIANCE.md`). |
| D2 | Wdrożenie | Instalacja na serwerze Linux: VM/LXC w Proxmox, mini-PC, Raspberry Pi 4/5. Docker Compose, obrazy amd64 + arm64. | RPi 3 i systemy 32-bitowe nie są wspierane; wymagany dysk SSD na RPi. |
| D3 | Dostęp | Przeglądarka w sieci LAN lub przez VPN. Bez wystawiania do Internetu. | Logowanie i TLS także w LAN; przekierowanie portów nie jest wspieraną metodą dostępu. |
| D4 | Aplikacja mobilna | Nie budujemy na tym etapie. | UI responsywne; API projektowane tak, by nie blokować aplikacji w przyszłości. |
| D5 | Instalacje i użytkownicy | Jeden serwer obsługuje wiele instalacji i wielu użytkowników. | Organizacje, role, izolacja danych i testy uprawnień od etapu P2. |
| D6 | Producenci urządzeń | Docelowo wszyscy producenci. | Sterowniki protokołów + deklaratywne profile urządzeń + poziomy wsparcia; marki dodawane stopniowo. |
| D7 | Język backendu | Python (FastAPI, Pydantic, SQLAlchemy, Alembic). | Zastępuje wcześniejszą propozycję Next.js/Prisma. |
| D8 | Frontend | React + TypeScript + Vite jako SPA, budowane do plików statycznych. Wykresy: Apache ECharts. | Node.js tylko do budowania, nie na serwerze klienta. |
| D9 | Dane na żywo | Server-Sent Events z API do przeglądarki. | Jeden mechanizm realtime; WebSocket tylko, jeśli pojawi się potrzeba komunikacji dwukierunkowej. |
| D10 | Baza danych | PostgreSQL z natywnym partycjonowaniem i własnymi agregatami. Bez TimescaleDB. | Unikamy niejasności licencji Timescale License w produkcie dystrybuowanym. |
| D11 | Pozyskiwanie danych | Osobny komponent **agent** jest jedynym klientem urządzeń. Może działać na tym samym serwerze lub w innej lokalizacji. | Rozwiązuje limit jednego połączenia Modbus; umożliwia instalacje w różnych sieciach. |
| D12 | Sterowanie | MVP tylko odczytuje dane. | Zapis do urządzeń to osobny projekt ryzyka. |
| D13 | Strefa czasowa | Przechowywanie w UTC; domyślna strefa prezentacji `Europe/Warsaw`, konfigurowalna per instalacja. | — |
| D14 | Topologia sieci | Wszystkie instalacje obsługiwane przez serwer są w tej samej sieci co serwer. Agent działa na serwerze (tryb lokalny). | Agent zdalny (P3b) poza MVP; kontrakt agent ↔ serwer pozostaje sieciowy, żeby nie blokować go w przyszłości. |
| D15 | Sprawdzanie aktualizacji | Administrator sprawdza dostępność nowej wersji ręcznie albo system robi to automatycznie raz w tygodniu (opcja włączana/wyłączana). O nowej wersji informuje komunikat w UI. Instalacja aktualizacji pozostaje ręczna. | Jedyne domyślne połączenie wychodzące do Internetu; bez wysyłania danych instalacji; manifest wersji podpisany (`ARCHITECTURE.md`). Zatwierdzone 2026-11-05. |
| D16 | Monitor serwera | W Ustawieniach widok „Stan serwera” dla administratora: ogólna ocena stabilności oraz zużycie CPU, RAM, dysku, temperatura (jeśli dostępna), stan komponentów aplikacji i historia. | Odczyt metryk hosta bez dostępu do gniazda Dockera; lekki pomiar, by nie obciążać RPi. Zatwierdzone 2026-11-05. |
| D17 | Sprzątanie po aktualizacji | Po udanej aktualizacji skrypt aktualizacji usuwa nieaktualne pliki instalacyjne: stare obrazy Dockera aplikacji, osierocone warstwy, cache budowania i pobrane archiwa wydań. Zostaje poprzednia wersja do rollbacku. | Nigdy nie usuwa wolumenów z danymi, kopii zapasowych, konfiguracji ani obrazów innych aplikacji na tym samym hoście. Zatwierdzone 2026-11-05. |
| D18 | Instalacja jedną komendą | Instalacja na czystym Linuksie jedną komendą w terminalu. Instalator sprawdza wymagania, w razie potrzeby instaluje Dockera, generuje sekrety, uruchamia aplikację i podaje adres do pierwszej konfiguracji. Ten sam program obsługuje aktualizację, status, backup i odinstalowanie. | Wysoki priorytet — pierwsza wersja instalatora już w P1, rozwijana do P7. Instalator jest wersjonowany i podpisany; dostępna ścieżka z ręczną weryfikacją przed uruchomieniem. Zatwierdzone 2026-11-05. |
| D19 | Wersja Pythona | Python 3.12 przypięty w `.python-version` i `requires-python`. | Obrazy Dockera używają tej samej wersji; zmiana wersji to osobna decyzja. Zatwierdzone 2026-11-07. |
| D20 | Menedżer pakietów Python | uv (MIT/Apache-2.0) z workspace i lockfile `uv.lock`. | Instalacje w CI i obrazach z `uv sync --locked`. Zatwierdzone 2026-11-07. |
| D21 | CI i repozytorium zdalne | GitHub Actions w prywatnym repozytorium GitHub. | Push i utworzenie repozytorium tylko za wyraźną zgodą właściciela. Zatwierdzone 2026-11-07. |
| D22 | Frontend — narzędzia | npm z `package-lock.json`; Node.js 26 LTS przypięty w `.nvmrc` i `engines`. | Node tylko do budowania (D8). Zatwierdzone 2026-11-07. |
| D23 | Docker w środowisku deweloperskim | Docker Engine w WSL2 albo na docelowej maszynie Linux (VM Proxmox / RPi). Bez Docker Desktop. | Unikamy płatnej licencji Docker Desktop; potrzebne od P1. Zatwierdzone 2026-11-07. |
| D24 | Wersja PostgreSQL | PostgreSQL 18 (oficjalny obraz `postgres:18`). Sterownik asyncpg (Apache-2.0); psycopg wykluczony (LGPL). | Zmiana wersji głównej wymaga migracji danych (`pg_upgrade`/dump) — osobna decyzja. Zatwierdzone 2026-11-07. |
| D25 | Endpointy health | `GET /api/health` (proces żyje) i `GET /api/health/ready` (także baza; 200/503) dostępne bez uwierzytelnienia. Odpowiedź zawiera tylko status — bez wersji, hostów i treści błędów. | Jedyny wyjątek od reguły „wszystkie endpointy wymagają uwierzytelnienia”; potrzebny dla health checków Dockera i instalatora. Zatwierdzone 2026-11-07. |
| D26 | Migracje bazy | Osobna jednorazowa usługa `migrate` w Compose (`alembic upgrade head`) przed startem `api`. API nie zmienia schematu. | Umożliwia backup przed migracją w instalatorze/aktualizacji (P7). Zatwierdzone 2026-11-07. |
| D27 | Definicje KPI (z O3) | Autokonsumpcja = (produkcja PV − eksport) / produkcja PV. Samowystarczalność = (zużycie domu − import) / zużycie domu. Dwa osobne wskaźniki, liczone z energii w danym okresie. | Implementacja i testy w P4; UI podpisuje wskaźnik definicją i okresem. Zatwierdzone 2026-11-07. |
| D28 | Frontend — biblioteki UI | ECharts (Apache-2.0) przez własny cienki komponent z importem modułowym; ikony lucide-react (ISC); style: CSS Modules + tokeny w zmiennych CSS; bez routera do czasu drugiego widoku. Testy: Testing Library + jsdom. | Bez echarts-for-react i Tailwind. Zatwierdzone 2026-11-07. |

## Otwarte — blokujące określone etapy

O1 (topologia sieci) rozstrzygnięte 2026-11-04 → D14. O3 (KPI) rozstrzygnięte 2026-11-07 → D27.

| # | Pytanie | Rekomendacja | Blokuje |
|---|---|---|---|
| O2 | Pierwszy sprzęt docelowy. | Deye SUN-12K-SG05LP3 + BOS-G16 przez logger Solarman V5, licznik Eastron SDM630; równolegle ogólny SunSpec. | Pierwszy adapter (P3) |
| O4 | Nazwa handlowa. | Wybrać nową nazwę i sprawdzić w EUIPO/UPRP przed jakimkolwiek materiałem sprzedażowym. | Sprzedaż, branding UI |
| O5 | Model licencjonowania (np. per instalacja, per serwer, subskrypcja aktualizacji). | Podpisany plik licencji weryfikowany offline; limit liczby instalacji; okres aktualizacji. | P7 |
| O6 | Role użytkowników. | Właściciel organizacji, administrator/instalator, podgląd; uprawnienia przypisane do instalacji. | P2 |
| O7 | Opóźnienie danych i liczba urządzeń. | Interwał zależny od profilu urządzenia (zwykle 5–30 s dla loggerów Wi-Fi); UI pokazuje wiek danych. | P3 |
| O8 | Retencja. | Próbki surowe 90 dni, agregaty 5-minutowe 2 lata, godzinowe i dzienne bez limitu — do potwierdzenia pomiarem rozmiaru bazy. | P4 |
| O9 | Deklarowany okres wsparcia produktu (wymóg CRA). | Min. 5 lat aktualizacji bezpieczeństwa od wydania wersji. | P7 |
| O10 | Sprawdzanie aktualizacji: gdzie publikujemy manifest wersji i czy automatyczne sprawdzanie jest domyślnie włączone? | Manifest na serwerze producenta (HTTPS, statyczny plik). Automatyczne sprawdzanie domyślnie włączone, z możliwością wyłączenia w ustawieniach i przy instalacji (serwery bez Internetu). | P7 |
| O11 | Progi oceny stabilności serwera i retencja metryk. | Ostrzeżenie: CPU > 85% przez 15 min, RAM > 90%, dysk > 85%, temperatura > 75 °C; krytyczne: dysk > 95%, komponent niedostępny, niedobór napięcia na RPi. Próbki co 60 s, historia 30 dni. Do potwierdzenia testami na RPi. | P7 |
| O12 | Ile poprzednich wersji zachować do rollbacku po aktualizacji? | Jedną poprzednią wersję. | P7 |
| O13 | Skąd instalator pobiera skrypt i obrazy (domena, rejestr obrazów) i czy dostęp do obrazów wymaga licencji? | Własna domena producenta dla skryptu i manifestu; prywatny rejestr obrazów z tokenem z licencji albo publiczne obrazy, w których działanie ogranicza plik licencji. Decyzja razem z O5. | P1 (wersja dev), P7 |
| O14 | Wspierane systemy. | Debian 12/13, Ubuntu 24.04 LTS, Raspberry Pi OS 64-bit (Bookworm i nowszy); amd64 i arm64. Proxmox: VM albo LXC z włączonym nesting. | P1 |

## Można odłożyć

- Powiadomienia (e-mail, push, komunikatory).
- Prognozy produkcji i optymalizacja taryf.
- Dane pogodowe i nasłonecznienie (wymagają czujnika lub zewnętrznego API, czyli wyjścia poza LAN).
- Wielojęzyczność poza polskim/angielskim.
- Eksport do Home Assistant (MQTT discovery) i eksporty zaawansowane.
- Sterowanie urządzeniami.
- Aplikacja mobilna.
