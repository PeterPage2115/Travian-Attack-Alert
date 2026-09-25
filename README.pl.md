# Travian Attack Alert

Alerty o atakach, rajdach i odejściach sojuszników z Traviana prosto na Twój serwer Discord. Jeden skrypt Tampermonkey działający po cichu w karcie przeglądarki. Bez backendu, bez konta, bez zależności runtime.

[English](README.md) | **Polski**

<p align="center">
  <a href="https://github.com/PeterPage2115/Travian-Attack-Alert/releases/latest"><img alt="Najnowsze wydanie" src="https://img.shields.io/github/v/release/PeterPage2115/Travian-Attack-Alert?label=release&amp;color=2ea44f"></a>
  <a href="LICENSE"><img alt="Licencja: MIT" src="https://img.shields.io/github/license/PeterPage2115/Travian-Attack-Alert?color=blue"></a>
  <a href="https://github.com/PeterPage2115/Travian-Attack-Alert/releases/latest/download/travian-attack-alert.user.js"><img alt="Zainstaluj userscript" src="https://img.shields.io/badge/install-userscript-2ea44f"></a>
  <a href="https://github.com/PeterPage2115/Travian-Attack-Alert/actions/workflows/ci.yml"><img alt="Status CI" src="https://img.shields.io/github/actions/workflow/status/PeterPage2115/Travian-Attack-Alert/ci.yml?label=CI"></a>
</p>

![Syntetyczny zrzut ekranu panelu operacyjnego Travian Attack Alert: okno monitora alertów sojuszu z kartami Overview, Players, Alerts i Diagnostics, statusem lidera, liniami zaakceptowanego skanu i ustaloną linią bazową.](docs/assets/panel-overview.png)

*Panel powyżej pochodzi z syntetycznej fixtury Playwright tego repozytorium. Nie zawiera żadnych prawdziwych danych sojuszu, gracza, hosta, konta ani webhooka.*

## Co to robi

Skrypt obserwuje tabelę członków sojuszu na Twoim świecie Traviana i wysyła powiadomienie na Discorda, gdy pojawią się nowe ataki, rajdy lub odejścia. Utrzymuje deltę względem linii bazowej, więc pierwszy zaakceptowany skan jest cichy, a alerty dotyczą tylko zmian od poprzedniego skanu. Wszystko działa lokalnie w karcie przeglądarki: sesja Traviana nie opuszcza Twojej maszyny, a webhook Discorda trafia wyłącznie do menedżera skryptów. Bieżąca kompilacja to `1.0.2` (`taa-1.0.2`), bez bundlera, frameworka ani zależności runtime w przeglądarce.

## Instalacja

Instalacja to cztery kroki.

1. Zainstaluj menedżera skryptów: [Tampermonkey dla Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) lub [Tampermonkey dla Firefoksa](https://addons.mozilla.org/firefox/addon/tampermonkey/).
2. Otwórz instalator z [najnowszego wydania GitHub](https://github.com/PeterPage2115/Travian-Attack-Alert/releases/latest) i potwierdź monit Tampermonkey. Plik do instalacji jednym kliknięciem to [`travian-attack-alert.user.js`](https://github.com/PeterPage2115/Travian-Attack-Alert/releases/latest/download/travian-attack-alert.user.js).
3. W Chrome 138+ z Tampermonkey 5.3+ włącz **Allow User Scripts** (albo Tryb dewelopera). Bez tego przeglądarka nie uruchomi żadnego userscriptu: brak panelu, menu, skanu i alertu. To FAQ Q209 Tampermonkey.
4. Potwierdź, że zainstalowany skrypt pokazuje nazwę `Travian Attack Alert`, przestrzeń nazw `travian-attack-alert-public` i wersję `1.0.2`.

Aktualizacje przychodzą automatycznie kanałem `@updateURL` na gałęzi `release/public-1.0.0`, więc menedżer, który go respektuje, pobiera bieżący plik bez ręcznej pracy. Ponowna instalacja z najnowszego wydania również wgra nową wersję. Nigdy nie włączaj dwóch nadawców jednocześnie w trakcie aktualizacji.

Budowanie ze źródeł jest dla współtwórców, nie służy do instalacji skryptu. Zobacz [CONTRIBUTING.md](CONTRIBUTING.md).

## Szybki start

1. Otwórz trasę kanoniczną: `https://<twoj-swiat>.travian.com/alliance/profile/members`. Musi być bez parametrów zapytania; każda inna dopasowana trasa pozostaje nieaktywna i nigdy nie skanuje.
2. Ustaw webhook Discorda w **menu Tampermonkey** przez `Set Discord webhook URL`. `Show Discord webhook status` powie Ci, czy webhook jest już skonfigurowany.
3. Kliknij **Send TEST alert to Discord** na karcie Alerts (`taa-tab-alerts`). TEST dowodzi tylko działania transportu. Nie dowodzi działania detektora i nigdy nie dotyka linii bazowej.
4. Potwierdź zaakceptowany skan i ustaloną linię bazową na karcie Overview (`taa-tab-overview`).

Jeśli Travian pokazuje stronę logowania, zaloguj się najpierw; monitor nigdy nie skanuje tej strony i nie zmienia tam stanu. Pierwszy zaakceptowany skan zatwierdza linię bazową po cichu, więc stare ataki nie zalewają kanału. Wykrycia sprzed ustawienia webhooka czekają w kolejce zamiast przepadać.

## Funkcje

**Wykrywanie**
- Obserwuje tabelę członków sojuszu na stronie kanonicznej i wykrywa nowe ataki, rajdy oraz odejścia.
- Praca na delcie: pierwszy zaakceptowany skan po cichu ustawia linię bazową, a alerty dotyczą tylko nowych zdarzeń.
- Progi na gracza, wyciszenia graczy oraz pasma priorytetu Normal / High / Critical.
- Odejście gracza nigdy nie odbiera mu dostępu do Discorda automatycznie; moderator musi zrobić to ręcznie.

**Alerty Discord**
- Wysyłka na Twój własny webhook Discorda: bez bota, bez aplikacji OAuth, bez backendu.
- Komunikaty delta-first z podlinkowanymi nazwami graczy i jednym użyciem wzmianek na partię.
- Dostarczanie jest co-najmniej-raz, więc utracone potwierdzenie może zdublować partię.

**Panel**
- Overview (`taa-tab-overview`) to tylko status do odczytu; Players (`taa-tab-players`) trzyma roster, mapowania i wyciszenia.
- Alerts (`taa-tab-alerts`) trzyma progi, role i wysyłkę testową; Diagnostics (`taa-tab-diagnostics`) trzyma śledzenie i eksporty.

**Bezpieczeństwo**
- Webhook trafia wyłącznie do pamięci menedżera skryptów (`GM_setValue`) i nigdy nie jest zapisywany w kodzie ani logach.
- Karta w trybie standby bez dzierżawy pozostaje tylko do odczytu, a utrata dzierżawy natychmiast blokuje mutacje.

Dalsza lektura: [format alertów](docs/ALERT-FORMAT.md), [operacje](docs/OPERATIONS.md), [architektura](docs/architecture.md).

## Konfiguracja

Codzienna praca należy do panelu. Konfiguracja i odzyskiwanie należą do menu Tampermonkey.

| Gdzie | Co |
| --- | --- |
| Panel, Overview (`taa-tab-overview`) | Tylko do odczytu: runtime, trasa, sesja, dzierżawa, skan, linia bazowa, dostarczanie. |
| Panel, Players (`taa-tab-players`) | Roster sojuszu, mapowania graczy i wyciszenia. |
| Panel, Alerts (`taa-tab-alerts`) | Progi ataków i rajdów, pasma priorytetu, role ataku i moderatora odejść, wysyłka testowa. |
| Panel, Diagnostics (`taa-tab-diagnostics`) | Filtry śledzenia i eksport pakietu incydentu. |
| Menu Tampermonkey | Ustaw, pokaż lub wyczyść webhook; ponów lub opróżnij partie w kolejce; przełącz szczegóły debugowania; wczytaj historię i stan; importuj lub eksportuj ustawienia. |

Najczęstsze ustawienia i wartości domyślne:

| Ustawienie | Domyślnie | Działanie |
| --- | --- | --- |
| Próg ataków | 1 | Minimalna liczba nowych ataków na jednego gracza, zanim powstanie alert ataku. |
| Próg rajdów | 1 | Minimalna liczba nowych rajdów na jednego gracza, zanim powstanie alert rajdu. |
| Normal max | 2 | Szczyt nowych zdarzeń do tej wartości pozostaje `Priority: Normal`. |
| High max | 5 | Szczyt do tej wartości to `Priority: High`; powyżej jest `Priority: Critical`. |

Pełna dokumentacja operatorska: [docs/OPERATIONS.md](docs/OPERATIONS.md) (angielska) i [docs/pl/OPERATIONS.md](docs/pl/OPERATIONS.md) (polska; w razie rozbieżności obowiązuje tekst angielski).

## Jak wyglądają alerty

Alerty są krótkie i delta-first. Tytuł nazywa zdarzenie, pierwszy embed niesie podsumowanie `New`, `Active now` i `Priority`, a stopka to `<hostname> · <observation-text>`.

Pełny kontrakt ładunku (anatomia pól, polityka wzmianek, limity pojedynczego żądania, dzielenie na części, wyniki dostarczania) jest w [docs/ALERT-FORMAT.md](docs/ALERT-FORMAT.md). Przykład poniżej pochodzi z aktywnego kanonicznego buildera rajdu.

```text
🛡️ Alliance raid · 2 players
**Players**
[Player 900001](https://world.example.invalid/profile/900001) — **+1 raid**
Now: 0 attacks / 1 raid

[Player 900002](https://world.example.invalid/profile/900002) — **+1 raid**
Now: 0 attacks / 1 raid
New: **+2 raids**
Active now: 0 attacks / 2 raids
Priority: Normal
world.example.invalid · Observed <1s before dispatch
Timestamp: 2026-08-23T09:46:01.000Z
```

## Prywatność i bezpieczeństwo

- Sesja Traviana zostaje w Twojej przeglądarce. Dane logowania nie są zapisywane, a cookies nie są czytane.
- Webhook Discorda żyje wyłącznie w pamięci menedżera skryptów. Jest walidowany jako adres HTTPS webhooka Discorda, zapisywany bez parametrów zapytania i nigdy nie jest logowany ani pokazywany w całości.
- Gdy coś wygląda źle, najpierw wyeksportuj pakiet incydentu: karta Diagnostics, **Export incident bundle** (`taa-incident-bundle-export`). Pakiet incydentu jest ograniczony (512 KiB) i zredagowany z założenia.
- Kopia ustawień (**Export settings** / **Import settings**, schowana pod `taa-settings-details`) to pełna ścieżka odtworzenia ustawień: odtwarza mapowania, ustawienia, wyciszenia, nazwy, roster i role, a sekret webhooka zawiera tylko po Twojej wyraźnej zgodzie.
- Nie usuwaj danych strony: ostatni zaakceptowany roster, mapowania i konfiguracja ról żyją w pamięci, a wyczyszczenie niszczy jedyne kopie do odzyskania.
- Niepoprawne lub częściowe dane wejściowe nigdy nie zmieniają stanu: akwizycja jest odrzucana bez częściowego stanu, a ostatni zaakceptowany stan pozostaje bez zmian.
- Wszystkie nazwy graczy, hosty i tokeny w dokumentacji oraz przykładach alertów to syntetyczne fixtury. W tym repozytorium nie ma prawdziwych danych graczy, hostów ani sekretów.

## Rozwiązywanie problemów

1. Nic się nie dzieje. W Chrome 138+ włącz **Allow User Scripts** (albo Tryb dewelopera), odśwież stronę i zainstaluj skrypt ponownie.
2. Nic nie dociera na Discorda. Sprawdź linię Delivery na karcie Overview. Jeśli brakuje webhooka, ustaw go w menu Tampermonkey; wykrycia czekają w kolejce i nic nie ginie.
3. Skan wygląda źle. Potwierdź dokładną trasę bez parametrów zapytania `/alliance/profile/members` i zalogowanie. Odrzucenie przez parser pokazuje `Live roster unavailable` z kodem przyczyny.
4. Dwie instalacje wysyłają podwójnie. Utrzymuj dokładnie jedną aktywną instalację monitorującą na sojusz i świat; drugi komputer lub profil przeglądarki to drugi nadawca.
5. Nadal nic. Wyeksportuj zredagowany pakiet incydentu i przejdź listę diagnostyczną w [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Dokumentacja

- [Indeks dokumentacji](docs/README.md): wszystkie bieżące dokumenty, z archiwum historii wydań oznaczonym jako historyczne.
- [Codzienna obsługa (angielska)](docs/OPERATIONS.md) i [polska](docs/pl/OPERATIONS.md): poranna rutyna, odzyskiwanie kolejki, przekazanie, rozwiązywanie problemów.
- [Format ładunku alertu](docs/ALERT-FORMAT.md): anatomia żądania, polityka wzmianek, limity, dzielenie, wyniki dostarczania.
- [Architektura](docs/architecture.md): graf modułów i tokeny designu.
- [Runbook wydania właściciela](docs/RELEASE-RUNBOOK.md): uporządkowana procedura publikacji bramkowana przez właściciela.
- [Historia zmian](CHANGELOG.md), [Współtworzenie](CONTRIBUTING.md), [Polityka bezpieczeństwa](SECURITY.md).
- Migrujesz z wewnętrznej linii 6.2.1 (historycznej)? Wyeksportuj kopię ustawień ze starego nadawcy, wyłącz go, zachowaj dane strony i zainstaluj 1.0.2. Zobacz [docs/MIGRATION-6X.md](docs/MIGRATION-6X.md).

## Wsparcie

Zgłaszając problem, podaj wersję skryptu (`1.0.2`), wersje przeglądarki i menedżera skryptów, numerowane kroki reprodukcji, oczekiwany i faktyczny wynik. Dołącz zredagowany pakiet incydentu. NIGDY nie dołączaj adresu webhooka ani tokenu, cookies, haseł, surowego HTML strony, ani danych graczy wykraczających poza to, co pakiet już zawiera w formie zredagowanej.

- [Zgłoszenie błędu](.github/ISSUE_TEMPLATE/bug_report.yml)
- [Propozycja funkcji](.github/ISSUE_TEMPLATE/feature_request.yml)
- [Polityka bezpieczeństwa](SECURITY.md): zgłaszaj luki prywatnie, nigdy w publicznym zgłoszeniu.

Wsparcie jest dobrowolne i nie wpływa na funkcje, priorytety ani terminy poprawek. Nie ma płatnego planu.

## Współtworzenie

Zobacz [CONTRIBUTING.md](CONTRIBUTING.md): workflow, testy, kopie zapasowe i lista kontrolna PR. Budowanie ze źródeł jest dla współtwórców; wspieraną ścieżką instalacji jest plik wydania powyżej.

## Historia zmian

[CHANGELOG.md](CHANGELOG.md) opisuje publiczną linię wydań. Opublikowane kompilacje są na [GitHub Releases](https://github.com/PeterPage2115/Travian-Attack-Alert/releases).

## Licencja

[MIT](LICENSE).

## Wyłączenie odpowiedzialności

Travian Attack Alert to nieoficjalne narzędzie fanowskie. Nie jest powiązane z Travian Games GmbH, nie jest przez tę firmę autoryzowane ani sponsorowane. Travian i powiązane znaki należą do ich właścicieli.

---

Ta strona opisuje userscript Tampermonkey **1.0.2**, identyfikowany przez ID wydania `taa-1.0.2`. Bieżące opublikowane wydanie to [v1.0.2](https://github.com/PeterPage2115/Travian-Attack-Alert/releases/latest).
