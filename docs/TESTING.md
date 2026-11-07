# Strategia testów

Projekt powstaje bez stałego dostępu do sprzętu. Dlatego warstwa symulatorów jest pełnoprawną częścią testów, ale **nigdy nie zastępuje** testu sprzętowego przy nadawaniu statusu `VERIFIED`.

## Piramida testów

1. **Unit:** konwersje jednostek, obliczenia energetyczne, reguły świeżości, dekodowanie rejestrów (typ, skala, kolejność bajtów/słów), walidatory, weryfikacja licencji.
2. **Profile:** walidacja schematu każdego profilu; każdy punkt danych ma źródło dowodu i status.
3. **Component (frontend):** KPI, wykres, status urządzenia, alarm; stany loading/empty/error/stale.
4. **Integration:** API + PostgreSQL, migracje, ingest partii od agenta, autoryzacja per instalacja.
5. **Symulacja urządzeń:** agent ↔ symulator protokołu (patrz niżej).
6. **E2E:** logowanie, wybór instalacji, dashboard z danymi na żywo, historia, alarmy (Playwright).
7. **Hardware-in-the-loop:** odczyt z dokładnie wskazanego modelu i firmware; wynik zapisany w profilu.

## Symulatory urządzeń

- Symulator generujemy **z tego samego profilu** co adapter (np. serwer Modbus z pymodbus, serwer Solarman V5, serwer HTTP). Dzięki temu każdy profil ma od razu cyfrowego bliźniaka.
- Wartości w symulatorze pochodzą z profili czasowych: realistyczna produkcja PV z PVGIS (np. przez pvlib) dla wskazanej lokalizacji, profil zużycia domu i model baterii. Dane mają `origin = SIMULATED`. Stan obecny (D40): prosty deterministyczny model w `simulator/`; PVGIS/pvlib dojdą później.
- Wstrzykiwanie błędów: timeout, zerwanie połączenia, drugi klient odrzucony, błędna odpowiedź, wartość poza zakresem, reset licznika, skok czasu.
- Nagrania (fixtures) z rzeczywistych urządzeń, gdy będą dostępne — anonimizowane, bez numerów seryjnych i adresów.
- Symulator testuje zgodność z **naszym odczytaniem** dokumentacji, nie z urządzeniem. Profil przetestowany tylko na symulatorze ma najwyżej poziom `COMMUNITY`.

## Minimalne przypadki brzegowe

- Brak odczytu / `null`.
- Wartość zero jako prawidłowy pomiar.
- Nieaktualny pomiar, utrata komunikacji z urządzeniem i z agentem (to różne stany).
- Jednostka niezgodna z definicją; wartość spoza fizycznie możliwego zakresu.
- Duplikat partii od agenta i opóźniona dosyłka z bufora.
- Reset/rollover licznika energii.
- Strefa czasowa i zmiana czasu (DST).
- Brak jednej fazy lub jednego źródła bilansu.
- Adapter: timeout, błąd autoryzacji, niepoprawna odpowiedź, odrzucenie drugiego połączenia.
- Użytkownik próbuje odczytać instalację innej organizacji.
- Duży zakres dat / niepoprawny parametr API.
- Niespójności z makiet (`DATA_MODEL.md`) jako testy obliczeń KPI i bilansu.
- Sprawdzanie aktualizacji: nowsza, ta sama i starsza wersja; wersja testowa; nieprawidłowy lub brakujący podpis; uszkodzony lub zbyt duży manifest; timeout i brak Internetu; wyłączone sprawdzanie automatyczne; komunikat bezpieczeństwa, którego nie da się trwale ukryć; ręczne sprawdzenie przez użytkownika bez roli administratora (odmowa).
- Monitor serwera: metryka niedostępna (np. brak czujnika temperatury w VM) jako „niedostępne”, nie 0; przekroczenie progu z histerezą; komponent bez heartbeatu; dysk bliski zapełnienia; odmowa dostępu dla roli bez uprawnień administratora; narzut pomiaru na RPi.
- Instalator: czysta instalacja na każdym systemie z O14 (amd64 i arm64, w tym RPi i LXC w Proxmox); ponowne uruchomienie na istniejącej instalacji; brak Dockera; zajęty port 80/443; za mało RAM lub miejsca; brak Internetu w trakcie; przerwane pobieranie skryptu; `--dry-run` niczego nie zmienia; `uninstall` bez `--purge` zostawia dane; brak sekretów w logu instalacji.
- Sprzątanie po aktualizacji (na hoście testowym z obrazami innej aplikacji): usuwa tylko obrazy z etykietą produktu; zostawia poprzednią wersję; nie rusza wolumenów, kopii zapasowych ani konfiguracji; nie sprząta po nieudanych health checks; `--dry-run` niczego nie usuwa.

## Narzędzia

- Python: `pytest` (+ wsparcie asyncio), `ruff`, `mypy --strict`.
- Frontend: Vitest + React Testing Library, oxlint (z wtyczkami react, jsx-a11y), `tsc -b`. ESLint zastąpiony przez oxlint, bo typescript-eslint nie wspiera jeszcze TypeScript 7.
- E2E: Playwright.
- Instalator (stan obecny, D34): CI uruchamia ShellCheck, `--dry-run` w kontenerach Debian 12/13 i Ubuntu 24.04/26.04 oraz pełną instalację z paczki na Ubuntu 24.04 (HTTPS z lokalnego CA, nagłówki, link `/setup`, logowanie, ponowna instalacja, `uninstall` i `--purge`). arm64 i Raspberry Pi OS — ręcznie.
- Instalator (docelowo): ShellCheck dla skryptu; testy instalacji w czystych maszynach wirtualnych/kontenerach każdego wspieranego systemu (amd64 w CI, arm64 na RPi lub emulacji).
- CI: lint, typecheck, testy, build obrazów, skan podatności, **kontrola licencji zależności** (lista dozwolonych z `COMPLIANCE.md`), generowanie SBOM.

Dokładne komendy zostaną zapisane w README po skonfigurowaniu w etapie P0/P1.

## Kontrole przed zakończeniem zadania

- Formatter, linter, typecheck.
- Testy powiązane z kodem; całość, jeśli zmiana dotyka wspólnych kontraktów.
- Build produkcyjny.
- Przegląd `git diff`.

Nie deklaruj „wszystkie testy przeszły”, jeżeli nie uruchomiono odpowiedniej komendy. Podaj dokładną komendę i wynik. Test na symulatorze opisuj zawsze oddzielnie od testu sprzętowego.
