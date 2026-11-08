# Bezpieczeństwo

Model zagrożeń: aplikacja działa w sieci LAN klienta lub jest dostępna przez VPN. Sieć domowa **nie** jest strefą zaufaną — inne urządzenia w niej mogą być skompromitowane, a protokoły falowników (np. Modbus TCP) nie mają uwierzytelniania.

## Podstawowe wymagania

- Nie commituj `.env`, tokenów, haseł, kluczy prywatnych (w tym klucza podpisującego licencje) ani zrzutów zawierających dane poufne.
- Udostępniaj tylko niezbędne porty; baza danych nie jest dostępna spoza sieci Docker.
- Kontenery jako użytkownik nieuprzywilejowany, z systemem plików tylko do odczytu tam, gdzie to możliwe.
- Waliduj wszystkie dane wejściowe API, partie od agentów i konfiguracje urządzeń.
- Ogranicz rozmiar żądań, zakres czasu i liczbę rekordów.
- Ustaw timeouty dla połączeń do urządzeń i do serwera.
- Sekrety i pełne konfiguracje połączeń nie mogą pojawiać się w logach.
- Zależności skanuj w CI (podatności i licencje) i aktualizuj kontrolowanie.
- Logi audytowe nie zawierają nadmiarowych danych osobowych.

## Uwierzytelnianie i autoryzacja

- Logowanie wymagane także w LAN. Brak kont domyślnych ze stałym hasłem — pierwsze konto administratora tworzone przy instalacji.
- Hasła hashowane algorytmem przeznaczonym do haseł (np. Argon2id); limit prób logowania.
- Sesje w bezpiecznych cookies (`HttpOnly`, `Secure`, `SameSite`) z ochroną CSRF dla żądań modyfikujących.
- Role przypisane do organizacji i instalacji (`DATA_MODEL.md`). Autoryzacja sprawdzana po stronie serwera dla każdego zasobu instalacji; nie ufamy `site_id` z żądania.
- Testy izolacji: użytkownik jednej organizacji nie może odczytać ani zmodyfikować danych innej.

## TLS i dostęp zdalny

- HTTPS także w LAN: Caddy z lokalnym CA (certyfikat CA instalowany na urządzeniach użytkowników) albo certyfikat dostarczony przez VPN (np. Tailscale). Wybór do potwierdzenia w P7.
- Dostęp spoza domu wyłącznie przez VPN (WireGuard lub Tailscale). Przekierowanie portu w routerze nie jest wspieraną metodą — dokumentacja produktu ma to wprost mówić.
- Nagłówki bezpieczeństwa (CSP, HSTS po włączeniu TLS, `X-Content-Type-Options`, `Referrer-Policy`).

## Agenci

- Każdy agent ma własne poświadczenie (token lub certyfikat), przechowywane na serwerze jako skrót, z możliwością odwołania i rotacji.
- Agent łączy się wychodząco; serwer nie inicjuje połączeń do lokalizacji klientów.
- Ingest przyjmuje dane tylko dla urządzeń przypisanych do danego agenta.
- Bufor lokalny agenta nie przechowuje sekretów w postaci jawnej, jeśli nie jest to konieczne.

## Urządzenia w sieci lokalnej

- Nie wystawiaj interfejsów falownika/BMS do Internetu.
- Nie pozwalaj, by dowolny użytkownik podał arbitralny adres IP/URL do odpytywania — ryzyko SSRF i skanowania sieci. Adresy urządzeń zatwierdza administrator organizacji.
- Wykrywanie urządzeń (skan, mDNS) tylko w podsieci zatwierdzonej przez administratora i tylko na żądanie.
- Odczyt oddzielony od sterowania. Sterowanie jest wyłączone w MVP; sterowniki w MVP nie implementują operacji zapisu.
- Jeśli urządzenie udostępnia tylko niezabezpieczony protokół lokalny, zalecamy izolację sieciową (VLAN) i opisujemy ryzyko w dokumentacji klienta.

## Licencja produktu

- Plik licencji podpisany kluczem prywatnym producenta (np. Ed25519), weryfikowany offline kluczem publicznym wbudowanym w aplikację.
- Klucz prywatny nigdy nie trafia do repozytorium ani obrazów.
- Brak ważnej licencji nie może powodować utraty danych klienta — tylko ograniczenie funkcji (do ustalenia w O5).

## Sprawdzanie aktualizacji

- Jedyne domyślne połączenie wychodzące do Internetu — tylko do skonfigurowanego adresu manifestu, przez HTTPS, z timeoutem i limitem rozmiaru.
- Manifest wersji jest podpisany; podpis weryfikujemy niezależnie od TLS. Klucz prywatny do podpisu manifestu nigdy nie trafia do repozytorium ani obrazów i jest inny niż klucz licencji.
- Treść manifestu (opis zmian, adresy) traktujemy jako dane: wyświetlana bez interpretacji HTML, odnośniki tylko do zatwierdzonej domeny producenta.
- Żądanie nie zawiera danych instalacji ani identyfikatorów; nie wysyłamy telemetrii.
- Wyłączenie automatycznego sprawdzania musi być możliwe (serwery bez Internetu, polityka klienta).
- System tylko informuje o nowej wersji; nie pobiera ani nie uruchamia kodu.

## Monitor serwera

- Widok „Stan serwera” i jego API tylko dla administratora — ujawnia informacje o infrastrukturze.
- Kontenery aplikacji **nie** dostają gniazda Dockera. Metryki hosta odczytujemy z `/proc` i `/sys` zamontowanych tylko do odczytu.
- W odpowiedziach nie zwracamy listy procesów hosta, zmiennych środowiskowych ani ścieżek z sekretami.

## Instalator

- Skrypt serwowany wyłącznie przez HTTPS z domeny producenta; obok publikowane suma SHA-256 i podpis, a instrukcja opisuje ścieżkę „pobierz → zweryfikuj → uruchom”.
- Skrypt zabezpieczony przed częściowym pobraniem (cała logika w funkcji wywoływanej na końcu pliku), z `set -euo pipefail`.
- Wersje obrazów pochodzą z podpisanego manifestu; obrazy przypięte po digest, nie po tagu `latest`.
- Sekrety generowane lokalnie z bezpiecznego źródła losowości, zapisywane z uprawnieniami `600`, nigdy nie wypisywane na ekran ani do logu.
- Brak kont i haseł domyślnych: pierwsze konto administratora przez jednorazowy, ograniczony czasowo link.
- Instalator nie otwiera portów w routerze i nie wyłącza zapory; informuje o wymaganych portach w LAN.
- Docker instalowany tylko z oficjalnego repozytorium i po potwierdzeniu (chyba że `--yes`).

## Skrypt aktualizacji i sprzątanie

- Skrypt działa na hoście z uprawnieniami administratora; jego operacje są logowane.
- Usuwa wyłącznie obrazy i pliki z etykietą/katalogiem produktu. Zakaz `docker system prune -a`, `--volumes` i usuwania wolumenów.
- Sprzątanie tylko po udanych health checks; zawsze zostaje poprzednia wersja do rollbacku (D73).
- Tryb `--dry-run` do podglądu przed usunięciem.

## Kopie zapasowe

- Określ RPO/RTO przed wdrożeniem produkcyjnym.
- Automatyczny backup bazy przed każdą migracją oraz cykliczny; szyfrowanie kopii zawierających dane osobowe.
- Przetestuj odtworzenie — sam sukces zadania backupu nie wystarcza.
- Ustal retencję kopii i procedurę bezpiecznego usuwania.

## Podatności i incydenty

- Proces obsługi podatności i zgłoszeń wymagany przez CRA opisuje `COMPLIANCE.md`.
- Dokumentuj procedurę rotacji poświadczeń, wyłączenia integracji lub agenta, odtworzenia bazy i powrotu do poprzedniej wersji.
- Nie wykonuj destrukcyjnych operacji bez zgody operatora.
