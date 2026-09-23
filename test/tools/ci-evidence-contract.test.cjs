'use strict';

// Static workflow contract for browser evidence handling (Task 6).
//
// The browser job must:
//   1. seal the mutable `test-results/` tree into ONE deterministic ZIP that
//      lives OUTSIDE `test-results/` (plus a digest manifest),
//   2. scan that exact sealed archive with the ZIP-recursive evidence scanner
//      (`--mode evidence`) under `if: always()`,
//   3. recompute and compare the ZIP SHA-256 immediately before upload,
//   4. upload ONLY the sealed ZIP + the separate scan report — never the
//      mutable source directory.
//
// This suite parses `.github/workflows/ci.yml` with a purpose-built, read-only
// indentation parser (no YAML dependency) and asserts those relations. It never
// executes or mutates the workflow.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const REQUIRED_JOBS = ['offline-node-18', 'offline-node-20', 'browser-node-20', 'cross-node-determinism'];
const BROWSER_JOB = 'browser-node-20';
const SEALED_DIR_PREFIX = 'ci-evidence';

function workflowLines() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
}

function collectBlock(lines, from, minIndent) {
  const out = [];
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      out.push('');
      continue;
    }
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent < minIndent) break;
    out.push(lines[i].slice(minIndent));
  }
  return out.join('\n').trim();
}

function parseStep(block) {
  const step = {
    name: null,
    id: null,
    condition: null,
    uses: null,
    run: null,
    with: {},
    continueOnError: false,
  };
  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    let match;
    if ((match = /^ {8}name: (.+)$/u.exec(line))) step.name = match[1].trim();
    else if ((match = /^ {8}id: (.+)$/u.exec(line))) step.id = match[1].trim();
    else if ((match = /^ {8}if: (.+)$/u.exec(line))) step.condition = match[1].trim();
    else if ((match = /^ {8}uses: (.+)$/u.exec(line))) step.uses = match[1].trim();
    else if ((match = /^ {8}continue-on-error: (.+)$/u.exec(line))) {
      step.continueOnError = match[1].trim() === 'true';
    } else if (line === '        run: |') {
      step.run = collectBlock(block, i + 1, 10);
    } else if ((match = /^ {8}run: (.+)$/u.exec(line))) {
      step.run = match[1].trim();
    } else if (line === '        with:') {
      const withLines = [];
      for (let j = i + 1; j < block.length; j += 1) {
        if (block[j].trim() !== '' && !/^ {10}/u.test(block[j])) break;
        withLines.push(block[j]);
      }
      for (let k = 0; k < withLines.length; k += 1) {
        const key = /^ {10}([A-Za-z0-9_-]+):(?: (.*))?$/u.exec(withLines[k]);
        if (!key) continue;
        step.with[key[1]] = key[2] === '|' ? collectBlock(withLines, k + 1, 12) : (key[2] || '').trim();
      }
    }
  }
  return step;
}

function jobSlice(lines, jobName) {
  const header = `  ${jobName}:`;
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `workflow job ${jobName} must exist`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/u.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function parseJobSteps(lines, jobName) {
  const { start, end } = jobSlice(lines, jobName);
  let stepsHeader = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i] === '    steps:') {
      stepsHeader = i;
      break;
    }
  }
  assert.notEqual(stepsHeader, -1, `workflow job ${jobName} must declare steps:`);
  let stepsEnd = end;
  for (let i = stepsHeader + 1; i < end; i += 1) {
    if (/^ {4}\S/u.test(lines[i])) {
      stepsEnd = i;
      break;
    }
  }
  const starts = [];
  for (let i = stepsHeader + 1; i < stepsEnd; i += 1) {
    if (/^ {6}- /u.test(lines[i])) starts.push(i);
  }
  return starts.map((from, index) => {
    const to = index + 1 < starts.length ? starts[index + 1] : stepsEnd;
    return parseStep(lines.slice(from, to));
  });
}

function browserSteps() {
  return parseJobSteps(workflowLines(), BROWSER_JOB);
}

function findStep(steps, id) {
  const step = steps.find(candidate => candidate.id === id);
  assert.ok(step, `browser job must declare a step with id: ${id}`);
  return step;
}

function argValue(run, flag) {
  const match = new RegExp(`${flag}\\s+(\\S+)`, 'u').exec(run);
  assert.ok(match, `run command must pass ${flag}`);
  return match[1];
}

function assertOutsideMutableTree(relPath, label) {
  const normalized = relPath.split('\\').join('/');
  assert.ok(
    normalized !== 'test-results' && !normalized.startsWith('test-results/'),
    `${label} must live outside test-results/ (got ${relPath})`,
  );
}

test('workflow keeps the four required jobs, triggers, and read-only permissions', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  const jobsHeader = lines.indexOf('jobs:');
  assert.notEqual(jobsHeader, -1, 'workflow must declare jobs:');
  const jobNames = lines
    .slice(jobsHeader + 1)
    .filter(line => /^ {2}[A-Za-z0-9_-]+:$/u.test(line))
    .map(line => line.trim().replace(/:$/u, ''));
  assert.deepEqual(jobNames.sort(), [...REQUIRED_JOBS].sort());

  const triggers = lines.slice(lines.indexOf('on:'), lines.indexOf('permissions:')).join('\n');
  assert.match(triggers, /pull_request:/u);
  assert.match(triggers, /push:/u);
  assert.equal((triggers.match(/release\/public-1\.0\.0/gu) || []).length, 2);

  const permissions = lines.slice(lines.indexOf('permissions:'), jobsHeader).join('\n');
  assert.match(permissions, /contents: read/u);
  assert.doesNotMatch(text, /^\s*\w+: write\s*$/mu);
});

test('browser job seals the evidence tree into a deterministic archive outside test-results/', () => {
  const steps = browserSteps();
  const seal = findStep(steps, 'evidence-seal');
  assert.equal(seal.condition, 'always()', 'seal step must run under if: always()');
  assert.ok(seal.run, 'seal step must run a command');
  assert.match(seal.run, /tools\/seal-evidence\.cjs/u);
  assert.match(seal.run, /--input test-results/u);
  const archive = argValue(seal.run, '--archive');
  const manifest = argValue(seal.run, '--manifest');
  assertOutsideMutableTree(archive, 'sealed archive');
  assertOutsideMutableTree(manifest, 'seal manifest');
  assert.match(archive, /\.zip$/u, 'sealed archive must be a ZIP');
  assert.ok(archive.startsWith(`${SEALED_DIR_PREFIX}/`), `sealed archive must live under ${SEALED_DIR_PREFIX}/`);
});

test('browser job scans the exact sealed archive with --mode evidence under if: always()', () => {
  const steps = browserSteps();
  const seal = findStep(steps, 'evidence-seal');
  const scan = findStep(steps, 'evidence-scan');
  assert.equal(scan.condition, 'always()', 'scan step must run under if: always()');
  assert.ok(scan.run, 'scan step must run a command');
  assert.match(scan.run, /tools\/audit-public-tree\.cjs/u);
  assert.match(scan.run, /--mode evidence/u);

  const archive = argValue(seal.run, '--archive');
  const root = argValue(scan.run, '--root');
  const report = argValue(scan.run, '--out');
  assert.equal(root, path.posix.dirname(archive), 'scan root must be the directory holding the sealed archive');
  assertOutsideMutableTree(root, 'scan root');
  assertOutsideMutableTree(report, 'scan report');
  assert.ok(
    !report.split('\\').join('/').startsWith(`${root}/`),
    'scan report must live outside the scanned root (the report must never be its own input)',
  );
  assert.ok(
    !report.split('\\').join('/').startsWith(`${archive}`),
    'scan report must be a separate file, never inside the sealed ZIP path',
  );
});

test('browser job rechecks the sealed archive digest immediately before upload', () => {
  const steps = browserSteps();
  const seal = findStep(steps, 'evidence-seal');
  const digest = findStep(steps, 'evidence-digest');
  assert.equal(digest.condition, 'always()', 'digest recheck must run under if: always()');
  assert.ok(digest.run, 'digest step must run a command');
  assert.match(digest.run, /tools\/seal-evidence\.cjs/u);
  assert.match(digest.run, /--verify/u);
  assert.equal(argValue(digest.run, '--archive'), argValue(seal.run, '--archive'), 'digest recheck must use the sealed archive');
  assert.equal(argValue(digest.run, '--manifest'), argValue(seal.run, '--manifest'), 'digest recheck must use the seal manifest');

  const uploadIndex = steps.findIndex(step => step.uses === 'actions/upload-artifact@v4');
  assert.notEqual(uploadIndex, -1, 'browser job must upload an artifact');
  assert.equal(uploadIndex, steps.indexOf(digest) + 1, 'digest recheck must be the step immediately before upload');
});

test('upload step consumes only the sealed ZIP and the separate scan report', () => {
  const steps = browserSteps();
  const seal = findStep(steps, 'evidence-seal');
  const scan = findStep(steps, 'evidence-scan');
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.ok(upload, 'browser job must upload an artifact');

  const archive = argValue(seal.run, '--archive');
  const report = argValue(scan.run, '--out');
  const uploadPaths = upload.with.path.split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(uploadPaths.slice().sort(), [archive, report].sort());
  for (const uploadPath of uploadPaths) {
    assertOutsideMutableTree(uploadPath, 'upload path');
    assert.notEqual(uploadPath.replace(/\/+$/u, ''), 'test-results', 'upload must never target the mutable test-results/ tree');
  }
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with.name, 'browser-node-20-evidence');
});

test('upload is ineligible unless seal, scan, and digest recheck all succeeded', () => {
  const steps = browserSteps();
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.ok(upload, 'browser job must upload an artifact');
  assert.ok(upload.condition, 'upload step must be conditional');
  assert.match(upload.condition, /always\(\)/u, 'upload must still run when the browser tests failed');
  for (const id of ['evidence-seal', 'evidence-scan', 'evidence-digest']) {
    assert.ok(
      upload.condition.includes(`steps.${id}.outcome == 'success'`),
      `upload must be gated on steps.${id}.outcome == 'success'`,
    );
  }
});

test('browser test failure status stays visible (no continue-on-error, no success() gate)', () => {
  const steps = browserSteps();
  const browserTests = steps.find(step => step.run && /npm run test:browser/u.test(step.run));
  const e2eTests = steps.find(step => step.run && /npm run test:e2e/u.test(step.run));
  assert.ok(browserTests, 'browser integration gate must remain in the job');
  assert.ok(e2eTests, 'loopback e2e gate must remain in the job');
  assert.equal(browserTests.continueOnError, false);
  assert.equal(e2eTests.continueOnError, false);
  for (const step of steps) {
    assert.equal(step.continueOnError, false, `step "${step.name}" must not swallow failures`);
  }
});
