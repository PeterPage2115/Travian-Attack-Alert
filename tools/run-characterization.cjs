#!/usr/bin/env node
'use strict';

/**
 * Characterization suite runner with receipt-backed accounting (plan Task 18).
 *
 * The manifest (`test/fixtures/contracts/test-suite-manifest.json`) owns the
 * characterization suite paths (`test/characterization/*.test.cjs`). This
 * runner is the SOLE `test:characterization` entry point: it enumerates those
 * manifest-owned paths, invokes `node --test --test-reporter=tap` once per
 * suite, parses the TAP summary, and atomically writes one JSON receipt per
 * suite to `test-results/suite-receipts/<sha256(path)>.json`.
 *
 * Every receipt binds the achieved execution accounting to:
 *   - the exact suite path (and the manifest-declared expectation),
 *   - the exact repository HEAD and tree,
 *   - a digest of the dirty worktree inventory: each non-ignored modified,
 *     staged, or untracked path with its status AND the SHA-256 of its current
 *     bytes (so dirty bytes cannot be swapped between execution and
 *     verification without changing the binding),
 *   - the exact command string, exit status, and TAP-derived counts.
 *
 * `test/tools/test-inventory-v2.cjs --receipt-dir test-results/suite-receipts`
 * consumes these receipts and fails closed on missing, unreadable, partial,
 * below-expectation, skipped-only, duplicated, stale, mis-command, nonzero,
 * timed-out, or unowned receipts. Registration in the manifest alone is not
 * sufficient; the receipts are the execution proof.
 *
 * A suite that cannot execute (missing file, spawn error, timeout) still gets
 * a receipt so the failure is auditable, and the runner exits nonzero.
 *
 * No runtime dependencies: node:child_process + node:fs + node:crypto only.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'test', 'fixtures', 'contracts', 'test-suite-manifest.json');
const DEFAULT_RECEIPT_DIR = path.join(ROOT, 'test-results', 'suite-receipts');
const CHARACTERIZATION_PREFIX = 'test/characterization/';
const RECEIPT_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const RECEIPT_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;

function fail(message) {
  throw new Error(`run-characterization: ${message}`);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Single source of truth for the canonical per-suite command. The v2 inventory
// verifier imports these helpers so a receipt can never claim a command the
// runner would not have produced.
function commandFor(suitePath) {
  return `node --test --test-reporter=tap ${suitePath}`;
}

function argvFor(suitePath) {
  return ['node', '--test', '--test-reporter=tap', suitePath];
}

function receiptFileName(suitePath) {
  return `${sha256Hex(suitePath)}.json`;
}

function isCharacterizationPath(suitePath) {
  return typeof suitePath === 'string' && suitePath.startsWith(CHARACTERIZATION_PREFIX);
}

function gitBytes(args, root = ROOT) {
  const result = spawnSync('git', args, { cwd: root });
  if (result.error) fail(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} exited ${result.status}: ${String(result.stderr || '').trim()}`);
  return result.stdout;
}

function gitText(args, root = ROOT) {
  return gitBytes(args, root).toString('utf8');
}

// `git status --porcelain=v2 -z` record shapes (paths are NUL-terminated and
// never quoted in -z mode):
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//   ? <path>
function porcelainPath(record, fieldCount) {
  let offset = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const space = record.indexOf(' ', offset);
    if (space === -1) fail(`unexpected porcelain record: ${JSON.stringify(record)}`);
    offset = space + 1;
  }
  return record.slice(offset);
}

function parsePorcelainV2(buffer) {
  const records = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === '') continue;
    const kind = record[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const xy = record.slice(2, 4);
      const filePath = porcelainPath(record, kind === '1' ? 8 : kind === '2' ? 9 : 10);
      if (kind === '2') {
        const originalPath = records[index + 1];
        index += 1;
        entries.push({ status: `${xy} <- ${originalPath}`, path: filePath });
      } else {
        entries.push({ status: xy, path: filePath });
      }
    } else if (kind === '?') {
      entries.push({ status: '??', path: record.slice(2) });
    } else {
      fail(`unexpected porcelain record type ${JSON.stringify(kind)}`);
    }
  }
  return entries;
}

// Content digest of one dirty/untracked path. Missing (deleted) paths and
// special entries get deterministic markers so the digest stays stable across
// runs while still moving whenever the byte payload changes.
function fileByteDigest(root, filePath) {
  const absolute = path.join(root, filePath);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'deleted' : `unreadable:${(error && error.code) || 'error'}`;
  }
  if (stats.isSymbolicLink()) {
    try {
      return `symlink:${sha256Hex(fs.readlinkSync(absolute))}`;
    } catch (error) {
      return `unreadable:${(error && error.code) || 'error'}`;
    }
  }
  if (stats.isDirectory()) return 'directory';
  try {
    return sha256Hex(fs.readFileSync(absolute));
  } catch (error) {
    return `unreadable:${(error && error.code) || 'error'}`;
  }
}

// Deterministic inventory digest of every tracked modified/staged and
// untracked (non-ignored) path: status + path + SHA-256 of current bytes,
// sorted by the serialized entry. `--untracked-files=all` deliberately
// excludes ignored paths (test-results/), so writing receipts does not
// invalidate the binding it just recorded; a clean tree digests to sha256('').
function worktreeDigestFor(root = ROOT) {
  const status = gitBytes(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root);
  const inventory = parsePorcelainV2(status)
    .map(entry => `${entry.status}\u0000${entry.path}\u0000${fileByteDigest(root, entry.path)}`)
    .sort();
  return sha256Hex(inventory.join('\n'));
}

// Exact execution binding: HEAD + tree + content digest of the dirty set.
function currentBinding(root = ROOT) {
  const head = gitText(['rev-parse', 'HEAD'], root).trim();
  const tree = gitText(['rev-parse', 'HEAD^{tree}'], root).trim();
  return { head, tree, worktreeDigest: worktreeDigestFor(root) };
}

function readManifest(manifestPath) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest is unreadable: ${manifestPath}: ${error.message}`);
  }
  if (!document || !Array.isArray(document.suites)) fail(`manifest has no suites array: ${manifestPath}`);
  return document;
}

function characterizationSuites(document) {
  return document.suites
    .filter(suite => suite && isCharacterizationPath(suite.path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function parseTapCounts(tap) {
  const seen = {};
  for (const raw of String(tap).split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/u.exec(raw.trim());
    if (match) seen[match[1]] = Number(match[2]);
  }
  return {
    tests: seen.tests || 0,
    passed: seen.pass || 0,
    failed: seen.fail || 0,
    skipped: seen.skipped || 0,
    todo: seen.todo || 0,
    cancelled: seen.cancelled || 0,
  };
}

// Runs one suite in its own process group so a timeout can reap the whole
// `node --test` tree (the runner child plus any per-file worker), never leaving
// a hung suite behind to poison later gates.
function runSuite(suitePath, timeoutMs) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(process.execPath, argvFor(suitePath).slice(1), {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ startedAt, startedMs, exitCode, signal, spawnError, timedOut, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child already exited between the timer firing and the kill.
        }
      }
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(null, null, error));
    child.on('close', (exitCode, signal) => finish(exitCode, signal, null));
  });
}

function writeReceiptAtomic(receiptDir, suitePath, receipt) {
  const target = path.join(receiptDir, receiptFileName(suitePath));
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return target;
}

function clearStaleReceipts(receiptDir) {
  if (!fs.existsSync(receiptDir)) return;
  for (const name of fs.readdirSync(receiptDir)) {
    if (RECEIPT_FILE_PATTERN.test(name)) fs.rmSync(path.join(receiptDir, name));
  }
}

function buildReceipt({ suite, binding, result }) {
  const counts = parseTapCounts(result.stdout);
  const achievedNonSkipped = counts.passed + counts.failed;
  const spawnFailed = Boolean(result.spawnError);
  const ok = !spawnFailed
    && !result.timedOut
    && result.exitCode === 0
    && result.signal === null
    && counts.failed === 0
    && counts.cancelled === 0
    && counts.passed > 0
    && achievedNonSkipped >= suite.expectedExecutionCount;
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    suitePath: suite.path,
    suiteId: suite.id,
    classification: suite.classification,
    expectedExecutionCount: suite.expectedExecutionCount,
    head: binding.head,
    tree: binding.tree,
    worktreeDigest: binding.worktreeDigest,
    command: commandFor(suite.path),
    argv: argvFor(suite.path),
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    startedAt: result.startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - result.startedMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    error: spawnFailed ? `spawn failed: ${result.spawnError.message}` : null,
    counts,
    achievedNonSkipped,
    tapSha256: sha256Hex(result.stdout),
    ok,
  };
}

function missingSuiteResult(suitePath) {
  const startedAt = new Date().toISOString();
  return {
    startedAt,
    startedMs: Date.now(),
    exitCode: null,
    signal: null,
    spawnError: new Error(`suite file does not exist: ${suitePath}`),
    timedOut: false,
    stdout: '',
    stderr: '',
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) fail(`invalid argument ${key}`);
    result[key.slice(2)] = argv[++index];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of Object.keys(args)) {
    if (key !== 'manifest' && key !== 'receipt-dir' && key !== 'timeout-ms') fail(`unsupported argument --${key}`);
  }
  const manifestPath = path.resolve(args.manifest || DEFAULT_MANIFEST);
  const receiptDir = path.resolve(args['receipt-dir'] || DEFAULT_RECEIPT_DIR);
  const timeoutMs = args['timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(args['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail(`--timeout-ms must be a positive integer, got ${args['timeout-ms']}`);
  if (receiptDir === ROOT) fail('--receipt-dir must not be the repository root');

  const suites = characterizationSuites(readManifest(manifestPath));
  if (suites.length === 0) fail(`manifest declares no ${CHARACTERIZATION_PREFIX} suites: ${manifestPath}`);

  const binding = currentBinding();
  fs.mkdirSync(receiptDir, { recursive: true });
  clearStaleReceipts(receiptDir);

  let failures = 0;
  for (const suite of suites) {
    const suiteAbsolute = path.join(ROOT, suite.path);
    const result = fs.existsSync(suiteAbsolute)
      ? await runSuite(suite.path, timeoutMs)
      : missingSuiteResult(suite.path);
    const receipt = buildReceipt({ suite, binding, result });
    const target = writeReceiptAtomic(receiptDir, suite.path, receipt);
    if (!receipt.ok) failures += 1;
    const verdict = receipt.ok ? 'ok' : 'FAIL';
    console.log(
      `[${verdict}] ${suite.path} exit=${receipt.exitCode === null ? 'n/a' : receipt.exitCode}`
      + `${receipt.timedOut ? ' timedOut=true' : ''}`
      + ` passed=${receipt.counts.passed} failed=${receipt.counts.failed} skipped=${receipt.counts.skipped}`
      + ` achieved=${receipt.achievedNonSkipped} expected=${suite.expectedExecutionCount}`
      + ` durationMs=${receipt.durationMs} receipt=${path.relative(ROOT, target)}`,
    );
  }

  console.log(`characterization: ${suites.length - failures}/${suites.length} suites ok; receipts: ${path.relative(ROOT, receiptDir)}`);
  if (failures > 0) fail(`${failures} characterization suite(s) did not achieve a receipt-backed pass`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CHARACTERIZATION_PREFIX,
  DEFAULT_MANIFEST,
  DEFAULT_RECEIPT_DIR,
  RECEIPT_SCHEMA_VERSION,
  argvFor,
  characterizationSuites,
  commandFor,
  currentBinding,
  isCharacterizationPath,
  parseTapCounts,
  receiptFileName,
};
