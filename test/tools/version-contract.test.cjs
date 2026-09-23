'use strict';

// Version-contract gate (Task 24): every current version authority must agree
// with package.json, and a partial bump must fail closed with the exact
// authority path. tools/check-versions.cjs is the single verifier; this suite
// drives it against throwaway fixture copies, mutating exactly one authority
// at a time, so each failure is attributed to the file that drifted instead of
// being masked by a blanket PASS. The frozen historical provenance
// (runtime-contract.provenance.json) is deliberately NOT re-derived here: it
// audits the archived 1.0.0 contract, while this suite audits the live one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECK = path.join(ROOT, 'tools', 'check-versions.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(pkg.version);
const RELEASE_ID = `taa-${VERSION}`;

function nextPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
const BUMPED = nextPatch(VERSION);
const BUMPED_ID = `taa-${BUMPED}`;

// Every file tools/check-versions.cjs reads as a current version authority.
const AUTHORITY_FILES = [
  'package.json',
  'package-lock.json',
  'src/runtime.js',
  'dist/travian-attack-alert.user.js',
  'dist/travian-attack-alert.user.js.sha256',
  'metadata.json',
  'module-manifest.json',
  'tools/build.cjs',
  'tools/backup.cjs',
  'tools/rollback.cjs',
  'test/offline/script.test.cjs',
  'AGENTS.md',
  'README.md',
  'docs/MIGRATION-6X.md',
  'docs/OPERATIONS.md',
  'docs/pl/OPERATIONS.md',
  'docs/architecture.md',
  'docs/release-state.json',
];

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-version-contract-'));
  for (const relative of AUTHORITY_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  return root;
}

function runCheck(root) {
  const result = spawnSync(process.execPath, [CHECK], {
    cwd: root,
    env: { ...process.env, TAA_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `check-versions did not run: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function replaceOnce(text, from, to) {
  const index = text.indexOf(from);
  assert.notEqual(index, -1, `fixture text not found: ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function edit(root, relative, transform) {
  const target = path.join(root, relative);
  fs.writeFileSync(target, transform(fs.readFileSync(target, 'utf8')));
}

function remove(root, relative) {
  fs.rmSync(path.join(root, relative));
}

/**
 * Run the real verifier against a fixture with the given mutations applied.
 * The unmutated fixture must PASS first (it proves the fixture is complete);
 * the mutated fixture must exit nonzero, print no PASS line, and name every
 * expected authority path.
 */
function expectRejected(label, mutations, expectedPaths, expectedStatus = 1) {
  const root = copyFixture();
  try {
    const baseline = runCheck(root);
    assert.equal(baseline.status, 0, `${label}: unmutated fixture must PASS\n${baseline.stderr}`);
    assert.equal(baseline.stdout, `VERSION CHECK PASS: ${VERSION} (${RELEASE_ID})\n`, `${label}: baseline PASS line`);
    for (const [relative, transform] of mutations) edit(root, relative, transform);
    const result = runCheck(root);
    assert.equal(result.status, expectedStatus, `${label}: mutated fixture must exit ${expectedStatus}\n${result.stderr}`);
    assert.equal(result.stdout, '', `${label}: mutated fixture must never print PASS`);
    for (const expected of expectedPaths) {
      assert.ok(
        result.stderr.includes(expected),
        `${label}: stderr must name "${expected}"\n${result.stderr}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('version contract (tools/check-versions.cjs)', () => {
  it('the repository reports one exact current identity', () => {
    const result = runCheck(ROOT);
    assert.equal(result.status, 0, `real repository must PASS\n${result.stderr}`);
    assert.equal(result.stdout, `VERSION CHECK PASS: ${VERSION} (${RELEASE_ID})\n`);
  });

  it('a package-only partial bump names every stale authority', () => {
    expectRejected(
      'package-only',
      [['package.json', (text) => replaceOnce(text, `"version": "${VERSION}"`, `"version": "${BUMPED}"`)]],
      [
        `package-lock.json version: expected ${BUMPED}, got ${VERSION}`,
        `package-lock root version: expected ${BUMPED}, got ${VERSION}`,
        `src/runtime.js RELEASE_VERSION: expected ${BUMPED}, got ${VERSION}`,
        `src/runtime.js RELEASE_ID: expected ${BUMPED_ID}, got ${RELEASE_ID}`,
        `dist @version: expected ${BUMPED}, got ${VERSION}`,
        `metadata.json release.version: expected ${BUMPED}, got ${VERSION}`,
        `module-manifest.json release.releaseId: expected ${BUMPED_ID}, got ${RELEASE_ID}`,
        `tools/build.cjs FALLBACK_VERSION: expected ${BUMPED}, got ${VERSION}`,
        `tools/backup.cjs FALLBACK_VERSION: expected ${BUMPED}, got ${VERSION}`,
        `tools/rollback.cjs FALLBACK_VERSION: expected ${BUMPED}, got ${VERSION}`,
        `test/offline/script.test.cjs version assertion: expected ${BUMPED}, got ${VERSION}`,
        `AGENTS current version: expected ${BUMPED}, got ${VERSION}`,
        `README current version: expected ${BUMPED}, got ${VERSION}`,
        `README migration install instruction: expected ${BUMPED}, got ${VERSION}`,
        `docs/MIGRATION-6X.md install instruction: expected ${BUMPED}, got ${VERSION}`,
        `docs/OPERATIONS.md migration install instruction: expected ${BUMPED}, got ${VERSION}`,
        `docs/pl/OPERATIONS.md migration install instruction: expected ${BUMPED}, got ${VERSION}`,
        `docs/architecture.md release ID claim: expected ${BUMPED_ID}, got ${RELEASE_ID}`,
        `docs/release-state.json version: expected ${BUMPED}, got ${VERSION}`,
      ],
    );
  });

  it('a runtime-only version bump is attributed to src/runtime.js alone', () => {
    const root = copyFixture();
    try {
      edit(root, 'src/runtime.js', (text) => replaceOnce(text, `const RELEASE_VERSION = "${VERSION}"`, `const RELEASE_VERSION = "${BUMPED}"`));
      const result = runCheck(root);
      assert.equal(result.status, 1, `runtime-only bump must fail\n${result.stderr}`);
      assert.ok(
        result.stderr.includes(`src/runtime.js RELEASE_VERSION: expected ${VERSION}, got ${BUMPED}`),
        result.stderr,
      );
      assert.ok(!result.stderr.includes('src/runtime.js RELEASE_ID'), 'unchanged release ID must not be reported');
      assert.ok(!result.stderr.includes('package-lock.json'), 'package identity is untouched by a runtime-only bump');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stale tool fallbacks name each tool file', () => {
    expectRejected(
      'stale fallback',
      [
        ['tools/build.cjs', (text) => replaceOnce(text, `const FALLBACK_VERSION = '${VERSION}'`, `const FALLBACK_VERSION = '${BUMPED}'`)],
        ['tools/backup.cjs', (text) => replaceOnce(text, `const FALLBACK_VERSION = '${VERSION}'`, `const FALLBACK_VERSION = '${BUMPED}'`)],
        ['tools/rollback.cjs', (text) => replaceOnce(text, `const FALLBACK_VERSION = '${VERSION}'`, `const FALLBACK_VERSION = '${BUMPED}'`)],
      ],
      [
        `tools/build.cjs FALLBACK_VERSION: expected ${VERSION}, got ${BUMPED}`,
        `tools/backup.cjs FALLBACK_VERSION: expected ${VERSION}, got ${BUMPED}`,
        `tools/rollback.cjs FALLBACK_VERSION: expected ${VERSION}, got ${BUMPED}`,
      ],
    );
  });

  it('a stale release-state identity names docs/release-state.json', () => {
    expectRejected(
      'stale release state',
      [['docs/release-state.json', (text) => replaceOnce(replaceOnce(text, `"version": "${VERSION}"`, `"version": "${BUMPED}"`), `"releaseId": "${RELEASE_ID}"`, `"releaseId": "${BUMPED_ID}"`)]],
      [
        `docs/release-state.json version: expected ${VERSION}, got ${BUMPED}`,
        `docs/release-state.json releaseId: expected ${RELEASE_ID}, got ${BUMPED_ID}`,
      ],
    );
  });

  it('a stale generated header names dist @version', () => {
    expectRejected(
      'stale generated header',
      [['dist/travian-attack-alert.user.js', (text) => text.replace(/^\/\/ @version(\s+).+$/m, `// @version$1${BUMPED}`)]],
      [`dist @version: expected ${VERSION}, got ${BUMPED}`],
    );
  });

  it('stale generated metadata and module manifest name each file', () => {
    expectRejected(
      'stale generated metadata',
      [
        ['metadata.json', (text) => replaceOnce(text, `"version": "${VERSION}"`, `"version": "${BUMPED}"`)],
        ['module-manifest.json', (text) => replaceOnce(text, `"releaseId": "${RELEASE_ID}"`, `"releaseId": "${BUMPED_ID}"`)],
      ],
      [
        `metadata.json release.version: expected ${VERSION}, got ${BUMPED}`,
        `module-manifest.json release.releaseId: expected ${RELEASE_ID}, got ${BUMPED_ID}`,
      ],
    );
  });

  it('a stale test assertion and a stale release literal name the test file', () => {
    expectRejected(
      'stale test assertion',
      [['test/offline/script.test.cjs', (text) => replaceOnce(text, `const version = '${VERSION}';`, `const version = '${BUMPED}';`)]],
      [`test/offline/script.test.cjs version assertion: expected ${VERSION}, got ${BUMPED}`],
    );
    expectRejected(
      'stale test release literal',
      [['test/offline/script.test.cjs', (text) => replaceOnce(text, `'${RELEASE_ID}'`, `'${BUMPED_ID}'`)]],
      ['test/offline/script.test.cjs release literal line'],
    );
  });

  it('stale documentation claims name AGENTS.md, README.md, and docs/architecture.md', () => {
    expectRejected(
      'stale docs',
      [
        ['AGENTS.md', (text) => replaceOnce(text, `aktualnie ${VERSION}`, `aktualnie ${BUMPED}`)],
        ['README.md', (text) => replaceOnce(text, `Tampermonkey **${VERSION}**`, `Tampermonkey **${BUMPED}**`)],
        ['docs/architecture.md', (text) => replaceOnce(text, RELEASE_ID, BUMPED_ID)],
      ],
      [
        `AGENTS current version: expected ${VERSION}, got ${BUMPED}`,
        `README current version: expected ${VERSION}, got ${BUMPED}`,
        `docs/architecture.md release ID claim: expected ${RELEASE_ID}, got ${BUMPED_ID}`,
      ],
    );
  });

  it('a stale README migration install instruction names the README line', () => {
    expectRejected(
      'stale README migration instruction',
      [['README.md', (text) => replaceOnce(text, `then install ${VERSION}.`, `then install ${BUMPED}.`)]],
      [`README migration install instruction: expected ${VERSION}, got ${BUMPED}`],
    );
  });

  it('a stale migration-guide install instruction names docs/MIGRATION-6X.md', () => {
    expectRejected(
      'stale migration guide',
      [['docs/MIGRATION-6X.md', (text) => replaceOnce(text, `**Install the ${VERSION} file.**`, `**Install the ${BUMPED} file.**`)]],
      [`docs/MIGRATION-6X.md install instruction: expected ${VERSION}, got ${BUMPED}`],
    );
  });

  it('stale operations migration instructions name each operations page', () => {
    expectRejected(
      'stale operations migration instruction',
      [
        ['docs/OPERATIONS.md', (text) => replaceOnce(text, `install the ${VERSION} file as a new script`, `install the ${BUMPED} file as a new script`)],
        ['docs/pl/OPERATIONS.md', (text) => replaceOnce(text, `zainstaluj plik ${VERSION} jako nowy skrypt`, `zainstaluj plik ${BUMPED} jako nowy skrypt`)],
      ],
      [
        `docs/OPERATIONS.md migration install instruction: expected ${VERSION}, got ${BUMPED}`,
        `docs/pl/OPERATIONS.md migration install instruction: expected ${VERSION}, got ${BUMPED}`,
      ],
    );
  });

  it('a missing generated output fails closed with the build instruction', () => {
    const root = copyFixture();
    try {
      remove(root, 'dist/travian-attack-alert.user.js');
      const result = runCheck(root);
      assert.equal(result.status, 2, `missing generated output must fail closed\n${result.stderr}`);
      assert.ok(
        result.stderr.includes('dist/travian-attack-alert.user.js is missing; run npm run build'),
        result.stderr,
      );
      assert.equal(result.stdout, '', 'missing generated output must never print PASS');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an invalid package semver fails closed', () => {
    expectRejected(
      'invalid semver',
      [['package.json', (text) => replaceOnce(text, `"version": "${VERSION}"`, '"version": "1.0"')]],
      ['package.json version: invalid semver 1.0'],
    );
  });
});
