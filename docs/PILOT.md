# Pilot Checklist — 1.0.0 external alliance trial (unpublished)

This checklist is for YOU, the pilot operator: a second person running the
trial on your own equipment. Nobody installs anything for you, and you share
no credentials with anyone. You use your own device, your own browser, your
own Travian login, and your own Discord webhook.

Purpose: one external alliance trial of the 1.0.0 release candidate. You
install the local candidate file, connect it to a Discord channel you
control, send a marked TEST, and confirm the monitor scans and reports
honestly. Nothing here publishes anything.

> REAL-PILOT STATUS: `NOT EXECUTED — awaiting owner-run trial`
>
> No second person has run this checklist yet. The walkthrough so far used a
> synthetic operator persona against loopback fixtures only
> (`test-results/release-1.0.0/readme-walkthrough.json`,
> `test-results/release-1.0.0/docs-equivalence.json`). Your completed run is
> what flips `pilotReady` (see `docs/VERDICTS.md`).

## What you need before you start

- Your own computer with desktop Chrome and Tampermonkey installed.
  Tampermonkey on Chrome 138 and newer needs the browser's Allow User Scripts
  toggle (Tampermonkey FAQ Q209); without it, local script installation is
  blocked by the browser.
- A Travian world where you are logged in and can open your alliance members
  page.
- A Discord channel where you hold the Manage Webhooks permission, so you can
  create your own webhook.
- The candidate file `dist/travian-attack-alert.user.js` handed to you
  locally (there is no download link and no update channel).
- NO credentials shared with anyone: no passwords, no cookies, no browser
  profile copies, no session exports. If anyone asks you for these, stop and
  report it.

## Steps (in this order)

1. Install the candidate file in YOUR manager. In the Tampermonkey Dashboard
   go to Utilities and use Install from file with
   `dist/travian-attack-alert.user.js`. Confirm the installed script shows
   name `Travian Attack Alert`, namespace `travian-attack-alert-public`, and
   version `1.0.0`.
2. Open YOUR world on the canonical route:
   `https://<your-world>.travian.com/alliance/profile/members`
   (no query string). Any other matched page shows inert guidance and never
   scans; that is intended.
3. Set YOUR webhook via the Tampermonkey menu (`Set Discord webhook URL`) and
   paste the URL you created. The value stays in your userscript storage. It
   is never logged and never shown in full.
4. Send the marked TEST from the Alerts tab (`Send TEST alert to Discord`).
   Read the feedback literally:
   `Discord TEST succeeded — transport works. This does not mean the monitor
   scan works.` A TEST proves transport only, never the detector scan, and it
   never touches the attack baseline.
5. Confirm an accepted scan in the Overview tab. Check the Scan line shows an
   accepted state and the Baseline line explains itself
   (`not established — the first accepted scan commits it silently (no
   historical flood)` on first run). A successful TEST next to a rejected
   scan means exactly that: Discord delivery works, the monitor scan does
   not. The two are reported independently.
6. Check lease owner, queue zeros, and diagnostics. Overview Lease should show
   your tab as owner; the Alerts tab failed/uncertain counts should read zero
   after a clean TEST; Diagnostics should show the trace stages
   (`route`, `lease`, `snapshot`, `diff`, `filter`, `queue`, `dispatch`,
   `reload`) with `ok` outcomes.
7. Export the incident bundle from the Diagnostics tab
   (`Export incident bundle`). This is the bounded (512 KiB) and redacted
   first response for any problem: it carries no webhook, token, raw DOM,
   player data, queue payloads, URLs, cookies, or response bodies. Export it
   FIRST, before touching anything, whenever something looks wrong.

## Stop rules (abort instead of working around)

- Two senders: if you discover another active installation watching the same
  alliance and world (a second computer, a second browser profile, or the old
  internal 6.x script still enabled), STOP. Quoted operator rule: "one active
  monitoring installation per alliance/world; a second computer or browser
  profile WILL double-send; the local lock cannot prevent it." Disable the
  old sender first and confirm silence for one full monitor cycle (60 to 120
  seconds) before you enable the new one. Never run two senders side by side,
  not even during an update. See `docs/MIGRATION-6X.md` for the owner
  transfer order.
- Login wall: if Travian shows a login page, log in yourself on the Travian
  site first. The monitor never scans a login page and never changes state
  there. Never share your session or credentials to get past it.
- Parser rejection: if the Players tab shows `Live roster unavailable` with a
  reason code (`no-member-table`, `multiple-member-tables`,
  `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`,
  `conflicting-tooltip`, `malformed-count`), export the incident bundle first
  and report it. Do not clear site data: the last accepted roster, mappings,
  and role configuration live in storage, and clearing destroys the only
  recoverable copies.

## Reporting back

Fill in the issue template (`.github/ISSUE_TEMPLATE/bug_report.yml`):
script version (`1.0.0`), your browser and manager versions, steps to
reproduce, what you expected, and what happened instead. Attach the redacted
incident bundle. NEVER include a webhook URL or token, cookies, passwords,
raw page HTML, or player data beyond what the bundle already contains in
redacted form. Send nothing containing secrets, and post no public message
about this candidate; the trial is unpublished until the owner decides
otherwise.

## Follow-up note (automation, not your job)

If a later automated run is needed instead of a hand install, the recorded
follow-up is the Violentmonkey unpacked path: build Violentmonkey from its
public repo and load it unpacked into a test profile (no store, no login, no
proprietary bits). That path was verified reachable but never executed; it
does not change your hand-install steps above.
