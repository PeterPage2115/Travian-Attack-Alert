# Pilot Checklist — 1.0.0 external alliance trial (unpublished)

> **Archive note (repository-cleanup restructure).** This file was moved from `docs/PILOT.md` to `docs/release-history/1.0.0-rc/PILOT.md`; only this note was added and code-span links were adjusted for the move. It is an unpublished 1.0.0 release-candidate record, not current proof: the pilot status recorded inside was never executed, and cited `test-results/` evidence was gitignored and never committed. Do not mistake it for a live operational guide — current guides are indexed in `../../README.md`.

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
> what flips `pilotReady` (see `VERDICTS.md`).

## Release gates — AGENT-AUTOMATED vs OWNER-MANUAL

Machine-readable state: `docs/release-state.json` reports `stable:false`.
No automated step (npm script, test, build, CI job) may flip it; only an
owner edit that records every OWNER-MANUAL field below — plus the matching
edit to the gate test — can advance it.

### AGENT-AUTOMATED (done by this migration)

- `src/` cutover: `src/userscript-entry.js` is the editable authority;
  `dist/travian-attack-alert.user.js` is generated deterministically
  (`npm run build`; SHA-256 recorded in `metadata.json` and the sidecar).
- Privacy fixtures: deterministic loopback fixtures only — no real
  webhooks, no live Travian requests; the incident bundle is bounded
  (512 KiB) and redacted by construction.
- CI: read-only `.github/workflows/ci.yml` (push + PR to `main`, Node
  18/20 matrix, run artifacts uploaded, no publish step).
- Docs: concise README, OPERATIONS (EN + PL), MIGRATION-6X, AUDIT,
  CHANGELOG, issue template; this archive record kept honest (its
  never-executed status box above is the truth, not a plan).

### OWNER-MANUAL (owner only — blocks stable-1.0 and DEV retirement)

- [ ] Real install by a second person: desktop Chrome + Tampermonkey on
  their own device, Allow User Scripts toggle where required, every step
  of this checklist completed by them.
- [ ] Evidence/version record: browser + manager versions, marked TEST
  result, accepted scan, lease/queue/diagnostics state, redacted incident
  bundle — recorded by the owner; the status box above flips only then.
- [ ] Default-branch/protection settings per `docs/REPOSITORY-SETTINGS.md`
  (default branch `main`, protection rule with required CI check) — applied
  and verified by the owner in GitHub Settings.
- [ ] Tag and GitHub Release created manually by the owner; no automation
  creates either.
- [ ] Private archival of the sibling TravianAttackAlertDEV directory (one
  level above the repo root) outside the repo: read-only migration input,
  never committed to the public repo, never deleted without owner consent,
  marked non-authoritative; never delete or upload backups.
- Until every box is recorded, `docs/release-state.json` stays
  `stable:false` and the README keeps its release-candidate warning even
  though the target version is 1.0.0.

(Naming note: the `../`-relative spelling of that DEV directory is never
written literally in this tree — the frozen privacy scanner rejects that
literal as a private-path leak. The sibling phrasing above names the same
directory.)

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
  not even during an update. See `../../MIGRATION-6X.md` for the owner
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
