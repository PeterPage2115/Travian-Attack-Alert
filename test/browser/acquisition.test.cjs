'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const script = require('../../src/runtime.js');
const acquisitionBrowser = require('../fixtures/acquisition/browser-harness.cjs');

const HOST = 'world.example.invalid';

test('Players workspace fixture: rejected browser DOM gets a labelled cached roster', async () => {
    const rejected = await acquisitionBrowser.extractRejectedFixtureSnapshots(['missing-player-id']);
    const model = script.buildPlayerWorkspaceReadModel({
        snapshot: rejected['missing-player-id'].snapshot,
        cachedRoster: { '900001': { name: 'Fixture cached player' } }
    });
    assert.equal(rejected['missing-player-id'].snapshot.status, 'rejected');
    assert.equal(model.rosterStatusText, 'Live roster unavailable — showing last accepted roster (1 players). Reason: missing-player-id');
    assert.equal(model.rows[0].name, 'Fixture cached player');
});

test('sanitized acquisition fixtures exercise the real DOM snapshot path', async () => {
    const snapshots = await acquisitionBrowser.extractFixtureSnapshots([
        'members-60', 'members-59-incident'
    ]);
    assert.equal(snapshots['members-60'].status, 'authoritative');
    assert.equal(Object.keys(snapshots['members-60'].membersById).length, 60);
    assert.equal(snapshots['members-59-incident'].status, 'authoritative');
    assert.equal(Object.keys(snapshots['members-59-incident'].membersById).length, 59);
    const incidentMembers = Object.values(snapshots['members-59-incident'].membersById);
    assert.equal(incidentMembers.reduce((sum, member) => sum + member.attackCount, 0), 2);
    assert.equal(incidentMembers.reduce((sum, member) => sum + member.raidCount, 0), 0);
    for (const member of Object.values(snapshots['members-59-incident'].membersById)) {
        assert.match(member.url, /\/profile\/\d+$/);
    }
});

test('paired zero counters browser extraction is authoritative', async () => {
    const result = await acquisitionBrowser.extractPairedZeroFixtureSnapshot();
    assert.equal(result.snapshot.status, 'authoritative');
    const counts = member => ({ attackCount: member.attackCount, raidCount: member.raidCount });
    assert.deepEqual(counts(result.snapshot.membersById['900001']), { attackCount: 1, raidCount: 0 });
    assert.deepEqual(counts(result.snapshot.membersById['900002']), { attackCount: 1, raidCount: 0 });
    assert.deepEqual(counts(result.snapshot.membersById['900003']), { attackCount: 0, raidCount: 0 });
    assert.equal(result.snapshot.anomalies.malformedCount, false);
    assert.equal(result.storageAfter, result.storageBefore);
});

test('bare-word malformed count stays rejected in the browser without storage writes', async () => {
    const result = await acquisitionBrowser.extractRejectedFixtureSnapshots(['malformed-count']);
    assert.deepEqual(result['malformed-count'].snapshot, { status: 'rejected', reason: 'malformed-count' });
    assert.equal(result['malformed-count'].storageAfter, result['malformed-count'].storageBefore);
});

test('member-table contract rejects every reason without mutating state', async () => {
    const reasons = [
        'no-member-table', 'multiple-member-tables', 'pagination-or-filter',
        'missing-player-id', 'duplicate-player-id', 'conflicting-tooltip',
        'malformed-count'
    ];
    const results = await acquisitionBrowser.extractRejectedFixtureSnapshots(reasons);
    for (const reason of reasons) {
        assert.deepEqual(results[reason].snapshot, {
            status: 'rejected', reason
        });
        assert.deepEqual(results[reason].storageAfter, results[reason].storageBefore, reason);
        const diagnostics = script.recordFailure({}, HOST, 1700000000000, 'invalid-snapshot', 0, results[reason].snapshot.reason, {
            memberRows: 0, rows: 0, icons: 0
        });
        assert.equal(diagnostics[HOST].lastFailure.rejectionReason, reason);
    }
});
