# Test Report — 1.0.0 release candidate (unpublished)

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
| Detector matrix | 17 | PASS | `test/artifact/detector-matrix.test.cjs`, `docs/AUDIT.md` |
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

### PENDING (Todo 18): real-manager matrix

No browser/manager combination is declared supported yet. Mandatory
target: desktop Chrome stable + Tampermonkey stable. Candidates:
Firefox + Tampermonkey, Chrome/Firefox + Violentmonkey. Each needs:
local-file install, identity/version check, injection on an allowed
host, GM storage, menu commands, Web Locks, loopback Discord send,
and local-only update/downgrade behavior, with exact versions recorded.

### PENDING (Todo 19): reproducibility seal + final full-gate rerun

Two builds in clean checkouts of the release commit with identical
SHA-256, plus a full `npm run check:release -- --offline` PASS on the
final artifact, with exit codes, test counts, and environment recorded.
