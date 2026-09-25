'use strict';

// Task 28 release asset and tag contract.
//
// `tools/prepare-release.cjs` builds the exact seven-asset release directory
// from a CLEAN, TAGGED checkout; `tools/check-release-readiness.cjs` rehashes a
// prepared directory and fails closed. These tests never create a tag on the
// real repository: every fixture is a DISPOSABLE temp clone with its own
// annotated tag, release branch and (optionally) deliberate defect.
//
// Covered: the happy path (seven declared assets, manifest/sums/SBOM contract,
// sidecar consistency), deterministic double-run byte identity, and fail-closed
// rejection of a lightweight tag, a wrong-version tag, a tag/HEAD mismatch, a
// missing release branch, an off-branch tagged commit, a dirty/untracked
// checkout, an identity mismatch, nondeterministic output, a build that mutates
// tracked state, runtime dependencies, and every release-directory corruption
// (missing/extra asset, digest/checksum/sidecar mismatch, SBOM misstatement or
// wall-clock timestamp, duplicate name, path traversal).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const PREPARE = path.join(ROOT, 'tools', 'prepare-release.cjs');
const CHECK = path.join(ROOT, 'tools', 'check-release-readiness.cjs');
const NODE_PATH = path.join(ROOT, 'node_modules');
const TIMEOUT_MS = 180000;

const USERSCRIPT = 'travian-attack-alert.user.js';
const SIDECAR = `${USERSCRIPT}.sha256`;
const PRIMARY = [USERSCRIPT, SIDECAR, 'metadata.json', 'module-manifest.json', 'sbom.spdx.json'];
const ALL_ASSETS = [...PRIMARY, 'release-manifest.json', 'SHA256SUMS'];
const STATEMENT = 'The browser userscript has zero runtime package dependencies.';

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function fixtureEnv(extra = {}) {
  const env = { ...process.env, NODE_PATH };
  delete env.SOURCE_DATE_EPOCH;
  delete env.TAA_RELEASE_BRANCH;
  delete env.TAA_RELEASE_TEST_NONDETERMINISM;
  return Object.assign(env, extra);
}

function runTool(tool, args, extraEnv = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: fixtureEnv(extraEnv),
    maxBuffer: 32 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });
}

function prepare(repo, out, extraArgs = [], extraEnv = {}) {
  return runTool(PREPARE, ['--root', repo, '--out', out, '--json', ...extraArgs], extraEnv);
}

function check(dir, extraEnv = {}) {
  return runTool(CHECK, ['--dir', dir, '--json'], extraEnv);
}

function git(repo, args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }

function refExists(repo, ref) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repo }).status === 0;
}

function cloneRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-release-fixture-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  execFileSync('git', ['clone', '--quiet', '--shared', ROOT, repo], { encoding: 'utf8' });
  // Context-independence: `clone --shared` inherits the parent's checked-out
  // branch (attached release/public-1.0.0, or a residual local branch while
  // the parent is detached). Detach HEAD and purge any inherited local
  // release branch so setReleaseBranch can never target a checked-out branch
  // and resolveReleaseRef cannot find a stale local ref the parent left
  // behind — the fixture must behave identically under any parent checkout.
  execFileSync('git', ['checkout', '--quiet', '--detach'], { cwd: repo });
  if (refExists(repo, 'refs/heads/release/public-1.0.0')) {
    execFileSync('git', ['update-ref', '-d', 'refs/heads/release/public-1.0.0'], { cwd: repo });
  }
  // Context-independence: a tag checkout (release workflow) carries the real
  // annotated release tag; `git clone` copies tags, so the fixture would fail
  // to create its own tag. Drop every inherited tag — the fixture creates its own.
  const inheritedTags = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/tags'])
    .split('\n').map((line) => line.trim()).filter(Boolean);
  for (const ref of inheritedTags) {
    execFileSync('git', ['update-ref', '-d', ref], { cwd: repo });
  }
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'TAA Release Fixture'], { cwd: repo });
  return { base, repo };
}

function setReleaseBranch(repo, target, branch = 'release/public-1.0.0') {
  execFileSync('git', ['branch', '-f', branch, target], { cwd: repo });
}

function annotate(repo, tag = 'v1.0.2') {
  execFileSync('git', ['tag', '-a', tag, '-m', `release ${tag}`], { cwd: repo });
}

function happyFixture(t) {
  const { base, repo } = cloneRepo(t);
  const head = git(repo, ['rev-parse', 'HEAD']);
  setReleaseBranch(repo, 'HEAD');
  annotate(repo);
  return { base, repo, head };
}

function listFiles(dir) { return fs.readdirSync(dir).sort(); }
function readManifest(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8')); }
function writeManifest(dir, manifest) { fs.writeFileSync(path.join(dir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); }

// Recompute every digest the manifest and SHA256SUMS declare, so a single
// targeted corruption is what the verifier sees (not an incidental digest drift).
function resign(dir) {
  const manifest = readManifest(dir);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(dir, asset.name));
    asset.bytes = bytes.length;
    asset.sha256 = sha256(bytes);
  }
  writeManifest(dir, manifest);
  const names = [...manifest.assets.map((asset) => asset.name), 'release-manifest.json'];
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${names.map((name) => `${sha256(fs.readFileSync(path.join(dir, name)))}  ${name}`).join('\n')}\n`);
}

function failCode(result) {
  assert.notEqual(result.status, 0, `expected a nonzero exit; stdout=${result.stdout} stderr=${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.verdict, 'FAIL');
  return parsed.code;
}

function prepareOk(repo, out) {
  const result = prepare(repo, out);
  assert.equal(result.status, 0, `prepare failed: stdout=${result.stdout} stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('Given package.json, when scripts are inspected, then release:prepare and release:check are registered', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['release:prepare'], 'node tools/prepare-release.cjs');
  assert.equal(pkg.scripts['release:check'], 'node tools/check-release-readiness.cjs');
});

test('Given .gitignore, when the release output is checked, then it is ignored and disposable', () => {
  execFileSync('git', ['check-ignore', '-q', 'release/release-manifest.json'], { cwd: ROOT });
  execFileSync('git', ['check-ignore', '-q', 'release-determinism-123/SHA256SUMS'], { cwd: ROOT });
});

// Regression (context-independence): the fixture must behave identically no
// matter which branch the parent checkout has checked out. CI runs detached
// with zero local branches; a developer parent may sit on
// release/public-1.0.0. `git clone --shared` inherits the parent's
// checked-out branch, which made `git branch -f` fail in setReleaseBranch and
// left a local refs/heads/release/public-1.0.0 that resolveReleaseRef finds
// before the remote ref — so the fixture must detach HEAD and purge that
// inherited local branch immediately after cloning.
test('Given a parent checkout, when cloneRepo runs, then the fixture is detached and free of the inherited release branch', (t) => {
  const { repo } = cloneRepo(t);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'fixture HEAD must be detached');
  assert.notEqual(
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/release/public-1.0.0'], { cwd: repo }).status,
    0,
    'fixture must not inherit a local refs/heads/release/public-1.0.0 branch',
  );
  setReleaseBranch(repo, 'HEAD');
  assert.equal(git(repo, ['rev-parse', 'refs/heads/release/public-1.0.0']), git(repo, ['rev-parse', 'HEAD']));
});

test('Given an annotated exact-version tag on the release branch, when prepared, then the seven declared assets are valid', (t) => {
  const { base, repo, head } = happyFixture(t);
  const out = path.join(base, 'release');
  const result = prepareOk(repo, out);

  assert.equal(result.assetCount, 7);
  assert.equal(result.releaseId, 'taa-1.0.2');
  assert.equal(result.tag, 'v1.0.2');
  assert.equal(result.commit, head);
  assert.deepEqual(listFiles(out), [...ALL_ASSETS].sort());

  const manifest = readManifest(out);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, '1.0.2');
  assert.equal(manifest.releaseId, 'taa-1.0.2');
  assert.equal(manifest.tag, 'v1.0.2');
  assert.equal(manifest.source.commit, head);
  assert.equal(manifest.source.branch, 'release/public-1.0.0');
  assert.deepEqual(manifest.assets.map((asset) => asset.name), PRIMARY);
  assert.deepEqual(manifest.toolchain, { esbuild: '0.25.9', typescript: '5.9.2', nodeMajor: 18 });
  assert.equal(manifest.sbom.classification, 'build-dependency');
  assert.equal(manifest.sbom.runtimeDependencies, 0);
  assert.equal(manifest.sbom.statement, STATEMENT);

  const userscript = fs.readFileSync(path.join(out, USERSCRIPT));
  assert.equal(manifest.assets[0].sha256, sha256(userscript));
  const sidecar = fs.readFileSync(path.join(out, SIDECAR), 'utf8');
  assert.match(sidecar, new RegExp(`^${sha256(userscript)} {2}dist/${USERSCRIPT.replace('.', '\\.')}\\n$`));

  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.deepEqual(sums.map((line) => line.slice(66)), [...PRIMARY, 'release-manifest.json']);
  assert.ok(!sums.some((line) => line.endsWith('SHA256SUMS')));

  const sbom = JSON.parse(fs.readFileSync(path.join(out, 'sbom.spdx.json'), 'utf8'));
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.creationInfo.created, new Date(Number(git(repo, ['show', '-s', '--format=%ct', 'HEAD'])) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const rootPackage = sbom.packages.find((pkg) => pkg.primaryPackagePurpose === 'APPLICATION');
  assert.match(rootPackage.comment, new RegExp(STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(sbom.relationships.every((rel) => rel.relationshipType === 'DESCRIBES' || rel.relationshipType === 'BUILD_DEPENDENCY_OF'));

  const verified = check(out);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verdict, 'PASS');
});

test('Given one tagged commit, when prepared twice, then both release directories are byte-identical', (t) => {
  const { base, repo } = happyFixture(t);
  const outA = path.join(base, 'release-a');
  const outB = path.join(base, 'release-b');
  prepareOk(repo, outA);
  prepareOk(repo, outB);
  assert.deepEqual(listFiles(outA), listFiles(outB));
  for (const name of listFiles(outA)) {
    assert.ok(fs.readFileSync(path.join(outA, name)).equals(fs.readFileSync(path.join(outB, name))), `${name} differs between runs`);
  }
});

test('Given a lightweight tag, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  setReleaseBranch(repo, 'HEAD');
  execFileSync('git', ['tag', 'v1.0.2'], { cwd: repo });
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'tag-not-annotated');
});

test('Given a wrong-version tag only, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  setReleaseBranch(repo, 'HEAD');
  annotate(repo, 'v1.0.0');
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'tag-missing');
});

test('Given a mismatched --tag flag, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = happyFixture(t);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'), ['--tag', 'v1.0.0'])), 'tag-version-mismatch');
});

test('Given a commit past the tag, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = happyFixture(t);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'post-tag commit'], { cwd: repo });
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'checkout-not-tagged-commit');
});

test('Given no release branch, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  annotate(repo);
  // resolveReleaseRef tries refs/heads/ before refs/remotes/origin/, so the
  // fixture must remove BOTH the inherited local branch (guard: it may already
  // be purged by cloneRepo) and the remote-tracking ref, each only when present.
  for (const ref of ['refs/heads/release/public-1.0.0', 'refs/remotes/origin/release/public-1.0.0']) {
    if (refExists(repo, ref)) {
      execFileSync('git', ['update-ref', '-d', ref], { cwd: repo });
    }
  }
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'release-branch-missing');
});

test('Given a tag on a commit outside the release branch, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  const head = git(repo, ['rev-parse', 'HEAD']);
  execFileSync('git', ['checkout', '-b', 'off-branch'], { cwd: repo });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'off-branch commit'], { cwd: repo });
  setReleaseBranch(repo, head);
  annotate(repo);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'tag-off-release-branch');
});

test('Given a modified tracked file, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = happyFixture(t);
  fs.appendFileSync(path.join(repo, 'README.md'), '\n');
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'dirty-worktree');
});

test('Given an untracked product file, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = happyFixture(t);
  fs.writeFileSync(path.join(repo, 'src', 'extra-module.js'), '// untracked\n');
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'dirty-worktree');
});

test('Given a runtime identity mismatch, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  // Version-relative successor: a hardcoded literal (it was '1.0.2' while the
  // tree sat at 1.0.1) rots on every bump — this test failed exactly that way
  // at 1.0.2 with "nothing to commit" — so derive it from the cloned identity.
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const mismatched = `${major}.${minor}.${patch + 1}`;
  pkg.version = mismatched;
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  execFileSync('git', ['commit', '-am', 'bump package only'], { cwd: repo });
  setReleaseBranch(repo, 'HEAD');
  annotate(repo, `v${mismatched}`);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'identity-mismatch');
});

test('Given nondeterministic second-run output, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = happyFixture(t);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'), [], { TAA_RELEASE_TEST_NONDETERMINISM: '1' })), 'nondeterministic-output');
});

test('Given a build that mutates tracked state, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  fs.appendFileSync(path.join(repo, 'dist', USERSCRIPT), '\n// stale committed artifact\n');
  execFileSync('git', ['commit', '-am', 'stale dist'], { cwd: repo });
  setReleaseBranch(repo, 'HEAD');
  annotate(repo);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'build-mutated-checkout');
});

test('Given declared runtime dependencies, when prepared, then preparation is rejected', (t) => {
  const { base, repo } = cloneRepo(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  pkg.dependencies = { 'left-pad': '1.0.0' };
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  execFileSync('git', ['commit', '-am', 'add runtime dependency'], { cwd: repo });
  setReleaseBranch(repo, 'HEAD');
  annotate(repo);
  assert.equal(failCode(prepare(repo, path.join(base, 'release'))), 'runtime-dependencies-present');
});

test('Given the repository root as --out, when prepared, then it is refused before anything is deleted', (t) => {
  const { repo } = happyFixture(t);
  const result = prepare(repo, repo);
  assert.equal(failCode(result), 'unsafe-output-path');
  for (const rel of ['package.json', 'README.md', 'src/runtime.js', 'dist', 'tools/prepare-release.cjs', '.git/HEAD']) {
    assert.ok(fs.existsSync(path.join(repo, rel)), `${rel} must survive a refused --out`);
  }
  assert.ok(fs.readdirSync(path.join(repo, 'src')).length > 0, 'src must not be emptied by a refused --out');
});

test('Given tracked files or tracked directories as --out, when prepared, then each is refused and the content survives', (t) => {
  const { repo } = happyFixture(t);
  for (const rel of ['src', 'dist', 'package.json']) {
    const result = prepare(repo, path.join(repo, rel));
    assert.equal(failCode(result), 'unsafe-output-path', `--out ${rel} must be refused as unsafe`);
    assert.ok(fs.existsSync(path.join(repo, rel)), `${rel} must survive a refused --out`);
  }
  assert.ok(fs.readdirSync(path.join(repo, 'src')).length > 0, 'src must still contain its tracked modules');
});

test('Given an existing external output directory with unrelated content, when prepared, then it is refused and nothing is deleted', (t) => {
  const { base, repo } = happyFixture(t);
  const external = fs.mkdtempSync(path.join(base, 'external-hold-'));
  fs.writeFileSync(path.join(external, 'unrelated-notes.txt'), 'keep me\n');
  const result = prepare(repo, external);
  assert.equal(failCode(result), 'unsafe-output-path');
  assert.equal(fs.readFileSync(path.join(external, 'unrelated-notes.txt'), 'utf8'), 'keep me\n');
});

test('Given an external output outside the system temp directory, when prepared, then it needs explicit disposable approval', (t) => {
  const { base, repo } = happyFixture(t);
  const fakeTmp = path.join(base, 'fake-tmp');
  fs.mkdirSync(fakeTmp);
  const external = path.join(base, 'outside', 'release');
  const refused = prepare(repo, external, [], { TMPDIR: fakeTmp });
  assert.equal(failCode(refused), 'unsafe-output-path');
  assert.ok(!fs.existsSync(external), 'a refused external output must not be created');
  const approved = prepare(repo, external, [], { TMPDIR: fakeTmp, TAA_RELEASE_ALLOW_EXTERNAL_OUT: '1' });
  assert.equal(approved.status, 0, `approved external output failed: stdout=${approved.stdout} stderr=${approved.stderr}`);
  assert.equal(JSON.parse(approved.stdout).assetCount, 7);
  assert.deepEqual(listFiles(external), [...ALL_ASSETS].sort());
});

test('Given an existing disposable release directory with exactly the seven assets, when prepared again, then the re-run is allowed', (t) => {
  const { base, repo } = happyFixture(t);
  const out = path.join(base, 'release');
  prepareOk(repo, out);
  const rerun = prepareOk(repo, out);
  assert.equal(rerun.assetCount, 7);
  assert.deepEqual(listFiles(out), [...ALL_ASSETS].sort());
});

test('Given the destructive-target validator, when a scratch or output path is unsafe, then every class is refused with its typed code', (t) => {
  const { validateDestructiveTarget } = require(PREPARE);
  const { repo } = happyFixture(t);
  const tracked = git(repo, ['ls-files']).split('\n');
  const probe = (code, args) => assert.throws(
    () => validateDestructiveTarget({ ...args, label: args.target, code }),
    (error) => error.code === code,
    `${args.target} must be refused with ${code}`,
  );

  probe('unsafe-output-path', { root: repo, target: repo, tracked, subtree: true });
  probe('unsafe-output-path', { root: repo, target: path.join(repo, 'src'), tracked, subtree: true });
  probe('unsafe-output-path', { root: repo, target: path.join(repo, 'dist'), tracked, subtree: true });
  probe('unsafe-output-path', { root: repo, target: path.join(repo, 'release'), tracked: [...tracked, 'release/forced.txt'], subtree: true });
  probe('unsafe-scratch-path', { root: repo, target: repo, tracked, subtree: false });
  probe('unsafe-scratch-path', { root: repo, target: path.join(repo, 'dist-determinism-1'), tracked, subtree: false });

  const polluted = path.join(repo, 'release-determinism-2');
  fs.mkdirSync(polluted);
  fs.writeFileSync(path.join(polluted, 'unrelated.txt'), 'x\n');
  probe('unsafe-scratch-path', { root: repo, target: polluted, tracked, subtree: false });

  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-targets-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(path.join(external, 'unrelated.txt'), 'x\n');
  probe('unsafe-output-path', { root: repo, target: external, tracked, subtree: false });

  const safeExternal = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-targets-ok-'));
  t.after(() => fs.rmSync(safeExternal, { recursive: true, force: true }));
  assert.doesNotThrow(() => validateDestructiveTarget({ root: repo, target: path.join(repo, 'release'), tracked, label: 'release', code: 'unsafe-output-path', subtree: true }));
  assert.doesNotThrow(() => validateDestructiveTarget({ root: repo, target: path.join(repo, 'release-determinism-1'), tracked, label: 'scratch', code: 'unsafe-scratch-path', subtree: false }));
  assert.doesNotThrow(() => validateDestructiveTarget({ root: repo, target: safeExternal, tracked, label: 'external', code: 'unsafe-output-path', subtree: false }));
});

test('Given no release directory, when checked, then release:check fails closed', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-release-missing-'));
  try {
    assert.equal(failCode(check(path.join(missing, 'release'))), 'missing-asset');
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

test('Given a prepared release, when each declared asset is corrupted, then release:check rejects the exact defect', (t) => {
  const { base, repo } = happyFixture(t);
  const out = path.join(base, 'release');
  prepareOk(repo, out);
  assert.equal(check(out).status, 0);

  // Missing asset.
  fs.rmSync(path.join(out, 'metadata.json'));
  assert.equal(failCode(check(out)), 'missing-asset');
  fs.copyFileSync(path.join(repo, 'metadata.json'), path.join(out, 'metadata.json'));

  // Extra asset.
  fs.writeFileSync(path.join(out, 'extra.txt'), 'undeclared\n');
  assert.equal(failCode(check(out)), 'unexpected-asset');
  fs.rmSync(path.join(out, 'extra.txt'));

  // Manifest digest mismatch (tampered userscript, untouched sums).
  const original = fs.readFileSync(path.join(out, USERSCRIPT));
  fs.appendFileSync(path.join(out, USERSCRIPT), '\n// tampered\n');
  assert.equal(failCode(check(out)), 'digest-mismatch');
  fs.writeFileSync(path.join(out, USERSCRIPT), original);

  // SHA256SUMS mismatch (manifest digests still valid).
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.replace(/^[0-9a-f]{64}/m, 'f'.repeat(64)));
  assert.equal(failCode(check(out)), 'checksum-mismatch');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums);

  // Duplicate SHA256SUMS entry.
  const lines = sums.trim().split('\n');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${[...lines, lines[0]].join('\n')}\n`);
  assert.equal(failCode(check(out)), 'duplicate-asset');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums);

  // Path traversal in SHA256SUMS.
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.replace(USERSCRIPT, '../escape.user.js'));
  assert.equal(failCode(check(out)), 'path-traversal');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums);

  // Sidecar mismatch (resigned so only the sidecar consistency check fires).
  fs.writeFileSync(path.join(out, SIDECAR), `${'a'.repeat(64)}  dist/${USERSCRIPT}\n`);
  resign(out);
  assert.equal(failCode(check(out)), 'sidecar-mismatch');

  // Restore a clean sidecar by regenerating from the userscript.
  fs.writeFileSync(path.join(out, SIDECAR), `${sha256(fs.readFileSync(path.join(out, USERSCRIPT)))}  dist/${USERSCRIPT}\n`);
  resign(out);
  assert.equal(check(out).status, 0);

  // SBOM runtime-dependency misstatement (resigned).
  const sbom = JSON.parse(fs.readFileSync(path.join(out, 'sbom.spdx.json'), 'utf8'));
  sbom.relationships.push({ spdxElementId: 'SPDXRef-Package-esbuild', relationshipType: 'RUNTIME_DEPENDENCY_OF', relatedSpdxElement: sbom.documentDescribes[0] });
  fs.writeFileSync(path.join(out, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
  resign(out);
  assert.equal(failCode(check(out)), 'sbom-runtime-dependency-misstatement');

  // SBOM wall-clock timestamp (resigned).
  delete sbom.relationships[sbom.relationships.length - 1];
  sbom.creationInfo.created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(path.join(out, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
  resign(out);
  assert.equal(failCode(check(out)), 'sbom-timestamp-mismatch');
});

test('Given crafted manifests, when the library verifier is called, then structural attacks fail closed', () => {
  const readiness = require(CHECK);
  const base = { schemaVersion: 1, version: '1.0.2', releaseId: 'taa-1.0.2', tag: 'v1.0.2', source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), branch: 'release/public-1.0.0', sourceDateEpoch: 0 }, toolchain: { esbuild: '0.25.9', typescript: '5.9.2', nodeMajor: 18 }, sbom: { file: 'sbom.spdx.json', format: 'SPDX-2.3', classification: 'build-dependency', runtimeDependencies: 0, statement: STATEMENT }, assets: PRIMARY.map((name) => ({ name, bytes: 1, sha256: 'c'.repeat(64) })) };
  assert.doesNotThrow(() => readiness.verifyManifest(base));
  const selfReferential = structuredClone(base);
  selfReferential.assets[4] = { name: 'SHA256SUMS', bytes: 1, sha256: 'c'.repeat(64) };
  assert.throws(() => readiness.verifyManifest(selfReferential), /not a plain basename|must not digest/);
  const traversal = structuredClone(base);
  traversal.assets[0] = { name: '../escape', bytes: 1, sha256: 'c'.repeat(64) };
  assert.throws(() => readiness.verifyManifest(traversal), (error) => error.code === 'path-traversal');
  const duplicate = structuredClone(base);
  duplicate.assets[1] = { name: PRIMARY[0], bytes: 1, sha256: 'c'.repeat(64) };
  assert.throws(() => readiness.verifyManifest(duplicate), (error) => error.code === 'malformed-release-manifest' || error.code === 'duplicate-asset');
  assert.throws(() => readiness.parseSha256Sums(`${'d'.repeat(64)}  a\n${'d'.repeat(64)}  a\n`), (error) => error.code === 'duplicate-asset');
  assert.throws(() => readiness.parseSha256Sums(`${'d'.repeat(64)}  ../x\n`), (error) => error.code === 'path-traversal');
});
