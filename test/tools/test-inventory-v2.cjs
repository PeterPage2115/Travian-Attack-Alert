'use strict';

// test-inventory-v2: versioned replacement for the frozen v1 verifier.
//
// v1 (test/tools/test-inventory.cjs) remains byte-identical and auditable for
// the historical contract. v2 delegates discovery and basic validation to v1,
// then closes the confirmed relocation bypass (docs/CODE-REVIEW.md item 7):
// a relocation could swap a 16-execution suite for an unrelated 1-execution
// suite and still report PASS with 934 of 949 executions.
//
// v2 requires every relocation to preserve, exactly:
//   - suite classification
//   - coverage labels (set equality)
//   - expected execution count
// and rejects missing, ambiguous, chained, or many-to-one relocation mappings.
// Any declared manifest `totals`/`byClassification` must match recomputed values.
//
// Task 18 extension: the manifest declaring a characterization suite is NOT
// execution proof. v2 consumes the receipt directory produced by
// `tools/run-characterization.cjs` and fails closed unless every manifest-owned
// `test/characterization/*.test.cjs` suite has exactly one HEAD/tree/worktree-
// bound receipt proving a non-skipped run at or above the declared execution
// floor with the exact canonical command and a zero exit status.

const fs = require('node:fs');
const path = require('node:path');

const v1 = require('./test-inventory.cjs');
const runner = require('../../tools/run-characterization.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASELINE = path.join(ROOT, 'test', 'fixtures', 'contracts', 'test-suite-baseline.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'test', 'fixtures', 'contracts', 'test-suite-manifest.json');
const DEFAULT_RECEIPT_DIR = runner.DEFAULT_RECEIPT_DIR;

function fail(message) {
  throw new Error(`test-inventory-v2: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// v1.verifyInventory has already validated both documents structurally, so this
// only indexes them for the v2 comparisons.
function indexSuites(document) {
  const byId = new Map();
  const byPath = new Map();
  for (const suite of document.suites) {
    byId.set(suite.id, suite);
    byPath.set(suite.path, suite);
  }
  return { byId, byPath };
}

function sortedCoverage(suite) {
  return [...suite.coverage].sort();
}

function compareRelocation(baselineSuite, targetSuite, relocation) {
  const problems = [];
  if (targetSuite.classification !== baselineSuite.classification) {
    problems.push(`classification mismatch for ${relocation.baselineId}: ${baselineSuite.classification} -> ${targetSuite.classification}`);
  }
  if (targetSuite.expectedExecutionCount !== baselineSuite.expectedExecutionCount) {
    problems.push(`execution count mismatch for ${relocation.baselineId}: ${baselineSuite.expectedExecutionCount} -> ${targetSuite.expectedExecutionCount}`);
  }
  const expected = sortedCoverage(baselineSuite);
  const actual = sortedCoverage(targetSuite);
  if (expected.length !== actual.length || expected.some((label, index) => label !== actual[index])) {
    const missing = expected.filter(label => !actual.includes(label));
    const added = actual.filter(label => !expected.includes(label));
    problems.push(`coverage mismatch for ${relocation.baselineId}: missing [${missing.join(', ')}] added [${added.join(', ')}]`);
  }
  return problems;
}

function recomputeTotals(suites) {
  const byClassification = {};
  let expectedExecutionCount = 0;
  for (const suite of suites) {
    expectedExecutionCount += suite.expectedExecutionCount;
    if (!byClassification[suite.classification]) byClassification[suite.classification] = { suiteCount: 0, expectedExecutionCount: 0 };
    byClassification[suite.classification].suiteCount += 1;
    byClassification[suite.classification].expectedExecutionCount += suite.expectedExecutionCount;
  }
  return { suiteCount: suites.length, expectedExecutionCount, byClassification };
}

function compareDeclaredTotals(declared, recomputed) {
  const problems = [];
  if (!declared || typeof declared !== 'object') return ['declared totals are not an object'];
  if (declared.suiteCount !== recomputed.suiteCount) {
    problems.push(`totals.suiteCount mismatch: declared ${declared.suiteCount} recomputed ${recomputed.suiteCount}`);
  }
  if (declared.expectedExecutionCount !== recomputed.expectedExecutionCount) {
    problems.push(`totals.expectedExecutionCount mismatch: declared ${declared.expectedExecutionCount} recomputed ${recomputed.expectedExecutionCount}`);
  }
  if (declared.byClassification !== undefined) {
    if (!declared.byClassification || typeof declared.byClassification !== 'object') {
      problems.push('totals.byClassification is not an object');
      return problems;
    }
    const classes = new Set([...Object.keys(declared.byClassification), ...Object.keys(recomputed.byClassification)]);
    for (const classification of [...classes].sort()) {
      const declaredBucket = declared.byClassification[classification];
      const actualBucket = recomputed.byClassification[classification];
      if (!actualBucket) {
        problems.push(`totals.byClassification.${classification} declared but no suite is recomputed for it`);
        continue;
      }
      if (!declaredBucket) {
        problems.push(`totals.byClassification.${classification} missing: recomputed ${actualBucket.suiteCount} suites/${actualBucket.expectedExecutionCount} executions`);
        continue;
      }
      if (declaredBucket.suiteCount !== actualBucket.suiteCount) {
        problems.push(`totals.byClassification.${classification}.suiteCount mismatch: declared ${declaredBucket.suiteCount} recomputed ${actualBucket.suiteCount}`);
      }
      if (declaredBucket.expectedExecutionCount !== actualBucket.expectedExecutionCount) {
        problems.push(`totals.byClassification.${classification}.expectedExecutionCount mismatch: declared ${declaredBucket.expectedExecutionCount} recomputed ${actualBucket.expectedExecutionCount}`);
      }
    }
  }
  return problems;
}

// Receipt-backed accounting (Task 18). The receipt directory is the only
// accepted execution proof: a missing suite, an unreadable or partially
// written receipt, a count below the manifest expectation, a skipped-only
// suite, a duplicate suite/path receipt, a stale HEAD/tree/worktree binding,
// a command mismatch, a nonzero exit, or a receipt for an unowned path is a
// hard failure. There is no "registration-only" pass.
//
// FINDING 6 (Qodo, High): each counter being a non-negative integer is not
// enough. The TAP terminal outcomes must reconcile with the declared total
// (`tests === passed + failed + cancelled + skipped + todo`) and with the
// achieved non-skipped count (`achievedNonSkipped === passed + failed`).
// Without those invariants a receipt can declare `counts.tests = 1` yet claim
// enough `passed` to satisfy the manifest floor. Accounting is checked before
// any manifest comparison and rejects with a typed, named reason.
function hex(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value);
}

function receiptAccountingProblems(receipt) {
  const counts = receipt.counts;
  const keys = ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
  if (!counts || typeof counts !== 'object' || keys.some(key => !Number.isInteger(counts[key]) || counts[key] < 0)) return [];
  const problems = [];
  const outcomes = counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo;
  if (counts.tests !== outcomes) {
    problems.push(`counts.tests ${counts.tests} != passed+failed+cancelled+skipped+todo ${outcomes}`);
  }
  if (receipt.achievedNonSkipped !== counts.passed + counts.failed) {
    problems.push(`achievedNonSkipped ${receipt.achievedNonSkipped} != passed+failed ${counts.passed + counts.failed}`);
  }
  return problems;
}

function validateReceiptShape(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt is not an object'];
  const problems = [];
  if (receipt.schemaVersion !== runner.RECEIPT_SCHEMA_VERSION) problems.push(`schemaVersion ${receipt.schemaVersion}`);
  if (typeof receipt.suitePath !== 'string' || !receipt.suitePath) problems.push('suitePath');
  if (typeof receipt.suiteId !== 'string' || !receipt.suiteId) problems.push('suiteId');
  if (!Number.isInteger(receipt.expectedExecutionCount) || receipt.expectedExecutionCount < 1) problems.push('expectedExecutionCount');
  if (!hex(receipt.head, 40)) problems.push('head');
  if (!hex(receipt.tree, 40)) problems.push('tree');
  if (!hex(receipt.worktreeDigest, 64)) problems.push('worktreeDigest');
  if (typeof receipt.command !== 'string' || !receipt.command) problems.push('command');
  if (!Array.isArray(receipt.argv) || receipt.argv.some(item => typeof item !== 'string')) problems.push('argv');
  if (!Number.isInteger(receipt.exitCode) && receipt.exitCode !== null) problems.push('exitCode');
  if (typeof receipt.timedOut !== 'boolean') problems.push('timedOut');
  if (receipt.signal !== null && typeof receipt.signal !== 'string') problems.push('signal');
  if (!receipt.counts || typeof receipt.counts !== 'object') problems.push('counts');
  else {
    for (const key of ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled']) {
      if (!Number.isInteger(receipt.counts[key]) || receipt.counts[key] < 0) problems.push(`counts.${key}`);
    }
  }
  if (!Number.isInteger(receipt.achievedNonSkipped) || receipt.achievedNonSkipped < 0) problems.push('achievedNonSkipped');
  if (typeof receipt.ok !== 'boolean') problems.push('ok');
  if (!hex(receipt.tapSha256, 64)) problems.push('tapSha256');
  return problems;
}

function compareReceipt(suite, receipt, name, binding) {
  const problems = [];
  if (receipt.suiteId !== suite.id) problems.push(`suite id mismatch for ${suite.path}: receipt ${receipt.suiteId}`);
  if (receipt.expectedExecutionCount !== suite.expectedExecutionCount) {
    problems.push(`expectation mismatch for ${suite.path}: receipt ${receipt.expectedExecutionCount} manifest ${suite.expectedExecutionCount}`);
  }
  if (receipt.command !== runner.commandFor(suite.path)) problems.push(`command mismatch for ${suite.path}: ${receipt.command}`);
  if (receipt.head !== binding.head) problems.push(`stale head binding for ${suite.path}: receipt ${receipt.head} current ${binding.head}`);
  if (receipt.tree !== binding.tree) problems.push(`stale tree binding for ${suite.path}: receipt ${receipt.tree} current ${binding.tree}`);
  if (receipt.worktreeDigest !== binding.worktreeDigest) {
    problems.push(`stale worktree binding for ${suite.path}: receipt ${receipt.worktreeDigest} current ${binding.worktreeDigest}`);
  }
  if (receipt.timedOut !== false) problems.push(`timed out suite: ${suite.path}`);
  if (receipt.exitCode !== 0) problems.push(`nonzero exit for ${suite.path}: ${receipt.exitCode}`);
  if (receipt.signal !== null) problems.push(`killed suite: ${suite.path} signal ${receipt.signal}`);
  if (receipt.counts.failed !== 0) problems.push(`failed tests for ${suite.path}: ${receipt.counts.failed}`);
  if (receipt.counts.passed === 0) problems.push(`skipped-only suite: ${suite.path} (passed 0, skipped ${receipt.counts.skipped})`);
  if (receipt.achievedNonSkipped !== receipt.counts.passed + receipt.counts.failed) {
    problems.push(`inconsistent receipt ${name}: achievedNonSkipped ${receipt.achievedNonSkipped} != passed+failed ${receipt.counts.passed + receipt.counts.failed}`);
  }
  if (receipt.achievedNonSkipped < suite.expectedExecutionCount) {
    problems.push(`count below expectation for ${suite.path}: achieved ${receipt.achievedNonSkipped} < declared ${suite.expectedExecutionCount}`);
  }
  if (receipt.ok !== true) problems.push(`receipt not ok: ${name}`);
  return problems;
}

function validateReceipts({ receiptDir, suites, binding }) {
  const problems = [];
  const expected = new Map(suites.map(suite => [suite.path, suite]));
  const seen = new Map();
  let files;
  try {
    files = fs.readdirSync(receiptDir).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    for (const suitePath of expected.keys()) problems.push(`missing receipt: ${suitePath} (receipt dir unreadable: ${error.message})`);
    return problems;
  }
  for (const name of files) {
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, name), 'utf8'));
    } catch (error) {
      problems.push(`unreadable receipt ${name}: ${error.message}`);
      continue;
    }
    const shape = validateReceiptShape(receipt);
    if (shape.length > 0) {
      problems.push(`partial receipt ${name}: invalid ${shape.join(', ')}`);
      continue;
    }
    const accounting = receiptAccountingProblems(receipt);
    if (accounting.length > 0) {
      problems.push(`inconsistent receipt ${name}: ${accounting.join('; ')}`);
      continue;
    }
    if (!expected.has(receipt.suitePath)) {
      problems.push(`unowned path receipt: ${name} claims ${receipt.suitePath}`);
      continue;
    }
    if (name !== runner.receiptFileName(receipt.suitePath)) {
      problems.push(`receipt path mismatch: ${name} does not match suite path ${receipt.suitePath}`);
    }
    if (seen.has(receipt.suitePath)) {
      problems.push(`duplicate receipt for ${receipt.suitePath}: ${seen.get(receipt.suitePath)}, ${name}`);
    } else {
      seen.set(receipt.suitePath, name);
    }
    problems.push(...compareReceipt(expected.get(receipt.suitePath), receipt, name, binding));
  }
  for (const suitePath of expected.keys()) {
    if (!seen.has(suitePath)) problems.push(`missing receipt: ${suitePath}`);
  }
  return problems;
}

function verifyInventory(options = {}) {
  const discovered = options.discovered === undefined ? v1.discoverSuites() : options.discovered;
  const basic = v1.verifyInventory({ ...options, discovered });

  const baseline = options.baseline;
  const manifest = options.manifest;
  const base = indexSuites(baseline);
  const current = indexSuites(manifest);
  const relocations = Array.isArray(manifest.relocations) ? manifest.relocations : [];
  const problems = [];

  const relocationByBaseline = new Map();
  const targetCounts = new Map();
  const sourceCounts = new Map();
  for (const relocation of relocations) {
    relocationByBaseline.set(relocation.baselineId, relocation);
    targetCounts.set(relocation.to, (targetCounts.get(relocation.to) || 0) + 1);
    sourceCounts.set(relocation.from, (sourceCounts.get(relocation.from) || 0) + 1);
  }

  for (const relocation of relocations) {
    const baselineSuite = base.byId.get(relocation.baselineId);
    if (!baselineSuite) {
      problems.push(`unknown relocation baselineId ${relocation.baselineId}`);
      continue;
    }
    if (relocation.from !== baselineSuite.path) {
      problems.push(`relocation source mismatch for ${relocation.baselineId}: declared ${relocation.from} but baseline path is ${baselineSuite.path}`);
    }
    if (relocation.from === relocation.to) {
      problems.push(`relocation for ${relocation.baselineId} does not move (from === to)`);
    }
    const retained = current.byId.get(relocation.baselineId);
    if (retained && retained.path === relocation.from) {
      problems.push(`ambiguous relocation: ${relocation.baselineId} is retained at ${relocation.from} and did not move`);
    }
    if ((targetCounts.get(relocation.to) || 0) > 1) {
      problems.push(`many-to-one relocation: ${relocation.to} is the target of ${targetCounts.get(relocation.to)} relocations`);
    }
    if ((sourceCounts.get(relocation.from) || 0) > 1) {
      problems.push(`ambiguous relocation source: ${relocation.from} is declared by ${sourceCounts.get(relocation.from)} relocations`);
    }
    if (sourceCounts.has(relocation.to)) {
      problems.push(`chained relocation: ${relocation.to} is both a relocation target and a relocation source`);
    }
    const targetSuite = current.byPath.get(relocation.to);
    if (!targetSuite) {
      problems.push(`relocation target does not exist: ${relocation.to}`);
      continue;
    }
    const targetBaselineSuite = base.byPath.get(relocation.to);
    if (targetBaselineSuite && targetBaselineSuite.id !== relocation.baselineId) {
      const targetRetained = current.byId.get(targetBaselineSuite.id);
      if (targetRetained && targetRetained.path === relocation.to) {
        problems.push(`ambiguous relocation: target ${relocation.to} is retained by baseline suite ${targetBaselineSuite.id}`);
      }
    }
    problems.push(...compareRelocation(baselineSuite, targetSuite, relocation));
  }

  for (const [id, baselineSuite] of base.byId) {
    const retained = current.byId.get(id);
    if (!retained) continue; // v1 already required a usable relocation for non-retained ids.
    // Classification equality is enforced on relocations only. The frozen
    // baseline predates two accepted historical reclassifications of retained
    // suites (test/fixtures/performance/server.test.cjs offline ->
    // source-artifact, test/runtime-parity.test.cjs dist-artifact ->
    // source-artifact) that v1 deliberately tolerates; v2 does not re-adjudicate
    // those. Retained suites keep v1's execution-count floor and coverage
    // superset rules.
    if (retained.path !== baselineSuite.path) {
      const relocation = relocationByBaseline.get(id);
      if (relocation && relocation.to !== retained.path) {
        problems.push(`relocation target mismatch for ${id}: declared ${relocation.to} but retained path is ${retained.path}`);
      }
    }
  }

  const recomputedTotals = recomputeTotals(manifest.suites);
  if (manifest.totals !== undefined) {
    problems.push(...compareDeclaredTotals(manifest.totals, recomputedTotals));
  }

  const characterization = manifest.suites.filter(suite => runner.isCharacterizationPath(suite.path));
  if (characterization.length > 0) {
    const receiptDir = options.receiptDir === undefined ? DEFAULT_RECEIPT_DIR : options.receiptDir;
    const binding = options.head && options.tree && options.worktreeDigest
      ? { head: options.head, tree: options.tree, worktreeDigest: options.worktreeDigest }
      : runner.currentBinding();
    problems.push(...validateReceipts({ receiptDir, suites: characterization, binding }));
  }

  if (problems.length > 0) fail(problems.join('; '));

  return {
    verdict: 'PASS',
    suites: basic.suites,
    expectedExecutions: basic.expectedExecutions,
    relocations: relocations.length,
    receiptBackedSuites: characterization.length,
    totals: recomputedTotals,
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

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const key of Object.keys(args)) {
      if (key !== 'baseline' && key !== 'manifest' && key !== 'receipt-dir') fail(`unsupported argument --${key}`);
    }
    if (!args['receipt-dir']) fail('--receipt-dir is required: inventory validation is receipt-backed');
    const result = verifyInventory({
      baseline: readJson(path.resolve(args.baseline || DEFAULT_BASELINE)),
      manifest: readJson(path.resolve(args.manifest || DEFAULT_MANIFEST)),
      receiptDir: path.resolve(args['receipt-dir']),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { discoverSuites: v1.discoverSuites, receiptAccountingProblems, validateReceipts, verifyInventory };
