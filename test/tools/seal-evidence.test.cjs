'use strict';

// Task 6 evidence sealing contract.
//
// Proves that `tools/seal-evidence.cjs` freezes a complete evidence tree into
// ONE byte-deterministic ZIP outside the input tree, with a per-entry +
// archive SHA-256 manifest, refuses symlinks/non-regular entries without
// following them, and that the ZIP-recursive `--mode evidence` scanner accepts
// the sealed archive as its exact input. Also proves the adversarial cases the
// CI wiring relies on: post-scan archive mutation makes the digest recheck
// fail, post-seal source mutation cannot enter the sealed bytes, and
// secret/screenshot/trace evidence fails the scan (making upload ineligible).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildZip,
  readZipCentralDirectory,
  verifySealedArchive,
} = require('../../tools/seal-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SEAL_TOOL = path.join(ROOT, 'tools', 'seal-evidence.cjs');
const AUDITOR = path.join(ROOT, 'tools', 'audit-public-tree.cjs');
const SPAWN_TIMEOUT_MS = 180000;
// Assembled at runtime so this file never carries a literal webhook shape
// (the canonical self-audit scans test sources too).
const WEBHOOK = [['discord', 'com'].join('.'), 'api', 'webhooks', '123456789012345678', 'A'.repeat(32)].join('/');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTree(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

function runSeal(args) {
  return spawnSync(process.execPath, [SEAL_TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function runEvidenceScan(rootDir, reportPath) {
  return spawnSync(
    process.execPath,
    [AUDITOR, '--mode', 'evidence', '--root', rootDir, '--out', reportPath],
    { cwd: ROOT, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function centralDirectoryOffset(buffer) {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.readUInt32LE(i + 16);
  }
  throw new Error('end-of-central-directory record not found');
}

function writeManifest(file, doc) {
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function sealCleanFixture(t) {
  const fixture = tempRoot(t, 'taa-seal-clean-');
  const input = path.join(fixture, 'test-results');
  const staging = path.join(fixture, 'upload');
  writeTree(input, {
    'reports/summary.json': `${JSON.stringify({ verdict: 'PASS', specs: 2 })}\n`,
    'notes.txt': 'loopback e2e finished without findings\n',
    'nested/deep/data.bin': Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]),
  });
  const archive = path.join(staging, 'browser-evidence.zip');
  const manifest = path.join(fixture, 'browser-evidence.manifest.json');
  const seal = runSeal(['--input', input, '--archive', archive, '--manifest', manifest]);
  assert.equal(seal.status, 0, `seal must succeed: ${seal.stderr}`);
  return { fixture, input, staging, archive, manifest };
}

test('seal writes one deterministic ZIP + manifest outside the input tree', (t) => {
  const fixture = tempRoot(t, 'taa-seal-determinism-');
  const input = path.join(fixture, 'test-results');
  writeTree(input, {
    'z-last.txt': 'last\n',
    'a-first.txt': 'first\n',
    'nested/middle.bin': Buffer.from([1, 2, 3, 0, 255]),
  });
  const archiveA = path.join(fixture, 'out-a', 'evidence.zip');
  const archiveB = path.join(fixture, 'out-b', 'evidence.zip');
  const manifestA = path.join(fixture, 'out-a', 'evidence.manifest.json');
  const manifestB = path.join(fixture, 'out-b', 'evidence.manifest.json');

  assert.equal(runSeal(['--input', input, '--archive', archiveA, '--manifest', manifestA]).status, 0);
  assert.equal(runSeal(['--input', input, '--archive', archiveB, '--manifest', manifestB]).status, 0);

  const bytesA = fs.readFileSync(archiveA);
  const bytesB = fs.readFileSync(archiveB);
  assert.deepEqual(bytesA, bytesB, 'two seals of the same input must be byte-identical');
  assert.equal(fs.readFileSync(manifestA, 'utf8'), fs.readFileSync(manifestB, 'utf8'), 'manifest must be deterministic');

  const manifest = readJson(manifestA);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.archive, 'evidence.zip');
  assert.equal(manifest.archiveBytes, bytesA.length);
  assert.equal(manifest.archiveSha256, sha256(bytesA));
  assert.equal(manifest.entryCount, 3);
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['a-first.txt', 'nested/middle.bin', 'z-last.txt']);
  for (const entry of manifest.entries) {
    const onDisk = fs.readFileSync(path.join(input, entry.path));
    assert.equal(entry.bytes, onDisk.length);
    assert.equal(entry.sha256, sha256(onDisk));
  }
  assert.ok(!fs.readFileSync(manifestA, 'utf8').includes(input), 'manifest must not embed absolute input paths');
  assert.deepEqual(
    readZipCentralDirectory(bytesA).map(entry => entry.path),
    ['a-first.txt', 'nested/middle.bin', 'z-last.txt'],
  );
  // STORE method: file bytes appear verbatim in the archive (no compressor).
  assert.ok(bytesA.includes(Buffer.from('first\n')), 'stored entry bytes must be present verbatim');
  assert.equal(verifySealedArchive({ archive: archiveA, manifest: manifestA }).verdict, 'PASS');
});

test('seal refuses archives or manifests inside the mutable input tree', (t) => {
  const fixture = tempRoot(t, 'taa-seal-inside-');
  const input = path.join(fixture, 'test-results');
  writeTree(input, { 'a.txt': 'a\n' });
  const insideArchive = runSeal([
    '--input', input,
    '--archive', path.join(input, 'evidence.zip'),
    '--manifest', path.join(fixture, 'evidence.manifest.json'),
  ]);
  assert.notEqual(insideArchive.status, 0);
  assert.match(insideArchive.stderr, /outside --input/u);
  const insideManifest = runSeal([
    '--input', input,
    '--archive', path.join(fixture, 'evidence.zip'),
    '--manifest', path.join(input, 'evidence.manifest.json'),
  ]);
  assert.notEqual(insideManifest.status, 0);
  assert.match(insideManifest.stderr, /outside --input/u);
  assert.ok(!fs.existsSync(path.join(input, 'evidence.zip')));
});

test('seal refuses symlinks and never follows them into the archive', (t) => {
  const fixture = tempRoot(t, 'taa-seal-symlink-');
  const input = path.join(fixture, 'test-results');
  const outside = path.join(fixture, 'outside-secret.txt');
  fs.writeFileSync(outside, `leak ${WEBHOOK}\n`);
  writeTree(input, { 'clean.txt': 'clean\n' });
  fs.symlinkSync(outside, path.join(input, 'linked.txt'));
  const archive = path.join(fixture, 'out', 'evidence.zip');
  const manifest = path.join(fixture, 'out', 'evidence.manifest.json');
  const seal = runSeal(['--input', input, '--archive', archive, '--manifest', manifest]);
  assert.notEqual(seal.status, 0);
  assert.match(seal.stderr, /symlink/u);
  assert.ok(!fs.existsSync(archive), 'no archive may be published when a symlink is present');
});

test('seal refuses non-regular entries (FIFO) and symlinked input roots', (t) => {
  const fixture = tempRoot(t, 'taa-seal-nonregular-');
  const input = path.join(fixture, 'test-results');
  writeTree(input, { 'clean.txt': 'clean\n' });
  const fifo = path.join(input, 'pipe');
  const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (mkfifo.status !== 0) {
    // mkfifo is unavailable (non-POSIX filesystem) — the symlink case above
    // still covers the no-follow contract; keep the suite honest about it.
    t.diagnostic(`mkfifo unavailable: ${mkfifo.stderr}`);
  } else {
    const seal = runSeal([
      '--input', input,
      '--archive', path.join(fixture, 'out', 'evidence.zip'),
      '--manifest', path.join(fixture, 'out', 'evidence.manifest.json'),
    ]);
    assert.notEqual(seal.status, 0);
    assert.match(seal.stderr, /non-regular/u);
  }
  const linkedInput = path.join(fixture, 'linked-input');
  fs.symlinkSync(input, linkedInput);
  const linkedRoot = runSeal([
    '--input', linkedInput,
    '--archive', path.join(fixture, 'out', 'root.zip'),
    '--manifest', path.join(fixture, 'out', 'root.manifest.json'),
  ]);
  assert.notEqual(linkedRoot.status, 0);
  assert.match(linkedRoot.stderr, /real directory/u);
});

test('verify fails closed on a missing or mutated archive and on digest tampering', (t) => {
  const sealed = sealCleanFixture(t);
  assert.equal(runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]).status, 0);

  const mutated = Buffer.from(fs.readFileSync(sealed.archive));
  mutated[mutated.length - 30] ^= 0xff;
  fs.writeFileSync(sealed.archive, mutated);
  const mutatedRun = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(mutatedRun.status, 0);
  assert.match(mutatedRun.stderr, /digest mismatch|size mismatch/u);

  const tampered = readJson(sealed.manifest);
  tampered.archiveSha256 = 'f'.repeat(64);
  fs.writeFileSync(sealed.manifest, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedRun = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(tamperedRun.status, 0);
  assert.match(tamperedRun.stderr, /digest mismatch/u);

  fs.rmSync(sealed.archive);
  const missing = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(missing.status, 0);
});

test('verify rejects a manifest entry digest changed without touching the archive', (t) => {
  const sealed = sealCleanFixture(t);
  const doc = readJson(sealed.manifest);
  const index = doc.entries.findIndex(entry => entry.path === 'notes.txt');
  assert.notEqual(index, -1, 'fixture must declare notes.txt');
  const original = doc.entries[index].sha256;
  doc.entries[index].sha256 = (original[0] === '0' ? '1' : '0') + original.slice(1);
  assert.notEqual(doc.entries[index].sha256, original);
  writeManifest(sealed.manifest, doc);

  const run = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(run.status, 0, 'a changed entry digest must fail verification');
  assert.match(run.stderr, /entry digest mismatch: notes\.txt/u);
  assert.match(run.stderr, new RegExp(doc.entries[index].sha256, 'u'), 'failure must name the declared digest');
});

test('verify rejects malformed manifest entry hashes and shapes', (t) => {
  const sealed = sealCleanFixture(t);
  const original = readJson(sealed.manifest);

  const badHash = JSON.parse(JSON.stringify(original));
  badHash.entries[0].sha256 = 'Z'.repeat(64);
  writeManifest(sealed.manifest, badHash);
  const badHashRun = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(badHashRun.status, 0);
  assert.match(badHashRun.stderr, /malformed manifest sha256/u);

  const shortHash = JSON.parse(JSON.stringify(original));
  shortHash.entries[1].sha256 = 'abc123';
  writeManifest(sealed.manifest, shortHash);
  const shortHashRun = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(shortHashRun.status, 0);
  assert.match(shortHashRun.stderr, /malformed manifest sha256/u);

  const badBytes = JSON.parse(JSON.stringify(original));
  badBytes.entries[0].bytes = '3';
  writeManifest(sealed.manifest, badBytes);
  const badBytesRun = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(badBytesRun.status, 0);
  assert.match(badBytesRun.stderr, /malformed manifest byte count/u);
});

test('verify rejects duplicate manifest entry paths', (t) => {
  const sealed = sealCleanFixture(t);
  const doc = readJson(sealed.manifest);
  doc.entries[1] = { ...doc.entries[0] };
  writeManifest(sealed.manifest, doc);

  const run = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /duplicate manifest entry path/u);
});

test('verify rejects a ZIP with duplicate entry paths', (t) => {
  const fixture = tempRoot(t, 'taa-seal-archive-dup-');
  const payloadA = Buffer.from('one\n');
  const payloadB = Buffer.from('two\n');
  const zip = buildZip([
    { rel: 'dup.txt', data: payloadA },
    { rel: 'dup.txt', data: payloadB },
  ]);
  const archive = path.join(fixture, 'dup.zip');
  const manifest = path.join(fixture, 'dup.manifest.json');
  fs.writeFileSync(archive, zip);
  writeManifest(manifest, {
    schemaVersion: 1,
    archive: 'dup.zip',
    archiveSha256: sha256(zip),
    archiveBytes: zip.length,
    entryCount: 2,
    // Unique manifest paths: the duplicate is an archive-level defect and must
    // be rejected by the archive check, not shadowed by the manifest check.
    entries: [
      { path: 'one.txt', bytes: payloadA.length, sha256: sha256(payloadA) },
      { path: 'two.txt', bytes: payloadB.length, sha256: sha256(payloadB) },
    ],
  });

  const run = runSeal(['--verify', '--archive', archive, '--manifest', manifest]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /duplicate archive entry path/u);
});

test('verify rejects unsupported ZIP features even with a matching archive digest', (t) => {
  const sealed = sealCleanFixture(t);
  const mutated = Buffer.from(fs.readFileSync(sealed.archive));
  mutated.writeUInt16LE(8, centralDirectoryOffset(mutated) + 10); // deflate
  fs.writeFileSync(sealed.archive, mutated);
  const doc = readJson(sealed.manifest);
  doc.archiveSha256 = sha256(mutated);
  doc.archiveBytes = mutated.length;
  writeManifest(sealed.manifest, doc);

  const run = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unsupported ZIP feature/u);
});

test('source mutation after sealing cannot enter the sealed archive bytes', (t) => {
  const sealed = sealCleanFixture(t);
  const before = fs.readFileSync(sealed.archive);
  const beforeSha = sha256(before);

  fs.writeFileSync(path.join(sealed.input, 'reports', 'summary.json'), `leak ${WEBHOOK}\n`);
  fs.writeFileSync(path.join(sealed.input, 'late.txt'), 'arrived after sealing\n');

  const verify = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.equal(verify.status, 0, 'the sealed archive must stay valid after source mutation');
  assert.deepEqual(fs.readFileSync(sealed.archive), before, 'sealed bytes must not change');
  assert.equal(sha256(fs.readFileSync(sealed.archive)), beforeSha);

  const central = readZipCentralDirectory(fs.readFileSync(sealed.archive));
  assert.deepEqual(central.map(entry => entry.path), ['nested/deep/data.bin', 'notes.txt', 'reports/summary.json']);
  assert.ok(!fs.readFileSync(sealed.archive).includes(Buffer.from(WEBHOOK)), 'post-seal source bytes must be absent');

  // A fresh seal of the mutated source is a different archive, proving the
  // uploaded snapshot is frozen at seal time.
  const rearchive = path.join(sealed.fixture, 'resealed.zip');
  const remanifest = path.join(sealed.fixture, 'resealed.manifest.json');
  assert.equal(runSeal(['--input', sealed.input, '--archive', rearchive, '--manifest', remanifest]).status, 0);
  assert.notEqual(sha256(fs.readFileSync(rearchive)), beforeSha);
});

test('clean synthetic evidence seals, scans PASS, and survives the digest recheck', (t) => {
  const sealed = sealCleanFixture(t);
  const report = path.join(sealed.fixture, 'browser-evidence.scan.json');
  const scan = runEvidenceScan(sealed.staging, report);
  assert.equal(scan.status, 0, `clean evidence must scan PASS: ${scan.stdout}${scan.stderr}`);
  const scanReport = readJson(report);
  assert.equal(scanReport.verdict, 'PASS');
  assert.deepEqual(scanReport.findings, []);
  assert.equal(
    runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]).status,
    0,
    'digest recheck immediately before upload must pass',
  );
});

test('secret-bearing evidence fails the scan and blocks upload eligibility', (t) => {
  const sealed = sealCleanFixture(t);
  fs.writeFileSync(path.join(sealed.input, 'reports', 'leak.txt'), `webhook ${WEBHOOK}\n`);
  const resealed = path.join(sealed.staging, 'browser-evidence.zip');
  const remanifest = path.join(sealed.fixture, 'browser-evidence.manifest.json');
  assert.equal(runSeal(['--input', sealed.input, '--archive', resealed, '--manifest', remanifest]).status, 0);
  const report = path.join(sealed.fixture, 'scan.json');
  const scan = runEvidenceScan(sealed.staging, report);
  assert.notEqual(scan.status, 0, 'secret-bearing evidence must fail the evidence scan');
  const scanReport = readJson(report);
  assert.equal(scanReport.verdict, 'FAIL');
  assert.ok(
    scanReport.findings.some(finding => finding.rule === 'discord-webhook' && finding.path.includes('leak.txt')),
    `expected a discord-webhook finding for the sealed entry, got ${JSON.stringify(scanReport.findings)}`,
  );
});

test('nested trace archive evidence fails the recursive ZIP scan', (t) => {
  const sealed = sealCleanFixture(t);
  const traceDir = path.join(sealed.fixture, 'trace-src');
  writeTree(traceDir, {
    '0-trace.trace': `{"type":"console","text":"${WEBHOOK}"}\n`,
    'resources/page.html': '<html></html>\n',
  });
  const traceZip = path.join(sealed.input, 'traces', 'trace.zip');
  const traceManifest = path.join(sealed.fixture, 'trace.manifest.json');
  assert.equal(runSeal(['--input', traceDir, '--archive', traceZip, '--manifest', traceManifest]).status, 0);
  const resealed = path.join(sealed.staging, 'browser-evidence.zip');
  const remanifest = path.join(sealed.fixture, 'browser-evidence.manifest.json');
  assert.equal(runSeal(['--input', sealed.input, '--archive', resealed, '--manifest', remanifest]).status, 0);

  const report = path.join(sealed.fixture, 'scan.json');
  const scan = runEvidenceScan(sealed.staging, report);
  assert.notEqual(scan.status, 0, 'trace evidence with a nested secret must fail the evidence scan');
  const scanReport = readJson(report);
  assert.equal(scanReport.verdict, 'FAIL');
  assert.ok(
    scanReport.findings.some(
      finding => finding.rule === 'discord-webhook' && finding.path.includes('trace.zip!') && finding.path.includes('0-trace.trace'),
    ),
    `expected a nested discord-webhook finding, got ${JSON.stringify(scanReport.findings)}`,
  );
});

test('screenshot evidence with a secret ID fails the OCR scan', async (t) => {
  const sealed = sealCleanFixture(t);
  const sharp = require('sharp');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="220">',
    '<rect width="1400" height="220" fill="white"/>',
    '<text x="30" y="150" font-family="DejaVu Sans Mono, monospace" font-size="72" fill="black">123456789012345678</text>',
    '</svg>',
  ].join('');
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const screenshotPath = path.join(sealed.input, 'screenshots', 'panel.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, png);
  const resealed = path.join(sealed.staging, 'browser-evidence.zip');
  const remanifest = path.join(sealed.fixture, 'browser-evidence.manifest.json');
  assert.equal(runSeal(['--input', sealed.input, '--archive', resealed, '--manifest', remanifest]).status, 0);

  const report = path.join(sealed.fixture, 'scan.json');
  const scan = runEvidenceScan(sealed.staging, report);
  assert.notEqual(scan.status, 0, 'screenshot evidence with a secret ID must fail the OCR scan');
  const scanReport = readJson(report);
  assert.equal(scanReport.verdict, 'FAIL');
  assert.ok(
    scanReport.findings.some(
      finding => finding.rule === 'discord-snowflake' && finding.path.includes('screenshots/panel.png'),
    ),
    `expected an OCR discord-snowflake finding, got ${JSON.stringify(scanReport.findings)}`,
  );
});

test('post-scan archive mutation makes the digest recheck (and upload) ineligible', (t) => {
  const sealed = sealCleanFixture(t);
  const report = path.join(sealed.fixture, 'scan.json');
  const scan = runEvidenceScan(sealed.staging, report);
  assert.equal(scan.status, 0, 'scan of the clean sealed archive must PASS');
  assert.equal(runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]).status, 0);

  const mutated = Buffer.from(fs.readFileSync(sealed.archive));
  mutated[mutated.length - 25] ^= 0x01;
  fs.writeFileSync(sealed.archive, mutated);
  const recheck = runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]);
  assert.notEqual(recheck.status, 0, 'post-scan mutation must fail the digest recheck');
  assert.match(recheck.stderr, /digest mismatch|size mismatch/u);

  fs.rmSync(sealed.archive);
  assert.notEqual(
    runSeal(['--verify', '--archive', sealed.archive, '--manifest', sealed.manifest]).status,
    0,
    'a missing archive must fail the digest recheck',
  );
});
