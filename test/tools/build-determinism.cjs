'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUTS = Object.freeze([
  'dist/travian-attack-alert.user.js',
  'dist/travian-attack-alert.user.js.sha256',
  'metadata.json',
  'module-manifest.json',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function snapshotOutputs(root) {
  return Object.fromEntries(OUTPUTS.map((relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`${relative} is missing; run npm run build`);
    const stat = fs.statSync(file, { bigint: true });
    return [relative, { sha256: sha256(fs.readFileSync(file)), mtimeNs: stat.mtimeNs.toString() }];
  }));
}

function assertByteIdentical(snapshots) {
  const expected = snapshots[0];
  for (const [runIndex, snapshot] of snapshots.entries()) {
    for (const relative of OUTPUTS) {
      if (snapshot[relative]?.sha256 !== expected[relative]?.sha256) {
        throw new Error(`${relative} differs in run ${runIndex + 1}`);
      }
    }
  }
}

function assertNoMtimeChurn(snapshots) {
  const expected = snapshots[0];
  for (const [runIndex, snapshot] of snapshots.entries()) {
    for (const relative of OUTPUTS) {
      if (snapshot[relative]?.mtimeNs !== expected[relative]?.mtimeNs) {
        throw new Error(`${relative} was rewritten in run ${runIndex + 1}`);
      }
    }
  }
}

function supportedNodeMajor(engine) {
  const match = /^>=\s*(\d+)$/u.exec(engine || '');
  if (!match) throw new Error(`unsupported package.json engines.node contract: ${engine ?? '<missing>'}`);
  return Number(match[1]);
}

function assertStableToolchain(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  const expectedMajor = supportedNodeMajor(packageJson.engines?.node);
  if (metadata.toolchain?.nodeMajor !== expectedMajor) {
    throw new Error(`metadata nodeMajor must be ${expectedMajor}, got ${metadata.toolchain?.nodeMajor ?? '<missing>'}`);
  }
  if (metadata.toolchain?.esbuild !== packageJson.devDependencies?.esbuild) {
    throw new Error('metadata esbuild must equal the package.json pin');
  }
}

function runCommand(root, args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TAA_ROOT: root },
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`.trim());
  }
  return result;
}

function runReadOnlyCommand(root, args) {
  const before = snapshotOutputs(root);
  runCommand(root, args);
  const after = snapshotOutputs(root);
  for (const relative of OUTPUTS) {
    if (JSON.stringify(after[relative]) !== JSON.stringify(before[relative])) {
      throw new Error(`${args.join(' ')} wrote generated output ${relative}`);
    }
  }
}

function parseArgs(argv) {
  const runsAt = argv.indexOf('--runs');
  const jsonAt = argv.indexOf('--json');
  const runs = runsAt >= 0 ? Number(argv[runsAt + 1]) : 2;
  if (!Number.isInteger(runs) || runs < 2) throw new Error('--runs must be an integer of at least 2');
  return { runs, output: jsonAt >= 0 ? path.resolve(argv[jsonAt + 1]) : null };
}

function verify(options) {
  const snapshots = [];
  for (let index = 0; index < options.runs; index += 1) {
    runCommand(ROOT, [process.execPath, path.join(ROOT, 'tools/build.cjs')]);
    snapshots.push(snapshotOutputs(ROOT));
  }
  assertByteIdentical(snapshots);
  assertNoMtimeChurn(snapshots);
  assertStableToolchain(ROOT);
  runReadOnlyCommand(ROOT, [process.execPath, path.join(ROOT, 'tools/check-artifact.cjs')]);
  runReadOnlyCommand(ROOT, [process.execPath, path.join(ROOT, 'tools/check-versions.cjs')]);
  return {
    schemaVersion: 1,
    runs: options.runs,
    outputs: Object.fromEntries(OUTPUTS.map(relative => [relative, snapshots[0][relative].sha256])),
    readOnlyChecks: ['check:artifact', 'check:versions'],
    verdict: 'PASS',
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = verify(options);
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OUTPUTS,
  assertByteIdentical,
  assertNoMtimeChurn,
  assertStableToolchain,
  runReadOnlyCommand,
  snapshotOutputs,
  supportedNodeMajor,
  verify,
};
