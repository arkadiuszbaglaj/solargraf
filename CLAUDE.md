# SolarGraf — instrukcje dla Claude Code

SolarGraf to **nazwa robocza**. Nie używaj jej w materiałach sprzedażowych, dopóki nie zostanie zatwierdzona nazwa handlowa (patrz `docs/COMPLIANCE.md`).

## Zasady nadrzędne

- Przed zmianą przeczytaj odpowiednie pliki i sprawdź rzeczywisty stan repozytorium. Nie zgaduj zawartości nieotwartych plików.
- Jeśli decyzja wpływa na architekturę, bezpieczeństwo, koszty, dane, licencje lub kompatybilność urządzeń i nie wynika z dokumentacji, **zadaj pytanie i zaczekaj**. Nie maskuj założeń jako faktów.
- Przy małych, odwracalnych zadaniach działaj samodzielnie. Przy decyzjach nieodwracalnych, destrukcyjnych lub zewnętrznych uzyskaj zgodę.
- Implementuj najmniejszy kompletny pionowy wycinek. Nie dodawaj funkcji „na zapas”.
- Nie używaj fikcyjnych danych, OID, endpointów, rejestrów Modbus, możliwości firmware ani statusów urządzeń.
- Brak pomiaru to `null`/brak danych z jakością i timestampem, nigdy automatyczne `0`.
- Dane demo i symulowane muszą być wyraźnie oznaczone (`DEMO` / `SIMULATED`) i odseparowane od produkcyjnego źródła danych.
- Nie usuwaj ani nie osłabiaj testów, aby uzyskać zielony wynik.
- Nie dodawaj zależności bez uzasadnienia i bez sprawdzenia licencji (patrz niżej). Przed dodaniem dużej biblioteki przedstaw koszt i alternatywę.
- Nie uruchamiaj `git push`, destrukcyjnych migracji, usuwania danych ani poleceń zewnętrznych bez wyraźnej zgody.
- Nigdy nie zapisuj sekretów, haseł, tokenów, kluczy licencyjnych ani prywatnych adresów/poświadczeń w kodzie, testach, dokumentacji lub logach.

## Produkt komercyjny — licencje

- Produkt jest zamknięty i sprzedawany na licencji. Dozwolone są tylko zależności o licencjach permisywnych: MIT, BSD, Apache-2.0, ISC, PSF, PostgreSQL, Zlib.
- GPL, AGPL, LGPL, SSPL, BSL, Timescale License i inne licencje „source-available” — **zakaz** bez pisemnej zgody właściciela projektu.
- Nie kopiuj kodu, profili urządzeń (YAML/JSON) ani tabel rejestrów z projektów copyleft. Mapy rejestrów buduj z dokumentacji producenta i zapisuj źródło.
- Licencję każdej nowej zależności sprawdź w momencie dodawania (repozytorium/PyPI/npm) i odnotuj w PR. Szczegóły: `docs/COMPLIANCE.md`.

## Cykl pracy

1. Ustal cel i kryteria akceptacji.
2. Przejrzyj tylko pliki i obszary potrzebne do zadania.
3. Jeśli są niejasności krytyczne, zadaj krótkie, numerowane pytania.
4. Przed zmianą wieloplikową przedstaw plan.
5. Zaimplementuj najmniejszy spójny zakres.
6. Uruchom formatowanie, lint, typecheck i odpowiednie testy.
7. Sprawdź `git diff` i szukaj niezamierzonych zmian.
8. Zaktualizuj dokumentację tylko wtedy, gdy zmienił się kontrakt, decyzja lub sposób uruchomienia.
9. Podsumuj zmiany, testy i pozostałe ryzyka. Nigdy nie twierdź, że test przeszedł, jeśli go nie uruchomiono.

## Standardy kodu

**Backend i agent (Python):**
- Pełne typowanie i `mypy --strict`; `ruff` jako linter i formatter; testy w `pytest`.
- Walidacja danych na granicach systemu (API, konfiguracja, odpowiedzi urządzeń) przez modele Pydantic.
- I/O asynchroniczne; każda operacja sieciowa ma timeout i jawne zachowanie błędów.

**Frontend (React):**
- TypeScript strict; unikaj `any`. Typy danych API generowane z kontraktu OpenAPI albo walidowane.
- Semantyczny HTML, obsługa klawiatury i widoczny focus.

**Wspólne:**
- Oddzielaj UI, logikę domenową, dostęp do danych i adaptery urządzeń.
- Daty przechowuj jako timestamp UTC; UI prezentuje czas strefy skonfigurowanej dla instalacji.
- Jednostki są jawne i normalizowane; nie mieszaj W z kW ani Wh z kWh.
- Testuj obliczenia energetyczne i przypadki brzegowe niezależnie od UI.
- Nie ujawniaj szczegółów urządzeń i sekretów w komunikatach błędów dla użytkownika.

## Zasady architektury, których nie łamiemy

- **Agent jest jedynym klientem urządzenia.** API i UI nigdy nie łączą się z falownikiem/BMS bezpośrednio.
- **Każdy zasób należy do instalacji (site).** Każdy odczyt i zapis sprawdza po stronie serwera uprawnienia użytkownika do tej instalacji.
- **MVP tylko odczytuje dane.** Zapis do urządzeń (sterowanie) wymaga osobnej decyzji.

## Pytania i decyzje

Zatwierdzone decyzje są w `docs/DECISIONS.md`. Zadawaj pytania przed implementacją, jeśli nieznane są: docelowe urządzenia/protokół, definicja KPI, uprawnienia ról, retencja, strefa czasowa lub zachowanie sterujące urządzeniami. Pytania grupuj w jednej krótkiej wiadomości i podawaj rekomendację wraz z konsekwencjami.

## Tokeny i kontekst

- Nie streszczaj ponownie całej dokumentacji w każdej odpowiedzi.
- Zacznij od `CLAUDE.md`, następnie otwórz tylko dokumenty istotne dla bieżącego zadania.
- Korzystaj z istniejących komponentów i wzorców; nie twórz równoległych implementacji.
- Preferuj małe PR-y i małe zadania o jednoznacznym wyniku.
- Przed końcem sesji aktualizuj `docs/WORKLOG.md` tylko o decyzje, postęp, testy i następny krok, nie o pełny zapis rozmowy.
- Używaj umiejętności z `.claude/skills/`, gdy zadanie pasuje do ich zakresu.
