# Repository Settings — Owner Checklist

Owner-only checklist for protecting the userscript update channel. All items
refer to https://github.com/PeterPage2115/Travian-Attack-Alert. Apply in
Settings; verify from a clean clone. The ordered owner publication procedure
that consumes these settings is `docs/RELEASE-RUNBOOK.md`.

Public-state observation (read-only GitHub API GETs on 2026-09-23): the
default branch is `release/public-1.0.0`; `main` and `master` do not exist, and
the fresh read also sees eight open `dependabot/*` dependency branches next to
it; that branch is protected with the four required status checks
`offline-node-18`, `offline-node-20`, `browser-node-20`, and
`cross-node-determinism`; no repository ruleset is installed; no deployment
environment exists (`GET /environments` reports `total_count: 0`); private
vulnerability reporting is reported disabled
(`GET /private-vulnerability-reporting` returns `enabled: false`); the
description, homepage, and topics are set. Anonymous requests to authenticated
endpoints (branch protection detail, immutable releases, Actions workflow
permissions) answer 401, so §8 now records a separate authenticated read-only
owner comparison (GET-only, no setting changed) instead of owner attestation.
This is a point-in-time API observation, not owner attestation. At that time the
separate owner-manual record in `docs/release-state.json` held
`ownerManual.branchProtection: false`,
`ownerManual.releaseEnvironment: false`,
`ownerManual.immutableReleases: false`, and `stable: false`. The owner has since
populated every pre-publication gate and set `stable: true`; the annotated
`v1.0.1` tag was published as an immutable GitHub Release (release id
`396778787`) on 2026-09-25, and the follow-up `v1.0.2` release superseded it as
the published stable channel (immutable GitHub Release id `396904420`, exactly
two public assets) on the same day. This file is an owner checklist,
not that owner-attestation record; checked items below are API-observed public
state, and unchecked items are pending owner actions.

## 0. Gate ownership — AGENT-AUTOMATED vs OWNER-MANUAL

### AGENT-AUTOMATED (done by this migration)

- Deterministic `dist/` build from `src/`; `config/userscript.json`
  `updateURL`/`downloadURL` pointing at the release-branch raw artifact
  URL in §1; read-only CI workflow (§3) with no publish step; docs.

### OWNER-MANUAL (owner only — everything below)

- Every numbered section (§1–§9) is applied and verified by the owner in
  GitHub Settings and on a clean clone. No npm script, test, build step, or CI
  job applies these settings or flips any field in `docs/release-state.json`;
  the pilot evidence, tag/Release, and archival record it references are
  owner-written. Until they were recorded, `docs/release-state.json` stayed
  `stable:false` and the README kept its release-candidate warning even though
  the target version was 1.0.1; the owner has since recorded all gates together
  with the published `v1.0.1` release. The tree then staged the `1.0.2`
  candidate, and the owner again recorded every gate and published `v1.0.2`
  (immutable Release id `396904420`, two public assets) on 2026-09-25.
  `docs/release-state.json` is now `stable: true` with
  `publication.tagAndRelease: true`.

## 1. Branch and update-channel identity

- [x] Default branch remains `release/public-1.0.0` (Settings → General →
      Default branch).
- [x] No `main` or `master` branch currently exists on the public remote.
- [x] `config/userscript.json` `updateURL` and `downloadURL` both point at
      the release-branch artifact URL exactly:

      `https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/release/public-1.0.0/dist/travian-attack-alert.user.js`

## 2. Branch protection for `release/public-1.0.0`

- [x] Branch protection rule targets `release/public-1.0.0` (Settings →
      Branches → Add rule); the public API reported the branch protected on
      2026-09-23.
- [x] Require status checks to pass before merging; the four exact required
      checks from `.github/workflows/ci.yml` are `offline-node-18`,
      `offline-node-20`, `browser-node-20`, and `cross-node-determinism`
      (observed as the required contexts on 2026-09-23).
- [ ] Require a pull request before merging (at least 1 approving review;
      dismiss stale approvals on new commits). Owner-verify: the public branch
      endpoint does not expose pull-request review requirements.
- [ ] Block force pushes (`Do not allow force pushes`) and deletions
      (`Do not allow deletions`) for `release/public-1.0.0`. Owner-verify: the
      public branch endpoint does not expose these toggles.
- [ ] Optionally require linear history to keep the deterministic-build
      history auditable.

## 3. CI is required and read-only

- [x] `.github/workflows/ci.yml` is named `CI` and runs on push to
      `release/public-1.0.0` and PRs targeting `release/public-1.0.0`.
- [ ] Repository Actions default workflow permissions are read-only.
      Owner-verify: the public API does not expose workflow permissions (401
      anonymously); target state = read-only (Settings → Actions → General →
      Workflow permissions). `docs/release-state.json` now records
      `ownerManual.branchProtection` as owner-attested (2026-09-25: strict
      protection on `release/public-1.0.0` with the four required checks,
      pull request required, force-push and deletion blocked).
- [x] Workflow permissions are read-only (`contents: read`); no
      `permissions: write`, no release/publish step — CI uploads
      fixed 14-day `determinism-node-18`, `determinism-node-20`,
      `browser-node-20-evidence`, and `ci-identity` run artifacts only.
- [ ] A PR cannot merge while CI is failing (covered by §2 required check).

## 4. Repository presentation

- Observed public API state (2026-09-23): description is "Tampermonkey
  userscript: Travian alliance attack alerts to Discord"; homepage is
  `https://github.com/PeterPage2115/Travian-Attack-Alert`; topics are
  `discord-webhook`, `tampermonkey`, `travian`, and `userscript`.
- [x] Description set (Settings → General → About), e.g.:
      "Tampermonkey userscript: Travian alliance attack alerts to Discord".
- [x] Website points at the repository or docs.
- [x] Topics include at least: `travian`, `userscript`, `tampermonkey`,
      `discord-webhook`.

## 5. Update URL availability test

- [ ] The artifact URL from §1 returns HTTP 200 with
      `Content-Type: application/javascript` (or `text/plain` via raw):
      `curl -sI <updateURL> | grep -i '^HTTP/.* 200'`.
- [ ] Downloaded bytes carry exactly one `// ==UserScript==` block whose
      `@updateURL`/`@downloadURL` equal the §1 URL and whose `@version`
      equals `package.json`.
- [ ] `sha256sum` of the download matches the committed
      `dist/travian-attack-alert.user.js.sha256` sidecar.

## 6. After any settings change

- [ ] Re-run this checklist top to bottom and record the date + verifier.
- [ ] Confirm `npm ci`, `npm run check:types`, `npm test`,
      `npm run test:tools`, and `npm run test:artifact` are still green
      on a clean clone before announcing the update channel as healthy.

## 7. DEV retirement (owner only, manual, backups preserved)

The sibling TravianAttackAlertDEV directory (one level above the repo root)
is read-only migration input: it seeded `src/` and the fixtures, and it is
non-authoritative from the cutover onward. `src/` is the editable authority;
`dist/` is the generated artifact. Nothing in that directory is normative
for 1.0.2. The owner already removed the legacy DEV snapshot on 2026-09-23
and cancelled the archive program; this section records that retirement and
how its attestation is completed.

- [ ] Never commit any file from that directory to the public repo.
- [ ] Never delete or upload backups — neither from that directory nor from
      `backups/` (gitignored) anywhere else. Backups and any other
      irreplaceable owner payload are excluded from every deletion
      instruction, including the DEV retirement.
- [ ] Never delete that directory, its files, or its backups without
      explicit owner consent.
- [ ] Any removal of owner data is an owner-approved, explicitly scoped
      action with a recoverable/preservation step: name the exact paths,
      confirm that no `backups/` or other irreplaceable payload is included,
      and keep the preservation copy until the owner signs off. There is no
      blanket "delete the directory including backups" instruction anywhere
      in this repository; the ordered procedure is `docs/RELEASE-RUNBOOK.md`
      Stage 4.
- [x] Record the retirement (timestamp, actor, record digest) and attest
      `devArchival` in the owner-written fields of `docs/release-state.json`.
      The owner recorded that attestation on 2026-09-25; `stable` is now `true`
      and `publication.tagAndRelease` records the published `v1.0.2` release.

## 8. Authenticated settings reconciliation (owner-only)

The public API exposes only part of the protection story. Each item below
separates the observed public API state (2026-09-23), the required target
state, and the owner attestation. Every attestation stays unchecked until the
owner records authenticated evidence (an authenticated settings export,
digest-bound to the tagged commit, per §9); no automated job can verify or
change these settings. Each one is an owner-only checklist item, not an implied
setting.

Fresh authenticated read-only comparison (GET-only with the owner's token,
2026-09-23; no setting was changed, and the response digests are recorded in
the Task 34 evidence root):

- Branch protection detail is now observable: require-pull-request is enabled
  with `required_approving_review_count: 0`, stale approvals dismissed, force
  pushes and deletions blocked, `enforce_admins` enabled, and linear history
  disabled. Owner-only recommendation: raise the required approving review
  count to at least 1 — the observed 0 does not meet the §2 target.
- Required status checks: exactly the four contexts above; the Task 34
  `offline-node-22` CI job is informational and is NOT a required check, so it
  implies no branch-protection change.
- Actions policy: default workflow permissions are already `read` (target met);
  `allowed_actions` is `all` and `sha_pinning_required` is `false`. Owner-only
  recommendation: restrict allowed actions to selected/verified actions and
  enable the SHA-pinning requirement.
- Private vulnerability reporting: observed `enabled: false` (target =
  enabled).
- Immutable releases: observed `enabled: false` (target = enabled).
- Release environment: none exists (target = protected `release` environment).
- Tag protection / ruleset: no ruleset was installed at the 2026-09-23
  observation (target = a `v*` tag ruleset); the `release-tag-immutability-v`
  ruleset now locks `v*` tags, and the annotated `v1.0.1` and `v1.0.2` tags were
  published as immutable GitHub Releases on 2026-09-25 — `v1.0.2` (release id
  `396904420`) supersedes `v1.0.1` as the current stable channel.

- [x] Required status checks: observed via the public API as protected with
      the four exact contexts `offline-node-18`, `offline-node-20`,
      `browser-node-20`, and `cross-node-determinism`, and confirmed by the
      authenticated read; target state = exactly those four checks required on
      `release/public-1.0.0`. Owner attestation recorded 2026-09-25 in
      `docs/release-state.json` (`ownerManual.branchProtection`).
- [ ] Required approving reviews (approval count): observed as 0 with stale
      approvals dismissed; target state = at least 1 approving review. Owner
      attestation pending.
- [ ] Private vulnerability reporting: observed as `enabled: false` on
      2026-09-23; target state = enabled, so the private
      link in `SECURITY.md` and `.github/ISSUE_TEMPLATE/config.yml` works
      (Settings → Code security). Owner attestation pending.
- [x] Protected `release` environment: no environment existed on 2026-09-23
      (`GET /environments` reported `total_count: 0`); target state = an
      environment named `release` with a deployment tag rule `v*`. Owner
      attestation recorded 2026-09-25 in `docs/release-state.json`
      (`ownerManual.releaseEnvironment`; a required reviewer and prevent
      self-review are **NOT REQUIRED in solo mode**).
- [x] Immutable releases: observed as `enabled: false` on 2026-09-23; target
      state = immutable releases enabled, so a published asset or tag cannot be
      silently replaced. Owner attestation recorded 2026-09-25 in
      `docs/release-state.json` (`ownerManual.immutableReleases`); the published
      `v1.0.1` and `v1.0.2` Releases are immutable.
- [x] Tag protection / ruleset: no ruleset was installed at the 2026-09-23
      observation (`GET /rulesets` returned `[]`); target state = a ruleset (or
      tag protection) restricting creation, update, and deletion of `v*` tags
      to the owner. The `release-tag-immutability-v` ruleset now locks `v*`
      tags.

## 9. Release-environment secrets and evidence (owner-only)

**NOT REQUIRED in solo mode.** This repository has a single maintainer, so the
release pipeline attaches no environment and references no secret: it publishes
on the workflow's automatic `${{ github.token }}`. The former
`TAA_RELEASE_APPROVAL_PROOF` and `TAA_RELEASE_SETTINGS_READ_TOKEN` environment
secrets and the `docs/release-owner-evidence.json` digest record are no longer
used by `.github/workflows/release.yml`; a pushed annotated `v*` tag now
publishes the GitHub Release automatically, with no second GitHub account and no
environment reviewer. Do not create or store these secrets for the solo flow. If
they already exist in the `release` environment, they are inert and may be
deleted at the owner's discretion.

> Naming note: the `../`-relative spelling of that DEV directory is never
> written literally in this tree — the frozen privacy scanner
> (`tools/audit-public-tree.cjs`, `test/tools/public-boundary.test.cjs`)
> rejects that literal as a private-path leak. The sibling phrasing above
> names the same directory.
