# Documentation

Start with the English [`README.md`](../README.md) (primary): what the script does, honest pilot status, the verified install/update path, quick start, privacy, and support. This index maps every current document; the archived release-history records are historical and are not current proof.

## Operator guides

- Daily operations (English): [`OPERATIONS.md`](OPERATIONS.md) — morning routine, queue recovery, handover, troubleshooting, incident template.
- Daily operations (Polish): [`pl/OPERATIONS.md`](pl/OPERATIONS.md) — polski odpowiednik strony `OPERATIONS.md`; w razie rozbieżności obowiązuje tekst angielski.
- Alert payload format: [`ALERT-FORMAT.md`](ALERT-FORMAT.md) — request envelope, first-embed fields, mention policy, per-request limits, multi-part splitting, delivery outcomes.
- Owner release runbook (ordered, owner-gated publication): [`RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md).
- Owner transfer from the 6.x line: [`MIGRATION-6X.md`](MIGRATION-6X.md).

## Technical records

- Architecture and design tokens: [`architecture.md`](architecture.md) — module graph (§10), panel tokens, WCAG targets.
- Distribution options (sourced decision record, no migration): [`DISTRIBUTION-OPTIONS.md`](DISTRIBUTION-OPTIONS.md) — userscript vs MV3 extension vs PWA vs desktop companion across DOM reach, install/update, permissions, storage migration, and unresolved policy; the current userscript is retained.
- Detector behavior audit (historical `1.0.0` audit-time record): [`AUDIT.md`](AUDIT.md) — locked behaviors and limitations as audited on 2026-09-13; `script.txt` citations are audit-time references to the authority removed by the repository cleanup.
- Code-review verification (standing rules): [`CODE-REVIEW.md`](CODE-REVIEW.md) — the 11 verified items and their existing gates.
- Development environment (WSL/DrvFS and Linux): [`DEVELOPMENT.md`](DEVELOPMENT.md) — Node/npm selection, `npm ci`, Playwright test tiers, evidence roots, frozen provenance, line endings, protected canonical checkout.
- Repository settings owner checklist: [`REPOSITORY-SETTINGS.md`](REPOSITORY-SETTINGS.md) — observed public state, required targets, and owner attestations.
- Machine-readable release state (owner gates): [`release-state.json`](release-state.json) — `stable: true` (owner-attested 2026-09-25); `publication.tagAndRelease` records the published `v1.0.1` tag and immutable GitHub Release (2026-09-25).
- Changelog: [`../CHANGELOG.md`](../CHANGELOG.md).

## Release history (historical archive, not current proof)

Unpublished 1.0.0 release-candidate records, kept with honest archive headers (private SHAs unreachable, `test-results/` evidence gitignored and uncommitted):

- [`release-history/1.0.0-rc/TEST-REPORT.md`](release-history/1.0.0-rc/TEST-REPORT.md)
- [`release-history/1.0.0-rc/VERDICTS.md`](release-history/1.0.0-rc/VERDICTS.md)
- [`release-history/1.0.0-rc/PILOT.md`](release-history/1.0.0-rc/PILOT.md)
- [`release-history/1.0.0-rc/RELEASE-CHECKLIST.md`](release-history/1.0.0-rc/RELEASE-CHECKLIST.md)

## Entry points

- Public overview and install: [`../README.md`](../README.md).
- Contributing: [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- Security policy: [`../SECURITY.md`](../SECURITY.md).
- This index: [`README.md`](README.md) (this file).
