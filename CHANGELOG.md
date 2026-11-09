# Zmiany

Sekcja `## X.Y.Z` jest opisem wydania na GitHubie i w podpisanym manifeście (D67) — widzi go
właściciel instalacji w Ustawienia → Aktualizacje. Najwyżej 2000 znaków na wersję. Nową sekcję
dodaje się w tym samym PR co podniesienie wersji (`tools/release.py version X.Y.Z`).

## 0.9.0

- Nowy alarm „Niepełne odczyty”: ostrzega, gdy urządzenie odpowiada, ale przez ostatnie 15 minut każdy odczyt pomijał część parametrów (np. zły profil albo adres).
- Panel urządzenia: sekcja „Jakość odczytów (24 h)” — ile odczytów było pełnych, częściowych i nieudanych, jaki procent parametrów odczytano poprawnie oraz 5 ostatnich błędów z godziną.
- Strona „Alarmy”: właściciel i administrator mogą przeglądać historię z 7, 30, 90 dni albo roku; filtry stanu i priorytetu oraz przycisk „Pokaż więcej” dla długich list. Podgląd (VIEWER) widzi nadal ostatnie 24 h.

## 0.8.1

- Agent odrzuca odczyty fizycznie niemożliwe (np. napięcie 6553,5 V, częstotliwość 0 Hz, temperatura 200 °C): taka wartość jest zapisywana jako niewiarygodna i nie trafia na wykresy ani do wskaźników. Wcześniej sprawdzany był tylko poziom naładowania magazynu.
- Wykres „Produkcja i zużycie dziś” na telefonie: legenda w jednym wierszu, bez nachodzenia na godziny.

## 0.8.0

- Nowa zakładka „Alarmy”: podsumowanie (krytyczne i ostrzeżenia aktywne, niepotwierdzone, zamknięte w 24 h), filtry stanu i priorytetu oraz lista z potwierdzaniem.
- Nowa zakładka „Raporty” (właściciel i administrator): bilans energii instalacji za miesiąc albo rok — produkcja PV, zużycie, pobór i oddanie do sieci, magazyn, autokonsumpcja i samowystarczalność, wykres i tabela dzień po dniu lub miesiąc po miesiącu. Brak danych jest pokazany jako „—”, nigdy 0. Raport można pobrać jako CSV (Excel) albo wydrukować / zapisać do PDF.
- Karty bieżących wartości na telefonie: mniejsza wartość i etykiety, które nie rozpychają strony.

## 0.7.2

- Nowy układ pulpitu: karty bieżących wartości na górze, pod nimi przepływ energii, wykres dnia i urządzenia, niżej szczegóły instalacji i alarmy. Panele w rzędzie mają równą wysokość; na telefonie karty układają się po dwie w rzędzie.
- Karty bieżących wartości są czytelniejsze: większa wartość, krótsze opisy, wiek odczytu zawsze na dole karty.
- Temperatura wyświetla się w °C (zamiast „degC”), a liczniki bez pustej jednostki.
- Wynik „Testuj połączenie”: oznaczenie SIMULATED tylko przy odczytanych danych; gdy nic nie odczytano, krótki komunikat zamiast pustej tabeli; zajęty adres lub nieznany profil jako „Test nie został wykonany”.

## 0.7.1

- Sprzątanie po aktualizacji usuwa także osierocone obrazy aplikacji (tylko z etykietą produktu — obrazy innych programów na serwerze zostają) i podaje, ile miejsca odzyskano.
- Ustawienia → Stan serwera pokazuje wynik ostatniej aktualizacji i odzyskane miejsce; Ustawienia → Aktualizacje dopisuje je przy wyniku.

## 0.7.0

- Kreator dodania urządzenia w trzech krokach: profil i adres, test komunikacji, nazwy i zapis. Przycisk „Testuj połączenie” zleca agentowi jednorazowy odczyt urządzenia pod podanym adresem i pokazuje wynik: czy połączenie działa, przyczynę błędu i odczytane wartości. Test niczego nie zapisuje do urządzenia ani do historii (D72).
- Panel „Magazyn” pokazuje szacunkowy czas do pełnego naładowania albo do rozładowania przy obecnej mocy (bez rezerwy falownika i strat) (D71).

## 0.6.0

- Nowa zakładka „Urządzenia”: kafle ze stanem urządzeń, wyszukiwarka i filtry typu oraz statusu, a dla wybranego urządzenia bieżące wartości wszystkich parametrów z wiekiem odczytu, wykres z ostatnich 24 godzin, 7 lub 30 dni, dane połączenia i profilu (także wersja firmware i numer seryjny, jeśli są znane) oraz włączanie i wyłączanie odczytu (D70).
- Dodawanie urządzenia otwiera się przyciskiem w tej zakładce; dawny adres listy urządzeń instalacji prowadzi do niej.

## 0.5.2

- Aktualizacja przy braku miejsca na dysku: serwer najpierw sam usuwa cache budowania Dockera; jeśli to nie wystarczy, Ustawienia → Aktualizacje pokazują, ile miejsca jest wolne, ile potrzeba i co można zwolnić — zamiast niejasnego „etap: sprawdzanie wersji”.

## 0.5.1

- Ostrzeżenie o rozjechanym zegarze podaje kierunek różnicy (serwer spieszy się albo spóźnia względem urządzenia) i najpierw radzi sprawdzić automatyczny czas urządzenia; administrator widzi też polecenie sprawdzenia serwera.

## 0.5.0

- Dashboard: zakładki MPPT z wykresem napięcia i prądu stringu, pierścień stanu naładowania i szacunek energii w magazynie, tabela faz sieci z energią pobraną i oddaną dziś, nowe panele „BMS — ogniwa” oraz „Zużycie i samowystarczalność” (D69).
- Nowe metryki urządzeń: prąd faz sieci, temperatura modułów PV, pojemność nominalna baterii, napięcia i temperatury ogniw, liczba cykli. Na razie podaje je symulator; profile sprzętowe po dokumentacji producenta.

## 0.4.1

- Uporządkowana strona Ustawienia → Stan serwera: ocena stabilności obok alarmów, kafle zużycia procesora, pamięci, dysku i temperatury z paskiem w kolorze progów, składniki obok szczegółów systemu; bez powtórzonych wartości.

## 0.4.0

- Alarmy serwera: baner na każdej stronie przy kończącym się dysku, braku pamięci, przegrzaniu, niedoborze napięcia albo niedziałającym składniku; lista z historią i potwierdzaniem w Ustawienia → Stan serwera (D68).
- Wydania publikowane automatycznie z podpisanym manifestem (D67).

## 0.3.0

- Zakładka „Wykresy i historia”: moc PV, zużycia domu, sieci i baterii oraz stan naładowania baterii dla dnia, tygodnia, miesiąca, roku albo własnego zakresu dat (D66).
- Brak danych widoczny jako przerwa w wykresie, nigdy jako zero.

## 0.2.0

- Animacja przepływu energii zależna od mocy (D64).
- Aktualizacja z aplikacji: Ustawienia → Aktualizacje, z kopią zapasową i automatycznym powrotem (D65).

## 0.1.0

- Pierwsze wydanie.
