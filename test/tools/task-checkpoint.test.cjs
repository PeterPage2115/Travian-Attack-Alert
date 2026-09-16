'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonical, sha256 } = require('./plan-evidence-audit.cjs');
const { verifyCheckpoint } = require('./task-checkpoint.cjs');

function receipt(task, preTree, postTree) {
  const value = { schemaVersion: 1, task, attemptId: 'attempt', planIdentitySha256: 'a'.repeat(64), behaviorOracleSha256: 'b'.repeat(64), preTree, postTree, commandsSha256: 'c'.repeat(64), reportsSha256: 'd'.repeat(64), commandCount: 1, reportCount: 1, verdict: 'PASS' };
  value.receiptSha256 = sha256(canonical(value)); return value;
}

test('continuous ordered receipt chain passes', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40), c = '3'.repeat(40);
  assert.deepEqual(verifyCheckpoint([receipt(1, a, b), receipt(2, b, c)], a), { verdict: 'PASS', tasks: 2, postTree: c });
});

test('tree discontinuity fails closed', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40), c = '3'.repeat(40);
  assert.throws(() => verifyCheckpoint([receipt(1, a, b), receipt(2, c, a)], a), /discontinuity/u);
});

test('unordered and empty checkpoints fail closed', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40);
  assert.throws(() => verifyCheckpoint([], a), /no receipts/u);
  assert.throws(() => verifyCheckpoint([receipt(2, a, b), receipt(1, b, a)], a), /increasing/u);
});
