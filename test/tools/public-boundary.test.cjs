'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const { STREAM_CHUNK_BYTES } = require('../../tools/audit-public-tree.cjs');

const ROOT = path.resolve(__dirname, '../..');
const AUDITOR = path.join(ROOT, 'tools', 'audit-public-tree.cjs');
// Fallback keeps the RED run behavioral (fixtures still split a signature
// across a chunk boundary) instead of crashing when the export is missing.
const CHUNK_BYTES = STREAM_CHUNK_BYTES || 64 * 1024;
const OVERSIZE_BYTES = 8 * 1024 * 1024 + 4096;
const MODES = ['tree', 'secrets'];
const REVIEWED_FILES = [
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'metadata.json',
  'module-manifest.json',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
];
const REVIEWED_DIRS = ['.github', 'config', 'dist', 'docs', 'src', 'test', 'tools'];

function runAudit(root, baseline, reportPath, options = {}) {
  const args = options.mode === 'secrets'
    ? [AUDITOR, '--mode', 'secrets', '--root', root, '--out', reportPath]
    : [AUDITOR, '--root', root, '--baseline', baseline, '--out', reportPath];
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs === undefined ? 120000 : options.timeoutMs,
    env: options.env === undefined ? process.env : options.env,
  });
}

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-public-boundary-'));
  const baseline = path.join(fixtureRoot, 'baseline');
  const publicRoot = path.join(fixtureRoot, 'public');
  fs.mkdirSync(baseline);
  for (const directory of REVIEWED_DIRS) {
    fs.mkdirSync(path.join(baseline, directory), { recursive: true });
  }
  // The allowlist also requires tools/ocr-models/ to exist in the baseline.
  fs.mkdirSync(path.join(baseline, 'tools', 'ocr-models'), { recursive: true });
  for (const file of REVIEWED_FILES) {
    fs.writeFileSync(path.join(baseline, file), `reviewed fixture: ${file}\n`);
  }
  fs.cpSync(baseline, publicRoot, { recursive: true });
  return {
    fixtureRoot,
    baseline,
    publicRoot,
    reportPath: path.join(fixtureRoot, 'boundary-report.json'),
  };
}

function createCanonicalSnapshot(destination) {
  fs.mkdirSync(destination);
  for (const directory of REVIEWED_DIRS) {
    fs.cpSync(path.join(ROOT, directory), path.join(destination, directory), { recursive: true });
  }
  for (const file of REVIEWED_FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(destination, file));
  }
}

function withFixture(assertion) {
  const fixture = createFixture();
  try {
    assertion(fixture);
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

function readReport(fixture) {
  return JSON.parse(fs.readFileSync(fixture.reportPath, 'utf8'));
}

function runFixtureAudit(fixture, mode, options = {}) {
  return runAudit(fixture.publicRoot, fixture.baseline, fixture.reportPath, { mode, ...options });
}

function assertRejected(fixture, expected) {
  const result = runAudit(fixture.publicRoot, fixture.baseline, fixture.reportPath);
  assert.notEqual(result.status, 0, 'audit must reject the forbidden fixture');
  const report = readReport(fixture);
  assert.equal(report.verdict, 'FAIL');
  expected(report);
  return { result, report };
}

/** Write the same bytes to the baseline and the public copy (expected file). */
function addFixtureFile(fixture, rel, data) {
  fs.writeFileSync(path.join(fixture.baseline, rel), data);
  fs.writeFileSync(path.join(fixture.publicRoot, rel), data);
}

function syntheticWebhook() {
  const snowflake = ['987654', '321098', '765432'].join('');
  const token = ['boundaryTokenPartOne_', 'boundaryTokenPartTwo_', 'boundaryTokenPartThree'].join('');
  return ['https:/', 'discord.com', 'api', 'webhooks', snowflake, token].join('/');
}

// One recognized token per supported secret kind. Tokens are assembled from
// fragments so this test file never matches its own policy.
const SECRET_KIND_SAMPLES = [
  { kind: 'discord-webhook', token: syntheticWebhook() },
  { kind: 'discord-snowflake', token: ['123456', '789012', '345678'].join('') },
  { kind: 'private-path', token: ['..', 'TravianAttackAlertDEV', 'backups', 'boundary-private.json'].join('/') },
  { kind: 'legacy-identity', token: ['Le', 'nny'].join('') },
  { kind: 'legacy-host', token: ['cw', 'x2', 'international', 'tra' + 'vian', 'com'].join('.') },
];

/** Oversized (> 8 MiB) single-line text with a webhook near EOF. */
function writeOversizedWebhookFile(fixture) {
  const buffer = Buffer.alloc(OVERSIZE_BYTES, 0x61);
  const token = syntheticWebhook();
  const start = OVERSIZE_BYTES - token.length - 16;
  Buffer.from(` ${token} `, 'utf8').copy(buffer, start - 1);
  addFixtureFile(fixture, 'docs/oversized-webhook.txt', buffer);
}

/** Oversized text where every secret kind straddles a streaming chunk boundary. */
function writeBoundarySplitFile(fixture) {
  const buffer = Buffer.alloc(8 * 1024 * 1024 + 1024, 0x61);
  SECRET_KIND_SAMPLES.forEach((sample, index) => {
    const boundary = CHUNK_BYTES * (index + 1);
    const start = boundary - ((index % 4) + 1);
    Buffer.from(` ${sample.token} `, 'utf8').copy(buffer, start - 1);
  });
  addFixtureFile(fixture, 'docs/oversized-boundary.txt', buffer);
}

test('Given the canonical repository, When audited against itself, Then only reviewed public paths pass', () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-canonical-boundary-'));
  try {
    const canonical = path.join(reportDir, 'canonical');
    const reportPath = path.join(reportDir, 'boundary-report.json');
    createCanonicalSnapshot(canonical);
    const result = runAudit(canonical, canonical, reportPath);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.verdict, 'PASS');
    assert.ok(report.scanStats.scanned > 0, 'canonical audit must report scanned files');
    const model = report.scanStats.binarySkippedFiles.find((entry) => entry.file === 'tools/ocr-models/eng.traineddata.gz');
    assert.ok(model, 'the tracked OCR model must be reported as a binary asset');
    assert.equal(model.reason, 'binary-nul');
    assert.equal(report.scanStats.errorEntries.length, 0);
    assert.equal(report.scanStats.nonRegularEntries.length, 0);
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
});

for (const directory of ['backups', '.dane', '.omo', '.playwright-mcp', 'node_modules', 'test-results']) {
  test(`Given an excluded ${directory} directory, When audited, Then the public tree is rejected`, () => {
    withFixture((fixture) => {
      fs.mkdirSync(path.join(fixture.publicRoot, directory));
      fs.writeFileSync(path.join(fixture.publicRoot, directory, 'private.txt'), 'private fixture\n');
      assertRejected(fixture, (report) => {
        assert.ok(report.excludedFound.includes(`${directory}/`));
      });
    });
  });
}

test('Given a settings-backup filename, When audited, Then the public tree is rejected', () => {
  withFixture((fixture) => {
    const backupName = ['taa-settings-backup-', 'fixture', '.json'].join('');
    fs.writeFileSync(path.join(fixture.publicRoot, 'docs', backupName), '{}\n');
    assertRejected(fixture, (report) => {
      assert.ok(report.excludedFound.includes(`docs/${backupName}`));
    });
  });
});

test('Given a private migration backup reference, When audited, Then the public tree is rejected safely', () => {
  withFixture((fixture) => {
    const privateReference = ['..', 'TravianAttackAlertDEV', 'backups'].join('/');
    fs.writeFileSync(path.join(fixture.publicRoot, 'README.md'), `${privateReference}\n`);
    const { result, report } = assertRejected(fixture, (auditReport) => {
      assert.ok(auditReport.secretHits.some((hit) => hit.kind === 'private-path'));
    });
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(report)}`.includes(privateReference));
  });
});

test('Given a Discord snowflake, When audited, Then the public tree is rejected without printing it', () => {
  withFixture((fixture) => {
    const snowflake = ['123456', '789012', '345678'].join('');
    fs.writeFileSync(path.join(fixture.publicRoot, 'metadata.json'), `channel=${snowflake}\n`);
    const { result, report } = assertRejected(fixture, (auditReport) => {
      assert.ok(auditReport.secretHits.some((hit) => hit.kind === 'discord-snowflake'));
    });
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(report)}`.includes(snowflake));
  });
});

test('Given a Discord webhook URL, When audited, Then the public tree is rejected without printing its secret bytes', () => {
  withFixture((fixture) => {
    const snowflake = ['987654', '321098', '765432'].join('');
    const token = ['privateTokenPartOne_', 'privateTokenPartTwo_', 'privateTokenPartThree'].join('');
    const webhook = ['https:/', 'discord.com', 'api', 'webhooks', snowflake, token].join('/');
    fs.writeFileSync(path.join(fixture.publicRoot, 'README.md'), `${webhook}\n`);
    const { result, report } = assertRejected(fixture, (auditReport) => {
      assert.ok(auditReport.secretHits.some((hit) => hit.kind === 'discord-webhook'));
    });
    const output = `${result.stdout}${result.stderr}${JSON.stringify(report)}`;
    assert.ok(!output.includes(token));
    assert.ok(!output.includes(webhook));
  });
});

test('Given an absolute DEV path, When audited, Then the public tree is rejected without printing the path', () => {
  withFixture((fixture) => {
    const absoluteDevPath = ['', 'mnt', 'e', 'Projekty', 'TravianAttackAlertDEV', 'src', 'runtime.js'].join('/');
    fs.writeFileSync(path.join(fixture.publicRoot, 'README.md'), `${absoluteDevPath}\n`);
    const { result, report } = assertRejected(fixture, (auditReport) => {
      assert.ok(auditReport.secretHits.some((hit) => hit.kind === 'private-path'));
    });
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(report)}`.includes(absoluteDevPath));
  });
});

for (const mode of MODES) {
  test(`Given an oversized (>8 MiB) text file with a Discord webhook near EOF, When audited in ${mode} mode, Then the secret is detected and the audit fails closed`, () => {
    withFixture((fixture) => {
      writeOversizedWebhookFile(fixture);
      const result = runFixtureAudit(fixture, mode);
      assert.notEqual(result.status, 0, `oversized secret must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.secretHits.some((hit) => hit.kind === 'discord-webhook'),
        `${mode}: webhook near EOF of an oversized file must be detected`,
      );
    });
  });

  test(`Given every secret kind split exactly across a stream chunk boundary, When audited in ${mode} mode, Then each kind is detected`, () => {
    assert.ok(Number.isInteger(STREAM_CHUNK_BYTES) && STREAM_CHUNK_BYTES >= 4096, 'the audit tool must export its streaming chunk size');
    withFixture((fixture) => {
      writeBoundarySplitFile(fixture);
      const result = runFixtureAudit(fixture, mode);
      assert.notEqual(result.status, 0, `cross-boundary secrets must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      for (const sample of SECRET_KIND_SAMPLES) {
        assert.ok(
          report.secretHits.some((hit) => hit.kind === sample.kind),
          `${mode}: ${sample.kind} split across the chunk boundary must be detected`,
        );
      }
    });
  });

  test(`Given an injected mid-stream read failure, When audited in ${mode} mode, Then the audit fails closed with a read-error finding`, () => {
    withFixture((fixture) => {
      addFixtureFile(fixture, 'docs/fault.txt', Buffer.alloc(1024 * 1024, 0x61));
      const result = runFixtureAudit(fixture, mode, {
        env: { ...process.env, TAA_AUDIT_TEST_READ_FAULT: 'throw:fault.txt' },
      });
      assert.notEqual(result.status, 0, `read failure must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.scanStats.errorEntries.some((entry) => entry.file.endsWith('fault.txt') && entry.reason === 'read-failure'),
        `${mode}: injected read failure must be reported: ${JSON.stringify(report.scanStats)}`,
      );
    });
  });

  test(`Given an injected mid-stream truncation, When audited in ${mode} mode, Then the audit fails closed with a truncation finding`, () => {
    withFixture((fixture) => {
      addFixtureFile(fixture, 'docs/fault.txt', Buffer.alloc(1024 * 1024, 0x61));
      const result = runFixtureAudit(fixture, mode, {
        env: { ...process.env, TAA_AUDIT_TEST_READ_FAULT: 'truncate:fault.txt' },
      });
      assert.notEqual(result.status, 0, `truncation must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.scanStats.errorEntries.some((entry) => entry.file.endsWith('fault.txt') && entry.reason === 'truncated-read'),
        `${mode}: truncation must be reported: ${JSON.stringify(report.scanStats)}`,
      );
    });
  });

  test(`Given a symlink to a clean file, When audited in ${mode} mode, Then the non-regular entry is reported and rejected`, () => {
    withFixture((fixture) => {
      const target = path.join(fixture.fixtureRoot, 'clean-target.txt');
      fs.writeFileSync(target, 'clean fixture\n');
      fs.symlinkSync(target, path.join(fixture.publicRoot, 'docs', 'link-clean.txt'));
      const result = runFixtureAudit(fixture, mode);
      assert.notEqual(result.status, 0, `symlink must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.scanStats.nonRegularEntries.some((entry) => entry.file === 'docs/link-clean.txt' && entry.reason === 'symlink'),
        `${mode}: symlink must be reported: ${JSON.stringify(report.scanStats)}`,
      );
      assert.equal(report.secretHits.length, 0);
    });
  });

  test(`Given a symlink to a secret-bearing file, When audited in ${mode} mode, Then it is rejected without following the link`, () => {
    withFixture((fixture) => {
      const target = path.join(fixture.fixtureRoot, 'secret-target.txt');
      fs.writeFileSync(target, `${syntheticWebhook()}\n`);
      fs.symlinkSync(target, path.join(fixture.publicRoot, 'docs', 'link-secret.txt'));
      const result = runFixtureAudit(fixture, mode);
      assert.notEqual(result.status, 0, `symlink to secret must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.scanStats.nonRegularEntries.some((entry) => entry.file === 'docs/link-secret.txt' && entry.reason === 'symlink'),
        `${mode}: symlink must be reported: ${JSON.stringify(report.scanStats)}`,
      );
      assert.equal(report.secretHits.length, 0, 'the symlink target must never be followed');
    });
  });

  test(`Given a non-regular FIFO entry, When audited in ${mode} mode, Then it is reported and rejected without being opened`, () => {
    withFixture((fixture) => {
      execFileSync('mkfifo', [path.join(fixture.publicRoot, 'docs', 'fifo-entry')]);
      const result = runFixtureAudit(fixture, mode);
      assert.notEqual(result.status, 0, `non-regular entry must fail closed (${mode}): ${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'FAIL');
      assert.ok(
        report.scanStats.nonRegularEntries.some((entry) => entry.file === 'docs/fifo-entry' && entry.reason === 'non-regular'),
        `${mode}: FIFO must be reported: ${JSON.stringify(report.scanStats)}`,
      );
    });
  });

  test(`Given an oversized binary file, When audited in ${mode} mode, Then it is accepted and reported as an auditable binary skip`, () => {
    withFixture((fixture) => {
      addFixtureFile(fixture, 'docs/oversized.bin', Buffer.alloc(10 * 1024 * 1024, 0));
      const result = runFixtureAudit(fixture, mode);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const report = readReport(fixture);
      assert.equal(report.verdict, 'PASS');
      assert.ok(
        report.scanStats.binarySkippedFiles.some((entry) => entry.file === 'docs/oversized.bin' && entry.reason === 'binary-nul'),
        `${mode}: binary skip must be reported: ${JSON.stringify(report.scanStats)}`,
      );
      assert.equal(report.scanStats.errorEntries.length, 0);
    });
  });
}
