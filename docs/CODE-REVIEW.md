# Code-review verification (standing rules)

Origin: Qodo bot review on PR #2 (merged as `4da2a1b`): 8 bugs + 3 rule
violations. Independent verification confirmed 9 of 11, 2 partial, 0 refuted.
Threads were resolved to unblock merge without per-claim fixes. This file is
the standing commitment to keep all 11 correct.

## Process (obowiazuje zawsze)

1. Every external review comment is verified with a repro command before it is
   resolved or dismissed. Resolving threads without evidence is forbidden.
   Every confirmed finding must remain open or, before resolution, record its
   remediation, owner, tracking issue, or explicit accepted-risk decision
   alongside the required verification evidence.
2. Evidence goes to `.omo/notepads/qodo-review-verification/` (append-only,
   never committed). This doc links gates, it does not duplicate evidence.
3. Each item below maps to an EXISTING gate only. No new executable checks.

Related: contributor entry `AGENTS.md`, daily routine `docs/OPERATIONS.md`,
module graph `docs/architecture.md` §10.

## The 11 items

| # | Rule (one sentence) | Standing gate | Repro proof |
|---|---------------------|---------------|-------------|
| 1 | `src/storage.js` facade must not silently drop writes when unconfigured. | `storage-roundtrip` suite (17/17) + `module-architecture` (15/15) | `node -e` facade probe: save then load returns `{}` before `storage-impl.configureStorageAdapters`, round-trips `{"p1":"X"}` after |
| 2 | `src/lease.js` facade must acquire ownership when adapters are configured. | `module-architecture` ownership tests + lease suite | `node -e` facade probe: `acquireLease` returns `null` unconfigured, `true` after `lease-impl.configureLeaseAdapters` |
| 3 | `tools/audit-public-tree.cjs --mode secrets` must not skip oversized files silently. | `audit-public-tree.cjs:517-529` + size inventory (`git ls-files -s` + `wc -c`) | 8,388,700-byte file with a known webhook: `node tools/audit-public-tree.cjs --mode secrets --root "$tmp" --out report.json` returns PASS with `secretHits=[]` |
| 4 | `src/parser.js` facade must not return `[]` on a populated members page. | Parser suite + `aggregator-cutover` (5/5) | `node -e` on facade: zero-arg call returns `[]`; same call with a fake `allianceMembers` doc returns the member row |
| 5 | No non-exempt private identity or secret may reach tracked files or `dist/`. | `audit-public-tree.cjs --mode secrets` + `test/tools/public-boundary.test.cjs` (12/12) | `node tools/audit-public-tree.cjs --mode secrets --root . --out report.json` PASS plus `node --test test/tools/public-boundary.test.cjs` |
| 6 | `npm run check:types` must be fail-closed, including compiler/config failures. | `tools/check-types-ratchet.cjs` + type-error-baseline + `run-quality-ratchet-mutations.cjs --cases new-type-error` | Temp copy with `tsconfig.json.include` pointed at an empty glob: gate exits 0 with `actualTotal:0, verdict:PASS` (TS18003 unparsed) |
| 7 | `test-inventory` relocation must not hide lost suites or executions. | `test/tools/test-inventory.cjs` + `test-suite-baseline.json`/`test-suite-manifest.json` + `test-inventory.test.cjs` (5/5) | Temp copy swapping `delivery-matrix` (16 executions) for a 1-execution suite keeps the same baseline ID: inventory still exits 0 with PASS |
| 8 | PARTIAL: facade consumers keep per-symbol reference identity. | `test/tools/module-architecture.test.cjs:258` (per-symbol `===`) + `aggregator-cutover` (5/5) | `node -e` probe: all 17 `facade[n]===impl[n]`, `api.lease===facade`, but `facade===impl` is `false` by design (`storage` `select()` requires a fresh object) |
| 9 | PARTIAL: lifecycle singletons have exactly one declared owner. | `test/tools/module-architecture.test.cjs:271-295` + ownership graph (`singletonOwner: src/lifecycle.js`) | `grep -R "require('./lifecycle.js')" src/` is empty; `runtime.js:309-337` legacy copies are pinned transition state, deleted only at cutover |
| 10 | Browser/e2e artifacts must pass the evidence privacy scan before upload. | `tools/audit-public-tree.cjs --mode evidence` (`:812-1152`, fail-closed) + CI cleanup job (`.github/workflows/ci.yml:113-121`) | Workflow parse of the `browser-node-20` block: `evidenceModeCalls:0`, `uploadAlways:true`; temp evidence run exits 1 fail-closed |
| 11 | `tools/backup.cjs` must not report success for a tampered payload. | `tools/backup.cjs` + `tools/rollback.cjs` (`lstatSync` rejects symlinks) + backup-rollback and mutation runners | Temp copy: symlink-swap `config/userscript.json` to same-byte external file, rerun backup (status 0) then rollback (status 1, not a regular file) |

## What "correct" means for the 2 PARTIAL items

- Item 8: correct means symbol-level identity (`facade[n]===impl[n]` for every
  symbol, `api.lease===facade`), pinned by the architecture test. Module-object
  identity (`facade===impl`) is explicitly not required.
- Item 9: correct means the ownership graph names `src/lifecycle.js` as owner
  with `runtimeAuthoritative:true`, and no production file requires the
  controller. Dual declaration in `src/runtime.js` is pinned transition state.

## Known EXPECTED_FAILs (do not re-litigate)

- `delivery-matrix` (h) split-count assertion: recorded honestly by the gate.
- E2E port-8899 conflict when specs share a runner: environmental, not a product
  defect.
