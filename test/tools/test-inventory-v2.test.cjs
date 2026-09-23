'use strict';

// v2 inventory contract: a relocation may move a suite's path but MUST NOT
// change its classification, coverage labels, or execution count. v1 accepted
// the 16-execution `delivery-matrix` suite being swapped for an unrelated
// 1-execution suite as long as a relocation record named the new path
// (docs/CODE-REVIEW.md item 7). v2 keeps v1's discovery/basic validation and
// fails closed on any weakening relocation.

const assert = require('node:assert/strict');
const test = require('node:test');

const v1 = require('./test-inventory.cjs');
const v2 = require('./test-inventory-v2.cjs');

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
