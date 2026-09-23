'use strict';

// v2 inventory contract: a relocation may move a suite's path but MUST NOT
// change its classification, coverage labels, or execution count. v1 accepted
// the 16-execution `delivery-matrix` suite being swapped for an unrelated
// 1-execution suite as long as a relocation record named the new path
// (docs/CODE-REVIEW.md item 7). v2 keeps v1's discovery/basic validation and
// fails closed on any weakening relocation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const v1 = require('./test-inventory.cjs');
const v2 = require('./test-inventory-v2.cjs');
const runner = require('../../tools/run-characterization.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

const RUNTIME_PARITY = {
  id: 'suite:test/runtime-parity.test.cjs',
  path: 'test/runtime-parity.test.cjs',
  classification: 'source-artifact',
  expectedExecutionCount: 2,
  coverage: ['runtime-api-exports', 'storage-keys'],
};

const DELIVERY = {
  id: 'suite:test/artifact/delivery-matrix.test.cjs',
  path: 'test/artifact/delivery-matrix.test.cjs',
  classification: 'dist-artifact',
  expectedExecutionCount: 16,
  coverage: ['dist-runtime', 'delivery-matrix'],
};

const OTHER = {
  id: 'suite:test/tools/other.test.cjs',
  path: 'test/tools/other.test.cjs',
  classification: 'tool',
  expectedExecutionCount: 3,
  coverage: ['repository-tooling', 'other'],
};

const BRIDGE = {
  id: 'suite:test/artifact/bridge.test.cjs',
  path: 'test/artifact/bridge.test.cjs',
  classification: 'dist-artifact',
  expectedExecutionCount: 5,
  coverage: ['dist-runtime', 'bridge'],
};

const UNRELATED = {
  id: 'suite:test/tools/unrelated.test.cjs',
  path: 'test/tools/unrelated.test.cjs',
  classification: 'tool',
  expectedExecutionCount: 1,
  coverage: ['repository-tooling'],
};

function fixture({ baselineSuites = [RUNTIME_PARITY, DELIVERY], manifestSuites = [RUNTIME_PARITY, DELIVERY], relocations = [], totals, discovered } = {}) {
  const baseline = { schemaVersion: 1, suites: structuredClone(baselineSuites) };
  const manifest = { schemaVersion: 1, suites: structuredClone(manifestSuites), relocations: structuredClone(relocations) };
  if (totals !== undefined) manifest.totals = structuredClone(totals);
  return { baseline, manifest, discovered: discovered || manifest.suites.map(suite => suite.path) };
}

function totalsFor(suites) {
  const byClassification = {};
  let expectedExecutionCount = 0;
  for (const suite of suites) {
    expectedExecutionCount += suite.expectedExecutionCount;
    const bucket = byClassification[suite.classification] || (byClassification[suite.classification] = { suiteCount: 0, expectedExecutionCount: 0 });
    bucket.suiteCount += 1;
    bucket.expectedExecutionCount += suite.expectedExecutionCount;
  }
  return { suiteCount: suites.length, expectedExecutionCount, byClassification };
}

function movedDelivery(path, overrides = {}) {
  return { ...structuredClone(DELIVERY), path, ...overrides };
}

const MOVED_PATH = 'test/artifact/delivery-matrix-relocated.test.cjs';

// A renamed move escapes v1's retained-id floor check (count >= baseline,
// coverage superset) so the v2 exact-equality gate is the only thing left.
function renamedDelivery(overrides = {}) {
  return movedDelivery(MOVED_PATH, { id: 'suite:test/artifact/delivery-matrix-relocated.test.cjs', ...overrides });
}

test('v1 accepts the 16-to-1 substitution that v2 must reject (934-vs-949 bypass, scaled)', () => {
  // Real-repo mapping: baseline delivery-matrix = 16 executions of 949; the
  // bypass swapped it for a 1-execution suite and still reported PASS with 934.
  const bypass = fixture({
    manifestSuites: [RUNTIME_PARITY, UNRELATED],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: UNRELATED.path }],
  });
  const v1Result = v1.verifyInventory(bypass);
  assert.equal(v1Result.verdict, 'PASS');
  assert.equal(v1Result.expectedExecutions, 3); // 18 -> 3: 16 executions vanished silently.
  assert.throws(
    () => v2.verifyInventory(bypass),
    error => /test-inventory-v2/u.test(error.message)
      && /classification mismatch/u.test(error.message)
      && /execution count mismatch/u.test(error.message)
      && /coverage mismatch/u.test(error.message),
  );
});

test('legitimate same-coverage path moves pass with declared totals', () => {
  const retainedMove = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  retainedMove.manifest.totals = totalsFor(retainedMove.manifest.suites);
  assert.deepEqual(v2.verifyInventory(retainedMove), {
    verdict: 'PASS',
    suites: 2,
    expectedExecutions: 18,
    relocations: 1,
    receiptBackedSuites: 0,
    totals: totalsFor(retainedMove.manifest.suites),
  });

  const renamedMove = fixture({
    manifestSuites: [RUNTIME_PARITY, renamedDelivery()],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  renamedMove.manifest.totals = totalsFor(renamedMove.manifest.suites);
  assert.equal(v2.verifyInventory(renamedMove).verdict, 'PASS');
});

test('lower execution count in a relocation fails', () => {
  const reduced = fixture({
    manifestSuites: [RUNTIME_PARITY, renamedDelivery({ expectedExecutionCount: 15 })],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  assert.throws(() => v2.verifyInventory(reduced), /execution count mismatch/u);
});

test('lost coverage label in a relocation fails', () => {
  const dropped = fixture({
    manifestSuites: [RUNTIME_PARITY, renamedDelivery({ coverage: ['dist-runtime'] })],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  assert.throws(() => v2.verifyInventory(dropped), /coverage mismatch/u);
});

test('changed suite classification in a relocation fails', () => {
  const reclassified = fixture({
    manifestSuites: [RUNTIME_PARITY, renamedDelivery({ classification: 'tool' })],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  assert.throws(() => v2.verifyInventory(reclassified), /classification mismatch/u);
});

test('relocation target must match the retained path', () => {
  const diverted = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: RUNTIME_PARITY.path }],
  });
  assert.equal(v1.verifyInventory(diverted).verdict, 'PASS'); // v1 only checks that a relocation exists.
  assert.throws(() => v2.verifyInventory(diverted), /relocation target mismatch/u);
});

test('missing relocation fails', () => {
  const moved = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
  });
  assert.throws(() => v2.verifyInventory(moved), /missing relocation/u);
});

test('ambiguous relocation for a suite that did not move fails', () => {
  const pointless = fixture({
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: DELIVERY.path }],
  });
  assert.throws(() => v2.verifyInventory(pointless), /ambiguous relocation|does not move/u);
});

test('ambiguous relocation onto a retained baseline path fails', () => {
  const collision = fixture({
    manifestSuites: [RUNTIME_PARITY],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: RUNTIME_PARITY.path }],
  });
  assert.throws(() => v2.verifyInventory(collision), /ambiguous relocation/u);
});

test('chained relocation fails', () => {
  const bridgeMovedPath = 'test/artifact/bridge-relocated.test.cjs';
  const chained = fixture({
    baselineSuites: [RUNTIME_PARITY, DELIVERY, BRIDGE],
    manifestSuites: [RUNTIME_PARITY, movedDelivery(BRIDGE.path), { ...structuredClone(BRIDGE), path: bridgeMovedPath }],
    relocations: [
      { baselineId: DELIVERY.id, from: DELIVERY.path, to: BRIDGE.path },
      { baselineId: BRIDGE.id, from: BRIDGE.path, to: bridgeMovedPath },
    ],
  });
  assert.equal(v1.verifyInventory(chained).verdict, 'PASS'); // v1 sees two unrelated hops.
  assert.throws(() => v2.verifyInventory(chained), /chained relocation/u);
});

test('many-to-one relocation fails', () => {
  const mergedPath = 'test/tools/merged.test.cjs';
  const merged = { id: 'suite:test/tools/merged.test.cjs', path: mergedPath, classification: 'tool', expectedExecutionCount: 3, coverage: ['repository-tooling', 'other'] };
  const manyToOne = fixture({
    baselineSuites: [RUNTIME_PARITY, DELIVERY, OTHER],
    manifestSuites: [RUNTIME_PARITY, merged],
    relocations: [
      { baselineId: DELIVERY.id, from: DELIVERY.path, to: mergedPath },
      { baselineId: OTHER.id, from: OTHER.path, to: mergedPath },
    ],
  });
  assert.equal(v1.verifyInventory(manyToOne).verdict, 'PASS'); // v1 never compares relocation targets.
  assert.throws(() => v2.verifyInventory(manyToOne), /many-to-one relocation/u);
});

test('relocation source must equal the baseline path', () => {
  const forgedSource = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: 'test/artifact/elsewhere.test.cjs', to: MOVED_PATH }],
  });
  assert.equal(v1.verifyInventory(forgedSource).verdict, 'PASS'); // v1 trusts any declared `from` for retained ids.
  assert.throws(() => v2.verifyInventory(forgedSource), /relocation source mismatch/u);
});

test('stale declared totals fail against recomputed values', () => {
  const correct = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  correct.manifest.totals = totalsFor(correct.manifest.suites);
  assert.equal(v2.verifyInventory(correct).verdict, 'PASS');

  const wrongCount = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  wrongCount.manifest.totals = { ...totalsFor(wrongCount.manifest.suites), suiteCount: 3 };
  assert.throws(() => v2.verifyInventory(wrongCount), /totals\.suiteCount mismatch/u);

  const wrongExecutions = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  wrongExecutions.manifest.totals = { ...totalsFor(wrongExecutions.manifest.suites), expectedExecutionCount: 19 };
  assert.throws(() => v2.verifyInventory(wrongExecutions), /totals\.expectedExecutionCount mismatch/u);

  const wrongByClass = fixture({
    manifestSuites: [RUNTIME_PARITY, movedDelivery(MOVED_PATH)],
    relocations: [{ baselineId: DELIVERY.id, from: DELIVERY.path, to: MOVED_PATH }],
  });
  const staleByClass = totalsFor(wrongByClass.manifest.suites);
  staleByClass.byClassification['dist-artifact'].expectedExecutionCount = 15;
  wrongByClass.manifest.totals = staleByClass;
  assert.throws(() => v2.verifyInventory(wrongByClass), /totals\.byClassification\.dist-artifact/u);
});

test('v2 delegates discovery and hash validation to v1', () => {
  const unreported = fixture({ manifestSuites: [RUNTIME_PARITY], discovered: [RUNTIME_PARITY.path, DELIVERY.path] });
  assert.throws(() => v2.verifyInventory(unreported), error => error.message.startsWith('test-inventory: '));

  const docs = fixture();
  docs.manifest.behaviorOracleSha256 = 'oracle';
  docs.manifest.verifierHashes = { audit: 'digest' };
  assert.equal(v2.verifyInventory({ ...docs, oracleSha256: 'oracle', verifierHashes: { audit: 'digest' } }).verdict, 'PASS');
  assert.throws(() => v2.verifyInventory({ ...docs, oracleSha256: 'changed' }), /oracle/u);
  assert.throws(() => v2.verifyInventory({ ...docs, verifierHashes: { audit: 'changed' } }), /verifier/u);
});

// --- Task 18: receipt-backed accounting -----------------------------------
//
// A manifest registration is not execution proof. v2 must consume the receipt
// directory produced by tools/run-characterization.cjs and reject every way an
// execution claim can be missing, forged, stale, partial, or skipped.

const RECEIPT_HEAD = '1'.repeat(40);
const RECEIPT_TREE = '2'.repeat(40);
const RECEIPT_WORKTREE = '3'.repeat(64);
const RECEIPT_TAP = '4'.repeat(64);

const CHARACTERIZATION = {
  id: 'suite:test/characterization/acquisition-extract.test.cjs',
  path: 'test/characterization/acquisition-extract.test.cjs',
  classification: 'source-artifact',
  expectedExecutionCount: 8,
  coverage: ['test-characterization-acquisition-extract'],
};

const CHARACTERIZATION_TWO = {
  id: 'suite:test/characterization/transport-retry.test.cjs',
  path: 'test/characterization/transport-retry.test.cjs',
  classification: 'source-artifact',
  expectedExecutionCount: 11,
  coverage: ['test-characterization-transport-retry'],
};

function tempReceiptDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-task18-receipts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function resetReceiptDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function characterizationFixture(suites = [CHARACTERIZATION]) {
  return fixture({ baselineSuites: [RUNTIME_PARITY], manifestSuites: [RUNTIME_PARITY, ...suites] });
}

function receiptOptions(dir) {
  return { receiptDir: dir, head: RECEIPT_HEAD, tree: RECEIPT_TREE, worktreeDigest: RECEIPT_WORKTREE };
}

function receiptFor(suite, overrides = {}) {
  const passed = suite.expectedExecutionCount;
  const receipt = {
    schemaVersion: 1,
    suitePath: suite.path,
    suiteId: suite.id,
    classification: suite.classification,
    expectedExecutionCount: suite.expectedExecutionCount,
    head: RECEIPT_HEAD,
    tree: RECEIPT_TREE,
    worktreeDigest: RECEIPT_WORKTREE,
    command: runner.commandFor(suite.path),
    argv: runner.argvFor(suite.path),
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    startedAt: '2026-09-23T00:00:00.000Z',
    endedAt: '2026-09-23T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    error: null,
    counts: { tests: passed, passed, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    achievedNonSkipped: passed,
    tapSha256: RECEIPT_TAP,
    ok: true,
  };
  return { ...receipt, ...overrides };
}

function writeReceipt(dir, receipt, fileName = runner.receiptFileName(receipt.suitePath)) {
  fs.writeFileSync(path.join(dir, fileName), `${JSON.stringify(receipt, null, 2)}\n`);
}

function withReceipt(suite, overrides, receiptOverrides = {}) {
  const dir = overrides.dir;
  resetReceiptDir(dir);
  writeReceipt(dir, receiptFor(suite, receiptOverrides));
  return { ...overrides.docs, ...receiptOptions(dir) };
}

test('RED: registration alone passes v1 but v2 requires a receipt per characterization suite', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  // The pre-Task-18 contract is green with zero execution proof...
  assert.equal(v1.verifyInventory(docs).verdict, 'PASS');
  // ...and v2 fails closed on the missing receipt.
  assert.throws(
    () => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }),
    error => /test-inventory-v2/u.test(error.message) && /missing receipt: test\/characterization\/acquisition-extract\.test\.cjs/u.test(error.message),
  );
});

test('receipt-backed accounting passes with one valid HEAD-bound receipt per characterization suite', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture([CHARACTERIZATION, CHARACTERIZATION_TWO]);
  writeReceipt(dir, receiptFor(CHARACTERIZATION));
  writeReceipt(dir, receiptFor(CHARACTERIZATION_TWO));
  const result = v2.verifyInventory({ ...docs, ...receiptOptions(dir) });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.receiptBackedSuites, 2);
});

test('a missing receipt for one of several characterization suites fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture([CHARACTERIZATION, CHARACTERIZATION_TWO]);
  writeReceipt(dir, receiptFor(CHARACTERIZATION));
  assert.throws(
    () => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }),
    /missing receipt: test\/characterization\/transport-retry\.test\.cjs/u,
  );
});

test('an unreadable (corrupt JSON) receipt fails closed', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  fs.writeFileSync(path.join(dir, runner.receiptFileName(CHARACTERIZATION.path)), '{ truncated');
  assert.throws(() => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }), /unreadable receipt/u);
});

test('a partially written receipt fails closed', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const partial = receiptFor(CHARACTERIZATION);
  delete partial.counts;
  delete partial.achievedNonSkipped;
  writeReceipt(dir, partial);
  assert.throws(
    () => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }),
    error => /partial receipt/u.test(error.message) && /counts/u.test(error.message) && /achievedNonSkipped/u.test(error.message),
  );
});

test('an achieved count below the manifest expectation fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const lowered = receiptFor(CHARACTERIZATION, {
    counts: { tests: 7, passed: 7, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    achievedNonSkipped: 7,
    ok: false,
  });
  writeReceipt(dir, lowered);
  assert.throws(
    () => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }),
    /count below expectation for test\/characterization\/acquisition-extract\.test\.cjs: achieved 7 < declared 8/u,
  );
});

test('a skipped-only receipt cannot contribute to PASS', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const skippedOnly = receiptFor(CHARACTERIZATION, {
    counts: { tests: 8, passed: 0, failed: 0, skipped: 8, todo: 0, cancelled: 0 },
    achievedNonSkipped: 0,
    ok: false,
  });
  writeReceipt(dir, skippedOnly);
  assert.throws(() => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }), /skipped-only suite/u);
});

test('duplicate receipts for the same suite path fail', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  writeReceipt(dir, receiptFor(CHARACTERIZATION));
  writeReceipt(dir, receiptFor(CHARACTERIZATION), `${'0'.repeat(64)}.json`);
  assert.throws(() => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }), /duplicate receipt for test\/characterization\/acquisition-extract\.test\.cjs/u);
});

test('stale HEAD, tree, or worktree bindings fail', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  assert.throws(verify({ head: '9'.repeat(40) }), /stale head binding/u);
  assert.throws(verify({ tree: '9'.repeat(40) }), /stale tree binding/u);
  assert.throws(verify({ worktreeDigest: '9'.repeat(64) }), /stale worktree binding/u);
});

// FINDING 8 (Qodo, High): the worktree binding used to hash only the
// `git status --porcelain` text, so once a file was dirty, changing its bytes
// (path/status text unchanged) left the binding identical and the verifier
// accepted receipts produced before those bytes existed. The binding now hashes
// the per-file bytes of every dirty/untracked path.
function tempGitRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-dirty-binding-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'core.autocrlf', 'false');
  return { repo, git };
}

test('mutating the bytes of an already-dirty file invalidates its receipt binding', (t) => {
  const { repo, git } = tempGitRepo(t);
  const tracked = path.join(repo, 'tracked.txt');
  fs.writeFileSync(tracked, 'committed bytes\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'fixture');

  // Dirty the file once: the porcelain path/status text is now fixed at `.M`.
  fs.writeFileSync(tracked, 'dirty revision one\n');
  const before = runner.currentBinding(repo);
  // Change ONLY the bytes; path and status text stay byte-identical.
  fs.writeFileSync(tracked, 'dirty revision two\n');
  const after = runner.currentBinding(repo);
  assert.equal(after.head, before.head);
  assert.equal(after.tree, before.tree);
  assert.notEqual(after.worktreeDigest, before.worktreeDigest);

  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  writeReceipt(dir, receiptFor(CHARACTERIZATION, before));
  // The receipt was produced before the second mutation: the verifier rejects it.
  assert.throws(
    () => v2.verifyInventory({ ...docs, receiptDir: dir, head: after.head, tree: after.tree, worktreeDigest: after.worktreeDigest }),
    /stale worktree binding/u,
  );
  // Control: while the dirty bytes are unchanged, the same receipt verifies.
  assert.equal(
    v2.verifyInventory({ ...docs, receiptDir: dir, head: before.head, tree: before.tree, worktreeDigest: before.worktreeDigest }).verdict,
    'PASS',
  );
});

test('the worktree digest tracks untracked bytes and ignores ignored paths', (t) => {
  const { repo, git } = tempGitRepo(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed bytes\n');
  git('add', '.gitignore', 'tracked.txt');
  git('commit', '-qm', 'fixture');
  const clean = runner.currentBinding(repo).worktreeDigest;

  // Receipts live under ignored paths: writing one must not move the binding.
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored', 'receipt.json'), 'ignored bytes one\n');
  assert.equal(runner.currentBinding(repo).worktreeDigest, clean);

  const untracked = path.join(repo, 'untracked.txt');
  fs.writeFileSync(untracked, 'untracked bytes one\n');
  const withUntracked = runner.currentBinding(repo).worktreeDigest;
  assert.notEqual(withUntracked, clean);
  fs.writeFileSync(untracked, 'untracked bytes two\n');
  assert.notEqual(runner.currentBinding(repo).worktreeDigest, withUntracked);
});

test('a direct node --test or glob command is not the canonical receipt command', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  assert.throws(verify({ command: `node --test ${CHARACTERIZATION.path}` }), /command mismatch/u);
  assert.throws(verify({ command: 'node --test test/characterization/*.test.cjs' }), /command mismatch/u);
});

test('nonzero exit, timeout, or a killed suite fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  assert.throws(verify({ exitCode: 1, ok: false }), /nonzero exit/u);
  assert.throws(verify({ exitCode: null, timedOut: true, signal: 'SIGKILL', ok: false }), /timed out suite/u);
  assert.throws(verify({ exitCode: null, signal: 'SIGTERM', ok: false }), /killed suite/u);
});

test('a receipt for a path the manifest does not own fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const ghost = { ...CHARACTERIZATION, id: 'suite:test/characterization/ghost.test.cjs', path: 'test/characterization/ghost.test.cjs' };
  writeReceipt(dir, receiptFor(ghost));
  assert.throws(
    () => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }),
    error => /unowned path receipt/u.test(error.message) && /missing receipt: test\/characterization\/acquisition-extract/u.test(error.message),
  );
});

test('a receipt filename that is not sha256(path) fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  writeReceipt(dir, receiptFor(CHARACTERIZATION), 'acquisition-extract.json');
  assert.throws(() => v2.verifyInventory({ ...docs, ...receiptOptions(dir) }), /receipt path mismatch/u);
});

test('a receipt that rewrites the manifest expectation or contradicts its counts fails', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  assert.throws(verify({ expectedExecutionCount: 1 }), /expectation mismatch/u);
  assert.throws(verify({ achievedNonSkipped: 99 }), /inconsistent receipt/u);
});

// FINDING 6 (Qodo, High): `validateReceiptShape` checked each TAP counter
// independently and `compareReceipt` only compared `achievedNonSkipped` to
// `passed + failed`, so a receipt declaring `counts.tests = 1` with 8 `passed`
// satisfied the manifest floor as execution proof. The TAP terminal outcomes
// must reconcile with the declared total before any manifest comparison.
test('forged counters that do not reconcile with the declared total are rejected before manifest comparison', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  // `passed` exceeds the declared total: the manifest floor (8) is met while
  // counts.tests claims a single execution.
  assert.throws(
    verify({ counts: { tests: 1, passed: 8, failed: 0, skipped: 0, todo: 0, cancelled: 0 } }),
    error => /inconsistent receipt/u.test(error.message) && /counts\.tests 1 != passed\+failed\+cancelled\+skipped\+todo 8/u.test(error.message),
  );
  // The declared total overstates the outcome sum: one execution is unaccounted for.
  assert.throws(
    verify({ counts: { tests: 9, passed: 8, failed: 0, skipped: 0, todo: 0, cancelled: 0 } }),
    error => /inconsistent receipt/u.test(error.message) && /counts\.tests 9 != passed\+failed\+cancelled\+skipped\+todo 8/u.test(error.message),
  );
  // Cancelled/skipped outcomes count toward the declared total too.
  assert.throws(
    verify({ counts: { tests: 8, passed: 8, failed: 0, skipped: 1, todo: 0, cancelled: 0 } }),
    error => /inconsistent receipt/u.test(error.message) && /counts\.tests 8 != passed\+failed\+cancelled\+skipped\+todo 9/u.test(error.message),
  );
});

test('a receipt whose achievedNonSkipped disagrees with passed+failed is rejected with a typed reason', (t) => {
  const dir = tempReceiptDir(t);
  const docs = characterizationFixture();
  const verify = receiptOverrides => () => v2.verifyInventory(withReceipt(CHARACTERIZATION, { dir, docs }, receiptOverrides));
  assert.throws(
    verify({ achievedNonSkipped: 7 }),
    error => /inconsistent receipt/u.test(error.message) && /achievedNonSkipped 7 != passed\+failed 8/u.test(error.message),
  );
  // Control: reconciled skipped accounting still passes while enough
  // non-skipped tests executed.
  const withSkip = withReceipt(CHARACTERIZATION, { dir, docs }, {
    counts: { tests: 9, passed: 8, failed: 0, skipped: 1, todo: 0, cancelled: 0 },
    achievedNonSkipped: 8,
  });
  assert.equal(v2.verifyInventory(withSkip).verdict, 'PASS');
});

test('the CLI refuses to validate inventory without an explicit receipt directory', () => {
  const result = spawnSync(process.execPath, [
    'test/tools/test-inventory-v2.cjs',
    '--baseline', 'test/fixtures/contracts/test-suite-baseline.json',
    '--manifest', 'test/fixtures/contracts/test-suite-manifest.json',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--receipt-dir is required/u);
});

test('the CLI fails closed on an empty or corrupt receipt directory', (t) => {
  const dir = tempReceiptDir(t);
  const args = [
    'test/tools/test-inventory-v2.cjs',
    '--baseline', 'test/fixtures/contracts/test-suite-baseline.json',
    '--manifest', 'test/fixtures/contracts/test-suite-manifest.json',
    '--receipt-dir', dir,
  ];
  const empty = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /missing receipt: test\/characterization\//u);

  fs.writeFileSync(path.join(dir, `${'a'.repeat(64)}.json`), 'not json');
  const corrupt = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /unreadable receipt/u);
});
