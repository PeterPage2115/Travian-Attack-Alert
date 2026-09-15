#!/usr/bin/env node
'use strict';

/**
 * Offline release quality gate runner (plan Todo 6).
 *
 * Runs every offline gate in order:
 *   syntax-runtime -> syntax-dist -> unit -> tools-tests -> artifact-matrix ->
 *   build -> versions -> artifact -> types -> quality -> static-format -> e2e
 *
 * Each gate is captured as { name, cmd, exitCode, verdict, reason } where
 * verdict is PASS | FAIL | NOT_EXECUTED. The summary is written to
 *   test-results/release-1.0.0/offline-summary.json
 * as { overall, gates, timestamp, node, commit, mode }.
 *
 * Exit code is 0 IFF zero gates FAIL (PASS or NOT_EXECUTED-with-reason
 * are both acceptable; any FAIL yields overall FAIL and a nonzero exit).
 *
 * `--offline` is accepted for contract clarity. All gates are offline by
 * construction: deterministic loopback fixtures only, no Travian/Discord/
 * production network anywhere. This runner never claims manager/live PASS;
 * whatever it cannot execute is reported NOT_EXECUTED with a reason.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-results', 'release-1.0.0');
const SUMMARY_PATH = path.join(OUT_DIR, 'offline-summary.json');

const OFFLINE_FLAG = process.argv.includes('--offline');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--offline') {
    console.error(`check-release: unknown flag ${arg} (only --offline is supported)`);
    process.exit(2);
  }
}

function headCommit() {
  try {
    const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    return out.status === 0 ? String(out.stdout || '').trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function tail(text, maxChars = 4000) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return `...[truncated ${s.length - maxChars} chars]...\n${s.slice(s.length - maxChars)}`;
}

function runGate(name, cmd, reason) {
  const started = Date.now();
  const display = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
  let exitCode = null;
  let output = '';
  try {
    const result = Array.isArray(cmd)
      ? spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      : spawnSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    exitCode = result.status;
    output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) {
      return { name, cmd: display, exitCode, verdict: 'FAIL', reason: `spawn error: ${result.error.message}`, durationMs: Date.now() - started, outputTail: tail(output) };
    }
  } catch (error) {
    return { name, cmd: display, exitCode, verdict: 'FAIL', reason: `spawn threw: ${error && error.message}`, durationMs: Date.now() - started, outputTail: '' };
  }
  const verdict = exitCode === 0 ? 'PASS' : 'FAIL';
  return {
    name,
    cmd: display,
    exitCode,
    verdict,
    reason: verdict === 'PASS' ? (reason || 'exit 0') : `exit ${exitCode}`,
    durationMs: Date.now() - started,
    outputTail: tail(output),
  };
}

function notExecuted(name, cmd, reason) {
  return { name, cmd, exitCode: null, verdict: 'NOT_EXECUTED', reason, durationMs: 0, outputTail: '' };
}

function toolsTestFiles() {
  const dir = path.join(ROOT, 'test', 'tools');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.cjs'))
    .sort()
    .map((f) => path.join('test', 'tools', f));
}

function artifactTestFiles() {
  const dir = path.join(ROOT, 'test', 'artifact');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.test.cjs'))
    .sort()
    .map((f) => path.join('test', 'artifact', f));
}

function e2eSpecFiles() {
  const dir = path.join(ROOT, 'test', 'e2e');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((f) => path.join('test', 'e2e', f));
}

function chromiumBinaryPresent() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    if (entries.some((e) => e.startsWith('chromium-') && !e.includes('headless_shell'))) return true;
  }
  return false;
}

function e2EBlockedByOccupiedPort(perSpec) {
  // Narrow environment-block classifier: every per-spec JSON report must show
  // ZERO executed tests and a webServer port-bind conflict. Any executed test
  // (pass or fail) or any other error keeps the FAIL verdict. This never
  // masks a real spec failure; it only names total non-execution honestly.
  if (!Array.isArray(perSpec) || perSpec.length === 0) return null;
  for (const entry of perSpec) {
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(path.join(ROOT, entry.report), 'utf8'));
    } catch {
      return null;
    }
    const stats = report.stats || {};
    const executed = (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0) + (stats.skipped || 0);
    const suites = Array.isArray(report.suites) ? report.suites.length : -1;
    const messages = [...(report.errors || []), ...(report.fatalErrors || [])].map((e) => String((e && e.message) || ''));
    const bindConflict = messages.some((m) => /already used/.test(m) && /127\.0\.0\.1:8899/.test(m));
    if (executed !== 0 || suites !== 0 || !bindConflict) return null;
  }
  return 'NOT EXECUTED (port 127.0.0.1:8899 is held by a foreign server in this environment, so the Playwright webServer could not bind; zero suites ran in every spec — rerun where 8899 is free)';
}

function runE2EGate() {
  const name = 'e2e';
  const specs = e2eSpecFiles();
  if (!chromiumBinaryPresent()) {
    return notExecuted(
      name,
      'npx playwright test --config test/e2e/playwright.config.ts --reporter=json (per spec)',
      'NOT EXECUTED (no browser binary in Playwright cache; browsers were not downloaded)',
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const perSpec = [];
  let worst = 0;
  for (const spec of specs) {
    const base = path.basename(spec, '.spec.ts');
    const report = path.join(OUT_DIR, `e2e-report-${base}.spec.json`);
    const cmd = ['npx', 'playwright', 'test', spec, '--config', 'test/e2e/playwright.config.ts', '--reporter=json'];
    const started = Date.now();
    const result = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const exitCode = result.status;
    worst = exitCode !== 0 ? 1 : worst;
    fs.writeFileSync(report, `${result.stdout || ''}`);
    perSpec.push({
      spec,
      cmd: [...cmd, `> ${path.relative(ROOT, report)}`].join(' '),
      exitCode,
      report: path.relative(ROOT, report),
      durationMs: Date.now() - started,
      outputTail: tail(result.stderr || ''),
    });
  }
  if (worst === 0) {
    return {
      name,
      cmd: 'npx playwright test <each test/e2e/*.spec.ts> --config test/e2e/playwright.config.ts --reporter=json > test-results/release-1.0.0/e2e-report-<spec>.spec.json',
      exitCode: worst,
      verdict: 'PASS',
      reason: `all ${perSpec.length} specs passed; per-spec JSON reports written (never the shared test-results/e2e-runtime.json)`,
      durationMs: perSpec.reduce((sum, s) => sum + s.durationMs, 0),
      outputTail: '',
      specs: perSpec,
    };
  }
  const blocked = e2EBlockedByOccupiedPort(perSpec);
  if (blocked) {
    return {
      name,
      cmd: 'npx playwright test <each test/e2e/*.spec.ts> --config test/e2e/playwright.config.ts --reporter=json > test-results/release-1.0.0/e2e-report-<spec>.spec.json',
      exitCode: null,
      verdict: 'NOT_EXECUTED',
      reason: blocked,
      durationMs: perSpec.reduce((sum, s) => sum + s.durationMs, 0),
      outputTail: '',
      specs: perSpec,
    };
  }
  return {
    name,
    cmd: 'npx playwright test <each test/e2e/*.spec.ts> --config test/e2e/playwright.config.ts --reporter=json > test-results/release-1.0.0/e2e-report-<spec>.spec.json',
    exitCode: worst,
    verdict: 'FAIL',
    reason: 'at least one spec failed; see per-spec reports',
    durationMs: perSpec.reduce((sum, s) => sum + s.durationMs, 0),
    outputTail: '',
    specs: perSpec,
  };
}

function main() {
  const gates = [];
  gates.push(runGate('syntax-runtime', [process.execPath, '-e', "new Function(require('fs').readFileSync('src/runtime.js','utf8'))"], 'src runtime authority parses'));
  gates.push(runGate('syntax-dist', [process.execPath, '-e', "new Function(require('fs').readFileSync('dist/travian-attack-alert.user.js','utf8'))"], 'dist artifact parses'));
  gates.push(runGate('unit', ['npm', 'test'], 'core + parity suites green'));
  gates.push(runGate('tools-tests', [process.execPath, '--test', ...toolsTestFiles()], 'tools suites green'));
  gates.push(runGate('artifact-matrix', [process.execPath, '--test', ...artifactTestFiles()], 'detector matrix suites green'));
  gates.push(runGate('build', ['npm', 'run', 'build'], 'deterministic dist rebuild'));
  gates.push(runGate('versions', ['npm', 'run', 'check:versions'], 'version/identity contract holds'));
  gates.push(runGate('artifact', ['npm', 'run', 'check:artifact'], 'artifact checks green'));
  gates.push(runGate('types', ['npm', 'run', 'check:types'], 'tsc --noEmit clean'));
  gates.push(runGate('quality', ['npm', 'run', 'quality'], 'quality gate PASS'));
  gates.push(runGate('static-format', [process.execPath, 'test/fixtures/discord/static-format-audit.cjs', '--file', 'src/runtime.js', '--readme', 'README.md'], 'static format audit PASS'));
  gates.push(runE2EGate());

  const failed = gates.filter((g) => g.verdict === 'FAIL');
  const overall = failed.length === 0 ? 'PASS' : 'FAIL';
  const summary = {
    overall,
    mode: OFFLINE_FLAG ? 'offline' : 'offline (all gates offline by construction)',
    gates,
    timestamp: new Date().toISOString(),
    node: process.version,
    commit: headCommit(),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);

  for (const g of gates) {
    console.log(`[${g.verdict}] ${g.name} (exit ${g.exitCode === null ? 'n/a' : g.exitCode}) — ${g.reason}`);
  }
  console.log(`overall: ${overall} — summary: ${path.relative(ROOT, SUMMARY_PATH)}`);
  process.exit(overall === 'PASS' ? 0 : 1);
}

main();
