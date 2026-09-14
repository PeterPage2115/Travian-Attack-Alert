'use strict';

/*
 * Controlled 6.x -> public 1.0.0 owner transfer matrix (plan Todo 12).
 *
 * Loads the BUILT ARTIFACT (dist/travian-attack-alert.user.js) via require —
 * dist is the generated installable bundled from the src/ runtime authority.
 * Proves the migration contracts of docs/MIGRATION-6X.md:
 *
 *   - legacy in-flight queue records carry an injective `ls1:` provenance
 *     identity and stay recoverable (never acknowledged);
 *   - history-only records carry an `lh1:` provenance identity and stay
 *     `unknown-legacy` (never delivery acknowledgements);
 *   - a queue record removed by the old sender becomes
 *     `uncertain-legacy-settlement`, never an ack;
 *   - legacy string-form webhook backups import validated; invalid ones are
 *     rejected with zero writes;
 *   - malformed imports yield `invalid-fields` with zero writes, and a failed
 *     import rolls back everything (full preimage restore);
 *   - an absent webhook field on import preserves the stored webhook while
 *     all other fields merge (manual re-entry model);
 *   - the one-shot migration marker makes re-migration return
 *     `already-complete` with a byte-identical envelope.
 *
 * Fiction only: hostnames *.example.travian.com, playerIds 201/202/203,
 * webhook https://discord.com/api/webhooks/100000000000000002/<synthetic>.
 * No DEV backup bytes, no real hosts, no network.
 *
 * Run: node --test test/artifact/migration-6x.test.cjs
 * Gate: npm run check:release -- --offline (artifact-matrix gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_FILE = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');

const runtime = require(DIST_FILE);

const WORLD = 's6.example.travian.com';
const T0 = 1700000000000;
const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/100000000000000002/FAKE_TOKEN_MIGRATION_6X_abcdef0123456789';

const WEBHOOK_KEY = runtime.WEBHOOK_STORAGE_KEY;
const SETTINGS_KEY = runtime.SETTINGS_STORAGE_KEY;
const MAPPINGS_KEY = 'travianAlliancePlayerMappings_v1';
const DISCORD_CONFIG_KEY = 'travianAllianceDiscordConfig_v1';
const MUTED_KEY = 'travianAllianceMutedPlayers_v1';
const NAMES_KEY = 'travianAlliancePlayerNames_v1';
const ROSTER_KEY = 'travianAllianceRoster_v1';

// ---------------------------------------------------------------------------
// Harness: localStorage-like memory storage + per-identity GM webhook store.
// ---------------------------------------------------------------------------
// The two script identities (private 6.x vs public 1.0.0) NEVER share GM
// storage: each harness instance is a separate object, and the transfer
// carrier under test is always the backup FILE (or manual re-entry).

function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(k) { return values.has(k) ? values.get(k) : null; },
        setItem(k, v) { values.set(k, String(v)); },
        removeItem(k) { values.delete(k); }
    };
}

function gmHarness(initial) {
    // initial === undefined models "this identity has no webhook stored".
    let present = initial !== undefined;
    let raw = initial;
    return {
        get gm() {
            return {
                get: () => (present ? raw : undefined),
                set: (v) => { present = true; raw = v; },
                remove: () => { present = false; raw = undefined; }
            };
        },
        snapshot() { return { present, raw }; }
    };
}

function storageHash(storage, gm) {
    const entries = [];
    for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        entries.push([k, storage.getItem(k)]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const snap = gm.snapshot();
    return crypto.createHash('sha256')
        .update(JSON.stringify({ entries, gmPresent: snap.present, gmRaw: snap.raw ?? null }))
        .digest('hex');
}

// ---------------------------------------------------------------------------
// Fictional 6.2.1 profile, built from scratch (never copied).
// ---------------------------------------------------------------------------

function memberRecord(name, attackCount = 0, raidCount = 0) {
    return { name, url: `/profile/${name}`, attackCount, raidCount };
}

function legacyQueueEvent(playerId, name, extra = {}) {
    return Object.assign({
        playerId: String(playerId),
        name,
        url: `https://s6.example.travian.com/profile/${playerId}`,
        attackCount: 1,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack',
        observedAtMs: T0,
        queuedAtMs: T0,
        attemptCount: 0,
        responseClass: null
    }, extra);
}

function snapshot(membersById, observedAtMs = T0) {
    return {
        status: 'authoritative',
        observedAtMs,
        tableSignature: 'alliance-members-v1:migration-6x',
        membersById,
        anomalies: {
            missingId: false,
            duplicateId: false,
            conflictingTooltip: false,
            malformedCount: false,
            paginationOrFilter: false
        }
    };
}

// ---------------------------------------------------------------------------
// Legacy identity matrix: ls1: in-flight stays recoverable, never acked.
// ---------------------------------------------------------------------------

test('migration: ls1: in-flight records stay recoverable and are never acknowledgements', () => {
    const legacy = {
        pending: {
            [WORLD]: {
                events: [legacyQueueEvent('201', 'Fictional Alpha')],
                createdAt: T0
            }
        },
        inFlight: {
            [WORLD]: {
                events: [legacyQueueEvent('202', 'Fictional Beta')],
                createdAt: T0
            }
        }
    };
    const plan = runtime.planMonitorLegacyMigration(legacy, snapshot({}), WORLD);
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.inFlight.length, 1);
    for (const record of [...plan.pending, ...plan.inFlight]) {
        assert.match(record.eventId, /^ls1:/, 'queue records must carry ls1: provenance');
        const tuple = runtime.decodeLegacyIdentity(record.eventId);
        assert.equal(tuple.world, WORLD);
        assert.ok(['pending', 'inFlight'].includes(tuple.sourceStore), tuple.sourceStore);
        // Recoverable means: not terminal, not acknowledged, not failed.
        assert.notEqual(record.deliveryState, 'acknowledged');
        assert.notEqual(record.responseClass, 'acknowledged');
    }
    // Nothing migrated may look like a settled delivery.
    assert.deepEqual(plan.uncertain.filter((e) => e.deliveryState === 'acknowledged'), []);
});

test('migration: lh1: history records stay unknown-legacy and are never acknowledgements', () => {
    const record = runtime.canonicalizeLegacyHistoryRecord(
        legacyQueueEvent('201', 'Fictional Alpha'), WORLD, 0
    );
    assert.match(record.recordIdentity, /^lh1:/, 'history records must carry lh1: provenance');
    assert.equal(record.deliveryState, 'unknown-legacy');
    const tuple = runtime.decodeLegacyIdentity(record.recordIdentity);
    assert.equal(tuple.historyIndex, 0);
    assert.equal(tuple.world, WORLD);

    const legacy = {
        history: [legacyQueueEvent('201', 'Fictional Alpha'), legacyQueueEvent('202', 'Fictional Beta')],
        terminal: [legacyQueueEvent('203', 'Fictional Gamma')]
    };
    const plan = runtime.planMonitorLegacyMigration(legacy, snapshot({}), WORLD);
    assert.equal(plan.history.length, 3);
    for (const entry of plan.history) {
        assert.match(entry.recordIdentity, /^lh1:/);
        assert.equal(entry.deliveryState, 'unknown-legacy');
    }
    // History must not leak into any delivery queue or terminal set.
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.inFlight, []);
    assert.deepEqual(plan.failed, []);
    assert.deepEqual(plan.uncertain, []);
});

test('migration: removed-by-old-sender records become uncertain-legacy-settlement, never acked', () => {
    const legacy = {
        removed: {
            [WORLD]: {
                events: [legacyQueueEvent('201', 'Fictional Alpha')],
                createdAt: T0
            }
        }
    };
    const plan = runtime.planMonitorLegacyMigration(legacy, snapshot({}), WORLD);
    assert.equal(plan.uncertain.length, 1);
    assert.equal(plan.uncertain[0].deliveryState, 'uncertain-legacy-settlement');
    assert.equal(plan.uncertain[0].responseClass, 'uncertain-legacy-settlement');
    assert.notEqual(plan.uncertain[0].deliveryState, 'acknowledged');
});

test('migration: malformed legacy identities are rejected, never decoded', () => {
    for (const bad of ['ls1:!!!', 'lh1:!!!', 'xx1:abcd', '', 'ls1:', 'lh1:not-base64!!']) {
        assert.throws(() => runtime.decodeLegacyIdentity(bad), /malformed|noncanonical|non-round/i, bad);
    }
    assert.throws(() => runtime.decodeLegacyIdentity(42), /malformed/i);
});

// ---------------------------------------------------------------------------
// Settings-file transfer: absent secret preserves, legacy string validates,
// malformed rolls back.
// ---------------------------------------------------------------------------

function fictionalBackupFile() {
    // What a default (secret-omitting) 6.x export carries: everything except
    // the webhook. The 1.0.0 target keeps its manually re-entered secret.
    return {
        schemaVersion: 1,
        kind: 'taa-settings-backup',
        hostname: WORLD,
        exportedAt: new Date(T0).toISOString(),
        releaseId: 'taa-6.2.1',
        data: {
            [MAPPINGS_KEY]: { [WORLD]: { 201: ['100000000000000011'] } },
            [DISCORD_CONFIG_KEY]: { roleId: '200000000000000011', leaveRoleId: null },
            [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 2, raidThreshold: 1, normalMax: 2, highMax: 5 } },
            [MUTED_KEY]: { [WORLD]: { 202: true } },
            [NAMES_KEY]: { [WORLD]: { 201: 'Fictional Alpha' } },
            [ROSTER_KEY]: { [WORLD]: { 201: { name: 'Fictional Alpha', url: '/profile/201' } } }
        }
    };
}

test('migration: secret-omitting file import preserves the re-entered webhook and merges everything else', () => {
    // Fresh 1.0.0 identity: empty site storage, webhook manually re-entered
    // into ITS OWN GM store (never the 6.x store).
    const storage = memoryStorage();
    const gm = gmHarness(FAKE_WEBHOOK);
    const result = runtime.applySettingsBackup(fictionalBackupFile(), {
        hostname: WORLD, storage, gm: gm.gm
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'imported');
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK, 'manually re-entered webhook must survive untouched');
    assert.deepEqual(JSON.parse(storage.getItem(MAPPINGS_KEY)), { [WORLD]: { 201: ['100000000000000011'] } });
    assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY))[WORLD].attackThreshold, 2);
    assert.deepEqual(JSON.parse(storage.getItem(DISCORD_CONFIG_KEY)), { roleId: '200000000000000011', leaveRoleId: null });
    assert.deepEqual(JSON.parse(storage.getItem(MUTED_KEY)), { [WORLD]: { 202: true } });
    assert.deepEqual(JSON.parse(storage.getItem(NAMES_KEY)), { [WORLD]: { 201: 'Fictional Alpha' } });
    assert.deepEqual(JSON.parse(storage.getItem(ROSTER_KEY))[WORLD]['201'].name, 'Fictional Alpha');
});

test('migration: default export carries no webhook bytes (secret-omitting carrier)', () => {
    const storage = memoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ [WORLD]: { attackThreshold: 2 } }));
    const backup = runtime.buildSettingsBackup({
        hostname: WORLD, storage, webhook: FAKE_WEBHOOK, nowMs: T0
    });
    assert.equal(Object.prototype.hasOwnProperty.call(backup.data, WEBHOOK_KEY), false);
    assert.equal(JSON.stringify(backup).includes('discord.com/api/webhooks'), false);
});

test('migration: legacy string-form webhook imports validated; invalid string rejected with zero writes', () => {
    const storage = memoryStorage();
    const gm = gmHarness(undefined);
    const okResult = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [WEBHOOK_KEY]: FAKE_WEBHOOK }
    }, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(okResult.ok, true);
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);

    const badStorage = memoryStorage();
    const badGm = gmHarness(FAKE_WEBHOOK);
    const badBefore = storageHash(badStorage, badGm);
    const badResult = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [WEBHOOK_KEY]: 'not-a-webhook' }
    }, { hostname: WORLD, storage: badStorage, gm: badGm.gm });
    assert.equal(badResult.ok, false);
    assert.equal(badResult.reason, 'invalid-fields');
    assert.equal(storageHash(badStorage, badGm), badBefore, 'rejected legacy string must write nothing');
});

test('migration: malformed file gives invalid-fields with zero writes', () => {
    const storage = memoryStorage({ unrelated: 'keep' });
    storage.setItem(SETTINGS_KEY, JSON.stringify({ [WORLD]: { attackThreshold: 2 } }));
    const gm = gmHarness(FAKE_WEBHOOK);
    const before = storageHash(storage, gm);
    const result = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: {
            [MAPPINGS_KEY]: { [WORLD]: { nope: ['bad'] } },
            [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 'bad' } },
            [WEBHOOK_KEY]: { action: 'set', url: 'not-a-webhook' }
        }
    }, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-fields');
    assert.equal(storageHash(storage, gm), before, 'malformed import must write nothing');
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);
});

test('migration: failed import rolls back everything (full preimage restore)', () => {
    const storage = memoryStorage({ unrelated: 'keep' });
    storage.setItem(SETTINGS_KEY, JSON.stringify({ [WORLD]: { attackThreshold: 2 } }));
    storage.setItem(MAPPINGS_KEY, JSON.stringify({ [WORLD]: { 201: ['100000000000000011'] } }));
    const gm = gmHarness(FAKE_WEBHOOK);
    const before = storageHash(storage, gm);
    // One-shot failure on the webhook write (the last write of the apply
    // phase): the import fails, but rollback itself can still restore.
    let webhookWrites = 0;
    const failingGm = {
        get: gm.gm.get,
        set: (v) => { webhookWrites += 1; if (webhookWrites === 1) throw new Error('injected-quota'); gm.gm.set(v); },
        remove: gm.gm.remove
    };
    const result = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: {
            [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 8 } },
            [WEBHOOK_KEY]: { action: 'set', url: FAKE_WEBHOOK }
        }
    }, { hostname: WORLD, storage, gm: failingGm });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-failed');
    assert.equal(storageHash(storage, gm), before, 'failed import must restore the full preimage');
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);
});

// ---------------------------------------------------------------------------
// One-shot migration marker + no-history-flood planner proof.
// ---------------------------------------------------------------------------

test('migration: one-shot marker — re-migration returns already-complete with identical bytes', () => {
    const legacy = {
        attackState: { 'Fictional Alpha': { id: '201', attackCount: 4, raidCount: 1 } },
        pending: { [WORLD]: { events: [legacyQueueEvent('201', 'Fictional Alpha')], createdAt: T0 } }
    };
    const members = {
        201: memberRecord('Fictional Alpha', 4, 1),
        202: memberRecord('Fictional Beta', 0, 0)
    };
    const first = runtime.migrateLegacyMonitorStateV1({
        world: WORLD, legacy, snapshot: snapshot(members), nowMs: T0
    });
    assert.equal(first.outcome, 'migrated');
    assert.deepEqual(first.envelope.baselineByPlayerId['201'].attackCount, 4);
    assert.equal(first.envelope.pending.length, 1);
    assert.match(first.envelope.pending[0].eventId, /^ls1:/);
    assert.deepEqual(first.envelope.migration.sources, ['attackState', 'pending']);
    // Baseline carries the observed counts forward, so the first
    // post-migration scan of identical state plans zero detections.
    const steady = runtime.planAcceptedScanTransition(
        snapshot({ 201: memberRecord('Fictional Alpha', 4, 1), 202: memberRecord('Fictional Beta', 0, 0) }),
        first.envelope.baselineByPlayerId,
        new Set(), 1, 1, { ownerId: 'owner-6x', term: 3 }, { world: WORLD }
    );
    assert.equal(steady.outcome, 'ok');
    assert.deepEqual(steady.detections, [], 'identical post-migration state must plan zero detections (no flood)');
    // Second migration against the completed envelope is a no-op.
    const second = runtime.migrateLegacyMonitorStateV1({
        world: WORLD, existingEnvelope: first.envelope, legacy, snapshot: snapshot(members), nowMs: T0 + 1000
    });
    assert.equal(second.outcome, 'already-complete');
    // Byte-identity uses the product's own canonical envelope serialization
    // (the same notion the detector matrix locks for rejected scans): a live
    // `deliveryState: undefined` key is not a state difference.
    assert.equal(
        runtime.serializeMonitorEnvelopeV1(second.envelope),
        runtime.serializeMonitorEnvelopeV1(first.envelope),
        'completed envelope must be byte-identical'
    );
});

test('migration: first post-migration scan of a genuinely new delta plans exactly that delta', () => {
    const baseline = {
        201: memberRecord('Fictional Alpha', 4, 1),
        202: memberRecord('Fictional Beta', 0, 0)
    };
    const plan = runtime.planAcceptedScanTransition(
        snapshot({
            201: memberRecord('Fictional Alpha', 5, 1),
            202: memberRecord('Fictional Beta', 0, 0)
        }),
        baseline,
        new Set(), 1, 1, { ownerId: 'owner-100', term: 1 }, { world: WORLD }
    );
    assert.equal(plan.outcome, 'ok');
    assert.equal(plan.detections.length, 1);
    assert.equal(plan.detections[0].addedAttackCount, 1);
    assert.equal(plan.eligibleEvents.length, 1);
});
