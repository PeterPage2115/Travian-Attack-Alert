# Travian – Alliance Alerts to Discord

Userscript Tampermonkey **6.2.1** detects alliance attacks/raids and forwards
new attack alerts through a durable Discord workflow. The single distributable
is `script.txt`; no bundler, framework, or runtime dependency is required in
the browser.

## Requirements and installation

- Tampermonkey in Chrome, Firefox, or Edge.
- A Discord server where you can create a webhook for attack alerts.
- Node.js 18+ only for the offline test suite.

In Tampermonkey, import `script.txt` from **Utilities → Import from file**, or
paste it into a new script, save with Ctrl+S, then open the canonical
same-origin route:

```text
/alliance/profile/members
/alliance/profile/members/
```

Only the query-free `/alliance/profile/members` route may acquire authority.
Other matched `/alliance*` routes show inert guidance and never scan, write,
send, or reload; query-filtered member URLs are also inert. Exactly one
structural `table.allianceMembers` is required; there is no
largest-profile-link fallback. Runtime route roles are `canonical-member`,
`alliance-noncanonical`, and `unsupported`. Table rejection reasons are
`no-member-table`, `multiple-member-tables`, `pagination-or-filter`,
`missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, and
`malformed-count`.

One lease-holding tab is authoritative. Other tabs are visible
standby/read-only views; a second tab is not required. The existing
60–120-second reload lifecycle drives the attack monitor.

## Configuration and privacy

Configure the attack webhook in the Tampermonkey menu (`Set Discord webhook URL`).
Manage recipients, thresholds, and role allowlists in the panel or the menu.
Attack webhook, queue, baselines, diagnostics, and storage keys are isolated
per hostname. Discord role configuration is global
and stored in `travianAllianceDiscordConfig_v1` as `{ roleId, leaveRoleId }`,
both validated by `validateDiscordRoleId`.

* **Attack role (`roleId`)**: optional Discord role pinged when the batch contains `attack` or `mixed` events. Set it in the `alerts` tab field `taa-alert-role` with `taa-alert-role-save`, or via Tampermonkey menu `Set/Clear/Show alert role ID`.
* **Leave-moderator role (`leaveRoleId`)**: separate global role pinged when the batch contains at least one `leave` event. Configure it in the `alerts` tab as `Leave-moderator role` (`taa-leave-role-input`, `taa-leave-role-set`, `taa-leave-role-clear`, `taa-leave-role-current`) or via Tampermonkey menu `Set/Clear/Show leave-moderator role ID`. It does not replace the attack role, both can fire together in a mixed batch.

Departure mention behavior has four operator-visible conditions:

1. A departing player is personally mentioned as `<@userId>` only if a mapping `mappings[hostname][playerId]` for that Travian `playerId` already exists before the leave is observed. Without that pre-existing mapping, no personal ping is produced.
2. Departures additionally ping the leave-moderator role `<@&leaveRoleId>` when at least one `leave` event is present. This role is global and distinct from the attack role, mixed batches include both roles in deterministic order.
3. The script never removes Discord access automatically. A moderator must manually revoke the departed player's Discord permissions after receiving the leave alert.
4. A role pings only when its Discord role is set to Mentionable and its ID is present in `allowed_mentions.roles`. Delivery is at-least-once, so a lost acknowledgement can produce the same first request twice even when mention policy is otherwise once-only.

Webhook values are validated HTTPS Discord webhook URLs and stored without a
query string. `wait=true` exists only in the in-memory send URL. There is no
cookie handling: credentials are not persisted and browser cookies are not read.
No `/map.sql` route is used; the string `/map.sql` is not a route used by this
release.

Upgrade note: if you previously used alliance news, previous news data remains
inert until you clear site data. Existing `travianAllianceDiscordConfig_v1`
values without `leaveRoleId` normalize to `{ roleId, leaveRoleId: null }`, and corrupted
role IDs normalize to `null` without throwing.

## Attack alerts

The approved hierarchy is short and delta-first:

- `🚨 Alliance attack`, `🛡️ Alliance raid`, or `🔄 Alliance changes`, with a
  linked title and singular/plural player count.
- Non-roster entries are atomic two-line blocks; roster entries are one line.
- The first embed has exactly `New`, `Active now`, and `Priority` fields, in
  that order. Continuations repeat global context.
- The footer is `<hostname> · <observation-text>`. One logical dispatch timestamp
  is placed on the last embed of every request.
- Multi-request output adds `part X/Y`; continuations repeat global context.
- Mentions occur once only; continuations use empty mention allowlists.
- Discord limits use JavaScript UTF-16 `.length`: content 2000, title 256,
  description 4096, field name 256, field value 1024, total embed text 6000,
  and at most 10 embeds per request.

Payloads use safe links in DOM order and mention policy is explicit. `allowed_mentions` is an explicit allowlist with no `parse` key. The first request of a batch may carry `content` such as `<@&leaveRoleId> <@userId>` together with `allowed_mentions` like `{ users: ["123456789012345678"], roles: ["987654321098765432"] }`, or `{ users: [] }` when no one is mentioned. Continuations use empty `content` with `{ users: [] }` and no `roles` key, and the list is bounded and deduplicated to fit the 2000 character content limit. Embed titles, descriptions, field values and footers never contain mention tokens, mentions live only in top-level `content`. Partial, repeated, malformed, or ambiguous input does not change authoritative
state; acquisition is rejected without partial state and authoritative state
remains unchanged.

The following bytes are generated from the live canonical raid builder:

<!-- discord-alert-example:start -->
```text
🛡️ Alliance raid · 2 players
**Players**
[Lenny Barre](https://cw.x2.international.travian.com/profile/101) — **+1 raid**
Now: 0 attacks / 1 raid

[Quinnos](https://cw.x2.international.travian.com/profile/102) — **+1 raid**
Now: 0 attacks / 1 raid
New: **+2 raids**
Active now: 0 attacks / 2 raids
Priority: Normal
cw.x2.international.travian.com · Observed <1s before dispatch
Timestamp: 2026-08-23T09:46:01.000Z
```
<!-- discord-alert-example:end -->

The attack and mixed-alert grammar is also captured from the live canonical
attack fixture:

<!-- discord-attack-example:start -->
```text
🚨 Alliance attack · 6 players
**Players**
[Player 365](https://cw.x2.international.travian.com/profile/365) — **+2 attacks**
Now: 17 attacks / 5 raids

[sandla](https://cw.x2.international.travian.com/profile/1) — **+2 attacks**
Now: 7 attacks / 7 raids

[Ariadne](https://cw.x2.international.travian.com/profile/2) — **+1 attack** · **+1 raid**
Now: 8 attacks / 1 raid

[Borek](https://cw.x2.international.travian.com/profile/3) — **+1 attack** · **+1 raid**
Now: 6 attacks / 2 raids

[Ciri](https://cw.x2.international.travian.com/profile/4) — **+1 attack** · **+1 raid**
Now: 7 attacks / 1 raid

[Darek](https://cw.x2.international.travian.com/profile/5) — **+1 attack**
Now: 7 attacks / 1 raid
New: **+8 attacks** · **+3 raids**
Active now: 52 attacks / 17 raids
Priority: Normal
cw.x2.international.travian.com · Observed <1s before dispatch
Timestamp: 2026-08-23T09:46:01.000Z
```
<!-- discord-attack-example:end -->

No historical or guessed time is invented. Missing observation time remains
`Observation time unavailable`; inherited timestamps remain marked approximate observation. Delivery is
**at-least-once**: a lost acknowledgement can produce a duplicate. HTTP 200
with a message ID acknowledges; network/timeout/abort/429/5xx retries, ordinary
4xx is retained as failed, and malformed or ID-less 200 is uncertain and is
not retried automatically.

## Recovery and accessibility

### Operations, sampling, and diagnostics

The monitor samples the canonical member table once per accepted document
cycle. Every positive net attack/raid delta visible between two accepted
snapshots is represented; arrivals that occur and disappear between samples
cannot be inferred. **Players** counts distinct member rows, **attacks/raids**
count event deltas, and **messages** count Discord requests; these quantities
must not be substituted.

The runtime authority is `script.txt`, identified by release ID `taa-6.2.1`.
`npm run build` does not generate `script.txt` from source wrappers; it only
refreshes the module manifest and artifact metadata hashes for the checked-in
distributable.

For an incident, first export **Export incident bundle**, then filter traces by
scan ID, stage, and outcome. Walk `route → lease → snapshot → diff → filter →
queue → dispatch → reload`, starting at the first rejected/error state. The
bounded, redacted bundle excludes raw DOM, player data, queue payloads, URLs,
webhook values, cookies, and response bodies.
The terminal `readiness-timeout/rejected` outcome is tied to its bounded cycle
ID; filter by that cycle ID so later generic lifecycle traces cannot mask it.

### Panel versus Tampermonkey menu

The panel (`Monitor views` tablist) is daily work with exactly four tabs:
Overview (`taa-tab-overview`, read-only status and counts), Players
(`taa-tab-players`, roster, mappings, mutes), Alerts (`taa-tab-alerts`,
thresholds, attack/leave roles, test send), and Diagnostics
(`taa-tab-diagnostics`, trace filters and exports). Recovery mutations live in
the Tampermonkey menu: webhook setup (`Set`, `Clear`, `Show Discord webhook
URL`), retry (`Retry failed Discord batches`, `Retry uncertain Discord
batches`), uncertain settlement (`Mark uncertain Discord batches delivered`),
queue drain (`Flush pending Discord batches`), and debug commands
(`Toggle debug details`, `Load history and health`). The Alerts tab shows failed/uncertain
counts, but the recovery actions themselves are menu commands. Standby tabs
show the same panel read-only; noncanonical routes show inert guidance and
never scan, write, send, or reload.

Two exports serve different jobs. The incident bundle (**Export incident
bundle**, `taa-incident-bundle-export`) is the bounded, redacted first response
for incidents: export it FIRST before touching anything; it excludes raw DOM,
player data, queue payloads, URLs, webhook values, cookies, and response
bodies. The settings backup (**Export settings** / **Import settings**,
collapsed under `taa-settings-details`) is the full-settings restore path: it
carries mappings, settings, mutes, names, roster, roles, and the webhook, with
the webhook masked only in the preview.

When the member scan fails, follow this non-destructive incident sequence:

1. Use **Export incident bundle** first, before touching anything.
2. Open the **Players** tab and inspect the state labels: a rejected live
   parse shows `Live roster unavailable — showing last accepted roster
   (N players). Reason: <code>` with the last accepted roster, or
   `Live roster unavailable — no accepted roster is stored. Reason: <code>`
   when nothing was ever accepted. The `Storage provenance` banner says
   `mapping data not found (storage key is absent).` /
   `role configuration not found (storage key is absent).` only when the keys
   are genuinely absent — absent configuration is not a parse failure, and a
   stale cached roster never masquerades as live.
3. Do NOT clear site data: the last accepted roster, mappings, and role
   configuration live in storage, and clearing destroys the only recoverable
   copies.
4. Re-enter only the values proved absent by the provenance labels. Mappings
   stored for another world are reported as other-world data and are never
   copied automatically; malformed values are never normalized or written.

Web-Lock fencing requires one exclusive same-origin lock, lease owner/term,
expected monitor generation, and post-write readback to agree before an
authority mutation. Lease loss disables mutations and leaves recoverable queue
state intact. Diagnostic labels are `route`, `lease`, `snapshot`, `diff`,
`filter`, `queue`, `dispatch`, and `reload`; statuses are `ok`, `rejected`,
`overflow`, and `error`.

Storage is compatible with additive schema-1 upgrades. Existing baseline,
pending, in-flight, failed, uncertain, configuration, and webhook keys remain
readable; missing additive fields receive safe defaults. Roll back by importing
the prior `script.txt`, preserving site data, and reloading the canonical route.
Do not delete storage during rollback.

Before recovery, export the incident bundle from the Diagnostics tab; exports
are bounded, sanitized, and never include webhook tokens or full query URLs.
Then use the Tampermonkey menu: `Retry failed Discord batches` after checking
configuration. For uncertain delivery choose `Mark uncertain Discord batches
delivered` or `Retry uncertain Discord batches` (may duplicate).

Legacy queue records retain an injective `ls1:` provenance identity during
upgrade. History-only records use separate `lh1:` provenance and remain
`unknown-legacy`; they are not delivery acknowledgements. If an older script
removed an active queue record, recovery marks it `uncertain-legacy-settlement`
and never treats the removal as acknowledged.

The panel shows queue counts, failure state, diagnostics, and exports; webhook
setup and retry/flush/debug actions live in the Tampermonkey menu. Standby is
read-only; lease loss disables mutations immediately. Controls are native labelled elements with truthful
`aria-selected`, `aria-controls`, `aria-invalid`, `aria-busy`, and live status
feedback. Focus returns after Escape, backdrop, Close, and reload decisions.
At 375 px, 768 px, 1280 px, and 200% zoom, content reflows without horizontal
scroll; IDs and URLs wrap. Reduced motion and forced-colors paths are explicit.

The superseded `.omo/plans/refine-discord-alert-hierarchy.md` hierarchy plan and
`.omo/plans/redesign-alliance-news-discord-format.md` format plan are historical
input only. Their 5.2.6-era contract is historical; the current 6.2.1 contract
is the one documented above and neither plan is executed separately.

## Offline verification

```bash
node -e "new Function(require('fs').readFileSync('script.txt','utf8'))"
node --test test/script.test.cjs
npm test
npm run build
npm run check:artifact
npm run check:types
npm run quality -- --gate todo14-final
node test/fixtures/discord/static-format-audit.cjs --file script.txt --readme README.md
```

Tests use deterministic loopback fixtures only. They do not make production
tile requests, access cookies, send a real webhook, or access external
Travian/map projects.
