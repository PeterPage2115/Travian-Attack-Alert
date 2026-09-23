# AGENTS.md - zasady projektu TravianAttackAlert

Userscript Tampermonkey, moduly `src/` budowane do `dist/` (`npm run build`). Testy offline `node:test`, zero zaleznosci runtime w przegladarce.

## 1. Wersjonowanie

- Jedno zrodlo prawdy: `package.json` (`version`, aktualnie 1.0.1).
- Bump semver: patch = fix, minor = nowa funkcja, major = break storage/schema.
- Po bumpie obowiazkowo: `npm run build && npm run check:artifact && npm run backup`.
- Miejsca do synchronizacji wersji: `package.json` + naglowek dist (generowany przez build) + RELEASE, `tools/*` (FALLBACK), asercje w testach, README.

## 2. Backup i rollback

- Przed KAZDA edycja `src/` lub `config/`: `npm run backup`.
- Rollback tylko procedura z README: `node tools/rollback.cjs <selector>`, potem `npm run build`, BEZ czyszczenia site data.
- Czyszczenie storage niszczy roster, mapowania i konfiguracje rol, to kopie bez odzysku.

## 3. Testy

- `npm test` musi byc zielone (caly pakiet testow offline, zero fail).
- Szybki syntax check: `node -e "new Function(require('fs').readFileSync('dist/travian-attack-alert.user.js','utf8'))"`.
- Fikstury deterministyczne (loopback), zadnych realnych webhookow i requestow do Travian.
- Uwagi review zewnetrznego: `docs/CODE-REVIEW.md`, kazdy komentarz weryfikuj repro przed resolve.

## 4. Sekrety

- Webhook Discorda tylko przez `GM_setValue` / menu Tampermonkey. Nigdy w kodzie, DOM, logach ani eksportach diagnostycznych.
- Eksporty sa ograniczone i zredagowane (bez tokenow, URL-i, payloadow kolejki, cookies).
- `backups/`, `.env*` sa gitignorowane. Nie wersjonuj sekretow.

## 5. Panel vs menu

- Panel = codzienna praca: Overview read-only, Players CRUD, progi, role (attack/leave), test wysylki.
- Menu Tampermonkey = setup + recovery: webhook, retry/flush, debug, import/export awaryjny, bundle incydentu.
- Standby (bez lease) jest read-only, utrata lease wylacza mutacje natychmiast.

## 6. Architektura

- `src/` to edytowalny autorytet runtime (entry `src/userscript-entry.js` → `src/runtime.js`); `dist/` jest generowany przez `npm run build` i nigdy nie jest edytowany ręcznie.
- `src/` to 13 modułów domenowych (`storage`, `lease`, `parser`, `snapshot`, `envelope`, `migration`, `discord`, `transport`, `dispatch`, `conservation`, `diagnostics`, `panel`, `acquisition`): każda fasada `X.js` re-eksportuje kontrakt `X-impl.js` przez referencję (`storage` ma 12 podmodułów: `storage-impl` + 11 siblings); `constants`/`text`/`route` to czyste moduły weryfikowane testem `pure-module-parity`.
- `src/runtime-api.js` to cienki agregator: bezpośrednie re-eksporty 13 fasad (identyczność referencyjna, brak `select()`), bez zależności od `src/runtime.js`.
- `src/lifecycle.js` (`createLifecycleController`) jest jedynym właścicielem mutowalnych singletonów cyklu życia; `src/adapters.js` to 7 fabryk seamu (storage, clock, sleep, gmRequest, docLoc, webLocks, sessionStore). `src/runtime.js` pozostaje legacy autorytetem (325 eksportów, release ID `taa-1.0.1`); produkcyjne wiring bez zmian. Granice wymusza `test/tools/module-architecture.test.cjs`.
- Zakaz nowych zaleznosci runtime bez pytania. Dev: esbuild, playwright, typescript tylko dla narzedzi/testow.
- Tokeny designu (kolory, komponenty panelu): `docs/architecture.md`.
