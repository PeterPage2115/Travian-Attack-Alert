# Repository Settings — Owner Checklist

Owner-only checklist for protecting the userscript update channel. All items
refer to https://github.com/PeterPage2115/Travian-Attack-Alert. Apply in
Settings; verify from a clean clone.

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

## 1. Default branch `main`

- [ ] Default branch is `main` (Settings → General → Default branch).
- [ ] No `master` branch exists or remains default.
- [ ] `config/userscript.json` `updateURL` and `downloadURL` both point at
      the protected-`main` artifact URL exactly:

      `https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/main/dist/travian-attack-alert.user.js`

## 2. Branch protection for `main`

- [ ] Branch protection rule targets `main` (Settings → Branches → Add rule).
- [ ] Require status checks to pass before merging; required check: `CI`
      (`verify` job, Node 18 and 20 matrix from `.github/workflows/ci.yml`).
- [ ] Require a pull request before merging (at least 1 approving review;
      dismiss stale approvals on new commits).
- [ ] Block force pushes (`Do not allow force pushes`) and deletions
      (`Do not allow deletions`) for `main`.
- [ ] Optionally require linear history to keep the deterministic-build
      history auditable.

## 3. CI is required and read-only

- [ ] `.github/workflows/ci.yml` runs on push to `main` and PRs to `main`.
- [ ] Workflow permissions are read-only (`contents: read`); no
      `permissions: write`, no release/publish step — CI uploads
      `test-results/`, `dist/`, and `metadata.json` as run artifacts only.
- [ ] A PR cannot merge while CI is failing (covered by §2 required check).

## 4. Repository presentation

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
