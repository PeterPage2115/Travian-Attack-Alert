'use strict';

// Task 13 update-channel verification contract.
//
// `tools/verify-update-channel.cjs` is the opt-in, read-only verifier the owner
// runs after pushing the release branch. These tests exercise it ONLY against a
// loopback HTTP server: the configured public URLs are rewritten to
// http://127.0.0.1:<port> through the injectable base URL, so no automated run
// ever touches the real network.
//
// Covered: the loopback happy path (remote bytes/SHA-256/version/directives must
// equal the local dist + config), non-200 status, altered bytes, altered
// version, altered @updateURL directive, malformed response, timeout, oversized
// response, byte-deterministic JSON, and fail-closed local preflight (stale
// sidecar, local header/config URL drift, missing configured URL) with zero
// network requests. Every failure must exit nonzero and must never print the
// response body: fixtures plant a marker in served bytes and every assertion
// checks the marker is absent from stdout and stderr.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'verify-update-channel.cjs');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const DIST_PATH = path.join(ROOT, 'dist', DIST_BASENAME);
const DIST_BYTES = fs.readFileSync(DIST_PATH);
const DIST_TEXT = DIST_BYTES.toString('utf8');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'userscript.json'), 'utf8'));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SIDECAR = `${sha256(DIST_BYTES)}  dist/${DIST_BASENAME}\n`;
const SPAWN_TIMEOUT_MS = 30000;
// Planted in served bodies; must never appear in any tool output.
const SECRET_MARKER = 'TAA-RESPONSE-BODY-SECRET-MARKER';

const ENV_KEYS = [
  'TAA_ROOT',
  'TAA_UPDATE_CHANNEL_BASE_URL',
  'TAA_UPDATE_CHANNEL_TIMEOUT_MS',
  'TAA_UPDATE_CHANNEL_MAX_BYTES',
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function startServer(t, handler) {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    res.on('error', () => {});
    handler(req, res, state);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => done());
      }));
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, state });
    });
  });
}

function serveBytes(bytes, status = 200) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(bytes);
  };
}

// Async spawn (not spawnSync): the loopback server lives in this process, so a
// synchronous child would block the event loop and starve its own requests.
function runCli(args = [], extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const key of ENV_KEYS) if (!(key in extraEnv)) delete env[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => {
      clearTimeout(killTimer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function parseOutput(result) {
  assert.ok(result.stdout.length > 0, `expected JSON on stdout, got stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function assertNoBodyLeak(result) {
  assert.ok(!result.stdout.includes(SECRET_MARKER), 'stdout must never contain the response body');
  assert.ok(!result.stderr.includes(SECRET_MARKER), 'stderr must never contain the response body');
}

function fixtureRoot(t, { config = CONFIG, distBytes = DIST_BYTES, sidecar = SIDECAR, pkg = PKG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-update-channel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'userscript.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'dist', DIST_BASENAME), distBytes);
  fs.writeFileSync(path.join(root, 'dist', `${DIST_BASENAME}.sha256`), sidecar);
  return root;
}

function snapshotTree(root) {
  const entries = [];
  const visit = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(childAbs);
      entries.push({ rel: childRel, kind: stat.isDirectory() ? 'dir' : 'file', size: stat.size });
      if (stat.isDirectory()) visit(childAbs, childRel);
      else entries[entries.length - 1].sha256 = sha256(fs.readFileSync(childAbs));
    }
  };
  visit(root, '');
  return entries;
}

test('loopback happy path: matching bytes, SHA-256, version and directives pass', async (t) => {
  const { baseUrl, state } = await startServer(t, serveBytes(DIST_BYTES));
  const result = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.equal(result.status, 0, result.stderr);
  const body = parseOutput(result);
  assert.equal(body.verdict, 'PASS');
  assert.equal(body.transport, 'loopback');
  assert.equal(body.local.version, PKG.version);
  assert.equal(body.local.sha256, sha256(DIST_BYTES));
  assert.equal(body.local.sidecarSha256, sha256(DIST_BYTES));
  assert.deepEqual(body.local.directives, { updateURL: CONFIG.updateURL, downloadURL: CONFIG.downloadURL });
  assert.equal(body.targets.length, 1);
  assert.deepEqual(body.targets[0].roles, ['updateURL', 'downloadURL']);
  assert.equal(body.targets[0].url, CONFIG.updateURL);
  assert.equal(body.targets[0].status, 200);
  assert.equal(body.targets[0].sha256, sha256(DIST_BYTES));
  assert.equal(body.targets[0].version, PKG.version);
  assert.deepEqual(body.targets[0].directives, { updateURL: CONFIG.updateURL, downloadURL: CONFIG.downloadURL });
  assert.deepEqual(body.targets[0].failures, []);
  assert.deepEqual(body.failures, []);
  assert.equal(state.requests, 1);
  assertNoBodyLeak(result);
});

test('non-200 response exits nonzero with a typed status and no body output', async (t) => {
  const { baseUrl, state } = await startServer(t, serveBytes(`${SECRET_MARKER} not found`, 404));
  const result = await runCli(['--base-url', baseUrl]);
  assert.notEqual(result.status, 0, 'a 404 must exit nonzero');
  const body = parseOutput(result);
  assert.equal(body.verdict, 'FAIL');
  assert.equal(body.targets[0].status, 404);
  assert.equal(body.targets[0].sha256, null);
  assert.ok(body.targets[0].failures.includes('non-200-status:404'), `failures: ${body.targets[0].failures}`);
  assert.equal(state.requests, 1);
  assertNoBodyLeak(result);
});

test('altered remote bytes fail with hash-mismatch only', async (t) => {
  const { baseUrl } = await startServer(t, serveBytes(Buffer.concat([DIST_BYTES, Buffer.from(`\n// ${SECRET_MARKER}\n`)])));
  const result = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.equal(body.verdict, 'FAIL');
  assert.equal(body.targets[0].status, 200);
  assert.notEqual(body.targets[0].sha256, sha256(DIST_BYTES));
  assert.ok(body.targets[0].failures.includes('hash-mismatch'), `failures: ${body.targets[0].failures}`);
  assert.ok(!body.targets[0].failures.includes('version-mismatch'));
  assert.ok(!body.targets[0].failures.some((failure) => failure.startsWith('directive-mismatch')));
  assertNoBodyLeak(result);
});

test('altered remote version fails with version-mismatch', async (t) => {
  const altered = Buffer.from(DIST_TEXT.replace(/^(\/\/ @version\s+).*$/m, '$19.9.9'));
  const { baseUrl } = await startServer(t, serveBytes(altered));
  const result = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.equal(body.targets[0].version, '9.9.9');
  assert.ok(body.targets[0].failures.includes('version-mismatch'), `failures: ${body.targets[0].failures}`);
  assert.ok(body.targets[0].failures.includes('hash-mismatch'));
  assert.ok(!body.targets[0].failures.some((failure) => failure.startsWith('directive-mismatch')));
});

test('remote header URL that disagrees with config fails with directive-mismatch', async (t) => {
  const altered = Buffer.from(DIST_TEXT.replace(/^(\/\/ @updateURL\s+).*$/m, '$1https://example.invalid/other.user.js'));
  const { baseUrl } = await startServer(t, serveBytes(altered));
  const result = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.equal(body.targets[0].directives.updateURL, 'https://example.invalid/other.user.js');
  assert.equal(body.targets[0].directives.downloadURL, CONFIG.downloadURL);
  assert.ok(body.targets[0].failures.includes('directive-mismatch:updateURL'), `failures: ${body.targets[0].failures}`);
  assert.ok(!body.targets[0].failures.includes('directive-mismatch:downloadURL'));
});

test('malformed response without a userscript header fails with header-missing', async (t) => {
  const { baseUrl } = await startServer(t, serveBytes(`<!doctype html><html>${SECRET_MARKER}</html>`));
  const result = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.ok(body.targets[0].failures.includes('header-missing'), `failures: ${body.targets[0].failures}`);
  assert.equal(body.targets[0].version, null);
  assert.equal(body.targets[0].directives, null);
  assertNoBodyLeak(result);
});

test('hung server is bounded by the timeout and exits nonzero without hanging', async (t) => {
  const { baseUrl } = await startServer(t, () => {});
  const startedAt = Date.now();
  const result = await runCli(['--timeout-ms', '400'], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null, 'the verifier must exit on its own, not be killed by the spawn timeout');
  assert.ok(elapsed < 15000, `timeout must be bounded, took ${elapsed}ms`);
  const body = parseOutput(result);
  assert.equal(body.targets[0].status, null);
  assert.ok(body.targets[0].failures.includes('timeout'), `failures: ${body.targets[0].failures}`);
});

test('oversized response is rejected without buffering or printing the body', async (t) => {
  const { baseUrl } = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    const chunk = Buffer.from(`${SECRET_MARKER}\n`.repeat(64));
    for (let index = 0; index < 64; index += 1) res.write(chunk);
    res.end();
  });
  const result = await runCli(['--max-bytes', '4096'], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.equal(body.targets[0].status, 200);
  assert.ok(body.targets[0].failures.includes('body-too-large'), `failures: ${body.targets[0].failures}`);
  assertNoBodyLeak(result);
});

test('two identical runs emit byte-identical deterministic JSON', async (t) => {
  const { baseUrl } = await startServer(t, serveBytes(DIST_BYTES));
  const first = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  const second = await runCli([], { TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, 'verifier output must not carry timestamps, ports, or run identity');
});

test('stale local sidecar fails closed before any network request', async (t) => {
  const root = fixtureRoot(t, { sidecar: `${'0'.repeat(64)}  dist/${DIST_BASENAME}\n` });
  const { baseUrl, state } = await startServer(t, serveBytes(`${SECRET_MARKER}`));
  const result = await runCli(['--root', root, '--base-url', baseUrl]);
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.ok(body.failures.includes('local-sidecar-mismatch'), `failures: ${body.failures}`);
  assert.deepEqual(body.targets, []);
  assert.equal(state.requests, 0, 'local preflight failure must not touch the network');
  assertNoBodyLeak(result);
});

test('local header/config URL drift fails closed before any network request', async (t) => {
  const config = { ...CONFIG, updateURL: 'https://example.invalid/other.user.js' };
  const root = fixtureRoot(t, { config });
  const { baseUrl, state } = await startServer(t, serveBytes(DIST_BYTES));
  const result = await runCli([], { TAA_ROOT: root, TAA_UPDATE_CHANNEL_BASE_URL: baseUrl });
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.ok(body.failures.includes('local-directive-mismatch:updateURL'), `failures: ${body.failures}`);
  assert.deepEqual(body.targets, []);
  assert.equal(state.requests, 0);
});

test('missing configured URL fails closed as malformed local input', async (t) => {
  const config = { ...CONFIG };
  delete config.updateURL;
  const root = fixtureRoot(t, { config });
  const { baseUrl, state } = await startServer(t, serveBytes(DIST_BYTES));
  const result = await runCli(['--root', root, '--base-url', baseUrl]);
  assert.notEqual(result.status, 0);
  const body = parseOutput(result);
  assert.ok(body.failures.includes('local-directive-missing:updateURL'), `failures: ${body.failures}`);
  assert.equal(state.requests, 0);
});

test('programmatic API reports per-target status, SHA-256, version and directives', async (t) => {
  const { verifyUpdateChannel } = require(TOOL);
  const { baseUrl } = await startServer(t, serveBytes(DIST_BYTES));
  const result = await verifyUpdateChannel({ baseUrl, timeoutMs: 5000, maxBytes: 1024 * 1024 });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.transport, 'loopback');
  assert.equal(result.targets[0].status, 200);
  assert.equal(result.targets[0].sha256, sha256(DIST_BYTES));
  assert.equal(result.targets[0].version, PKG.version);
  assert.deepEqual(result.targets[0].directives, { updateURL: CONFIG.updateURL, downloadURL: CONFIG.downloadURL });
});

test('verifier is read-only: the fixture root is byte-identical after a PASS run', async (t) => {
  const root = fixtureRoot(t);
  const before = snapshotTree(root);
  const { baseUrl } = await startServer(t, serveBytes(DIST_BYTES));
  const result = await runCli(['--root', root, '--base-url', baseUrl]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshotTree(root), before, 'the verifier must not write into the verified root');
});
