# Daily operations

Operator routine for `Travian Attack Alert` version `1.0.0` (release ID `taa-1.0.0`).

This page covers daily use. Setup, install, and first-scan facts live in `README.md`; the Polish equivalent of this page is `docs/OPERATIONS.pl.md` and the Polish guide is `README.pl.md`. The English `README.md` stays primary.

## Morning routine

1. Open the exact query-free canonical route:
   ```text
   https://<your-world>.travian.com/alliance/profile/members
   ```
2. Open the Overview tab (`taa-tab-overview`) and read the eight status lines: Runtime (`taa-operational-runtime-value`), Route (`taa-operational-route-value`), Session (`taa-operational-session-value`), Lease (`taa-operational-lease-value`), Scan (`taa-operational-scan-value`), Scan detail (`taa-operational-scan-detail-value`), Baseline (`taa-operational-baseline-value`), and Delivery (`taa-operational-delivery-value`).
3. Confirm an accepted scan (Scan line) and an established baseline. The first accepted scan commits the baseline silently: `not established — the first accepted scan commits it silently (no historical flood)`.
4. Check the queue zeros: the Alerts tab (`taa-tab-alerts`) shows failed and uncertain counts. Both should be zero before the day starts. If not, see [Queue check](#queue-check).
5. If Delivery says `webhook missing — configuration required; queue preserved`, set the webhook through the Tampermonkey menu (`Set Discord webhook URL`) first. Detections stay queued, nothing is lost.

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

## Queue check

The Alerts tab shows failed and uncertain counts. The recovery actions live in the Tampermonkey menu:

- Failed batches: `Retry failed Discord batches`, after checking the webhook configuration.
- Uncertain batches: `Mark uncertain Discord batches delivered` or `Retry uncertain Discord batches`. A retry may duplicate.
- Pending drain: `Flush pending Discord batches`.
- Debug and history: `Toggle debug details`, `Load history and health`.

Failed means a permanent rejection (ordinary 4xx) kept for manual recovery. Uncertain means the acknowledgement was lost (malformed or ID-less 200) and is never retried automatically. Both stay recoverable; neither is dropped silently.

## Transfer from the 6.x line

Anyone moving a private 6.2.1 profile (historical internal development) to public 1.0.0 follows `docs/MIGRATION-6X.md`. Quoted order, not duplicated here: export a private settings backup on the old sender, disable the 6.x script and verify zero sends for a full cycle, install the 1.0.0 file as a new script, import the backup file or re-enter the webhook by hand, verify queue/baseline/config in Diagnostics, and only then enable monitoring. Never clear site data during the transfer; never copy cookies, profiles, or credentials. Public `1.0.0` is numerically lower than private `6.2.1`, so no manager offers it as an update. Rollback is re-importing the prior `.user.js` file, keeping site data, and reloading the canonical route.

## Updates 1.0.1 and 1.1.0

Updates are manual local-file reinstalls. The local `.user.js` file has no update channel, and the script never auto-updates. To update to 1.0.1 or 1.1.0 when published, repeat the install-from-local-file steps from `README.md` with the new file and confirm the version shown by the manager. Never enable two senders at once during an update.

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

Export the incident bundle FIRST, before touching anything: Diagnostics tab (`taa-tab-diagnostics`), `Export incident bundle` (`taa-incident-bundle-export`). The bundle is bounded (512 KiB) and redacted by construction: no webhook, token, raw DOM, player data, queue payloads, URLs, cookies, or response bodies.

Then match your state:

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

- Script version (for example `1.0.0`).
- Browser version and userscript manager version (for example Tampermonkey version).
- Steps to reproduce (what page, what tab state, what you clicked, in order).
- What you expected to happen.
- What happened instead (exact status lines and reason codes, quoted).
- Redacted incident bundle attached (yes or no).

## Version note

This page documents `1.0.0` (`taa-1.0.0`). Earlier 6.2.1-era behavior (historical internal development) is not part of this candidate's contract.
