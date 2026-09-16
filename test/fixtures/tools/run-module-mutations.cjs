#!/usr/bin/env node
'use strict';

// Module-architecture mutation proof (plan Todo 7).
//
// Runs isolated temp-root mutations and requires every one to be REJECTED
// (test/tools/module-architecture.test.cjs must exit nonzero with a
// case-specific reason):
//
//   remaining-selector  — selector naming a symbol absent from
//                         src/runtime.js must throw the contract violation.
//   duplicate-export    — selecting parseLease from a second domain must
//                         break the frozen duplicate-export allowlist.
//   duplicate-singleton — declaring tabLeaseActive outside src/lifecycle.js
//                         (and src/runtime.js legacy authority) must break
//                         singleton ownership.
//   cycle               — a mutual adapters<->storage require must break the
//                         acyclic allowed-dependency map.
//   dormant-entry       — an unwired src/taa-dormant-probe.js file must break
//                         the exact src inventory.
//   type-error          — invalid syntax in src/adapters.js must fail module
//                         load (no broken module ships).
//   illegal-global      — a live document reference in the pure module
//                         src/storage.js must fail the host-global rule.
//   direct-dist-edit    — a hand-edited dist bundle (probe first line) must
//                         fail the generated-output check.
//   runtime-dependency  — requiring src/runtime.js directly from a domain
//                         stub must break the allowed-dependency map.
//
// Usage:
//   node test/fixtures/tools/run-module-mutations.cjs \
//     --cases duplicate-export,duplicate-singleton,cycle \
//     --json <attemptDir>/task-7-mutations.json
//
// Exit code is 0 IFF every selected case is rejected. The JSON report is
// written to --json (or stdout when --json is omitted).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const CASES = [
  'remaining-selector',
  'duplicate-export',
  'duplicate-singleton',
  'cycle',
  'dormant-entry',
  'type-error',
  'illegal-global',
  'direct-dist-edit',
  'runtime-dependency',
];

function fail(message) {
  process.stderr.write(`run-module-mutations: ${message}\n`);
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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `taa-module-${tag}-`));
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

function runArchTest(temp) {
  return spawnSync(process.execPath, ['--test', 'test/tools/module-architecture.test.cjs'], {
    cwd: temp,
    encoding: 'utf8',
    env: { ...process.env, TAA_GRAPH_OUT: path.join(temp, 'task-7-graph-probe.json') },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
}

function rejectedBy(result, pattern) {
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return result.status !== 0 && pattern.test(output);
}

function withTemp(tag, mutate, pattern) {
  const temp = copyTreeToTemp(tag);
  try {
    mutate(temp);
    const result = runArchTest(temp);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (rejectedBy(result, pattern)) {
      return { rejected: true, reason: `architecture test exited ${result.status} matching ${pattern} (${temp})` };
    }
    return { rejected: false, reason: `expected rejection matching ${pattern}, got exit ${result.status}: ${output.slice(-600)}` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function mutateContractSymbol(temp, symbol) {
  const file = path.join(temp, 'src', 'runtime-api.js');
  const source = fs.readFileSync(file, 'utf8');
  const anchor = "'writeVerifiedJson', 'buildMappingKey',";
  if (!source.includes(anchor)) throw new Error('contract anchor is missing');
  fs.writeFileSync(file, source.replace(anchor, `'writeVerifiedJson', '${symbol}', 'buildMappingKey',`));
}

const CHECKS = {
  'remaining-selector': () => withTemp(
    'remaining-selector',
    (temp) => mutateContractSymbol(temp, '__taaMissingSelector'),
    /contract violation|__taaMissingSelector|Cannot find|missing from/,
  ),
  'duplicate-export': () => withTemp(
    'duplicate-export',
    (temp) => mutateContractSymbol(temp, 'parseLease'),
    /parseLease|duplicate/i,
  ),
  'duplicate-singleton': () => withTemp(
    'duplicate-singleton',
    (temp) => fs.appendFileSync(path.join(temp, 'src', 'storage.js'), '\nlet tabLeaseActive = false;\n'),
    /tabLeaseActive|retain a copy|ownership/i,
  ),
  cycle: () => withTemp(
    'cycle',
    (temp) => {
      fs.appendFileSync(path.join(temp, 'src', 'adapters.js'), "\nrequire('./storage.js');\n");
      fs.appendFileSync(path.join(temp, 'src', 'storage.js'), "\nrequire('./adapters.js');\n");
    },
    /cycle|unlisted dependency/i,
  ),
  'dormant-entry': () => withTemp(
    'dormant-entry',
    (temp) => fs.writeFileSync(path.join(temp, 'src', 'taa-dormant-probe.js'), "'use strict';\n\nmodule.exports = {};\n"),
    /taa-dormant-probe|inventory|dormant/i,
  ),
  'type-error': () => withTemp(
    'type-error',
    (temp) => fs.appendFileSync(path.join(temp, 'src', 'adapters.js'), '\nthis is not valid javascript {{{\n'),
    /SyntaxError|error/i,
  ),
  'illegal-global': () => withTemp(
    'illegal-global',
    (temp) => fs.appendFileSync(path.join(temp, 'src', 'storage.js'), '\n;globalThis.__taaArchProbe = document.title;\n'),
    /document|browser global|ReferenceError/i,
  ),
  'direct-dist-edit': () => withTemp(
    'direct-dist-edit',
    (temp) => {
      const file = path.join(temp, 'dist', 'travian-attack-alert.user.js');
      const body = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, `;// __taaModuleProbe direct-dist-edit\n${body}`);
    },
    /generated|metadata block|hand-edit|probe/i,
  ),
  'runtime-dependency': () => withTemp(
    'runtime-dependency',
    (temp) => fs.appendFileSync(path.join(temp, 'src', 'storage.js'), "\n;void require('./runtime.js');\n"),
    /unlisted dependency|runtime\.js/i,
  ),
};

function main() {
  const { cases, json } = parseArgs(process.argv.slice(2));
  const results = {};
  let allRejected = true;
  for (const name of cases) {
    const outcome = CHECKS[name]();
    results[name] = outcome.rejected ? 'REJECTED' : 'NOT_REJECTED';
    results[`${name}:detail`] = outcome.reason;
    if (!outcome.rejected) allRejected = false;
    process.stderr.write(`run-module-mutations: ${name} -> ${results[name]} (${outcome.reason})\n`);
  }
  const report = { schemaVersion: 1, cases, results, verdict: allRejected ? 'PASS' : 'FAIL' };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (json) fs.writeFileSync(json, text);
  else process.stdout.write(text);
  process.exitCode = allRejected ? 0 : 1;
}

main();
