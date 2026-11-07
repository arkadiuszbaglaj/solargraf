# Instrukcja krok po kroku

Kolejność etapów odpowiada `ROADMAP.md`. Polecenia w cytatach są gotowymi promptami dla Claude Code uruchomionego w katalogu `SolarGraf/`.

## Etap 0 — przygotowanie

1. Zainicjuj repozytorium Git w katalogu `SolarGraf/` i wykonaj pierwszy commit dokumentacji.
2. Repozytorium zdalne — prywatne (produkt komercyjny).
3. Zainstaluj Git, aktualny Python (wersja do przypięcia w P0), Node.js LTS (tylko do budowania frontendu), Docker z Compose i Claude Code zgodnie z oficjalną dokumentacją.
4. Makiety z `graf/` traktuj jako referencję układu, nie danych. Zawierają nazwę SolarFlow i sprzeczne wartości (`docs/DATA_MODEL.md`).

## Etap 1 — otwarte decyzje

> Przeczytaj CLAUDE.md i docs/DECISIONS.md. Nie twórz kodu. Zadaj mi jedną grupę krótkich pytań o otwarte decyzje blokujące najbliższy etap (sekcja „Otwarte”), przy każdym podaj rekomendację i konsekwencję. Zapisz zatwierdzone odpowiedzi w docs/DECISIONS.md.

## Etap 2 — fundament repozytorium (P0)

> Zaimplementuj wyłącznie fundament projektu zgodny z docs/DECISIONS.md: strukturę monorepo (server/, agent/, web/, profiles/, deploy/), pyproject z przypiętymi wersjami i lockfile, ruff, mypy --strict, pytest, projekt Vite + React + TypeScript strict z ESLint i Vitest, pre-commit oraz CI z lint, typecheck, testami, kontrolą licencji zależności (lista z docs/COMPLIANCE.md) i generowaniem SBOM. Zapisz dokładne komendy w README. Nie implementuj urządzeń ani obliczeń. Uruchom wszystkie kontrole i pokaż wyniki.

Sprawdź `git diff`, zrób commit, dopiero potem przejdź dalej.

## Etap 3 — szkielet i interfejs statyczny (P1)

> Dodaj Docker Compose dla środowiska developerskiego (api FastAPI z /health, PostgreSQL, Alembic) i zbuduj responsywny layout na podstawie makiet z graf/: sidebar, topbar z przełącznikiem instalacji, KPI, przepływ energii, wykres historii (ECharts), szczegóły PV, magazynu, sieci, status urządzeń i alarmy. Dane wyłącznie z jawnego providera DEMO, z widocznym oznaczeniem. Branding w jednym miejscu. Dodaj stany loading, empty, error i stale oraz testy kluczowych komponentów. Przed implementacją wskaż pliki, które zamierzasz utworzyć.

Zatwierdź wersję desktopową i responsywną przed rozbudową funkcji.

> Przygotuj instalator jedną komendą w wersji 1 zgodnie z docs/ARCHITECTURE.md (sekcja „Instalator jedną komendą”) i docs/SECURITY.md: sprawdzenie wymagań, instalacja Dockera po potwierdzeniu, generowanie sekretów, uruchomienie Compose, health checks, jednorazowy link do pierwszego konta, polecenia install/status/uninstall i --dry-run. Dodaj ShellCheck do CI i test na czystym kontenerze Debiana. Nie publikuj skryptu ani obrazów bez mojej zgody.

## Etap 4 — model danych, wiele instalacji i API (P2)

> Na podstawie docs/DATA_MODEL.md przygotuj modele SQLAlchemy, migracje Alembic (z partycjonowaniem pomiarów po czasie) i API odczytu. Najpierw wskaż niespójności w modelu. Zaimplementuj logowanie, role i autoryzację per instalacja zgodnie z docs/SECURITY.md, walidację wejścia, paginację i filtrowanie dat. Dodaj testy izolacji danych między organizacjami. Brak pomiaru reprezentuj zgodnie z kontraktem, nie jako zero.

## Etap 5 — agent, profile i symulator (P3)

1. Ustal format profilu i walidator (pola z `docs/ARCHITECTURE.md`).
2. Dla pierwszego urządzenia zdobądź dokumentację producenta; sprawdź jej licencję/warunki.
3. Zbuduj tabelę punktów danych przed kodowaniem.
4. Zaimplementuj sterownik, profil, symulator i testy.

> Nie zgaduj rejestrów Modbus, endpointów ani możliwości urządzenia i nie kopiuj profili z projektów open source. Przed kodowaniem przedstaw tabelę: metryka | rejestr/endpoint | typ | jednostka | skala | dokument źródłowy | status. Brak dowodu = UNVERIFIED i pytanie do mnie. Po zatwierdzeniu zaimplementuj agenta w trybie lokalnym (jedno połączenie na urządzenie, timeouty, retry, bufor offline), sterownik, profil, symulator generowany z profilu i testy z wstrzykiwaniem błędów.

## Etap 6 — historia i obliczenia (P4)

> Zaimplementuj tylko te obliczenia, których definicje są zatwierdzone w docs/DECISIONS.md i docs/DATA_MODEL.md. Dodaj agregaty z liczbą próbek i pokryciem. Testuj brakujące próbki, wartości ujemne, reset licznika, zmianę czasu, strefę czasową, niespójny bilans (w tym przykłady z makiet) i nieaktualne dane. Nie interpoluj braków bez jawnej polityki.

## Etap 7 — dashboard na żywo (P5)

> Podłącz dashboard do API i strumienia SSE. Usuń zależność produkcyjnego UI od danych demo. Każdy komponent obsługuje loading, empty, error i stale oraz pokazuje wiek danych. Nie pokazuj urządzenia jako online bez świeżego odczytu. Dodaj testy API i E2E (Playwright) dla głównej ścieżki na danych z symulatora.

## Etap 8 — kolejni producenci (P6)

Dla każdej marki powtórz etap 5. Profil z samym symulatorem ma poziom `COMMUNITY`; `VERIFIED` dopiero po teście na rzeczywistym modelu i firmware.

## Etap 9 — wdrożenie, licencja i zgodność (P7)

> Przejrzyj docs/SECURITY.md, docs/COMPLIANCE.md i docs/TESTING.md. Przygotuj obrazy amd64/arm64, produkcyjny Docker Compose, health checks, skrypt instalacyjny, aktualizację z backupem przed migracją, TLS przez Caddy, weryfikację pliku licencji offline i instrukcję VPN. Nie publikuj obrazów, nie wykonuj wdrożenia zewnętrznego i nie modyfikuj żadnego serwera bez mojej zgody.

## Stały cykl dla każdego zadania

1. Jedno zadanie = jeden rezultat i kryteria akceptacji.
2. Przeczytaj powiązane pliki i aktualny kod.
3. Plan, jeśli zmiana dotyczy kilku modułów.
4. Implementacja minimalnego zakresu.
5. Testy i przegląd diffu.
6. Raport: co zmieniono, jakie testy uruchomiono, co nie jest zweryfikowane.
7. Commit po akceptacji.

## Szablon promptu zadaniowego

> Cel: [jeden rezultat].
> Kontekst: przeczytaj [konkretne pliki].
> Ograniczenia: nie zmieniaj [obszary], nie dodawaj [niepotrzebne funkcje].
> Kryteria akceptacji: [mierzalne warunki].
> Testy: uruchom [konkretne komendy].
> Jeśli brakuje decyzji krytycznej, zadaj pytanie przed implementacją.
> Na końcu podaj zmienione pliki, wyniki testów i pozostałe ryzyka.

Wskazuj konkretne pliki zamiast prosić o streszczenie całego repozytorium. Zadania równoległe tylko wtedy, gdy nie edytują tych samych plików i nie zależą od wspólnych decyzji.

## Kiedy Claude ma pytać, a kiedy nie

Pytaj, jeśli odpowiedź zmienia: model danych lub kontrakt API, wybór biblioteki (i jej licencję), protokół/kompatybilność sprzętu, bezpieczeństwo, retencję, semantykę KPI, operację destrukcyjną albo zewnętrzne wdrożenie.

Nie pytaj o drobne szczegóły, które wynikają z istniejącego wzorca lub są bezpieczne i odwracalne — przyjmij spójne rozwiązanie i opisz je w podsumowaniu. Nie wymuszaj wieloetapowego planu dla drobnej zmiany.

Nie używaj `--dangerously-skip-permissions` jako domyślnego ustawienia; zatwierdzaj operacje destrukcyjne, publikację, push i zmiany infrastruktury.

## Gdy Claude traci kontekst

> Odczytaj CLAUDE.md, ROADMAP.md, docs/WORKLOG.md, ostatnie zmiany Git i testy związane z aktualnym etapem. Nie odtwarzaj całej historii rozmowy. Podsumuj w maksymalnie 8 punktach aktualny stan, otwarte blokery i następne małe zadanie. Nie zmieniaj kodu, dopóki nie potwierdzę planu.
