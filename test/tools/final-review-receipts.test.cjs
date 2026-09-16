'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonical, sha256 } = require('./plan-evidence-audit.cjs');
const { verifyFinalReview } = require('./final-review-receipts.cjs');

function receipt(task, preTree, postTree) {
  const value = { schemaVersion: 1, task, attemptId: 'attempt', planIdentitySha256: 'a'.repeat(64), behaviorOracleSha256: 'b'.repeat(64), preTree, postTree, commandsSha256: 'c'.repeat(64), reportsSha256: 'd'.repeat(64), commandCount: 1, reportCount: 1, verdict: 'PASS' };
  value.receiptSha256 = sha256(canonical(value)); return value;
}

test('final review verifies required continuous receipts', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40);
  assert.equal(verifyFinalReview({ receipts: [receipt(1, a, b)], preTree: a, requiredTasks: [1] }).verdict, 'PASS');
});

test('missing required task fails closed', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40);
  assert.throws(() => verifyFinalReview({ receipts: [receipt(1, a, b)], preTree: a, requiredTasks: [1, 2] }), /missing required/u);
});

test('tampered receipt fails before review', () => {
  const a = '1'.repeat(40), b = '2'.repeat(40), item = receipt(1, a, b); item.reportCount = 0;
  assert.throws(() => verifyFinalReview({ receipts: [item], preTree: a, requiredTasks: [1] }), /digest mismatch/u);
});
