'use strict';

// Task 29 release-workflow contract.
//
// `.github/workflows/release.yml` is the ONLY workflow allowed to write to the
// repository. It must therefore be provably least-privilege and solo-owner:
//
//   * tag-only `v*` trigger (no pull_request / branch / dispatch trigger), so
//     an untrusted event can never reach a write or OIDC job;
//   * top-level `permissions: {}` plus exact per-job permission blocks, with
//     `id-token`/`attestations` NEVER co-located with `contents: write`;
//   * every action pinned to a full 40-char SHA from the official `actions`
//     owner with a stable version comment;
//   * the build job verifies the annotated exact-version tag, the release-branch
//     ancestry and the schema-v2 `stable: true` release state (with every
//     pre-publication owner gate populated and `publication.tagAndRelease` still
//     false) before it prepares and uploads the exact release directory;
//   * the attestation job is OIDC-only and attests `SHA256SUMS`;
//   * the draft job is idempotent, uses `--draft --verify-tag --generate-notes`,
//     and rejects an existing published or mismatched draft;
//   * the publish job depends on build/attest/draft, attaches no environment and
//     references no secret: it runs entirely on the automatic `github.token`
//     (contents: write) so a solo maintainer can publish without a second
//     account, an environment reviewer or a settings-read token; it verifies
//     the tag still targets the source commit, validates the complete
//     downloaded AND API-reported draft asset set against the exact seven-name
//     allowlist (extras, omissions and duplicates fail closed), reverifies the
//     workflow artifact against every remote draft asset, verifies build
//     attestations, records immutable evidence, re-fetches the draft immediately
//     before performing exactly one publish mutation and rejects any changed
//     release id/tag/draft state or asset id/name/size/digest, then verifies
//     the published immutable release, exact asset digests, and that the tag
//     still points at the source commit (a retargeted tag is an incident, never
//     success).
//
// `analyzeReleaseWorkflow()` is a pure, offline analyzer over the workflow
// source. The suite runs it against the real file (zero violations) and against
// a series of byte-level mutations to prove every rejection class fails closed.
// No YAML dependency is used; the parser is purpose-built and asserts instead of
// skipping malformed input.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = process.env.TAA_REPO_ROOT ? path.resolve(process.env.TAA_REPO_ROOT) : path.resolve(__dirname, '..', '..');
const RELEASE_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const MAX_JOB_TIMEOUT_MINUTES = 120;
const ALLOWED_ACTION_OWNERS = ['actions'];
const EXPECTED_JOBS = ['release-attest', 'release-build', 'release-draft', 'release-publish'];
const PRE_PUBLICATION_GATES = ['pilotInstallBySecondPerson', 'evidenceRecord', 'branchProtection', 'devArchival', 'releaseEnvironment', 'immutableReleases'];

function readReleaseWorkflow() {
  assert.ok(fs.existsSync(RELEASE_WORKFLOW), '.github/workflows/release.yml must exist');
  return fs.readFileSync(RELEASE_WORKFLOW, 'utf8');
}

function extractOnBlock(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (start === -1) return '';
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && /^\S/u.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

function sliceJobs(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.notEqual(start, -1, 'release workflow must declare jobs:');
  const jobs = {};
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) { current = header[1]; jobs[current] = []; continue; }
    if (current) jobs[current].push(line.startsWith('  ') ? line.slice(2) : line);
  }
  const result = {};
  for (const [name, body] of Object.entries(jobs)) result[name] = body.join('\n');
  return result;
}

function jobPermissions(jobText) {
  const lines = jobText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^ {2}permissions:\s*(?:\{\})?\s*$/u.test(line));
  if (start === -1) return null;
  if (/\{\}/u.test(lines[start])) return {};
  const map = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const entry = /^ {4}([A-Za-z0-9_-]+):\s*(\S+)\s*$/u.exec(line);
    if (!entry) break;
    map[entry[1]] = entry[2];
  }
  return map;
}

function jobTimeout(jobText) {
  const match = /^ {2}timeout-minutes:\s*(\d+)\s*$/mu.exec(jobText);
  return match ? Number(match[1]) : null;
}

function jobNeeds(jobText) {
  const inline = /^ {2}needs:\s*\[([^\]]*)\]\s*$/mu.exec(jobText);
  if (inline) return inline[1].split(',').map((entry) => entry.trim()).filter(Boolean);
  const lines = jobText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^ {2}needs:\s*$/u.test(line));
  if (start === -1) return [];
  const needs = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const entry = /^ {4}-\s*(\S+)\s*$/u.exec(lines[index]);
    if (!entry) break;
    needs.push(entry[1]);
  }
  return needs;
}

function jobSteps(jobText) {
  const lines = jobText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^ {2}steps:\s*$/u.test(line));
  if (start === -1) return [];
  const steps = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < 4) break;
    if (/^ {4}- /u.test(line)) { current = [line.slice(6)]; steps.push(current); continue; }
    if (current) current.push(line.slice(6));
  }
  return steps.map((stepLines) => stepLines.join('\n'));
}

function actionReferences(source) {
  const references = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    const match = /^\s*uses:\s+(\S+)(?:\s+#\s*(.*?))?\s*$/u.exec(line);
    if (!match) return;
    references.push({ line: index + 1, reference: match[1], comment: (match[2] ?? '').trim() });
  });
  return references;
}

// Pure offline analyzer: returns every contract violation it can prove.
function analyzeReleaseWorkflow(source) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  const onBlock = extractOnBlock(source);
  const pushEvent = /^\s{2}push:\s*$/mu.test(onBlock);
  const tagFilter = /^\s{4}tags:\s*$/mu.test(onBlock);
  const vstar = /^\s{6}-\s*['"]?v\*['"]?\s*$/mu.test(onBlock);
  const forbiddenEvent = /^\s{2}(pull_request|pull_request_target|workflow_dispatch|schedule|workflow_run|repository_dispatch|release):/mu.test(onBlock);
  const branchFilter = /^\s{4}branches:/mu.test(onBlock);
  if (!pushEvent || !tagFilter || !vstar || forbiddenEvent || branchFilter) {
    add('non-tag-trigger', 'release workflow must trigger only on pushed v* tags');
  }

  if (!/^permissions:\s*\{\}\s*$/mu.test(source)) add('permissions-not-empty', 'release workflow must set top-level permissions: {}');
  if (!/^concurrency:\s*$/mu.test(source)) add('concurrency-missing', 'release workflow must declare concurrency');
  else {
    const concurrency = source.slice(source.search(/^concurrency:\s*$/mu));
    const group = concurrency.slice(0, concurrency.indexOf('\njobs:') === -1 ? undefined : concurrency.indexOf('\njobs:'));
    if (!/group:\s*release-\$\{\{\s*github\.ref\s*\}\}/u.test(group)) add('concurrency-missing', 'concurrency group must be scoped to github.ref');
    if (!/cancel-in-progress:\s*false\s*$/mu.test(group)) add('concurrency-cancel', 'release concurrency must not cancel in-progress runs');
  }

  const jobs = sliceJobs(source);
  const jobNames = Object.keys(jobs).sort();
  if (JSON.stringify(jobNames) !== JSON.stringify(EXPECTED_JOBS)) add('job-set', `unexpected release jobs: ${jobNames.join(', ')}`);

  for (const [name, jobText] of Object.entries(jobs)) {
    const timeout = jobTimeout(jobText);
    if (timeout === null || timeout < 1 || timeout > MAX_JOB_TIMEOUT_MINUTES) add('unbounded-job', `${name} must declare a bounded timeout-minutes`);
    const permissions = jobPermissions(jobText);
    if (permissions === null) {
      add('missing-job-permissions', `${name} must declare job permissions`);
    } else {
      const writesContents = permissions.contents === 'write';
      const oidc = permissions['id-token'] === 'write' || permissions.attestations === 'write';
      if (writesContents && oidc) add('permission-colocation', `${name} co-locates contents: write with id-token/attestations write`);
    }
  }

  function expectPermissions(name, expected) {
    const actual = jobPermissions(jobs[name] || '');
    if (!actual) { add('missing-job-permissions', `${name} must declare job permissions`); return; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) add('wrong-job-permissions', `${name} permissions ${JSON.stringify(actual)} do not match ${JSON.stringify(expected)}`);
  }
  expectPermissions('release-build', { contents: 'read' });
  expectPermissions('release-attest', { contents: 'read', 'id-token': 'write', attestations: 'write' });
  expectPermissions('release-draft', { contents: 'write' });
  expectPermissions('release-publish', { contents: 'write' });

  for (const reference of actionReferences(source)) {
    const parts = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@(\S+)$/u.exec(reference.reference);
    if (!parts) { add('malformed-action', `line ${reference.line}: not an owner/repo@ref reference: ${reference.reference}`); continue; }
    if (!ALLOWED_ACTION_OWNERS.includes(parts[1])) add('untrusted-action-owner', `line ${reference.line}: unexpected action owner ${parts[1]}`);
    if (!/^[0-9a-f]{40}$/u.test(parts[3])) add('mutable-action-ref', `line ${reference.line}: mutable action ref ${parts[3]}`);
    if (!/^v\d+\.\d+\.\d+$/u.test(reference.comment)) add('missing-version-comment', `line ${reference.line}: pinned action needs a vX.Y.Z comment`);
  }
  if (/action-gh-release|softprops|peaceiris|pypa\/ghaction/u.test(source)) add('third-party-release-action', 'release workflow must not use a third-party release action');

  const build = jobs['release-build'] || '';
  if (!/^\s{8}ref:\s*\$\{\{\s*github\.ref\s*\}\}\s*$/mu.test(build)) add('build-not-tag-ref', 'build must check out the triggering tag ref');
  if (!/^\s{8}fetch-depth:\s*0\s*$/mu.test(build)) add('missing-history', 'build must fetch full history for tag/ancestry validation');
  if (!/cat-file/u.test(build) || !/tag-not-annotated/u.test(build)) add('missing-tag-check', 'build must require an annotated tag');
  if (!/--is-ancestor/u.test(build)) add('missing-ancestry-check', 'build must validate release-branch ancestry');
  if (!/schemaVersion\s*!==\s*2/u.test(build)) add('missing-schema-check', 'build must require release-state schema v2');
  if (!/stable\s*!==\s*true/u.test(build)) add('missing-stable-check', 'build must require stable: true');
  if (!/publication\.tagAndRelease\s*!==\s*false/u.test(build)) add('circular-release-state-gate', 'build must require publication.tagAndRelease to still be false');
  for (const gate of PRE_PUBLICATION_GATES) {
    if (!build.includes(gate)) add('missing-owner-gate', `build must require the ${gate} owner gate`);
  }
  if (!/npm ci/u.test(build)) add('missing-npm-ci', 'build must install locked dependencies');
  if (!/release:prepare/u.test(build) || !/release:check/u.test(build)) add('missing-release-prepare', 'build must run deterministic release preparation and verification');
  if (!/actions\/upload-artifact@/u.test(build)) add('missing-artifact-upload', 'build must upload the exact release directory');
  if (!/^\s{8}retention-days:\s*\d+\s*$/mu.test(build)) add('missing-retention', 'build artifact retention must be bounded');
  for (const output of ['artifact-id', 'artifact-digest', 'run-id', 'source-sha', 'source-tree', 'release-manifest-sha256']) {
    if (!new RegExp(`^ {4}${output}:`, 'mu').test(build)) add('missing-output', `build must expose the ${output} job output`);
  }

  const attest = jobs['release-attest'] || '';
  if (!/actions\/attest@/u.test(attest)) add('missing-attest', 'attestation job must use actions/attest');
  if (!/^\s{8}subject-checksums:\s*release\/SHA256SUMS\s*$/mu.test(attest)) add('missing-attest-subject-checksums', 'attestation job must attest release/SHA256SUMS');
  if (!/actions\/download-artifact@/u.test(attest)) add('missing-artifact-download', 'attestation job must download the workflow artifact');

  const draft = jobs['release-draft'] || '';
  for (const match of source.matchAll(/gh\s+release\s+create[^\n]*/gu)) {
    if (!/--draft/u.test(match[0])) add('draft-bypass', 'every gh release create must create a draft');
  }
  if (!/gh\s+release\s+create/u.test(draft)) add('draft-bypass', 'draft job must create the release');
  if (!/--draft/u.test(draft) || !/--verify-tag/u.test(draft)) add('draft-bypass', 'draft job must pass --draft and --verify-tag');
  if (!/--generate-notes/u.test(draft)) add('missing-generated-notes', 'draft release must use generated notes');
  if (!/--title/u.test(draft)) add('missing-title', 'draft release must set an exact title');
  if (!/actions\/download-artifact@/u.test(draft) || !/artifact-ids:/u.test(draft)) add('missing-artifact-id-binding', 'draft job must download the exact captured artifact');
  if (!/gh\s+release\s+view/u.test(draft) || !/isDraft/u.test(draft)) add('missing-idempotency', 'draft job must be idempotent for the same tag');

  const publish = jobs['release-publish'] || '';
  for (const dependency of ['release-build', 'release-attest', 'release-draft']) {
    if (!jobNeeds(publish).includes(dependency)) add('publish-needs', `publish job must depend on ${dependency}`);
  }
  if (/^\s{2}environment:\s*\S+/mu.test(publish)) add('publish-environment-gate', 'solo mode: publish job must not attach an environment');
  if (/secrets\./u.test(publish)) add('publish-uses-secret', 'solo mode: publish job must run on the automatic github.token only');
  if (!/git\/ref\/tags/u.test(publish) || !/git\/tags/u.test(publish)) add('missing-tag-target-check', 'publish job must resolve and compare the exact tag target');
  if (!/cmp -s/u.test(publish)) add('asset-artifact-attestation-mismatch', 'publish job must byte-compare the workflow artifact and the draft assets');
  if (!/sha256sum -c/u.test(publish)) add('asset-artifact-attestation-mismatch', 'publish job must recheck SHA256SUMS');
  if (!/gh attestation verify/u.test(publish)) add('asset-artifact-attestation-mismatch', 'publish job must verify each build attestation');
  if (!/m\.source\.commit/u.test(publish)) add('asset-artifact-attestation-mismatch', 'publish job must compare the release-manifest source SHA/tree');
  if (!/draftReleaseId/u.test(publish)) add('missing-draft-record', 'publish job must record the draft release id');
  if (!/draft=false/u.test(publish)) add('missing-publish-mutation', 'publish job must publish the verified draft');
  if (!/gh release verify/u.test(publish)) add('missing-post-publish-verify', 'publish job must verify the published release and attestation');
  if (!/asset digests changed after publish/u.test(publish)) add('missing-post-publish-verify', 'publish job must reject changed asset digests after publish');

  // The complete draft asset set must be exactly the seven declared names, both
  // as downloaded and as reported by the API: extras, omissions and duplicates
  // all fail closed before any byte comparison.
  if (!/draft-asset-set-mismatch/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must reject a draft asset set that is not exactly the seven declared assets');
  if (!/new Set\(apiNames\)\.size !== apiNames\.length/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must reject duplicate API-reported draft asset names');
  if (!/JSON\.stringify\(\[\.\.\.apiNames\]\.sort\(\)\) !== JSON\.stringify\(expected\)/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must compare the API-reported draft asset set against the exact allowlist');
  if (!/readdirSync\(/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must validate the complete downloaded asset set');
  if (!/JSON\.stringify\(downloaded\) !== JSON\.stringify\(expected\)/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must compare the downloaded asset set against the exact allowlist');
  if (!/asset\.digest !== digest/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must compare the downloaded bytes against the API-reported digest');
  if (!/asset\.size !== bytes\.length/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must compare the downloaded size against the API-reported size');
  if (!/fingerprint\(listed\.assets\) !== fingerprint\(release\.assets\)/u.test(publish)) add('missing-draft-asset-set-check', 'publish job must reject draft metadata drift between download and evidence snapshot');

  // Immediately before the single publish mutation the draft is fetched again
  // and any changed id, tag, draft state, asset id/name/size/digest, or extra
  // asset fails closed.
  if (!/draft-drift-before-publish/u.test(publish)) add('missing-draft-recheck', 'publish job must re-fetch the draft immediately before the publish mutation');
  if (!/recheck\.draft !== true/u.test(publish)) add('missing-draft-recheck', 'publish job must reject a draft-state change before the publish mutation');
  if (!/recheck\.id !== record\.draftReleaseId/u.test(publish)) add('missing-draft-recheck', 'publish job must reject a changed draft release id before the publish mutation');
  if (!/recheck\.tag_name !== record\.tag/u.test(publish)) add('missing-draft-recheck', 'publish job must reject a changed draft tag before the publish mutation');
  if (!/fingerprint\(recheck\.assets\) !== fingerprint\(record\.assetIds\)/u.test(publish)) add('missing-draft-recheck', 'publish job must reject changed asset ids, names, sizes or digests before the publish mutation');

  // The tag target must be re-resolved after publication; any mismatch is a
  // publication failure, never success. The GitHub-side no-bypass tag ruleset
  // and immutable-releases setting stay in force outside the workflow.
  if (!/tag-target-changed-after-publish/u.test(publish)) add('missing-post-publish-tag-check', 'publish job must treat a retargeted tag after publication as a failure');
  if (!/test "\$tag_commit_after" = "\$SOURCE_SHA"/u.test(publish)) add('missing-post-publish-tag-check', 'publish job must compare the post-publication tag target against the source commit');

  for (const [name, jobText] of Object.entries(jobs)) {
    if (name === 'release-publish') continue;
    if (/gh\s+release\s+edit|--method\s+(?:PATCH|POST|PUT|DELETE)|draft=false/u.test(jobText)) add('direct-auto-publish', `${name} must not mutate a release`);
  }

  if (/\bsecrets\./u.test(source)) add('unexpected-secret', 'solo mode: the release workflow must reference no repository or environment secret');

  return { errors };
}

function analyzeReal() {
  return analyzeReleaseWorkflow(readReleaseWorkflow());
}

function mutate(from, to) {
  const source = readReleaseWorkflow();
  assert.ok(source.includes(from), `mutation anchor not found: ${from}`);
  return source.replace(from, to);
}

function mutateAll(from, to) {
  const source = readReleaseWorkflow();
  assert.ok(source.includes(from), `mutation anchor not found: ${from}`);
  return source.replaceAll(from, to);
}

function mutateSeq(...pairs) {
  let source = readReleaseWorkflow();
  for (const [from, to] of pairs) {
    assert.ok(source.includes(from), `mutation anchor not found: ${from}`);
    source = source.replace(from, to);
  }
  return source;
}

function expectRejected(source, code) {
  const report = analyzeReleaseWorkflow(source);
  assert.ok(
    report.errors.some((error) => error.code === code),
    `expected rejection code ${code}, got ${JSON.stringify(report.errors)}`,
  );
}

test('Given the release workflow, when analyzed, then it has no contract violations', () => {
  const report = analyzeReal();
  assert.deepEqual(report.errors, []);
});

test('Given the release workflow, when the trigger is inspected, then it is tag-only and denies default permissions', () => {
  const source = readReleaseWorkflow();
  const onBlock = extractOnBlock(source);
  assert.match(onBlock, /^\s{2}push:\s*$/mu);
  assert.match(onBlock, /^\s{4}tags:\s*$/mu);
  assert.match(onBlock, /^\s{6}-\s*['"]?v\*['"]?\s*$/mu);
  assert.doesNotMatch(source, /^\s*pull_request_target\s*:/mu);
  assert.doesNotMatch(source, /^\s{2}(pull_request|workflow_dispatch|schedule):/mu);
  assert.doesNotMatch(onBlock, /^\s{4}branches:/mu);
  assert.match(source, /^permissions:\s*\{\}\s*$/mu);
  assert.match(source, /^\s{2}group:\s*release-\$\{\{\s*github\.ref\s*\}\}\s*$/mu);
  assert.match(source, /^\s{2}cancel-in-progress:\s*false\s*$/mu);
});

test('Given the release workflow, when jobs are inspected, then permissions are separated per job', () => {
  const jobs = sliceJobs(readReleaseWorkflow());
  assert.deepEqual(Object.keys(jobs).sort(), EXPECTED_JOBS);
  assert.deepEqual(jobPermissions(jobs['release-build']), { contents: 'read' });
  assert.deepEqual(jobPermissions(jobs['release-attest']), { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.deepEqual(jobPermissions(jobs['release-draft']), { contents: 'write' });
  assert.deepEqual(jobPermissions(jobs['release-publish']), { contents: 'write' });
  assert.equal(jobPermissions(jobs['release-publish']).contents, 'write');
  assert.notEqual(jobPermissions(jobs['release-attest']).contents, 'write');
  assert.doesNotMatch(jobs['release-publish'], /^\s{2}environment:\s*\S+/mu);
  for (const job of Object.values(jobs)) {
    const permissions = jobPermissions(job);
    assert.ok(!(permissions.contents === 'write' && (permissions['id-token'] === 'write' || permissions.attestations === 'write')));
  }
});

test('Given the release workflow, when actions are inspected, then they are immutable official pins', () => {
  const references = actionReferences(readReleaseWorkflow());
  assert.ok(references.length >= 5);
  for (const reference of references) {
    const parts = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@([0-9a-f]{40})$/u.exec(reference.reference);
    assert.ok(parts, `not a full-SHA official pin: ${reference.reference}`);
    assert.equal(parts[1], 'actions');
    assert.match(reference.comment, /^v\d+\.\d+\.\d+$/u);
  }
});

test('Given the release workflow, when the build job is inspected, then it verifies tag/ancestry/state and uploads the exact directory', () => {
  const build = sliceJobs(readReleaseWorkflow())['release-build'];
  assert.match(build, /cat-file/u);
  assert.match(build, /tag-not-annotated/u);
  assert.match(build, /--is-ancestor/u);
  assert.match(build, /schemaVersion\s*!==\s*2/u);
  assert.match(build, /stable\s*!==\s*true/u);
  assert.match(build, /publication\.tagAndRelease\s*!==\s*false/u);
  for (const gate of PRE_PUBLICATION_GATES) assert.ok(build.includes(gate), `missing gate ${gate}`);
  assert.match(build, /npm ci/u);
  assert.match(build, /release:prepare/u);
  assert.match(build, /release:check/u);
  assert.match(build, /actions\/upload-artifact@/u);
  assert.match(build, /artifact-id:/u);
  assert.match(build, /artifact-digest:/u);
});

test('Given the release workflow, when the attestation job is inspected, then it is OIDC-only and attests SHA256SUMS', () => {
  const attest = sliceJobs(readReleaseWorkflow())['release-attest'];
  assert.deepEqual(jobPermissions(attest), { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.match(attest, /actions\/attest@/u);
  assert.match(attest, /subject-checksums:\s*release\/SHA256SUMS/u);
  assert.doesNotMatch(attest, /contents:\s*write/u);
});

test('Given the release workflow, when the draft job is inspected, then it is idempotent and verify-tag gated', () => {
  const draft = sliceJobs(readReleaseWorkflow())['release-draft'];
  assert.match(draft, /gh\s+release\s+create/u);
  assert.match(draft, /--draft/u);
  assert.match(draft, /--verify-tag/u);
  assert.match(draft, /--generate-notes/u);
  assert.match(draft, /--title/u);
  assert.match(draft, /artifact-ids:/u);
  assert.match(draft, /isDraft/u);
  assert.doesNotMatch(draft, /draft=false/u);
});

test('Given the release workflow, when the publish job is inspected, then it is solo-owner and references no environment or secret', () => {
  const publish = sliceJobs(readReleaseWorkflow())['release-publish'];
  assert.deepEqual(jobNeeds(publish).sort(), ['release-attest', 'release-build', 'release-draft']);
  assert.deepEqual(jobPermissions(publish), { contents: 'write' });
  assert.doesNotMatch(publish, /^\s{2}environment:\s*\S+/mu);
  assert.doesNotMatch(publish, /\bsecrets\./u);
  assert.match(publish, /github\.token/u);
  assert.match(publish, /git\/ref\/tags/u);
  assert.match(publish, /gh attestation verify/u);
  assert.match(publish, /draft=false/u);
  assert.match(publish, /gh release verify/u);
});

test('Given a mutable action reference, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2', 'actions/attest@v4'), 'mutable-action-ref');
});

test('Given a permission co-location, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate(
    '      contents: read\n      id-token: write\n      attestations: write',
    '      contents: write\n      id-token: write\n      attestations: write',
  ), 'permission-colocation');
});

test('Given a non-tag trigger, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate("    tags:\n      - 'v*'", '    branches: [release/public-1.0.0]'), 'non-tag-trigger');
});

test('Given a circular release-state gate, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('state.publication.tagAndRelease !== false', 'state.publication.tagAndRelease === true'), 'circular-release-state-gate');
});

test('Given a missing stable check, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('state.stable !== true', 'state.stable === false'), 'missing-stable-check');
});

test('Given a missing annotated-tag check, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate("fail('tag-not-annotated'", "fail('tag-ok'"), 'missing-tag-check');
});

test('Given a missing ancestry check, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate("'--is-ancestor'", "'--x-ancestor'"), 'missing-ancestry-check');
});

test('Given a draft bypass, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('gh release create "$TAG" --draft --verify-tag', 'gh release create "$TAG" --verify-tag'), 'draft-bypass');
});

test('Given an unexpected secret reference, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'unexpected-secret');
});

test('Given an attached environment, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('\n  release-publish:\n    needs:', '\n  release-publish:\n    environment: release\n    needs:'), 'publish-environment-gate');
});

test('Given an asset/artifact/attestation mismatch path, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('gh attestation verify', 'gh attestation inspect'), 'asset-artifact-attestation-mismatch');
});

test('Given a direct auto-publish, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate(
    '\n  release-publish:\n',
    '\n      - name: bypass\n        run: gh release edit "$TAG" --draft=false\n\n  release-publish:\n',
  ), 'direct-auto-publish');
});

test('Given an undeclared extra draft asset, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutateAll('draft-asset-set-mismatch', 'draft-asset-set-ok'), 'missing-draft-asset-set-check');
});

test('Given a missing duplicate-asset guard, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('new Set(apiNames).size !== apiNames.length', 'false'), 'missing-draft-asset-set-check');
});

test('Given an unvalidated downloaded asset directory, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('readdirSync(', 'readdirSyncX('), 'missing-draft-asset-set-check');
});

test('Given a missing pre-publish draft re-fetch, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('draft-drift-before-publish', 'draft-drift-ok'), 'missing-draft-recheck');
});

test('Given a changed draft asset between verification and publish, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('fingerprint(recheck.assets) !== fingerprint(record.assetIds)', 'false'), 'missing-draft-recheck');
});

test('Given a retagged commit after publication, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('test "$tag_commit_after" = "$SOURCE_SHA"', 'true'), 'missing-post-publish-tag-check');
});

test('Given an unchecked API-reported draft asset set, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('JSON.stringify([...apiNames].sort()) !== JSON.stringify(expected)', 'false'), 'missing-draft-asset-set-check');
});

test('Given an unchecked downloaded draft asset set, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('JSON.stringify(downloaded) !== JSON.stringify(expected)', 'false'), 'missing-draft-asset-set-check');
});

test('Given weakened pre-publish recheck fields, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutateSeq(
    ['recheck.draft !== true', 'false'],
    ['recheck.id !== record.draftReleaseId', 'false'],
    ['recheck.tag_name !== record.tag', 'false'],
  ), 'missing-draft-recheck');
});

test('Given downloaded bytes that do not match the API digest, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('asset.digest !== digest', 'false'), 'missing-draft-asset-set-check');
});

test('Given draft metadata that drifted after download, when analyzed, then the workflow is rejected', () => {
  expectRejected(mutate('fingerprint(listed.assets) !== fingerprint(release.assets)', 'false'), 'missing-draft-asset-set-check');
});
