# Release Checklist — 1.0.0 (unpublished release candidate)

> **Archive note (repository-cleanup restructure).** This file was moved from `docs/RELEASE-CHECKLIST.md` to `docs/release-history/1.0.0-rc/RELEASE-CHECKLIST.md`; only this note was added and code-span links were adjusted for the move. It is an unpublished 1.0.0 release-candidate record, not current proof: its "Docs complete" list names the pre-cleanup layout (`README.pl.md`, `docs/OPERATIONS.pl.md`), and cited `test-results/` evidence was gitignored and never committed. Do not mistake it for a live operational guide — current guides are indexed in `../../README.md`.

This task prepares materials only. It creates no tag, no GitHub Release,
no push, and no public message. Publication needs separate owner consent.

Distribution terms: TBD owner decision — blocks public-ready, not the local RC.
No `LICENSE` file exists by intent; `find . -maxdepth 1 -iname 'LICENSE*'`
must print nothing until the owner chooses terms.

## Gate ownership — AGENT-AUTOMATED vs OWNER-MANUAL

Machine-readable state: `docs/release-state.json` reports `stable:false`
until every OWNER-MANUAL box below is recorded by the owner. No automated
step (npm script, test, build, CI job) may flip it; only an owner edit that
populates those fields — plus the matching edit to the gate test — can
advance it.

### AGENT-AUTOMATED (done by this migration)

- `src/` cutover, deterministic `dist/` build (SHA-256 in `metadata.json`
  plus sidecar), privacy fixtures (loopback only, no real webhooks, no live
  requests), read-only CI, docs.
- Pre-pilot material preparation: the offline-PASS evidence, sidecar
  verification, secret scan, and docs list below, to the extent automation
  can reach. The pilot-entry real-manager matrix and everything under
  OWNER-MANUAL remain owner-only.

### OWNER-MANUAL (owner only — blocks stable-1.0 and DEV retirement)

- [ ] Chrome + Tampermonkey real install by a second person, run to green
  per `PILOT.md` in this directory.
- [ ] Evidence/version record filed by the owner (browser + manager
  versions, TEST + accepted-scan proof, redacted incident bundle).
- [ ] Default-branch/protection settings applied and verified per
  `docs/REPOSITORY-SETTINGS.md`.
- [ ] Tag and GitHub Release created MANUALLY by the owner. This task
  creates NEITHER. Do not automate this step.
- [ ] Sibling TravianAttackAlertDEV directory (one level above the repo
  root) privately archived outside the repo: read-only migration input,
  never committed to the public repo, never deleted without owner consent,
  marked non-authoritative; never delete or upload backups.
- Until every box is recorded, `docs/release-state.json` stays
  `stable:false` and the README keeps its release-candidate warning even
  though the target version is 1.0.0.

## Pre-pilot gates (all required before any pilot)

- [ ] `npm run check:release -- --offline` overall PASS with evidence
      (`test-results/release-1.0.0/offline-summary.json`), on the final commit.
- [ ] `dist/` SHA-256 recorded and verified against the sidecar
      (`sha256sum -c dist/travian-attack-alert.user.js.sha256` prints OK).
- [ ] Secret scan clean over the tracked tree, `dist/`, and docs.
- [ ] Docs complete: `README.md` (English primary), `README.pl.md`,
      `docs/OPERATIONS.md` + `docs/OPERATIONS.pl.md`,
      `docs/MIGRATION-6X.md`, `docs/AUDIT.md`, `CHANGELOG.md`,
      `TEST-REPORT.md`, issue template.
- [ ] No `LICENSE` decision recorded → pilot may proceed, public stays blocked.

## Pilot-entry gates

- [ ] Real-manager matrix recorded in `TEST-REPORT.md` (Todo 18):
      desktop Chrome stable + Tampermonkey stable mandatory; other
      combinations are candidates until proven.
- [ ] Reproducibility seal + final full-gate rerun (Todo 19): two builds
      in clean checkouts with identical SHA-256, all offline gates PASS.

## Pre-public gates (owner only, manual)

- [ ] License chosen by the owner and added to the repo.
- [ ] Pilot sign-off recorded with evidence.
- [ ] Default branch `main` plus protection (required CI check) applied and
      verified per `docs/REPOSITORY-SETTINGS.md`.
- [ ] Tag + GitHub Release created MANUALLY by the owner.
      This task creates NEITHER. Do not automate this step.
- [ ] Sibling DEV tree privately archived outside the repo (read-only
      migration input, never committed, never deleted without owner
      consent, non-authoritative); never delete or upload backups.
