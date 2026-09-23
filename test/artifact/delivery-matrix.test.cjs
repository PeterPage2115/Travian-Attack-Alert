'use strict';

/*
 * Delivery + transport recovery matrix for public release 1.0.0 (plan Todo 10).
 *
 * Loads the BUILT ARTIFACT (dist/travian-attack-alert.user.js) via require —
 * dist is the generated installable bundled from the src/ runtime authority,
 * so every assertion below locks shipped behavior.
 *
 * Scope (each gate maps to the Todo 10 acceptance matrix):
 *   (a) 429 + retry_after:1 then 200+ID → exactly 2 attempts, ~1000 ms capped
 *       delay, acknowledged ledger.
 *   (b) 5xx then 200+ID → bounded retry then ack; always-5xx exhausts at
 *       MAX_ATTEMPT_COUNT with capped delays.
 *   (c) timeout / abort / network-error then 200+ID → retry then ack.
 *   (d) 404 / 410 deleted-webhook → failed, retained, NO retry storm.
 *   (e) 200 malformed / ID-less → exactly ONE request, uncertain, NO auto-retry.
 *   (f) enqueue → serialize/parse restart → identical lineage → ack.
 *   (g) duplicate source event IDs → single-send identity (throw + stable batchId).
 *   (h) 60-event forced-split → part X/Y, mentions ONLY in first request,
 *       continuations use empty allowlists (proven on the WIRE via loopback).
 *   (i) storage-quota / readback failure → baseline unmoved, queue intact,
 *       operator-visible outcome.
 *   (j) player named @everyone / @here / <#…> → zero unintended pings
 *       (allowed_mentions explicit users/roles, NO parse key, asserted on the
 *       WIRE payload, not on builder output alone).
 *   (k) legacy pending-queue reconciliation (RED until plan Task 15): an
 *       existing envelope plus dual-written world-keyed legacy stores
 *       (pending.events[], pending.inFlight[], separate failed map) must
 *       conserve every record exactly once, drain the legacy keys only after
 *       a verified envelope commit, stay idempotent at each staged crash
 *       boundary, never advance the baseline, and never touch the network.
 *
 * Transport legs (a)-(c),(h),(j) dispatch through REAL artifact code
 * (sendDiscordPayload / sendDiscordPayloadWithRetry / buildDiscordPayloads)
 * over real loopback HTTP sockets (127.0.0.1, ephemeral port). The
 * gmRequest shim models the Tampermonkey transport narrowly (POST bytes,
 * onload/onerror/ontimeout/onabort mapping); retry, classification, delay
 * capping, and payload bytes are 100% artifact code.
 *
 * Synthetic fixtures only: hostnames *.example.travian.com, playerId '101',
 * fake webhook token. No DEV bytes, no real hosts, no production network.
 *
 * Run: node --test test/artifact/delivery-matrix.test.cjs
 * Gate: npm run check:release -- --offline (artifact-matrix gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_FILE = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');
const DIST_SIDECAR = `${DIST_FILE}.sha256`;
const RUNTIME_FILE = path.join(ROOT, 'src', 'runtime.js');

const runtime = require(DIST_FILE);
const canonical = require('../fixtures/discord/canonical.cjs');

const WORLD = 's1.example.travian.com';
const T0 = 1700000000000;
const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/100000000000000001/FAKE_TOKEN_SYNTHETIC_0123456789abcdef';
const USER_A = '123456789012345678';
const USER_B = '223456789012345678';
const ROLE_A = '987654321098765432';

// ---------------------------------------------------------------------------
// Loopback sink: scripted per-attempt responses, records every wire body.
// ---------------------------------------------------------------------------

function startLoopback(script) {
    const received = [];
    let count = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            count += 1;
            const step = script(count, Buffer.concat(chunks).toString('utf8'));
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
            received.push({ attempt: count, body, startedAt: Date.now() });
            const respond = () => {
                res.writeHead(step.status, { 'Content-Type': 'application/json' });
                res.end(step.body);
            };
            if (step.delayMs) setTimeout(respond, step.delayMs);
            else respond();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                received,
                url: `http://127.0.0.1:${server.address().port}/discord-webhook`,
                close: () => new Promise((done) => server.close(done)),
            });
        });
    });
}

const okId = (id) => ({ status: 200, body: JSON.stringify({ id }) });

// gmRequest shim over real fetch: the ONLY modeled surface is the
// Tampermonkey transport call convention. Classification, retry counting,
// delay math, and payload bytes stay inside the artifact.
function gmRequestTo(targetUrl, { timeoutMs } = {}) {
    return (options) => {
        const controller = new AbortController();
        let timedOut = false;
        let timer = null;
        if (Number.isFinite(timeoutMs)) {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                try { options.ontimeout && options.ontimeout(); } catch { /* shim only */ }
            }, timeoutMs);
        }
        fetch(targetUrl, {
            method: options.method || 'POST',
            body: options.data,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
        }).then(async (res) => {
            if (timedOut) return;
            if (timer) clearTimeout(timer);
            try {
                options.onload && options.onload({ status: res.status, responseText: await res.text(), responseHeaders: '' });
            } catch { /* shim only */ }
        }).catch((error) => {
            if (timedOut) return;
            if (timer) clearTimeout(timer);
            try { options.onerror && options.onerror(error); } catch { /* shim only */ }
        });
    };
}

async function retryViaLoopback(sink, { timeoutMs, sleepDelays } = {}) {
    const delays = [];
    const outcome = await runtime.sendDiscordPayloadWithRetry({
        webhookUrl: FAKE_WEBHOOK,
        payload: { content: 'probe', allowed_mentions: { users: [] } },
        gmRequest: gmRequestTo(sink.url, { timeoutMs }),
        sleep: (ms) => { delays.push(ms); if (sleepDelays === 'real') return new Promise((r) => setTimeout(r, ms)); return Promise.resolve(); },
    });
    return { outcome, delays };
}

// ---------------------------------------------------------------------------
// Memory GM-style storage for monitor envelope commits.
// ---------------------------------------------------------------------------

function memoryStorage(seed) {
    const values = new Map(Object.entries(seed || {}));
    return {
        values,
        get: (k) => (values.has(k) ? values.get(k) : undefined),
        set: (k, v) => { values.set(k, String(v)); },
    };
}

function sourceId(playerId, seq) {
    return runtime.sourceEventIdFromTuple({
        world: WORLD,
        playerId: String(playerId),
        eventType: 'attack',
        acceptedGeneration: 1,
        scanSequence: seq,
        attackDelta: 1,
        raidDelta: 0,
    });
}

function queueEvent(playerId, seq) {
    return runtime.createMonitorQueueEvent(
        { playerId: String(playerId), eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: [sourceId(playerId, seq)] },
        { world: WORLD, observedAtMs: T0, queuedAtMs: T0 + 1 }
    );
}

function seedEnvelope(storage, baseline101 = { attackCount: 0, raidCount: 0 }) {
    const base = runtime.createMonitorEnvelopeV1(WORLD, { baselineByPlayerId: { 101: baseline101 } });
    const seeded = runtime.commitMonitorEnvelopeV1({
        world: WORLD, currentEnvelope: null, candidateEnvelope: base, expectedGeneration: -1, storage,
    });
    assert.equal(seeded.outcome, 'ok');
    return seeded.envelope;
}

// ---------------------------------------------------------------------------
// T0 — artifact authority.
// ---------------------------------------------------------------------------

test('T0 artifact authority: dist is the generated 1.0.0 installable', () => {
    const distBytes = fs.readFileSync(DIST_FILE);
    assert.deepEqual(Object.keys(runtime).sort(), Object.keys(require(RUNTIME_FILE)).sort());
    const digest = crypto.createHash('sha256').update(distBytes).digest('hex');
    assert.equal(fs.readFileSync(DIST_SIDECAR, 'utf8').trim(), `${digest}  dist/travian-attack-alert.user.js`);
    assert.match(distBytes.toString('utf8'), /^\/\/ @version\s+1\.0\.0$/m);
    assert.ok(distBytes.includes('const RELEASE_ID = "taa-1.0.0"'));
    assert.equal(runtime.MAX_ATTEMPT_COUNT, 3);
    assert.deepEqual([...runtime.RETRY_DELAY_MS], [1000, 3000]);
    assert.equal(runtime.MAX_RETRY_DELAY_MS, 60000);
});

// ---------------------------------------------------------------------------
// (a) 429 with retry_after:1 then 200+ID.
// ---------------------------------------------------------------------------

test('(a) 429 retry_after:1 then 200+ID: exactly 2 attempts, 1000 ms delay, acknowledged', async () => {
    const sink = await startLoopback((n) => (n === 1
        ? { status: 429, body: JSON.stringify({ retry_after: 1 }) }
        : okId('m-ack-1')));
    try {
        const { outcome, delays } = await retryViaLoopback(sink);
        assert.equal(outcome.outcome.kind, 'acknowledged');
        assert.equal(outcome.outcome.messageId, 'm-ack-1');
        assert.equal(outcome.attempts, 2);
        assert.deepEqual(delays, [1000]);
        assert.equal(sink.received.length, 2);
    } finally {
        await sink.close();
    }
});

test('(a-cap) huge retry_after is capped at MAX_RETRY_DELAY_MS and attempts stay bounded', async () => {
    const sink = await startLoopback(() => ({ status: 429, body: JSON.stringify({ retry_after: 3600 }) }));
    try {
        const { outcome, delays } = await retryViaLoopback(sink);
        assert.equal(outcome.attempts, runtime.MAX_ATTEMPT_COUNT);
        assert.deepEqual(delays, [60000, 60000]);
        assert.equal(sink.received.length, 3);
    } finally {
        await sink.close();
    }
});

// ---------------------------------------------------------------------------
// (b) 5xx then 200+ID; always-5xx exhausts bounded.
// ---------------------------------------------------------------------------

test('(b) 500 then 200+ID: bounded retry then acknowledged', async () => {
    const sink = await startLoopback((n) => (n === 1 ? { status: 500, body: '{}' } : okId('m-ack-2')));
    try {
        const { outcome, delays } = await retryViaLoopback(sink);
        assert.equal(outcome.outcome.kind, 'acknowledged');
        assert.equal(outcome.attempts, 2);
        assert.deepEqual(delays, [1000]);
        assert.equal(sink.received.length, 2);
    } finally {
        await sink.close();
    }
});

test('(b-exhaust) persistent 503: exactly MAX_ATTEMPT_COUNT attempts, fallback delays [1000,3000]', async () => {
    const sink = await startLoopback(() => ({ status: 503, body: '{}' }));
    try {
        const { outcome, delays } = await retryViaLoopback(sink);
        assert.equal(outcome.outcome.kind, 'retryable');
        assert.equal(outcome.attempts, 3);
        assert.deepEqual(delays, [1000, 3000]);
        assert.equal(sink.received.length, 3, 'no retry storm past the bound');
    } finally {
        await sink.close();
    }
});

// ---------------------------------------------------------------------------
// (c) timeout / abort / network-error then 200+ID.
// ---------------------------------------------------------------------------

test('(c-timeout) slow first response past timeoutMs then 200+ID: retry then acknowledged', async () => {
    const sink = await startLoopback((n) => (n === 1 ? { ...okId('late'), delayMs: 400 } : okId('m-ack-3')));
    try {
        const { outcome, delays } = await retryViaLoopback(sink, { timeoutMs: 60 });
        assert.equal(outcome.outcome.kind, 'acknowledged');
        assert.equal(outcome.outcome.messageId, 'm-ack-3');
        assert.equal(outcome.attempts, 2);
        assert.deepEqual(delays, [1000]);
    } finally {
        await sink.close();
    }
});

test('(c-abort) client abort then 200+ID: retry then acknowledged', async () => {
    const sink = await startLoopback(() => okId('m-ack-4'));
    let calls = 0;
    const gmRequest = (options) => {
        calls += 1;
        if (calls === 1) { options.onabort && options.onabort(); return; }
        gmRequestTo(sink.url)(options);
    };
    try {
        const delays = [];
        const outcome = await runtime.sendDiscordPayloadWithRetry({
            webhookUrl: FAKE_WEBHOOK,
            payload: { content: 'probe', allowed_mentions: { users: [] } },
            gmRequest,
            sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
        });
        assert.equal(outcome.outcome.kind, 'acknowledged');
        assert.equal(outcome.attempts, 2);
        assert.deepEqual(delays, [1000]);
        assert.equal(sink.received.length, 1, 'aborted attempt never reaches the wire');
    } finally {
        await sink.close();
    }
});

test('(c-network) refused connection then 200+ID: retry then acknowledged', async () => {
    const dead = await startLoopback(() => okId('never'));
    const deadUrl = dead.url;
    await dead.close();
    const sink = await startLoopback(() => okId('m-ack-5'));
    let calls = 0;
    const gmRequest = (options) => {
        calls += 1;
        gmRequestTo(calls === 1 ? deadUrl : sink.url)(options);
    };
    try {
        const delays = [];
        const outcome = await runtime.sendDiscordPayloadWithRetry({
            webhookUrl: FAKE_WEBHOOK,
            payload: { content: 'probe', allowed_mentions: { users: [] } },
            gmRequest,
            sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
        });
        assert.equal(outcome.outcome.kind, 'acknowledged');
        assert.equal(outcome.attempts, 2);
        assert.deepEqual(delays, [1000]);
        assert.equal(sink.received.length, 1);
    } finally {
        await sink.close();
    }
});

// ---------------------------------------------------------------------------
// (d) ordinary 4xx: failed, retained, no retry.
// ---------------------------------------------------------------------------

test('(d) 404 and 410 deleted-webhook: permanent, single attempt, retained as failed', async () => {
    for (const status of [404, 410]) {
        const sink = await startLoopback(() => ({ status, body: '{"message":"Unknown Webhook"}' }));
        try {
            const { outcome, delays } = await retryViaLoopback(sink);
            assert.equal(outcome.outcome.kind, 'permanent');
            assert.equal(outcome.outcome.status, status);
            assert.equal(outcome.attempts, 1, 'no retry storm on deleted webhook');
            assert.deepEqual(delays, []);
            assert.equal(sink.received.length, 1);
        } finally {
            await sink.close();
        }
    }
    // Queue surface: permanent failure retains the record as failed.
    const storage = memoryStorage();
    let envelope = seedEnvelope(storage);
    envelope = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'enqueue', events: [queueEvent('101', 7)] }, storage,
    }).envelope;
    envelope = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'pending-to-inFlight' }, storage,
    }).envelope;
    const settled = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'failed', eventIds: [envelope.inFlight[0].eventId], responseClass: '404' }, storage,
    });
    assert.equal(settled.outcome, 'ok');
    assert.equal(settled.envelope.inFlight.length, 0);
    assert.equal(settled.envelope.failed.length, 1);
    assert.equal(settled.envelope.failed[0].playerId, '101');
    assert.equal(settled.envelope.metrics.deliveryAccounting.recoverable.length, 1);
});

// ---------------------------------------------------------------------------
// (e) malformed / ID-less 200: uncertain, exactly one request, no auto-retry.
// ---------------------------------------------------------------------------

test('(e) ID-less and non-JSON 200: exactly ONE request, uncertain, NO auto-retry', async () => {
    for (const [label, body] of [['id-less-json', '{}'], ['non-json', '<html>accepted</html>']]) {
        const sink = await startLoopback(() => ({ status: 200, body }));
        try {
            const { outcome, delays } = await retryViaLoopback(sink);
            assert.equal(outcome.outcome.kind, 'uncertain', label);
            assert.equal(outcome.attempts, 1, `${label}: uncertain never auto-retries`);
            assert.deepEqual(delays, []);
            assert.equal(sink.received.length, 1, `${label}: exactly one wire request`);
        } finally {
            await sink.close();
        }
    }
    // Queue surface: uncertain parks the record with its response class.
    const storage = memoryStorage();
    let envelope = seedEnvelope(storage);
    envelope = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'enqueue', events: [queueEvent('101', 8)] }, storage,
    }).envelope;
    envelope = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'pending-to-inFlight' }, storage,
    }).envelope;
    const settled = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: envelope, expectedGeneration: envelope.generation,
        transition: { type: 'uncertain', eventIds: [envelope.inFlight[0].eventId], responseClass: 'malformed-json-200' }, storage,
    });
    assert.equal(settled.outcome, 'ok');
    assert.equal(settled.envelope.inFlight.length, 0);
    assert.equal(settled.envelope.uncertain.length, 1);
    assert.equal(settled.envelope.uncertain[0].responseClass, 'malformed-json-200');
    assert.equal(settled.envelope.failed.length, 0);
});

// ---------------------------------------------------------------------------
// (f) reload / restart preserves recoverable records with lineage, then ack.
// ---------------------------------------------------------------------------

test('(f) enqueue survives a storage restart with identical lineage, then acknowledges', () => {
    const storage = memoryStorage();
    const seeded = seedEnvelope(storage);
    const baselineBefore = JSON.stringify(seeded.baselineByPlayerId);
    const enqueued = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: seeded, expectedGeneration: seeded.generation,
        transition: { type: 'enqueue', events: [queueEvent('101', 9)] }, storage,
    });
    assert.equal(enqueued.outcome, 'ok');
    assert.equal(enqueued.envelope.pending.length, 1);
    const lineageBefore = JSON.stringify(enqueued.envelope.pending[0].sourceEventIds);

    // Simulated restart: fresh parse of the persisted bytes only.
    const activeKey = runtime.monitorActiveStorageKey(WORLD);
    const persisted = storage.values.get(activeKey);
    assert.ok(typeof persisted === 'string');
    const restarted = runtime.parseMonitorEnvelopeV1(persisted, WORLD);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.envelope.pending.length, 1);
    assert.equal(JSON.stringify(restarted.envelope.pending[0].sourceEventIds), lineageBefore);
    assert.equal(restarted.envelope.pending[0].playerId, '101');
    assert.equal(restarted.envelope.metrics.deliveryAccounting.recoverable.length, 1);

    const inFlight = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: restarted.envelope, expectedGeneration: restarted.envelope.generation,
        transition: { type: 'pending-to-inFlight' }, storage,
    });
    assert.equal(inFlight.outcome, 'ok');
    const acked = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: inFlight.envelope, expectedGeneration: inFlight.envelope.generation,
        transition: { type: 'acknowledge', eventIds: [inFlight.envelope.inFlight[0].eventId] }, storage,
    });
    assert.equal(acked.outcome, 'ok');
    assert.equal(acked.envelope.pending.length, 0);
    assert.equal(acked.envelope.inFlight.length, 0);
    const terminal = acked.envelope.metrics.deliveryAccounting.terminal;
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].terminalStatus, 'acknowledged');
    assert.deepEqual([...terminal[0].sourceEventIds], JSON.parse(lineageBefore));
    assert.equal(JSON.stringify(acked.envelope.baselineByPlayerId), baselineBefore, 'settle never moves the baseline');
});

// ---------------------------------------------------------------------------
// (g) duplicate source IDs dedupe to a single send identity.
// ---------------------------------------------------------------------------

test('(g) duplicate dispatch source IDs throw; identical events share one batch identity', () => {
    const sid = sourceId('101', 10);
    const withIds = (extra) => runtime.createMonitorQueueEvent(
        { playerId: '101', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: [sid], ...extra },
        { world: WORLD, observedAtMs: T0, queuedAtMs: T0 + 1 }
    );
    assert.throws(
        () => runtime.buildDispatchPlanV1([withIds(), withIds()]),
        /duplicate dispatch source ID/,
        'same source ID twice is never planned as two sends'
    );
    const other = runtime.createMonitorQueueEvent(
        { playerId: '102', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: [sourceId('102', 11)] },
        { world: WORLD, observedAtMs: T0, queuedAtMs: T0 + 1 }
    );
    const first = runtime.buildDispatchPlanV1([withIds(), other]);
    const second = runtime.buildDispatchPlanV1([withIds(), other]);
    assert.equal(first.batchId, second.batchId, 'redelivery maps to the same batch, not a new send');
    assert.equal(first.chunks.length, 1);
    assert.deepEqual([...first.chunks[0].sourceEventIds].sort(), [sid, sourceId('102', 11)].sort());
});

// ---------------------------------------------------------------------------
// (h) 60-event forced split: wire proof of part X/Y + mentions-once.
// ---------------------------------------------------------------------------

test('(h) 60-event forced split posts part 1/2..2/2 with mentions ONLY in the first request', async () => {
    const fixture = canonical.previewCases['forced-split']();
    const options = { ...canonical.BASE_OPTIONS, roleId: ROLE_A, userIds: [USER_A, USER_B] };
    const payloads = runtime.buildDiscordPayloads(fixture.events, options);
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].embeds[0].title, /part 1\/2/);
    assert.match(payloads[1].embeds[0].title, /part 2\/2/);

    // Verbatim onto the wire: the sink receives JSON-stringified payloads.
    const sink = await startLoopback(() => okId('m-part'));
    try {
        for (const payload of payloads) {
            const res = await fetch(sink.url, {
                method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
            });
            assert.equal(res.status, 200);
        }
        assert.equal(sink.received.length, 2);
        const [first, second] = sink.received.map((r) => r.body);
        assert.equal(first.content, `<@&${ROLE_A}> <@${USER_A}> <@${USER_B}>`);
        assert.deepEqual(first.allowed_mentions, { users: [USER_A, USER_B], roles: [ROLE_A] });
        assert.ok(!('parse' in first.allowed_mentions));
        assert.equal(second.content, '', 'second continuation carries no mentions');
        assert.deepEqual(second.allowed_mentions, { users: [] }, 'second allowlist is empty');
        assert.ok(!('roles' in second.allowed_mentions), 'second has no roles key');
        assert.ok(!('parse' in second.allowed_mentions), 'second has no parse key');
    } finally {
        await sink.close();
    }
});

// ---------------------------------------------------------------------------
// (i) storage / quota / readback failure: baseline unmoved, queue intact.
// ---------------------------------------------------------------------------

test('(i-quota) throwing storage: wrote-failed, memorySwapped false, bytes unchanged', () => {
    const storage = memoryStorage();
    const seeded = seedEnvelope(storage);
    const activeKey = runtime.monitorActiveStorageKey(WORLD);
    const bytesBefore = storage.values.get(activeKey);
    const queueBefore = JSON.stringify(seeded.pending);

    const failing = {
        get: storage.get,
        set: () => { throw new Error('quota exceeded (synthetic)'); },
    };
    const attempt = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: seeded, expectedGeneration: seeded.generation,
        transition: { type: 'enqueue', events: [queueEvent('101', 12)] }, storage: failing,
    });
    assert.equal(attempt.outcome, 'wrote-failed', 'operator-visible outcome');
    assert.equal(attempt.memorySwapped, false);
    assert.equal(storage.values.get(activeKey), bytesBefore, 'baseline bytes unmoved');
    assert.equal(JSON.stringify(seeded.pending), queueBefore, 'in-memory queue intact');
    const reparsed = runtime.parseMonitorEnvelopeV1(bytesBefore, WORLD);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.envelope.pending.length, 0);
});

test('(i-readback) vanishing writes: readback-mismatch, memorySwapped false, bytes unchanged', () => {
    const storage = memoryStorage();
    const seeded = seedEnvelope(storage);
    const activeKey = runtime.monitorActiveStorageKey(WORLD);
    const backupKey = runtime.monitorBackupStorageKey(WORLD);
    const bytesBefore = storage.values.get(activeKey);
    const backupBefore = storage.values.get(backupKey);
    // Realistic persistence failure: reads work, but writes silently vanish
    // (quota-blocked mobile webview, read-only profile). The write-readback
    // guard must refuse the commit instead of advancing state.
    const vanishing = {
        get: (k) => storage.get(k),
        set: () => { /* write vanishes */ },
    };
    const attempt = runtime.commitMonitorQueueTransitionV1({
        world: WORLD, currentEnvelope: seeded, expectedGeneration: seeded.generation,
        transition: { type: 'enqueue', events: [queueEvent('101', 13)] }, storage: vanishing,
    });
    assert.equal(attempt.outcome, 'readback-mismatch', 'operator-visible outcome');
    assert.equal(attempt.memorySwapped, false);
    assert.equal(storage.values.get(activeKey), bytesBefore, 'baseline bytes unmoved');
    assert.equal(storage.values.get(backupKey), backupBefore, 'backup bytes unmoved');
    const reparsed = runtime.parseMonitorEnvelopeV1(bytesBefore, WORLD);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.envelope.pending.length, 0, 'queue intact: no phantom record');
});

// ---------------------------------------------------------------------------
// (j) @everyone-style nicknames never ping: wire-level allowlist proof.
// ---------------------------------------------------------------------------

test('(j) @everyone/@here/<#…> nicknames: no parse key, explicit allowlist, clean content on the wire', async () => {
    const sink = await startLoopback(() => okId('m-noping'));
    try {
        for (const nick of ['@everyone', '@here', '<#123456789012345678>']) {
            const events = [{
                testId: 'nick', name: nick, url: '/profile/101',
                attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack',
            }];
            const options = { ...canonical.BASE_OPTIONS, userIds: [USER_A] };
            const [payload] = runtime.buildDiscordPayloads(events, options);
            assert.ok(!('parse' in payload.allowed_mentions), `${nick}: no parse key in builder output`);
            assert.deepEqual(payload.allowed_mentions, { users: [USER_A] });
            assert.ok(!payload.content.includes('@everyone'), `${nick}: content carries no @everyone`);
            assert.ok(!payload.content.includes('@here'), `${nick}: content carries no @here`);
            assert.ok(!payload.content.includes('<#'), `${nick}: content carries no channel token`);
            const wireText = JSON.stringify(payload);
            assert.ok(!wireText.includes('"parse"'), `${nick}: no parse key anywhere on the wire bytes`);

            const res = await fetch(sink.url, {
                method: 'POST', body: wireText, headers: { 'Content-Type': 'application/json' },
            });
            assert.equal(res.status, 200);
            const received = sink.received[sink.received.length - 1].body;
            assert.ok(!('parse' in received.allowed_mentions), `${nick}: no parse key in received wire body`);
            assert.deepEqual(received.allowed_mentions, { users: [USER_A] }, `${nick}: explicit user allowlist on the wire`);
            assert.ok(!String(received.content).includes('@everyone'), `${nick}: received content ping-free`);
            // Mention tokens (<@/ <@&) live ONLY in top-level content, never in embeds.
            const embedText = JSON.stringify(received.embeds);
            assert.ok(!embedText.includes('<@'), `${nick}: embeds carry no mention tokens`);
        }
        assert.equal(sink.received.length, 3);
    } finally {
        await sink.close();
    }
});

// ---------------------------------------------------------------------------
// (k) legacy pending-queue reconciliation contract (Task 14 RED -> Task 15).
//
// Persisted defect shape, reproduced through the product's own helpers:
//   travianAlliancePendingBatch_v1: world-keyed map; each world value owns an
//     ordered `events[]` AND an independent ordered `inFlight[]` store.
//   travianAllianceFailedBatch_v1: separate world-keyed map with `events[]`.
// The runtime commits monitor events to the durable envelope and then
// dual-writes them into the legacy pending map. When an envelope already
// exists the legacy keys are never drained, so the very same records remain
// and can later reappear as stale duplicates.
//
// Task 15 contract locked here: runtime.loadOrMigrateMonitorEnvelopeV1(world,
// snapshot, { storage, legacy, nowMs }) must reconcile an existing envelope
// with legacy records by
//   1. snapshotting `pending.events`, `pending.inFlight`, and the failed store
//      separately for the normalized world and deriving each ls1: identity
//      with the existing migration discriminator + that store's own original
//      index (never a global/concatenated list),
//   2. representing every record exactly once - an exact retained identity is
//      left alone, anything else becomes an explicit
//      `uncertain-legacy-settlement` entry that is never auto-sent,
//   3. committing the envelope with readback before touching any legacy key,
//   4. writing the pending map, then the failed map, each with a verified
//      readback, preserving unrelated worlds byte-for-byte and reporting the
//      exact `pending-cleanup-indeterminate` / `failed-cleanup-indeterminate`
//      stage when a write/readback is unavailable or mismatched,
//   5. staying idempotent across every staged crash boundary, never advancing
//      the baseline, and never performing a network request.
// Every case below FAILS on the current artifact because the stale legacy key
// is left untouched (a conservation defect, not a call-count change); Task 15
// turns them green.
// ---------------------------------------------------------------------------

const PENDING_KEY = runtime.PENDING_BATCH_STORAGE_KEY;
const FAILED_KEY = runtime.FAILED_BATCH_STORAGE_KEY;
const OTHER_WORLD = 's2.example.travian.com';

// What the scan dual-write persists: toPendingEvent() of a committed monitor
// event with the queue contract enforced (safe fields + observedAtMs + the
// deterministic eventId hash). Fixtures stay fully synthetic/deterministic.
function persistedLegacyEvent(world, playerId, seed) {
    return runtime.toPendingEvent(
        {
            name: `Fictional ${playerId}`,
            url: `/profile/${playerId}`,
            attackCount: seed,
            raidCount: 0,
            oldAttackCount: 0,
            oldRaidCount: 0,
            addedAttackCount: 1,
            addedRaidCount: 0,
            eventType: 'attack',
            playerId: String(playerId),
            observedAtMs: T0 + seed,
        },
        {
            world, playerId: String(playerId), observedAtMs: T0 + seed,
            queuedAtMs: T0 + seed, enforceQueueContract: true,
        }
    );
}

function legacyPendingEntry(world) {
    return {
        events: [persistedLegacyEvent(world, '101', 1), persistedLegacyEvent(world, '102', 2)],
        inFlight: [persistedLegacyEvent(world, '103', 3), persistedLegacyEvent(world, '104', 4)],
        createdAt: T0,
        attemptCount: 1,
    };
}

function seedPersistedLegacy(storage) {
    const pending = {
        [WORLD]: legacyPendingEntry(WORLD),
        [OTHER_WORLD]: legacyPendingEntry(OTHER_WORLD),
    };
    const failed = runtime.enqueueFailedEvents(
        {}, WORLD, [persistedLegacyEvent(WORLD, '105', 5), persistedLegacyEvent(WORLD, '106', 6)], T0 + 7, '404'
    );
    failed[OTHER_WORLD] = runtime.enqueueFailedEvents(
        {}, OTHER_WORLD, [persistedLegacyEvent(OTHER_WORLD, '205', 5)], T0 + 7, '404'
    )[OTHER_WORLD];
    storage.values.set(PENDING_KEY, JSON.stringify(pending));
    storage.values.set(FAILED_KEY, JSON.stringify(failed));
    return { pending, failed };
}

// Mirrors the runtime's own legacy readers (loadPendingBatch + the
// loadInFlightBatch projection of pending[world].inFlight + loadFailedBatch)
// so every simulated restart re-reads the persisted bytes.
function legacyViewFromStorage(storage) {
    const pending = JSON.parse(storage.values.get(PENDING_KEY) || '{}');
    const failed = JSON.parse(storage.values.get(FAILED_KEY) || '{}');
    const inFlight = {};
    for (const [worldKey, world] of Object.entries(pending)) {
        if (world && Array.isArray(world.inFlight)) {
            inFlight[worldKey] = { events: world.inFlight.slice(), createdAt: world.createdAt };
        }
    }
    return { pending, inFlight, failed };
}

// Store-local identities exactly as the existing migration planner derives
// them; Task 15 must match this derivation, not a concatenated index space.
function expectedLegacyIds(pending, failed) {
    const inFlight = {};
    for (const [worldKey, world] of Object.entries(pending)) {
        if (world && Array.isArray(world.inFlight)) {
            inFlight[worldKey] = { events: world.inFlight.slice(), createdAt: world.createdAt };
        }
    }
    const plan = runtime.planMonitorLegacyMigration({ pending, inFlight, failed }, null, WORLD);
    return [...plan.pending, ...plan.inFlight, ...plan.failed].map((event) => event.eventId);
}

function seedMigratedEnvelope(storage) {
    const base = runtime.createMonitorEnvelopeV1(WORLD, {
        baselineByPlayerId: { '101': { attackCount: 3, raidCount: 1 } },
        migration: { completedAtMs: T0, sources: ['pending', 'inFlight', 'failed'] },
    });
    const seeded = runtime.commitMonitorEnvelopeV1({
        world: WORLD, currentEnvelope: null, candidateEnvelope: base, expectedGeneration: -1, storage,
    });
    assert.equal(seeded.outcome, 'ok', 'fixture: migrated envelope commits');
    return seeded.envelope;
}

function persistedEnvelope(storage) {
    const loaded = runtime.loadMonitorEnvelopeV1(WORLD, { storage });
    return loaded.envelope || null;
}

function queueIdentityCounts(envelope) {
    const counts = new Map();
    const queues = [
        ...(envelope.pending || []), ...(envelope.inFlight || []),
        ...(envelope.failed || []), ...(envelope.uncertain || []),
    ];
    for (const event of queues) {
        const id = String(event.eventId);
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
}

function assertRepresentedExactlyOnce(envelope, ids, label) {
    const counts = queueIdentityCounts(envelope);
    for (const id of ids) {
        assert.equal(
            counts.get(id) || 0, 1,
            `${label}: conservation failure - legacy identity ${id} must be represented exactly once in the envelope (found ${counts.get(id) || 0}); a stale/duplicated record would be delivered twice`
        );
    }
    for (const [id, count] of counts) {
        assert.equal(count, 1, `${label}: conservation failure - envelope queue identity ${id} appears ${count} times`);
    }
}

// Byte-presence of the world's legacy records across all three stores; a
// removed world entry counts as drained too. An array-form world entry carries
// its records directly (no `events`/`inFlight` wrapper).
function legacyStoredRecordCount(storage, worldKey) {
    const pending = JSON.parse(storage.values.get(PENDING_KEY) || '{}')[worldKey];
    const failed = JSON.parse(storage.values.get(FAILED_KEY) || '{}')[worldKey];
    const count = (entry) => Array.isArray(entry)
        ? entry.length
        : (Array.isArray(entry && entry.events) ? entry.events.length : 0)
            + (Array.isArray(entry && entry.inFlight) ? entry.inFlight.length : 0);
    return count(pending) + count(failed);
}

// Storage with deterministic failure injection on exact keys:
//   throwOnSet      -> that key's write throws (pre-write failure)
//   staleReadKeys   -> once written, reads of that key keep returning the
//                      pre-write value until clearStaleReads() models a fresh
//                      process (unverified/indeterminate write).
function controlledStorage(seed) {
    const values = new Map(Object.entries(seed || {}));
    const log = { sets: [], gets: [] };
    const rules = { throwOnSet: new Set(), staleReadKeys: new Set() };
    const staleSnapshot = new Map();
    const staleArmed = new Set();
    return {
        values, log, rules,
        clearStaleReads() { rules.staleReadKeys.clear(); staleSnapshot.clear(); staleArmed.clear(); },
        get(key) {
            log.gets.push(key);
            if (rules.staleReadKeys.has(key) && staleArmed.has(key)) {
                return staleSnapshot.has(key) ? staleSnapshot.get(key) : undefined;
            }
            return values.has(key) ? values.get(key) : undefined;
        },
        set(key, value) {
            log.sets.push(key);
            if (rules.throwOnSet.has(key)) throw new Error(`injected storage failure: ${key}`);
            if (rules.staleReadKeys.has(key) && !staleSnapshot.has(key)) {
                staleSnapshot.set(key, values.has(key) ? values.get(key) : undefined);
            }
            values.set(key, String(value));
            if (rules.staleReadKeys.has(key)) staleArmed.add(key);
        },
    };
}

function storageSnapshot(storage) {
    return [...storage.values.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

// Hard proof of "no real network": the reconciliation window runs with the
// fetch/http/https primitives replaced by throwing recorders.
function withoutNetwork(run) {
    const calls = [];
    const original = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
    const blocker = (label) => () => { calls.push(label); throw new Error(`network is forbidden during reconciliation: ${label}`); };
    globalThis.fetch = blocker('fetch');
    http.request = blocker('http.request');
    http.get = blocker('http.get');
    https.request = blocker('https.request');
    https.get = blocker('https.get');
    try {
        return { value: run(), calls };
    } finally {
        globalThis.fetch = original.fetch;
        http.request = original.httpRequest;
        http.get = original.httpGet;
        https.request = original.httpsRequest;
        https.get = original.httpsGet;
    }
}

// One simulated startup pass: legacy stores are re-read from persisted bytes,
// then the artifact's load-or-reconcile entry point runs offline.
function reconcile(storage, extra = {}) {
    const guarded = withoutNetwork(() => {
        try {
            const legacy = legacyViewFromStorage(storage);
            return {
                threw: false,
                result: runtime.loadOrMigrateMonitorEnvelopeV1(
                    WORLD, null, Object.assign({ storage, legacy, nowMs: T0 + 9000 }, extra)
                ),
            };
        } catch (error) {
            return { threw: true, error };
        }
    });
    return Object.assign(guarded.value, { networkCalls: guarded.calls });
}

function outcomeText(outcome) {
    return outcome.threw
        ? String((outcome.error && outcome.error.message) || outcome.error)
        : JSON.stringify(outcome.result);
}

function assertOffline(outcome, label) {
    assert.deepEqual(outcome.networkCalls, [], `${label}: offline reconciliation must not perform any network request`);
}

function assertNotReportedOk(outcome, label) {
    if (outcome.threw) return; // an explicit thrown failure is fail-closed as well
    assert.notEqual(
        outcome.result.outcome, 'ok',
        `${label}: the current artifact reports success while stale legacy records remain; a failed/gated reconciliation must never be reported as 'ok' (misleading success output)`
    );
}

test('(k1) coexistence: existing envelope + dual-written legacy queues conserve every record and drain all stores', () => {
    const storage = controlledStorage();
    const seededEnvelope = seedMigratedEnvelope(storage);
    const baselineBefore = JSON.stringify(seededEnvelope.baselineByPlayerId);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    assert.equal(expectedIds.length, 6, 'fixture: two pending + two inFlight + two failed records');
    assert.equal(new Set(expectedIds).size, 6, 'fixture: every store-local identity is distinct');
    const otherPendingBefore = JSON.stringify(fixtures.pending[OTHER_WORLD]);
    const otherFailedBefore = JSON.stringify(fixtures.failed[OTHER_WORLD]);

    const outcome = reconcile(storage);
    assertOffline(outcome, '(k1)');
    assert.equal(outcome.threw, false, `(k1): a valid world must not throw (${outcome.error && outcome.error.message})`);

    const envelope = persistedEnvelope(storage);
    assert.ok(envelope, '(k1): the envelope must survive reconciliation');
    assertRepresentedExactlyOnce(envelope, expectedIds, '(k1)');

    const activeIds = [...envelope.pending, ...envelope.inFlight].map((event) => String(event.eventId));
    assert.deepEqual(
        activeIds.filter((id) => expectedIds.includes(id)), [],
        '(k1): unmatched legacy records must never enter the active send queues (no auto-send)'
    );
    for (const id of expectedIds) {
        const entry = envelope.uncertain.find((event) => String(event.eventId) === id);
        assert.ok(entry, `(k1): ${id} must be represented as an explicit uncertain-legacy-settlement entry`);
        assert.ok(
            String(entry.deliveryState) === 'uncertain-legacy-settlement' || String(entry.responseClass) === 'uncertain-legacy-settlement',
            `(k1): ${id} must carry the explicit uncertain-legacy-settlement marker`
        );
    }

    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k1): conservation failure - the reconciled world must be drained from pending.events, pending.inFlight and the failed map'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(PENDING_KEY))[OTHER_WORLD]), otherPendingBefore,
        '(k1): unrelated pending world must stay byte-identical'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(FAILED_KEY))[OTHER_WORLD]), otherFailedBefore,
        '(k1): unrelated failed world must stay byte-identical'
    );
    assert.equal(JSON.stringify(envelope.baselineByPlayerId), baselineBefore, '(k1): settlement must never advance the baseline');
    assert.ok(envelope.generation > seededEnvelope.generation, '(k1): representing records requires a committed envelope generation');
});

test('(k2) retained ls1: identities are not duplicated and each store keeps its own zero-based index space', () => {
    const storage = controlledStorage();
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const plan = runtime.planMonitorLegacyMigration(legacyViewFromStorage(storage), null, WORLD);
    assert.deepEqual(
        plan.pending.map((event) => runtime.decodeLegacyIdentity(event.eventId).originalIndex), [0, 1],
        'fixture: pending.events index space is 0..1'
    );
    assert.deepEqual(
        plan.inFlight.map((event) => runtime.decodeLegacyIdentity(event.eventId).originalIndex), [0, 1],
        'fixture: pending.inFlight keeps its OWN 0..1 index space (never a concatenated list)'
    );
    for (const record of [...plan.pending, ...plan.inFlight]) {
        assert.ok(['pending', 'inFlight'].includes(runtime.decodeLegacyIdentity(record.eventId).sourceStore));
    }

    // The envelope already retains three exact identities: an active pending
    // record, a failed record, and a parked uncertain settlement.
    const seeded = runtime.commitMonitorEnvelopeV1({
        world: WORLD, currentEnvelope: null,
        candidateEnvelope: runtime.createMonitorEnvelopeV1(WORLD, {
            generation: 4,
            baselineByPlayerId: { '101': { attackCount: 1, raidCount: 0 } },
            migration: { completedAtMs: T0, sources: ['pending'] },
            pending: [plan.pending[0]],
            failed: [plan.failed[0]],
            uncertain: [Object.assign({}, plan.inFlight[0], { deliveryState: 'uncertain-legacy-settlement', responseClass: 'uncertain-legacy-settlement' })],
        }),
        expectedGeneration: -1, storage,
    });
    assert.equal(seeded.outcome, 'ok', 'fixture: envelope with retained identities commits');
    const retainedIds = [plan.pending[0].eventId, plan.failed[0].eventId, plan.inFlight[0].eventId];

    const outcome = reconcile(storage);
    assertOffline(outcome, '(k2)');
    assert.equal(outcome.threw, false, `(k2): a valid world must not throw (${outcome.error && outcome.error.message})`);
    const envelope = persistedEnvelope(storage);
    assertRepresentedExactlyOnce(envelope, expectedIds, '(k2)');
    for (const id of retainedIds) {
        const entry = [...envelope.pending, ...envelope.inFlight, ...envelope.failed, ...envelope.uncertain]
            .find((event) => String(event.eventId) === id);
        assert.ok(entry, `(k2): retained identity ${id} must remain represented, not be dropped or re-derived`);
    }
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k2): conservation failure - legacy copies of already-retained identities must be drained, not left to reappear'
    );
});

test('(k3) repeated reconciliation is a byte-identical no-op (idempotent steady state)', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);

    const first = reconcile(storage);
    assertOffline(first, '(k3)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k3): conservation failure - the first reconciliation must drain the recognised world'
    );
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k3)');
    const bytesAfterFirst = JSON.stringify(storageSnapshot(storage));

    const second = reconcile(storage);
    assertOffline(second, '(k3)');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesAfterFirst,
        '(k3): rerunning reconciliation on a settled world must be a byte-identical no-op'
    );
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k3)');
});

test('(k4) envelope commit failure before any legacy write leaves legacy byte-identical and must fail closed', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const bytesBefore = JSON.stringify(storageSnapshot(storage));

    storage.rules.throwOnSet.add(runtime.monitorActiveStorageKey(WORLD));
    const failedAttempt = reconcile(storage);
    assertOffline(failedAttempt, '(k4)');
    assertNotReportedOk(failedAttempt, '(k4) envelope pre-write failure');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesBefore,
        '(k4): a failed envelope commit must leave every store byte-identical (legacy keys are only touched after a verified envelope readback)'
    );
    assert.equal(legacyStoredRecordCount(storage, WORLD), 6, '(k4): no legacy record may be dropped by a failed commit');

    storage.rules.throwOnSet.delete(runtime.monitorActiveStorageKey(WORLD));
    const repaired = reconcile(storage);
    assertOffline(repaired, '(k4-repair)');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k4-repair)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k4-repair): conservation failure - after the repaired run every legacy record must be represented and drained'
    );
});

test('(k5) crash after envelope commit but before pending cleanup: failed store untouched, stage reported, rerun resumes', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const failedBytesBefore = storage.values.get(FAILED_KEY);

    storage.rules.throwOnSet.add(PENDING_KEY);
    const crashed = reconcile(storage);
    assertOffline(crashed, '(k5)');
    assert.ok(
        outcomeText(crashed).includes('pending-cleanup-indeterminate'),
        `(k5): the exact stage must be reported as pending-cleanup-indeterminate; got ${outcomeText(crashed)}`
    );
    assert.ok(!storage.log.sets.includes(FAILED_KEY), '(k5): no failed-map write while pending cleanup is indeterminate');
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k5): the later failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k5 envelope commit)');

    storage.rules.throwOnSet.delete(PENDING_KEY);
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k5-resume)');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k5-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k5-resume): conservation failure - the resumed run must drain pending.events, pending.inFlight and the failed store'
    );

    const bytesAfterResume = JSON.stringify(storageSnapshot(storage));
    const steady = reconcile(storage);
    assertOffline(steady, '(k5-steady)');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesAfterResume,
        '(k5-steady): the resumed steady state must itself be idempotent'
    );
});

test('(k6) stale readback after the pending cleanup is indeterminate-after-write: no failed write, fresh-read resume', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const failedBytesBefore = storage.values.get(FAILED_KEY);

    storage.rules.staleReadKeys.add(PENDING_KEY);
    const indeterminate = reconcile(storage);
    assertOffline(indeterminate, '(k6)');
    assert.ok(
        outcomeText(indeterminate).includes('pending-cleanup-indeterminate'),
        `(k6): a write without a verified readback must be reported as pending-cleanup-indeterminate; got ${outcomeText(indeterminate)}`
    );
    assert.ok(!storage.log.sets.includes(FAILED_KEY), '(k6): no failed-map write while the pending readback is unverified');
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k6): the failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k6 envelope commit)');

    storage.clearStaleReads();
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k6-resume)');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k6-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k6-resume): a fresh read must classify the written pending map and finish the cleanup without duplicate representation'
    );
});

test('(k7) crash after pending cleanup but before failed cleanup: later store untouched, stage reported, rerun completes', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const failedBytesBefore = storage.values.get(FAILED_KEY);

    storage.rules.throwOnSet.add(FAILED_KEY);
    const crashed = reconcile(storage);
    assertOffline(crashed, '(k7)');
    assert.ok(
        outcomeText(crashed).includes('failed-cleanup-indeterminate'),
        `(k7): the exact stage must be reported as failed-cleanup-indeterminate; got ${outcomeText(crashed)}`
    );
    assert.ok(storage.log.sets.includes(PENDING_KEY), '(k7): the pending cleanup was attempted before the reported stage');
    const pendingWorld = JSON.parse(storage.values.get(PENDING_KEY))[WORLD];
    assert.equal(
        (pendingWorld.events || []).length + (pendingWorld.inFlight || []).length, 0,
        '(k7): the verified pending cleanup must persist (a verified earlier write is never reconstructed)'
    );
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k7): the not-yet-written failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k7 envelope commit)');

    storage.rules.throwOnSet.delete(FAILED_KEY);
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k7-resume)');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k7-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k7-resume): conservation failure - the resumed run must finish the failed-store cleanup without losing records'
    );
});

test('(k8) malformed legacy record fails the world preflight with zero writes', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    seedPersistedLegacy(storage);
    // Isolate the reconciliation write window from the fixture's own seeding.
    storage.log.sets.length = 0;
    const pending = JSON.parse(storage.values.get(PENDING_KEY));
    const malformed = Object.assign(persistedLegacyEvent(WORLD, '107', 7), { canonicalEventFields: { name: 'tampered' } });
    pending[WORLD].events.push(malformed);
    storage.values.set(PENDING_KEY, JSON.stringify(pending));
    const bytesBefore = JSON.stringify(storageSnapshot(storage));

    const outcome = reconcile(storage);
    assertOffline(outcome, '(k8)');
    assertNotReportedOk(outcome, '(k8) malformed legacy preflight');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesBefore,
        '(k8): a malformed record must fail the whole-world preflight before any envelope/cleanup write, leaving all three stores byte-for-byte'
    );
    assert.equal(storage.log.sets.length, 0, '(k8): a malformed world preflight performs zero writes');
});

// ---------------------------------------------------------------------------
// (k9/k10/k13) staged-cleanup lease fence. Reconciliation already receives the
// live lease predicate (`beforeCommit`/`isCurrentLeaseOwner`) and fences the
// envelope commit with it. The staged legacy cleanup must fence EACH of its two
// writes the same way: ownership lost after the envelope commit (k9), after the
// verified pending write (k10), or during a fresh migration (k13) must stop
// with a fenced rejection, leave the not-yet-written store byte-identical, and
// resume on the next ownership pass.
// (k11/k12) array-form legacy world entries. monitorLegacyEvents migrates both
// a direct array and an `{ events }` object, so the cleanup predicates and the
// staged replacement must recognise and clear the array form with the same
// verified readback and store order.
// ---------------------------------------------------------------------------

// controlledStorage plus a live-lease model: the fence reads `lease.owned`, and
// writing `lease.loseOnSet` loses ownership exactly at that write. This
// reproduces a lease loss between two staged writes without counting the
// runtime's internal fence calls.
function leaseFencedStorage() {
    const storage = controlledStorage();
    storage.lease = { owned: true, loseOnSet: null };
    const baseSet = storage.set.bind(storage);
    storage.set = (key, value) => {
        const result = baseSet(key, value);
        if (storage.lease.loseOnSet === key) storage.lease.owned = false;
        return result;
    };
    return storage;
}

// `form` selects which store carries the direct array; the other store keeps
// the object form and the unrelated world always keeps the object form, so
// "unrelated worlds untouched" stays a byte proof.
function seedArrayFormLegacy(storage, form) {
    const pendingWorld = form === 'pending'
        ? [persistedLegacyEvent(WORLD, '101', 1), persistedLegacyEvent(WORLD, '102', 2)]
        : legacyPendingEntry(WORLD);
    const failedWorld = form === 'failed'
        ? [persistedLegacyEvent(WORLD, '105', 5), persistedLegacyEvent(WORLD, '106', 6)]
        : runtime.enqueueFailedEvents(
            {}, WORLD, [persistedLegacyEvent(WORLD, '105', 5), persistedLegacyEvent(WORLD, '106', 6)], T0 + 7, '404'
        )[WORLD];
    const pending = { [WORLD]: pendingWorld, [OTHER_WORLD]: legacyPendingEntry(OTHER_WORLD) };
    const failed = {
        [WORLD]: failedWorld,
        [OTHER_WORLD]: runtime.enqueueFailedEvents(
            {}, OTHER_WORLD, [persistedLegacyEvent(OTHER_WORLD, '205', 5)], T0 + 7, '404'
        )[OTHER_WORLD],
    };
    storage.values.set(PENDING_KEY, JSON.stringify(pending));
    storage.values.set(FAILED_KEY, JSON.stringify(failed));
    return { pending, failed };
}

function assertNoAutoSend(envelope, ids, label) {
    const activeIds = [...envelope.pending, ...envelope.inFlight].map((event) => String(event.eventId));
    assert.deepEqual(
        activeIds.filter((id) => ids.includes(id)), [],
        `${label}: unmatched legacy records must never enter the active send queues (no auto-send)`
    );
    for (const id of ids) {
        const entry = envelope.uncertain.find((event) => String(event.eventId) === id);
        assert.ok(entry, `${label}: ${id} must be represented as an explicit uncertain-legacy-settlement entry`);
        assert.ok(
            String(entry.deliveryState) === 'uncertain-legacy-settlement' || String(entry.responseClass) === 'uncertain-legacy-settlement',
            `${label}: ${id} must carry the explicit uncertain-legacy-settlement marker`
        );
    }
}

test('(k9) lease loss before the pending cleanup write: fenced reject, both legacy stores byte-identical, resume drains', () => {
    const storage = leaseFencedStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const pendingBytesBefore = storage.values.get(PENDING_KEY);
    const failedBytesBefore = storage.values.get(FAILED_KEY);
    // Ownership is lost exactly when the envelope's active key commits: after
    // the commit fences and before the first staged cleanup write.
    storage.lease.loseOnSet = runtime.monitorActiveStorageKey(WORLD);

    const outcome = reconcile(storage, { beforeCommit: () => storage.lease.owned });
    assertOffline(outcome, '(k9)');
    assert.equal(outcome.threw, false, `(k9): a lease loss must not throw (${outcome.error && outcome.error.message})`);
    assert.notEqual(outcome.result.outcome, 'ok', '(k9): a lost lease must never report a successful reconciliation');
    assert.ok(
        outcomeText(outcome).includes('fenced-reject'),
        `(k9): the cleanup must stop with a fenced rejection; got ${outcomeText(outcome)}`
    );
    assert.ok(
        outcomeText(outcome).includes('pending-cleanup'),
        `(k9): the exact stage must name pending-cleanup; got ${outcomeText(outcome)}`
    );
    assert.equal(storage.values.get(PENDING_KEY), pendingBytesBefore, '(k9): the unfenced pending write must not happen');
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k9): the later failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k9 envelope commit)');

    storage.lease.owned = true;
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k9-resume)');
    assert.equal(resumed.result.outcome, 'reconciled', `(k9-resume): a live lease must finish the cleanup; got ${outcomeText(resumed)}`);
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k9-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k9-resume): conservation failure - the resumed run must drain every legacy store'
    );
});

test('(k10) lease loss before the failed cleanup write: verified pending write persists, failed byte-identical, resume drains', () => {
    const storage = leaseFencedStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const failedBytesBefore = storage.values.get(FAILED_KEY);
    // Ownership survives the commit and the pending write, then is lost before
    // the failed cleanup write.
    storage.lease.loseOnSet = PENDING_KEY;

    const outcome = reconcile(storage, { beforeCommit: () => storage.lease.owned });
    assertOffline(outcome, '(k10)');
    assert.equal(outcome.threw, false, `(k10): a lease loss must not throw (${outcome.error && outcome.error.message})`);
    assert.notEqual(outcome.result.outcome, 'ok', '(k10): a lost lease must never report a successful reconciliation');
    assert.ok(
        outcomeText(outcome).includes('fenced-reject'),
        `(k10): the cleanup must stop with a fenced rejection; got ${outcomeText(outcome)}`
    );
    assert.ok(
        outcomeText(outcome).includes('failed-cleanup'),
        `(k10): the exact stage must name failed-cleanup; got ${outcomeText(outcome)}`
    );
    const pendingWorld = JSON.parse(storage.values.get(PENDING_KEY))[WORLD];
    assert.equal(
        (pendingWorld.events || []).length + (pendingWorld.inFlight || []).length, 0,
        '(k10): the verified pending write must persist (an earlier verified write is never reconstructed)'
    );
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k10): the failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k10 envelope commit)');

    storage.lease.owned = true;
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k10-resume)');
    assert.equal(resumed.result.outcome, 'reconciled', `(k10-resume): a live lease must finish the cleanup; got ${outcomeText(resumed)}`);
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k10-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k10-resume): conservation failure - the resumed run must finish the failed-store cleanup without losing records'
    );
});

test('(k13) fresh migration: lease loss before the staged cleanup leaves both legacy stores byte-identical', () => {
    const storage = leaseFencedStorage();
    const fixtures = seedPersistedLegacy(storage);
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    const pendingBytesBefore = storage.values.get(PENDING_KEY);
    const failedBytesBefore = storage.values.get(FAILED_KEY);
    // No envelope yet: the migration commit writes the active key, which loses
    // ownership before the cleanup that follows it.
    storage.lease.loseOnSet = runtime.monitorActiveStorageKey(WORLD);

    const outcome = reconcile(storage, { beforeCommit: () => storage.lease.owned });
    assertOffline(outcome, '(k13)');
    assert.equal(outcome.threw, false, `(k13): a lease loss must not throw (${outcome.error && outcome.error.message})`);
    assert.ok(
        outcomeText(outcome).includes('fenced-reject'),
        `(k13): the fresh-migration cleanup must stop with a fenced rejection; got ${outcomeText(outcome)}`
    );
    assert.equal(storage.values.get(PENDING_KEY), pendingBytesBefore, '(k13): the unfenced pending write must not happen');
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k13): the unfenced failed write must not happen');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k13 migration commit)');

    storage.lease.owned = true;
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k13-resume)');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k13-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k13-resume): conservation failure - the resumed run must drain every legacy store'
    );
});

test('(k11) array-form pending world entry is drained to the canonical empty store', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedArrayFormLegacy(storage, 'pending');
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    assert.ok(Array.isArray(fixtures.pending[WORLD]), 'fixture: the pending world entry is a direct array');
    assert.equal(expectedIds.length, 4, 'fixture: two array pending + two object failed records');
    const otherPendingBefore = JSON.stringify(fixtures.pending[OTHER_WORLD]);
    const otherFailedBefore = JSON.stringify(fixtures.failed[OTHER_WORLD]);

    const outcome = reconcile(storage);
    assertOffline(outcome, '(k11)');
    assert.equal(outcome.threw, false, `(k11): a valid world must not throw (${outcome.error && outcome.error.message})`);
    assert.equal(outcome.result.outcome, 'reconciled', `(k11): the array-form world must be reconciled; got ${outcomeText(outcome)}`);
    const envelope = persistedEnvelope(storage);
    assertRepresentedExactlyOnce(envelope, expectedIds, '(k11)');
    assertNoAutoSend(envelope, expectedIds, '(k11)');
    assert.deepEqual(
        JSON.parse(storage.values.get(PENDING_KEY))[WORLD], { events: [], inFlight: [] },
        '(k11): the array-form pending entry must be replaced by the canonical empty store'
    );
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k11): conservation failure - the array-form pending records must be drained'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(PENDING_KEY))[OTHER_WORLD]), otherPendingBefore,
        '(k11): unrelated pending world must stay byte-identical'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(FAILED_KEY))[OTHER_WORLD]), otherFailedBefore,
        '(k11): unrelated failed world must stay byte-identical'
    );
    const bytesAfter = JSON.stringify(storageSnapshot(storage));
    const steady = reconcile(storage);
    assertOffline(steady, '(k11-steady)');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesAfter,
        '(k11-steady): the drained array-form world must be a byte-identical no-op'
    );
});

test('(k11b) array-form pending cleanup keeps the verified readback: stale readback is indeterminate, no failed write', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedArrayFormLegacy(storage, 'pending');
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    storage.log.sets.length = 0;
    const failedBytesBefore = storage.values.get(FAILED_KEY);
    storage.rules.staleReadKeys.add(PENDING_KEY);

    const indeterminate = reconcile(storage);
    assertOffline(indeterminate, '(k11b)');
    assert.ok(
        outcomeText(indeterminate).includes('pending-cleanup-indeterminate'),
        `(k11b): an array-form pending write without a verified readback must report pending-cleanup-indeterminate; got ${outcomeText(indeterminate)}`
    );
    assert.ok(!storage.log.sets.includes(FAILED_KEY), '(k11b): no failed-map write while the pending readback is unverified');
    assert.equal(storage.values.get(FAILED_KEY), failedBytesBefore, '(k11b): the failed store must stay byte-identical');
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k11b envelope commit)');

    storage.clearStaleReads();
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k11b-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k11b-resume): a fresh read must finish the array-form cleanup without losing records'
    );
});

test('(k12) array-form failed world entry is drained to the canonical empty store', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedArrayFormLegacy(storage, 'failed');
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    assert.ok(Array.isArray(fixtures.failed[WORLD]), 'fixture: the failed world entry is a direct array');
    assert.equal(expectedIds.length, 6, 'fixture: two pending + two inFlight + two array failed records');
    const otherPendingBefore = JSON.stringify(fixtures.pending[OTHER_WORLD]);
    const otherFailedBefore = JSON.stringify(fixtures.failed[OTHER_WORLD]);

    const outcome = reconcile(storage);
    assertOffline(outcome, '(k12)');
    assert.equal(outcome.threw, false, `(k12): a valid world must not throw (${outcome.error && outcome.error.message})`);
    assert.equal(outcome.result.outcome, 'reconciled', `(k12): the array-form world must be reconciled; got ${outcomeText(outcome)}`);
    const envelope = persistedEnvelope(storage);
    assertRepresentedExactlyOnce(envelope, expectedIds, '(k12)');
    assertNoAutoSend(envelope, expectedIds, '(k12)');
    assert.deepEqual(
        JSON.parse(storage.values.get(FAILED_KEY))[WORLD], { events: [] },
        '(k12): the array-form failed entry must be replaced by the canonical empty store'
    );
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k12): conservation failure - the array-form failed records must be drained'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(PENDING_KEY))[OTHER_WORLD]), otherPendingBefore,
        '(k12): unrelated pending world must stay byte-identical'
    );
    assert.equal(
        JSON.stringify(JSON.parse(storage.values.get(FAILED_KEY))[OTHER_WORLD]), otherFailedBefore,
        '(k12): unrelated failed world must stay byte-identical'
    );
    const bytesAfter = JSON.stringify(storageSnapshot(storage));
    const steady = reconcile(storage);
    assertOffline(steady, '(k12-steady)');
    assert.equal(
        JSON.stringify(storageSnapshot(storage)), bytesAfter,
        '(k12-steady): the drained array-form world must be a byte-identical no-op'
    );
});

test('(k12b) array-form failed cleanup keeps the verified readback: stale readback is indeterminate, staged order held', () => {
    const storage = controlledStorage();
    seedMigratedEnvelope(storage);
    const fixtures = seedArrayFormLegacy(storage, 'failed');
    const expectedIds = expectedLegacyIds(fixtures.pending, fixtures.failed);
    storage.log.sets.length = 0;
    storage.rules.staleReadKeys.add(FAILED_KEY);

    const indeterminate = reconcile(storage);
    assertOffline(indeterminate, '(k12b)');
    assert.ok(
        outcomeText(indeterminate).includes('failed-cleanup-indeterminate'),
        `(k12b): an array-form failed write without a verified readback must report failed-cleanup-indeterminate; got ${outcomeText(indeterminate)}`
    );
    const pendingWorld = JSON.parse(storage.values.get(PENDING_KEY))[WORLD];
    assert.equal(
        (pendingWorld.events || []).length + (pendingWorld.inFlight || []).length, 0,
        '(k12b): the earlier verified pending cleanup must persist'
    );
    assertRepresentedExactlyOnce(persistedEnvelope(storage), expectedIds, '(k12b envelope commit)');

    storage.clearStaleReads();
    const resumed = reconcile(storage);
    assertOffline(resumed, '(k12b-resume)');
    assert.equal(
        legacyStoredRecordCount(storage, WORLD), 0,
        '(k12b-resume): a fresh read must finish the array-form failed cleanup without losing records'
    );
});
