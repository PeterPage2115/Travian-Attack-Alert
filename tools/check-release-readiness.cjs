#!/usr/bin/env node
'use strict';

// Release readiness verifier — Task 28 foundation (extended by Task 30).
//
// This module owns two fail-closed verifiers:
//
//   1. The release-asset CONTRACT and its directory verifier
//      (`verifyReleaseDirectory`). The contract is deliberately exhaustive: a
//      prepared release directory is valid only when it contains EXACTLY the
//      seven declared assets and every byte re-hashes to the digests recorded
//      in `release-manifest.json` and `SHA256SUMS`.
//
//   2. The owner-gated PUBLICATION READINESS evaluator (`evaluateReadiness`).
//      It consumes a self-contained, machine-readable readiness bundle and
//      reports exactly one of four states WITHOUT mutating GitHub:
//        BLOCKED                    — a prerequisite is absent (earliest typed
//                                     blocker returned in `code`/`blockers`)
//        READY_FOR_OWNER_TAG        — every pre-tag prerequisite is satisfied
//                                     and no tag exists yet
//        DRAFT_READY_FOR_APPROVAL   — exact annotated tag + verified draft and
//                                     attestations, not yet published
//        PUBLISHED_VERIFIED         — published, immutable and release
//                                     attestation verified, tagAndRelease
//                                     recorded
//      It validates the clean commit, exact tag, branch ancestry/protection/
//      checks, update-channel HTTP/SHA, pilot evidence, the Task 23 seed and
//      Task 31 update receipts, the owner-executed DEV-deletion record with its
//      `devArchival` attestation, the release environment checklist, immutable
//      releases, owner evidence shape, owner fields, assets/checksums, draft
//      state and published/attestation verification. `--offline-fixture <path>`
//      evaluates a committed bundle deterministically (no git, no network).
//
// The seven assets (flat, basename-only):
//   1. travian-attack-alert.user.js          generated userscript
//   2. travian-attack-alert.user.js.sha256   existing userscript sidecar
//   3. metadata.json                         generated build metadata
//   4. module-manifest.json                  generated module manifest
//   5. sbom.spdx.json                        SPDX-2.3 BUILD-dependency SBOM
//   6. release-manifest.json                 release descriptor
//   7. SHA256SUMS                            checksums of 1-5 + 6
//
// The release manifest intentionally does NOT digest SHA256SUMS (or itself),
// so there is no circular hash. SHA256SUMS covers the five primary assets plus
// release-manifest.json, never itself.
//
// Verification rejects, with a typed `code`:
//   malformed-release-manifest, malformed-sbom, malformed-sha256sums,
//   unsupported-schema, path-traversal, duplicate-asset, missing-asset,
//   unexpected-asset, non-regular-asset, digest-mismatch, checksum-mismatch,
//   sidecar-mismatch, self-referential-asset, sbom-classification-mismatch,
//   sbom-runtime-dependency-misstatement, sbom-timestamp-mismatch.
//
// Exit codes: 0 PASS/state-determined, 1 verification FAIL, 2 usage/read error.
// Flags: --root <dir> --dir <releaseDir> --offline-fixture <path> --json
// Env:   TAA_ROOT
// Dependencies: node:fs, node:path, node:crypto only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');

const USERSCRIPT = 'travian-attack-alert.user.js';
const SIDECAR = `${USERSCRIPT}.sha256`;
const METADATA = 'metadata.json';
const MODULE_MANIFEST = 'module-manifest.json';
const SBOM = 'sbom.spdx.json';
const RELEASE_MANIFEST = 'release-manifest.json';
const SHA256SUMS = 'SHA256SUMS';
const PRIMARY_ASSETS = [USERSCRIPT, SIDECAR, METADATA, MODULE_MANIFEST, SBOM];
const SHA256SUMS_ASSETS = [...PRIMARY_ASSETS, RELEASE_MANIFEST];
const ALL_ASSETS = [...PRIMARY_ASSETS, RELEASE_MANIFEST, SHA256SUMS];
const SPDX_VERSION = 'SPDX-2.3';
const SBOM_CLASSIFICATION = 'build-dependency';
const ZERO_RUNTIME_DEPENDENCIES_STATEMENT = 'The browser userscript has zero runtime package dependencies.';

const USAGE = [
  'Usage: node tools/check-release-readiness.cjs [options]',
  '  --root <dir>   project root (defaults to TAA_ROOT or the repository root)',
  '  --dir <dir>    prepared release directory (defaults to <root>/release)',
  '  --offline-fixture <path>  evaluate an owner readiness bundle (no git, no network)',
  '  --json         emit machine-readable JSON',
].join('\n');

// ---------------------------------------------------------------------------
// Owner-gated publication readiness (Task 30).
//
// The evaluator is a PURE function over a self-contained readiness bundle so it
// can run offline and deterministically. It never mutates GitHub and never
// consults git or the network in `--offline-fixture` mode. Every check returns
// a typed code; the earliest failing check in runbook order is reported as
// `code`, and every failing check is reported in `blockers`.
// ---------------------------------------------------------------------------

const READINESS_STATES = Object.freeze({
  BLOCKED: 'BLOCKED',
  READY_FOR_OWNER_TAG: 'READY_FOR_OWNER_TAG',
  DRAFT_READY_FOR_APPROVAL: 'DRAFT_READY_FOR_APPROVAL',
  PUBLISHED_VERIFIED: 'PUBLISHED_VERIFIED',
});

// Schema v2 pre-publication owner gates (mirrors docs/release-state.json).
const PRE_PUBLICATION_GATES = [
  'pilotInstallBySecondPerson',
  'evidenceRecord',
  'branchProtection',
  'devArchival',
  'releaseEnvironment',
  'immutableReleases',
];
const REQUIRED_CHECKS = ['offline-node-18', 'offline-node-20', 'browser-node-20', 'cross-node-determinism'];
const READINESS_BUNDLE_KEYS = [
  'identity',
  'repository',
  'updateChannel',
  'pilot',
  'seedReceipt',
  'updateReceipt',
  'devDeletion',
  'releaseEnvironment',
  'immutableReleases',
  'ownerEvidence',
  'releaseState',
  'assets',
  'draft',
  'published',
];
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function isPopulated(value) {
  return value !== false && value !== null && value !== undefined && value !== '';
}

function isHex(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validateReadinessBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new ReleaseError('malformed-readiness-bundle', 'readiness bundle must be a JSON object', 2);
  }
  if (bundle.schemaVersion !== 1) {
    throw new ReleaseError('unsupported-readiness-schema', `unsupported readiness schemaVersion: ${String(bundle.schemaVersion)}`, 2);
  }
  for (const key of READINESS_BUNDLE_KEYS) {
    if (!bundle[key] || typeof bundle[key] !== 'object' || Array.isArray(bundle[key])) {
      throw new ReleaseError('malformed-readiness-bundle', `readiness bundle.${key} must be an object`, 2);
    }
  }
  return bundle;
}

// Owner evidence is only accepted when it carries the four required binding
// fields plus a read-only API response digest; no secret value is ever read.
function ownerEvidenceComplete(ownerEvidence) {
  return isTimestamp(ownerEvidence.timestamp)
    && isNonEmptyString(ownerEvidence.actor)
    && isNonEmptyString(ownerEvidence.repository)
    && isNonEmptyString(ownerEvidence.ref)
    && isHex(ownerEvidence.apiResponseDigest, 64);
}

function evaluateReadiness(bundle) {
  validateReadinessBundle(bundle);

  const identity = bundle.identity;
  const repository = bundle.repository;
  const branchProtection = repository.branchProtection || {};
  const tag = repository.tag || {};
  const updateChannel = bundle.updateChannel;
  const pilot = bundle.pilot;
  const seedReceipt = bundle.seedReceipt;
  const updateReceipt = bundle.updateReceipt;
  const devDeletion = bundle.devDeletion;
  const releaseEnvironment = bundle.releaseEnvironment;
  const immutableReleases = bundle.immutableReleases;
  const releaseState = bundle.releaseState;
  const ownerManual = releaseState.ownerManual || {};
  const publication = releaseState.publication || {};
  const assets = bundle.assets;
  const draft = bundle.draft;
  const published = bundle.published;

  const checks = [];
  const record = (stage, id, code, ok, message) => {
    const entry = { stage, id, ok: Boolean(ok), code: ok ? null : code };
    checks.push(entry);
    return entry;
  };

  // --- Pre-tag prerequisites (ordered exactly like the owner runbook) --------
  record('pre-tag', 'identity', 'identity-mismatch',
    isNonEmptyString(identity.version) && SEMVER_RE.test(identity.version)
      && identity.releaseId === `taa-${identity.version}`
      && identity.tag === `v${identity.version}`
      && isHex(identity.artifactSha256, 64),
    'identity must bind version, releaseId, tag and the userscript artifact digest');

  record('pre-tag', 'worktree', 'dirty-worktree',
    repository.worktreeClean === true,
    'the release checkout must be clean');

  record('pre-tag', 'release-ref', 'release-branch-missing',
    isNonEmptyString(repository.releaseBranch)
      && isHex(repository.headCommit, 40)
      && isHex(repository.headTree, 40),
    'the release branch, head commit and tree must be recorded');

  record('pre-tag', 'branch-protection', 'branch-protection-incomplete',
    branchProtection.protected === true
      && branchProtection.requirePullRequest === true
      && branchProtection.blockForcePush === true
      && branchProtection.blockDeletion === true
      && Array.isArray(branchProtection.requiredChecks)
      && REQUIRED_CHECKS.every((check) => branchProtection.requiredChecks.includes(check)),
    'branch protection must require a PR, block force pushes/deletions and require the four CI checks');

  record('pre-tag', 'required-checks', 'required-checks-not-green',
    branchProtection.checksGreen === true,
    'the required status checks must be green on the release head');

  record('pre-tag', 'update-channel', 'update-channel-unverified',
    updateChannel.verified === true
      && updateChannel.httpStatus === 200
      && isHex(updateChannel.sha256, 64)
      && updateChannel.sha256 === identity.artifactSha256
      && updateChannel.sidecarSha256 === updateChannel.sha256
      && updateChannel.version === identity.version
      && updateChannel.directivesMatch === true
      && isTimestamp(updateChannel.verifiedAt),
    'the live update channel must return HTTP 200 with the exact artifact bytes/SHA, version and directives');

  record('pre-tag', 'pilot', 'pilot-missing',
    pilot.completed === true
      && pilot.installBySecondPerson === true
      && pilot.updatedInPlace === true
      && isNonEmptyString(pilot.manager)
      && isNonEmptyString(pilot.installVersion) && SEMVER_RE.test(pilot.installVersion)
      && pilot.updateVersion === identity.version
      && pilot.installVersion !== pilot.updateVersion
      && isHex(pilot.evidenceDigest, 64),
    'a second-person real-manager pilot must record an in-place update to the release version with evidence');

  record('pre-tag', 'seed-receipt', 'seed-receipt-missing',
    seedReceipt.present === true && seedReceipt.task === 23 && isHex(seedReceipt.sha256, 64),
    'the Task 23 seed receipt must be present and digest-bound');

  record('pre-tag', 'update-receipt', 'update-receipt-missing',
    updateReceipt.present === true && updateReceipt.task === 31 && isHex(updateReceipt.sha256, 64),
    'the Task 31 update receipt must be present and digest-bound');

  record('pre-tag', 'dev-deletion', 'dev-archival-missing',
    devDeletion.executed === true
      && devDeletion.noArchive === true
      && devDeletion.devArchivalAttested === true
      && isHex(devDeletion.recordDigest, 64),
    'the owner must record the DEV deletion with no archive and attest devArchival with that record');

  record('pre-tag', 'release-environment', 'release-environment-missing',
    releaseEnvironment.exists === true
      && releaseEnvironment.name === 'release'
      && releaseEnvironment.autoCreated !== true
      && releaseEnvironment.requiredReviewer === true
      && releaseEnvironment.distinctReviewer === true
      && releaseEnvironment.preventSelfReview === true
      && releaseEnvironment.tagPolicyVStar === true
      && releaseEnvironment.environmentSecretsOnly === true
      && releaseEnvironment.approvalProofSecret === true
      && releaseEnvironment.settingsReadToken === true
      && isTimestamp(releaseEnvironment.settingsReadTokenExpiresAt),
    'the protected release environment must have a distinct reviewer, prevent self-review, a v* tag policy and environment-only short-lived secrets');

  record('pre-tag', 'immutable-releases', 'immutable-releases-missing',
    immutableReleases.enabled === true && isHex(immutableReleases.evidenceDigest, 64),
    'immutable releases must be enabled with digest-bound evidence');

  record('pre-tag', 'owner-evidence', 'owner-evidence-incomplete',
    ownerEvidenceComplete(bundle.ownerEvidence),
    'every owner-only evidence item needs timestamp, actor, repository/ref and a read-only API response digest');

  record('pre-tag', 'release-state', 'release-state-not-ready',
    releaseState.schemaVersion === 2
      && releaseState.version === identity.version
      && releaseState.releaseId === identity.releaseId
      && releaseState.stable === true
      && PRE_PUBLICATION_GATES.every((gate) => isPopulated(ownerManual[gate]))
      && isNonEmptyString(ownerManual.evidenceRecord),
    'schema-v2 state must be stable:true with every pre-publication owner gate populated');

  record('pre-tag', 'assets', 'assets-unverified',
    assets.verified === true
      && assets.assetCount === ALL_ASSETS.length
      && isHex(assets.sha256, 64)
      && assets.sha256 === identity.artifactSha256,
    'the exact seven assets must be present and match the release artifact digest');
  record('pre-tag', 'asset-checksums', 'checksum-mismatch',
    assets.checksumsVerified === true,
    'every release asset checksum must verify against SHA256SUMS');
  record('pre-tag', 'asset-substitution', 'source-archive-substituted',
    assets.sourceArchiveSubstituted === false,
    'a source archive auto-download must never be substituted for the userscript asset');

  // --- Tag prerequisites ----------------------------------------------------
  const tagPresent = tag.present === true;
  let tagCode = null;
  if (tagPresent) {
    if (tag.name !== identity.tag) tagCode = 'tag-name-mismatch';
    else if (tag.annotated !== true) tagCode = 'tag-not-annotated';
    else if (tag.onReleaseBranch !== true) tagCode = 'tag-off-release-branch';
    else if (tag.targetCommit !== repository.headCommit || !isHex(tag.targetCommit, 40)) tagCode = 'tag-target-mismatch';
  }
  record('tag', 'tag', tagCode || 'tag-missing', tagCode === null,
    'the exact annotated release tag must exist on the release branch at the release head');

  // --- Draft prerequisites --------------------------------------------------
  record('draft', 'draft-exists', 'draft-missing',
    draft.exists === true && draft.isDraft === true,
    'the draft release must exist and still be a draft');
  record('draft', 'draft-assets', 'draft-asset-mismatch',
    draft.assetsMatchWorkflowArtifact === true && draft.assetCount === ALL_ASSETS.length,
    'the draft assets must be the exact seven, byte-identical to the workflow artifact');
  record('draft', 'draft-attestation', 'draft-attestation-missing',
    draft.attestationVerified === true,
    'every draft asset build attestation must verify');

  // --- Published prerequisites ---------------------------------------------
  record('published', 'published-exists', 'published-missing',
    published.exists === true && published.isDraft === false,
    'the release must exist and no longer be a draft');
  record('published', 'published-immutable', 'mutable-release',
    published.immutableVerified === true,
    'immutable releases must be verified so a published asset cannot be replaced');
  record('published', 'published-attestation', 'release-attestation-mismatch',
    published.releaseAttestationVerified === true,
    'the published release attestation must verify');
  record('published', 'published-digests', 'checksum-mismatch',
    published.assetDigestsMatch === true,
    'the published asset ids and digests must be unchanged');
  const publicationRecorded = isPopulated(publication.tagAndRelease);

  const failing = (stage) => checks.filter((entry) => entry.stage === stage && !entry.ok).map((entry) => entry.code);
  const preTagFailures = failing('pre-tag');
  const tagFailures = failing('tag');
  const draftFailures = failing('draft');
  const publishedFailures = failing('published');

  const inconsistent = (message, code) => {
    checks.push({ stage: 'consistency', id: 'consistency', ok: false, code });
    return { state: READINESS_STATES.BLOCKED, code, blockers: [{ check: 'consistency', code, message }], checks };
  };

  let state;
  let activeFailures;
  if (preTagFailures.length > 0) {
    state = READINESS_STATES.BLOCKED;
    activeFailures = preTagFailures;
  } else if (!tagPresent) {
    if (draft.exists === true || published.exists === true || publicationRecorded) {
      return inconsistent('a tagless bundle must not claim a draft, published release or tagAndRelease record', 'inconsistent-readiness-state');
    }
    state = READINESS_STATES.READY_FOR_OWNER_TAG;
    activeFailures = [];
  } else if (tagFailures.length > 0) {
    state = READINESS_STATES.BLOCKED;
    activeFailures = tagFailures;
  } else if (draftFailures.length > 0) {
    state = READINESS_STATES.BLOCKED;
    activeFailures = draftFailures;
  } else if (published.exists !== true) {
    if (publicationRecorded) {
      return inconsistent('a draft-only bundle must not claim publication.tagAndRelease', 'publication-claim-unverified');
    }
    state = READINESS_STATES.DRAFT_READY_FOR_APPROVAL;
    activeFailures = [];
  } else if (publishedFailures.length > 0) {
    state = READINESS_STATES.BLOCKED;
    activeFailures = publishedFailures;
  } else if (!publicationRecorded) {
    state = READINESS_STATES.BLOCKED;
    activeFailures = ['publication-not-recorded'];
  } else {
    state = READINESS_STATES.PUBLISHED_VERIFIED;
    activeFailures = [];
  }

  const blockers = activeFailures.map((code) => {
    const entry = checks.find((candidate) => candidate.code === code);
    return { check: entry ? entry.id : code, code, message: describeBlocker(code) };
  });

  return {
    state,
    code: blockers.length > 0 ? blockers[0].code : null,
    blockers,
    checks,
    version: identity.version,
    releaseId: identity.releaseId,
    tag: identity.tag,
    tagPresent,
  };
}

function describeBlocker(code) {
  const messages = {
    'identity-mismatch': 'version/releaseId/tag/artifact digest are not internally consistent',
    'dirty-worktree': 'the release checkout is not clean',
    'release-branch-missing': 'the release branch/head commit/tree is not recorded',
    'branch-protection-incomplete': 'branch protection is missing a required rule or CI check',
    'required-checks-not-green': 'the required status checks are not green',
    'update-channel-unverified': 'the live update channel does not serve the exact release bytes/SHA/version/directives',
    'pilot-missing': 'the second-person real-manager in-place pilot is incomplete',
    'seed-receipt-missing': 'the Task 23 seed receipt is absent or not digest-bound',
    'update-receipt-missing': 'the Task 31 update receipt is absent or not digest-bound',
    'dev-archival-missing': 'the owner DEV-deletion record with devArchival attestation is absent',
    'release-environment-missing': 'the protected release environment is absent or incomplete',
    'immutable-releases-missing': 'immutable releases are not enabled with evidence',
    'owner-evidence-incomplete': 'an owner evidence item is missing timestamp/actor/ref/API digest',
    'release-state-not-ready': 'schema-v2 release state is not stable:true with every pre-publication gate',
    'assets-unverified': 'the exact release assets are not present or do not match the artifact digest',
    'checksum-mismatch': 'a release asset checksum or published asset digest does not match',
    'source-archive-substituted': 'a source archive was substituted for the userscript asset',
    'tag-missing': 'the exact annotated release tag does not exist yet',
    'tag-name-mismatch': 'the tag name does not match the release version',
    'tag-not-annotated': 'the tag is lightweight; an annotated tag is required',
    'tag-off-release-branch': 'the tagged commit is not contained in the release branch',
    'tag-target-mismatch': 'the tag does not point at the recorded release head',
    'draft-missing': 'the verified draft release is absent or no longer a draft',
    'draft-asset-mismatch': 'the draft assets are missing or differ from the workflow artifact',
    'draft-attestation-missing': 'a draft asset build attestation is absent or does not verify',
    'published-missing': 'the published release does not exist or is still a draft',
    'mutable-release': 'immutable releases are not enabled/verified, so the release is mutable',
    'release-attestation-mismatch': 'the published release attestation does not verify',
    'publication-not-recorded': 'publication.tagAndRelease has not been recorded after verification',
    'publication-claim-unverified': 'publication.tagAndRelease is claimed before the release was verified',
    'inconsistent-readiness-state': 'the bundle mixes prerequisites from incompatible readiness stages',
  };
  return messages[code] || code;
}


class ReleaseError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function isPlainName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name === path.basename(name)
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..'
    && !path.isAbsolute(name);
}

function requirePlainName(name, code, label) {
  if (!isPlainName(name)) throw new ReleaseError(code, `${label} is not a plain basename: ${String(name)}`);
}

function readRegularFile(dir, name) {
  const file = path.join(dir, name);
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    throw new ReleaseError('missing-asset', `release asset is missing: ${name}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ReleaseError('non-regular-asset', `release asset is not a regular file: ${name}`);
  }
  return fs.readFileSync(file);
}

function readJsonAsset(dir, name) {
  const bytes = readRegularFile(dir, name);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const code = name === SBOM ? 'malformed-sbom' : 'malformed-release-manifest';
    throw new ReleaseError(code, `${name} is not valid JSON: ${error.message}`);
  }
}

function parseSha256Sums(text) {
  const entries = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new ReleaseError('malformed-sha256sums', `SHA256SUMS line is malformed: ${line}`);
    const name = match[2];
    requirePlainName(name, 'path-traversal', 'SHA256SUMS entry');
    if (seen.has(name)) throw new ReleaseError('duplicate-asset', `SHA256SUMS lists a duplicate name: ${name}`);
    seen.add(name);
    entries.push({ sha256: match[1], name });
  }
  return entries;
}

function epochToSpdx(epoch) {
  return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ReleaseError('malformed-release-manifest', 'release-manifest.json must be a JSON object');
  }
  if (manifest.schemaVersion !== 1) throw new ReleaseError('unsupported-schema', `unsupported release-manifest schemaVersion: ${String(manifest.schemaVersion)}`);
  if (typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new ReleaseError('malformed-release-manifest', `release version is invalid: ${String(manifest.version)}`);
  }
  if (manifest.releaseId !== `taa-${manifest.version}`) throw new ReleaseError('malformed-release-manifest', `releaseId must be taa-${manifest.version}`);
  if (manifest.tag !== `v${manifest.version}`) throw new ReleaseError('malformed-release-manifest', `tag must be v${manifest.version}`);
  const source = manifest.source;
  if (!source || !/^[0-9a-f]{40}$/.test(source.commit || '') || !/^[0-9a-f]{40}$/.test(source.tree || '')) {
    throw new ReleaseError('malformed-release-manifest', 'source.commit and source.tree must be 40-hex git object ids');
  }
  if (typeof source.branch !== 'string' || source.branch.length === 0) throw new ReleaseError('malformed-release-manifest', 'source.branch is missing');
  if (!Number.isInteger(source.sourceDateEpoch) || source.sourceDateEpoch < 0) throw new ReleaseError('malformed-release-manifest', 'source.sourceDateEpoch must be a non-negative integer');
  const toolchain = manifest.toolchain;
  if (!toolchain || typeof toolchain.esbuild !== 'string' || typeof toolchain.typescript !== 'string' || !Number.isInteger(toolchain.nodeMajor)) {
    throw new ReleaseError('malformed-release-manifest', 'toolchain must pin esbuild, typescript and nodeMajor');
  }
  const sbom = manifest.sbom;
  if (!sbom || sbom.file !== SBOM || sbom.format !== SPDX_VERSION || sbom.classification !== SBOM_CLASSIFICATION) {
    throw new ReleaseError('sbom-classification-mismatch', `release-manifest sbom must declare ${SBOM} as an ${SBOM_CLASSIFICATION} ${SPDX_VERSION} document`);
  }
  if (sbom.runtimeDependencies !== 0 || sbom.statement !== ZERO_RUNTIME_DEPENDENCIES_STATEMENT) {
    throw new ReleaseError('sbom-runtime-dependency-misstatement', 'release-manifest must state the userscript has zero runtime package dependencies');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== PRIMARY_ASSETS.length) {
    throw new ReleaseError('malformed-release-manifest', `release-manifest must declare exactly ${PRIMARY_ASSETS.length} primary assets`);
  }
  const names = manifest.assets.map((asset) => asset && asset.name);
  for (const name of names) requirePlainName(name, 'path-traversal', 'release-manifest asset name');
  for (const forbidden of [SHA256SUMS, RELEASE_MANIFEST]) {
    if (names.includes(forbidden)) throw new ReleaseError('self-referential-asset', `release-manifest must not digest ${forbidden}`);
  }
  if (new Set(names).size !== names.length) throw new ReleaseError('duplicate-asset', 'release-manifest declares duplicate asset names');
  for (let index = 0; index < PRIMARY_ASSETS.length; index += 1) {
    if (names[index] !== PRIMARY_ASSETS[index]) {
      throw new ReleaseError('malformed-release-manifest', `release-manifest assets must be ordered ${PRIMARY_ASSETS.join(', ')}`);
    }
    const asset = manifest.assets[index];
    if (!Number.isInteger(asset.bytes) || asset.bytes < 0 || !/^[0-9a-f]{64}$/.test(asset.sha256 || '')) {
      throw new ReleaseError('malformed-release-manifest', `release-manifest asset ${asset.name} needs integer bytes and a sha256 digest`);
    }
  }
}

function verifySbom(sbom, manifest) {
  if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom)) throw new ReleaseError('malformed-sbom', 'sbom.spdx.json must be a JSON object');
  if (sbom.spdxVersion !== SPDX_VERSION) throw new ReleaseError('malformed-sbom', `sbom spdxVersion must be ${SPDX_VERSION}`);
  if (sbom.dataLicense !== 'CC0-1.0') throw new ReleaseError('malformed-sbom', 'sbom dataLicense must be CC0-1.0');
  if (sbom.SPDXID !== 'SPDXRef-DOCUMENT') throw new ReleaseError('malformed-sbom', 'sbom SPDXID must be SPDXRef-DOCUMENT');
  const info = sbom.creationInfo;
  const expectedCreated = epochToSpdx(manifest.source.sourceDateEpoch);
  if (!info || info.created !== expectedCreated) {
    throw new ReleaseError('sbom-timestamp-mismatch', `sbom creation timestamp must derive from SOURCE_DATE_EPOCH (${expectedCreated})`);
  }
  const packages = Array.isArray(sbom.packages) ? sbom.packages : null;
  if (!packages || packages.length === 0) throw new ReleaseError('malformed-sbom', 'sbom must declare packages');
  const ids = new Set();
  for (const pkg of packages) {
    if (!pkg || typeof pkg.SPDXID !== 'string' || typeof pkg.name !== 'string') throw new ReleaseError('malformed-sbom', 'each sbom package needs SPDXID and name');
    if (ids.has(pkg.SPDXID)) throw new ReleaseError('duplicate-asset', `sbom declares duplicate SPDXID ${pkg.SPDXID}`);
    ids.add(pkg.SPDXID);
  }
  const root = packages.find((pkg) => pkg.primaryPackagePurpose === 'APPLICATION');
  if (!root) throw new ReleaseError('malformed-sbom', 'sbom must declare the userscript APPLICATION package');
  if (typeof root.comment !== 'string' || !root.comment.includes(ZERO_RUNTIME_DEPENDENCIES_STATEMENT)) {
    throw new ReleaseError('sbom-runtime-dependency-misstatement', 'sbom root package must state zero runtime package dependencies');
  }
  const relationships = Array.isArray(sbom.relationships) ? sbom.relationships : [];
  for (const relationship of relationships) {
    if (!relationship || typeof relationship.spdxElementId !== 'string' || typeof relationship.relationshipType !== 'string') {
      throw new ReleaseError('malformed-sbom', 'each sbom relationship needs spdxElementId and relationshipType');
    }
    if (relationship.relationshipType === 'RUNTIME_DEPENDENCY_OF' || relationship.relationshipType === 'DEPENDENCY_OF') {
      throw new ReleaseError('sbom-runtime-dependency-misstatement', `sbom must not declare runtime dependencies (${relationship.spdxElementId} ${relationship.relationshipType})`);
    }
  }
  const describes = Array.isArray(sbom.documentDescribes) ? sbom.documentDescribes : [];
  if (!describes.includes(root.SPDXID)) throw new ReleaseError('malformed-sbom', 'sbom documentDescribes must name the userscript package');
}

function verifyReleaseDirectory(dir) {
  let dirStats;
  try {
    dirStats = fs.lstatSync(dir);
  } catch {
    throw new ReleaseError('missing-asset', `release directory is missing: ${dir}`);
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) throw new ReleaseError('non-regular-asset', `release path is not a directory: ${dir}`);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const present = new Set();
  for (const entry of entries) {
    requirePlainName(entry.name, 'path-traversal', 'release directory entry');
    if (!entry.isFile()) throw new ReleaseError('non-regular-asset', `release entry is not a regular file: ${entry.name}`);
    if (present.has(entry.name)) throw new ReleaseError('duplicate-asset', `release directory lists a duplicate name: ${entry.name}`);
    present.add(entry.name);
  }
  for (const name of ALL_ASSETS) {
    if (!present.has(name)) throw new ReleaseError('missing-asset', `release asset is missing: ${name}`);
  }
  for (const name of present) {
    if (!ALL_ASSETS.includes(name)) throw new ReleaseError('unexpected-asset', `release directory contains an undeclared asset: ${name}`);
  }

  const manifest = readJsonAsset(dir, RELEASE_MANIFEST);
  verifyManifest(manifest);

  const actualDigests = new Map();
  for (const asset of manifest.assets) {
    const bytes = readRegularFile(dir, asset.name);
    const digest = sha256(bytes);
    if (bytes.length !== asset.bytes || digest !== asset.sha256) {
      throw new ReleaseError('digest-mismatch', `release-manifest digest mismatch for ${asset.name}`);
    }
    actualDigests.set(asset.name, { bytes: bytes.length, sha256: digest });
  }

  const sumsText = readRegularFile(dir, SHA256SUMS).toString('utf8');
  const sums = parseSha256Sums(sumsText);
  const sumNames = sums.map((entry) => entry.name);
  if (sumNames.length !== SHA256SUMS_ASSETS.length || SHA256SUMS_ASSETS.some((name, index) => sumNames[index] !== name)) {
    throw new ReleaseError('malformed-sha256sums', `SHA256SUMS must list exactly ${SHA256SUMS_ASSETS.join(', ')} in order`);
  }
  for (const entry of sums) {
    const bytes = readRegularFile(dir, entry.name);
    if (sha256(bytes) !== entry.sha256) throw new ReleaseError('checksum-mismatch', `SHA256SUMS digest mismatch for ${entry.name}`);
  }

  // Sidecar consistency: the existing sidecar records the userscript digest.
  const sidecarText = readRegularFile(dir, SIDECAR).toString('utf8');
  const sidecarMatch = /^([0-9a-f]{64}) {2}/.exec(sidecarText);
  if (!sidecarMatch) throw new ReleaseError('malformed-sha256sums', 'userscript sidecar does not start with a sha256 digest');
  if (sidecarMatch[1] !== actualDigests.get(USERSCRIPT).sha256) {
    throw new ReleaseError('sidecar-mismatch', 'userscript sidecar digest does not match the userscript asset');
  }

  verifySbom(readJsonAsset(dir, SBOM), manifest);

  return {
    verdict: 'PASS',
    directory: dir,
    version: manifest.version,
    releaseId: manifest.releaseId,
    tag: manifest.tag,
    commit: manifest.source.commit,
    tree: manifest.source.tree,
    assetCount: ALL_ASSETS.length,
    primaryAssetCount: manifest.assets.length,
    assets: manifest.assets.map((asset) => ({ name: asset.name, bytes: asset.bytes, sha256: asset.sha256 })),
  };
}

function readReadinessBundle(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new ReleaseError('missing-readiness-bundle', `readiness bundle is missing: ${file}`, 2);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ReleaseError('malformed-readiness-bundle', `readiness bundle is not valid JSON: ${error.message}`, 2);
  }
}

function parseArgs(argv) {
  const options = { root: ROOT, dir: null, offlineFixture: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') { options.root = path.resolve(argv[++index] || ''); }
    else if (arg === '--dir') { options.dir = path.resolve(argv[++index] || ''); }
    else if (arg === '--offline-fixture') { options.offlineFixture = path.resolve(argv[++index] || ''); }
    else if (arg === '--json') { options.json = true; }
    else throw new ReleaseError('usage', `unknown argument: ${arg}\n${USAGE}`, 2);
  }
  if (!options.dir) options.dir = path.join(options.root, 'release');
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
    if (options.offlineFixture) {
      const report = evaluateReadiness(readReadinessBundle(options.offlineFixture));
      const payload = { verdict: report.state, ...report, fixture: options.offlineFixture };
      if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else {
        const suffix = report.code ? ` (${report.code})` : '';
        process.stdout.write(`RELEASE READINESS: ${report.state}${suffix}\n`);
      }
      process.exitCode = 0;
      return;
    }
    const result = verifyReleaseDirectory(options.dir);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`RELEASE CHECK PASS: ${result.releaseId} ${result.tag} ${result.assetCount} assets at ${result.directory}\n`);
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : 'internal-error';
    if (options.json) process.stdout.write(`${JSON.stringify({ verdict: 'FAIL', code, message: error.message }, null, 2)}\n`);
    else process.stderr.write(`RELEASE CHECK FAIL: ${code}: ${error.message}\n`);
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 2;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseError,
  verifyReleaseDirectory,
  verifyManifest,
  verifySbom,
  parseSha256Sums,
  sha256,
  sha256File,
  epochToSpdx,
  isPlainName,
  evaluateReadiness,
  validateReadinessBundle,
  ownerEvidenceComplete,
  READINESS_STATES,
  PRE_PUBLICATION_GATES,
  REQUIRED_CHECKS,
  constants: {
    ROOT,
    USERSCRIPT,
    SIDECAR,
    METADATA,
    MODULE_MANIFEST,
    SBOM,
    RELEASE_MANIFEST,
    SHA256SUMS,
    PRIMARY_ASSETS,
    SHA256SUMS_ASSETS,
    ALL_ASSETS,
    SPDX_VERSION,
    SBOM_CLASSIFICATION,
    ZERO_RUNTIME_DEPENDENCIES_STATEMENT,
  },
};
