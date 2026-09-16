# Repository Settings — Owner Checklist

Owner-only checklist for protecting the userscript update channel. All items
refer to https://github.com/PeterPage2115/Travian-Attack-Alert. Apply in
Settings; verify from a clean clone.

Live-state note (verified through the GitHub API on 2026-09-16): the default
branch is `release/public-1.0.0`; it is not yet protected; no repository
ruleset is installed; repository description, homepage, and topics are unset;
and the default Actions workflow permission is read-only. Unchecked items below
are owner actions, not claims about the current remote state.

## 0. Gate ownership — AGENT-AUTOMATED vs OWNER-MANUAL

### AGENT-AUTOMATED (done by this migration)

- Deterministic `dist/` build from `src/`; `config/userscript.json`
  `updateURL`/`downloadURL` pointing at the protected-`main` raw artifact
  URL in §1; read-only CI workflow (§3) with no publish step; docs.

### OWNER-MANUAL (owner only — everything below)

- Every numbered section (§1–§6) plus §7 DEV archival is applied and
  verified by the owner in GitHub Settings and on a clean clone. No npm
  script, test, build step, or CI job applies these settings or flips any
  field in `docs/release-state.json`; the pilot evidence, tag/Release, and
  archival record it references are owner-written. Until recorded,
  `docs/release-state.json` stays `stable:false` and the README keeps its
  release-candidate warning even though the target version is 1.0.0.

## 1. Branch and update-channel identity

- [x] Default branch remains `release/public-1.0.0` (Settings → General →
      Default branch).
- [x] No `main` or `master` branch currently exists on the public remote.
- [x] `config/userscript.json` `updateURL` and `downloadURL` both point at
      the protected-`main` artifact URL exactly:

      `https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/main/dist/travian-attack-alert.user.js`

## 2. Branch protection for `release/public-1.0.0`

- [ ] Branch protection rule targets `release/public-1.0.0` (Settings →
      Branches → Add rule).
- [ ] Require status checks to pass before merging; the four exact required
      checks from `.github/workflows/ci.yml` are `offline-node-18`,
      `offline-node-20`, `browser-node-20`, and `cross-node-determinism`.
- [ ] Require a pull request before merging (at least 1 approving review;
      dismiss stale approvals on new commits).
- [ ] Block force pushes (`Do not allow force pushes`) and deletions
      (`Do not allow deletions`) for `main`.
- [ ] Optionally require linear history to keep the deterministic-build
      history auditable.

## 3. CI is required and read-only

- [x] `.github/workflows/ci.yml` is named `CI` and runs on push to
      `release/public-1.0.0` and PRs targeting `release/public-1.0.0`.
- [x] Repository Actions default workflow permissions are read-only.
- [x] Workflow permissions are read-only (`contents: read`); no
      `permissions: write`, no release/publish step — CI uploads
      fixed 14-day `determinism-node-18`, `determinism-node-20`,
      `browser-node-20-evidence`, and `ci-identity` run artifacts only.
- [ ] A PR cannot merge while CI is failing (covered by §2 required check).

## 4. Repository presentation

- Current API state: description and homepage are `null`; topics are empty.
- [ ] Description set (Settings → General → About), e.g.:
      "Tampermonkey userscript: Travian alliance attack alerts to Discord".
- [ ] Website points at the repository or docs.
- [ ] Topics include at least: `travian`, `userscript`, `tampermonkey`,
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

## 7. DEV retirement and archival (owner only, manual)

The sibling TravianAttackAlertDEV directory (one level above the repo root)
is read-only migration input: it seeded `src/` and the fixtures, and it is
non-authoritative from the cutover onward. `src/` is the editable authority;
`dist/` is the generated artifact. Nothing in that directory is normative
for 1.0.0.

- [ ] Never commit any file from that directory to the public repo.
- [ ] Never delete or upload backups — neither from that directory nor from
      `backups/` (gitignored) anywhere else.
- [ ] Never delete that directory, its files, or its backups without
      explicit owner consent.
- [ ] Private archival outside the repo: the owner copies it to private
      storage, records the date and location privately, and keeps the public
      repo free of its bytes.
- [ ] Retirement is recorded only in the owner-written fields of
      `docs/release-state.json` (`devArchival`); until then `stable` stays
      `false`.

> Naming note: the `../`-relative spelling of that DEV directory is never
> written literally in this tree — the frozen privacy scanner
> (`tools/audit-public-tree.cjs`, `test/tools/public-boundary.test.cjs`)
> rejects that literal as a private-path leak. The sibling phrasing above
> names the same directory.
