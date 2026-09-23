#!/usr/bin/env node
'use strict';

/**
 * Per-spec Playwright runner on the loopback QA config (plan Todo 3, Task 19).
 *
 * Runs each test/e2e/*.spec.ts in its own Playwright invocation with the
 * JSON reporter captured to a SEPARATE file:
 *   test-results/release-1.0.0/e2e-report-<spec>.spec.json
 *
 * Never writes the shared test-results/e2e-runtime.json (specs themselves
 * write namespaced e2e-evidence-*.json files under release-1.0.0/).
 *
 * Honesty contract (fail closed):
 *   - expected / unexpected / flaky / skipped are counted SEPARATELY; only the
 *     `expected` (first-try pass) count of a PASS spec is ever reported as
 *     executed. A skipped test is never executed accounting.
 *   - release mode (--release / --offline) requires, per spec: a readable JSON
 *     report, exit 0, expected >= 1, and zero skipped / zero flaky / zero
 *     unexpected. A missing Chromium binary is NOT EXECUTED and a FAILURE.
 *   - ordinary mode may report skips/flakes but still never counts them as
 *     executed, and still fails on unreadable reports or nonzero exits.
 *
 * Owned child lifecycle:
 *   - every spec runs in its OWN process group (`detached: true`), with a hard
 *     ceiling of 480_000 ms. The verified clean-install spec needs ~346 s on
 *     this DrvFs/WSL workstation, so the ceiling must never drop below 480 s.
 *   - on timeout the process group gets SIGTERM, then SIGKILL after a bounded
 *     grace, and `close` is awaited (with a final bounded wait even after
 *     SIGKILL) before anything else happens.
 *   - after EVERY spec the configured loopback ports must be free again; a
 *     still-bound port is CLEANUP_FAILED and stops the run so later specs are
 *     never launched into an occupied health endpoint.
 *
 * Test-only environment seams (never set in production/CI):
 *   TAA_E2E_SPEC_TIMEOUT_MS  positive integer; shortened per-spec ceiling for
 *                            the contract suite; values above 480_000 are
 *                            clamped to the hard ceiling.
 *   TAA_E2E_LOOPBACK_PORTS   comma-separated 127.0.0.1 ports to verify
 *                            (default 8899, the QA config webServer port).
 *   TAA_E2E_SPECS            comma-separated relative spec paths overriding
 *                            discovery (used with TAA_E2E_SPEC_COMMAND).
 *   TAA_E2E_SPEC_COMMAND     Node script run instead of `npx playwright test`.
 *   TAA_E2E_OUT_DIR          report output directory override.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'test-results', 'release-1.0.0');
const QA_CONFIG = 'test/e2e/playwright.qa.config.ts';

// Hard per-spec ceiling (never lowered in production code).
const HARD_SPEC_CEILING_MS = 480_000;
const TERMINATION_GRACE_MS = 5_000;
const POST_KILL_CLOSE_WAIT_MS = 5_000;
const PORT_FREE_TIMEOUT_MS = 5_000;
const PORT_POLL_INTERVAL_MS = 100;
const DEFAULT_LOOPBACK_PORTS = [8899];

const VERDICT = {
  PASS: 'PASS',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  SKIPPED: 'SKIPPED',
  FLAKY: 'FLAKY',
  UNREADABLE_REPORT: 'UNREADABLE_REPORT',
};

function fail(message, code = 2) {
  process.stderr.write(`run-e2e: ${message}\n`);
  process.exit(code);
}

function parseFlags(argv) {
  const flags = { release: false };
  for (const arg of argv) {
    if (arg === '--release' || arg === '--offline') flags.release = true;
    else fail(`unknown flag ${arg} (only --release/--offline are supported)`);
  }
  return flags;
}

function resolveTimeoutMs(env) {
  const raw = env.TAA_E2E_SPEC_TIMEOUT_MS;
  if (raw === undefined || raw === '') return { timeoutMs: HARD_SPEC_CEILING_MS, clamped: false, requested: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`TAA_E2E_SPEC_TIMEOUT_MS must be a positive integer, got ${raw}`);
  }
  if (value > HARD_SPEC_CEILING_MS) {
    return { timeoutMs: HARD_SPEC_CEILING_MS, clamped: true, requested: value };
  }
  return { timeoutMs: value, clamped: false, requested: value };
}

function resolvePorts(env) {
  const raw = env.TAA_E2E_LOOPBACK_PORTS;
  if (raw === undefined || raw === '') return [...DEFAULT_LOOPBACK_PORTS];
  const ports = String(raw).split(',').map((entry) => Number(entry.trim()));
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    fail(`TAA_E2E_LOOPBACK_PORTS must be comma-separated ports 1..65535, got ${raw}`);
  }
  return [...new Set(ports)];
}

function resolveSpecs(env) {
  const raw = env.TAA_E2E_SPECS;
  if (raw === undefined || raw === '') return null;
  const specs = String(raw).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (specs.length === 0) fail('TAA_E2E_SPECS must list at least one spec');
  for (const spec of specs) {
    if (path.isAbsolute(spec) || spec.includes('..')) {
      fail(`TAA_E2E_SPECS entries must be relative paths without "..", got ${spec}`);
    }
  }
  return specs;
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
    if (entries.some((entry) => entry.startsWith('chromium-') && !entry.includes('headless_shell'))) return true;
  }
  return false;
}

function discoverSpecs() {
  return fs.readdirSync(path.join(ROOT, 'test', 'e2e'))
    .filter((file) => file.endsWith('.spec.ts'))
    .sort()
    .map((file) => path.join('test', 'e2e', file));
}

function specCommand(spec, env) {
  const override = env.TAA_E2E_SPEC_COMMAND;
  if (override) {
    return {
      command: process.execPath,
      args: [path.resolve(ROOT, override), spec, '--config', QA_CONFIG, '--reporter=json'],
    };
  }
  return {
    command: 'npx',
    args: ['playwright', 'test', spec, '--config', QA_CONFIG, '--reporter=json'],
  };
}

// A readable Playwright JSON report has a stats object with non-negative
// integer counters. Anything else (missing file, truncated stdout, forged
// shape) is unreadable and can never contribute to PASS.
function parseReportCounts(reportPath) {
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
  if (!report || typeof report !== 'object' || !report.stats || typeof report.stats !== 'object') return null;
  const stats = report.stats;
  const counts = {
    expected: stats.expected || 0,
    unexpected: stats.unexpected || 0,
    flaky: stats.flaky || 0,
    skipped: stats.skipped || 0,
  };
  if (Object.values(counts).some((value) => !Number.isInteger(value) || value < 0)) return null;
  return counts;
}

function classifySpec({ counts, exitCode, release }) {
  if (counts === null) {
    return { verdict: VERDICT.UNREADABLE_REPORT, failure: true, reason: 'unreadable JSON report' };
  }
  if (exitCode !== 0) {
    return { verdict: VERDICT.FAILED, failure: true, reason: `exit ${exitCode}` };
  }
  if (release && counts.skipped > 0) {
    return { verdict: VERDICT.SKIPPED, failure: true, reason: `release mode requires zero skipped (skipped=${counts.skipped})` };
  }
  if (release && counts.flaky > 0) {
    return { verdict: VERDICT.FLAKY, failure: true, reason: `release mode requires zero flaky (flaky=${counts.flaky})` };
  }
  if (release && counts.expected < 1) {
    return { verdict: VERDICT.FAILED, failure: true, reason: 'release mode requires a positive expected count' };
  }
  if (counts.unexpected > 0) {
    return { verdict: VERDICT.FAILED, failure: true, reason: `unexpected=${counts.unexpected}` };
  }
  if (counts.skipped > 0) {
    return { verdict: VERDICT.SKIPPED, failure: false, reason: `skipped=${counts.skipped} reported but never counted as executed` };
  }
  if (counts.flaky > 0) {
    return { verdict: VERDICT.FLAKY, failure: false, reason: `flaky=${counts.flaky} reported` };
  }
  return { verdict: VERDICT.PASS, failure: false, reason: `expected=${counts.expected}` };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Owns one spec invocation end to end: detached process group, hard ceiling,
// SIGTERM -> bounded grace -> SIGKILL escalation, awaited close.
function runSpecProcess({ spec, timeoutMs, env }) {
  return new Promise((resolve) => {
    const { command, args } = specCommand(spec, env);
    const startedMs = Date.now();
    const child = spawn(command, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalated = false;
    let settled = false;
    let ceilingTimer = null;
    let graceTimer = null;
    let closeWaitTimer = null;

    const clearTimers = () => {
      clearTimeout(ceilingTimer);
      clearTimeout(graceTimer);
      clearTimeout(closeWaitTimer);
    };
    const finish = (exitCode, signal, spawnError, closed) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        startedMs,
        exitCode,
        signal,
        spawnError: spawnError || null,
        timedOut,
        escalated,
        closed: closed !== false,
        stdout,
        stderr,
      });
    };

    ceilingTimer = setTimeout(() => {
      timedOut = true;
      // The child owns its process group; terminate the whole tree so no
      // Playwright/web-server descendant survives the timeout.
      killGroup(child.pid, 'SIGTERM');
      graceTimer = setTimeout(() => {
        escalated = true;
        killGroup(child.pid, 'SIGKILL');
        // Even SIGKILL must be awaited within bounds: fail closed otherwise.
        closeWaitTimer = setTimeout(() => finish(null, null, null, false), POST_KILL_CLOSE_WAIT_MS);
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(null, null, error, true));
    child.on('close', (exitCode, signal) => finish(exitCode, signal, null, true));
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bind-probe each configured loopback port; a listener that survived a spec
// keeps the port occupied and must stop the run.
async function verifyPortsFree(ports) {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  for (;;) {
    const occupied = [];
    for (const port of ports) {
      const free = await probePort(port);
      if (!free) occupied.push(port);
    }
    if (occupied.length === 0) return { ok: true, occupied: [] };
    if (Date.now() >= deadline) return { ok: false, occupied };
    await sleep(PORT_POLL_INTERVAL_MS);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const { timeoutMs, clamped, requested } = resolveTimeoutMs(process.env);
  const ports = resolvePorts(process.env);
  const outDir = process.env.TAA_E2E_OUT_DIR ? path.resolve(process.env.TAA_E2E_OUT_DIR) : DEFAULT_OUT_DIR;
  const specs = resolveSpecs(process.env) || discoverSpecs();

  if (specs.length === 0) {
    console.error('e2e: FAIL (no specs found under test/e2e)');
    process.exit(1);
  }
  if (!chromiumBinaryPresent()) {
    const message = 'e2e: NOT EXECUTED (no browser binary in Playwright cache; browsers were not downloaded)';
    if (flags.release) {
      console.error(`${message} — failing: a required suite was skipped in release mode`);
      process.exit(1);
    }
    console.log(message);
    process.exit(0);
  }

  if (clamped) {
    console.error(`e2e: TAA_E2E_SPEC_TIMEOUT_MS=${requested} exceeds the hard ceiling; clamped to ${HARD_SPEC_CEILING_MS}ms`);
  }
  console.log(
    `e2e: per-spec ceiling ${timeoutMs}ms; loopback ports ${ports.join(', ')}; ${specs.length} specs;`
    + ` mode ${flags.release ? 'release' : 'ordinary'}`,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const preflight = await verifyPortsFree(ports);
  if (!preflight.ok) {
    console.error(`e2e: [${VERDICT.CLEANUP_FAILED}] loopback port(s) ${preflight.occupied.join(', ')} already bound before the run; refusing to start`);
    console.error('e2e: FAIL (executed=0 across 0 specs)');
    process.exit(1);
  }

  const totals = { executed: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0, specsRun: 0, notRun: 0 };
  let failed = false;

  for (const spec of specs) {
    const base = path.basename(spec, '.spec.ts');
    const reportPath = path.join(outDir, `e2e-report-${base}.spec.json`);
    console.log(`e2e: running ${spec} -> ${path.relative(ROOT, reportPath)}`);
    const result = await runSpecProcess({ spec, timeoutMs, env: process.env });
    fs.writeFileSync(reportPath, result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    const reaped = !result.spawnError && !result.timedOut && result.closed;
    const counts = reaped ? parseReportCounts(reportPath) : null;

    let verdict;
    let failure;
    let reason;
    if (result.spawnError) {
      verdict = VERDICT.FAILED;
      failure = true;
      reason = `did not complete (${result.spawnError.message})`;
    } else if (result.timedOut) {
      verdict = VERDICT.TIMED_OUT;
      failure = true;
      reason = `exceeded the ${timeoutMs}ms ceiling; process group terminated (escalated=${result.escalated})`;
    } else if (!result.closed) {
      verdict = VERDICT.CLEANUP_FAILED;
      failure = true;
      reason = 'child did not close after SIGKILL escalation';
    } else {
      const classification = classifySpec({ counts, exitCode: result.exitCode, release: flags.release });
      verdict = classification.verdict;
      failure = classification.failure;
      reason = classification.reason;
    }

    totals.specsRun += 1;
    if (failure) failed = true;

    if (counts) {
      totals.expected += counts.expected;
      totals.unexpected += counts.unexpected;
      totals.flaky += counts.flaky;
      totals.skipped += counts.skipped;
      if (verdict === VERDICT.PASS) totals.executed += counts.expected;
    }
    const counters = counts
      ? `expected=${counts.expected} unexpected=${counts.unexpected} flaky=${counts.flaky} skipped=${counts.skipped}`
      : 'expected=n/a unexpected=n/a flaky=n/a skipped=n/a';
    console.log(
      `e2e: [${verdict}] ${spec} exit=${result.exitCode === null ? 'n/a' : result.exitCode} ${counters} (${reason})`,
    );

    const portCheck = await verifyPortsFree(ports);
    if (!portCheck.ok) {
      console.error(`e2e: [${VERDICT.CLEANUP_FAILED}] loopback port(s) ${portCheck.occupied.join(', ')} still bound after ${spec}; stopping before later specs`);
      failed = true;
      totals.notRun = specs.length - totals.specsRun;
      break;
    }
    if (result.timedOut || !result.closed || result.spawnError) {
      totals.notRun = specs.length - totals.specsRun;
      break;
    }
  }

  console.log(
    `e2e: executed=${totals.executed} across ${totals.specsRun} specs`
    + ` (expected=${totals.expected} unexpected=${totals.unexpected} flaky=${totals.flaky} skipped=${totals.skipped} notRun=${totals.notRun};`
    + ` config ${QA_CONFIG})`,
  );
  if (failed) {
    console.error(`e2e: FAIL (executed=${totals.executed} across ${totals.specsRun} specs)`);
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`run-e2e: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = {
  HARD_SPEC_CEILING_MS,
  VERDICT,
  classifySpec,
  parseReportCounts,
  resolvePorts,
  resolveSpecs,
  resolveTimeoutMs,
  specCommand,
  verifyPortsFree,
};
