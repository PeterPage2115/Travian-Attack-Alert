#!/usr/bin/env node
'use strict';

/**
 * Gate-mutation proof for the release orchestration (plan Todo 3).
 *
 * Runs three isolated temp-root mutations and requires every one to be
 * REJECTED (the gate under test must exit nonzero with an honest reason):
 *
 *   missing-browser       — e2e runner with an empty Playwright browser cache
 *                           must fail (never NOT_EXECUTED-pass) in release mode.
 *   stale-dist            — temp root whose src/ changed after the last build
 *                           must fail the read-only artifact check.
 *   artifact-before-build — temp root with dist/ removed must fail the
 *                           artifact check, AND tools/check-release.cjs must
 *                           order `build` before every artifact consumer.
 *
 * Usage:
 *   node test/fixtures/tools/run-gate-mutations.cjs \
 *     --cases missing-browser,stale-dist,artifact-before-build \
 *     --json <attemptDir>/task-3-mutations.json
 *
 * Exit code is 0 IFF every selected case is rejected. The JSON report is
 * written to --json (or stdout when --json is omitted).
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const CASES = ['missing-browser', 'stale-dist', 'artifact-before-build'];

function fail(message) {
  process.stderr.write(`run-gate-mutations: ${message}\n`);
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

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function copyTreeToTemp(tag) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `taa-gate-${tag}-`));
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

function checkMissingBrowser() {
  // Isolate BOTH probe roots: PLAYWRIGHT_BROWSERS_PATH and the home-dir
  // Playwright cache (os.homedir() honors HOME on POSIX).
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-no-home-'));
  const emptyBrowsers = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-no-browsers-'));
  const result = run(process.execPath, ['tools/run-e2e.cjs', '--release'], {
    env: { ...process.env, HOME: emptyHome, PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers },
    timeout: 120_000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const honest = /NOT.?EXECUTED|browser required|no browser binary/i.test(output);
  if (result.status !== 0 && honest) {
    return { rejected: true, reason: `run-e2e --release exited ${result.status} with honest skip-as-failure` };
  }
  return { rejected: false, reason: `expected nonzero honest failure, got exit ${result.status}: ${output.slice(-500)}` };
}

function checkStaleDist() {
  const temp = copyTreeToTemp('stale-dist');
  try {
  // Append live code (not a comment — esbuild strips comments, so a comment
  // would be a byte-level no-op and prove nothing).
  fs.appendFileSync(
    path.join(temp, 'src', 'runtime.js'),
    '\n;globalThis.__taaGateMutationStaleDist = 1;\n',
  );
    const result = spawnSync(process.execPath, ['tools/check-artifact.cjs'], {
      cwd: temp,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 && /synchronized|artifact check failed/i.test(output)) {
      return { rejected: true, reason: `check-artifact exited ${result.status} on stale dist (${temp})` };
    }
    return { rejected: false, reason: `expected stale dist to fail check-artifact, got exit ${result.status}: ${output.slice(-500)}` };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function gateOrderInCheckRelease() {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'check-release.cjs'), 'utf8');
  const order = [];
  for (const match of source.matchAll(/gates\.push\(\s*(?:runGate\(\s*'([^']+)'|runE2EGate\(\))/g)) {
    order.push(match[1] || 'e2e');
  }
  return order;
}

function checkArtifactBeforeBuild() {
  const temp = copyTreeToTemp('artifact-before-build');
  try {
    fs.rmSync(path.join(temp, 'dist'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, ['tools/check-artifact.cjs'], {
      cwd: temp,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const rejected = result.status !== 0 && /missing|run npm run build|artifact check failed/i.test(output);
    const order = gateOrderInCheckRelease();
    const consumers = ['syntax-dist', 'artifact', 'artifact-matrix', 'versions', 'browser-tests', 'e2e'];
    const buildIndex = order.indexOf('build');
    const orderOk = buildIndex === 0 && consumers.every((name) => order.indexOf(name) > buildIndex);
    if (rejected && orderOk) {
      return { rejected: true, reason: `artifact gate fails without build output; check-release order [${order.join(' -> ')}]` };
    }
    const problems = [];
    if (!rejected) problems.push(`artifact gate passed without dist (exit ${result.status})`);
    if (!orderOk) problems.push(`build is not first in [${order.join(', ')}]`);
    return { rejected: false, reason: problems.join('; ') };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const { cases, json } = parseArgs(process.argv.slice(2));
  const results = [];
  for (const name of cases) {
    let outcome;
    if (name === 'missing-browser') outcome = checkMissingBrowser();
    else if (name === 'stale-dist') outcome = checkStaleDist();
    else outcome = checkArtifactBeforeBuild();
    results.push({ name, ...outcome });
    process.stdout.write(`${outcome.rejected ? 'REJECTED' : 'NOT-REJECTED'} ${name} — ${outcome.reason}\n`);
  }
  const overall = results.every((r) => r.rejected) ? 'PASS' : 'FAIL';
  const report = {
    schemaVersion: 1,
    tool: 'test/fixtures/tools/run-gate-mutations.cjs',
    overall,
    cases: results,
    timestamp: new Date().toISOString(),
    commit: (() => {
      const out = run('git', ['rev-parse', '--short', 'HEAD']);
      return out.status === 0 ? String(out.stdout || '').trim() : 'unknown';
    })(),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (json) {
    fs.mkdirSync(path.dirname(path.resolve(json)), { recursive: true });
    fs.writeFileSync(path.resolve(json), text);
  }
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  process.stdout.write(`overall: ${overall} — sha256: ${digest}\n`);
  process.exit(overall === 'PASS' ? 0 : 1);
}

main();
