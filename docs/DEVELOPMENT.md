# Development Environment — WSL / DrvFS and Linux

Reproducible local workflow for this repository. `AGENTS.md` holds the project
rules; this page covers environment setup, test tiers, evidence handling, line
endings, and the read-only canonical checkout. It is a contributor guide, not
an operational or release document.

## Workspace layout: canonical checkout, task worktrees, evidence root

- **Canonical checkout** — the primary clone that carries the owner's dirty
  `dist/` bytes (the first entry of `git worktree list`). It is **read-only for
  contributors**: never run `npm run build`, `npm test`, `npm run backup`, or
  any other command that writes files there.
- **Task worktree** — every edit, build, and test run happens in a task
  worktree (`.worktrees/<task>`). `git worktree list` shows the canonical
  checkout first and the worktrees after it.
- **Evidence root** — the `.omo/` directory beside the canonical checkout and
  `.worktrees/` (outside the Git repository). Task receipts, evidence, plans,
  and notepads live there and are never committed. An in-repo `.omo/` is
  ignored by `.gitignore` and is **not** the evidence root: never commit it and
  never treat it as proof.

## Node and npm version selection

- `.node-version` names the documented development major: **22.19.0**. Use
  Node 22 for local work.
- `package.json` `engines.node` stays `>=18`: Node 18 and Node 20 remain
  supported CI legs and must not be dropped, and `engines.node` must not be
  raised without an explicit compatibility proof.
- `package.json` `packageManager` records `npm@10.9.3`; use the npm that ships
  with the selected Node and keep the lockfile exact.
- CI matrix: `offline-node-18`, `offline-node-20`, `browser-node-20`, and
  `cross-node-determinism` are the four required status checks, plus the
  informational `offline-node-22` development leg. The Node 22 job is **not**
  a required check until the owner separately updates branch protection.
- Check the selection before running anything:
  `node --version && npm --version`.

## Install with npm ci

- `npm ci` is the only supported install: it is lockfile-exact and never edits
  `package-lock.json`. Do not use `npm install` for verification.
- For a throwaway verification checkout, clone the task worktree instead of
  reusing it: `git clone --shared <task-worktree> <disposable-dir>` (fast,
  object-sharing), then `npm ci && npm run build`.

## Playwright browsers and test tiers

- Install the pinned Chromium once per machine:
  `npx playwright install --with-deps chromium`. CI installs it in
  `browser-node-20` and in `offline-node-22` before the release gate.
- Tiers, cheapest first:
  - `npm run test:offline` — offline unit and parity suites (no browser).
  - `npm run test:tools` / `npm run test:artifact` — tooling and generated
    artifact contracts.
  - `npm run test:characterization` — manifest-owned suites that must leave
    HEAD-bound receipts under `test-results/suite-receipts/`.
  - `npm test` — characterization, offline, tools, and artifact suites (the
    standard local gate; no browser).
  - `npm run test:browser` — real Chromium integration suites.
  - `npm run test:e2e` — the loopback QA matrix through
    `tools/run-e2e.cjs --release`; it needs Chromium, takes several minutes,
    and has a 480 s per-spec ceiling that must never be lowered.
  - `npm run check:release -- --offline` — the complete offline release gate:
    build, versions, artifact, source, characterization, inventory, tools,
    types, quality, browser, and e2e. There is no `NOT_EXECUTED` verdict; a
    gate that cannot execute fails. Run it only where Chromium is installed;
    CI runs it exactly once, as a blocking step in `offline-node-22`.

## Back up before editing src/ or config/

- Run `npm run backup` **before** every edit to `src/` or `config/`, and keep
  the printed selector.
- Roll back only with `node tools/rollback.cjs <selector>` followed by
  `npm run build`; never clear site data — that destroys rosters, mappings, and
  role configuration with no recovery.

## Frozen test provenance

- Frozen: do not edit and do not re-seal
  `test/tools/test-inventory.cjs`, `test/tools/test-inventory.test.cjs`,
  `test/fixtures/contracts/test-suite-baseline.json`, and
  `test/fixtures/contracts/runtime-contract.provenance.json`.
- `test/fixtures/contracts/test-suite-manifest.json` is the mutable manifest:
  update it only for a real execution-count change, with recomputed totals.
- Receipts bind to HEAD, tree, and worktree digest. After committing, run
  `npm test` (to rebind characterization receipts) and then `npm run check`
  (inventory) — a stale binding fails closed.

## Line endings and .gitattributes

- `.gitattributes` declares `* text=auto eol=lf`: every text file is LF in the
  index and on checkout, and known binary formats are marked binary.
- Keep `core.autocrlf false` on Windows/DrvFS; the attributes already
  normalize both directions.
- Run `git diff --check` before committing; a CRLF or trailing-whitespace file
  fails the repository contract tests.

## Case-only renames and core.ignorecase

- DrvFS and NTFS are case-insensitive, so this workstation runs with
  `git config core.ignorecase true`. A case-only rename (`Docs/x.md` to
  `docs/x.md`) can then look like a no-op and produce a tracked-path collision.
- Rename case-only paths in two steps (through a temporary name) with
  `git mv`, commit, and verify the result with `git ls-files` — never rely on
  the filesystem to report the difference.

## Owner data is never deleted

- `backups/` (gitignored) holds recovery selectors. Never delete, prune,
  archive, upload, or clean them, and never reset site data.
- `test-results/` and `.omo/` are evidence inputs; do not remove them
  destructively. Temporary fixtures belong under `/tmp`, not in the repository.
- Never run `git gc`, `git worktree prune`, `git reset --hard`, or delete a
  worktree, and never push, tag, or publish without explicit owner consent.

## The protected canonical checkout

- The canonical checkout is protected precisely because it is dirty: its
  `dist/`, `metadata.json`, and ignored owner state are recorded in a manifest
  digest that is hashed into the audit receipts. Any build or write there
  changes that digest and invalidates the audit.
- Verify the digest before and after any work and require it identical; never
  point a build, test, backup, or release command at the canonical path.

## Optional: ext4 task worktree (performance tactic, not a mandate)

- DrvFS is noticeably slower than ext4. Creating the task worktree on ext4
  (under `/tmp` or the Linux home filesystem) speeds up `npm ci` and the test
  tiers.
- This is optional: it is not required, and existing repository worktrees and
  their evidence paths must not be moved for performance. The canonical
  checkout stays where it is.

## Quick verification sequence

```bash
node --version && npm --version
npm ci
npm run build
npm test
npm run check:types
npm run check
git diff --check
```

For the complete release-grade check (needs Chromium):

```bash
npx playwright install --with-deps chromium
npm run check:release -- --offline
```
