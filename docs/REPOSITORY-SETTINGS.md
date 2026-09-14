# Repository Settings — Owner Checklist

Owner-only checklist for protecting the userscript update channel. All items
refer to https://github.com/PeterPage2115/Travian-Attack-Alert. Apply in
Settings; verify from a clean clone.

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
