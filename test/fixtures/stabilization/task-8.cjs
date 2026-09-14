'use strict';

const crypto = require('node:crypto');
const script = require('../../../src/runtime.js');

const world = 'CW.X2.International.Travian.com';
const fields = { name: 'A', url: '/profile/1', attackCount: 3, raidCount: 1, oldAttackCount: 2, oldRaidCount: 1, addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack', observedAtMs: 10, queuedAtMs: 11, attemptCount: 0, responseClass: null };
const active = script.canonicalizeLegacyActiveEvent({ ...fields, eventId: 'raw-id' }, { world, sourceStore: 'pending', originalIndex: 0 });
const history = script.canonicalizeLegacyHistoryRecord(fields, world, 0);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function run() {
    assert(script.decodeLegacyIdentity(active.eventId).canonicalEventFields.addedAttackCount === 1, 'active identity did not round-trip');
    assert(script.decodeLegacyIdentity(history.recordIdentity).canonicalHistoryFields.name === 'A', 'history identity did not round-trip');
    assert(history.deliveryState === 'unknown-legacy', 'history was made deliverable');
    const storageKeyManifest = [script.monitorActiveStorageKey(world), script.monitorBackupStorageKey(world), script.monitorQuarantineStorageKey(world, 10)].map(key => ({ sha256: crypto.createHash('sha256').update(key).digest('hex'), length: key.length }));
    return { task: 8, storageKeyManifest, activePrefix: active.eventId.slice(0, 4), historyPrefix: history.recordIdentity.slice(0, 4), verdict: 'PASS' };
}

if (process.argv.includes('--failures')) {
    assertThrows(() => script.decodeLegacyIdentity(active.eventId.replace(/^ls1:/, 'ls1:A')), 'malformed identity accepted');
    assertThrows(() => script.canonicalizeLegacyActiveEvent({ ...fields, canonicalEventFields: { ...fields, unknown: true } }, { world, sourceStore: 'pending', originalIndex: 0 }), 'malformed fields accepted');
}

function assertThrows(action, message) {
    let threw = false;
    try { action(); } catch (error) { threw = true; }
    assert(threw, message);
}

process.stdout.write(`${JSON.stringify(run())}\n`);
