#!/usr/bin/env node
'use strict';

// Deterministic release preparation — Task 28.
//
// `release:prepare` produces the exact seven-asset release contract from a
// CLEAN, TAGGED checkout. It is side-effect-bounded: the only writes are the
// generated build outputs (owned by tools/build.cjs) and the disposable,
// gitignored release directory. Every byte is derived from the tagged commit
// and deterministic tooling; running it twice at one commit is byte-identical.
//
// Fail-closed preconditions (all checked before any release write):
//   * package.json version is valid semver and the runtime declares exactly
//     RELEASE_VERSION = <version> and RELEASE_ID = taa-<version>;
//   * the annotated tag `v<version>` exists and points at the current HEAD;
//   * the tagged commit is contained in the allowed release branch
//     (`release/public-1.0.0` by default);
//   * the checkout is clean (no tracked modification, no untracked product
//     file) and the deterministic build does not mutate tracked state.
//
// Rejections carry a typed `code`: identity-mismatch, tag-missing,
// tag-not-annotated, tag-version-mismatch, checkout-not-tagged-commit,
// release-branch-missing, tag-off-release-branch, dirty-worktree,
// build-mutated-checkout, build-failed, nondeterministic-output,
// runtime-dependencies-present, sbom-runtime-dependency-misstatement,
// unsafe-output-path, unsafe-scratch-path.
//
// The SBOM is an SPDX-2.3 BUILD-dependency document. Its creation timestamp is
// SOURCE_DATE_EPOCH (derived from the tagged commit's committer date, never
// wall-clock time), and it states explicitly that the browser userscript has
// zero runtime package dependencies.
//
// Exit codes: 0 PASS, 1 verification FAIL, 2 usage/read error.
// Flags: --root <dir> --out <dir> --release-branch <name> --json
// Env:   TAA_ROOT TAA_RELEASE_BRANCH SOURCE_DATE_EPOCH TAA_RELEASE_TEST_NONDETERMINISM
//        TAA_RELEASE_ALLOW_EXTERNAL_OUT (explicit approval for a disposable
//        release directory outside the repository and the system temp dir)
// Dependencies: node:fs, node:path, node:os, node:crypto, node:child_process +
//               the existing tools/build.cjs and tools/check-release-readiness.cjs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readiness = require('./check-release-readiness.cjs');
const {
  ReleaseError,
  verifyReleaseDirectory,
  sha256,
  epochToSpdx,
  constants: C,
} = readiness;

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const DEFAULT_RELEASE_BRANCH = 'release/public-1.0.0';
const USAGE = [
  'Usage: node tools/prepare-release.cjs [options]',
  '  --root <dir>             project root (defaults to TAA_ROOT or the repository root)',
  '  --out <dir>              release output directory (defaults to <root>/release)',
  '  --release-branch <name>  allowed release branch (defaults to release/public-1.0.0)',
  '  --json                   emit machine-readable JSON',
].join('\n');

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function gitOrThrow(root, args, code, message) {
  const result = git(root, args);
  if (result.error) throw new ReleaseError('git-failed', `git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) throw new ReleaseError(code, `${message} (git ${args.join(' ')}: exit ${result.status})`);
  return String(result.stdout || '').trim();
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function validVersion(version) { return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || ''); }

function verifyIdentity(root, version, releaseId) {
  const runtime = fs.readFileSync(path.join(root, 'src', 'runtime.js'), 'utf8');
  const declaredVersion = /const RELEASE_VERSION = ["']([^"']+)["']/m.exec(runtime);
  const declaredId = /const RELEASE_ID = ["']([^"']+)["']/m.exec(runtime);
  if (!declaredVersion) throw new ReleaseError('identity-mismatch', 'src/runtime.js is missing RELEASE_VERSION');
  if (!declaredId) throw new ReleaseError('identity-mismatch', 'src/runtime.js is missing RELEASE_ID');
  if (declaredVersion[1] !== version) throw new ReleaseError('identity-mismatch', `src/runtime.js RELEASE_VERSION ${declaredVersion[1]} does not match package.json ${version}`);
  if (declaredId[1] !== releaseId) throw new ReleaseError('identity-mismatch', `src/runtime.js RELEASE_ID ${declaredId[1]} does not match ${releaseId}`);
}

function resolveReleaseRef(root, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const result = git(root, ['rev-parse', '--verify', '--quiet', ref]);
    if (result.status === 0 && String(result.stdout || '').trim()) return { ref, commit: String(result.stdout).trim() };
  }
  throw new ReleaseError('release-branch-missing', `allowed release branch is missing: ${branch}`);
}

function cleanWorktreeProblems(root, ignoredPaths) {
  const result = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (result.error) throw new ReleaseError('git-failed', `git status failed: ${result.error.message}`);
  if (result.status !== 0) throw new ReleaseError('git-failed', `git status exited ${result.status}`);
  const problems = [];
  for (const raw of String(result.stdout || '').split('\n')) {
    if (raw.length === 0) continue;
    const rel = raw.slice(3);
    if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue;
    if (ignoredPaths.some((ignored) => rel === ignored || rel.startsWith(`${ignored}/`))) continue;
    problems.push(raw);
  }
  return problems;
}

function assertClean(root, ignoredPaths, code, message) {
  const problems = cleanWorktreeProblems(root, ignoredPaths);
  if (problems.length > 0) throw new ReleaseError(code, `${message}: ${problems.slice(0, 5).join(' | ')}`);
}

function runBuild(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', 'build.cjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TAA_ROOT: root },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new ReleaseError('build-failed', `build failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new ReleaseError('build-failed', `build exited ${result.status}: ${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function spdxIdFor(name) { return `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]/g, '-')}`; }

function buildSbom({ packageJson, toolchain, version, releaseId, tag, commit, epoch }) {
  const dependencies = packageJson.dependencies || {};
  if (Object.keys(dependencies).length > 0) {
    throw new ReleaseError('runtime-dependencies-present', 'the userscript must declare zero runtime package dependencies');
  }
  const rootId = spdxIdFor(packageJson.name || 'travian-attack-alert');
  const nodeId = 'SPDXRef-Package-nodejs';
  const packages = [
    {
      SPDXID: rootId,
      name: packageJson.name || 'travian-attack-alert',
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: packageJson.license || 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      primaryPackagePurpose: 'APPLICATION',
      comment: `${C.ZERO_RUNTIME_DEPENDENCIES_STATEMENT} All browser code is bundled into ${C.USERSCRIPT}; no npm package is loaded at runtime.`,
    },
    {
      SPDXID: nodeId,
      name: 'node',
      versionInfo: `>=${toolchain.nodeMajor}`,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      primaryPackagePurpose: 'APPLICATION',
      comment: `Pinned build toolchain: Node.js major ${toolchain.nodeMajor} (package.json engines.node).`,
    },
  ];
  const devDependencies = Object.entries(packageJson.devDependencies || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, spec] of devDependencies) {
    packages.push({
      SPDXID: spdxIdFor(name),
      name,
      versionInfo: String(spec),
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      primaryPackagePurpose: 'LIBRARY',
      comment: `Pinned build dependency (package.json devDependencies: ${name}@${spec}).`,
    });
  }
  const relationships = [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
    { spdxElementId: nodeId, relationshipType: 'BUILD_DEPENDENCY_OF', relatedSpdxElement: rootId },
  ];
  for (const pkg of packages.slice(2)) relationships.push({ spdxElementId: pkg.SPDXID, relationshipType: 'BUILD_DEPENDENCY_OF', relatedSpdxElement: rootId });
  relationships.sort((a, b) => (`${a.spdxElementId}|${a.relationshipType}|${a.relatedSpdxElement}` < `${b.spdxElementId}|${b.relationshipType}|${b.relatedSpdxElement}` ? -1 : 1));
  return {
    spdxVersion: C.SPDX_VERSION,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${releaseId}-build-dependencies`,
    documentNamespace: `https://github.com/PeterPage2115/Travian-Attack-Alert/spdx/${releaseId}-${commit}`,
    creationInfo: {
      created: epochToSpdx(epoch),
      creators: ['Tool: tools/prepare-release.cjs'],
      comment: `Build-dependency SBOM for ${tag} (${releaseId}). ${C.ZERO_RUNTIME_DEPENDENCIES_STATEMENT} The document classifies every package relationship as BUILD_DEPENDENCY_OF.`,
    },
    packages,
    relationships,
    documentDescribes: [rootId],
  };
}

function digestEntry(dir, name) {
  const bytes = fs.readFileSync(path.join(dir, name));
  return { name, bytes: bytes.length, sha256: sha256(bytes) };
}

// Assemble one complete release directory from the current build outputs.
function assembleRelease({ root, out, packageJson, toolchain, version, releaseId, tag, source, nondeterministic }) {
  if (path.resolve(out) === path.resolve(root)) {
    throw new ReleaseError('unsafe-output-path', 'release assembly must never target the repository root');
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const dist = path.join(root, 'dist');
  const copies = [
    [path.join(dist, C.USERSCRIPT), C.USERSCRIPT],
    [path.join(dist, C.SIDECAR), C.SIDECAR],
    [path.join(root, C.METADATA), C.METADATA],
    [path.join(root, C.MODULE_MANIFEST), C.MODULE_MANIFEST],
  ];
  for (const [source_, name] of copies) fs.writeFileSync(path.join(out, name), fs.readFileSync(source_));

  const sbom = buildSbom({ packageJson, toolchain, version, releaseId, tag, commit: source.commit, epoch: source.sourceDateEpoch });
  if (nondeterministic) sbom.testNondeterminism = `wall-clock-${Date.now()}`;
  fs.writeFileSync(path.join(out, C.SBOM), json(sbom));

  const assets = C.PRIMARY_ASSETS.map((name) => digestEntry(out, name));
  const manifest = {
    schemaVersion: 1,
    version,
    releaseId,
    tag,
    source: {
      commit: source.commit,
      tree: source.tree,
      branch: source.branch,
      tagObject: source.tagObject,
      sourceDateEpoch: source.sourceDateEpoch,
    },
    toolchain,
    sbom: {
      file: C.SBOM,
      format: C.SPDX_VERSION,
      classification: C.SBOM_CLASSIFICATION,
      runtimeDependencies: 0,
      statement: C.ZERO_RUNTIME_DEPENDENCIES_STATEMENT,
    },
    assets,
  };
  fs.writeFileSync(path.join(out, C.RELEASE_MANIFEST), json(manifest));

  const sumsLines = C.SHA256SUMS_ASSETS.map((name) => `${digestEntry(out, name).sha256}  ${name}`);
  fs.writeFileSync(path.join(out, C.SHA256SUMS), `${sumsLines.join('\n')}\n`);
  return manifest;
}

function compareReleaseDirectories(a, b) {
  const list = (dir) => fs.readdirSync(dir).sort();
  const namesA = list(a);
  const namesB = list(b);
  if (namesA.join('\n') !== namesB.join('\n')) return false;
  for (const name of namesA) {
    if (!fs.readFileSync(path.join(a, name)).equals(fs.readFileSync(path.join(b, name)))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Destructive-path safety (PR #16 review).
//
// `assembleRelease` recursively removes its output directory before recreating
// it, and the determinism pass removes a scratch sibling. Both targets are
// therefore canonicalized and validated BEFORE any build or deletion:
//   * the repository root and any ancestor of it are refused;
//   * tracked files, and directories containing tracked files, are refused;
//   * an in-repository `--out` must be the designated gitignored release
//     directory (or a child of it); the scratch path must be its gitignored
//     sibling, so the clean-worktree exclusion only ever covers disposable
//     output;
//   * an external target must live under the system temp directory or be
//     explicitly approved with TAA_RELEASE_ALLOW_EXTERNAL_OUT=1;
//   * an existing target may hold nothing but the seven release asset names.
// ---------------------------------------------------------------------------

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function toPosix(rel) { return rel.split(path.sep).join('/'); }

// Resolve symlinks in the existing prefix and re-append the missing suffix, so
// a symlinked target cannot point validation at one directory and deletion at
// another.
function canonicalPath(target) {
  const resolved = path.resolve(target);
  let current = resolved;
  const suffix = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function trackedFiles(root) {
  const result = git(root, ['ls-files', '-z']);
  if (result.error) throw new ReleaseError('git-failed', `git ls-files failed: ${result.error.message}`);
  if (result.status !== 0) throw new ReleaseError('not-a-git-checkout', `release preparation requires a git checkout (git ls-files: exit ${result.status})`);
  return String(result.stdout || '').split('\0').filter(Boolean).map(toPosix);
}

function disposableEntriesProblem(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return null; // A missing target holds nothing to lose.
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return 'exists and is not a directory';
  const unexpected = fs.readdirSync(target).filter((name) => !C.ALL_ASSETS.includes(name));
  if (unexpected.length > 0) return `holds unrelated entries: ${unexpected.slice(0, 5).join(', ')}`;
  return null;
}

function validateDestructiveTarget({
  root,
  target,
  tracked,
  label,
  code,
  subtree = false,
  outDir = null,
  externalAllowed = process.env.TAA_RELEASE_ALLOW_EXTERNAL_OUT === '1',
}) {
  if (target === root) throw new ReleaseError(code, `${label} must not be the repository root`);
  if (isWithin(target, root)) throw new ReleaseError(code, `${label} must not contain the repository root`);
  if (isWithin(root, target)) {
    const rel = toPosix(path.relative(root, target));
    const clash = tracked.find((file) => file === rel || file.startsWith(`${rel}/`) || rel.startsWith(`${file}/`));
    if (clash) throw new ReleaseError(code, `${label} overlaps tracked path ${clash}`);
    if (subtree && rel !== 'release' && !rel.startsWith('release/')) {
      throw new ReleaseError(code, `${label} must be the release/ directory or a child of it`);
    }
    const ignored = git(root, ['check-ignore', '-q', '--', `${rel}/`]);
    if (ignored.error) throw new ReleaseError('git-failed', `git check-ignore failed: ${ignored.error.message}`);
    if (ignored.status !== 0) throw new ReleaseError(code, `${label} must be gitignored before it can be deleted as disposable`);
  } else if (!externalAllowed && !isWithin(canonicalPath(os.tmpdir()), target)) {
    throw new ReleaseError(code, `${label} is outside the repository and the system temp directory; set TAA_RELEASE_ALLOW_EXTERNAL_OUT=1 to approve a disposable external path`);
  }
  if (outDir !== null && path.dirname(target) !== path.dirname(outDir)) {
    throw new ReleaseError(code, `${label} must be a sibling of the release output ${outDir}`);
  }
  const problem = disposableEntriesProblem(target);
  if (problem) throw new ReleaseError(code, `${label} ${problem}`);
}

function prepareRelease(options) {
  const root = canonicalPath(options.root || ROOT);
  const out = canonicalPath(options.out || path.join(root, 'release'));
  const scratch = canonicalPath(`${out}-determinism-${process.pid}`);
  const releaseBranch = options.releaseBranch || process.env.TAA_RELEASE_BRANCH || DEFAULT_RELEASE_BRANCH;

  // Destructive-path safety first: refuse to erase tracked inputs or unrelated
  // directories BEFORE reading, building, or deleting anything.
  const tracked = trackedFiles(root);
  validateDestructiveTarget({ root, target: out, tracked, label: `--out ${out}`, code: 'unsafe-output-path', subtree: true });
  validateDestructiveTarget({ root, target: scratch, tracked, label: `determinism scratch ${scratch}`, code: 'unsafe-scratch-path', outDir: out });

  const packageJson = readJson(path.join(root, 'package.json'));
  const version = packageJson.version;
  if (!validVersion(version)) throw new ReleaseError('identity-mismatch', `package.json version is not valid semver: ${String(version)}`);
  const releaseId = `taa-${version}`;
  const tag = `v${version}`;
  if (options.tag && options.tag !== tag) throw new ReleaseError('tag-version-mismatch', `--tag ${options.tag} does not match v${version}`);

  verifyIdentity(root, version, releaseId);

  // Tag/ancestry checks.
  gitOrThrow(root, ['rev-parse', '--is-inside-work-tree'], 'not-a-git-checkout', 'release preparation requires a git checkout');
  const tagRef = `refs/tags/${tag}`;
  const tagObject = git(root, ['rev-parse', '--verify', '--quiet', tagRef]);
  if (tagObject.status !== 0 || !String(tagObject.stdout || '').trim()) throw new ReleaseError('tag-missing', `annotated tag ${tag} is missing`);
  const tagObjectId = String(tagObject.stdout).trim();
  const tagType = gitOrThrow(root, ['cat-file', '-t', tagRef], 'tag-missing', `tag ${tag} is unreadable`);
  if (tagType !== 'tag') throw new ReleaseError('tag-not-annotated', `tag ${tag} is lightweight; an annotated tag is required`);
  const taggedCommit = gitOrThrow(root, ['rev-parse', `${tagRef}^{commit}`], 'tag-missing', `tag ${tag} does not resolve to a commit`);
  const head = gitOrThrow(root, ['rev-parse', 'HEAD'], 'not-a-git-checkout', 'HEAD is unreadable');
  if (head !== taggedCommit) throw new ReleaseError('checkout-not-tagged-commit', `HEAD ${head} is not the tagged commit ${taggedCommit}`);
  const releaseRef = resolveReleaseRef(root, releaseBranch);
  const ancestry = git(root, ['merge-base', '--is-ancestor', taggedCommit, releaseRef.commit]);
  if (ancestry.error) throw new ReleaseError('git-failed', `merge-base failed: ${ancestry.error.message}`);
  if (ancestry.status !== 0) throw new ReleaseError('tag-off-release-branch', `tagged commit ${taggedCommit} is not contained in ${releaseBranch}`);

  const tree = gitOrThrow(root, ['rev-parse', `${taggedCommit}^{tree}`], 'git-failed', 'tagged tree is unreadable');
  const commitEpoch = Number(gitOrThrow(root, ['show', '-s', '--format=%ct', taggedCommit], 'git-failed', 'tagged commit timestamp is unreadable'));
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : commitEpoch;
  if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new ReleaseError('git-failed', `SOURCE_DATE_EPOCH is invalid: ${String(process.env.SOURCE_DATE_EPOCH)}`);
  const source = { commit: taggedCommit, tree, branch: releaseBranch, tagObject: tagObjectId, sourceDateEpoch };

  // Clean checkout, then build. The build must not mutate tracked state. The
  // exclusion below is safe because `out` was validated before this point: it
  // is either the gitignored release/ directory (or a child) or an approved
  // disposable external path.
  const ignoredPaths = isWithin(root, out) ? [toPosix(path.relative(root, out))] : [];
  assertClean(root, ignoredPaths, 'dirty-worktree', 'release preparation requires a clean checkout');
  runBuild(root);
  assertClean(root, ignoredPaths, 'build-mutated-checkout', 'deterministic build mutated tracked state');

  const metadata = readJson(path.join(root, C.METADATA));
  const toolchain = metadata.toolchain;
  if (!toolchain || typeof toolchain.esbuild !== 'string' || typeof toolchain.typescript !== 'string' || !Number.isInteger(toolchain.nodeMajor)) {
    throw new ReleaseError('build-failed', 'metadata.json toolchain is missing or malformed');
  }

  // Pass 1: final output directory. Pass 2: determinism scratch (byte-identical).
  const manifest = assembleRelease({ root, out, packageJson, toolchain, version, releaseId, tag, source, nondeterministic: false });
  try {
    runBuild(root);
    const nondeterministic = process.env.TAA_RELEASE_TEST_NONDETERMINISM === '1';
    assembleRelease({ root, out: scratch, packageJson, toolchain, version, releaseId, tag, source, nondeterministic });
    if (!compareReleaseDirectories(out, scratch)) {
      throw new ReleaseError('nondeterministic-output', 'two release preparations at the tagged commit were not byte-identical');
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const result = verifyReleaseDirectory(out);
  return { ...result, tagObject: tagObjectId, sourceDateEpoch, assets: manifest.assets };
}

function parseArgs(argv) {
  const options = { root: ROOT, out: null, releaseBranch: DEFAULT_RELEASE_BRANCH, tag: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--out') options.out = path.resolve(argv[++index] || '');
    else if (arg === '--release-branch') options.releaseBranch = argv[++index] || '';
    else if (arg === '--tag') options.tag = argv[++index] || '';
    else if (arg === '--json') options.json = true;
    else throw new ReleaseError('usage', `unknown argument: ${arg}\n${USAGE}`, 2);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 2;
    return;
  }
  try {
    const result = prepareRelease(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`RELEASE PREPARE PASS: ${result.releaseId} ${result.tag} ${result.assetCount} assets at ${result.directory}\n`);
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : 'internal-error';
    if (options.json) process.stdout.write(`${JSON.stringify({ verdict: 'FAIL', code, message: error.message }, null, 2)}\n`);
    else process.stderr.write(`RELEASE PREPARE FAIL: ${code}: ${error.message}\n`);
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 2;
  }
}

if (require.main === module) main();

module.exports = { prepareRelease, buildSbom, assembleRelease, parseArgs, validVersion, cleanWorktreeProblems, validateDestructiveTarget, canonicalPath };
