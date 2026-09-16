'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function readJsonNoFollow(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}

function assertHex(value, label) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function verifyPlanIdentity(identity, expected = {}) {
  if (!identity || identity.schemaVersion !== 1) throw new Error('unsupported plan identity schema');
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/u.test(identity.attemptId)) throw new Error('invalid attempt id');
  if (!path.isAbsolute(identity.canonicalRoot) || path.resolve(identity.canonicalRoot) !== identity.canonicalRoot) throw new Error('canonical root is not absolute and normalized');
  if (!/^[0-9a-f]{40}$/u.test(identity.cleanStartingHead)) throw new Error('invalid clean starting HEAD');
  assertHex(identity.plan?.sha256, 'plan digest');
  if (!Number.isInteger(identity.plan?.byteCount) || identity.plan.byteCount < 1) throw new Error('invalid plan byte count');
  if (!identity.plan.openFlags?.includes('O_NOFOLLOW')) throw new Error('plan identity is not O_NOFOLLOW-bound');
  for (const [key, value] of Object.entries(expected)) if (identity[key] !== value) throw new Error(`plan identity mismatch: ${key}`);
  return true;
}

function verifyCommands(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.commands) || document.commands.length < 1) throw new Error('commands are missing');
  const ids = new Set();
  for (const entry of document.commands) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) throw new Error('command ids must be unique');
    ids.add(entry.id);
    if (typeof entry.command !== 'string' || !entry.command) throw new Error(`command text missing: ${entry.id}`);
    if (!Number.isInteger(entry.exitCode)) throw new Error(`command exit missing: ${entry.id}`);
    if (!Number.isInteger(entry.count) || entry.count < 0) throw new Error(`command count missing: ${entry.id}`);
    if (!['PASS', 'EXPECTED_FAIL'].includes(entry.outcome) || entry.outcome === 'PASS' && entry.exitCode !== 0 || entry.outcome === 'EXPECTED_FAIL' && entry.exitCode === 0) throw new Error(`misleading command outcome: ${entry.id}`);
    if (!Number.isInteger(entry.retryCount) || entry.retryCount < 0) throw new Error(`retry count missing: ${entry.id}`);
  }
  return document.commands.length;
}

function resolveInside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error(`unsafe report path: ${relative}`);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`report path escapes attempt: ${relative}`);
  return absolute;
}

function verifyReports(document, attemptRoot) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.reports) || document.reports.length < 1) throw new Error('reports are missing');
  const sorted = document.reports.map(item => item.path).slice().sort();
  if (JSON.stringify(sorted) !== JSON.stringify(document.reports.map(item => item.path))) throw new Error('reports are not sorted');
  const seen = new Set();
  for (const report of document.reports) {
    if (seen.has(report.path)) throw new Error(`duplicate report: ${report.path}`);
    seen.add(report.path);
    assertHex(report.sha256, `report digest ${report.path}`);
    const absolute = resolveInside(attemptRoot, report.path);
    if (!fs.statSync(absolute).isFile() || sha256File(absolute) !== report.sha256) throw new Error(`report hash mismatch: ${report.path}`);
  }
  return document.reports.length;
}

if (require.main === module) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 === 0 ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
    const identity = readJsonNoFollow(path.resolve(args['plan-identity']));
    verifyPlanIdentity(identity);
    const result = { verdict: 'PASS', attemptId: identity.attemptId };
    if (args.commands) result.commands = verifyCommands(readJsonNoFollow(path.resolve(args.commands)));
    if (args.reports) result.reports = verifyReports(readJsonNoFollow(path.resolve(args.reports)), path.dirname(path.dirname(path.resolve(args.reports))));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { canonical, sha256, sha256File, readJsonNoFollow, verifyPlanIdentity, verifyCommands, verifyReports, resolveInside };
