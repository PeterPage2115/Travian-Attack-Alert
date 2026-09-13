# Release Checklist — 1.0.0 (unpublished release candidate)

This task prepares materials only. It creates no tag, no GitHub Release,
no push, and no public message. Publication needs separate owner consent.

Distribution terms: TBD owner decision — blocks public-ready, not the local RC.
No `LICENSE` file exists by intent; `find . -maxdepth 1 -iname 'LICENSE*'`
must print nothing until the owner chooses terms.

## Pre-pilot gates (all required before any pilot)

- [ ] `npm run check:release -- --offline` overall PASS with evidence
      (`test-results/release-1.0.0/offline-summary.json`), on the final commit.
- [ ] `dist/` SHA-256 recorded and verified against the sidecar
      (`sha256sum -c dist/travian-attack-alert.user.js.sha256` prints OK).
- [ ] Secret scan clean over the tracked tree, `dist/`, and docs.
- [ ] Docs complete: `README.md` (English primary), `README.pl.md`,
      `docs/OPERATIONS.md` + `docs/OPERATIONS.pl.md`,
      `docs/MIGRATION-6X.md`, `docs/AUDIT.md`, `CHANGELOG.md`,
      `docs/TEST-REPORT.md`, issue template.
- [ ] No `LICENSE` decision recorded → pilot may proceed, public stays blocked.

## Pilot-entry gates

- [ ] Real-manager matrix recorded in `docs/TEST-REPORT.md` (Todo 18):
      desktop Chrome stable + Tampermonkey stable mandatory; other
      combinations are candidates until proven.
- [ ] Reproducibility seal + final full-gate rerun (Todo 19): two builds
      in clean checkouts with identical SHA-256, all offline gates PASS.

## Pre-public gates (owner only, manual)

- [ ] License chosen by the owner and added to the repo.
- [ ] Pilot sign-off recorded with evidence.
- [ ] Tag + GitHub Release created MANUALLY by the owner.
      This task creates NEITHER. Do not automate this step.
