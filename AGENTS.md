# AGENTS.md - zasady projektu TravianAttackAlert

Userscript Tampermonkey, monolit `script.txt` (~9959 linii). Testy offline `node:test`, zero zaleznosci runtime w przegladarce.

## 1. Wersjonowanie

- Jedno zrodlo prawdy: `package.json` (`version`, aktualnie 1.0.0).
- Bump semver: patch = fix, minor = nowa funkcja, major = break storage/schema.
- Po bumpie obowiazkowo: `npm run build && npm run check:artifact && npm run backup`.
- Miejsca do synchronizacji wersji: naglowek `script.txt` + RELEASE, `tools/*` (RELEASE), asercje w testach, README.

## 2. Backup i rollback

- Przed KAZDA edycja `script.txt`: `npm run backup`.
- Rollback tylko procedura z README: zaimportuj stary `script.txt` do Tampermonkey, BEZ czyszczenia site data.
- Czyszczenie storage niszczy roster, mapowania i konfiguracje rol, to kopie bez odzysku.

## 3. Testy

- `npm test` musi byc zielone (caly pakiet testow offline, zero fail).
- Szybki syntax check: `node -e "new Function(require('fs').readFileSync('script.txt','utf8'))"`.
- Fikstury deterministyczne (loopback), zadnych realnych webhookow i requestow do Travian.

## 4. Sekrety

- Webhook Discorda tylko przez `GM_setValue` / menu Tampermonkey. Nigdy w kodzie, DOM, logach ani eksportach diagnostycznych.
- Eksporty sa ograniczone i zredagowane (bez tokenow, URL-i, payloadow kolejki, cookies).
- `backups/`, `.env*` sa gitignorowane. Nie wersjonuj sekretow.

## 5. Panel vs menu

- Panel = codzienna praca: Overview read-only, Players CRUD, progi, role (attack/leave), test wysylki.
- Menu Tampermonkey = setup + recovery: webhook, retry/flush, debug, import/export awaryjny, bundle incydentu.
- Standby (bez lease) jest read-only, utrata lease wylacza mutacje natychmiast.

## 6. Architektura

- `script.txt` to checked-in source of truth. `npm run build` tylko odswieza manifest i hashe metadanych, nie generuje dystrybucji.
- `src/` to shimy, runtime autorytetem jest `script.txt` (release ID `taa-1.0.0`).
- Zakaz nowych zaleznosci runtime bez pytania. Dev: esbuild, playwright, typescript tylko dla narzedzi/testow.
