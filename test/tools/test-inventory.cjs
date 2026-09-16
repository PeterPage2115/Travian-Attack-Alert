'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLASSES = new Set(['offline', 'source-artifact', 'dist-artifact', 'browser', 'tool']);

function fail(message) {
  throw new Error(`test-inventory: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else output.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
  }
  return output;
}

function discoverSuites(root = ROOT) {
  const testRoot = path.join(root, 'test');
  return walk(testRoot)
    .filter(file => /\.test\.[^.]+$/u.test(file) || /^test\/e2e\/[^/]+\.spec\.ts$/u.test(file))
    .sort();
}

function suiteMap(document, label) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.suites)) fail(`${label} has an unsupported schema`);
  const byId = new Map();
  const byPath = new Map();
  for (const suite of document.suites) {
    if (!suite || typeof suite.id !== 'string' || !suite.id) fail(`${label} contains an invalid suite id`);
    if (byId.has(suite.id)) fail(`${label} contains duplicate suite id ${suite.id}`);
    if (typeof suite.path !== 'string' || path.isAbsolute(suite.path) || suite.path.includes('..')) fail(`${label} contains unsafe path ${suite.path}`);
    if (byPath.has(suite.path)) fail(`${label} contains duplicate suite path ${suite.path}`);
    if (!CLASSES.has(suite.classification)) fail(`${label} contains invalid classification for ${suite.id}`);
    if (!Number.isInteger(suite.expectedExecutionCount) || suite.expectedExecutionCount < 1) fail(`${label} contains invalid execution count for ${suite.id}`);
    if (!Array.isArray(suite.coverage) || suite.coverage.length < 1 || suite.coverage.some(item => typeof item !== 'string' || !item)) fail(`${label} contains invalid coverage for ${suite.id}`);
    byId.set(suite.id, suite);
    byPath.set(suite.path, suite);
  }
  return { byId, byPath };
}

function verifyInventory({ baseline, manifest, discovered = discoverSuites(), oracleSha256, verifierHashes } = {}) {
  const base = suiteMap(baseline, 'baseline');
  const current = suiteMap(manifest, 'manifest');
  const found = [...discovered].sort();
  if (found.length !== current.byPath.size) fail(`discovered ${found.length} suites but manifest reports ${current.byPath.size}`);
  for (const file of found) if (!current.byPath.has(file)) fail(`suite is not reported: ${file}`);
  for (const file of current.byPath.keys()) if (!found.includes(file)) fail(`manifest path does not exist: ${file}`);
  if (![...current.byPath.keys()].includes('test/runtime-parity.test.cjs')) fail('missing runtime parity suite');

  const relocations = Array.isArray(manifest.relocations) ? manifest.relocations : [];
  const relocationByBaseline = new Map();
  for (const relocation of relocations) {
    if (!relocation || typeof relocation.baselineId !== 'string' || typeof relocation.from !== 'string' || typeof relocation.to !== 'string') fail('invalid relocation');
    if (relocationByBaseline.has(relocation.baselineId)) fail(`duplicate relocation for ${relocation.baselineId}`);
    relocationByBaseline.set(relocation.baselineId, relocation);
  }
  for (const [id, suite] of base.byId) {
    const retained = current.byId.get(id);
    if (retained) {
      if (retained.path !== suite.path && !relocationByBaseline.has(id)) fail(`missing relocation for ${id}`);
      if (retained.expectedExecutionCount < suite.expectedExecutionCount) fail(`coverage reduction for ${id}`);
      for (const behavior of suite.coverage) if (!retained.coverage.includes(behavior)) fail(`coverage reduction for ${id}: ${behavior}`);
      continue;
    }
    const relocation = relocationByBaseline.get(id);
    if (!relocation || relocation.from !== suite.path || !current.byPath.has(relocation.to)) fail(`baseline id is not retained: ${id}`);
  }
  const expectedOracleSha256 = oracleSha256 || baseline.behaviorOracleSha256;
  const expectedVerifierHashes = verifierHashes || baseline.verifierHashes;
  if (expectedOracleSha256 && manifest.behaviorOracleSha256 !== expectedOracleSha256) fail('changed behavior oracle digest');
  if (expectedVerifierHashes) {
    for (const [name, digest] of Object.entries(expectedVerifierHashes)) {
      if (manifest.verifierHashes?.[name] !== digest) fail(`changed verifier hash: ${name}`);
    }
  }
  return { verdict: 'PASS', suites: found.length, expectedExecutions: [...current.byId.values()].reduce((sum, suite) => sum + suite.expectedExecutionCount, 0) };
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
    if (!args.baseline || !args.manifest) fail('--baseline and --manifest are required');
    const result = verifyInventory({ baseline: readJson(path.resolve(args.baseline)), manifest: readJson(path.resolve(args.manifest)) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { discoverSuites, verifyInventory };
