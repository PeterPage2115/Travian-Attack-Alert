'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sha256File } = require('./plan-evidence-audit.cjs');
const { buildReceipt, verifyReceipt } = require('./task-receipt.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-receipt-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'report.json'), '{}\n');
  return { task: 1, attemptId: '20260916T000000Z-abcdef12', behaviorOracleSha256: 'a'.repeat(64), preTree: 'b'.repeat(40), postTree: 'c'.repeat(40), attemptRoot: root, planIdentity: { schemaVersion: 1, attemptId: '20260916T000000Z-abcdef12', canonicalRoot: '/tmp/root', cleanStartingHead: 'd'.repeat(40), plan: { sha256: 'e'.repeat(64), byteCount: 1, openFlags: ['O_NOFOLLOW'] } }, commands: { schemaVersion: 1, commands: [{ id: 'one', command: 'true', exitCode: 0, count: 1, outcome: 'PASS', retryCount: 0 }] }, reports: { schemaVersion: 1, reports: [{ path: 'report.json', sha256: sha256File(path.join(root, 'report.json')) }] } };
}

test('receipt binds plan, commands, reports, oracle, and trees', t => {
  const receipt = buildReceipt(fixture(t));
  assert.equal(receipt.verdict, 'PASS'); assert.equal(verifyReceipt(receipt), true);
});

test('receipt digest rejects mutation', t => {
  const receipt = buildReceipt(fixture(t)); receipt.postTree = 'f'.repeat(40);
  assert.throws(() => verifyReceipt(receipt), /digest mismatch/u);
});

test('receipt rejects wrong attempt and missing command outcome', t => {
  const input = fixture(t); input.attemptId = '20260916T000001Z-abcdef12';
  assert.throws(() => buildReceipt(input), /attempt id/u);
  const second = fixture(t); second.commands.commands[0].outcome = 'NOT_EXECUTED';
  assert.throws(() => buildReceipt(second), /misleading/u);
});

test('receipt rejects zero reports and path escape', t => {
  const input = fixture(t); input.reports.reports = [];
  assert.throws(() => buildReceipt(input), /reports are missing/u);
  const second = fixture(t); second.reports.reports[0].path = '../report.json';
  assert.throws(() => buildReceipt(second), /escapes/u);
});
