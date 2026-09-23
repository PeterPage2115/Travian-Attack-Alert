'use strict';

// Tool contract for `tools/run-e2e.cjs` and the release e2e gate (Task 19).
//
// Every case drives the REAL runner binary (`node tools/run-e2e.cjs`) through
// its documented test-only environment seams, with a temporary Node fixture
// impersonating one Playwright invocation. The fixtures live under
// os.tmpdir(); nothing under test/e2e or the repository is touched.
//
// Browser independence (CI never downloads Playwright browsers): the runner
// refuses to execute any spec unless `chromiumBinaryPresent()` sees a
// `chromium-*` entry under PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright.
// `fixtureEnv()` therefore points PLAYWRIGHT_BROWSERS_PATH at a fake
// `chromium-<version>` directory created under os.tmpdir(), so every fixture
// case reaches the fixture command on any machine. The production precheck is
// NOT weakened: one case proves it still fails closed when both the configured
// cache and the home cache are empty.
//
// Covered failure classes:
//   - a skipped-only report is SKIPPED in release mode and is never counted as
//     executed (ordinary mode reports skips without counting them either),
//   - a flaky-only report is FLAKY in release mode,
//   - a malformed report is UNREADABLE_REPORT,
//   - a partial stats object (only `expected`) and every missing/null/negative/
//     non-integer counter is UNREADABLE_REPORT: counters never default to 0,
//   - no Chromium in any cache is NOT EXECUTED and a release-mode failure,
//   - release mode requires a positive expected count,
//   - a hanging child is TIMED_OUT, its process group is reaped, and the
//     configured loopback port is free again (the next spec is not launched),
//   - a child that ignores SIGTERM is still reaped by SIGKILL escalation,
//   - a descendant that survives the process-group kill keeps the port bound,
//     yields CLEANUP_FAILED, and stops the run,
//   - an already-occupied loopback port fails closed before any spec starts,
//   - the timeout override is clamped to the 480 s hard ceiling and invalid
//     overrides are rejected,
//   - `tools/check-release.cjs` runE2EGate() consumes the separated counters
//     and fails closed on skipped executions / passes a clean fixture.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'tools', 'run-e2e.cjs');
const CHECK_RELEASE = path.join(ROOT, 'tools', 'check-release.cjs');

const PASS_SPEC = 'test/e2e/fixture-pass.spec.ts';
const SKIPPED_SPEC = 'test/e2e/fixture-skipped.spec.ts';
const FLAKY_SPEC = 'test/e2e/fixture-flaky.spec.ts';
const MALFORMED_SPEC = 'test/e2e/fixture-malformed.spec.ts';
const ZERO_SPEC = 'test/e2e/fixture-zero.spec.ts';
const HANG_SPEC = 'test/e2e/fixture-hang.spec.ts';
const IGNORE_TERM_SPEC = 'test/e2e/fixture-ignore-term.spec.ts';
const ESCAPED_SPEC = 'test/e2e/fixture-escaped.spec.ts';
const MARKER_SPEC = 'test/e2e/fixture-marker.spec.ts';
const STATS_SPEC = 'test/e2e/fixture-stats.spec.ts';

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-e2e-contract-'));
const FIXTURE_RUNNER = path.join(FIXTURE_ROOT, 'fixture-runner.cjs');
const FIXTURE_DAEMON = path.join(FIXTURE_ROOT, 'fixture-daemon.cjs');

// Test-only browser seam: a fake Playwright cache with one `chromium-*` entry.
// `chromiumBinaryPresent()` (tools/run-e2e.cjs) only inspects directory names,
// so this satisfies the real precheck without downloading anything.
const FAKE_BROWSERS_ROOT = path.join(FIXTURE_ROOT, 'browsers');
fs.mkdirSync(path.join(FAKE_BROWSERS_ROOT, 'chromium-9999.0.0'), { recursive: true });

fs.writeFileSync(FIXTURE_RUNNER, `'use strict';
// Test-only fixture for test/tools/run-e2e-contract.test.cjs. argv[2] is the
// spec path; its basename selects the behaviour. Never touches the repository.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const spec = process.argv[2] || '';
const behavior = path.basename(spec).replace(/\\.spec\\.ts$/, '').replace(/^fixture-/, '');
const port = Number(process.env.TAA_FIXTURE_PORT || 0);
const markerDir = process.env.TAA_FIXTURE_MARKER_DIR || '';
const pidFile = process.env.TAA_FIXTURE_PID_FILE || '';

function marker() {
  if (!markerDir) return;
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, path.basename(spec) + '.ran'), '');
}

function emitReport(expected, unexpected, flaky, skipped) {
  fs.writeSync(1, JSON.stringify({
    config: {},
    suites: [],
    errors: [],
    stats: { expected, unexpected, flaky, skipped },
  }) + '\\n');
  process.exit(0);
}

function holdPort() {
  const server = http.createServer((request, response) => response.end('ok'));
  server.listen(port, '127.0.0.1', () => {
    if (pidFile) fs.appendFileSync(pidFile, String(process.pid) + '\\n');
  });
  setInterval(() => {}, 1000);
}

marker();
switch (behavior) {
  case 'pass': emitReport(2, 0, 0, 0); break;
  case 'skipped': emitReport(0, 0, 0, 4); break;
  case 'flaky': emitReport(3, 0, 1, 0); break;
  case 'malformed':
    fs.writeSync(1, '{ not json\\n');
    process.exit(0);
    break;
  case 'zero': emitReport(0, 0, 0, 0); break;
  case 'stats': {
    const stats = JSON.parse(process.env.TAA_FIXTURE_STATS_JSON || '{}');
    fs.writeSync(1, JSON.stringify({ config: {}, suites: [], errors: [], stats }) + '\\n');
    process.exit(0);
    break;
  }
  case 'hang': holdPort(); break;
  case 'ignore-term':
    process.on('SIGTERM', () => {});
    holdPort();
    break;
  case 'escaped': {
    const daemon = spawn(process.execPath, [path.join(__dirname, 'fixture-daemon.cjs')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    daemon.unref();
    setInterval(() => {}, 1000);
    break;
  }
  case 'marker': emitReport(1, 0, 0, 0); break;
  default:
    fs.writeSync(2, 'unknown fixture behavior: ' + behavior + '\\n');
    process.exit(3);
}
`);

fs.writeFileSync(FIXTURE_DAEMON, `'use strict';
// Test-only escaped descendant: its own session/process group, so the runner's
// process-group kill cannot reach it; it keeps the loopback port bound.
const fs = require('node:fs');
const http = require('node:http');

const port = Number(process.env.TAA_FIXTURE_PORT || 0);
const pidFile = process.env.TAA_FIXTURE_DAEMON_PID_FILE || '';
const server = http.createServer((request, response) => response.end('daemon'));
server.listen(port, '127.0.0.1', () => {
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid) + '\\n');
});
`);

process.on('exit', () => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

let caseCounter = 0;

function newCase() {
  caseCounter += 1;
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, `case-${String(caseCounter).padStart(2, '0')}-`));
  const ctx = {
    dir,
    outDir: path.join(dir, 'out'),
    pidFile: path.join(dir, 'pids.txt'),
    daemonPidFile: path.join(dir, 'daemon.pid'),
    markerDir: path.join(dir, 'markers'),
  };
  fs.mkdirSync(ctx.markerDir, { recursive: true });
  return ctx;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
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

async function waitPortFree(port, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForGone(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

function readPids(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\s+/u).filter(Boolean).map(Number);
}

function killPids(file) {
  for (const pid of readPids(file)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function markerPath(ctx, spec) {
  return path.join(ctx.markerDir, `${path.basename(spec)}.ran`);
}

function fixtureEnv({ specs, ctx, port, timeoutMs, stats }) {
  const env = {
    TAA_E2E_SPEC_COMMAND: FIXTURE_RUNNER,
    TAA_E2E_SPECS: specs.join(','),
    TAA_E2E_OUT_DIR: ctx.outDir,
    TAA_E2E_SPEC_TIMEOUT_MS: String(timeoutMs),
    TAA_E2E_LOOPBACK_PORTS: String(port),
    TAA_FIXTURE_PORT: String(port),
    TAA_FIXTURE_PID_FILE: ctx.pidFile,
    TAA_FIXTURE_DAEMON_PID_FILE: ctx.daemonPidFile,
    TAA_FIXTURE_MARKER_DIR: ctx.markerDir,
    // Fake Playwright cache: lets the real precheck pass without a browser.
    PLAYWRIGHT_BROWSERS_PATH: FAKE_BROWSERS_ROOT,
  };
  if (stats !== undefined) env.TAA_FIXTURE_STATS_JSON = JSON.stringify(stats);
  return env;
}

function runRunner({ specs, ctx, port, release = true, timeoutMs = 2_000, spawnTimeoutMs = 60_000, stats }) {
  const args = [RUNNER, ...(release ? ['--release'] : [])];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: spawnTimeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...fixtureEnv({ specs, ctx, port, timeoutMs, stats }) },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

async function withEnv(env, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('release mode refuses a skipped-only report with SKIPPED and never counts it as executed', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [SKIPPED_SPEC], ctx, port, release: true });
    assert.notEqual(run.status, 0, 'release mode must fail on skipped executions');
    assert.match(run.output, /\[SKIPPED\]/u);
    assert.match(run.output, /release mode requires zero skipped \(skipped=4\)/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
    assert.match(run.output, /expected=0 unexpected=0 flaky=0 skipped=4/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('ordinary mode reports skips without counting them as executed', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [SKIPPED_SPEC], ctx, port, release: false });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /\[SKIPPED\]/u);
    assert.match(run.output, /never counted as executed/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
    assert.match(run.output, /skipped=4/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('release mode refuses a flaky-only report with FLAKY', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [FLAKY_SPEC], ctx, port, release: true });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[FLAKY\]/u);
    assert.match(run.output, /release mode requires zero flaky \(flaky=1\)/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
    assert.match(run.output, /expected=3 unexpected=0 flaky=1 skipped=0/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('a malformed report yields UNREADABLE_REPORT', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [MALFORMED_SPEC], ctx, port, release: true });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[UNREADABLE_REPORT\]/u);
    assert.match(run.output, /unreadable JSON report/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('a partial report that only carries expected yields UNREADABLE_REPORT', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const partial = runRunner({ specs: [STATS_SPEC], ctx, port, release: true, stats: { expected: 2 } });
    assert.notEqual(partial.status, 0);
    assert.match(partial.output, /\[UNREADABLE_REPORT\]/u);
    assert.match(partial.output, /unreadable JSON report/u);
    assert.match(partial.output, /executed=0 across 1 specs/u);
    assert.match(partial.output, /expected=n\/a unexpected=n\/a flaky=n\/a skipped=n\/a/u, 'partial counters must never default to 0');

    // The same shape with all four counters (plus unrelated keys) still passes:
    // the strictness targets the four counters, not extra report fields.
    const complete = runRunner({
      specs: [STATS_SPEC], ctx, port, release: true,
      stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0, duration: 5 },
    });
    assert.equal(complete.status, 0, complete.output);
    assert.match(complete.output, /\[PASS\]/u);
    assert.match(complete.output, /executed=2 across 1 specs/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('missing, null, negative, or non-integer stats fields yield UNREADABLE_REPORT', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  const variants = [
    ['missing expected', { unexpected: 0, flaky: 0, skipped: 0 }],
    ['missing unexpected', { expected: 2, flaky: 0, skipped: 0 }],
    ['missing flaky', { expected: 2, unexpected: 0, skipped: 0 }],
    ['missing skipped', { expected: 2, unexpected: 0, flaky: 0 }],
    ['null expected', { expected: null, unexpected: 0, flaky: 0, skipped: 0 }],
    ['null skipped', { expected: 2, unexpected: 0, flaky: 0, skipped: null }],
    ['negative expected', { expected: -1, unexpected: 0, flaky: 0, skipped: 0 }],
    ['negative flaky', { expected: 2, unexpected: 0, flaky: -2, skipped: 0 }],
    ['non-integer expected', { expected: 1.5, unexpected: 0, flaky: 0, skipped: 0 }],
    ['non-integer skipped (string)', { expected: 2, unexpected: 0, flaky: 0, skipped: '0' }],
  ];
  try {
    for (const [name, stats] of variants) {
      const run = runRunner({ specs: [STATS_SPEC], ctx, port, release: true, stats });
      assert.notEqual(run.status, 0, `${name}: release mode must fail\n${run.output}`);
      assert.match(run.output, /\[UNREADABLE_REPORT\]/u, `${name}: must be UNREADABLE_REPORT`);
      assert.match(run.output, /unreadable JSON report/u, name);
      assert.match(run.output, /expected=n\/a unexpected=n\/a flaky=n\/a skipped=n\/a/u, `${name}: counters must not default to 0`);
    }
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('release mode requires a positive expected count', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [ZERO_SPEC], ctx, port, release: true });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[FAILED\]/u);
    assert.match(run.output, /positive expected count/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('a hanging child is TIMED_OUT, reaped, and leaves the loopback port free', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [HANG_SPEC, MARKER_SPEC], ctx, port, release: true, timeoutMs: 1_500 });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[TIMED_OUT\]/u);
    assert.match(run.output, /escalated=false/u);
    assert.match(run.output, /executed=0 across 1 specs/u);
    assert.match(run.output, /notRun=1/u, 'later specs must not be launched after a timeout');
    assert.equal(fs.existsSync(markerPath(ctx, MARKER_SPEC)), false, 'the second spec must not run');

    const pids = readPids(ctx.pidFile);
    assert.ok(pids.length >= 1, 'the fixture must have recorded its pid');
    for (const pid of pids) {
      assert.equal(await waitForGone(pid), true, `fixture pid ${pid} must be reaped`);
    }
    assert.equal(await waitPortFree(port), true, `port ${port} must be free after the timeout`);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('a child that ignores SIGTERM is still reaped by SIGKILL escalation', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [IGNORE_TERM_SPEC], ctx, port, release: true, timeoutMs: 1_500 });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[TIMED_OUT\]/u);
    assert.match(run.output, /escalated=true/u, 'SIGTERM must be escalated to SIGKILL after the grace period');

    const pids = readPids(ctx.pidFile);
    assert.ok(pids.length >= 1);
    for (const pid of pids) {
      assert.equal(await waitForGone(pid), true, `SIGTERM-ignoring pid ${pid} must be SIGKILLed`);
    }
    assert.equal(await waitPortFree(port), true);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('a descendant that survives the process-group kill yields CLEANUP_FAILED and stops the run', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [ESCAPED_SPEC, MARKER_SPEC], ctx, port, release: true, timeoutMs: 1_500 });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[TIMED_OUT\]/u);
    assert.match(run.output, /\[CLEANUP_FAILED\]/u);
    assert.match(run.output, /still bound after/u);
    assert.match(run.output, /notRun=1/u);
    assert.equal(fs.existsSync(markerPath(ctx, MARKER_SPEC)), false, 'the second spec must not run into an occupied port');

    const daemonPids = readPids(ctx.daemonPidFile);
    assert.ok(daemonPids.length >= 1, 'the escaped daemon must have recorded its pid');
    assert.equal(isAlive(daemonPids[0]), true, 'the escaped descendant proves the port check (not the kill) caught it');
    assert.equal(await probePort(port), false, 'the escaped descendant still holds the port');
  } finally {
    killPids(ctx.pidFile);
    killPids(ctx.daemonPidFile);
    assert.equal(await waitPortFree(port), true, 'cleanup must leave the port free');
  }
});

test('an occupied loopback port fails closed before any spec starts', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const run = runRunner({ specs: [PASS_SPEC], ctx, port, release: true });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /\[CLEANUP_FAILED\]/u);
    assert.match(run.output, /already bound before the run/u);
    assert.match(run.output, /executed=0 across 0 specs/u);
    assert.equal(fs.existsSync(markerPath(ctx, PASS_SPEC)), false, 'no spec may start while the port is occupied');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    killPids(ctx.pidFile);
  }
});

test('the real browser precheck fails closed when no Chromium exists in any cache', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  const emptyBrowsers = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'empty-browsers-'));
  const emptyHome = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'empty-home-'));
  // Production precheck isolation: PLAYWRIGHT_BROWSERS_PATH points at an empty
  // directory and HOME/USERPROFILE at an empty home, so no `chromium-*` entry
  // exists anywhere the runner looks (the real CI condition). The production
  // precheck must stay fail-closed: NOT EXECUTED, and a failure in release mode.
  const env = {
    ...process.env,
    ...fixtureEnv({ specs: [PASS_SPEC], ctx, port, timeoutMs: 2_000 }),
    PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
    HOME: emptyHome,
    USERPROFILE: emptyHome,
  };
  const spawnRunner = (release) => spawnSync(process.execPath, [RUNNER, ...(release ? ['--release'] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  });

  const release = spawnRunner(true);
  const releaseOutput = `${release.stdout || ''}${release.stderr || ''}`;
  assert.equal(release.status, 1, releaseOutput);
  assert.match(releaseOutput, /e2e: NOT EXECUTED \(no browser binary in Playwright cache; browsers were not downloaded\)/u);
  assert.match(releaseOutput, /failing: a required suite was skipped in release mode/u);

  const ordinary = spawnRunner(false);
  const ordinaryOutput = `${ordinary.stdout || ''}${ordinary.stderr || ''}`;
  assert.equal(ordinary.status, 0, ordinaryOutput);
  assert.match(ordinaryOutput, /e2e: NOT EXECUTED \(no browser binary in Playwright cache/u);

  assert.equal(fs.existsSync(markerPath(ctx, PASS_SPEC)), false, 'no spec may start without a browser');
  assert.equal(fs.existsSync(ctx.outDir), false, 'the precheck must exit before creating the report directory');
});

test('a timeout override above the hard ceiling is clamped to 480000ms', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const run = runRunner({ specs: [PASS_SPEC], ctx, port, release: true, timeoutMs: 999_999_999 });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /clamped to 480000ms/u);
    assert.match(run.output, /per-spec ceiling 480000ms/u);
    assert.doesNotMatch(run.output, /ceiling 999999999ms/u);
    assert.match(run.output, /executed=2 across 1 specs/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('an invalid timeout or port override is rejected', async () => {
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const badTimeout = runRunner({ specs: [PASS_SPEC], ctx, port, timeoutMs: 'abc' });
    assert.equal(badTimeout.status, 2, badTimeout.output);
    assert.match(badTimeout.output, /TAA_E2E_SPEC_TIMEOUT_MS must be a positive integer/u);

    const badPort = spawnSync(process.execPath, [RUNNER, '--release'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...fixtureEnv({ specs: [PASS_SPEC], ctx, port, timeoutMs: 2_000 }), TAA_E2E_LOOPBACK_PORTS: 'abc' },
    });
    assert.equal(badPort.status, 2, `${badPort.stdout}${badPort.stderr}`);
    assert.match(`${badPort.stdout}${badPort.stderr}`, /TAA_E2E_LOOPBACK_PORTS must be comma-separated ports/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('the release gate fails closed on skipped executions and never reports PASS', async () => {
  // eslint-disable-next-line global-require
  const checkRelease = require(CHECK_RELEASE);
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const gate = await withEnv(fixtureEnv({ specs: [SKIPPED_SPEC], ctx, port, timeoutMs: 1_500 }), () => checkRelease.runE2EGate());
    assert.equal(gate.verdict, 'FAIL');
    assert.match(gate.reason, /skipped=4/u);
    assert.match(gate.reason, /executed=0/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});

test('the release gate passes a clean fixture only with positive separated counters', async () => {
  // eslint-disable-next-line global-require
  const checkRelease = require(CHECK_RELEASE);
  const ctx = newCase();
  const port = await getFreePort();
  try {
    const gate = await withEnv(fixtureEnv({ specs: [PASS_SPEC], ctx, port, timeoutMs: 2_000 }), () => checkRelease.runE2EGate());
    assert.equal(gate.verdict, 'PASS', gate.reason);
    assert.match(gate.reason, /executed=2/u);
    assert.match(gate.reason, /unexpected=0 flaky=0 skipped=0/u);
  } finally {
    killPids(ctx.pidFile);
    await waitPortFree(port);
  }
});
