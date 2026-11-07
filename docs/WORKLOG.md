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

## Szablon kolejnego wpisu

- Data:
- Etap:
- Zmiany:
- Testy uruchomione i wyniki:
- Decyzje zatwierdzone:
- Ryzyka / rzeczy nieweryfikowane:
- Następne małe zadanie:
