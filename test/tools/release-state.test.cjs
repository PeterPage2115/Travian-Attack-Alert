'use strict';

// Release-gate test (repository-cleanup Task 13; schema v2 Task 27):
// docs/release-state.json separates PRE-PUBLICATION owner gates from
// POST-PUBLICATION evidence. A tag and a GitHub Release cannot exist before
// tagging, so requiring them to flip `stable:true` would be circular; the six
// pre-publication gates alone gate `stable`, while PUBLISHED_VERIFIED
// additionally requires publication.tagAndRelease.
//
// Automated steps cannot flip owner fields: this test pins stable:false while
// any pre-publication owner field is unpopulated, and the flip rule it
// enforces requires owner-written evidence for stable:true. Advancing the gate
// therefore requires an owner edit of BOTH docs/release-state.json AND this
// test — no npm script, build step, or CI job does it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_PATH = path.join(ROOT, 'docs', 'release-state.json');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// Schema v2 (Task 27): every field below must be populated by the owner before
// `stable` may become true. publication.tagAndRelease is deliberately NOT in
// this list: it is post-publication evidence that can only be recorded after
// the tag and the GitHub Release exist.
const PRE_PUBLICATION_FIELDS = [
  'pilotInstallBySecondPerson',
  'evidenceRecord',
  'branchProtection',
  'devArchival',
  'releaseEnvironment',
  'immutableReleases',
];
const PUBLICATION_FIELDS = ['tagAndRelease'];
const TOP_LEVEL_FIELDS = [
  'agentAutomated',
  'flipRule',
  'gateDocs',
  'ownerManual',
  'publication',
  'releaseId',
  'schemaVersion',
  'stable',
  'version',
];

function isPopulated(value) {
  return value !== false && value !== null && value !== '';
}

/** Pre-publication readiness: all six owner gates recorded, nothing else. */
function prePublicationReady(candidate) {
  return PRE_PUBLICATION_FIELDS.every((key) => isPopulated(candidate.ownerManual?.[key]));
}

/**
 * PUBLISHED_VERIFIED: stable plus a recorded tag/Release. It is intentionally
 * a separate predicate from prePublicationReady so a release candidate can be
 * stable-ready before it is tagged without ever claiming a Release exists.
 */
function publishedVerified(candidate) {
  return candidate.stable === true
    && prePublicationReady(candidate)
    && isPopulated(candidate.publication?.tagAndRelease);
}

/** A synthetic state that satisfies every pre-publication gate but has no tag. */
function syntheticPrePublicationState(overrides = {}) {
  return {
    stable: true,
    ownerManual: Object.fromEntries(
      PRE_PUBLICATION_FIELDS.map((key) => [key, key === 'evidenceRecord' ? 'docs/release-history/1.0.0-rc/PILOT.md' : true]),
    ),
    publication: { tagAndRelease: false },
    ...overrides,
  };
}

describe('release gate (stable-1.0, schema v2)', () => {
  it('pins version identity to package.json', () => {
    assert.equal(state.schemaVersion, 2, 'release-state schemaVersion must be 2');
    assert.equal(state.version, String(pkg.version), 'release-state version must track package.json');
    assert.equal(state.releaseId, `taa-${pkg.version}`, 'release-state releaseId must track package.json');
  });

  it('keeps agent-automated work separate from owner-manual and publication gates', () => {
    for (const [key, value] of Object.entries(state.agentAutomated)) {
      assert.equal(value, true, `agentAutomated.${key} must stay true (migration accomplished it)`);
    }
    assert.deepEqual(
      Object.keys(state.ownerManual).sort(),
      [...PRE_PUBLICATION_FIELDS].sort(),
      'ownerManual must carry exactly the six pre-publication owner-gated fields',
    );
    assert.deepEqual(
      Object.keys(state.publication).sort(),
      [...PUBLICATION_FIELDS].sort(),
      'publication must carry exactly the post-publication tagAndRelease field',
    );
    const ownerFields = [...Object.keys(state.ownerManual), ...Object.keys(state.publication)];
    const overlap = Object.keys(state.agentAutomated).filter((key) => ownerFields.includes(key));
    assert.deepEqual(overlap, [], 'agent and owner fields must not overlap');
    assert.deepEqual(
      Object.keys(state).sort(),
      [...TOP_LEVEL_FIELDS].sort(),
      'release-state schema v2 must not grow undocumented top-level fields',
    );
  });

  it('references only gate documents that exist in the repository', () => {
    assert.ok(Array.isArray(state.gateDocs) && state.gateDocs.length > 0, 'gateDocs must not be empty');
    for (const relative of state.gateDocs) {
      assert.equal(path.isAbsolute(relative), false, `gateDocs entries must be repository-relative: ${relative}`);
      assert.ok(fs.existsSync(path.join(ROOT, relative)), `gateDocs entry does not exist: ${relative}`);
    }
  });

  it('reports stable:false while any pre-publication owner field is unpopulated', () => {
    const pending = PRE_PUBLICATION_FIELDS.filter((key) => !isPopulated(state.ownerManual[key]));
    assert.ok(
      pending.length > 0,
      'pilot not yet executed: at least one pre-publication owner field must stay unpopulated',
    );
    assert.equal(
      state.stable,
      false,
      `stable must stay false until the owner records every pre-publication field (pending: ${pending.join(', ')})`,
    );
  });

  it('forbids automated flips: stable:true requires every pre-publication owner field with evidence', () => {
    assert.ok(typeof state.flipRule === 'string' && state.flipRule.length > 0, 'flipRule must be documented');
    if (state.stable === true) {
      for (const key of PRE_PUBLICATION_FIELDS) {
        assert.ok(
          isPopulated(state.ownerManual[key]),
          `stable:true requires owner-populated ${key} — automation cannot supply it`,
        );
      }
      assert.ok(
        typeof state.ownerManual.evidenceRecord === 'string' && state.ownerManual.evidenceRecord.length > 0,
        'stable:true requires a recorded evidence reference, never an empty owner field',
      );
    } else {
      assert.equal(state.stable, false, 'stable must be exactly false until the owner flips it with evidence');
    }
  });

  it('keeps the pre-publication gate non-circular: stable:true never requires a Release that cannot exist yet', () => {
    const untagged = syntheticPrePublicationState();
    assert.equal(prePublicationReady(untagged), true, 'all six pre-publication gates alone must satisfy stable readiness');
    assert.equal(publishedVerified(untagged), false, 'an untagged stable candidate is not PUBLISHED_VERIFIED');
    const missingGate = syntheticPrePublicationState({
      ownerManual: { ...untagged.ownerManual, branchProtection: false },
    });
    assert.equal(
      prePublicationReady(missingGate),
      false,
      'misleading success rejected: stable:true with any pre-publication gate missing must not pass',
    );
  });

  it('separates post-publication evidence: PUBLISHED_VERIFIED additionally requires publication.tagAndRelease', () => {
    assert.equal(publishedVerified(state), false, 'the live state must not claim a published, verified release');
    assert.equal(state.publication.tagAndRelease, false, 'no tag or Release may be recorded before the owner publishes one');
    const tagged = syntheticPrePublicationState({ publication: { tagAndRelease: 'v1.0.0 + GitHub Release' } });
    assert.equal(publishedVerified(tagged), true, 'a recorded tag/Release must complete PUBLISHED_VERIFIED');
    const untaggedStable = syntheticPrePublicationState();
    assert.equal(publishedVerified(untaggedStable), false, 'stable alone must never imply a published Release');
    const unpublished = syntheticPrePublicationState({ stable: false, publication: { tagAndRelease: 'v1.0.0' } });
    assert.equal(publishedVerified(unpublished), false, 'a tag without stable must not report PUBLISHED_VERIFIED');
  });

  it('documents both stages in the flip rule', () => {
    assert.match(state.flipRule, /ownerManual/u, 'flipRule must name the pre-publication owner record');
    assert.match(state.flipRule, /publication\.tagAndRelease/u, 'flipRule must name the post-publication evidence');
    assert.match(state.flipRule, /stable/u, 'flipRule must name the stable flag it governs');
  });
});
