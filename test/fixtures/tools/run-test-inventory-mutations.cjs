'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverSuites, verifyInventory } = require('../../tools/test-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BASELINE = path.join(ROOT, 'test/fixtures/contracts/test-suite-baseline.json');
const MANIFEST = path.join(ROOT, 'test/fixtures/contracts/test-suite-manifest.json');

function clone(value) { return structuredClone(value); }

const mutations = {
  'missing-runtime-parity'({ manifest }) {
    manifest.suites = manifest.suites.filter(suite => suite.path !== 'test/runtime-parity.test.cjs');
  },
  'duplicate-suite'({ manifest }) {
    manifest.suites.push(clone(manifest.suites[0]));
  },
  'changed-oracle'({ manifest }) {
    manifest.behaviorOracleSha256 = '0'.repeat(64);
  },
  'coverage-reduction'({ manifest }) {
    const suite = manifest.suites.find(item => item.path === 'test/runtime-parity.test.cjs');
    suite.expectedExecutionCount -= 1;
  },
  'missing-relocation'({ manifest, discovered }) {
    const suite = manifest.suites.find(item => item.path === 'test/tools/backup-rollback.test.cjs');
    const index = discovered.indexOf(suite.path);
    suite.path = 'test/tools/backup-rollback-relocated.test.cjs';
    discovered[index] = suite.path;
  },
  'changed-verifier-hash'({ manifest }) {
    const name = Object.keys(manifest.verifierHashes).sort()[0];
    manifest.verifierHashes[name] = 'f'.repeat(64);
  },
};

function parse(argv) {
  const casesAt = argv.indexOf('--cases'); const jsonAt = argv.indexOf('--json');
  return {
    cases: (casesAt >= 0 ? argv[casesAt + 1] : Object.keys(mutations).join(',')).split(',').filter(Boolean),
    output: jsonAt >= 0 ? path.resolve(argv[jsonAt + 1]) : null,
  };
}

function run(names) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const originalManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return names.map(name => {
    if (!mutations[name]) return { case: name, rejected: false, error: 'unknown mutation' };
    const input = { baseline: clone(baseline), manifest: clone(originalManifest), discovered: discoverSuites() };
    mutations[name](input);
    try {
      verifyInventory(input);
      return { case: name, rejected: false, error: 'mutation was accepted' };
    } catch (error) {
      return { case: name, rejected: true, error: error.message };
    }
  });
}

if (require.main === module) {
  const options = parse(process.argv.slice(2));
  const cases = run(options.cases);
  const result = { schemaVersion: 1, verdict: cases.every(item => item.rejected) ? 'PASS' : 'FAIL', rejected: cases.filter(item => item.rejected).length, total: cases.length, cases };
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

module.exports = { run };
