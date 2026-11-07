---
name: solargraf-quality-review
description: Wykonuje ukierunkowany przegląd zmian SolarGraf pod kątem błędów, bezpieczeństwa, izolacji instalacji, licencji, jakości danych, testów i niezamierzonego zakresu.
---

# Przegląd jakości

Uruchamiaj po implementacji, przed commitem/PR albo na prośbę o review.

Sprawdź:
- czy wymagania i kryteria akceptacji są spełnione;
- czy kod pasuje do istniejącej architektury (agent jako jedyny klient urządzenia, brak logiki domenowej w UI);
- czy walidacja jest na granicach systemu (API, ingest od agentów, profile, konfiguracja);
- czy autoryzacja obejmuje każdy zasób instalacji i czy są testy izolacji między organizacjami;
- czy brak danych nie jest konwertowany do zera;
- czy jednostki, timestampy, jakość i pochodzenie (`origin`) pomiarów są zachowane;
- czy nie ma fikcyjnych integracji, sekretów, logów wrażliwych lub publicznych portów;
- czy nowe zależności mają licencję z listy w `docs/COMPLIANCE.md` i czy nie skopiowano kodu ani profili z projektów copyleft;
- czy testy sprawdzają zachowanie, a nie tylko implementację, i czy test na symulatorze nie jest opisany jako sprzętowy;
- czy nie usunięto/wyłączono testów ani nie dodano niepotrzebnych zależności;
- czy `git diff` nie zawiera przypadkowych zmian.

Raportuj najpierw błędy w kolejności: krytyczne, wysokie, średnie, niskie. Każde ustalenie wskaż przez plik i konkretny fragment. Jeśli nie ma błędów, zaznacz zakres przeglądu i ograniczenia; nie obiecuj, że kod jest wolny od wszystkich błędów.
