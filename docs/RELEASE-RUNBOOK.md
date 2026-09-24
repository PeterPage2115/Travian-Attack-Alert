# Owner Release Runbook — 1.0.1

Active, ordered, owner-gated publication procedure for the `1.0.1` release
(`taa-1.0.1`) of Travian Attack Alert. This is the live operational guide. The
frozen 1.0.0 release-candidate records under `docs/release-history/1.0.0-rc/`
are historical archive, not current proof, and are never edited by this
procedure.

No automation may perform any owner step below. No npm script, test, build step,
or CI job sets `stable:true`, creates a tag or Release, or changes a GitHub
setting. Every owner-only evidence item must record its **timestamp**, **actor**,
**repository/ref**, and a **read-only API response digest**. Never embed tokens,
private paths of any kind, player data, or environment secret values in any
record.

## 0. Readiness verifier

The verifier is offline and read-only; it never mutates GitHub.

```text
node tools/check-release-readiness.cjs --offline-fixture test/fixtures/release/blocked-current-state.json
node tools/check-release-readiness.cjs --offline-fixture <owner-bundle.json> --json
```

It reports exactly one machine-readable state:

- `BLOCKED` — at least one prerequisite is absent; the earliest typed blocker is
  returned as `code` and every failing prerequisite in `blockers`.
- `READY_FOR_OWNER_TAG` — every pre-tag prerequisite is satisfied and no tag
  exists yet.
- `DRAFT_READY_FOR_APPROVAL` — the exact annotated tag exists and the draft
  release and build attestations are verified, but the release is not published.
- `PUBLISHED_VERIFIED` — the release is published, immutable, its release
  attestation is verified, its asset digests are unchanged, and
  `publication.tagAndRelease` is recorded.

The committed `blocked-current-state.json` fixture is the truthful current
snapshot: it reports `BLOCKED`. Do not advance a stage until the verifier for the
next stage no longer reports `BLOCKED`.

## Stage 0 — Merge the reviewed PR

1. Confirm the reviewed PR for the release candidate is approved and that CI
   (`offline-node-18`, `offline-node-20`, `browser-node-20`,
   `cross-node-determinism`) is green.
2. Merge the reviewed PR into the default branch `release/public-1.0.0`. Record
   the resulting remote head commit.
3. Confirm the merged head is a clean, reviewed commit and that no tag exists
   (`git ls-remote --tags` shows no `v1.0.1`).

- **Evidence:** PR URL, reviewer, merge commit, remote head, check conclusions.
- **Stop:** any failing required check, an unapproved PR, or a pre-existing tag
  stops the run; nothing is tagged.
- **Rollback:** revert the merge on the default branch with a reviewed revert PR
  and re-run the readiness verifier; the release stays `BLOCKED`.

## Stage 1 — Run live update verification

1. With the merged head published to the default branch, run:

   ```text
   node tools/verify-update-channel.cjs
   ```

2. Require HTTP 200, byte equality with the local `1.0.1` artifact, sidecar
   SHA-256 equality, `@version 1.0.1`, and `@updateURL`/`@downloadURL` identical
   to the configured release-channel URL.

- **Evidence:** command output, status, artifact SHA-256, version, directives.
- **Stop:** any non-200 response, hash mismatch, wrong version, or directive
  drift stops the run.
- **Rollback:** fix the channel/commit, re-merge, and re-run; no tag is created.

## Stage 2 — Complete the second-person real-manager pilot

1. In dedicated, clean, secret-free Tampermonkey and Violentmonkey profiles still
   holding the seed install, run the manager's own update check against the live
   channel. No reinstall from file, no URL change, no profile reset.
2. Require both managers to move `1.0.0 → 1.0.1` in place with post-update bytes
   equal to the public raw `1.0.1` artifact byte-for-byte. A reinstall is
   recorded as a reinstall, never as an update.
3. Have a **second person** (not the release owner) perform and attest the pilot.

- **Evidence:** manager/browser versions, pre/post installed versions and header
  hashes, update URL, second-person attestation, timestamp, actor, ref.
- **Stop:** a manager that cannot discover the update, yields a different
  version/hash, or needs a reinstall stops the run.
- **Rollback:** keep the seed install and site data intact; investigate the
  channel, then repeat Stage 1 before retrying the pilot.

## Stage 3 — Review the Task 23 seed receipt and Task 31 update receipt

1. Review the **Task 23** seed receipt (the installed `1.0.0` seed identity) and
   the **Task 31** update receipt (the verified in-place `1.0.0 → 1.0.1` update).
2. Confirm both receipts are present, digest-bound, and contain no webhook,
   player data, cookies, extension-profile internals, or private browser state.

- **Evidence:** both receipt paths, SHA-256 digests, reviewer, timestamp.
- **Stop:** a missing, unverifiable, or secret-bearing receipt stops the run.
- **Rollback:** re-run the affected task and re-record the receipt; nothing is
  tagged.

## Stage 4 — Record the DEV deletion and attest `devArchival`

1. The owner already removed the legacy sibling DEV directory (one level above
   the repository root) on 2026-09-23, with no archive program. That removal
   did not include any `backups/` directory or other irreplaceable owner
   payload; backups are excluded from every deletion instruction.
2. Record the deletion and manually attest `devArchival` in
   `docs/release-state.json`. Do not commit any byte of that directory to the
   public repository and do not upload any backup.
3. Any later removal of owner data is an owner-approved, explicitly scoped
   action with a recoverable/preservation step: name the exact paths, confirm
   that no `backups/` or other irreplaceable payload is included, and keep the
   preservation copy until the owner signs off. Never issue a blanket
   "delete the directory including backups" instruction.

- **Evidence:** owner deletion record with timestamp, actor, and record digest.
- **Stop:** any attempt to archive or upload owner data, or any deletion
  instruction that would include backups, stops the run.
- **Rollback:** recover owner data from the preserved copy; the legacy DEV
  snapshot itself was removed with no archive program, and that precedent is
  never a reason to delete backups irreversibly.

## Stage 5 — Configure repository protections

Apply, then verify from a clean clone and via read-only authenticated GETs:

1. Enable private vulnerability reporting so the `SECURITY.md` private link
   works.
2. Enable **immutable releases** so a published asset or tag cannot be silently
   replaced.
3. Install an **active tag ruleset** that makes the `v*` tag immutable. It must
   target tag refs, match `refs/tags/v*` (including the exact release tag),
   enable **restrict creations**, **restrict updates**, and **restrict
   deletions**, and grant **no bypass actors**. With no bypass actors, no
   release actor — not the owner, not a repository administrator — can retarget,
   delete, or recreate the tag while a publication is running. The
   `release-publish` preflight proves this exact ruleset through read-only API
   calls and fails closed (`tag-protection-missing` / `tag-protection-bypass`)
   if the ruleset is absent, inactive, does not cover the exact tag ref, lacks
   any of the three restrictions, or lists any bypass actor.
4. Create a protected `release` environment with a required reviewer distinct
   from the release actor, prevent self-review, and a `v*` deployment tag policy.
5. Store **environment-only** secrets: `TAA_RELEASE_APPROVAL_PROOF` (random) and
   a short-lived `TAA_RELEASE_SETTINGS_READ_TOKEN` (expires within 24 hours,
   read-only grants only). Ensure no same-named repository secret or variable
   exists and no organization-level name collides.
6. Complete every item in `docs/REPOSITORY-SETTINGS.md`.

- **Evidence:** authenticated settings export digests, tag ruleset response
  digest (id, target, enforcement, ref conditions, rules, empty bypass list),
  environment protection response digest, secret-name absence digests,
  timestamp, actor, repository/ref.
- **Stop:** an unprotected or auto-created environment, a missing environment
  secret, a same-actor reviewer, a disabled immutable-release setting, or a
  missing, inactive, uncovered, or bypassable tag ruleset stops the run.
- **Rollback:** correct the setting and re-verify; the release stays `BLOCKED`.

## Stage 6 — Populate pre-publication owner gates and set `stable:true`

1. In an owner-reviewed commit, populate only the schema-v2 pre-publication owner
   gates in `docs/release-state.json`
   (`pilotInstallBySecondPerson`, `evidenceRecord`, `branchProtection`,
   `devArchival`, `releaseEnvironment`, `immutableReleases`) and set
   `stable:true`.
2. Update the matching gate test (`test/tools/release-state.test.cjs`) and the
   changelog in the same owner-reviewed commit.
3. Leave `publication.tagAndRelease` **false** until after publication.

- **Evidence:** owner-reviewed commit, gate values, matching test/changelog edit.
- **Stop:** any attempt to set `stable:true` from automation, or to populate
  `publication.tagAndRelease` before publication, stops the run.
- **Rollback:** revert the owner commit with a reviewed revert; the release
  returns to `BLOCKED`.

## Stage 7 — Create and push the annotated `v1.0.1` tag

1. Create an **annotated** tag `v1.0.1` at the reviewed release head and push it.
2. Confirm `git ls-remote` resolves the annotated tag to the exact release head
   and that the head is contained in `release/public-1.0.0`.

- **Evidence:** tag object id, target commit, branch ancestry, timestamp, actor.
- **Stop:** a lightweight tag, a wrong-version tag, or a tag off the release
  branch stops the run.
- **Rollback:** delete the tag locally and remotely, fix the commit, and recreate
  it; no Release is published.

## Stage 8 — Inspect the draft assets and build attestations

1. The release workflow builds from the tag, prepares and verifies the exact
   seven assets, attests `SHA256SUMS`, and creates one **draft** release.
2. Inspect the draft: exactly the seven declared assets, byte-identical to the
   workflow artifact, `SHA256SUMS` verified, and every build attestation
   verified. A source archive auto-download must never be substituted for the
   userscript asset.

- **Evidence:** workflow run/artifact ids, draft release id, asset ids/digests,
  attestation ids, immutable-release response digest.
- **Stop:** a missing draft asset, an extra or duplicate draft asset, a checksum
  or attestation mismatch, or a substituted asset stops publication; the draft
  stays unpublished.
- **Rollback:** delete the draft release and the tag, fix the cause, and re-tag;
  never publish a mismatched draft.

## Stage 9 — Distinct reviewer approves the protected environment

1. The `release-publish` job waits on the protected `release` environment. A
   reviewer **distinct** from the triggering actor approves the deployment.
2. The job performs its GET-only preflight with the short-lived
   `TAA_RELEASE_SETTINGS_READ_TOKEN`, proves the live environment protections,
   both environment secrets, immutable releases, the active no-bypass tag
   ruleset covering the exact tag ref, the exact tag target, and the
   digest-bound owner evidence, then unsets the token immediately.

- **Evidence:** environment approval record, reviewer identity, preflight record,
  token grant/expiry evidence digest, timestamp.
- **Stop:** an absent/expired token, a denied API call, a same-actor reviewer, or
  any settings mismatch leaves the draft unpublished.
- **Rollback:** deny or withdraw the approval; the draft remains unpublished and
  can be deleted.

## Stage 10 — Verify the published immutable release

1. Immediately before the single publish mutation the workflow re-fetches the
   draft and requires the same release id, tag, draft state, and asset
   id/name/size/digest set it verified. Any drift
   (`draft-drift-before-publish`) stops publication with the draft untouched.
   After approval, the single publish mutation flips the draft to published.
2. Immediately after the mutation the workflow re-resolves the tag object and
   requires it to still point at the exact release commit it verified before
   publication. A retargeted tag (`tag-target-changed-after-publish`) is a
   publication **incident**: the job fails, the release is never represented as
   success, and Stage 11 must not run.
3. Verify the published release: `gh release verify`, per-asset
   `gh release verify-asset`, immutable releases still enabled, and unchanged
   asset ids and digests. Any mismatch raises an incident and must never be
   represented as success.

- **Evidence:** pre-publish draft record, post-publish tag object id and target
  commit, published release id, asset ids/digests, release attestation
  verification, immutable-release response digest, timestamp.
- **Stop:** draft drift before the mutation, a retargeted tag, a mutable
  release, a failed release attestation, or changed asset digests is an
  incident; do not report success.
- **Rollback:** if immutable releases are enabled the release cannot be silently
  replaced; if the tag was retargeted, stop, do not run Stage 11, and delete the
  release and the wrong tag only through the documented owner incident procedure
  (temporarily amending the tag ruleset in an owner-reviewed change, then
  restoring it and re-verifying) before re-running from Stage 7.

## Stage 11 — Post-publication follow-up record

1. Only after Stage 10 verifies, populate `publication.tagAndRelease` in
   `docs/release-state.json` in a follow-up owner-reviewed commit. The readiness
   verifier may now report `PUBLISHED_VERIFIED`.
2. Remove or rotate `TAA_RELEASE_SETTINGS_READ_TOKEN` immediately and record the
   removal.

- **Evidence:** follow-up commit, `publication.tagAndRelease` value, token
  removal record, timestamp, actor, repository/ref.
- **Stop:** if publication was not verified, `publication.tagAndRelease` stays
  false and the state stays `DRAFT_READY_FOR_APPROVAL` or `BLOCKED`.
- **Rollback:** revert the follow-up commit to retract the record; rotate the
  token again if any doubt remains.
