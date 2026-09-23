'use strict';

// Task 26 workflow supply-chain contract.
//
// Every workflow under .github/workflows/ must be read-only and immutable:
//   - each `uses:` is owner/repo@<full 40-char commit SHA> plus a stable
//     version comment, from an allowlisted official owner;
//   - workflow-level permissions stay `contents: read` with no write scope and
//     no secret access anywhere;
//   - `pull_request_target` is forbidden;
//   - every job is bounded by a timeout-minutes ceiling;
//   - artifact names, retention, failure policy, the four required check
//     names, the release-branch trigger, and the Task 6 / Task 18 evidence and
//     characterization steps are preserved.
//
// .github/dependabot.yml must declare weekly npm + github-actions updates at
// the repository root with bounded open pull requests, grouped non-major
// development updates, and no automatic merge policy.
//
// All parsing is local and offline. Set TAA_REPO_ROOT to run the same contract
// against a mutated repository copy (the adversarial harness does exactly
// that); malformed input fails closed instead of being skipped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = process.env.TAA_REPO_ROOT
  ? path.resolve(process.env.TAA_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');

const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const DEPENDABOT_REL = path.join('.github', 'dependabot.yml');
const DEPENDABOT_PATH = path.join(ROOT, DEPENDABOT_REL);

const REQUIRED_JOBS = ['offline-node-18', 'offline-node-20', 'browser-node-20', 'cross-node-determinism'];
const RELEASE_BRANCH = 'release/public-1.0.0';
const RELEASE_WORKFLOW_NAME = 'release.yml';
const ALLOWED_ACTION_OWNERS = ['actions'];
const ACTION_REFERENCE_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@(\S+)$/u;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/u;
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+$/u;
const MAX_JOB_TIMEOUT_MINUTES = 120;
const MAX_OPEN_PULL_REQUESTS = 10;
const PUBLISH_SIGNATURES = [
  /npm\s+publish/u,
  /gh\s+release\s+create/u,
  /action-gh-release/u,
  /docker\s+push/u,
  /git\s+push/u,
];
const AUTOMERGE_SIGNATURES = [
  /auto-?merge/iu,
  /gh\s+pr\s+merge/u,
  /pascalgn\/automerge/u,
  /dependabot\/fetch-metadata/u,
];
const EXPECTED_UPLOADS = [
  { job: 'offline-node-18', name: 'determinism-node-18' },
  { job: 'offline-node-20', name: 'determinism-node-20' },
  { job: 'browser-node-20', name: 'browser-node-20-evidence' },
  { job: 'cross-node-determinism', name: 'ci-identity' },
];
const EXPECTED_DOWNLOADS = [
  { job: 'cross-node-determinism', name: 'determinism-node-18' },
  { job: 'cross-node-determinism', name: 'determinism-node-20' },
];
const EXPECTED_RETENTION_DAYS = 14;

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function workflowNames() {
  assert.ok(fs.existsSync(WORKFLOW_DIR), 'repository must contain .github/workflows/');
  const names = fs.readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/u.test(name)).sort();
  assert.ok(names.length > 0, '.github/workflows/ must contain at least one workflow');
  return names;
}

function workflowSources() {
  return workflowNames().map((name) => ({
    name,
    relative: path.join('.github', 'workflows', name),
    source: fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8'),
  }));
}

function parseWorkflow(source, file) {
  const jobs = new Map();
  let current = null;
  let inJobs = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^jobs:\s*$/u.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\S/u.test(line)) { inJobs = false; current = null; continue; }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) { current = { name: header[1], lines: [] }; jobs.set(header[1], current); continue; }
    assert.ok(current, `${file}: unexpected line inside jobs: ${line}`);
    current.lines.push(line);
  }
  return jobs;
}

function parseStepFields(lines) {
  const step = { name: null, id: null, condition: null, uses: null, run: '', with: {}, env: {}, continueOnError: false };
  let mode = null;
  let map = null;
  let blockKey = null;
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (mode === 'run') {
      if (indent >= 4) { step.run += `${line.trim()}\n`; continue; }
      mode = null;
    }
    if (mode === 'block') {
      if (indent >= 6) { map[blockKey] += `${line.trim()}\n`; continue; }
      mode = 'map';
    }
    if (mode === 'map') {
      const key = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
      if (key) {
        if (key[2] === '|') { blockKey = key[1]; map[blockKey] = ''; mode = 'block'; }
        else map[key[1]] = key[2].trim();
        continue;
      }
      mode = null;
    }
    const scalar = /^ {2}(name|id|if|uses|continue-on-error|run|timeout-minutes):\s*(.*)$/u.exec(line);
    if (scalar) {
      const key = scalar[1];
      const value = scalar[2];
      if (key === 'run') {
        if (value === '|' || value === '>') { step.run = ''; mode = 'run'; } else step.run = value.trim();
      } else if (key === 'name') step.name = value.trim();
      else if (key === 'id') step.id = value.trim();
      else if (key === 'if') step.condition = value.trim();
      else if (key === 'uses') step.uses = value.trim();
      else if (key === 'timeout-minutes') step.timeoutMinutes = value.trim();
      else if (key === 'continue-on-error') step.continueOnError = value.trim() === 'true';
      continue;
    }
    const header = /^ {2}(with|env):\s*$/u.exec(line);
    if (header) {
      map = header[1] === 'with' ? step.with : step.env;
      mode = 'map';
      continue;
    }
    assert.fail(`unexpected step line: ${line}`);
  }
  return step;
}

function parseSteps(job) {
  const stepsIndex = job.lines.findIndex((line) => /^ {4}steps:\s*$/u.test(line));
  if (stepsIndex === -1) return [];
  const steps = [];
  let current = null;
  for (let index = stepsIndex + 1; index < job.lines.length; index += 1) {
    const line = job.lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length < 4) break;
    if (/^ {6}- /u.test(line)) {
      current = { lines: [`  ${line.slice(8)}`] };
      steps.push(current);
      continue;
    }
    assert.ok(current, `step content before any step in job ${job.name}: ${line}`);
    current.lines.push(line.slice(6));
  }
  return steps.map((step) => parseStepFields(step.lines));
}

function jobTimeoutMinutes(job) {
  const matches = job.lines
    .map((line) => /^ {4}timeout-minutes:\s*(\S+)\s*$/u.exec(line))
    .filter(Boolean);
  if (matches.length === 0) return null;
  assert.equal(matches.length, 1, `job ${job.name} must declare timeout-minutes exactly once`);
  assert.match(matches[0][1], /^\d+$/u, `job ${job.name} timeout-minutes must be an integer`);
  return Number(matches[0][1]);
}

function parseOnBlock(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  assert.notEqual(start, -1, 'workflow must declare a top-level on: block');
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && /^\S/u.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block;
}

function eventBranches(onBlock, event) {
  const index = onBlock.indexOf(`  ${event}:`);
  assert.notEqual(index, -1, `on: block must declare ${event}`);
  const branches = /^ {4}branches:\s*\[([^\]]*)\]\s*$/u.exec(onBlock[index + 1] ?? '');
  assert.ok(branches, `${event} must declare a single-line branches list`);
  return branches[1].split(',').map((entry) => entry.trim()).filter(Boolean);
}

function collectActionReferences(source, file) {
  const references = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    const match = /^(\s*)uses:\s+(\S+)(?:\s+#\s*(.*?))?\s*$/u.exec(line);
    if (!match) return;
    references.push({
      file,
      line: index + 1,
      reference: match[2],
      comment: (match[3] ?? '').trim(),
    });
  });
  return references;
}

function allActionReferences() {
  return workflowSources().flatMap((workflow) => collectActionReferences(workflow.source, workflow.relative));
}

function parseScalar(text) {
  const trimmed = text.trim();
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const array = /^\[(.*)\]$/u.exec(trimmed);
  if (array) return array[1].split(',').map((entry) => entry.trim()).filter(Boolean);
  const quoted = /^"([^"]*)"$|^'([^']*)'$/u.exec(trimmed);
  return quoted ? (quoted[1] ?? quoted[2]) : trimmed;
}

function parseYamlSubset(source, file) {
  const tokens = [];
  source.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.replace(/\s+$/u, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    assert.equal(indent % 2, 0, `${file}:${index + 1}: indentation must be a multiple of two`);
    tokens.push({ indent, text: line.trim(), line: index + 1 });
  });
  let position = 0;

  function parseBlock(indent) {
    if (position < tokens.length && tokens[position].indent === indent && tokens[position].text.startsWith('- ')) {
      const items = [];
      while (position < tokens.length && tokens[position].indent === indent && tokens[position].text.startsWith('- ')) {
        const itemText = tokens[position].text.slice(2).trim();
        position += 1;
        const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(itemText);
        if (!pair) {
          assert.notEqual(itemText, '', `${file}: empty list item`);
          items.push(parseScalar(itemText));
          continue;
        }
        const item = {};
        if (pair[2] === '') item[pair[1]] = parseBlock(indent + 2);
        else item[pair[1]] = parseScalar(pair[2]);
        while (position < tokens.length && tokens[position].indent === indent + 2 && !tokens[position].text.startsWith('- ')) {
          const token = tokens[position];
          position += 1;
          const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(token.text);
          assert.ok(pair, `${file}:${token.line}: malformed mapping entry "${token.text}"`);
          if (pair[2] === '') item[pair[1]] = parseBlock(indent + 4);
          else item[pair[1]] = parseScalar(pair[2]);
        }
        items.push(item);
      }
      return items;
    }
    const map = {};
    while (position < tokens.length && tokens[position].indent === indent && !tokens[position].text.startsWith('- ')) {
      const token = tokens[position];
      position += 1;
      const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(token.text);
      assert.ok(pair, `${file}:${token.line}: malformed mapping entry "${token.text}"`);
      if (pair[2] === '') map[pair[1]] = parseBlock(indent + 2);
      else map[pair[1]] = parseScalar(pair[2]);
    }
    return map;
  }

  const document = parseBlock(0);
  assert.equal(position, tokens.length, `${file}: unparsed YAML remains at line ${tokens[position]?.line ?? '?'}`);
  return document;
}

function readDependabot() {
  assert.ok(fs.existsSync(DEPENDABOT_PATH), '.github/dependabot.yml must exist');
  return parseYamlSubset(fs.readFileSync(DEPENDABOT_PATH, 'utf8'), DEPENDABOT_REL);
}

function dependabotEntries(config) {
  assert.equal(config.version, 2, 'dependabot.yml must declare version: 2');
  assert.ok(Array.isArray(config.updates), 'dependabot.yml must declare an updates list');
  assert.ok(config.updates.length > 0, 'dependabot.yml updates list must not be empty');
  return config.updates;
}

test('workflow declares exactly the four required check job names', () => {
  const jobs = parseWorkflow(read(path.join('.github', 'workflows', 'ci.yml')), 'ci.yml');
  assert.deepEqual([...jobs.keys()].sort(), [...REQUIRED_JOBS].sort());
});

test('workflow triggers target only the release branch and never pull_request_target', () => {
  for (const workflow of workflowSources()) {
    assert.doesNotMatch(workflow.source, /^\s*pull_request_target\s*:/mu, `${workflow.relative} must not use pull_request_target`);
    if (workflow.name === RELEASE_WORKFLOW_NAME) {
      // release.yml is the owner-gated tag-only pipeline. Its full trigger
      // contract is owned by test/tools/release-workflow.test.cjs; this test only
      // pins that it can never gain a branch or PR trigger.
      assert.doesNotMatch(workflow.source, /^\s{2}(pull_request|workflow_dispatch|schedule|workflow_run|repository_dispatch):/mu, `${workflow.relative} must stay tag-only`);
      assert.doesNotMatch(workflow.source, /^\s{4}branches:/mu, `${workflow.relative} must not trigger on branches`);
      continue;
    }
    const onBlock = parseOnBlock(workflow.source);
    assert.deepEqual(eventBranches(onBlock, 'pull_request'), [RELEASE_BRANCH], `${workflow.relative} pull_request branch trigger changed`);
    assert.deepEqual(eventBranches(onBlock, 'push'), [RELEASE_BRANCH], `${workflow.relative} push branch trigger changed`);
  }
});

test('workflow keeps workflow-level read-only permissions and grants no write scope', () => {
  for (const workflow of workflowSources()) {
    if (workflow.name === RELEASE_WORKFLOW_NAME) {
      // release.yml denies every scope by default and grants exact per-job
      // scopes; the separation contract is owned by release-workflow.test.cjs.
      assert.match(workflow.source, /^permissions:\s*\{\}\s*$/mu, `${workflow.relative} must deny all default permissions`);
      continue;
    }
    const lines = workflow.source.split(/\r?\n/u);
    const start = lines.findIndex((line) => /^permissions:\s*$/u.test(line));
    assert.notEqual(start, -1, `${workflow.relative} must declare workflow-level permissions`);
    const block = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].trim() !== '' && /^\S/u.test(lines[index])) break;
      if (lines[index].trim() !== '') block.push(lines[index].trim());
    }
    assert.deepEqual(block, ['contents: read'], `${workflow.relative} workflow permissions must stay exactly contents: read`);
    const permissionLines = lines.filter((line) => /^\s*permissions\s*:/u.test(line));
    assert.equal(permissionLines.length, 1, `${workflow.relative} must not override permissions per job`);
    assert.doesNotMatch(workflow.source, /^\s*[A-Za-z0-9_-]+:\s*write(-all)?\s*$/mu, `${workflow.relative} must not grant any write scope`);
    assert.doesNotMatch(workflow.source, /^\s*permissions:\s*(read-all|write-all)\s*$/mu, `${workflow.relative} must not use a permission shorthand`);
  }
});

test('no workflow can receive repository secrets', () => {
  for (const workflow of workflowSources()) {
    if (workflow.name === RELEASE_WORKFLOW_NAME) {
      // release.yml may reference ONLY the two environment-scoped release
      // secrets (available only after the protected environment approves).
      const names = [...workflow.source.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
      assert.deepEqual(
        [...new Set(names)].sort(),
        ['TAA_RELEASE_APPROVAL_PROOF', 'TAA_RELEASE_SETTINGS_READ_TOKEN'],
        `${workflow.relative} may only reference the two release environment secrets`,
      );
      continue;
    }
    assert.doesNotMatch(workflow.source, /\bsecrets\./u, `${workflow.relative} must not reference repository secrets`);
  }
});

test('every action reference uses an allowlisted official owner and repository', () => {
  const references = allActionReferences();
  assert.ok(references.length > 0, 'workflows must reference actions');
  for (const entry of references) {
    const match = ACTION_REFERENCE_RE.exec(entry.reference);
    assert.ok(match, `${entry.file}:${entry.line}: not an owner/repo@ref action reference: ${entry.reference}`);
    assert.ok(
      ALLOWED_ACTION_OWNERS.includes(match[1]),
      `${entry.file}:${entry.line}: unexpected action owner ${match[1]} in ${entry.reference}`,
    );
    assert.ok(match[2].length > 0, `${entry.file}:${entry.line}: missing action repository name`);
  }
});

test('every action reference is pinned to a full lowercase 40-character commit SHA', () => {
  const references = allActionReferences();
  for (const entry of references) {
    const match = ACTION_REFERENCE_RE.exec(entry.reference);
    assert.ok(match, `${entry.file}:${entry.line}: malformed action reference: ${entry.reference}`);
    assert.match(
      match[3],
      COMMIT_SHA_RE,
      `${entry.file}:${entry.line}: mutable or non-full action ref "${match[3]}" in ${entry.reference}`,
    );
  }
});

test('every pinned action retains a stable version comment', () => {
  const references = allActionReferences();
  for (const entry of references) {
    assert.match(
      entry.comment,
      VERSION_COMMENT_RE,
      `${entry.file}:${entry.line}: pinned action needs a vX.Y.Z version comment (got "${entry.comment}")`,
    );
  }
});

test('every job is bounded by a timeout-minutes ceiling', () => {
  for (const workflow of workflowSources()) {
    const jobs = parseWorkflow(workflow.source, workflow.relative);
    assert.ok(jobs.size > 0, `${workflow.relative} must declare jobs`);
    for (const job of jobs.values()) {
      const timeout = jobTimeoutMinutes(job);
      assert.notEqual(timeout, null, `${workflow.relative} job ${job.name} is unbounded (missing timeout-minutes)`);
      assert.ok(timeout >= 1, `${workflow.relative} job ${job.name} timeout-minutes must be positive`);
      assert.ok(
        timeout <= MAX_JOB_TIMEOUT_MINUTES,
        `${workflow.relative} job ${job.name} timeout-minutes ${timeout} exceeds the ${MAX_JOB_TIMEOUT_MINUTES} ceiling`,
      );
    }
  }
});

test('no workflow cancels in-progress runs in a way that could drop evidence', () => {
  for (const workflow of workflowSources()) {
    assert.doesNotMatch(workflow.source, /^\s*cancel-in-progress:\s*true\s*$/mu, `${workflow.relative} must not cancel in-progress evidence`);
  }
});

test('artifact names, retention, and failure policy are unchanged', () => {
  const jobs = parseWorkflow(read(path.join('.github', 'workflows', 'ci.yml')), 'ci.yml');
  const uploads = [];
  const downloads = [];
  for (const job of jobs.values()) {
    for (const step of parseSteps(job)) {
      if (step.uses && step.uses.startsWith('actions/upload-artifact@')) uploads.push({ job: job.name, step });
      if (step.uses && step.uses.startsWith('actions/download-artifact@')) downloads.push({ job: job.name, step });
    }
  }
  assert.deepEqual(
    uploads.map((entry) => ({ job: entry.job, name: entry.step.with.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [...EXPECTED_UPLOADS].sort((a, b) => a.name.localeCompare(b.name)),
    'uploaded artifact names must not change',
  );
  for (const entry of uploads) {
    assert.equal(entry.step.with['if-no-files-found'], 'error', `${entry.step.with.name} must fail when files are missing`);
    assert.equal(Number(entry.step.with['retention-days']), EXPECTED_RETENTION_DAYS, `${entry.step.with.name} retention must stay ${EXPECTED_RETENTION_DAYS} days`);
  }
  assert.deepEqual(
    downloads.map((entry) => ({ job: entry.job, name: entry.step.with.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [...EXPECTED_DOWNLOADS].sort((a, b) => a.name.localeCompare(b.name)),
    'downloaded artifact names must not change',
  );
});

test('Task 6 sealed-evidence steps are preserved with always() gating', () => {
  const jobs = parseWorkflow(read(path.join('.github', 'workflows', 'ci.yml')), 'ci.yml');
  const browser = jobs.get('browser-node-20');
  assert.ok(browser, 'browser-node-20 job must exist');
  const steps = parseSteps(browser);
  for (const id of ['evidence-seal', 'evidence-scan', 'evidence-digest']) {
    const step = steps.find((candidate) => candidate.id === id);
    assert.ok(step, `browser job must keep step id ${id}`);
    assert.equal(step.condition, 'always()', `step ${id} must stay gated on always()`);
  }
});

test('Task 18 characterization receipts remain blocking in both offline jobs', () => {
  const jobs = parseWorkflow(read(path.join('.github', 'workflows', 'ci.yml')), 'ci.yml');
  for (const name of ['offline-node-18', 'offline-node-20']) {
    const job = jobs.get(name);
    assert.ok(job, `${name} job must exist`);
    const step = parseSteps(job).find((candidate) => /npm run test:characterization/u.test(candidate.run));
    assert.ok(step, `${name} must keep the blocking characterization step`);
    assert.equal(step.continueOnError, false, `${name} characterization step must stay blocking`);
  }
});

test('no workflow can publish or release', () => {
  for (const workflow of workflowSources()) {
    if (workflow.name === RELEASE_WORKFLOW_NAME) {
      // release.yml publishes ONLY through the environment-gated publish job; the
      // full mutation/idempotency contract is owned by release-workflow.test.cjs.
      assert.match(workflow.source, /^\s{4}environment:\s*release\s*$/mu, `${workflow.relative} publication must be environment-gated`);
      continue;
    }
    for (const signature of PUBLISH_SIGNATURES) {
      assert.doesNotMatch(workflow.source, signature, `${workflow.relative} must not publish or release`);
    }
  }
});

test('dependabot declares exactly npm and github-actions at the repository root', () => {
  const entries = dependabotEntries(readDependabot());
  const ecosystems = entries.map((entry) => entry['package-ecosystem']).sort();
  assert.deepEqual(ecosystems, ['github-actions', 'npm'], 'dependabot must track npm and github-actions');
  for (const entry of entries) {
    assert.equal(entry.directory, '/', `dependabot ${entry['package-ecosystem']} must target the repository root`);
  }
});

test('dependabot updates run weekly with bounded open pull requests', () => {
  for (const entry of dependabotEntries(readDependabot())) {
    assert.equal(entry.schedule?.interval, 'weekly', `dependabot ${entry['package-ecosystem']} must run weekly`);
    const limit = entry['open-pull-requests-limit'];
    assert.ok(Number.isInteger(limit), `dependabot ${entry['package-ecosystem']} needs a numeric open-pull-requests-limit`);
    assert.ok(limit >= 1 && limit <= MAX_OPEN_PULL_REQUESTS, `dependabot ${entry['package-ecosystem']} open-pull-requests-limit must be 1..${MAX_OPEN_PULL_REQUESTS}`);
  }
});

test('dependabot groups non-major development updates', () => {
  const entries = dependabotEntries(readDependabot());
  const npm = entries.find((entry) => entry['package-ecosystem'] === 'npm');
  const actions = entries.find((entry) => entry['package-ecosystem'] === 'github-actions');
  const npmGroups = Object.values(npm?.groups ?? {});
  assert.ok(
    npmGroups.some((group) => group['dependency-type'] === 'development'
      && group['update-types']?.includes('minor')
      && group['update-types']?.includes('patch')),
    'npm updates must group non-major development bumps (dependency-type development, minor + patch)',
  );
  const actionGroups = Object.values(actions?.groups ?? {});
  assert.ok(
    actionGroups.some((group) => group['update-types']?.includes('minor') && group['update-types']?.includes('patch')),
    'github-actions updates must group non-major bumps (minor + patch)',
  );
});

test('no automatic merge policy exists for dependency updates', () => {
  const sources = [{ name: DEPENDABOT_REL, source: fs.readFileSync(DEPENDABOT_PATH, 'utf8') }, ...workflowSources()];
  for (const entry of sources) {
    for (const signature of AUTOMERGE_SIGNATURES) {
      assert.doesNotMatch(entry.source, signature, `${entry.name} must not contain an automatic merge policy`);
    }
  }
});
