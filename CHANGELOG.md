# Changelog

All notable changes to the public release line are documented here.
This file starts at 1.0.0. The earlier internal 6.x history is not
rewritten here; it is noted as lineage only.

## 1.0.0 — first public release based on historical internal 6.x development (release candidate, unpublished)

No tag, no GitHub Release, and no download link exist for this entry yet.
Publication needs a separate owner decision (see `docs/RELEASE-CHECKLIST.md`).

### Product identity

- Name `Travian Attack Alert`, namespace `travian-attack-alert-public`,
  version `1.0.0`, release ID `taa-1.0.0` (commit `3fc31c0`).
- Single neutral match `https://*.travian.com/alliance*`; no update channel
  (`@updateURL`/`@downloadURL` absent); `@noframes` retained.
- Installable file `dist/travian-attack-alert.user.js`, byte-identical to
  `script.txt` with a sidecar SHA-256 (commit `4b3ec21`).
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
