#!/usr/bin/env node
'use strict';

/**
 * Offline release quality gate runner (plan Todo 3).
 *
 * Gate order is load-bearing: `build` runs FIRST, then versions, artifact,
 * source, tool, and browser gates. Every artifact consumer (syntax-dist,
 * artifact check, artifact matrix, versions) runs only on freshly rebuilt
 * output, so a stale dist can never pass. There is no NOT_EXECUTED verdict:
 * any gate that cannot execute is a FAIL, because required skipped suites
 * must fail rather than pass silently.
 *
 * Order:
 *   build -> versions -> syntax-dist -> artifact -> artifact-matrix ->
 *   syntax-runtime -> source-offline -> characterization -> test-inventory ->
 *   static-format -> tools-tests -> types -> quality -> browser-tests -> e2e
 *
 * Each gate is captured as { name, cmd, exitCode, verdict, reason } where
 * verdict is PASS | FAIL. The summary is written to
 *   test-results/release-1.0.0/offline-summary.json
 * as { overall, gates, timestamp, node, commit, mode }.
 *
 * Exit code is 0 IFF every gate passes.
 *
 * `--offline` / `--release` are accepted for contract clarity. All gates are
 * offline by construction: deterministic loopback fixtures only, no
 * Travian/Discord/production network anywhere.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-results', 'release-1.0.0');
const SUMMARY_PATH = path.join(OUT_DIR, 'offline-summary.json');

for (const arg of process.argv.slice(2)) {
  if (arg !== '--offline' && arg !== '--release') {
    console.error(`check-release: unknown flag ${arg} (only --offline/--release are supported)`);
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

function runE2EGate() {
  const started = Date.now();
  const cmd = [process.execPath, 'tools/run-e2e.cjs', '--release'];
  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const executed = /executed=(\d+) across (\d+) specs/.exec(output);
  if (result.error) {
    return { name: 'e2e', cmd: cmd.join(' '), exitCode: result.status, verdict: 'FAIL', reason: `runner did not complete: ${result.error.message}`, durationMs: Date.now() - started, outputTail: tail(output) };
  }
  if (result.status === 0 && executed) {
    return { name: 'e2e', cmd: cmd.join(' '), exitCode: 0, verdict: 'PASS', reason: `all specs passed; executed=${executed[1]} across ${executed[2]} specs on the loopback QA config`, durationMs: Date.now() - started, outputTail: '' };
  }
  return { name: 'e2e', cmd: cmd.join(' '), exitCode: result.status, verdict: 'FAIL', reason: result.status === 0 ? 'runner passed without an explicit executed count' : `exit ${result.status}${executed ? ` executed=${executed[1]}` : ''}; a skipped or failing e2e suite fails the release`, durationMs: Date.now() - started, outputTail: tail(output) };
}

function main() {
  const gates = [];
  // Build FIRST: every gate below consumes freshly rebuilt output.
  gates.push(runGate('build', ['npm', 'run', 'build'], 'deterministic dist rebuild'));
  // Versions gate: identity contract over the rebuilt metadata/manifest/dist.
  gates.push(runGate('versions', ['npm', 'run', 'check:versions'], 'version/identity contract holds'));
  // Artifact gates: syntax, read-only check, and matrix over rebuilt output.
  gates.push(runGate('syntax-dist', [process.execPath, '-e', "new Function(require('fs').readFileSync('dist/travian-attack-alert.user.js','utf8'))"], 'dist artifact parses'));
  gates.push(runGate('artifact', ['npm', 'run', 'check:artifact'], 'artifact checks green'));
  gates.push(runGate('artifact-matrix', [process.execPath, '--test', ...artifactTestFiles(), 'test/runtime-parity.test.cjs'], 'detector matrix suites green'));
  // Source gates: authority parses, offline suites, static format audit.
  gates.push(runGate('syntax-runtime', [process.execPath, '-e', "new Function(require('fs').readFileSync('src/runtime.js','utf8'))"], 'src runtime authority parses'));
  gates.push(runGate('source-offline', ['npm', 'run', 'test:offline'], 'offline + parity suites green'));
  // Characterization receipts must exist before the inventory gate reads them.
  gates.push(runGate('characterization', ['npm', 'run', 'test:characterization'], 'manifest-owned characterization suites produced HEAD-bound receipts'));
  gates.push(runGate('test-inventory', [process.execPath, 'test/tools/test-inventory-v2.cjs', '--baseline', 'test/fixtures/contracts/test-suite-baseline.json', '--manifest', 'test/fixtures/contracts/test-suite-manifest.json', '--receipt-dir', 'test-results/suite-receipts'], 'manifest and receipt-backed accounting PASS'));
  gates.push(runGate('static-format', [process.execPath, 'test/fixtures/discord/static-format-audit.cjs', '--file', 'src/runtime.js', '--readme', 'README.md'], 'static format audit PASS'));
  // Tool gates: full tools matrix, types, quality.
  gates.push(runGate('tools-tests', [process.execPath, '--test', ...toolsTestFiles()], 'tools suites green'));
  gates.push(runGate('types', ['npm', 'run', 'check:types'], 'tsc --noEmit clean'));
  gates.push(runGate('quality', ['npm', 'run', 'quality'], 'quality gate PASS'));
  // Browser gates: real Chromium integration, then the loopback e2e matrix.
  gates.push(runGate('browser-tests', ['npm', 'run', 'test:browser'], 'browser integration suites green'));
  gates.push(runE2EGate());

  const failed = gates.filter((g) => g.verdict === 'FAIL');
  const skipped = gates.filter((g) => g.verdict !== 'PASS' && g.verdict !== 'FAIL');
  const overall = failed.length === 0 && skipped.length === 0 ? 'PASS' : 'FAIL';
  const summary = {
    overall,
    mode: 'offline (all gates offline by construction; loopback fixtures only)',
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
