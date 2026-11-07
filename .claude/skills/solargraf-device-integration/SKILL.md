---
name: solargraf-device-integration
description: Bezpiecznie projektuje sterowniki i profile urządzeń SolarGraf (falowniki, liczniki, baterie/BMS, bramki) wraz z symulatorem, bez wymyślania rejestrów, OID ani endpointów i bez kopiowania kodu copyleft.
---

# Integracje urządzeń

Ta umiejętność jest obowiązkowa przy dodawaniu źródła danych. Architektura: `docs/ARCHITECTURE.md` (sekcje o agencie, sterownikach i profilach).

## Zanim napiszesz kod

Zbierz:
- dokładny producent, model i firmware (albo zakres, którego dotyczy dokumentacja);
- protokół i transport (Modbus TCP/RTU, Solarman V5, SunSpec, HTTP/JSON, MQTT);
- dokumentację producenta lub standard, z wersją — i warunki jej użycia;
- limity: liczba jednoczesnych klientów, minimalny interwał, maksymalny blok rejestrów;
- sposób uwierzytelniania (jeśli jest);
- listę parametrów wymaganych przez dashboard.

Utwórz tabelę:
`metryka | urządzenie | rejestr/endpoint | typ | kolejność bajtów/słów | jednostka | skala | dokument źródłowy | status`.

Statusy punktu danych: `VERIFIED`, `PARTIALLY_VERIFIED`, `UNVERIFIED`, `UNSUPPORTED`. Nie przedstawiaj wartości `UNVERIFIED` jako gotowej funkcji.

## Licencje

- Nie kopiuj kodu, profili YAML/JSON ani tabel rejestrów z projektów GPL/AGPL/LGPL (np. integracji Home Assistant, `huawei-solar`). Źródłem jest dokumentacja producenta lub standard.
- Nowa zależność tylko z licencją z listy w `docs/COMPLIANCE.md`.

## Implementacja

- Nowa marka na istniejącym transporcie = nowy profil, nie nowy kod. Kod sterownika dodawaj tylko dla nowego transportu.
- Agent jest jedynym klientem urządzenia; jedno połączenie na urządzenie fizyczne.
- Sterownik nie zawiera logiki UI ani obliczeń KPI.
- Timeouty, ograniczona współbieżność, retry z backoff dla błędów przejściowych; parametry z profilu.
- Rozróżniaj timeout, odrzucenie połączenia, błąd protokołu, niepoprawną odpowiedź i brak parametru.
- Waliduj zakresy i jednostki; zachowaj źródłowy timestamp tylko, jeśli jest wiarygodny.
- Zapisuj `observed_at`, `received_at`, `quality`, `origin` i wynik `PollingRun`.
- Nigdy nie zamieniaj braku odczytu na zero.
- MVP: brak operacji zapisu do urządzenia.
- Nie loguj sekretów ani pełnych payloadów z danymi poufnymi.

## Testy

- Walidacja schematu profilu.
- Testy dekodowania z fixture (typ, skala, znak, kolejność słów).
- Symulator generowany z profilu; testy agenta na symulatorze z wstrzykiwaniem błędów (timeout, drugi klient, błędna odpowiedź, reset licznika).
- Test sprzętowy tylko z potwierdzonym modelem/firmware; nie udawaj, że symulator jest testem sprzętowym.
- Poziom wsparcia profilu: `COMMUNITY` po testach na symulatorze, `VERIFIED` dopiero po teście sprzętowym.

## Discovery

Automatyczne wykrywanie jest dozwolone tylko tam, gdzie definiuje je protokół (np. modele SunSpec) i tylko w podsieci zatwierdzonej przez administratora. Nie zgaduj semantyki nieopisanych rejestrów. Zadaj pytanie, jeśli dokumentacja jest niedostępna.
