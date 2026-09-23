# Travian Attack Alert

Alliance attack, raid, and departure alerts from Travian to your own Discord server.

**Version 1.0.0, release ID `taa-1.0.0`. Release candidate under pilot, not yet declared public.**

Release candidate under pilot; stable publication requires owner pilot evidence (pilot checklist and machine-readable gate: `docs/release-history/1.0.0-rc/PILOT.md`, `docs/release-state.json`).

The script (`Travian Attack Alert`, namespace `travian-attack-alert-public`) periodically reads the alliance members table on the canonical page and sends Discord alerts when attacks, raids, or departures appear. No bundler, framework, or runtime dependency is required in the browser. The installable file is `dist/travian-attack-alert.user.js`, generated from `src/` via `npm run build`.

## Constraints

- It has no backend. Everything runs in your browser tab.
- It gives no 24/7 guarantee. Alerts are produced only while your browser, with an active installation, sits on the canonical page.
- It is not exactly-once. Delivery is at-least-once, so a lost acknowledgement can deliver the same batch twice.
- It can miss short-lived events by design: events that appear and disappear between two reads cannot be inferred.
- It never removes Discord access automatically. When a player leaves, a moderator must revoke that player's Discord permissions by hand.
- One active monitoring installation per alliance and world. A second computer or browser profile is a second sender and WILL double-send; the local lock cannot prevent it.
- Desktop Chrome with Tampermonkey is the tested combination. Firefox with Tampermonkey, and Violentmonkey, are candidate-only until proven. Mobile browser monitoring is unsupported; receiving alerts in the mobile Discord app works as usual.

Daily routine, handover order, queue recovery, and diagnostics live in `docs/OPERATIONS.md` (English) and `docs/pl/OPERATIONS.md` (Polish). This page stays an overview.

## Install and update

Build the installable file from source (`src/` is the editable authority — `dist/` is generated, never hand-edited):

```text
npm run build
```

Then install `dist/travian-attack-alert.user.js` in Tampermonkey (Dashboard → Utilities → Install from file, or drag the `.user.js` file into the browser window). Confirm the installed script shows name `Travian Attack Alert`, namespace `travian-attack-alert-public`, and version `1.0.0`.

On Chrome 138 and newer, Tampermonkey 5.3+ additionally needs the browser's `Allow User Scripts` toggle (or Developer Mode) enabled; this is Tampermonkey FAQ Q209. With that permission off, the browser runs no userscript at all: there is no panel, no Tampermonkey menu entry, no scan, and no alert, and the script cannot diagnose or report the condition because it never executes. To recover, enable `Allow User Scripts` (or Developer Mode), reload the page, then reinstall the script.

Updates are delivered through the `@updateURL` channel pointing at the default release branch `release/public-1.0.0` (`main` does not exist on the remote):

```text
https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/release/public-1.0.0/dist/travian-attack-alert.user.js
```

The script therefore supports automatic updates from that URL; a new version can also be applied by repeating the install-from-file steps with the new file and confirming the version shown by the manager. Never enable two senders at once during an update.

The remote branch is observed protected through the public GitHub API with four required checks, while `docs/release-state.json` still records the owner attestation as unrecorded (`ownerManual.branchProtection: false`), so `stable` stays `false`. The API observation and the owner attestation are separate facts.

Already-installed `1.0.0` copies that embedded the old broken URL cannot self-heal at the same version: a same-version install never triggers an update, and the stale embedded URL never resolves. Reinstall `1.0.0` from the corrected URL or file above (or re-run the install-from-file steps), keep all site data untouched, and confirm the version shown by the manager.

Anyone migrating from the internal 6.2.1 line (historical internal development) should read `docs/MIGRATION-6X.md`: export settings first, disable the old sender, keep site data, then install 1.0.0.

## Quick start

The Alerts tab shows a `Setup order` banner. Follow it in this order:

1. Open the canonical members route: `https://<your-world>.travian.com/alliance/profile/members` (query-free; any other matched route shows inert guidance and never scans).
2. Set the Discord webhook via the Tampermonkey menu (`Set Discord webhook URL`). `Show Discord webhook status` tells you whether one is configured; `Clear Discord webhook URL` removes it after a typed confirmation.
3. Send the TEST alert with the `Send TEST alert to Discord` button. A TEST proves that transport works. It never proves that the detector works, and it never touches the attack baseline.
4. Confirm an accepted scan in the Overview tab (`taa-tab-overview`).

If Travian shows a login page, log in first. The monitor never scans a login page and never changes state there.

The panel (`Monitor views` tablist) has exactly four tabs: Overview (`taa-tab-overview`, read-only status and counts), Players (`taa-tab-players`, roster, mappings, mutes), Alerts (`taa-tab-alerts`, thresholds, attack and leave roles, test send), and Diagnostics (`taa-tab-diagnostics`, trace filters and exports).

The first accepted scan commits the baseline silently (no historical flood), so old attacks do not flood your channel. Detections made before a webhook is configured stay queued instead of being dropped.

Recovery lives in the Tampermonkey menu: `Retry failed Discord batches`, `Retry uncertain Discord batches`, `Mark uncertain Discord batches delivered`, `Flush pending Discord batches`, plus `Toggle debug details` and `Load history and health`. Retry, flush, debug, and webhook work all belong to the Tampermonkey menu, never to the panel.

Export the incident bundle FIRST, before touching anything: Diagnostics tab, `Export incident bundle` (`taa-incident-bundle-export`). The incident bundle is bounded (512 KiB) and redacted by construction: no webhook, token, raw DOM, player data, queue payloads, URLs, cookies, or response bodies. The settings backup (`Export settings` / `Import settings`, collapsed under `taa-settings-details`) is the full-settings restore path: it restores mappings, settings, mutes, names, roster, and roles, and carries the webhook secret only with your explicit opt-in checkbox. Do not clear site data: the last accepted roster, mappings, and role configuration live in storage, and clearing destroys the only recoverable copies.

## What alerts look like

Alerts are short and delta-first:

- `🚨 Alliance attack`, `🛡️ Alliance raid`, or `🔄 Alliance changes`, with a linked title and singular/plural player count.
- The first embed has exactly `New`, `Active now`, and `Priority` fields, in that order. Continuations repeat global context.
- The footer is `<hostname> · <observation-text>`. One logical dispatch timestamp is placed on the last embed of every request.
- Multi-request output adds `part X/Y`; continuations repeat global context.
- Mentions occur once only; continuations use empty mention allowlists.
- Departure-operator roles: Attack role (`roleId`) pings on attack/mixed batches; Leave-moderator role (`leaveRoleId`) is a separate global role pinged when a batch contains a departure. Configure the leave role as `Leave-moderator role` (`taa-leave-role-input`, `taa-leave-role-set`, `taa-leave-role-clear`, `taa-leave-role-current`) or via the Tampermonkey menu; both IDs live in `travianAllianceDiscordConfig_v1` and are validated by `validateDiscordRoleId`. A role pings only when its Discord role is Mentionable. A departing player is personally mentioned only when a pre-existing `mappings[hostname][playerId]` mapping already exists, so the first request may carry `<@&leaveRoleId> <@userId>` exactly as the live builder emits it.
- Discord limits use JavaScript UTF-16 `.length`: content 2000, title 256, description 4096, field name 256, field value 1024, total embed text 6000, and at most 10 embeds per request.

Payloads use safe links in DOM order and the mention policy is explicit. `allowed_mentions` is an explicit allowlist with no `parse` key. The first request of a batch may carry `content` such as `<@&leaveRoleId> <@userId>` together with `allowed_mentions` like `{ users: ["123456789012345678"], roles: ["987654321098765432"] }`, or `{ users: [] }` when no one is mentioned. Continuations use empty `content` with `{ users: [] }` and no `roles` key, and the list is bounded and deduplicated to fit the 2000 character content limit. Embed titles, descriptions, field values and footers never contain mention tokens; mentions live only in top-level `content`. Partial, repeated, malformed, or ambiguous input does not change authoritative state; acquisition is rejected without partial state and authoritative state remains unchanged.

The following bytes are generated from the live canonical raid builder:

<!-- discord-alert-example:start -->
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
<!-- discord-alert-example:end -->

The attack and mixed-alert grammar is also captured from the live canonical attack fixture:

<!-- discord-attack-example:start -->
```text
🚨 Alliance attack · 6 players
**Players**
[Player 900003](https://world.example.invalid/profile/900003) — **+2 attacks**
Now: 17 attacks / 5 raids

[Player 900004](https://world.example.invalid/profile/900004) — **+2 attacks**
Now: 7 attacks / 7 raids

[Player 900005](https://world.example.invalid/profile/900005) — **+1 attack** · **+1 raid**
Now: 8 attacks / 1 raid

[Player 900006](https://world.example.invalid/profile/900006) — **+1 attack** · **+1 raid**
Now: 6 attacks / 2 raids

[Player 900007](https://world.example.invalid/profile/900007) — **+1 attack** · **+1 raid**
Now: 7 attacks / 1 raid

[Player 900008](https://world.example.invalid/profile/900008) — **+1 attack**
Now: 7 attacks / 1 raid
New: **+8 attacks** · **+3 raids**
Active now: 52 attacks / 17 raids
Priority: Normal
world.example.invalid · Observed <1s before dispatch
Timestamp: 2026-08-23T09:46:01.000Z
```
<!-- discord-attack-example:end -->

No historical or guessed time is invented. Missing observation time remains `Observation time unavailable`; inherited timestamps remain marked approximate observation. Delivery is at-least-once: a lost acknowledgement can produce a duplicate. HTTP 200 with a message ID acknowledges; network, timeout, abort, 429 and 5xx responses are retried, ordinary 4xx stays failed, and a malformed or ID-less 200 is uncertain and is not retried automatically. `wait=true` exists only in the in-memory send URL.

The superseded 5.2.6-era contract is historical; the 1.0.0 contract above is the one this candidate implements.

## Privacy

- Your Travian session stays in your browser. Credentials are not persisted and cookies are not read.
- Your webhook URL lives only in your userscript manager storage. It is validated as an HTTPS Discord webhook URL, stored without a query string, and never logged or displayed in full.
- The incident bundle is bounded (512 KiB) and redacted by construction.
- The settings backup omits the webhook secret by default; the file carries it only with your explicit opt-in checkbox.
- All player names, hosts, and tokens shown in docs and alert examples are synthetic fixtures only. No real player data, hosts, or secrets appear in this repository's documentation.

## Support

Include the script version (`1.0.0`), your browser and userscript manager versions, steps to reproduce, what you expected, and what happened instead. Attach the redacted incident bundle. NEVER include a webhook URL or token, cookies, passwords, raw page HTML, or player data beyond what the bundle already contains in redacted form.

To file a report, use the issue templates: [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or [feature request](.github/ISSUE_TEMPLATE/feature_request.yml). Please follow [CONTRIBUTING.md](CONTRIBUTING.md) and the [security policy](SECURITY.md) (synthetic/redacted data only, no secrets).

Support for this project is entirely voluntary and optional. It has no influence on features, priorities, or fix timelines. There is no paid tier and nothing is locked behind support. The destination for voluntary support will be added by the maintainer.

This page documents the Tampermonkey **1.0.0** userscript, identified by release ID `taa-1.0.0`. Earlier 6.2.1-era behavior (historical internal development) is not part of this candidate's contract.

## Documentation

- Docs index: `docs/README.md`.
- Daily operations (English): `docs/OPERATIONS.md`.
- Daily operations (Polish): `docs/pl/OPERATIONS.md`.
- Migration from the 6.x line: `docs/MIGRATION-6X.md`.
- Detector behavior audit: `docs/AUDIT.md`.
- Module graph (post-extraction): `docs/architecture.md` §10.
- Release history (archived 1.0.0 candidate records): `docs/release-history/1.0.0-rc/`.
- Changelog: `CHANGELOG.md`.
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) (workflow, tests, backup, PR checklist).
- Pull request template: [.github/pull_request_template.md](.github/pull_request_template.md).
- Security policy: [SECURITY.md](SECURITY.md). License: [LICENSE](LICENSE).

## Source layout

`src/` is the editable authority; `dist/travian-attack-alert.user.js` is generated (`npm run build`) and never hand-edited. The runtime is 13 domain modules (`storage`, `lease`, `parser`, `snapshot`, `envelope`, `migration`, `discord`, `transport`, `dispatch`, `conservation`, `diagnostics`, `panel`, `acquisition`): each `X.js` facade re-exports its `X-impl.js` contract by reference (`storage` spans 12 sub-modules), while `constants`/`text`/`route` are pure modules covered by `pure-module-parity`. `src/runtime-api.js` is a thin aggregator over the 13 facades (reference-equal, no `select()` indirection) and does not depend on the legacy authority. Mutable lifecycle state has a single owner, `src/lifecycle.js` (`createLifecycleController`), fed through the seven-factory seam in `src/adapters.js`; `src/runtime.js` remains the legacy authority (325 exports, release ID `taa-1.0.0`) and production wiring is unchanged. Boundaries are enforced by `test/tools/module-architecture.test.cjs`; the panel-vs-menu boundary on this page is enforced by `test/tools/readme-runtime-contract.test.cjs`.
