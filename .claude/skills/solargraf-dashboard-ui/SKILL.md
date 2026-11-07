---
name: solargraf-dashboard-ui
description: Buduje dostępne, responsywne widżety dashboardu SolarGraf (React + TypeScript + ECharts) z poprawnymi stanami ładowania, braku danych, błędu i nieaktualności oraz danymi na żywo przez SSE.
---

# Dashboard UI

Przed zmianami sprawdź istniejące komponenty i design tokens. Nie twórz duplikatów.

## Zasady

- Makiety z `graf/` to referencja układu i hierarchii, nie źródło pomiarów. Mają nazwę SolarFlow i sprzeczne wartości — nie kopiuj ich jako danych.
- Branding (nazwa, logo) pobieraj z jednego miejsca; nazwa jest robocza.
- Projektuj od komponentów wspólnych: panel, KPI, status, wykres, tabela, alarm.
- Każdy widżet obsługuje `loading`, `empty`, `error`, `stale` i dane poprawne.
- Wartość zawsze ma czytelną jednostkę; daty prezentuj w strefie instalacji.
- Dane na żywo z SSE: pokazuj wiek wartości; po przekroczeniu progu świeżości przejdź w stan `stale`.
- Nie pokazuj statusu online bez świeżego potwierdzenia. Utrata agenta to `UNKNOWN`, nie `OFFLINE`.
- Wykresy ECharts: luki jako `null` (brak linii), nie zero ani interpolacja.
- Widżet parametru, którego profil nie dostarcza, jest ukryty albo pokazuje „parametr niedostępny”.
- Dane demo mają widoczny badge `DEMO` i pochodzą z osobnego providera.
- Unikaj animacji sugerujących rzeczywisty przepływ, jeśli aktualne pomiary go nie potwierdzają.
- Responsywność, kontrast, focus klawiatury, semantyczne nagłówki i etykiety są częścią ukończenia.

## Przed zakończeniem

Sprawdź desktop i mały ekran, obsługę klawiatury, stany puste/błędne/nieaktualne, formatowanie jednostek i testy komponentów. Nie deklaruj zgodności pikselowej bez rzeczywistego porównania z makietą.
