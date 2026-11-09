# Licencjonowanie produktu — projekt (do zatwierdzenia)

Status: **projekt, niewdrożony** (2026-11-09). Rozwija O5 z `DECISIONS.md`. Decyzje oznaczone
„do zatwierdzenia” mają rekomendację, ale nie są przyjęte — przed implementacją trafią do
`DECISIONS.md` jako decyzja D-x. Zasady nadrzędne: `SECURITY.md` (plik licencji podpisany,
weryfikowany offline; brak licencji nie powoduje utraty danych) i `COMPLIANCE.md`.

## Przebieg dla klienta

1. Instaluje oprogramowanie — przy pierwszym uruchomieniu rusza 30-dniowy okres próbny.
2. Zakłada konto na stronie producenta i opłaca licencję.
3. Dostaje kod aktywacyjny (16 znaków) i może pobrać plik licencji.
4. W panelu aplikacji wpisuje kod albo wgrywa plik.

## Dlaczego kod i plik

Kod 16-znakowy jest za krótki, żeby zawierał podpis (Ed25519: 64 bajty), więc aplikacja nie
może go zweryfikować offline. Sprawdzanie kodu sekretem wbudowanym w aplikację nie chroni —
kod Pythona da się odczytać z obrazu i zbudować generator kodów. Obie drogi kończą się więc tym
samym podpisanym plikiem licencji:

| Droga | Przebieg | Warunek |
|---|---|---|
| Kod (online) | Użytkownik wpisuje `XXXX-XXXX-XXXX-XXXX`; serwer klienta wysyła do API producenta tylko kod, identyfikator instalacji i wersję aplikacji; producent odsyła podpisany plik, aplikacja go zapisuje. | Dostęp serwera klienta do Internetu. |
| Plik (offline) | Na stronie producenta użytkownik podaje identyfikator instalacji (z panelu, także jako kod QR), pobiera plik `.sglic` i wgrywa go w panelu. | Brak — także sieć izolowana. |

Po aktywacji licencja działa offline; aplikacja nie wymaga cyklicznego kontaktu z producentem.

## Okres próbny

- Przy pierwszym starcie serwer tworzy losowy **identyfikator instalacji** (UUID) i zapisuje
  w bazie początek próby (UTC). Próba liczy się od pierwszego uruchomienia, nie od dodania
  urządzenia. Długość: 30 dni.
- Pełna funkcjonalność; baner z liczbą pozostałych dni (wyraźniejszy w ostatnich 7 dniach).
- Ochrona przed cofnięciem zegara: aplikacja pamięta najpóźniejszy widziany czas (także czasy
  pomiarów); cofnięcie zegara nie przedłuża próby.
- Świadome ograniczenie: próbę da się „odnowić” tylko przez usunięcie bazy, czyli utratę danych.
  Pełna ochrona wymagałaby rejestracji próby online — sprzeczne z pracą offline.

## Plik licencji

JSON podpisany Ed25519 **osobnym kluczem licencji** (innym niż klucz manifestu wydań, D63),
z identyfikatorem klucza `kid` (rotacja). Zawartość:

- `license_id`, nazwa klienta lub firmy (bez adresu i e-maila), `installation_id`;
- edycja i limity (np. liczba instalacji — site — i urządzeń);
- `issued_at`, `expires_at` (`null` = bezterminowa), `updates_until`.

Weryfikacja wyłącznie po stronie serwera: podpis, `installation_id`, daty, limity. Plik
z błędnym podpisem albo innej instalacji jest odrzucany z czytelnym komunikatem.

## Panel „Ustawienia → Licencja” (tylko OWNER)

- Stan: próba (zostało N dni) / aktywna / wygasła / nieważna.
- Identyfikator instalacji (kopiuj, kod QR).
- Pole kodu, wgranie pliku (limit rozmiaru), szczegóły licencji (edycja, limity, ważność,
  aktualizacje do).
- Aktywacja i wgranie pliku zapisywane w dzienniku audytu; kod nie trafia do logów.

## Po wygaśnięciu próby lub licencji — do zatwierdzenia

Rekomendacja: agent dalej odczytuje urządzenia i serwer zapisuje pomiary (bez dziur w historii);
UI przechodzi w tryb ograniczony — dostępne: ekran licencji, stan bieżący i eksport danych;
zablokowane: historia, raporty, dodawanie urządzeń — do aktywacji. Żadne dane nie są usuwane.

## Aktualizacje

Manifest wydania ma datę wydania. Wersja wydana po `updates_until` nie jest instalowana — panel
Aktualizacje pokazuje „wymaga przedłużenia aktualizacji”; obecna wersja działa dalej.

## Strona producenta (osobny system)

Poza tym repozytorium: konta klientów, płatności (np. Przelewy24 / Stripe), generowanie kodów,
API aktywacji (kod → plik dla `installation_id`, limit aktywacji na kod, przeniesienie licencji
na nowy serwer, np. 2 razy w roku). Klucz prywatny licencji tylko u producenta (sejf kluczy),
nigdy w repozytorium ani obrazach. Wymaga domeny (O13).

## Etapy

1. **Aplikacja, offline:** identyfikator instalacji i licznik próby, model stanu licencji,
   baner, panel Licencja, wgrywanie i weryfikacja pliku, tryb ograniczony; narzędzie
   `tools/issue_license.py` do ręcznego wystawiania plików (klucz ze zmiennej środowiskowej).
   Po tym etapie sprzedaż jest możliwa z ręcznie wystawianymi plikami.
2. **Aktywacja kodem:** klient API w aplikacji i kontrakt API producenta (timeout, limit
   rozmiaru, tylko HTTPS do domeny producenta).
3. **Strona producenta:** konta, płatności, wydawanie kodów (osobne repozytorium).
4. **Licencja a aktualizacje:** `updates_until` w panelu Aktualizacje.

## Decyzje do zatwierdzenia

1. **Format kodu** — rekomendacja: 16 znaków alfanumerycznych (Crockford Base32, ok. 80 bitów,
   z sumą kontrolną na literówki) zamiast samych cyfr (ok. 53 bity); kod online, plik offline.
2. **Zakres blokady po wygaśnięciu** — rekomendacja jak w sekcji wyżej.
3. **Model sprzedaży** — rekomendacja: licencja bezterminowa na serwer + rok aktualizacji,
   płatne przedłużenie; alternatywa: subskrypcja roczna, po niej tryb ograniczony.
4. **Limity** — rekomendacja: liczba instalacji i urządzeń na serwer (edycje, np. Dom / Firma).
5. **Strona producenta** — kto buduje i na jakiej domenie; rekomendacja: osobne repozytorium
   po etapie 1.
