'use strict';

// Type ratchet: `tsc --noEmit` must report no diagnostics outside the
// machine-readable legacy baseline, and no legacy category may grow.
//
// Baseline: test/fixtures/contracts/type-error-baseline.json
//   - every error in a file with no baseline entry => FAIL (zero tolerance,
//     covers new modules and every tools/ file);
//   - every error that matches no baseline (file, code, pattern) category
//     => FAIL (new diagnostic class);
//   - every category whose actual count exceeds the baselined count => FAIL
//     (regression inside the legacy monolith).
// Decreases pass silently (debt paid down); the baseline is then stale-high,
// which reviewers reconcile from this tool's machine-readable report.
// A missing or malformed baseline, or a tsc launch failure/timeout, fails
// closed. Exit 0 IFF the ratchet holds.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BASELINE_REL = path.join('test', 'fixtures', 'contracts', 'type-error-baseline.json');
const TSC_TIMEOUT_MS = 120_000;

function loadBaseline() {
  const absolute = path.join(ROOT, BASELINE_REL);
  if (!fs.existsSync(absolute)) throw new Error(`type ratchet failed: baseline is missing: ${BASELINE_REL}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`type ratchet failed: baseline is malformed: ${BASELINE_REL}: ${error.message}`);
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.legacy) || parsed.legacy.length < 1) {
    throw new Error(`type ratchet failed: baseline schema drift: ${BASELINE_REL}`);
  }
  for (const entry of parsed.legacy) {
    if (typeof entry.file !== 'string' || typeof entry.code !== 'string' || typeof entry.pattern !== 'string' || !Number.isInteger(entry.count) || entry.count < 0) {
      throw new Error(`type ratchet failed: baseline entry is malformed: ${JSON.stringify(entry)}`);
    }
  }
  return parsed;
}

function runTsc() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error('type ratchet failed: typescript compiler is missing (run npm ci)');
  const result = spawnSync(process.execPath, [tsc, '--noEmit'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: TSC_TIMEOUT_MS,
  });
  if (result.error) throw new Error(`type ratchet failed: tsc did not run: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    throw new Error(`type ratchet failed: tsc crashed with exit ${result.status}`);
  }
  return { status: result.status, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

const DIAGNOSTIC_RE = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

// Global/compiler-level failures carry no file(line,col) position, so the
// baseline ratchet would otherwise see zero parsed diagnostics and report
// PASS with actualTotal:0. Any nonzero compiler result with an unparsed
// diagnostic (TS18003 no inputs, TS5xxx config errors), or with empty
// output, must fail closed with a typed reason.
function detectGlobalFailure(output, status) {
  if (status === 0) return null;
  const unparsed = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (DIAGNOSTIC_RE.test(line)) continue;
    if (/error\s+TS\d+/i.test(line) || /no inputs were found/i.test(line)) {
      unparsed.push(line.trim().slice(0, 200));
    }
  }
  if (unparsed.length > 0) return { reason: 'compiler-global-failure', detail: unparsed };
  if (output.trim() === '') return { reason: 'compiler-empty-output', detail: [] };
  return null;
}

function parseDiagnostics(output) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(line);
    if (!match) continue;
    const absolute = path.resolve(ROOT, match[1].trim());
    diagnostics.push({
      file: path.relative(ROOT, absolute).split(path.sep).join('/'),
      line: Number(match[2]),
      code: match[4],
      message: match[5],
    });
  }
  return diagnostics;
}

function check() {
  const baseline = loadBaseline();
  const { status, output } = runTsc();
  const globalFailure = detectGlobalFailure(output, status);
  const diagnostics = parseDiagnostics(output);
  const failures = [];
  if (globalFailure) {
    const sample = globalFailure.detail.slice(0, 3).join('; ');
    failures.push(
      `${globalFailure.reason}: tsc exited ${status} with ${globalFailure.detail.length} unparsed compiler error(s)${sample ? `: ${sample}` : ' and no output'}`,
    );
  }
  const byCategory = baseline.legacy.map((entry) => ({ entry, actual: 0 }));
  const baselinedFiles = new Set(baseline.legacy.map((entry) => entry.file));
  const unmatched = [];
  for (const diagnostic of diagnostics) {
    if (!baselinedFiles.has(diagnostic.file)) {
      unmatched.push(`${diagnostic.file}(${diagnostic.line}): ${diagnostic.code}: zero-tolerance violation outside baseline`);
      continue;
    }
    const slot = byCategory.find(
      (item) => item.entry.file === diagnostic.file && item.entry.code === diagnostic.code && diagnostic.message.includes(item.entry.pattern),
    );
    if (!slot) {
      unmatched.push(`${diagnostic.file}(${diagnostic.line}): ${diagnostic.code}: ${diagnostic.message.slice(0, 120)}`);
      continue;
    }
    slot.actual += 1;
  }
  if (unmatched.length) {
    failures.push(`${unmatched.length} diagnostic(s) outside the legacy baseline: ${unmatched.slice(0, 5).join('; ')}${unmatched.length > 5 ? '; ...' : ''}`);
  }
  for (const { entry, actual } of byCategory) {
    if (actual > entry.count) {
      failures.push(`legacy budget exceeded: ${entry.file} ${entry.code} '${entry.label || entry.pattern}' actual ${actual} > baseline ${entry.count}`);
    }
  }
  const categories = byCategory.map(({ entry, actual }) => ({ label: entry.label || null, file: entry.file, code: entry.code, pattern: entry.pattern, baseline: entry.count, actual }));
  const summary = {
    schemaVersion: 1,
    baseline: BASELINE_REL.split(path.sep).join('/'),
    baselineTotal: baseline.legacy.reduce((sum, entry) => sum + entry.count, 0),
    actualTotal: diagnostics.length,
    categories,
    verdict: failures.length ? 'FAIL' : 'PASS',
    reason: failures.length ? (globalFailure ? globalFailure.reason : 'baseline-exceeded') : null,
  };
  if (failures.length) {
    process.stderr.write(`type ratchet failed: ${failures.join('; ')}\n`);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) check();
module.exports = { check, parseDiagnostics, detectGlobalFailure };
