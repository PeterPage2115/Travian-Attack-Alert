# Daily operations

Operator routine for `Travian Attack Alert` version `1.0.2` (release ID `taa-1.0.2`).

This page covers daily use. Setup, install, and first-scan facts live in `README.md`; the alert payload contract is `docs/ALERT-FORMAT.md`; the Polish equivalent of this page is `docs/pl/OPERATIONS.md`. The English `README.md` stays primary.

> **Panel layout.** The Overview described here is the simplified layout shipped with `1.0.2`: plain-language status and the next action first, detail behind small collapsed groups. A `1.0.1` install shows the same values in one flat list — nothing is hidden, only regrouped.

## Morning routine

1. Open the exact query-free canonical route:
   ```text
   https://<your-world>.travian.com/alliance/profile/members
   ```
2. Open the Overview tab (`taa-tab-overview`). It leads with plain-language status and the next action: the operational lines Runtime (`taa-operational-runtime-value`), Route (`taa-operational-route-value`), Lease (`taa-operational-lease-value`), Scan (`taa-operational-scan-value`), Baseline (`taa-operational-baseline-value`) and Delivery (`taa-operational-delivery-value`), followed by the status metrics Freshness, Scan result, Failed / uncertain, Storage health, Queue / in flight, Last authoritative observation, Next refresh and Last sent.
3. The detail sits in collapsed groups next to what it explains, not in a longer list: `Scan reason and outcome` (`taa-operational-scan-detail-details`) beside the Scan line, `Raw counters` (`taa-overview-raw-details`) for Scan duration and Queue age, the former Session line folded into Storage health (`taa-storage-health-value`), and in Diagnostics the groups `Storage detail` (`taa-storage-provenance-details`), `Filters and recent traces` (`taa-trace-details`) and `Overflow and export bounds` (`taa-bounded-details`).
4. Confirm an accepted scan (Scan line) and an established baseline. The first accepted scan commits the baseline silently: `not established — the first accepted scan commits it silently (no historical flood)`.
5. Check the queue zeros: the Alerts tab (`taa-tab-alerts`) shows failed and uncertain counts. Both should be zero before the day starts. If not, see [Queue check](#queue-check) and [What the red states mean](#what-the-red-states-mean).
6. If Delivery says `webhook missing — configuration required; queue preserved`, set the webhook through the Tampermonkey menu (`Set Discord webhook URL`) first. Detections stay queued, nothing is lost.

If Travian shows a login page, log in first. The monitor never scans a login page and never changes state there.

## Active device, browser, session

Alerts are produced only while all of these hold at the same time:

- One active device runs the monitor. A second computer is a second sender.
- One browser profile holds the work. A second profile elects its own leader and sends duplicates.
- One session stays logged in on Travian. An expired session stops scanning.
- One tab sits on the canonical page. The active tab holds a Web-Lock lease and does the work; any other open tab is a standby read-only view.

Monitoring in a desktop browser tab and receiving alert messages in the mobile Discord app are two separate things. Browser monitoring on mobile is unsupported; receiving the alerts on a phone works as usual.

## Background tabs, sleep, and throttling (honest results)

What this repository measured:

- The panel reflows without horizontal scroll at 375 px, 768 px, and 1280 px viewports, at 200% zoom, and under reduced-motion and forced-colors paths (Playwright matrix, all suites green).
- The monitor is driven by the 60-120-second reload lifecycle. Sampling happens once per accepted document cycle; events that appear and vanish between two accepted snapshots cannot be inferred.

What was NOT proven, and is therefore NOT promised:

- Background-timer throttling is browser-controlled and unguaranteed. This repository did not measure sustained background-tab delivery, and timer behavior in a frozen or throttled background tab was NOT proven on any manager.
- There is no 24/7 claim and no exactly-once claim. Delivery is at-least-once: any retry may duplicate.
- A suspended laptop, a frozen background tab, or an expired Travian session stops scanning. After sleep or re-login, reopen the canonical route and check Overview before trusting alerts again.

Never promise continuous background coverage. The only trustworthy state is what the Overview lines show right now.

## Safe handover to another operator

Quoted operator rule:

> one active monitoring installation per alliance/world; a second computer or browser profile WILL double-send; the local lock cannot prevent it.

Hand over in this order:

1. Disable the old sender first (Tampermonkey dashboard, or disable its match host).
2. Confirm silence: no new Discord messages arrive for one full monitor cycle (60-120 s). Only proceed when the old sender is provably silent.
3. Enable the new installation. Confirm a single active installation (one script, one browser profile, one computer) before trusting its alerts.

Never run the old and the new sender at the same time, not even briefly. The Web-Lock lease fences tabs inside one browser profile only.

## What the red states mean

Three states look alarming and mean three different things. None of them settles itself, and none of them means monitoring keeps covering you while you are away:

- **Uncertain delivery.** Discord answered HTTP 200 but the reply carried no usable message id (a malformed or non-JSON body), so the script cannot prove the message exists. It is never retried automatically — a human settles every one — and the queue holding it is bounded at 512 records, so nothing grows without limit. Settle it from the Tampermonkey menu, see [Queue check](#queue-check).
- **Stale observation.** `Freshness` reads `Stale — observed <N>s ago` once the last authoritative observation is older than 120 seconds. Stale means "no current observation", not "no alert" and not "still covered": re-open the canonical route and read Overview again before trusting alerts.
- **Rejected scan.** The document was refused, so no scan was applied. The Scan line shows `parser-rejected/<reason>` (also `readiness-timeout/rejected`, `lease-lost/rejected`, `reload-blocked/rejected`) and `Scan reason and outcome` shows `reason <code> · outcome rejected`. Nothing is written by a rejected scan: do not clear site data to "fix" it — re-enter only the values proved absent by the `Storage provenance` labels.

Colour only reinforces these words; the panel never paints a failing fact green.

## Queue check

The Alerts tab (`taa-tab-alerts`) shows the failed and uncertain counts next to the `Failed / uncertain delivery` banner, and every recovery action lives in the Tampermonkey menu — never in the panel:

- Failed batches: `Retry failed Discord batches`, after checking the webhook configuration. Failed means a permanent rejection (ordinary 4xx) kept for manual recovery.
- Uncertain batches: the acknowledgement was lost (a 200 with no usable message id), so the message cannot be proved to exist. Never retried automatically; a human settles every one from this menu — `Mark uncertain Discord batches delivered` (you found the message in Discord) or `Retry uncertain Discord batches` (you did not; a retry may duplicate). While you investigate, `Toggle debug details` turns on verbose debug output and `Load history and health` loads the recorded history.
- Pending drain: `Flush pending Discord batches`.

Neither state is dropped silently and neither settles itself; both stay recoverable by hand.

## Leave-moderator role configuration

The departure ping is configured on the Alerts tab (`taa-tab-alerts`) or via the Tampermonkey menu. The four panel controls are `taa-leave-role-input` (paste the Discord role ID), `taa-leave-role-set` (save it), `taa-leave-role-clear` (remove it), and `taa-leave-role-current` (show the stored value). Both role IDs live in `travianAllianceDiscordConfig_v1` and are validated by `validateDiscordRoleId`. A role pings only when its Discord role is Mentionable; a departing player is personally mentioned only when a pre-existing `mappings[hostname][playerId]` mapping already exists. Configuring the leave role never removes Discord access: when a player leaves, a moderator must revoke that player's Discord permissions by hand.

## Transfer from the 6.x line

Anyone moving a private 6.2.1 profile (historical internal development) to public 1.0.2 follows `docs/MIGRATION-6X.md`. Quoted order, not duplicated here: export a private settings backup on the old sender, disable the 6.x script and verify zero sends for a full cycle, install the 1.0.2 file as a new script, import the backup file or re-enter the webhook by hand, verify queue/baseline/config in Diagnostics, and only then enable monitoring. Never clear site data during the transfer; never copy cookies, profiles, or credentials. Public `1.0.2` is numerically lower than private `6.2.1`, so no manager offers it as an update. Rollback is re-importing the prior `.user.js` file, keeping site data, and reloading the canonical route.

## Updates

The script carries an `@updateURL` channel pointing at the default release branch `release/public-1.0.0` (`main` does not exist on the remote), so managers that honor it update automatically from the corrected raw dist file:

```text
https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/release/public-1.0.0/dist/travian-attack-alert.user.js
```

A new version can also be applied by repeating the install-from-file steps from `README.md` with the new file and confirming the version shown by the manager. Never enable two senders at once during an update.

Already-installed `1.0.0` copies that embedded the old broken URL cannot self-heal at the same version: a same-version install never triggers an update, and the stale embedded URL never resolves. Reinstall `1.0.0` from the corrected URL or file above (or re-run the install-from-file steps), keep all site data untouched, and confirm the version shown by the manager.

If the new version misbehaves, roll back: disable the new script, re-import the prior `.user.js` file (or re-enable the kept old script entry), keep all site data untouched (do not clear storage: roster, mappings, baselines, and queue state live there), reload the canonical route, and verify the monitor resumes with its queue intact.

## Private backup

The settings backup (`Export settings` / `Import settings`, collapsed under `taa-settings-details`) is the full-settings restore path: it restores mappings, settings, mutes, names, roster, and roles.

- Default export omits the webhook secret. The file carries no secret unless you opt in.
- Opt-in checkbox `Include the Discord webhook secret in this file` (`taa-settings-export-webhook`) includes the secret in plain, readable JSON, with the plain-JSON notice (`taa-settings-export-warning`). Treat an opt-in file as a secret: store it where only you can read it, never post it, never attach it to an issue.
- A file without a webhook field preserves the stored webhook on import (absent means preserve, never clear). `{action:"clear"}` clears explicitly. A failed import rolls back everything; a rejected file (`invalid-fields`) writes nothing.

## Uninstall versus data deletion

Removing the script and deleting its data are two separate, destructive-different acts:

- Uninstall (remove script): disable or delete the `Travian Attack Alert` entry in the Tampermonkey dashboard. This stops scanning and sending. Stored queue, roster, mappings, and settings remain where they are until you delete them explicitly.
- Delete data (separate explicit act): clear the userscript storage for this script identity (webhook, config, mappings) and the site localStorage for the Travian origin (roster, baselines, queue, diagnostics). WARNING: this destroys the only recoverable copies of the roster, mappings, baselines, and queue state. There is no undo. Do this only when you mean to abandon the monitored state entirely, never as a troubleshooting step.

Never clear site data to "fix" a rejected scan. Re-enter only the values proved absent by the `Storage provenance` labels.

## Troubleshooting (diagnostics first)

Export the incident bundle FIRST, before touching anything: Diagnostics tab (`taa-tab-diagnostics`), `Export incident bundle` (`taa-incident-bundle-export`). The bundle is bounded (512 KiB) and redacted by construction: no webhook, token, raw DOM, player data, queue payloads, URLs, cookies, or response bodies. The Diagnostics detail sits behind three collapsed groups: `Storage detail` (`taa-storage-provenance-details`, holding the `Storage provenance` labels), `Filters and recent traces` (`taa-trace-details`, holding the scan/stage/outcome filters, the trace count and the last 32 traces), and `Overflow and export bounds` (`taa-bounded-details`, holding the queue overflow count and the 512 KiB export bound).

Then match your state:

- No script running at all: on Chrome 138 and newer, Tampermonkey 5.3+ needs the browser's `Allow User Scripts` toggle (or Developer Mode) enabled; this is Tampermonkey FAQ Q209. With that permission off, the browser runs no userscript at all: there is no panel, no Tampermonkey menu entry, no scan, and no alert, and the script cannot diagnose the condition because it never executes. Enable `Allow User Scripts` (or Developer Mode), reload the page, then reinstall the script.
- Webhook missing: Overview Delivery says `webhook missing — configuration required; queue preserved`. Set the webhook through the Tampermonkey menu. The queue is preserved, nothing is lost.
- Wrong page: the panel shows inert guidance instead of scan state. Open the exact query-free `/alliance/profile/members` route.
- Login page: log in on the Travian site first. The monitor never scans a login page and never mutates state there.
- Parser rejection: the Players tab (`taa-tab-players`) shows `Live roster unavailable` with a reason code (`no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, `malformed-count`). Do not clear site data. Re-enter only the values proved absent by the `Storage provenance` labels.
- Failed batches: `Retry failed Discord batches` from the Tampermonkey menu after checking the webhook configuration.
- Uncertain batches: `Mark uncertain Discord batches delivered` or `Retry uncertain Discord batches` from the Tampermonkey menu. A retry may duplicate.
- TEST versus scan confusion: `Send TEST alert to Discord` proves transport only. Read its feedback literally: `Discord TEST not sent — webhook is not configured. Set it via the Tampermonkey menu. Pending queue preserved.`, `Discord TEST succeeded — transport works. This does not mean the monitor scan works.`, `Discord TEST delivery issue — no acknowledgement. Failed/uncertain recovery stays in the Tampermonkey menu.` A successful TEST next to a rejected scan means Discord delivery works and the monitor scan does not.
- Still stuck: take the exported bundle to the incident template below.

## Incident template (no secrets)

Copy these fields into the issue. Attach the redacted incident bundle. NEVER include a webhook URL or token, cookies, passwords, raw page HTML, queue payloads, or player data beyond what the bundle already contains in redacted form.

- Script version (for example `1.0.2`).
- Browser version and userscript manager version (for example Tampermonkey version).
- Steps to reproduce (what page, what tab state, what you clicked, in order).
- What you expected to happen.
- What happened instead (exact status lines and reason codes, quoted).
- Redacted incident bundle attached (yes or no).

## Version note

This page documents `1.0.2` (`taa-1.0.2`). Earlier 6.2.1-era behavior (historical internal development) is not part of the current release's contract.

## Implementation map

The behavior above is implemented by 13 domain modules under `src/` (each an `X.js` facade over its `X-impl.js` contract; `storage` spans 12 sub-modules), aggregated reference-equal by `src/runtime-api.js` with no `select()` indirection. Mutable lifecycle state is owned solely by `src/lifecycle.js` and fed through the seven factories in `src/adapters.js`; `src/runtime.js` remains the legacy authority (`taa-1.0.2`) and production wiring is unchanged. The authoritative map is `docs/architecture.md` §10, enforced by `test/tools/module-architecture.test.cjs`. Nothing here changes operations: the panel/menu split, routes, and recovery steps above are exactly as stated.
