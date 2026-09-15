# Codzienna obsługa

Procedura operatorska dla `Travian Attack Alert` w wersji `1.0.0` (ID wydania `taa-1.0.0`).

> Uwaga: to jest polski odpowiednik strony `docs/OPERATIONS.md`. Angielska strona `README.md` pozostaje głównym dokumentem. W razie rozbieżności obowiązuje tekst angielski.

Ta strona opisuje codzienną pracę. Konfiguracja, instalacja i fakty o pierwszym skanie znajdują się w angielskim `README.md` (indeks dokumentów: `docs/README.md`).

## Poranna procedura

1. Otwórz dokładną trasę kanoniczną bez zapytania:
   ```text
   https://<twoj-swiat>.travian.com/alliance/profile/members
   ```
2. Otwórz kartę Overview (`taa-tab-overview`) i odczytaj osiem linii statusu: Runtime (`taa-operational-runtime-value`), Route (`taa-operational-route-value`), Session (`taa-operational-session-value`), Lease (`taa-operational-lease-value`), Scan (`taa-operational-scan-value`), Scan detail (`taa-operational-scan-detail-value`), Baseline (`taa-operational-baseline-value`) i Delivery (`taa-operational-delivery-value`).
3. Potwierdź zaakceptowany skan (linia Scan) i ustaloną linię bazową. Pierwszy zaakceptowany skan zatwierdza linię bazową po cichu: `not established — the first accepted scan commits it silently (no historical flood)`.
4. Sprawdź zera kolejki: karta Alerts (`taa-tab-alerts`) pokazuje liczniki nieudanych i niepewnych partii. Oba powinny być zerowe na start dnia. Jeśli nie, patrz [Sprawdzanie kolejki](#sprawdzanie-kolejki).
5. Jeśli Delivery mówi `webhook missing — configuration required; queue preserved`, najpierw ustaw webhook przez menu Tampermonkey (`Set Discord webhook URL`). Wykrycia czekają w kolejce, nic nie ginie.

Jeśli Travian pokazuje stronę logowania, zaloguj się najpierw. Monitor nigdy nie skanuje strony logowania i nigdy nie zmienia tam stanu.

## Aktywne urządzenie, przeglądarka, sesja

Alarmy powstają tylko wtedy, gdy wszystkie poniższe warunki zachodzą jednocześnie:

- Monitor działa na jednym aktywnym urządzeniu. Drugi komputer to drugi nadawca.
- Pracę trzyma jeden profil przeglądarki. Drugi profil wybiera własnego lidera i wysyła duplikaty.
- Jedna sesja pozostaje zalogowana w Travianie. Wygasła sesja zatrzymuje skanowanie.
- Jedna karta znajduje się na stronie kanonicznej. Aktywna karta trzyma dzierżawę Web-Lock i wykonuje pracę; każda inna otwarta karta to gotowościowy widok tylko do odczytu.

Monitorowanie w karcie przeglądarki na komputerze oraz odbieranie wiadomości z alarmami w mobilnej aplikacji Discord to dwie osobne sprawy. Monitorowanie w przeglądarce mobilnej jest nieobsługiwane; odbieranie alarmów w telefonie działa jak zwykle.

## Karty w tle, uśpienie i ograniczanie (uczciwe wyniki)

Co to repozytorium zmierzyło:

- Panel układa się bez przewijania w poziomie przy szerokościach 375 px, 768 px i 1280 px, przy powiększeniu 200% oraz w ścieżkach reduced-motion i forced-colors (macierz Playwright, wszystkie pakiety zielone).
- Monitor napędza cykl przeładowań 60-120 sekund. Próbkowanie zachodzi raz na zaakceptowany cykl dokumentu; zdarzeń, które pojawią się i znikną między dwiema zaakceptowanymi migawkami, nie da się wywnioskować.

Czego NIE udowodniono i dlatego NIE obiecuje się:

- Ograniczanie liczników w tle zależy od przeglądarki i nie jest gwarantowane. To repozytorium nie mierzyło trwałego dostarczania z karty w tle, a zachowanie liczników w zamrożonej lub ograniczonej karcie NIE zostało udowodnione w żadnym menedżerze.
- Nie ma twierdzenia 24/7 ani twierdzenia exactly-once. Dostarczanie jest at-least-once: każde ponowienie może zduplikować.
- Uśpiony laptop, zamrożona karta w tle albo wygasła sesja Traviana zatrzymują skanowanie. Po uśpieniu lub ponownym logowaniu otwórz ponownie trasę kanoniczną i sprawdź Overview, zanim zaufasz alarmom.

Nigdy nie obiecuj ciągłego pokrycia z tła. Jedyny wiarygodny stan to ten, który linie Overview pokazują właśnie teraz.

## Bezpieczne przekazanie innemu operatorowi

Cytowana reguła operatorska:

> one active monitoring installation per alliance/world; a second computer or browser profile WILL double-send; the local lock cannot prevent it.

Przekazuj w tej kolejności:

1. Najpierw wyłącz starego nadawcę (panel Tampermonkey albo wyłączenie dopasowania hosta).
2. Potwierdź ciszę: przez jeden pełny cykl monitora (60-120 s) nie przychodzą żadne nowe wiadomości na Discord. Idź dalej tylko wtedy, gdy udowodniono, że stary nadawca milczy.
3. Włącz nową instalację. Potwierdź pojedynczą aktywną instalację (jeden skrypt, jeden profil przeglądarki, jeden komputer), zanim zaufasz jej alarmom.

Nigdy nie uruchamiaj starego i nowego nadawcy jednocześnie, nawet na chwilę. Dzierżawa Web-Lock odgradza karty tylko wewnątrz jednego profilu przeglądarki.

## Sprawdzanie kolejki

Karta Alerts pokazuje liczniki nieudanych i niepewnych partii. Akcje odzyskiwania znajdują się w menu Tampermonkey:

- Partie nieudane: `Retry failed Discord batches`, po sprawdzeniu konfiguracji webhooka.
- Partie niepewne: `Mark uncertain Discord batches delivered` albo `Retry uncertain Discord batches`. Ponowienie może zduplikować.
- Opróżnianie oczekujących: `Flush pending Discord batches`.
- Debug i historia: `Toggle debug details`, `Load history and health`.

Nieudane znaczy trwale odrzucone (zwykłe 4xx), zachowane do ręcznego rozliczenia. Niepewne znaczy utracone potwierdzenie (zniekształcone lub bez-ID 200), nigdy nieponawiane automatycznie. Oba stany dają się odzyskać; żaden nie jest porzucany po cichu.

## Przeniesienie z linii 6.x

Każdy, kto przenosi prywatny profil 6.2.1 (historyczny rozwój wewnętrzny) do publicznego 1.0.0, postępuje według `docs/MIGRATION-6X.md`. Cytowana kolejność, niepowielona tutaj: wyeksportuj prywatną kopię ustawień na starym nadawcy, wyłącz skrypt 6.x i sprawdź zero wysyłek przez pełny cykl, zainstaluj plik 1.0.0 jako nowy skrypt, zaimportuj plik kopii albo wpisz webhook ręcznie, sprawdź kolejkę, linię bazową i konfigurację w Diagnostics i dopiero wtedy włącz monitorowanie. Podczas przenoszenia nigdy nie czyść danych stron; nigdy nie kopiuj ciasteczek, profili ani danych logowania. Publiczne `1.0.0` jest liczbowo niższe niż prywatne `6.2.1`, więc żaden menedżer nie zaproponuje go jako aktualizacji. Wycofanie to ponowne zaimportowanie poprzedniego pliku `.user.js`, zachowanie danych stron i przeładowanie trasy kanonicznej.

## Aktualizacje

Skrypt ma kanał `@updateURL` wskazujący na surowy plik dist chronionego maina, więc menedżery, które go honorują, aktualizują się automatycznie. Nową wersję można też zastosować, powtarzając kroki instalacji z pliku z `README.md` z nowym plikiem i potwierdzając wersję pokazywaną przez menedżera. Podczas aktualizacji nigdy nie włączaj dwóch nadawców naraz.

Jeśli nowa wersja zachowuje się źle, wycofaj: wyłącz nowy skrypt, zaimportuj ponownie poprzedni plik `.user.js` (albo włącz zachowany stary wpis skryptu), zachowaj wszystkie dane stron w całości (nie czyść magazynu: skład, mapowania, linie bazowe i stan kolejki znajdują się tam), przeładuj trasę kanoniczną i sprawdź, czy monitor wznawia pracę z nienaruszoną kolejką.

## Prywatna kopia zapasowa

Kopia ustawień (`Export settings` / `Import settings`, zwinięta pod `taa-settings-details`) to pełna ścieżka przywracania ustawień: przywraca mapowania, ustawienia, wyciszenia, nazwy, skład i role.

- Domyślny eksport pomija sekret webhooka. Plik nie zawiera sekretu, chyba że go dołączysz.
- Pole opt-in `Include the Discord webhook secret in this file` (`taa-settings-export-webhook`) dołącza sekret w jawnym, czytelnym JSON, z powiadomieniem o jawnym JSON (`taa-settings-export-warning`). Plik opt-in traktuj jak sekret: trzymaj go tam, gdzie tylko Ty masz odczyt, nigdy go nie publikuj, nigdy nie załączaj do zgłoszenia.
- Plik bez pola webhooka zachowuje zapisany webhook przy imporcie (brak znaczy zachowaj, nigdy nie czyść). `{action:"clear"}` czyści jawnie. Nieudany import wycofuje wszystko; odrzucony plik (`invalid-fields`) nie zapisuje niczego.

## Odinstalowanie a usuwanie danych

Usunięcie skryptu i usunięcie jego danych to dwa osobne akty, różnie destrukcyjne:

- Odinstalowanie (usunięcie skryptu): wyłącz lub usuń wpis `Travian Attack Alert` w panelu Tampermonkey. To zatrzymuje skanowanie i wysyłanie. Zapisane kolejka, skład, mapowania i ustawienia zostają na miejscu, dopóki jawnie ich nie usuniesz.
- Usunięcie danych (osobny jawny akt): wyczyść magazyn skryptu dla tej tożsamości (webhook, konfiguracja, mapowania) oraz site localStorage dla pochodzenia Traviana (skład, linie bazowe, kolejka, diagnostyka). OSTRZEŻENIE: to niszczy jedyne możliwe do odzyskania kopie składu, mapowań, linii bazowych i stanu kolejki. Nie ma cofnięcia. Rób to tylko wtedy, gdy chcesz całkowicie porzucić monitorowany stan, nigdy jako krok rozwiązywania problemów.

Nigdy nie czyść danych stron, aby "naprawić" odrzucony skan. Uzupełnij tylko te wartości, których brak udowodniły etykiety `Storage provenance`.

## Rozwiązywanie problemów (najpierw diagnostyka)

Wyeksportuj pakiet incydentu NAJPIERW, zanim dotkniesz czegokolwiek: karta Diagnostics (`taa-tab-diagnostics`), `Export incident bundle` (`taa-incident-bundle-export`). Pakiet jest z konstrukcji ograniczony (512 KiB) i zredagowany: bez webhooka, tokenu, surowego DOM, danych graczy, ładunków kolejki, URL-i, ciasteczek i treści odpowiedzi.

Potem dopasuj swój stan:

- Brak webhooka: Overview Delivery mówi `webhook missing — configuration required; queue preserved`. Ustaw webhook przez menu Tampermonkey. Kolejka jest zachowana, nic nie ginie.
- Zła strona: panel pokazuje bierne wskazówki zamiast stanu skanu. Otwórz dokładną trasę `/alliance/profile/members` bez zapytania.
- Strona logowania: zaloguj się najpierw na stronie Traviana. Monitor nigdy nie skanuje strony logowania i nigdy nie zmienia tam stanu.
- Odrzucenie parsera: karta Players (`taa-tab-players`) pokazuje `Live roster unavailable` z kodem przyczyny (`no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, `malformed-count`). Nie czyść danych stron. Uzupełnij tylko te wartości, których brak udowodniły etykiety `Storage provenance`.
- Partie nieudane: `Retry failed Discord batches` z menu Tampermonkey po sprawdzeniu konfiguracji webhooka.
- Partie niepewne: `Mark uncertain Discord batches delivered` albo `Retry uncertain Discord batches` z menu Tampermonkey. Ponowienie może zduplikować.
- Pomyłka TEST kontra skan: `Send TEST alert to Discord` dowodzi tylko transportu. Czytaj jego informacje dosłownie: `Discord TEST not sent — webhook is not configured. Set it via the Tampermonkey menu. Pending queue preserved.`, `Discord TEST succeeded — transport works. This does not mean the monitor scan works.`, `Discord TEST delivery issue — no acknowledgement. Failed/uncertain recovery stays in the Tampermonkey menu.` Udany TEST obok odrzuconego skanu znaczy, że dostarczanie na Discord działa, a skan monitora nie.
- Nadal nie działa: weź wyeksportowany pakiet do szablonu incydentu niżej.

## Szablon incydentu (bez sekretów)

Skopiuj te pola do zgłoszenia. Załącz zredagowany pakiet incydentu. NIGDY nie dołączaj URL webhooka ani tokenu, ciasteczek, haseł, surowego HTML strony, ładunków kolejki ani danych graczy ponad to, co pakiet już zawiera w formie zredagowanej.

- Wersja skryptu (na przykład `1.0.0`).
- Wersja przeglądarki i wersja menedżera skryptów (na przykład wersja Tampermonkey).
- Kroki odtworzenia (jaka strona, jaki stan kart, co kliknięto, po kolei).
- Czego oczekiwałeś.
- Co stało się zamiast (dokładne linie statusu i kody przyczyn, cytowane).
- Zredagowany pakiet incydentu załączony (tak albo nie).

## Uwaga o wersji

Ta strona dokumentuje `1.0.0` (`taa-1.0.0`). Wcześniejsze zachowanie z ery 6.2.1 (historyczny rozwój wewnętrzny) nie jest częścią kontraktu tego kandydata.
