# Zgodność: licencje, CRA, RODO, nazwa

Ten dokument opisuje wymagania wynikające z tego, że SolarGraf jest **produktem komercyjnym, zamkniętym, sprzedawanym na licencji** (`DECISIONS.md` D1). Nie jest poradą prawną — kluczowe punkty należy raz potwierdzić z prawnikiem (IP, CRA, RODO).

## Licencje zależności

**Dozwolone:** MIT, BSD-2/3-Clause, Apache-2.0, ISC, PSF, PostgreSQL, Zlib.

**Zakazane bez pisemnej zgody właściciela projektu:** GPL, AGPL, LGPL, MPL (do oceny indywidualnej), SSPL, BSL, Timescale License, Commons Clause i inne licencje „source-available”.

Zasady:
- Licencję sprawdzamy w momencie dodawania zależności i ponownie w CI (lista dozwolonych, build kończy się błędem przy niezgodności).
- Zależności przechodnie też podlegają kontroli.
- Narzędzia używane wyłącznie przy tworzeniu i w CI, które nie trafiają do produktu ani obrazów (np. ShellCheck, GPL-3.0), są dozwolone — pod warunkiem że nie są dołączane do dystrybucji.
- Licencje mogą się zmieniać między wersjami — kontrola dotyczy przypiętej wersji.

Stan sprawdzony 2026-11-04 (do ponownej weryfikacji przy dodaniu):

| Pakiet | Licencja | Status |
|---|---|---|
| pymodbus | BSD-3-Clause | dozwolony |
| pysolarmanv5 | MIT | dozwolony |
| goodwe | MIT | dozwolony |
| FastAPI, React, echarts-for-react | MIT | dozwolony |
| Apache ECharts | Apache-2.0 | dozwolony |
| huawei-solar | **AGPL-3.0** | **zakazany** — adapter Huawei piszemy samodzielnie z dokumentacji Huawei |
| TimescaleDB (funkcje TSL) | Timescale License | **nieużywany** (D10) |

## Profile urządzeń i dokumentacja (clean room)

- Nie kopiujemy kodu, profili YAML/JSON ani tabel rejestrów z projektów copyleft (np. integracji Home Assistant na GPL, `sunspec-monitor` GPL-3, `sma-proto` AGPL-3).
- Profile budujemy z dokumentacji producenta (np. „Modbus interface definitions”) lub ze standardów (SunSpec) i zapisujemy źródło z wersją dokumentu.
- Dokumentacja producenta bywa objęta warunkami (NDA, zakaz redystrybucji). Nie dołączamy PDF-ów producentów do repozytorium ani produktu bez sprawdzenia praw.
- Projekty open source możemy czytać, żeby zrozumieć zachowanie urządzenia, ale wynik musi wynikać z dokumentacji lub własnych testów.

## Cyber Resilience Act (Rozporządzenie (UE) 2024/2847)

SolarGraf jest produktem z elementami cyfrowymi sprzedawanym w UE.
- **Od 11 września 2026** obowiązuje zgłaszanie aktywnie wykorzystywanych podatności i poważnych incydentów (ENISA / CSIRT; wczesne ostrzeżenie w ciągu 24 h). Dotyczy produktów już na rynku.
- **Od 11 grudnia 2027** pełne wymagania: bezpieczeństwo w fazie projektowania, obsługa podatności, SBOM, deklarowany okres wsparcia, dokumentacja techniczna, ocena zgodności i oznakowanie CE.

Co wbudowujemy od początku:
- SBOM generowany w CI dla każdego wydania.
- Polityka zgłaszania podatności (kontakt, `SECURITY.txt`/strona) i wewnętrzny proces triage.
- Mechanizm aktualizacji bezpieczeństwa i deklarowany okres wsparcia (`DECISIONS.md` O9). Sprawdzanie aktualizacji z komunikatem w UI (D15) informuje administratora o wersjach z poprawkami bezpieczeństwa.
- Bezpieczne ustawienia domyślne (brak kont domyślnych, TLS, minimalne uprawnienia).
- Dokumentacja techniczna i instrukcja bezpiecznej instalacji dla klienta.

Klasyfikację produktu (domyślny / ważny / krytyczny) i ścieżkę oceny zgodności trzeba potwierdzić przed sprzedażą.

## RODO

- Dane zużycia energii konkretnego gospodarstwa domowego są danymi osobowymi (pozwalają wnioskować o obecności i zwyczajach mieszkańców).
- Dane pozostają na serwerze klienta. Produkt domyślnie **nie wysyła telemetrii** do producenta oprogramowania. Jedynym domyślnym połączeniem wychodzącym jest pobranie manifestu wersji (D15) — bez danych instalacji i identyfikatorów; serwer producenta może jednak widzieć adres IP klienta, co opisujemy w informacji o przetwarzaniu.
- Gdy serwer prowadzi instalator dla wielu klientów, instalator jest zwykle administratorem lub podmiotem przetwarzającym — potrzebne są wzory umów i informacji dla klientów końcowych.
- Funkcje: eksport danych instalacji, usunięcie instalacji wraz z danymi, retencja, minimalizacja danych w logach.

## Nazwa handlowa

- **Solargraf** — oprogramowanie Enphase Energy do projektowania instalacji PV i ofert, sprzedawane m.in. w Niemczech i Austrii.
- **SolarFlow** (makiety) — linia magazynów energii Zendure; w USA zgłoszony jest znak SOLARFLOW na falowniki i baterie.

Obie nazwy pozostają wyłącznie roboczymi. Przed jakimkolwiek materiałem sprzedażowym: wybór nowej nazwy, wyszukiwanie w EUIPO (TMview) i UPRP w klasach 9 i 42, sprawdzenie domen. Branding w UI trzymamy w jednym miejscu, by łatwo go zmienić.

## Licencjonowanie produktu

- Podpisany plik licencji weryfikowany offline (szczegóły w `SECURITY.md`).
- Zakres licencji (liczba instalacji, okres aktualizacji, edycje) — `DECISIONS.md` O5.
- Kod Pythona da się odczytać z obrazu; ochrona opiera się głównie na umowie licencyjnej. Kompilacja wybranych modułów (np. Nuitka, Cython) jest opcją do oceny kosztu w P7.
