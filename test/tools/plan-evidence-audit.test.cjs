'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const audit = require('./plan-evidence-audit.cjs');

function identity() {
  return { schemaVersion: 1, attemptId: '20260916T000000Z-abcdef12', canonicalRoot: '/tmp/root', cleanStartingHead: 'a'.repeat(40), plan: { sha256: 'b'.repeat(64), byteCount: 7, openFlags: ['O_RDONLY', 'O_NOFOLLOW'] } };
}

test('canonical JSON and SHA-256 are key-order independent', () => {
  assert.equal(audit.canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(audit.sha256(audit.canonical({ b: 1, a: 2 })), audit.sha256(audit.canonical({ a: 2, b: 1 })));
});

test('plan identity requires normalized root and O_NOFOLLOW evidence', () => {
  assert.equal(audit.verifyPlanIdentity(identity()), true);
  const bad = identity(); bad.plan.openFlags = ['O_RDONLY'];
  assert.throws(() => audit.verifyPlanIdentity(bad), /O_NOFOLLOW/u);
});

test('command records reject NOT_EXECUTED and misleading success', () => {
  const valid = { schemaVersion: 1, commands: [{ id: 'gate', command: 'node gate.cjs', exitCode: 0, count: 1, outcome: 'PASS', retryCount: 0 }] };
  assert.equal(audit.verifyCommands(valid), 1);
  valid.commands[0].outcome = 'NOT_EXECUTED';
  assert.throws(() => audit.verifyCommands(valid), /misleading/u);
});

test('report lists are sorted, unique, contained, and hash-bound', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-reports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.json'), '{}\n');
  const reports = { schemaVersion: 1, reports: [{ path: 'a.json', sha256: audit.sha256File(path.join(root, 'a.json')) }] };
  assert.equal(audit.verifyReports(reports, root), 1);
  reports.reports[0].path = '../escape.json';
  assert.throws(() => audit.verifyReports(reports, root), /escapes/u);
});

test('descriptor reads reject symlink inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-nofollow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'real.json'), '{}');
  fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'link.json'));
  assert.throws(() => audit.readJsonNoFollow(path.join(root, 'link.json')), /ELOOP/u);
});
