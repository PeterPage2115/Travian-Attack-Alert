'use strict';

/*
 * Settings-backup privacy matrix for public release 1.0.0 (plan Todo 8).
 *
 * Loads the BUILT ARTIFACT (dist/travian-attack-alert.user.js) via require —
 * dist is the generated installable bundled from the src/ runtime authority,
 * so pre-rebuild runs below exercise the UNCHANGED runtime and
 * must show RED on the new default-omit / opt-in-warning expectations, while
 * post-rebuild runs must go GREEN without touching any other behavior.
 *
 * Synthetic fixtures only: webhook
 * https://discord.com/api/webhooks/100000000000000001/<synthetic>, playerId
 * '101', hostnames *.example.travian.com. No DEV backup bytes, no real hosts,
 * no network.
 *
 * Run: node --test test/artifact/settings-backup.test.cjs
 * Gate: npm run check:release -- --offline (artifact-matrix gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_FILE = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');

const runtime = require(DIST_FILE);

const WORLD = 's1.example.travian.com';
const OTHER_WORLD = 's2.example.travian.com';
const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/100000000000000001/FAKE_TOKEN_SYNTHETIC_0123456789abcdef';
const FAKE_TOKEN = 'FAKE_TOKEN_SYNTHETIC_0123456789abcdef';
const T0 = 1700000000000;

const WEBHOOK_KEY = runtime.WEBHOOK_STORAGE_KEY;
const SETTINGS_KEY = runtime.SETTINGS_STORAGE_KEY;
// NOTE: MAPPING_STORAGE_KEY is intentionally not part of the runtime export
// surface, so the literal storage key is used here (matches the runtime authority).
const MAPPINGS_KEY = 'travianAlliancePlayerMappings_v1';

// ---------------------------------------------------------------------------
// Harness: localStorage-like memory storage + GM webhook harness.
// ---------------------------------------------------------------------------

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
    // initial === undefined models "GM has no webhook stored".
    let present = initial !== undefined;
    let raw = initial;
    const calls = [];
    return {
        calls,
        get gm() {
            return {
                get: () => { calls.push('get'); return present ? raw : undefined; },
                set: (v) => { calls.push('set'); present = true; raw = v; },
                remove: () => { calls.push('remove'); present = false; raw = undefined; }
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

function seedWorldSettings(storage, threshold = 4) {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ [WORLD]: { attackThreshold: threshold } }));
}

// ---------------------------------------------------------------------------
// Matrix.
// ---------------------------------------------------------------------------

test('default export omits the webhook key entirely (no placeholder, no secret bytes)', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const backup = runtime.buildSettingsBackup({
        hostname: WORLD, storage, webhook: FAKE_WEBHOOK, nowMs: T0
    });
    assert.equal(Object.prototype.hasOwnProperty.call(backup.data, WEBHOOK_KEY), false,
        'default export must not contain the webhook property at all');
    assert.equal(Object.prototype.hasOwnProperty.call(backup, '_warning'), false,
        'default export carries no secret, so it carries no secret warning either');
    const serialized = JSON.stringify(backup);
    assert.equal(serialized.includes('discord.com/api/webhooks'), false);
    assert.equal(serialized.includes(FAKE_TOKEN), false);
});

test('explicit opt-in includes the webhook with a plain-language warning (no protection claims)', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const backup = runtime.buildSettingsBackup({
        hostname: WORLD, storage, webhook: FAKE_WEBHOOK, includeWebhook: true, nowMs: T0
    });
    assert.deepEqual(backup.data[WEBHOOK_KEY], { action: 'set', url: FAKE_WEBHOOK });
    assert.equal(typeof backup._warning, 'string', 'opt-in file must warn inside the file itself');
    assert.match(backup._warning, /webhook secret/i);
    assert.match(backup._warning, /plain/i);
    assert.match(backup._warning, /no additional protection|do not share/i);
    const serialized = JSON.stringify(backup);
    // The file and its warning must stay plain-spoken: masking in the panel
    // preview is never presented as added protection for the file itself.
    assert.equal(/encrypt/i.test(serialized), false,
        'file and warning wording must never claim added protection');
    assert.equal(/encrypt/i.test(backup._warning), false);
});

test('opt-in file round-trips: import sets the webhook with validation', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const file = JSON.parse(JSON.stringify(runtime.buildSettingsBackup({
        hostname: WORLD, storage, webhook: FAKE_WEBHOOK, includeWebhook: true, nowMs: T0
    })));
    const target = memoryStorage();
    const gm = gmHarness(undefined);
    const result = runtime.applySettingsBackup(file, { hostname: WORLD, storage: target, gm: gm.gm });
    assert.equal(result.ok, true);
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);
});

test('absent webhook on import preserves the stored webhook byte-identical while other fields merge', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage, 4);
    const gm = gmHarness(FAKE_WEBHOOK);
    const before = storageHash(storage, gm);
    const backup = {
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 8 } } }
    };
    const result = runtime.applySettingsBackup(backup, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(result.ok, true);
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK, 'stored webhook must survive untouched');
    assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)), { [WORLD]: { attackThreshold: 8 } });
    assert.notEqual(storageHash(storage, gm), before, 'settings merge must still apply');
});

test('explicit clear empties the stored webhook', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const gm = gmHarness(FAKE_WEBHOOK);
    const backup = {
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [WEBHOOK_KEY]: { action: 'clear' } }
    };
    const result = runtime.applySettingsBackup(backup, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(result.ok, true);
    assert.equal(gm.snapshot().present, false);
});

test('legacy string form imports (validated); invalid legacy string is rejected with zero writes', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const gm = gmHarness(undefined);
    const before = storageHash(storage, gm);
    const okResult = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [WEBHOOK_KEY]: FAKE_WEBHOOK }
    }, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(okResult.ok, true);
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);

    const badStorage = memoryStorage();
    seedWorldSettings(badStorage);
    const badGm = gmHarness(FAKE_WEBHOOK);
    const badBefore = storageHash(badStorage, badGm);
    const badResult = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [WEBHOOK_KEY]: 'not-a-webhook' }
    }, { hostname: WORLD, storage: badStorage, gm: badGm.gm });
    assert.equal(badResult.ok, false);
    assert.equal(badResult.reason, 'invalid-fields');
    assert.equal(storageHash(badStorage, badGm), badBefore, 'rejected import must write nothing');
});

test('cancel path (validate/inspect only, user dismisses) writes nothing', () => {
    const storage = memoryStorage();
    seedWorldSettings(storage);
    const gm = gmHarness(FAKE_WEBHOOK);
    const before = storageHash(storage, gm);
    // The panel validates via inspectSettingsBackup and only calls
    // applySettingsBackup after an explicit confirm; a dismissed confirm
    // therefore performs exactly the calls below and no writes.
    const plan = runtime.inspectSettingsBackup(JSON.stringify({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 9 } } }
    }), WORLD, {});
    assert.equal(plan.ok, true);
    assert.equal(storageHash(storage, gm), before);
});

test('malformed backup gives invalid-fields with zero writes', () => {
    const storage = memoryStorage({ unrelated: 'keep' });
    seedWorldSettings(storage);
    const gm = gmHarness(FAKE_WEBHOOK);
    const before = storageHash(storage, gm);
    const result = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: {
            [SETTINGS_KEY]: { [WORLD]: { attackThreshold: 'bad' } },
            [WEBHOOK_KEY]: { action: 'set', url: 'not-a-webhook' }
        }
    }, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-fields');
    assert.equal(storageHash(storage, gm), before);
});

test('injected last-write failure gives write-failed with pre/post storage-hash equality', () => {
    const storage = memoryStorage({ unrelated: 'keep' });
    seedWorldSettings(storage, 3);
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
    assert.equal(storageHash(storage, gm), before,
        'full preimage (localStorage keys + GM presence/raw) must be restored');
    assert.equal(gm.snapshot().raw, FAKE_WEBHOOK);
});

test('incident bundle contains no URL/token/body/player rows', () => {
    const bundle = runtime.buildIncidentBundle({
        envelope: {
            metrics: { deliveryAccounting: { compactedTerminalTotals: [{ count: 2 }] } }
        },
        diagnostics: {
            records: [
                { sequence: 1, scanId: 'scan-1', stage: 'snapshot', status: 'ok', reason: 'accepted' },
                { sequence: 2, scanId: 'scan-1', stage: 'dispatch', status: 'error', reason: 'missing-endpoint' }
            ]
        },
        traces: undefined,
        routeRole: 'canonical-member',
        filters: {},
        webhookConfigured: true
    });
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes('discord.com/api/webhooks'), false);
    assert.equal(serialized.includes(FAKE_TOKEN), false);
    assert.equal(serialized.includes('https://'), false, 'no full URLs in the bundle');
    assert.equal(serialized.includes('"body"'), false, 'no response bodies in the bundle');
    assert.equal(serialized.includes('101'), false, 'no raw player rows in the bundle');
    assert.equal(bundle.config.endpointConfigured, true, 'presence flag (not value) is reported');
    assert.equal(bundle.kind, 'taa-incident-bundle');
});

test('other-world entries never overwrite current-world values on import', () => {
    const storage = memoryStorage();
    storage.setItem(MAPPINGS_KEY, JSON.stringify({ [WORLD]: { 101: ['100000000000000001'] } }));
    const gm = gmHarness(undefined);
    const result = runtime.applySettingsBackup({
        schemaVersion: 1, kind: 'taa-settings-backup', hostname: WORLD,
        data: { [MAPPINGS_KEY]: { [OTHER_WORLD]: { 101: ['100000000000000002'] } } }
    }, { hostname: WORLD, storage, gm: gm.gm });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(storage.getItem(MAPPINGS_KEY))[WORLD], { 101: ['100000000000000001'] });
});
