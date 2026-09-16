'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  OUTPUTS,
  assertByteIdentical,
  assertStableToolchain,
  runReadOnlyCommand,
  snapshotOutputs,
} = require('../../tools/build-determinism.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-build-mutation-'));
  for (const relative of OUTPUTS) {
    const source = path.join(ROOT, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  return root;
}

const mutations = {
  'missing-manifest'(root) {
    fs.rmSync(path.join(root, 'module-manifest.json'));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/check-artifact.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TAA_ROOT: root },
    });
    if (result.status === 0 || !/run npm run build/u.test(`${result.stdout}${result.stderr}`)) {
      throw new Error('missing manifest was not rejected with the build hint');
    }
  },
  'check-writes-output'(root) {
    const writer = path.join(root, 'writer.cjs');
    fs.writeFileSync(writer, "const fs=require('node:fs');const f='metadata.json';fs.writeFileSync(f,fs.readFileSync(f));\n");
    assertRejected(() => runReadOnlyCommand(root, [process.execPath, writer]), /wrote generated output/u);
  },
  'node-major-drift'(root) {
    const metadataPath = path.join(root, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.toolchain = { ...metadata.toolchain, nodeMajor: 99 };
    delete metadata.toolchain.node;
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    assertRejected(() => assertStableToolchain(root), /nodeMajor/u);
  },
  'cross-node-output-difference'(root) {
    const first = snapshotOutputs(root);
    const second = structuredClone(first);
    second[OUTPUTS[0]].sha256 = '0'.repeat(64);
    assertRejected(() => assertByteIdentical([first, second]), /differs/u);
  },
};

function assertRejected(action, expression) {
  let error = null;
  try { action(); } catch (caught) { error = caught; }
  if (!error || !expression.test(error.message)) throw new Error('mutation was accepted');
}

function parse(argv) {
  const casesAt = argv.indexOf('--cases');
  const jsonAt = argv.indexOf('--json');
  return {
    cases: (casesAt >= 0 ? argv[casesAt + 1] : Object.keys(mutations).join(',')).split(',').filter(Boolean),
    output: jsonAt >= 0 ? path.resolve(argv[jsonAt + 1]) : null,
  };
}

function run(names) {
  return names.map((name) => {
    if (!mutations[name]) return { case: name, rejected: false, error: 'unknown mutation' };
    const root = tempRoot();
    try {
      mutations[name](root);
      return { case: name, rejected: true };
    } catch (error) {
      return { case: name, rejected: false, error: error.message };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

if (require.main === module) {
  const options = parse(process.argv.slice(2));
  const cases = run(options.cases);
  const result = {
    schemaVersion: 1,
    verdict: cases.every(item => item.rejected) ? 'PASS' : 'FAIL',
    rejected: cases.filter(item => item.rejected).length,
    total: cases.length,
    cases,
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

module.exports = { run };
