# Changelog

All notable changes to the public release line are documented here.
This file starts at 1.0.0. The earlier internal 6.x history is not
rewritten here; it is noted as lineage only.

## Unreleased — repository cleanup: `src/` runtime authority

- Owner release runbook and readiness verifier: `docs/RELEASE-RUNBOOK.md`
  documents the ordered owner-gated publication procedure (merged PR through
  verified published release, with rollback/stop behavior at each stage), and
  `tools/check-release-readiness.cjs` reports the machine-readable states
  `BLOCKED`, `READY_FOR_OWNER_TAG`, `DRAFT_READY_FOR_APPROVAL`, and
  `PUBLISHED_VERIFIED` from a self-contained bundle. The task performs no tag,
  Release, or repository-settings change; `docs/release-state.json` stays
  `stable: false`.
- The checked-in root monolith authority is removed: `src/runtime.js` is the
  sole editable runtime authority and `dist/travian-attack-alert.user.js` is
  generated from `src/userscript-entry.js` via `npm run build`. The
  compatibility shim (the `src/` bridge module) is deleted; domain modules select
  their contract through `src/runtime-api.js`.
- Every consumer follows the new paths: tests import `src/runtime.js` or
  domain modules, fixture servers serve `dist/*.user.js`, and
  version/artifact/release/quality checks target `src/`, `config/`, and
  `dist/` instead of the removed file.
- Backup/rollback now operate on the source set (`src/runtime.js`,
  `config/userscript.json`, `metadata.json`, `module-manifest.json`); the
  generated `dist/` tree is never backed up. Atomicity and path-traversal
  negative controls still hold.
- Root layout is simplified: `DESIGN.md` moved to `docs/architecture.md`
  (content unchanged); `module-manifest.json` is no longer committed and is
  regenerated deterministically by `npm run build` (frozen tests and quality
  tools keep reading the generated root copy). Committed release integrity
  is only `dist/*.sha256` plus generated `metadata.json`, whose
  `toolchain.node` now reports the actual build runtime instead of a
  hardcoded version.
- The update channel is reconfigured: `config/userscript.json` `updateURL`
  and `downloadURL` both point at the default release branch
  `release/public-1.0.0`, and the generated header carries both directives.
  The stale `/main/` channel URL is gone; `main` does not exist on the remote.

## 1.0.1 — stable (owner-attested, published)

Owner decision 2026-09-25: `1.0.1` is marked stable. All six schema-v2
pre-publication owner gates in `docs/release-state.json` are populated and
`stable` is `true`; `publication.tagAndRelease` is recorded because the
annotated `v1.0.1` tag and the immutable GitHub Release now exist. This
supersedes the `stable: false` candidate state recorded below.

- Second-person pilot: the owner reports (2026-09-25) that a second person
  completed the in-place `1.0.0 → 1.0.1` manager update and the latest version
  works for all users. Manager/browser versions and header hashes were not
  captured, and are not invented here.
- Branch protection, DEV archival, the `release` environment, immutable
  releases, and the owner evidence record are recorded as owner attestations in
  `docs/release-state.json`; `SECURITY.md` and the README now state the stable
  support state, and `test/tools/release-state.test.cjs` pins it.
- No artifact change: the built bytes are unchanged from the candidate; this
  entry records owner evidence and flips the stable flag only.
- Published as an immutable GitHub Release on 2026-09-25 (release id 396778787; assets attested).

## 1.0.1 — update-channel verification candidate (unpublished)

No tag, no GitHub Release, and no download link exist for this entry yet.
This candidate exists to prove the in-place `1.0.0 → 1.0.1` update through the
managers' own update check. The live update has NOT been executed or verified
yet; `docs/release-state.json` stays `stable: false` and every owner gate
stays unfulfilled until the owner runs and records that verification.

- Version identity moved to `1.0.1` / `taa-1.0.1` across `package.json`,
  `package-lock.json`, the runtime, the generated artifact, sidecar, metadata,
  and module manifest, the `tools/*` fallbacks, `docs/release-state.json`, and
  the current-version test assertions.
- No behavior change relative to the installed `1.0.0` seed: storage keys and
  schemas, detector semantics, grants, namespace, script name, `@match`, and
  both update directives are unchanged. `updateURL`/`downloadURL` remain
  byte-identical to the corrected release-branch raw URL, so the version
  increase alone is what a manager must discover.
- The version-contract gate now also covers `docs/release-state.json`, and
  `test/tools/version-contract.test.cjs` proves that a partial bump
  (package-only, runtime-only, stale fallback, stale release state, or stale
  generated header) fails closed with the exact stale authority path.

## 1.0.0 — first public release based on historical internal 6.x development (release candidate, unpublished)

No tag, no GitHub Release, and no download link exist for this entry yet.
Publication needs a separate owner decision (see `docs/release-history/1.0.0-rc/RELEASE-CHECKLIST.md`).

### Product identity

- Name `Travian Attack Alert`, namespace `travian-attack-alert-public`,
  version `1.0.0`, release ID `taa-1.0.0` (commit `3fc31c0`).
- Single neutral match `https://*.travian.com/alliance*`; no update channel in
  this candidate (`@updateURL`/`@downloadURL` absent, added later by the
  repository cleanup above); `@noframes` retained.
- Installable file `dist/travian-attack-alert.user.js`, generated from `src/`
  via `npm run build`, with a sidecar SHA-256 (commit `4b3ec21`).
- Complete offline quality gate `npm run check:release` (commit `e01adfa`).

### Unchanged compatibility

The following schemas are explicitly UNCHANGED from the internal line.
Existing correct backups import without conversion:

- Storage keys (monitor, roster, mappings, settings, roles, mutes, queue, diagnostics).
- Monitor envelope schema 1.
- Diagnostics schema 2.
- Settings backup schema 1.

### Intentional behavior changes

Each entry below changed observable behavior on purpose, with its commit:

- Default settings export omits the webhook secret; an explicit opt-in
  writes it together with a top-level plain-language `_warning`
  (commit `2fca21e`). Imports without a secret keep the stored one;
  explicit clear empties it.
- `releaseLease` term-guard fix: the unload path now reads the full lease
  record, so closing the owner tab actually releases authority instead of
  leaving it to the 120 s TTL (commit `1672a3c`).
- `writeVerifiedJson` canonicalizer fix: nested plain-string values (names,
  roster) no longer throw on readback, so settings-file imports carrying
  them succeed (commit `52b81e5`).
- TEST-marked synthetic sends and operational state lines: the Alerts test
  button is labeled `Send TEST alert to Discord` with outcome-based
  feedback, and Overview shows 8 operational state lines
  (commit `4bccfa4`).
- Dead-fallback removal (commit `c66fb50`): deleted unreachable
  largest-profile-link code past an unconditional early return.
  No behavior change; matrices pass identically with and without it.

### Known limitations

- Sampling gaps: events appearing and disappearing between two accepted
  snapshots cannot be inferred.
- Delivery is at-least-once: a lost acknowledgement can duplicate a batch.
- Uncertain settlement stays manual (`Retry uncertain` / `Mark delivered`
  menu path; no auto-retry from `uncertain`).
- One active monitoring installation per alliance/world; a second computer
  or browser profile WILL double-send (the local lock cannot prevent it).
- Background throttling behavior is browser-controlled and unproven;
  no 24/7 guarantee.
- Real userscript-manager matrix PENDING (Todo 18); reproducibility seal
  and final full-gate rerun PENDING (Todo 19).
