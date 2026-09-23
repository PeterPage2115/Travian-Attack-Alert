'use strict';

// Task 34 developer-workflow contract.
//
// ci.yml must keep the four required status-check job names and add exactly
// one bounded, informational `offline-node-22` development leg that matches the
// documented development major (`.node-version`) without dropping Node 18/20 or
// raising `engines.node`. The complete offline release gate
// (`npm run check:release -- --offline`) must be wired exactly once, as a
// blocking step, and must fail closed instead of reclassifying a failure as
// skipped.
//
// docs/DEVELOPMENT.md must document the reproducible WSL/DrvFS workflow:
// Node/npm selection, `npm ci`, Playwright browsers and test tiers, backup
// before editing `src/`, the external `.omo` evidence root versus the ignored
// in-repo `.omo`, frozen test provenance, `.gitattributes`/line endings,
// `core.ignorecase` case-only renames, owner-data preservation, the protected
// canonical checkout, and the optional ext4 worktree tactic.
//
// All assertions are offline and deterministic. Set TAA_REPO_ROOT to run the
// same contract against a mutated fixture copy (the adversarial harness does
// exactly that); malformed input fails closed instead of being skipped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = process.env.TAA_REPO_ROOT
  ? path.resolve(process.env.TAA_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');

const CI_REL = path.join('.github', 'workflows', 'ci.yml');
const DEVELOPMENT_REL = path.join('docs', 'DEVELOPMENT.md');
const DEVELOPMENT_DOC_HEADINGS = [
  '## Workspace layout: canonical checkout, task worktrees, evidence root',
  '## Node and npm version selection',
  '## Install with npm ci',
  '## Playwright browsers and test tiers',
  '## Back up before editing src/ or config/',
  '## Frozen test provenance',
  '## Line endings and .gitattributes',
  '## Case-only renames and core.ignorecase',
  '## Owner data is never deleted',
  '## The protected canonical checkout',
  '## Optional: ext4 task worktree (performance tactic, not a mandate)',
  '## Quick verification sequence',
];

const REQUIRED_JOBS = ['offline-node-18', 'offline-node-20', 'browser-node-20', 'cross-node-determinism'];
const DEVELOPMENT_JOB = 'offline-node-22';
const DEVELOPMENT_MAJOR = 22;
const MAX_JOB_TIMEOUT_MINUTES = 120;
const RELEASE_GATE_COMMAND = 'npm run check:release -- --offline';
const REQUIRED_PINS = new Map([
  ['actions/checkout', '11d5960a326750d5838078e36cf38b85af677262'],
  ['actions/setup-node', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
  ['actions/upload-artifact', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
  ['actions/download-artifact', 'd3f86a106a0bac45b974a628896c90dbdf5c8093'],
]);
const ACTION_REFERENCE_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@(\S+)$/u;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/u;

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function jobBlocks(source, file) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.notEqual(start, -1, `${file} must declare a top-level jobs: block`);
  const jobs = new Map();
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && /^\S/u.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) {
      current = { name: header[1], lines: [] };
      jobs.set(header[1], current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  assert.ok(jobs.size > 0, `${file} must declare at least one job`);
  return jobs;
}

function jobSource(job) {
  return job.lines.join('\n');
}

function jobRuns(job) {
  const runs = [];
  let block = null;
  for (const line of job.lines) {
    const indent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() !== '' && indent >= 10) {
        block.push(line.trim());
        continue;
      }
      runs.push(block.join('\n'));
      block = null;
    }
    const inline = /^ {8}run:\s*(.+)$/u.exec(line);
    if (inline) {
      runs.push(inline[1].trim());
      continue;
    }
    if (/^ {8}run:\s*[|>]\s*$/u.test(line)) block = [];
  }
  if (block !== null) runs.push(block.join('\n'));
  return runs;
}

function jobTimeoutMinutes(job) {
  const matches = job.lines.map((line) => /^ {4}timeout-minutes:\s*(\d+)\s*$/u.exec(line)).filter(Boolean);
  assert.equal(matches.length, 1, `job ${job.name} must declare timeout-minutes exactly once`);
  return Number(matches[0][1]);
}

function setupNodeVersion(job) {
  const lines = job.lines;
  const index = lines.findIndex((line) => /uses:\s+actions\/setup-node@/u.test(line));
  assert.notEqual(index, -1, `job ${job.name} must set up Node.js`);
  const version = /^ {10}node-version:\s*(\S+)\s*$/u.exec(lines[index + 2] ?? '');
  assert.ok(version, `job ${job.name} must declare a node-version`);
  return version[1];
}

function actionReferences(source) {
  return [...source.matchAll(/^\s*uses:\s+(\S+)(?:\s+#\s*(\S+))?\s*$/gmu)]
    .map((match) => ({ reference: match[1], comment: (match[2] ?? '').trim() }));
}

function section(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `docs/DEVELOPMENT.md must contain the "${heading}" section`);
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n');
}

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

test('ci.yml keeps the four required check names and adds exactly one Node 22 development leg', () => {
  const jobs = jobBlocks(read(CI_REL), 'ci.yml');
  assert.deepEqual(
    [...jobs.keys()].sort(),
    [...REQUIRED_JOBS, DEVELOPMENT_JOB].sort(),
    'ci.yml job names changed beyond the Task 34 development leg',
  );
  for (const name of REQUIRED_JOBS) {
    assert.ok(jobs.has(name), `required check job ${name} must survive verbatim`);
  }
});

test('the Node 22 development leg matches .node-version without dropping 18/20 or raising engines', () => {
  const declared = read('.node-version').trim();
  assert.match(declared, /^\d+\.\d+\.\d+$/u, '.node-version must pin an exact version');
  assert.equal(Number(declared.split('.')[0]), DEVELOPMENT_MAJOR, '.node-version must name the documented development major');
  const jobs = jobBlocks(read(CI_REL), 'ci.yml');
  assert.equal(Number(setupNodeVersion(jobs.get(DEVELOPMENT_JOB))), DEVELOPMENT_MAJOR, `${DEVELOPMENT_JOB} must run the documented development major`);
  assert.equal(Number(setupNodeVersion(jobs.get('offline-node-18'))), 18, 'Node 18 coverage must not be dropped');
  assert.equal(Number(setupNodeVersion(jobs.get('offline-node-20'))), 20, 'Node 20 coverage must not be dropped');
  const pkg = readJson('package.json');
  assert.equal(pkg.engines?.node, '>=18', 'engines.node must stay >=18 until a compatibility proof exists');
});

test('the Node 22 job is bounded and runs the offline suites plus the release gate in order', () => {
  const jobs = jobBlocks(read(CI_REL), 'ci.yml');
  const job = jobs.get(DEVELOPMENT_JOB);
  assert.ok(job, `${DEVELOPMENT_JOB} job must exist`);
  assert.match(jobSource(job), /runs-on:\s+ubuntu-latest/u, `${DEVELOPMENT_JOB} must run on ubuntu-latest`);
  const timeout = jobTimeoutMinutes(job);
  assert.ok(timeout >= 1 && timeout <= MAX_JOB_TIMEOUT_MINUTES, `${DEVELOPMENT_JOB} timeout ${timeout} must be 1..${MAX_JOB_TIMEOUT_MINUTES}`);
  const runs = jobRuns(job);
  const requiredRuns = [
    'npm ci',
    'npm run build',
    'npm run test:offline',
    'npm run test:tools',
    'npm run test:artifact',
    'npm run test:characterization',
    'npm run check',
    'npm run check:types',
    'npm run quality',
    'npx playwright install --with-deps chromium',
    RELEASE_GATE_COMMAND,
  ];
  let cursor = 0;
  for (const expected of requiredRuns) {
    const index = runs.findIndex((run, position) => position >= cursor && run.includes(expected));
    assert.notEqual(index, -1, `${DEVELOPMENT_JOB} must run "${expected}" after the previous gate`);
    cursor = index;
  }
});

test('the offline release gate is wired exactly once, in the Node 22 job, and stays blocking', () => {
  const source = read(CI_REL);
  assert.equal(source.split(RELEASE_GATE_COMMAND).length - 1, 1, 'the offline release gate must be wired exactly once');
  const jobs = jobBlocks(source, 'ci.yml');
  const job = jobs.get(DEVELOPMENT_JOB);
  assert.ok(jobSource(job).includes(RELEASE_GATE_COMMAND), 'the release gate must live in the Node 22 development leg');
  for (const name of ['offline-node-18', 'offline-node-20']) {
    assert.ok(!jobSource(jobs.get(name)).includes('check:release'), `${name} must not gain the release gate without Chromium`);
  }
  assert.ok(!/continue-on-error/u.test(jobSource(job)), 'the Node 22 job must not tolerate a failing step');
  assert.ok(!/^ {8}if:/mu.test(jobSource(job)), 'the Node 22 job must not conditionally skip a step');
});

test('ci.yml keeps every action pinned to a full commit SHA with a version comment', () => {
  const references = actionReferences(read(CI_REL));
  assert.ok(references.length > 0, 'ci.yml must reference actions');
  for (const entry of references) {
    const match = ACTION_REFERENCE_RE.exec(entry.reference);
    assert.ok(match, `not an owner/repo@ref action reference: ${entry.reference}`);
    assert.match(match[3], COMMIT_SHA_RE, `mutable action ref "${match[3]}" in ${entry.reference}`);
    assert.match(entry.comment, /^v\d+\.\d+\.\d+$/u, `pinned action needs a vX.Y.Z comment: ${entry.reference}`);
    const expected = REQUIRED_PINS.get(`${match[1]}/${match[2]}`);
    if (expected) assert.equal(match[3], expected, `${match[1]}/${match[2]} must keep its Task 26 pin`);
  }
});

test('the release gate fails closed instead of reclassifying a failure as skipped', () => {
  const checkRelease = require(path.join(ROOT, 'tools', 'check-release.cjs'));
  assert.equal(typeof checkRelease.runGate, 'function', 'check-release must expose the gate runner');
  assert.equal(typeof checkRelease.runE2EGate, 'function', 'check-release must expose the e2e gate');
  const passing = checkRelease.runGate('probe-pass', [process.execPath, '-e', 'process.exit(0)'], 'probe');
  assert.equal(passing.verdict, 'PASS');
  const failing = checkRelease.runGate('probe-fail', [process.execPath, '-e', 'process.exit(7)'], 'probe');
  assert.equal(failing.verdict, 'FAIL');
  assert.equal(failing.exitCode, 7);
  const unrunnable = checkRelease.runGate('probe-missing', [path.join(ROOT, 'does-not-exist.cjs')], 'probe');
  assert.equal(unrunnable.verdict, 'FAIL', 'a gate that cannot execute must fail, never skip');
});

test('docs/DEVELOPMENT.md documents every required environment topic', () => {
  const markdown = read(DEVELOPMENT_REL);
  for (const heading of DEVELOPMENT_DOC_HEADINGS) {
    assert.ok(markdown.includes(heading), `docs/DEVELOPMENT.md must contain the "${heading}" section`);
  }
  const layout = section(markdown, DEVELOPMENT_DOC_HEADINGS[0]);
  for (const pattern of [/canonical checkout/iu, /read-only/iu, /never run/iu, /task worktree/iu, /worktree list/u, /evidence root/iu, /\.omo\//u, /gitignore/iu]) {
    assert.match(layout, pattern, `layout section must document ${pattern}`);
  }
  const nodeSection = section(markdown, DEVELOPMENT_DOC_HEADINGS[1]);
  for (const pattern of [/\.node-version/u, /22\.19\.0/u, /engines\.node/u, />=18/u, /npm@10\.9\.3/u, /offline-node-22/u, /informational/iu, /branch protection/iu, /required check/iu]) {
    assert.match(nodeSection, pattern, `Node selection section must document ${pattern}`);
  }
  const install = section(markdown, DEVELOPMENT_DOC_HEADINGS[2]);
  for (const pattern of [/npm ci/u, /npm install/u, /clone --shared/u]) {
    assert.match(install, pattern, `install section must document ${pattern}`);
  }
  const playwright = section(markdown, DEVELOPMENT_DOC_HEADINGS[3]);
  for (const pattern of [/npx playwright install --with-deps chromium/u, /test:browser/u, /test:e2e/u, /check:release -- --offline/u, /NOT_EXECUTED/u, /480 s/u]) {
    assert.match(playwright, pattern, `Playwright section must document ${pattern}`);
  }
  const backup = section(markdown, DEVELOPMENT_DOC_HEADINGS[4]);
  for (const pattern of [/npm run backup/u, /tools\/rollback\.cjs/u, /src\//u]) {
    assert.match(backup, pattern, `backup section must document ${pattern}`);
  }
  const provenance = section(markdown, DEVELOPMENT_DOC_HEADINGS[5]);
  for (const pattern of [/test-inventory\.cjs/u, /test-inventory\.test\.cjs/u, /test-suite-baseline\.json/u, /runtime-contract\.provenance\.json/u, /mutable manifest/u, /do not edit/iu, /npm run check/u]) {
    assert.match(provenance, pattern, `provenance section must document ${pattern}`);
  }
  const endings = section(markdown, DEVELOPMENT_DOC_HEADINGS[6]);
  for (const pattern of [/text=auto/u, /eol=lf/u, /core\.autocrlf/u, /git diff --check/u]) {
    assert.match(endings, pattern, `line-ending section must document ${pattern}`);
  }
  const ignorecase = section(markdown, DEVELOPMENT_DOC_HEADINGS[7]);
  for (const pattern of [/core\.ignorecase/u, /case-insensitive/iu, /git mv/u, /git ls-files/u]) {
    assert.match(ignorecase, pattern, `case-only rename section must document ${pattern}`);
  }
  const ownerData = section(markdown, DEVELOPMENT_DOC_HEADINGS[8]);
  for (const pattern of [/backups\//u, /never delete/iu, /test-results\//u, /git reset --hard/u]) {
    assert.match(ownerData, pattern, `owner-data section must document ${pattern}`);
  }
  const ext4 = section(markdown, DEVELOPMENT_DOC_HEADINGS[10]);
  for (const pattern of [/ext4/u, /optional/iu, /not required/iu, /must not be moved/iu]) {
    assert.match(ext4, pattern, `ext4 section must document ${pattern}`);
  }
});

test('docs/DEVELOPMENT.md protects the canonical checkout and stays machine-portable', () => {
  const markdown = read(DEVELOPMENT_REL);
  const canonical = section(markdown, DEVELOPMENT_DOC_HEADINGS[9]);
  for (const pattern of [/canonical/iu, /digest/iu, /never/iu, /identical/iu]) {
    assert.match(canonical, pattern, `canonical section must document ${pattern}`);
  }
  assert.ok(!markdown.includes('TravianAttackAlertDEV'), 'the public guide must never name the private DEV directory');
  for (const block of fencedBlocks(markdown)) {
    assert.doesNotMatch(block, /\/(?:mnt|home|Users)\//u, 'documented commands must not hardcode a machine-specific path');
    assert.doesNotMatch(block, /[A-Za-z]:\\/u, 'documented commands must not hardcode a Windows path');
  }
});

test('repository text stays LF-only with a final newline', () => {
  const attributes = read('.gitattributes');
  const wildcardRules = attributes.split('\n').filter((line) => /^\*\s/u.test(line));
  assert.equal(wildcardRules.length, 1, 'exactly one * rule expected');
  assert.match(wildcardRules[0], /text=auto/u);
  assert.match(wildcardRules[0], /eol=lf/u);
  for (const relative of ['.node-version', DEVELOPMENT_REL, CI_REL, path.join('test', 'tools', 'developer-workflow.test.cjs')]) {
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    assert.ok(bytes.length > 0, `${relative} must not be empty`);
    assert.equal(bytes.includes(0x0d), false, `${relative} must use LF line endings`);
    assert.equal(bytes[bytes.length - 1], 0x0a, `${relative} must end with a newline`);
    assert.equal(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), true, `${relative} must be valid UTF-8`);
  }
});

test('package.json ships no runtime dependencies and keeps devDependencies', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the browser userscript must ship without runtime dependencies');
  assert.ok(pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0, 'devDependencies must stay declared');
});
