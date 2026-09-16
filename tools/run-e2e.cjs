#!/usr/bin/env node
'use strict';

/**
 * Per-spec Playwright runner on the loopback QA config (plan Todo 3).
 *
 * Runs each test/e2e/*.spec.ts in its own Playwright invocation with the
 * JSON reporter captured to a SEPARATE file:
 *   test-results/release-1.0.0/e2e-report-<spec>.spec.json
 *
 * Never writes the shared test-results/e2e-runtime.json (specs themselves
 * write namespaced e2e-evidence-*.json files under release-1.0.0/).
 *
 * Honesty contract: every invocation prints an explicit executed count
 * parsed from the per-spec JSON reports. A missing Chromium binary is
 * reported as NOT EXECUTED and is a FAILURE in release mode (--release /
 * --offline): required skipped suites never pass. Each spec is bounded by
 * a 300s timeout so a hung browser fails instead of hanging the release.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-results', 'release-1.0.0');
const QA_CONFIG = 'test/e2e/playwright.qa.config.ts';
const SPEC_TIMEOUT_MS = 300_000;

const RELEASE = process.argv.includes('--release') || process.argv.includes('--offline');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--release' && arg !== '--offline') {
    console.error(`run-e2e: unknown flag ${arg} (only --release/--offline are supported)`);
    process.exit(2);
  }
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

function executedInReport(reportPath) {
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
  const stats = report.stats || {};
  return (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0) + (stats.skipped || 0);
}

function main() {
  const specs = fs.readdirSync(path.join(ROOT, 'test', 'e2e'))
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((f) => path.join('test', 'e2e', f));
  if (specs.length === 0) {
    console.error('e2e: FAIL (no specs found under test/e2e)');
    process.exit(1);
  }
  if (!chromiumBinaryPresent()) {
    const message = 'e2e: NOT EXECUTED (no browser binary in Playwright cache; browsers were not downloaded)';
    if (RELEASE) {
      console.error(`${message} — failing: a required suite was skipped in release mode`);
      process.exit(1);
    }
    console.log(message);
    process.exit(0);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = 0;
  let executed = 0;
  for (const spec of specs) {
    const base = path.basename(spec, '.spec.ts');
    const report = path.join(OUT_DIR, `e2e-report-${base}.spec.json`);
    console.log(`e2e: running ${spec} -> ${path.relative(ROOT, report)}`);
    const result = spawnSync(
      'npx',
      ['playwright', 'test', spec, '--config', QA_CONFIG, '--reporter=json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SPEC_TIMEOUT_MS },
    );
    fs.writeFileSync(report, `${result.stdout || ''}`);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      console.error(`e2e: ${spec} did not complete (${result.error.message})`);
      failed = 1;
      continue;
    }
    const count = executedInReport(report);
    if (count === null) {
      console.error(`e2e: ${spec} produced an unreadable JSON report`);
      failed = 1;
      continue;
    }
    executed += count;
    console.log(`e2e: ${spec} exit ${result.status} executed=${count}`);
    if (result.status !== 0) failed = 1;
  }
  console.log(`e2e: executed=${executed} across ${specs.length} specs (config ${QA_CONFIG})`);
  if (failed !== 0) {
    console.error(`e2e: FAIL (executed=${executed} across ${specs.length} specs)`);
  }
  process.exit(failed);
}

main();
