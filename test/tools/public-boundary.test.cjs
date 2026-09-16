'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const AUDITOR = path.join(ROOT, 'tools', 'audit-public-tree.cjs');
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

function runAudit(root, baseline, reportPath) {
  return spawnSync(
    process.execPath,
    [AUDITOR, '--root', root, '--baseline', baseline, '--out', reportPath],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-public-boundary-'));
  const baseline = path.join(fixtureRoot, 'baseline');
  const publicRoot = path.join(fixtureRoot, 'public');
  fs.mkdirSync(baseline);
  for (const directory of REVIEWED_DIRS) {
    fs.mkdirSync(path.join(baseline, directory), { recursive: true });
  }
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

function assertRejected(fixture, expected) {
  const result = runAudit(fixture.publicRoot, fixture.baseline, fixture.reportPath);
  assert.notEqual(result.status, 0, 'audit must reject the forbidden fixture');
  const report = JSON.parse(fs.readFileSync(fixture.reportPath, 'utf8'));
  assert.equal(report.verdict, 'FAIL');
  expected(report);
  return { result, report };
}

test('Given the canonical repository, When audited against itself, Then only reviewed public paths pass', () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-canonical-boundary-'));
  try {
    const canonical = path.join(reportDir, 'canonical');
    createCanonicalSnapshot(canonical);
    const result = runAudit(canonical, canonical, path.join(reportDir, 'boundary-report.json'));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
