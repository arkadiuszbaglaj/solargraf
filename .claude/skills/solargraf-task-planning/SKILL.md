---
name: solargraf-task-planning
description: Planuje małe, weryfikowalne zadania dla SolarGraf, rozpoznaje blokujące niewiadome i definiuje kryteria akceptacji przed implementacją.
---

# Planowanie zadania SolarGraf

Użyj tej umiejętności, gdy zadanie jest nowe, obejmuje kilka plików albo wymaga decyzji architektonicznej.

1. Odczytaj `CLAUDE.md`, właściwy fragment `ROADMAP.md` oraz odpowiednią dokumentację domenową.
2. Sprawdź aktualny kod i Git; nie zakładaj, że dokumentacja opisuje już zaimplementowany stan.
3. Sformułuj jeden mierzalny rezultat i kryteria akceptacji.
4. Wypisz zależności i ryzyka.
5. Jeżeli niewiadoma może zmienić architekturę, bezpieczeństwo, koszty lub semantykę pomiarów, zadaj pytanie przed kodowaniem.
6. Proponuj najmniejszy kompletny pionowy wycinek.
7. Wskaż pliki, które najprawdopodobniej będą zmienione, ale nie twórz plików tylko dlatego, że znalazły się na liście.
8. Po implementacji sprawdź testy i diff, a następnie zaktualizuj `docs/WORKLOG.md`.

## Format planu

- Cel
- Kryteria akceptacji
- Pliki/moduły do sprawdzenia
- Plan maksymalnie 5–7 kroków
- Testy
- Pytania blokujące
