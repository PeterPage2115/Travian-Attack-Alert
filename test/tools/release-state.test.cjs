'use strict';

// Release-gate test (repository-cleanup Task 13): docs/release-state.json
// reports stable:false until every owner-manual pilot field is populated
// with evidence. Automated steps cannot flip owner fields: this test pins
// stable:false while any owner field is unpopulated, and the flip rule it
// enforces requires owner-written evidence for stable:true. Advancing the
// gate therefore requires an owner edit of BOTH docs/release-state.json AND
// this test — no npm script, build step, or CI job does it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_PATH = path.join(ROOT, 'docs', 'release-state.json');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

const OWNER_FIELDS = [
  'pilotInstallBySecondPerson',
  'evidenceRecord',
  'branchProtection',
  'tagAndRelease',
  'devArchival',
];

function isPopulated(value) {
  return value !== false && value !== null && value !== '';
}

describe('release gate (stable-1.0 and DEV retirement)', () => {
  it('pins version identity to package.json', () => {
    assert.equal(state.schemaVersion, 1, 'release-state schemaVersion must be 1');
    assert.equal(state.version, String(pkg.version), 'release-state version must track package.json');
    assert.equal(state.releaseId, `taa-${pkg.version}`, 'release-state releaseId must track package.json');
  });

  it('keeps agent-automated work separate from owner-manual blockers', () => {
    for (const [key, value] of Object.entries(state.agentAutomated)) {
      assert.equal(value, true, `agentAutomated.${key} must stay true (migration accomplished it)`);
    }
    assert.deepEqual(
      Object.keys(state.ownerManual).sort(),
      [...OWNER_FIELDS].sort(),
      'ownerManual must carry exactly the five owner-gated fields',
    );
    const overlap = Object.keys(state.agentAutomated).filter((k) => k in state.ownerManual);
    assert.deepEqual(overlap, [], 'agent and owner fields must not overlap');
  });

  it('reports stable:false while any owner field is unpopulated', () => {
    const pending = OWNER_FIELDS.filter((key) => !isPopulated(state.ownerManual[key]));
    assert.ok(
      pending.length > 0,
      'pilot not yet executed: at least one owner field must stay unpopulated',
    );
    assert.equal(
      state.stable,
      false,
      `stable must stay false until the owner records every pilot field (pending: ${pending.join(', ')})`,
    );
  });

  it('forbids automated flips: stable:true requires every owner field populated with evidence', () => {
    assert.ok(typeof state.flipRule === 'string' && state.flipRule.length > 0, 'flipRule must be documented');
    if (state.stable === true) {
      for (const key of OWNER_FIELDS) {
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
});
