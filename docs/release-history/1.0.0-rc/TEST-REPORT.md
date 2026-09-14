# Test Report — 1.0.0 release candidate (unpublished)

> **Archive note (repository-cleanup restructure).** This file was moved from `docs/TEST-REPORT.md` to `docs/release-history/1.0.0-rc/TEST-REPORT.md`; only this note was added and code-span links were adjusted for the move. It is an unpublished 1.0.0 release-candidate record, not current proof: cited commit SHAs refer to private, unreachable history, and cited `test-results/` evidence was gitignored and never committed. Do not mistake it for a live operational guide — current guides are indexed in `../../README.md`.

Distribution terms: TBD owner decision — blocks public-ready, not the local RC.

Every PASS claim below cites an evidence file. Nothing here claims
a manager or live PASS. Statuses honestly split executed vs planned work.

## Executed results

Full offline gate: `test-results/release-1.0.0/offline-summary.json`
(overall PASS, 12/12 gates, commit `4bccfa4`; final full-gate rerun on the
release commit is PENDING Todo 19).

| Area | Tests | Status | Evidence |
|---|---|---|---|
| Unit (core + parity) | 358 | PASS | `test-results/release-1.0.0/offline-summary.json` (unit gate) |
| Tools (backup/rollback, readme contract) | 55 | PASS | `test-results/release-1.0.0/offline-summary.json` (tools-tests gate) |
| Detector matrix | 17 | PASS | `test/artifact/detector-matrix.test.cjs`, `../../AUDIT.md` |
| Settings/secret-omit | 11 | PASS | `test/artifact/settings-backup.test.cjs` |
| Lease release | 3 | PASS | `test/artifact/lease-release.test.cjs` |
| Migration 6.x | 11 | PASS | `test/artifact/migration-6x.test.cjs` |
| Delivery matrix | 16 | PASS | `test/artifact/delivery-matrix.test.cjs` |
| e2e attack-panel | 96 | PASS | `test-results/release-1.0.0/e2e-report-attack-panel.spec.json` |
| e2e clean-install | 36 | PASS | `test-results/release-1.0.0/e2e-report-clean-install.spec.json` |
| e2e discord-delivery | 18 | PASS | `test-results/release-1.0.0/e2e-report-discord-delivery.spec.json` |
| e2e manual-fetch-timing | 6 | PASS | `test-results/release-1.0.0/e2e-report-discord-manual-fetch-timing.spec.json` |
| e2e dual-tab-lease | 24 | PASS | `test-results/release-1.0.0/e2e-report-dual-tab-lease.spec.json` |
| e2e browser-qa | 12 | PASS | `test-results/release-1.0.0/e2e-report-f3-browser-qa.spec.json` |
| e2e live-member-scan | 54 | PASS | `test-results/release-1.0.0/e2e-report-live-member-scan.spec.json` |
| e2e migration-6x | 18 | PASS | `test-results/release-1.0.0/e2e-report-migration-6x.spec.json` |
| e2e onboarding-states | 36 | PASS | `test-results/release-1.0.0/e2e-report-onboarding-states.spec.json` |
| e2e readiness-late | 18 | PASS | `test-results/release-1.0.0/e2e-report-readiness-late.spec.json` |
| e2e route-lease | 18 | PASS | `test-results/release-1.0.0/e2e-report-route-lease.spec.json` |
| README onboarding walkthrough | 6 | PASS | `test-results/release-1.0.0/readme-walkthrough.json` |
| Docs EN/PL equivalence | mapping | PASS | `test-results/release-1.0.0/docs-equivalence.json` |
| Deterministic dist build | — | PASS | `test-results/release-1.0.0/repro-build.json` + sidecar `dist/travian-attack-alert.user.js.sha256` |

Note: the evidence files above live under the gitignored
`test-results/` directory and are not committed; they are rerunnable
via `npm run check:release -- --offline` (Todo 19 reruns them on the
final commit).

## Planned, not executed

### EXECUTED (Todo 18): real-manager matrix — 2026-09-13, all NOT_EXECUTED

Install target was the exact committed bytes
`dist/travian-attack-alert.user.js`
(SHA-256 `a34272340e92c1b5159244345a8ef2da98c6bd297e13d8547ed11838622f3ce7`,
verified `sha256sum -c dist/travian-attack-alert.user.js.sha256` → OK before
any attempt; identity `Travian Attack Alert` / `travian-attack-alert-public` /
`1.0.0`). No manager could be installed under automation, so every
downstream step (identity/version in manager UI, injection, GM storage,
menu commands, Web Locks, loopback Discord send, update/downgrade) is
NOT_EXECUTED for every combo. Nothing below converts this into a PASS.

| Combo | Versions found | Verdict | Evidence dir (gitignored) |
|---|---|---|---|
| Chrome + Tampermonkey (mandatory) | Chrome `151.0.7922.108` (system); TM version n/a (not installed) | NOT_EXECUTED | `test-results/release-1.0.0/manager-matrix/chrome-tm/` |
| Firefox + Tampermonkey | Firefox `153.0` (Playwright-bundled build; no system binary); TM n/a | NOT_EXECUTED | `test-results/release-1.0.0/manager-matrix/firefox-tm/` |
| Chrome + Violentmonkey | Chrome `151.0.7922.108`; VM n/a | NOT_EXECUTED | `test-results/release-1.0.0/manager-matrix/chrome-vm/` |
| Firefox + Violentmonkey | Firefox `153.0` (Playwright-bundled); VM n/a | NOT_EXECUTED | `test-results/release-1.0.0/manager-matrix/firefox-vm/` |

Per-combo blockers (each proven by the logged probe output, never a bare
claim; all profiles fresh `--user-data-dir`/ephemeral, deleted afterwards,
no credentials entered, no sync, loopback-only):

- Chrome + Tampermonkey: 4 attempts. CWS reachable (`TM-CWS 200`); consent
  gate passed; `Add to Chrome` clicked (headless + headed on `DISPLAY=:0`).
  Install stalls: button area becomes a spinner, no native WebStore
  confirmation dialog is surfaced to DOM automation, and no OS-level input
  tool exists (`xdotool` absent) to drive it. Tampermonkey is proprietary —
  CWS-or-nothing, no unpacked fallback attempted by policy.
  Logs `attempt.log`–`attempt4.log`, screenshots `store-page2.png`,
  `after-install-click2.png`, `headed-after-click.png`.
- Chrome + Violentmonkey: 3 attempts. Direct detail URL with a wrong
  trailing id redirected to store home (curl `-L` + attempt log prove it);
  the correct listing
  (`/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag`) was found via
  store search and `Add to Chrome` clicked — same spinner stall as TM.
  Unpacked path (public repo reachable: `git ls-remote .../violentmonkey`
  OK) recorded as follow-up, not executed here.
- Firefox + Tampermonkey: 3 attempts. AMO page loads (`200`, Playwright
  Firefox `153.0`); clicking `Add to Firefox` redirects to
  `accounts.firefox.com/authorization` — install requires a Firefox Account
  login, which is out of scope (no credentials). One attempt additionally
  hit an intermittent AMO anti-bot CAPTCHA (screenshot `tm-after-click.png`;
  clean retry `retry-landing.png` proves intermittence, not persistence).
  `about:addons` is not navigable under automation (timeout, logged).
- Firefox + Violentmonkey: 2 attempts. Same `accounts.firefox.com`
  login-wall redirect after clicking `Add to Firefox` (logged URL embeds
  the `/addon/violentmonkey/` return path).

Supported set: EMPTY — no combination reached full PASS, so nothing is
declared supported. Violentmonkey stays candidate/not-supported.

pilotReady:false — mandatory Chrome + Tampermonkey PASS is missing, so the
pilot gate is not met by this matrix (Todo 20 consumes this line).

### SEAL (Todo 19): reproducibility + final full-gate rerun — 2026-09-13, verdict PASS (repaired)

History, kept honest: the first seal commit (`0495bcd`) recorded verdict BLOCKED —
reproducibility PASS but the full gate FAIL 9/12 on README-contract drift from the
`9d19a67` rewrite. The repair commit realigned the README with the asserted
contracts (README-only; no test/tool/runtime change) and reran the full gate to
green. What follows is the PASS record on the final tree.

Release commit for the artifact bytes: `b8b41a5` (dist bytes unchanged by the
repair — see below).

**Reproducibility: PASS.** Two clean checkouts of exactly `b8b41a5` outside the
repo (`/tmp/taa-repro-A`, `/tmp/taa-repro-B`, detached HEAD, fresh `npm ci` +
`npm run build` in each) produce byte-identical
`dist/travian-attack-alert.user.js`: `cmp` A=B and A=main-tree identical;
SHA-256 `a34272340e92c1b5159244345a8ef2da98c6bd297e13d8547ed11838622f3ce7`
in A, B, and the main tree; sidecars and `metadata.json` artifact/dist hashes
identical (`taa-1.0.0` / `1.0.0`); all three trees `git status` clean after
rebuild. Evidence (gitignored):
`test-results/release-1.0.0/reproducibility.json`
(`{shaA, shaB, shaMain, match:true, commit}`, node `v22.22.0`, npm `10.9.4`).
Both worktrees removed afterwards and verified (`git worktree list`, `/tmp`
dirs gone).

**Final full offline gate on the final tree: PASS (12/12) — seal CLOSED.**
`npm run check:release -- --offline` exit 0; evidence
`test-results/release-1.0.0/offline-summary.json` (mode `offline`).
Per-gate: PASS syntax-script, syntax-dist, unit (358/358), tools-tests,
artifact-matrix, build, versions (`VERSION CHECK PASS: 1.0.0 (taa-1.0.0)`),
artifact, types, quality, static-format, e2e.
e2e EXECUTED honestly on this run: all 11 specs green (attack-panel 96,
clean-install 36, discord-delivery 18, manual-fetch-timing 6, dual-tab-lease 24,
browser-qa 12, live-member-scan 54, migration-6x 18, onboarding-states 36,
readiness-late 18, route-lease 18 — 336 expected, 0 unexpected, 0 flaky;
per-spec JSON reports under `test-results/release-1.0.0/`).
Ports 8898/8899 verified free before the run; no fixture servers left behind.

**Repair (no test/tool/runtime change — README only):** the blocker was the
`9d19a67` README rewrite dropping machine-checked contracts. Restored into
`README.md`, dictated verbatim by the failing assertions: a Version-note line
carrying literally `Tampermonkey **1.0.0**` plus
"identified by release ID `taa-1.0.0`";
a "What alerts look like" section with the exact `discord-alert-example`
markers whose bytes were spliced from the live canonical raid-two builder
(never hand-typed; static audit `readme-canonical-bytes` PASS); the
departure-conditions + `allowed_mentions` contract prose (4 conditions,
`{ roleId, leaveRoleId }` / `travianAllianceDiscordConfig_v1` /
`validateDiscordRoleId`, allowlist with no `parse` key). README is not an input
to `tools/build.cjs`, so the dist SHA is unchanged by the repair:
`a34272340e92c1b5159244345a8ef2da98c6bd297e13d8547ed11838622f3ce7` before and
after (rebuilt + sidecar-verified + backed up per AGENTS.md).
Reproducibility, artifact identity (`@version 1.0.0`, `Travian Attack Alert` /
`travian-attack-alert-public`, single neutral `https://*.travian.com/alliance*`
match, `@noframes`, no update/download URLs), the tracked-tree secret sweep
(only `FAKE_*` synthetic placeholders in tests — no private keys, no AKIA, no
real webhook URLs), and the non-loopback request-target scan (`src/` has zero
hardcoded `https://` targets; surviving fixture hits are the synthetic
`cw.x2.international.travian.com` host, `real.example` rejection bait, and
split-string validator fragments — all test-only, no real requests) are all
clean. Unblock path for a follow-up: reconcile the README wording with the
asserted contracts (or the contracts with the intended README) and rerun the
gate to green.

Final per AGENTS.md: `npm run build && npm run check:artifact && npm run backup`
all green, same SHA `a3427234…`; `git status --short` clean after the runs.
