'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OUTPUTS,
  assertByteIdentical,
  assertNoMtimeChurn,
  assertStableToolchain,
  runReadOnlyCommand,
  snapshotOutputs,
} = require('./build-determinism.cjs');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-build-contract-'));
  fs.mkdirSync(path.join(root, 'dist'));
  for (const relative of OUTPUTS) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${relative}\n`);
  }
  return root;
}

test('Given equal output snapshots, when byte identity is checked, then all four outputs pass', () => {
  const root = fixtureRoot();
  try {
    const snapshot = snapshotOutputs(root);
    assert.doesNotThrow(() => assertByteIdentical([snapshot, structuredClone(snapshot)]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Given one rewritten output, when mtime stability is checked, then the rewrite is rejected', () => {
  const root = fixtureRoot();
  try {
    const before = snapshotOutputs(root);
    const after = structuredClone(before);
    after[OUTPUTS[0]].mtimeNs = String(BigInt(after[OUTPUTS[0]].mtimeNs) + 1n);
    assert.throws(() => assertNoMtimeChurn([before, after]), /was rewritten/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Given supported-major metadata, when toolchain stability is checked, then package pins are authoritative', () => {
  const root = fixtureRoot();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"engines":{"node":">=18"},"devDependencies":{"esbuild":"0.25.9"}}\n');
    fs.writeFileSync(path.join(root, 'metadata.json'), '{"toolchain":{"nodeMajor":18,"esbuild":"0.25.9"}}\n');
    assert.doesNotThrow(() => assertStableToolchain(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Given a check that rewrites metadata, when read-only behavior is checked, then the check is rejected', () => {
  const root = fixtureRoot();
  try {
    const writer = path.join(root, 'writer.cjs');
    fs.writeFileSync(writer, "const fs=require('node:fs');const p=require('node:path');const f=p.join(process.cwd(),'metadata.json');fs.writeFileSync(f,fs.readFileSync(f));\n");
    assert.throws(() => runReadOnlyCommand(root, [process.execPath, writer]), /wrote generated output/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
