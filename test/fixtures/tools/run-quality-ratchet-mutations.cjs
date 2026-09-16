#!/usr/bin/env node
'use strict';

/**
 * Quality-ratchet mutation proof (plan Todo 6).
 *
 * Runs three isolated temp-root mutations and requires every one to be
 * REJECTED (the gate under test must exit nonzero with an honest,
 * ratchet-specific reason):
 *
 *   new-type-error  — temp root with one extra type error in a new pure
 *                     module must fail tools/check-types-ratchet.cjs, and
 *                     the failure must name the probe file (zero-tolerance
 *                     for diagnostics outside the legacy baseline).
 *   monolith-growth — temp root with one extra runtime line in
 *                     src/runtime.js must fail tools/quality.cjs with a
 *                     monolith-budget reason (strictly decreasing LOC).
 *   illegal-global  — temp root using `document` in the pure module
 *                     src/text.js must fail tools/quality.cjs with a
 *                     browser-global reason scoped to src/text.js
 *                     (module-role rule: pure modules may not touch
 *                     browser entry globals).
 *
 * Usage:
 *   node test/fixtures/tools/run-quality-ratchet-mutations.cjs \
 *     --cases new-type-error,monolith-growth,illegal-global \
 *     --json <attemptDir>/task-6-mutations.json
 *
 * Exit code is 0 IFF every selected case is rejected. The JSON report is
 * written to --json (or stdout when --json is omitted).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const CASES = ['new-type-error', 'monolith-growth', 'illegal-global'];

function fail(message) {
  process.stderr.write(`run-quality-ratchet-mutations: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) fail(`invalid argument ${key}`);
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!args.cases) fail('--cases is required');
  const cases = String(args.cases).split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of cases) if (!CASES.includes(name)) fail(`unknown case ${name}`);
  return { cases, json: args.json || null };
}

function copyTreeToTemp(tag) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `taa-ratchet-${tag}-`));
  fs.cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const head = rel.split(path.sep)[0];
      return !['.git', 'node_modules', 'test-results', 'backups', '.omo', '.codegraph', '.dane'].includes(head);
    },
  });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'));
  return dest;
}

function runGate(temp, args) {
  return spawnSync(process.execPath, args, {
    cwd: temp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
}

function checkNewTypeError() {
  const temp = copyTreeToTemp('new-type-error');
  try {
    // Live type error, not a comment: JSDoc-typed const initialized with
    // the wrong primitive. checkJs must report TS2322 in this file.
    fs.writeFileSync(
      path.join(temp, 'src', 'taa-ratchet-probe.js'),
      `'use strict';\n\n/** @type {number} */\nconst probe = 'not-a-number';\n\nmodule.exports = { probe };\n`,
    );
    const result = runGate(temp, ['tools/check-types-ratchet.cjs']);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 && /taa-ratchet-probe/.test(output)) {
      return { rejected: true, reason: `check-types-ratchet exited ${result.status} naming the probe file (${temp})` };
    }
    return { rejected: false, reason: `expected types ratchet to reject the probe module, got exit ${result.status}: ${output.slice(-500)}` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function checkMonolithGrowth() {
  const temp = copyTreeToTemp('monolith-growth');
  try {
    // Live code (not a comment — esbuild/pure-line counters ignore
    // comments, so a comment would prove nothing).
    fs.appendFileSync(
      path.join(temp, 'src', 'runtime.js'),
      '\n;globalThis.__taaRatchetMonolithGrowth = 1;\n',
    );
    const result = runGate(temp, ['tools/quality.cjs']);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 && /monolith budget/i.test(output)) {
      return { rejected: true, reason: `quality exited ${result.status} on monolith growth (${temp})` };
    }
    return { rejected: false, reason: `expected monolith growth to fail the quality budget, got exit ${result.status}: ${output.slice(-500)}` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function checkIllegalGlobal() {
  const temp = copyTreeToTemp('illegal-global');
  try {
    // Live `document` reference in a pure/domain module. Entry adapters
    // may use it; src/text.js may not.
    fs.appendFileSync(
      path.join(temp, 'src', 'text.js'),
      '\n;globalThis.__taaRatchetIllegalGlobal = document.title;\n',
    );
    const result = runGate(temp, ['tools/quality.cjs']);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 && /src\/text\.js/.test(output) && /browser global/i.test(output)) {
      return { rejected: true, reason: `quality exited ${result.status} on illegal global in src/text.js (${temp})` };
    }
    return { rejected: false, reason: `expected illegal global to fail quality for src/text.js, got exit ${result.status}: ${output.slice(-500)}` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const { cases, json } = parseArgs(process.argv.slice(2));
  const checks = {
    'new-type-error': checkNewTypeError,
    'monolith-growth': checkMonolithGrowth,
    'illegal-global': checkIllegalGlobal,
  };
  const results = {};
  let allRejected = true;
  for (const name of cases) {
    const outcome = checks[name]();
    results[name] = outcome.rejected ? 'REJECTED' : 'NOT_REJECTED';
    results[`${name}:detail`] = outcome.reason;
    if (!outcome.rejected) allRejected = false;
    process.stderr.write(`run-quality-ratchet-mutations: ${name} -> ${results[name]} (${outcome.reason})\n`);
  }
  const report = { schemaVersion: 1, cases, results, verdict: allRejected ? 'PASS' : 'FAIL' };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (json) fs.writeFileSync(json, text);
  else process.stdout.write(text);
  process.exitCode = allRejected ? 0 : 1;
}

main();
