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

const fs = require('node:fs');
const path = require('node:path');

const v1 = require('./test-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASELINE = path.join(ROOT, 'test', 'fixtures', 'contracts', 'test-suite-baseline.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'test', 'fixtures', 'contracts', 'test-suite-manifest.json');

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

  if (problems.length > 0) fail(problems.join('; '));

  return {
    verdict: 'PASS',
    suites: basic.suites,
    expectedExecutions: basic.expectedExecutions,
    relocations: relocations.length,
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
      if (key !== 'baseline' && key !== 'manifest') fail(`unsupported argument --${key}`);
    }
    const result = verifyInventory({
      baseline: readJson(path.resolve(args.baseline || DEFAULT_BASELINE)),
      manifest: readJson(path.resolve(args.manifest || DEFAULT_MANIFEST)),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { discoverSuites: v1.discoverSuites, verifyInventory };
