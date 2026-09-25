'use strict';

// Task 30 owner-gated publication readiness contract.
//
// `tools/check-release-readiness.cjs` is extended from the Task 28 asset
// verifier into a fail-closed readiness evaluator. It consumes a self-contained
// readiness bundle and reports exactly one machine-readable state:
//
//   BLOCKED | READY_FOR_OWNER_TAG | DRAFT_READY_FOR_APPROVAL | PUBLISHED_VERIFIED
//
// The evaluator never mutates GitHub and, in `--offline-fixture` mode, never
// consults git or the network. This suite proves the happy path through all four
// states with synthetic owner evidence and proves every adversarial class fails
// closed with its earliest typed blocker. It also pins the committed
// `blocked-current-state.json` fixture as a truthful BLOCKED snapshot and pins
// the active owner runbook's required transitions and rollback/stop behavior.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECK = path.join(ROOT, 'tools', 'check-release-readiness.cjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'release', 'blocked-current-state.json');
const RUNBOOK = path.join(ROOT, 'docs', 'RELEASE-RUNBOOK.md');

const {
  evaluateReadiness,
  READINESS_STATES,
  PRE_PUBLICATION_GATES,
  REQUIRED_CHECKS,
} = require(CHECK);

const ARTIFACT = '0c187870841a62d9b5d064fe242c00c648eaac6936cb6a830207239114045824';
const COMMIT = 'ae534e2897ceb984a2f36f2b2eb5ed5a04e537e1';
const TREE = '35b134aad1893dbcac0c7bbb530c75c88c9fe476';
const hex = (char) => char.repeat(64);
const TIMESTAMP = '2026-09-23T20:30:00Z';

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override.slice();
  if (override && typeof override === 'object') {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = deepMerge(base && typeof base[key] === 'object' && !Array.isArray(base[key]) ? base[key] : {}, value);
    }
    return result;
  }
  return override;
}

// A complete, synthetic, pre-tag owner bundle: every prerequisite satisfied but
// no tag yet, so it must report READY_FOR_OWNER_TAG.
function happyBundle(overrides = {}) {
  const base = {
    schemaVersion: 1,
    generatedAt: TIMESTAMP,
    identity: {
      version: '1.0.1',
      releaseId: 'taa-1.0.1',
      tag: 'v1.0.1',
      repository: 'PeterPage2115/Travian-Attack-Alert',
      commit: COMMIT,
      artifactSha256: ARTIFACT,
    },
    repository: {
      name: 'PeterPage2115/Travian-Attack-Alert',
      releaseBranch: 'release/public-1.0.0',
      headCommit: COMMIT,
      headTree: TREE,
      worktreeClean: true,
      tag: { present: false, name: null, annotated: false, onReleaseBranch: false, targetCommit: null },
      branchProtection: {
        protected: true,
        requiredChecks: [...REQUIRED_CHECKS],
        checksGreen: true,
        requirePullRequest: true,
        blockForcePush: true,
        blockDeletion: true,
      },
    },
    updateChannel: {
      verified: true,
      httpStatus: 200,
      sha256: ARTIFACT,
      sidecarSha256: ARTIFACT,
      version: '1.0.1',
      directivesMatch: true,
      verifiedAt: TIMESTAMP,
    },
    pilot: {
      completed: true,
      installBySecondPerson: true,
      updatedInPlace: true,
      manager: 'Tampermonkey',
      installVersion: '1.0.0',
      updateVersion: '1.0.1',
      evidenceDigest: hex('a'),
    },
    seedReceipt: { present: true, task: 23, sha256: hex('b') },
    updateReceipt: { present: true, task: 31, sha256: hex('c') },
    devDeletion: { executed: true, noArchive: true, devArchivalAttested: true, recordDigest: hex('d') },
    releaseEnvironment: {
      exists: true,
      name: 'release',
      autoCreated: false,
      tagPolicyVStar: true,
    },
    immutableReleases: { enabled: true, evidenceDigest: hex('e') },
    releaseState: {
      schemaVersion: 2,
      version: '1.0.1',
      releaseId: 'taa-1.0.1',
      stable: true,
      ownerManual: {
        pilotInstallBySecondPerson: true,
        evidenceRecord: 'docs/release-history/1.0.0-rc/PILOT.md',
        branchProtection: true,
        devArchival: true,
        releaseEnvironment: true,
        immutableReleases: true,
      },
      publication: { tagAndRelease: false },
    },
    assets: {
      verified: true,
      assetCount: 7,
      checksumsVerified: true,
      sourceArchiveSubstituted: false,
      sha256: ARTIFACT,
    },
    draft: { exists: false, isDraft: false, assetCount: 0, assetsMatchWorkflowArtifact: false, attestationVerified: false },
    published: { exists: false, isDraft: false, immutableVerified: false, releaseAttestationVerified: false, assetDigestsMatch: false },
  };
  return deepMerge(base, overrides);
}

function taggedBundle(overrides = {}) {
  return happyBundle(deepMerge({
    repository: {
      tag: { present: true, name: 'v1.0.1', annotated: true, onReleaseBranch: true, targetCommit: COMMIT },
    },
  }, overrides));
}

function draftedBundle(overrides = {}) {
  return taggedBundle(deepMerge({
    draft: { exists: true, isDraft: true, assetCount: 7, assetsMatchWorkflowArtifact: true, attestationVerified: true },
  }, overrides));
}

function publicationRecord(overrides = {}) {
  return {
    tag: 'v1.0.1',
    version: '1.0.1',
    releaseId: 'taa-1.0.1',
    githubReleaseId: 234567890,
    verifiedAt: TIMESTAMP,
    evidenceDigest: hex('1'),
    ...overrides,
  };
}

function publishedBundle(overrides = {}) {
  return draftedBundle(deepMerge({
    published: { exists: true, isDraft: false, immutableVerified: true, releaseAttestationVerified: true, assetDigestsMatch: true },
    releaseState: { publication: { tagAndRelease: publicationRecord() } },
  }, overrides));
}

function assertBlocked(bundle, expectedCode, label) {
  const report = evaluateReadiness(bundle);
  assert.equal(report.state, READINESS_STATES.BLOCKED, `${label}: expected BLOCKED, got ${report.state}`);
  assert.equal(report.code, expectedCode, `${label}: expected code ${expectedCode}, got ${report.code}`);
  assert.notEqual(report.state, READINESS_STATES.READY_FOR_OWNER_TAG, label);
  assert.notEqual(report.state, READINESS_STATES.DRAFT_READY_FOR_APPROVAL, label);
  assert.notEqual(report.state, READINESS_STATES.PUBLISHED_VERIFIED, label);
  return report;
}

test('Given the committed current-state fixture, when evaluated, then it is truthfully BLOCKED with every owner prerequisite named', () => {
  const bundle = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const report = evaluateReadiness(bundle);
  assert.equal(report.state, READINESS_STATES.BLOCKED);
  assert.equal(report.code, 'branch-protection-incomplete');
  const codes = report.blockers.map((blocker) => blocker.code);
  for (const expected of [
    'branch-protection-incomplete',
    'update-channel-unverified',
    'pilot-missing',
    'seed-receipt-missing',
    'update-receipt-missing',
    'dev-archival-missing',
    'release-environment-missing',
    'immutable-releases-missing',
    'release-state-not-ready',
    'assets-unverified',
  ]) {
    assert.ok(codes.includes(expected), `current-state fixture must report ${expected}; got ${codes.join(', ')}`);
  }
  assert.equal(bundle.releaseState.stable, false, 'the fixture must mirror the live stable:false state');
  assert.equal(bundle.releaseState.publication.tagAndRelease, false, 'the fixture must not claim a published release');
  for (const gate of PRE_PUBLICATION_GATES) {
    assert.equal(bundle.releaseState.ownerManual[gate], gate === 'evidenceRecord' ? null : false, `fixture gate ${gate} must stay unpopulated`);
  }
});

test('Given a complete pre-tag owner bundle, when evaluated, then it is READY_FOR_OWNER_TAG with no blockers', () => {
  const report = evaluateReadiness(happyBundle());
  assert.equal(report.state, READINESS_STATES.READY_FOR_OWNER_TAG);
  assert.equal(report.code, null);
  assert.deepEqual(report.blockers, []);
});

test('Given an exact annotated tag and a verified draft, when evaluated, then it is DRAFT_READY_FOR_APPROVAL', () => {
  const report = evaluateReadiness(draftedBundle());
  assert.equal(report.state, READINESS_STATES.DRAFT_READY_FOR_APPROVAL);
  assert.equal(report.code, null);
  assert.deepEqual(report.blockers, []);
});

test('Given a published, immutable, attestation-verified release with tagAndRelease recorded, when evaluated, then it is PUBLISHED_VERIFIED', () => {
  const report = evaluateReadiness(publishedBundle());
  assert.equal(report.state, READINESS_STATES.PUBLISHED_VERIFIED);
  assert.equal(report.code, null);
  assert.deepEqual(report.blockers, []);
});

test('Given each pre-tag prerequisite removed one at a time, when evaluated, then it stays BLOCKED with the earliest typed blocker', () => {
  const cases = [
    ['identity-mismatch', happyBundle({ identity: { releaseId: 'taa-1.0.0' } })],
    ['dirty-worktree', happyBundle({ repository: { worktreeClean: false } })],
    ['release-branch-missing', happyBundle({ repository: { releaseBranch: null } })],
    ['branch-protection-incomplete', happyBundle({ repository: { branchProtection: { requirePullRequest: false } } })],
    ['required-checks-not-green', happyBundle({ repository: { branchProtection: { checksGreen: false } } })],
    ['update-channel-unverified', happyBundle({ updateChannel: { sha256: hex('0') } })],
    ['pilot-missing', happyBundle({ pilot: { completed: false } })],
    ['seed-receipt-missing', happyBundle({ seedReceipt: { present: false } })],
    ['update-receipt-missing', happyBundle({ updateReceipt: { present: false } })],
    ['dev-archival-missing', happyBundle({ devDeletion: { devArchivalAttested: false } })],
    ['release-environment-missing', happyBundle({ releaseEnvironment: { exists: false } })],
    ['immutable-releases-missing', happyBundle({ immutableReleases: { enabled: false } })],
    ['release-state-not-ready', happyBundle({ releaseState: { stable: false } })],
    ['assets-unverified', happyBundle({ assets: { assetCount: 6 } })],
    ['checksum-mismatch', happyBundle({ assets: { checksumsVerified: false } })],
    ['source-archive-substituted', happyBundle({ assets: { sourceArchiveSubstituted: true } })],
  ];
  for (const [code, bundle] of cases) {
    assertBlocked(bundle, code, `pre-tag ${code}`);
  }
});

test('Given a false pilot install/update attestation, when evaluated, then the pilot gate fails closed', () => {
  assertBlocked(happyBundle({ pilot: { installBySecondPerson: false } }), 'pilot-missing', 'pilot not by a second person');
  assertBlocked(happyBundle({ pilot: { updateVersion: '1.0.0' } }), 'pilot-missing', 'update version never advanced');
  assertBlocked(happyBundle({ pilot: { updatedInPlace: false } }), 'pilot-missing', 'reinstall misreported as update');
  assertBlocked(happyBundle({ pilot: { evidenceDigest: null } }), 'pilot-missing', 'pilot evidence digest missing');
});

test('Given a missing or auto-created release environment, when evaluated, then the environment gate fails closed', () => {
  assertBlocked(happyBundle({ releaseEnvironment: { exists: false } }), 'release-environment-missing', 'missing environment');
  assertBlocked(happyBundle({ releaseEnvironment: { autoCreated: true } }), 'release-environment-missing', 'auto-created environment');
  assertBlocked(happyBundle({ releaseEnvironment: { name: 'prod' } }), 'release-environment-missing', 'wrong environment name');
  assertBlocked(happyBundle({ releaseEnvironment: { tagPolicyVStar: false } }), 'release-environment-missing', 'no v* tag deployment policy');
});

test('Given a wrong or unsafe tag, when evaluated, then the tag gate fails closed', () => {
  assertBlocked(taggedBundle({ repository: { tag: { annotated: false } } }), 'tag-not-annotated', 'lightweight tag');
  assertBlocked(taggedBundle({ repository: { tag: { name: 'v1.0.0' } } }), 'tag-name-mismatch', 'wrong tag name');
  assertBlocked(taggedBundle({ repository: { tag: { onReleaseBranch: false } } }), 'tag-off-release-branch', 'off-branch tag');
  assertBlocked(taggedBundle({ repository: { tag: { targetCommit: hex('9') } } }), 'tag-target-mismatch', 'wrong tag target');
});

test('Given a draft with a missing asset or attestation, when evaluated, then the draft gate fails closed', () => {
  assertBlocked(draftedBundle({ draft: { assetCount: 6 } }), 'draft-asset-mismatch', 'missing draft asset');
  assertBlocked(draftedBundle({ draft: { assetsMatchWorkflowArtifact: false } }), 'draft-asset-mismatch', 'draft differs from workflow artifact');
  assertBlocked(draftedBundle({ draft: { attestationVerified: false } }), 'draft-attestation-missing', 'draft attestation missing');
  assertBlocked(draftedBundle({ draft: { isDraft: false } }), 'draft-missing', 'draft already published without approval');
});

test('Given an identity that disagrees with the canonical repository or release head, when evaluated, then it is rejected', () => {
  assertBlocked(happyBundle({ identity: { repository: 'someone-else/other-project' } }), 'identity-mismatch', 'unrelated identity repository');
  assertBlocked(happyBundle({ identity: { commit: 'b'.repeat(40) } }), 'identity-mismatch', 'identity commit differs from the recorded release head');
  assertBlocked(happyBundle({ repository: { name: 'someone-else/other-project' } }), 'identity-mismatch', 'repository name differs from the identity');
});

test('Given a mutable or unverified published release, when evaluated, then it never reports PUBLISHED_VERIFIED', () => {
  assertBlocked(publishedBundle({ published: { immutableVerified: false } }), 'mutable-release', 'mutable release');
  assertBlocked(publishedBundle({ published: { releaseAttestationVerified: false } }), 'release-attestation-mismatch', 'release attestation mismatch');
  assertBlocked(publishedBundle({ published: { assetDigestsMatch: false } }), 'checksum-mismatch', 'asset digest changed after publish');
  assertBlocked(publishedBundle({ published: { isDraft: true } }), 'published-missing', 'still a draft');
  assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: false } } }), 'publication-not-recorded', 'publication not recorded');
});

test('Given publication.tagAndRelease as a boolean or an unstructured string, when evaluated, then PUBLISHED_VERIFIED is refused', () => {
  assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: true } } }), 'publication-record-mismatch', 'boolean publication record');
  assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: 'v1.0.1 + GitHub Release' } } }), 'publication-record-mismatch', 'unstructured string publication record');
  assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: [] } } }), 'publication-record-mismatch', 'array publication record');
  assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: '' } } }), 'publication-not-recorded', 'empty publication record');
});

test('Given a structured publication record that disagrees with the release identity, when evaluated, then PUBLISHED_VERIFIED is refused', () => {
  const cases = [
    ['wrong tag', publicationRecord({ tag: 'v1.0.0' })],
    ['wrong version', publicationRecord({ version: '1.0.0' })],
    ['wrong release id', publicationRecord({ releaseId: 'taa-1.0.0' })],
    ['missing GitHub release id', publicationRecord({ githubReleaseId: null })],
    ['boolean GitHub release id', publicationRecord({ githubReleaseId: true })],
    ['missing verification timestamp', publicationRecord({ verifiedAt: null })],
    ['missing verification evidence', publicationRecord({ evidenceDigest: null })],
  ];
  for (const [label, record] of cases) {
    assertBlocked(publishedBundle({ releaseState: { publication: { tagAndRelease: record } } }), 'publication-record-mismatch', label);
  }
});

test('Given bundles that mix incompatible readiness stages, when evaluated, then they are rejected as inconsistent', () => {
  assertBlocked(happyBundle({ draft: { exists: true, isDraft: true, assetCount: 7, assetsMatchWorkflowArtifact: true, attestationVerified: true } }), 'inconsistent-readiness-state', 'draft without a tag');
  assertBlocked(happyBundle({ published: { exists: true, isDraft: false, immutableVerified: true, releaseAttestationVerified: true, assetDigestsMatch: true } }), 'inconsistent-readiness-state', 'published without a tag');
  assertBlocked(happyBundle({ releaseState: { publication: { tagAndRelease: 'v1.0.1' } } }), 'inconsistent-readiness-state', 'tagAndRelease without a tag');
  assertBlocked(draftedBundle({ releaseState: { publication: { tagAndRelease: 'v1.0.1' } } }), 'publication-claim-unverified', 'tagAndRelease before publish verification');
});

test('Given a malformed readiness bundle, when evaluated, then it fails closed with a typed error', () => {
  assert.throws(() => evaluateReadiness(null), (error) => error.code === 'malformed-readiness-bundle');
  assert.throws(() => evaluateReadiness({ schemaVersion: 2 }), (error) => error.code === 'unsupported-readiness-schema');
  const missing = happyBundle();
  delete missing.published;
  assert.throws(() => evaluateReadiness(missing), (error) => error.code === 'malformed-readiness-bundle');
});

test('Given the offline fixture flag, when the tool runs, then it emits the machine-readable BLOCKED state and exits 0', () => {
  const json = spawnSync(process.execPath, [CHECK, '--offline-fixture', FIXTURE, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.verdict, 'BLOCKED');
  assert.equal(parsed.state, 'BLOCKED');
  assert.equal(parsed.code, 'branch-protection-incomplete');
  const plain = spawnSync(process.execPath, [CHECK, '--offline-fixture', FIXTURE], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /RELEASE READINESS: BLOCKED/);
});

test('Given the active owner runbook, when inspected, then it covers every transition from merged PR through verified publication with rollback/stop behavior', () => {
  assert.ok(fs.existsSync(RUNBOOK), 'docs/RELEASE-RUNBOOK.md must exist');
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  for (const required of [
    'merged',
    'verify-update-channel.cjs',
    'pilot',
    'Task 23',
    'Task 31',
    'devArchival',
    'immutable releases',
    'release` environment',
    'stable:true',
    'annotated',
    'v1.0.1',
    'draft',
    'attestation',
    'PUBLISHED_VERIFIED',
    'publication.tagAndRelease',
    'BLOCKED',
    'READY_FOR_OWNER_TAG',
    'DRAFT_READY_FOR_APPROVAL',
  ]) {
    assert.ok(runbook.includes(required), `runbook must mention ${required}`);
  }
  assert.match(runbook, /rollback/i, 'runbook must document rollback behavior');
  assert.match(runbook, /stop/i, 'runbook must document stop behavior');
  const docsIndex = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'docs', 'REPOSITORY-SETTINGS.md'), 'utf8');
  for (const [label, source] of [['docs/README.md', docsIndex], ['README.md', readme], ['docs/REPOSITORY-SETTINGS.md', settings]]) {
    assert.ok(source.includes('RELEASE-RUNBOOK.md'), `${label} must link the owner release runbook`);
  }
});
