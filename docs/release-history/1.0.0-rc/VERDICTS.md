# Verdicts — 1.0.0 review package (unpublished)

> **Archive note (repository-cleanup restructure).** This file was moved from `docs/VERDICTS.md` to `docs/release-history/1.0.0-rc/VERDICTS.md`; only this note was added and code-span links were adjusted for the move. It is an unpublished 1.0.0 release-candidate record, not current proof: cited commit SHAs refer to private, unreachable history, and cited `test-results/` evidence was gitignored and never committed. Do not mistake it for a live operational guide — current guides are indexed in `../../README.md`.

Three separate verdicts, each with its own reasons and evidence. No verdict
borrows another's evidence. Each verdict flips only on its own stated
conditions.

## 1. localCandidateReady: TRUE

The local release candidate is sealed: the bytes are reproducible, every
offline gate is green, and the tracked tree carries no secrets.

- Reproducible bytes: two clean checkouts of commit `b8b41a5` plus the main
  tree all hash to SHA-256
  `a34272340e92c1b5159244345a8ef2da98c6bd297e13d8547ed11838622f3ce7`,
  verified with `sha256sum -c dist/travian-attack-alert.user.js.sha256`
  (prints OK). Evidence: `test-results/release-1.0.0/reproducibility.json`
  (`match:true`) and the committed sidecar
  `dist/travian-attack-alert.user.js.sha256`. Recorded in
  `TEST-REPORT.md` (SEAL section).
- Full offline gate green: `npm run check:release -- --offline` exits 0,
  overall PASS, 12/12 gates on the final tree. Evidence:
  `test-results/release-1.0.0/offline-summary.json`. Recorded in
  `TEST-REPORT.md` (Executed results).
- All matrices green: unit 358/358, tools 55/55, artifact matrices
  (detector 17, settings/secret-omit 11, lease-release 3, migration-6x 11,
  delivery 16), and all 11 e2e specs green (336 expected, 0 unexpected, 0
  flaky; attack-panel 96, clean-install 36, discord-delivery 18,
  manual-fetch-timing 6, dual-tab-lease 24, browser-qa 12, live-member-scan
  54, migration-6x 18, onboarding-states 36, readiness-late 18, route-lease
  18). Evidence: per-spec JSON reports under `test-results/release-1.0.0/`
  plus `test-results/release-1.0.0/readme-walkthrough.json` and
  `test-results/release-1.0.0/docs-equivalence.json`. Recorded in
  `TEST-REPORT.md` (Executed results table).
- Secret sweeps clean: the tracked-tree scan prints only `FAKE_*` synthetic
  placeholders in tests (no private keys, no AKIA patterns, no real webhook
  URLs), and `src/` holds zero hardcoded request targets (surviving fixture
  hits are the synthetic `cw.x2.international.travian.com` host,
  `real.example` rejection bait, and split-string validator fragments, all
  test-only). Evidence: the seal record in `TEST-REPORT.md` (SEAL
  repair paragraph).
- Pre-pilot boxes checked: `RELEASE-CHECKLIST.md` gates (offline PASS
  with evidence, dist SHA recorded and sidecar-verified, secret scan clean,
  docs complete, no `LICENSE` by intent) hold on the final commit.

This verdict says nothing about real managers, a real pilot, or publication.
Those belong to verdicts 2 and 3.

## 2. pilotReady: FALSE

No real external pilot has run yet, and the mandatory real-manager proof is
missing. The pilot checklist (`PILOT.md`) is the path to flip this
verdict, not proof that it already flipped.

- Real-manager matrix all NOT_EXECUTED: all four combos (Chrome plus
  Tampermonkey, Firefox plus Tampermonkey, Chrome plus Violentmonkey,
  Firefox plus Violentmonkey) are NOT_EXECUTED with per-attempt logged
  blockers (store spinner stall outside DOM automation, AMO Firefox-Account
  login wall, no OS-level input tooling). Supported set: EMPTY. Evidence:
  `TEST-REPORT.md` (real-manager matrix section) and the gitignored
  per-combo dirs under
  `test-results/release-1.0.0/manager-matrix/<combo>/`.
- Mandatory gate unmet: `TEST-REPORT.md` records `pilotReady:false`
  because the desktop Chrome plus Tampermonkey PASS is missing; the pilot
  gate requires it.
- No second-person trial yet: `PILOT.md` carries the status box
  `NOT EXECUTED — awaiting owner-run trial`. Prior walkthroughs used a
  synthetic operator persona against loopback fixtures only, never a second
  person's device, webhook, or manager.

Flip conditions (both required): a hand-install PASS on desktop Chrome plus
Tampermonkey recorded with versions and evidence, AND the pilot checklist
completed by a second person on their own device with their own webhook
(marked TEST sent, accepted scan confirmed, lease/queue/diagnostics
checked). Until then this verdict stays FALSE.

## 3. publicReleaseReady: FALSE

Publication is blocked on owner decisions that have not been made. This
verdict is independent of candidate quality (verdict 1) and of pilot state
(verdict 2).

- Distribution terms undecided: `RELEASE-CHECKLIST.md` states
  "Distribution terms: TBD owner decision", and no `LICENSE` file exists by
  intent. Evidence: `RELEASE-CHECKLIST.md` (header block) and the
  `find . -maxdepth 1 -iname 'LICENSE*'` empty result it pins.
- No pilot sign-off: verdict 2 above is FALSE, and
  `RELEASE-CHECKLIST.md` lists pilot sign-off with evidence as a
  pre-public gate. No sign-off exists because no real pilot has run.
- No publication artifacts: no tag, no GitHub Release, no push, and no
  public message exist for 1.0.0. Evidence: `RELEASE-CHECKLIST.md`
  (pre-public gates) and `CHANGELOG.md` ("No tag, no GitHub Release, and no
  download link exist for this entry yet").

Flip conditions (all required): the owner chooses license terms and adds the
`LICENSE` file, a pilot PASS is recorded with evidence, and the owner
manually creates the tag plus GitHub Release. Until then this verdict stays
FALSE, and nothing in this package auto-publishes.
