# Travian Attack Alert (przewodnik po polsku)

Alarmy o atakach, rajdach i odejściach z sojuszu, z Traviana na Twój własny serwer Discord.

**Wersja 1.0.0, ID wydania `taa-1.0.0`. Kandydat w wersji pilotażowej, nieogłoszony jeszcze publicznie.**

> Uwaga: to jest polski odpowiednik strony `README.md`. Angielska strona `README.md` pozostaje główna. W razie rozbieżności obowiązuje tekst angielski.

Skrypt (`Travian Attack Alert`, przestrzeń nazw `travian-attack-alert-public`) okresowo odczytuje tabelę członków sojuszu na stronie kanonicznej i wysyła alarmy na Discord, gdy pojawią się ataki, rajdy lub odejścia. W przeglądarce nie jest potrzebny żaden bundler, framework ani zależność wykonawcza. Plikiem instalacyjnym jest `dist/travian-attack-alert.user.js`.

## Co robi

- Otwiera tabelę członków sojuszu i robi migawkę liczby ataków i rajdów każdego członka.
- Porównuje nową migawkę z ostatnią zaakceptowaną i wysyła wiadomość na Discord o nowych atakach, rajdach i odejściach.
- W alarmie oznacza skonfigurowane role Discord lub zmapowanych użytkowników, zgodnie z opisaną niżej polityką oznaczeń.
- Ponawia nieudane dostarczenia i zachowuje możliwy do odzyskania stan kolejki, tak aby przerwaną wysyłkę można było rozliczyć z menu.

## Czego NIE robi

- Nie ma backendu. Wszystko działa w karcie Twojej przeglądarki.
- Nie daje gwarancji 24/7. Alarmy powstają tylko wtedy, gdy Twoja przeglądarka, z aktywną instalacją, znajduje się na stronie kanonicznej.
- Nie jest exactly-once. Dostarczanie jest at-least-once, więc utracone potwierdzenie może dostarczyć tę samą partię dwukrotnie.
- Z założenia może przegapić krótkotrwałe zdarzenia: zdarzeń, które pojawią się i znikną między dwoma odczytami, nie da się wywnioskować.
- Nigdy nie odbiera dostępu do Discorda automatycznie. Gdy gracz odejdzie, moderator musi ręcznie odebrać temu graczowi uprawnienia na Discordzie.
- Drugi komputer lub profil przeglądarki to drugi nadawca. Patrz [Jedna aktywna instalacja](#jedna-aktywna-instalacja).

## Wymagania

- Komputer stacjonarny: Chrome z Tampermonkey (testowana kombinacja).
- Firefox z Tampermonkey oraz Violentmonkey mają status wyłącznie KANDYDATA, do czasu potwierdzenia macierzą zgodności.
- Serwer Discord, na którym możesz utworzyć własny webhook (potrzebujesz uprawnienia Manage Webhooks na kanale docelowym).
- Świat Traviana, w którym jesteś zalogowany i możesz otworzyć stronę członków sojuszu.

Monitorowanie z przeglądarki mobilnej jest nieobsługiwane. Odbieranie wiadomości z alarmami w mobilnej aplikacji Discord to osobna sprawa i działa jak zwykle.

## Szybki start

Karta Alerts pokazuje baner `Setup order`. Idź zgodnie z nim, w tej kolejności:

1. Otwórz kanoniczną trasę członków (patrz niżej).
2. Ustaw webhook Discord przez menu Tampermonkey.
3. Wyślij alarm TEST przyciskiem `Send TEST alert to Discord`.
4. Potwierdź zaakceptowany skan w karcie Overview.

Jeśli Travian pokazuje stronę logowania, zaloguj się najpierw. Monitor nigdy nie skanuje strony logowania i nigdy nie zmienia tam stanu.

## Instalacja z pliku lokalnego

Nie ma linku do pobrania ani kanału aktualizacji. Instaluj z lokalnego pliku `dist/travian-attack-alert.user.js` dostarczonego z tym kandydatem:

1. W Chrome otwórz `chrome://extensions` i włącz tryb dewelopera (Developer Mode). W Chrome 138 i nowszym Tampermonkey dodatkowo wymaga przełącznika przeglądarki Allow User Scripts (Tampermonkey FAQ Q209); bez niego przeglądarka blokuje instalację lokalnych skryptów.
2. Otwórz panel Tampermonkey, przejdź do Utilities i użyj Install from file albo przeciągnij plik `.user.js` do okna przeglądarki.
3. Jeśli instalacja jest zablokowana albo skrypt nie widzi plików lokalnych, włącz dla Tampermonkey dostęp do adresów file-URL i sprawdź, czy dozwolony jest dostęp do stron.
4. Sprawdź, czy zainstalowany skrypt pokazuje nazwę `Travian Attack Alert`, przestrzeń nazw `travian-attack-alert-public` i wersję `1.0.0`.

Jeśli wcześniej działała wewnętrzna linia 6.2.1 (historyczny rozwój wewnętrzny, nigdy niepublikowany), pamiętaj, że 1.0.0 to niższy numer, więc Tampermonkey traktuje to jako obniżenie wersji i NIGDY nie zaktualizuje do niej automatycznie. Zainstaluj plik ręcznie i najpierw wyłącz stary skrypt, aby obaj nadawcy nigdy nie działali obok siebie. W Violentmonkey skrypt jest zastępowany tylko wtedy, gdy zgadzają się przestrzeń nazw oraz nazwa, więc przed potwierdzeniem zastąpienia sprawdź oba pola.

## Strona kanoniczna i uprawnienia

Jedyna strona, na której działa monitor, to pozbawiona zapytań trasa członków sojuszu:

```text
https://<twoj-swiat>.travian.com/alliance/profile/members
```

Skrypt dopasowuje `https://*.travian.com/alliance*`, ale każda inna dopasowana trasa pokazuje tylko bierne wskazówki i nigdy nie skanuje, nie zapisuje, nie wysyła ani nie przeładowuje. Adres członków z ciągiem zapytania też jest bierny. Tabela musi być pojedynczą strukturalną tabelą członków; widoki stronicowane lub filtrowane są odrzucane zamiast zgadywane.

Aktywna karta trzyma dzierżawę Web-Lock i wykonuje pracę. Każda inna otwarta karta to gotowościowy widok tylko do odczytu: pokazuje ten sam panel bez kontrolek zmieniających stan, a utrata dzierżawy wyłącza mutacje natychmiast, zachowując możliwy do odzyskania stan kolejki w całości.

## Konfiguracja webhooka (Twój własny Discord)

1. W ustawieniach kanału Discord utwórz webhook do alarmów o atakach i skopiuj jego URL.
2. W Tampermonkey otwórz menu skryptu i wybierz `Set Discord webhook URL`, a potem wklej URL. Wartość jest przechowywana lokalnie w magazynie skryptu. Nigdy nie trafia do logów ani nie jest pokazywana w całości.
3. `Show Discord webhook status` mówi, czy webhook jest skonfigurowany. `Clear Discord webhook URL` usuwa go po wpisanym potwierdzeniu.

Opcjonalne pingi konfiguruje się osobno i nigdy się wzajemnie nie zastępują:

- Rola alarmowa: ustawiana przez `Set alert role ID`, czyszczona przez `Clear alert role ID`, podglądana przez `Show alert role ID`. Jest pingowana, gdy partia zawiera zdarzenia ataków lub mieszane.
- Rola moderatorów odejść: ustawiana przez `Set leave-moderator role ID`, czyszczona przez `Clear leave-moderator role ID`, podglądana przez `Show leave-moderator role ID`. Jest pingowana, gdy partia zawiera co najmniej jedno odejście.

Rola pinguje tylko wtedy, gdy rola Discord ma włączoną opcję Mentionable. Odchodzący gracz jest oznaczany osobiście tylko wtedy, gdy mapowanie Discord dla tego gracza z Traviana istniało już przed zaobserwowaniem odejścia.

## Syntetyczny TEST a skan detektora

Przycisk karty Alerts `Send TEST alert to Discord` wysyła syntetyczną partię (`Send TEST batch to Discord`, z wpisami `[TEST] Player 1` i `[TEST] Player 2`) przez Twój webhook i kolejkę. TEST dowodzi, że transport działa. Nigdy nie dowodzi, że działa detektor, i nigdy nie dotyka linii bazowej ataków.

Czytaj informacje zwrotne TEST dosłownie:

- `Discord TEST not sent — webhook is not configured. Set it via the Tampermonkey menu. Pending queue preserved.`
- `Discord TEST succeeded — transport works. This does not mean the monitor scan works.`
- `Discord TEST delivery issue — no acknowledgement. Failed/uncertain recovery stays in the Tampermonkey menu.`

Udany TEST obok odrzuconego skanu znaczy dokładnie tyle: dostarczanie na Discord działa, skan monitora nie. Oba wyniki są zgłaszane niezależnie i nigdy nie są łączone w jedno twierdzenie.

## Normalna praca

Panel (lista kart `Monitor views`) ma dokładnie cztery karty: Overview (`taa-tab-overview`, status i liczniki tylko do odczytu), Players (`taa-tab-players`, skład, mapowania, wyciszenia), Alerts (`taa-tab-alerts`, progi, role ataków i odejść, wysyłka testowa) oraz Diagnostics (`taa-tab-diagnostics`, filtry śladów i eksporty).

Overview pokazuje osiem linii statusu: Runtime (`taa-operational-runtime-value`), Route (`taa-operational-route-value`), Session (`taa-operational-session-value`), Lease (`taa-operational-lease-value`), Scan (`taa-operational-scan-value`), Scan detail (`taa-operational-scan-detail-value`), Baseline (`taa-operational-baseline-value`) i Delivery (`taa-operational-delivery-value`).

Dwie linie zasługują na wyjaśnienie przy pierwszym czytaniu:

- Baseline zaczyna jako `not established — the first accepted scan commits it silently (no historical flood)`. Pierwszy zaakceptowany skan ustawia odniesienie po cichu, aby stare ataki nie zalały Twojego kanału.
- Delivery pokazuje `webhook missing — configuration required; queue preserved`, dopóki webhook nie jest skonfigurowany. Wykrycia sprzed konfiguracji czekają w kolejce zamiast być porzucane.

Liczniki nieudanych i niepewnych partii widać w karcie Alerts. Same akcje odzyskiwania znajdują się w menu Tampermonkey: `Retry failed Discord batches`, `Retry uncertain Discord batches`, `Mark uncertain Discord batches delivered`, `Flush pending Discord batches`, a także `Toggle debug details` i `Load history and health`. Ponawianie, opróżnianie, debug i praca z webhookiem należą do menu Tampermonkey, nigdy do panelu.

Dwa eksporty służą różnym zadaniom. Pakiet incydentu (`Export incident bundle`, `taa-incident-bundle-export`) to ograniczona i zredagowana pierwsza reakcja na incydenty: eksportuj go NAJPIERW, zanim dotkniesz czegokolwiek; nie zawiera webhooka, tokenu, surowego DOM, danych graczy, ładunków kolejki, URL-i, ciasteczek ani treści odpowiedzi. Kopia ustawień (`Export settings` / `Import settings`, zwinięta pod `taa-settings-details`) to pełna ścieżka przywracania ustawień: przywraca mapowania, ustawienia, wyciszenia, nazwy, skład i role, a sekret webhooka zawiera tylko wtedy, gdy zaznaczysz pole `Include the Discord webhook secret in this file` (`taa-settings-export-webhook`, z powiadomieniem o jawnym JSON `taa-settings-export-warning`).

## Jedna aktywna instalacja

Uruchamiaj jedną aktywną instalację monitorującą na sojusz i świat. Cytowana reguła operatorska:

> one active monitoring installation per alliance/world; a second computer or browser profile WILL double-send; the local lock cannot prevent it.

Dzierżawa Web-Lock odgradza karty tylko wewnątrz jednego profilu przeglądarki. Drugi komputer, drugi profil albo równoległy nadawca 6.x wybiera własnego lidera i wysyła duplikaty. Przy przekazywaniu monitorowania innej osobie stary nadawca musi zostać najpierw wyłączony, potem trzeba potwierdzić ciszę, zanim nowy zostanie włączony.

## Ograniczenia, które warto znać

- Próbkowanie: monitor próbkuje tabelę raz na zaakceptowany cykl dokumentu. Cokolwiek pojawi się i zniknie między dwiema zaakceptowanymi migawkami, nie da się wywnioskować.
- Dostarczanie at-least-once: HTTP 200 z ID wiadomości potwierdza partię. Błędy sieci, limity czasu, przerwania, odpowiedzi 429 i 5xx są ponawiane; zwykłe odpowiedzi 4xx zostają nieudane do ręcznego rozliczenia; zniekształcone lub bez-ID 200 zostaje niepewne i nigdy nie jest ponawiane automatycznie. Każde ponowienie może zduplikować.
- Karty w tle, uśpienie i sesje: uśpiony laptop, zamrożona karta w tle albo wygasła sesja Traviana zatrzymują skanowanie. Po uśpieniu lub ponownym logowaniu otwórz ponownie trasę kanoniczną i sprawdź Overview, zanim zaufasz alarmom. Pokazywane liczniki to odrębne wiersze członków (Players), delty zdarzeń (ataki/rajdy) oraz żądania Discord (wiadomości); tych wielkości nie wolno zastępować jedną drugą.
- Monitor napędza cykl przeładowań 60-120 sekund. Nie uruchamiaj dwóch kart licząc na podwójne pokrycie; druga karta jest z założenia gotowościowa.

## Aktualizacje

Aktualizacje to ręczne przeinstalowania z pliku lokalnego. Lokalny plik `.user.js` nie ma kanału aktualizacji, a skrypt nigdy nie aktualizuje się sam. Aby zaktualizować, powtórz kroki [Instalacja z pliku lokalnego](#instalacja-z-pliku-lokalnego) z nowym plikiem i potwierdź wersję pokazywaną przez menedżera. Podczas aktualizacji nigdy nie włączaj dwóch nadawców naraz.

Każdy, kto migruje z wewnętrznej linii 6.2.1 (historyczny rozwój wewnętrzny), powinien przeczytać `docs/MIGRATION-6X.md`: najpierw wyeksportuj ustawienia, wyłącz starego nadawcę, zachowaj dane stron, a potem zainstaluj 1.0.0.

## Rozwiązywanie problemów

Wyeksportuj pakiet incydentu NAJPIERW, zanim dotkniesz czegokolwiek. Potem dopasuj swój stan:

- Brak webhooka: Overview Delivery mówi `webhook missing — configuration required; queue preserved`. Ustaw webhook przez menu Tampermonkey. Kolejka jest zachowana, nic nie ginie.
- Zła strona: panel pokazuje bierne wskazówki zamiast stanu skanu. Otwórz dokładną trasę `/alliance/profile/members` bez zapytania.
- Strona logowania: zaloguj się najpierw na stronie Traviana. Monitor nigdy nie skanuje strony logowania i nigdy nie zmienia tam stanu.
- Odrzucenie parsera: karta Players pokazuje `Live roster unavailable` z kodem przyczyny (`no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, `malformed-count`). Nie czyść danych stron: ostatni zaakceptowany skład, mapowania i konfiguracja ról znajdują się w magazynie, a wyczyszczenie niszczy jedyne możliwe do odzyskania kopie. Uzupełnij tylko te wartości, których brak udowodniły etykiety `Storage provenance`.
- Nieudane partie: użyj `Retry failed Discord batches` z menu Tampermonkey po sprawdzeniu konfiguracji webhooka.
- Niepewne partie: wybierz `Mark uncertain Discord batches delivered` albo `Retry uncertain Discord batches` z menu Tampermonkey. Ponowienie może zduplikować.
- Nadal nie działa: weź wyeksportowany pakiet do szablonu zgłoszenia opisanego niżej.

## Prywatność

- Twoja sesja Traviana zostaje w Twojej przeglądarce. Dane logowania nie są zapisywane, a ciasteczka nie są odczytywane.
- Twój URL webhooka znajduje się tylko w magazynie Twojego menedżera skryptów. Jest sprawdzany jako URL webhooka Discord przez HTTPS, przechowywany bez ciągu zapytania i nigdy nie jest logowany ani pokazywany w całości.
- Pakiet incydentu jest z konstrukcji ograniczony (512 KiB) i zredagowany.
- Kopia ustawień domyślnie pomija sekret webhooka; plik zawiera go tylko po Twoim wyraźnym zaznaczeniu pola.

## Bezpieczne zgłaszanie problemu

Dołącz wersję skryptu (`1.0.0`), wersje przeglądarki i menedżera skryptów, kroki odtworzenia, to czego oczekiwałeś i to co stało się zamiast. Załącz zredagowany pakiet incydentu. NIGDY nie dołączaj URL webhooka ani tokenu, ciasteczek, haseł, surowego HTML strony ani danych graczy ponad to, co pakiet już zawiera w formie zredagowanej.

## Dalsze dokumenty

- Angielski przewodnik główny: `README.md` (ta strona jest jego polskim odpowiednikiem).
- Codzienna obsługa: `docs/OPERATIONS.md` (wersja angielska) i `docs/OPERATIONS.pl.md` (wersja polska).
- Migracja z linii 6.x: `docs/MIGRATION-6X.md`.

## Dobrowolne wsparcie

Wsparcie tego projektu jest w całości dobrowolne i opcjonalne. Nie ma wpływu na funkcje, priorytety ani terminy poprawek. Nie ma płatnego poziomu i nic nie jest zablokowane za wsparciem. Miejsce docelowe dobrowolnego wsparcia doda opiekun.

## Uwaga o wersji

Ta strona dokumentuje `1.0.0` (`taa-1.0.0`). Wcześniejsze zachowanie z ery 6.2.1 (historyczny rozwój wewnętrzny) nie jest częścią kontraktu tego kandydata.
