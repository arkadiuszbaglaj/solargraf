---
name: solargraf-energy-metrics
description: Projektuje i testuje obliczenia energetyczne SolarGraf, jednostki, agregacje i przypadki brakujących lub niespójnych pomiarów.
---

# Metryki energetyczne

Przed implementacją odczytaj `docs/DATA_MODEL.md`.

## Reguły

- Odróżniaj moc chwilową od energii w czasie.
- Używaj jawnych jednostek i testowanych konwersji.
- Dokumentuj wzór, zakres czasu, wymagane wejścia, źródła i zachowanie przy brakach.
- Nie sumuj próbek mocy jako energii.
- Nie zakładaj, że wszystkie urządzenia mają synchroniczne timestampy.
- Brak danych nie jest równoważny zeru.
- Nie interpoluj bez jawnej decyzji i oznaczenia danych jako szacowanych.
- Obsłuż reset/rollover licznika i wartości poza zakresem.
- Nie wyliczaj KPI, jeśli brakuje niezbędnego źródła; zwróć stan niedostępności.

## Wymagane dla każdej nowej metryki

1. Definicja biznesowa i wzór.
2. Jednostka wejściowa/wyjściowa.
3. Wymagane źródła.
4. Semantyka brakujących i nieaktualnych próbek.
5. Testy dla wartości normalnych i brzegowych.
6. Przykład liczbowy niezależnie policzony.
