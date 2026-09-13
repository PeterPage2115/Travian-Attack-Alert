# Travian Attack Alert

Alliance attack, raid, and departure alerts from Travian to your own Discord server.

**Version 1.0.0, release ID `taa-1.0.0`. Release candidate under pilot, not yet declared public.**

The script (`Travian Attack Alert`, namespace `travian-attack-alert-public`) periodically reads the alliance members table on the canonical page and sends Discord alerts when attacks, raids, or departures appear. No bundler, framework, or runtime dependency is required in the browser. The installable file is `dist/travian-attack-alert.user.js`.

## What it does

- Opens the alliance members table and takes a snapshot of each member's attack and raid counts.
- Compares the new snapshot with the last accepted one and sends a Discord message for new attacks, raids, and departures.
- Mentions the configured Discord roles or mapped users in the alert, according to the mention policy described below.
- Retries failed deliveries and keeps recoverable queue state so an interrupted dispatch can be settled from the menu.

## What it does NOT do

- It has no backend. Everything runs in your browser tab.
- It gives no 24/7 guarantee. Alerts are produced only while your browser, with an active installation, sits on the canonical page.
- It is not exactly-once. Delivery is at-least-once, so a lost acknowledgement can deliver the same batch twice.
- It can miss short-lived events by design: events that appear and disappear between two reads cannot be inferred.
- It never removes Discord access automatically. When a player leaves, a moderator must revoke that player's Discord permissions by hand.
- A second computer or browser profile is a second sender. See [One active installation](#one-active-installation).

## Requirements

- Desktop Chrome with Tampermonkey: tested combination.
- Firefox with Tampermonkey, and Violentmonkey, are CANDIDATE-only until proven by the compatibility matrix.
- A Discord server where you can create your own webhook (you need the Manage Webhooks permission on the target channel).
- A Travian world where you are logged in and can open the alliance members page.

Mobile browser monitoring is unsupported. Receiving the alert messages in the mobile Discord app is separate and works as usual.

## Quick start

The Alerts tab shows a `Setup order` banner. Follow it in this order:

1. Open the canonical members route (see below).
2. Set the Discord webhook via the Tampermonkey menu.
3. Send the TEST alert with the `Send TEST alert to Discord` button.
4. Confirm an accepted scan in the Overview tab.

If Travian shows a login page, log in first. The monitor never scans a login page and never changes state there.

## Install from the local file

There is no download link and no update channel. Install from the local file `dist/travian-attack-alert.user.js` that ships with this candidate:

1. In Chrome, open `chrome://extensions` and enable Developer Mode. On Chrome 138 and newer, Tampermonkey additionally needs the browser's Allow User Scripts toggle (Tampermonkey FAQ Q209); without it, local script installation is blocked by the browser.
2. Open the Tampermonkey Dashboard, go to Utilities, and use Install from file, or drag the `.user.js` file into the browser window.
3. If the install is blocked or the script cannot see local files, enable file-URL access for Tampermonkey and check that site access is allowed.
4. Confirm the installed script shows name `Travian Attack Alert`, namespace `travian-attack-alert-public`, and version `1.0.0`.

If you previously ran the internal 6.2.1 line (historical internal development, never published), note that 1.0.0 is a lower number, so Tampermonkey treats it as a downgrade and will NEVER auto-update to it. Install the file by hand and disable the old script first so the two senders never run side by side. In Violentmonkey, a script is replaced only when namespace plus name match, so check both fields before confirming the replacement.

## Canonical page and permissions

The only page the monitor works on is the query-free alliance members route:

```text
https://<your-world>.travian.com/alliance/profile/members
```

The script matches `https://*.travian.com/alliance*`, but every other matched route shows inert guidance and never scans, writes, sends, or reloads. A members URL with a query string is also inert. The table must be the single structural members table; paginated or filtered views are rejected instead of guessed.

The active tab holds a Web-Lock lease and does the work. Any other open tab is a standby read-only view: it shows the same panel without mutation controls, and losing the lease disables mutations immediately while keeping recoverable queue state intact.

## Webhook setup (your own Discord)

1. In your Discord channel settings, create a webhook for attack alerts and copy its URL.
2. In Tampermonkey, open the userscript menu and choose `Set Discord webhook URL`, then paste the URL. The value is stored locally in the userscript storage. It is never logged and never shown in full.
3. `Show Discord webhook status` tells you whether a webhook is configured. `Clear Discord webhook URL` removes it after a typed confirmation.

Optional pings are configured separately and never replace each other:

- Attack role: set with `Set alert role ID`, cleared with `Clear alert role ID`, inspected with `Show alert role ID`. It is pinged when a batch contains attack or mixed events.
- Leave-moderator role: set with `Set leave-moderator role ID`, cleared with `Clear leave-moderator role ID`, inspected with `Show leave-moderator role ID`. It is pinged when a batch contains at least one departure.

A role pings only when the Discord role is set to Mentionable. A departing player is mentioned personally only when a Discord mapping for that Travian player already exists before the leave is observed.

## Synthetic TEST versus the detector scan

The Alerts tab button `Send TEST alert to Discord` sends a synthetic batch (`Send TEST batch to Discord`, with `[TEST] Player 1` and `[TEST] Player 2` entries) through your webhook and queue. A TEST proves that transport works. It never proves that the detector works, and it never touches the attack baseline.

Read the TEST feedback literally:

- `Discord TEST not sent — webhook is not configured. Set it via the Tampermonkey menu. Pending queue preserved.`
- `Discord TEST succeeded — transport works. This does not mean the monitor scan works.`
- `Discord TEST delivery issue — no acknowledgement. Failed/uncertain recovery stays in the Tampermonkey menu.`

A successful TEST next to a rejected scan means exactly that: Discord delivery works, the monitor scan does not. The two are reported independently and never merged into one claim.

## Normal operation

The panel (`Monitor views` tablist) has exactly four tabs: Overview (`taa-tab-overview`, read-only status and counts), Players (`taa-tab-players`, roster, mappings, mutes), Alerts (`taa-tab-alerts`, thresholds, attack and leave roles, test send), and Diagnostics (`taa-tab-diagnostics`, trace filters and exports).

Overview shows eight status lines: Runtime (`taa-operational-runtime-value`), Route (`taa-operational-route-value`), Session (`taa-operational-session-value`), Lease (`taa-operational-lease-value`), Scan (`taa-operational-scan-value`), Scan detail (`taa-operational-scan-detail-value`), Baseline (`taa-operational-baseline-value`), and Delivery (`taa-operational-delivery-value`).

Two lines deserve a first-read explanation:

- Baseline starts as `not established — the first accepted scan commits it silently (no historical flood)`. The first accepted scan sets the reference quietly so old attacks do not flood your channel.
- Delivery shows `webhook missing — configuration required; queue preserved` until a webhook is configured. Detections made before that stay queued instead of being dropped.

Failed and uncertain counts are visible in the Alerts tab. The recovery actions themselves live in the Tampermonkey menu: `Retry failed Discord batches`, `Retry uncertain Discord batches`, `Mark uncertain Discord batches delivered`, `Flush pending Discord batches`, plus `Toggle debug details` and `Load history and health`. Retry, flush, debug, and webhook work all belong to the Tampermonkey menu, never to the panel.

Two exports serve different jobs. The incident bundle (`Export incident bundle`, `taa-incident-bundle-export`) is the bounded and redacted first response for incidents: export it FIRST before touching anything; it carries no webhook, token, raw DOM, player data, queue payloads, URLs, cookies, or response bodies. The settings backup (`Export settings` / `Import settings`, collapsed under `taa-settings-details`) is the full-settings restore path: it restores mappings, settings, mutes, names, roster, and roles, and it carries the webhook secret only when you tick the `Include the Discord webhook secret in this file` checkbox (`taa-settings-export-webhook`, with the plain-JSON `taa-settings-export-warning` notice).

## One active installation

Run one active monitoring installation per alliance and world. Quoted operator rule:

> one active monitoring installation per alliance/world; a second computer or browser profile WILL double-send; the local lock cannot prevent it.

The Web-Lock lease fences tabs inside one browser profile only. A second computer, a second profile, or a parallel 6.x sender each elects its own leader and sends duplicates. When handing monitoring to someone else, the old sender must be disabled first, then silence confirmed, before the new one is enabled.

## Limits you should know

- Sampling: the monitor samples the table once per accepted document cycle. Anything that appears and vanishes between two accepted snapshots cannot be inferred.
- At-least-once delivery: HTTP 200 with a message ID acknowledges a batch. Network errors, timeouts, aborts, 429, and 5xx responses are retried; ordinary 4xx responses stay failed for manual recovery; a malformed or ID-less 200 stays uncertain and is never retried automatically. Any retry may duplicate.
- Background tabs, sleep, and sessions: a suspended laptop, a frozen background tab, or an expired Travian session stops scanning. After sleep or re-login, reopen the canonical route and check Overview before trusting alerts again. Counts shown are distinct member rows (Players), event deltas (attacks/raids), and Discord requests (messages); these quantities must not be substituted for each other.
- The 60-120-second reload lifecycle drives the monitor. Do not run two tabs expecting double coverage; the second tab is standby by design.

## Updates

Updates are manual local-file reinstalls. The local `.user.js` file has no update channel, and the script never auto-updates. To update, repeat the [Install from the local file](#install-from-the-local-file) steps with the new file and confirm the version shown by the manager. Never enable two senders at once during an update.

Anyone migrating from the internal 6.2.1 line (historical internal development) should read `docs/MIGRATION-6X.md`: export settings first, disable the old sender, keep site data, then install 1.0.0.

## Troubleshooting

Export the incident bundle FIRST, before touching anything. Then match your state:

- Webhook missing: Overview Delivery says `webhook missing — configuration required; queue preserved`. Set the webhook through the Tampermonkey menu. The queue is preserved, nothing is lost.
- Wrong page: the panel shows inert guidance instead of scan state. Open the exact query-free `/alliance/profile/members` route.
- Login page: log in on the Travian site first. The monitor never scans a login page and never mutates state there.
- Parser rejection: the Players tab shows `Live roster unavailable` with a reason code (`no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, `malformed-count`). Do not clear site data: the last accepted roster, mappings, and role configuration live in storage, and clearing destroys the only recoverable copies. Re-enter only the values proved absent by the `Storage provenance` labels.
- Failed batches: use `Retry failed Discord batches` from the Tampermonkey menu after checking the webhook configuration.
- Uncertain batches: choose `Mark uncertain Discord batches delivered` or `Retry uncertain Discord batches` from the Tampermonkey menu. A retry may duplicate.
- Still stuck: take the exported bundle to the issue template described below.

## Privacy

- Your Travian session stays in your browser. Credentials are not persisted and cookies are not read.
- Your webhook URL lives only in your userscript manager storage. It is validated as an HTTPS Discord webhook URL, stored without a query string, and never logged or displayed in full.
- The incident bundle is bounded (512 KiB) and redacted by construction.
- The settings backup omits the webhook secret by default; the file carries it only with your explicit opt-in checkbox.

## Reporting an issue safely

Include the script version (`1.0.0`), your browser and userscript manager versions, steps to reproduce, what you expected, and what happened instead. Attach the redacted incident bundle. NEVER include a webhook URL or token, cookies, passwords, raw page HTML, or player data beyond what the bundle already contains in redacted form.

## Polish guide and further docs

- Polish operator guide: `README.pl.md` (planned companion to this page; this English page stays primary).
- Daily operations: `docs/OPERATIONS.md` (planned).
- Migration from the 6.x line: `docs/MIGRATION-6X.md`.

## Voluntary support

Support for this project is entirely voluntary and optional. It has no influence on features, priorities, or fix timelines. There is no paid tier and nothing is locked behind support. The destination for voluntary support will be added by the maintainer.

## Version note

This page documents `1.0.0` (`taa-1.0.0`). Earlier 6.2.1-era behavior (historical internal development) is not part of this candidate's contract.
