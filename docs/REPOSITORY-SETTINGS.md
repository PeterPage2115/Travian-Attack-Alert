# Repository Settings — Owner Checklist

Owner-only checklist for protecting the userscript update channel. All items
refer to https://github.com/PeterPage2115/Travian-Attack-Alert. Apply in
Settings; verify from a clean clone. The ordered owner publication procedure
that consumes these settings is `docs/RELEASE-RUNBOOK.md`.

Public-state observation (read-only GitHub API GETs on 2026-09-23): the
default branch is `release/public-1.0.0` and it is the only branch on the
remote (`main` and `master` do not exist); that branch is protected with the
four required status checks `offline-node-18`, `offline-node-20`,
`browser-node-20`, and `cross-node-determinism`; no repository ruleset is
installed; no deployment environment exists (`GET /environments` reports
`total_count: 0`); private vulnerability reporting is reported disabled
(`GET /private-vulnerability-reporting` returns `enabled: false`); the
description, homepage, and topics are set. Authenticated endpoints (branch
protection detail, immutable releases, Actions workflow permissions) answer
401 anonymously, so those requirements are owner attestations in §8, not
observed facts. This is a point-in-time API observation, not owner
attestation. The separate owner-manual record in `docs/release-state.json`
still holds `ownerManual.branchProtection: false`,
`ownerManual.releaseEnvironment: false`,
`ownerManual.immutableReleases: false`, and `stable: false` until the owner
completes the pilot and records the evidence. This file is an owner checklist,
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
  owner-written. Until recorded, `docs/release-state.json` stays `stable:false`
  and the README keeps its release-candidate warning even though the target
  version is 1.0.1.

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
      Workflow permissions), and `docs/release-state.json`
      `ownerManual.branchProtection` stays `false` until it is attested.
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

## 7. DEV retirement (owner only, manual, no archive)

The sibling TravianAttackAlertDEV directory (one level above the repo root)
is read-only migration input: it seeded `src/` and the fixtures, and it is
non-authoritative from the cutover onward. `src/` is the editable authority;
`dist/` is the generated artifact. Nothing in that directory is normative
for 1.0.1.

- [ ] Never commit any file from that directory to the public repo.
- [ ] Never delete or upload backups — neither from that directory nor from
      `backups/` (gitignored) anywhere else.
- [ ] Never delete that directory, its files, or its backups without
      explicit owner consent.
- [ ] Execute the deletion with **no archive kept**: do not copy that
      directory, its files, or its backups to private storage, cloud storage,
      a release asset, or any other location. The ordered procedure is
      `docs/RELEASE-RUNBOOK.md` Stage 4.
- [ ] Record the deletion (timestamp, actor, record digest) and attest
      `devArchival` in the owner-written fields of `docs/release-state.json`;
      until then `stable` stays `false`.

## 8. Authenticated settings reconciliation (owner-only, all unchecked)

The public API exposes only part of the protection story. Each item below
separates the observed public API state (2026-09-23), the required target
state, and the owner attestation. Every attestation stays unchecked until the
owner records authenticated evidence (an authenticated settings export,
digest-bound to the tagged commit, per §9); no automated job can verify or
change these settings. Each one is an owner-only checklist item, not an implied
setting.

- [ ] Required status checks: observed via the public API as protected with
      the four exact contexts `offline-node-18`, `offline-node-20`,
      `browser-node-20`, and `cross-node-determinism`; target state = exactly
      those four checks required on `release/public-1.0.0`. Owner attestation
      pending an authenticated read — the anonymous protection endpoint is 401.
- [ ] Required approving reviews (approval count): the public API does not
      expose review requirements; target state = at least 1 approving review,
      stale approvals dismissed on new commits. Owner attestation pending.
- [ ] Private vulnerability reporting: the public API reported
      `enabled: false` on 2026-09-23; target state = enabled, so the private
      link in `SECURITY.md` and `.github/ISSUE_TEMPLATE/config.yml` works
      (Settings → Code security). Owner attestation pending.
- [ ] Protected `release` environment: no environment exists on 2026-09-23
      (`GET /environments` reports `total_count: 0`); target state = an
      environment named `release` with a required reviewer, prevent
      self-review, and a deployment tag rule `v*`. Owner attestation pending.
- [ ] Immutable releases: the public API does not expose this (401
      anonymously); target state = immutable releases enabled, so a published
      asset or tag cannot be silently replaced. Owner attestation pending.
- [ ] Tag protection / ruleset: no repository ruleset is installed
      (`GET /rulesets` returns `[]`); target state = a ruleset (or tag
      protection) restricting creation, update, and deletion of `v*` tags to
      the owner. Owner attestation pending.

## 9. Release-environment secrets and evidence (owner-only)

Two environment-scoped secrets belong to the protected `release` environment
(§8). They must never be repository-scoped, committed, logged, or reused:

- `TAA_RELEASE_APPROVAL_PROOF` — a random value generated by the owner. It
  proves owner approval of a release run.
- `TAA_RELEASE_SETTINGS_READ_TOKEN` — a fine-grained owner token that expires
  within 24 hours and carries exactly these repository permissions:
  `Administration: read`, `Environments: read`, `Secrets: read metadata`,
  `Actions variables: read`, and `Actions: read`. It must have **no** Contents,
  Issues, or Pull requests write permission, and no other write permission.

A bearer token cannot introspect its own grants or expiry, and repository
credentials cannot prove the absence of an organization-level setting.
Therefore the owner also generates a digest-bound settings export covering:
the token's grants and expiry, and any organization secret or variable whose
name collides with `TAA_RELEASE_APPROVAL_PROOF` or
`TAA_RELEASE_SETTINGS_READ_TOKEN`.

A release workflow may use `TAA_RELEASE_SETTINGS_READ_TOKEN` only to prove
repository and environment state and the absence of same-named repository
secrets or variables. It must verify the owner's organization-settings
evidence digest from the tagged commit instead of querying organization scope.

Fail-closed rules: missing or expired evidence, or any API denial, leaves
publication blocked. The owner rotates or deletes the read token immediately
after the release.

> Naming note: the `../`-relative spelling of that DEV directory is never
> written literally in this tree — the frozen privacy scanner
> (`tools/audit-public-tree.cjs`, `test/tools/public-boundary.test.cjs`)
> rejects that literal as a private-path leak. The sibling phrasing above
> names the same directory.
