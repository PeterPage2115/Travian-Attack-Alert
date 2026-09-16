'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { discoverSuites, verifyInventory } = require('./test-inventory.cjs');

function suite(id, file, count = 1) {
  return { id, path: file, classification: 'tool', expectedExecutionCount: count, coverage: [`behavior:${id}`] };
}

function documents() {
  const suites = [suite('runtime-parity', 'test/runtime-parity.test.cjs', 2), suite('tool-a', 'test/tools/a.test.cjs')];
  return {
    baseline: { schemaVersion: 1, suites },
    manifest: { schemaVersion: 1, suites: structuredClone(suites), relocations: [] },
    discovered: suites.map(item => item.path),
  };
}

test('repository discovery reports every supported suite exactly once', () => {
  const files = discoverSuites();
  assert.equal(files.length, new Set(files).size);
  assert.ok(files.includes('test/runtime-parity.test.cjs'));
  assert.ok(files.includes('test/e2e/route-lease.spec.ts'));
});

test('matching baseline and manifest pass with deterministic counts', () => {
  assert.deepEqual(verifyInventory(documents()), { verdict: 'PASS', suites: 2, expectedExecutions: 3 });
});

test('missing and duplicate suites fail closed', () => {
  const missing = documents();
  missing.manifest.suites.pop();
  assert.throws(() => verifyInventory(missing), /not reported|reports/u);
  const duplicate = documents();
  duplicate.manifest.suites.push(structuredClone(duplicate.manifest.suites[0]));
  assert.throws(() => verifyInventory(duplicate), /duplicate/u);
});

test('coverage cannot decrease and moves require explicit relocation', () => {
  const reduced = documents();
  reduced.manifest.suites[0].expectedExecutionCount = 1;
  assert.throws(() => verifyInventory(reduced), /coverage reduction/u);
  const moved = documents();
  moved.manifest.suites[1].path = 'test/tools/b.test.cjs';
  moved.discovered[1] = 'test/tools/b.test.cjs';
  assert.throws(() => verifyInventory(moved), /missing relocation/u);
  moved.manifest.relocations.push({ baselineId: 'tool-a', from: 'test/tools/a.test.cjs', to: 'test/tools/b.test.cjs' });
  assert.equal(verifyInventory(moved).verdict, 'PASS');
});

test('oracle and verifier hashes are immutable when supplied', () => {
  const docs = documents();
  docs.manifest.behaviorOracleSha256 = 'oracle';
  docs.manifest.verifierHashes = { audit: 'digest' };
  assert.equal(verifyInventory({ ...docs, oracleSha256: 'oracle', verifierHashes: { audit: 'digest' } }).verdict, 'PASS');
  assert.throws(() => verifyInventory({ ...docs, oracleSha256: 'changed' }), /oracle/u);
  assert.throws(() => verifyInventory({ ...docs, verifierHashes: { audit: 'changed' } }), /verifier/u);
});
