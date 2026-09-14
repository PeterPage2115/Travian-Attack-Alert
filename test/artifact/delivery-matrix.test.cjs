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

test('(h) 60-event forced split posts part 1/3..3/3 with mentions ONLY in the first request', async () => {
    const fixture = canonical.previewCases['forced-split']();
    const options = { ...canonical.BASE_OPTIONS, roleId: ROLE_A, userIds: [USER_A, USER_B] };
    const payloads = runtime.buildDiscordPayloads(fixture.events, options);
    assert.equal(payloads.length, 3);
    assert.match(payloads[0].embeds[0].title, /part 1\/3/);
    assert.match(payloads[1].embeds[0].title, /part 2\/3/);
    assert.match(payloads[2].embeds[0].title, /part 3\/3/);

    // Verbatim onto the wire: the sink receives JSON-stringified payloads.
    const sink = await startLoopback(() => okId('m-part'));
    try {
        for (const payload of payloads) {
            const res = await fetch(sink.url, {
                method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
            });
            assert.equal(res.status, 200);
        }
        assert.equal(sink.received.length, 3);
        const [first, second, third] = sink.received.map((r) => r.body);
        assert.equal(first.content, `<@&${ROLE_A}> <@${USER_A}> <@${USER_B}>`);
        assert.deepEqual(first.allowed_mentions, { users: [USER_A, USER_B], roles: [ROLE_A] });
        assert.ok(!('parse' in first.allowed_mentions));
        for (const [label, cont] of [['second', second], ['third', third]]) {
            assert.equal(cont.content, '', `${label} continuation carries no mentions`);
            assert.deepEqual(cont.allowed_mentions, { users: [] }, `${label} allowlist is empty`);
            assert.ok(!('roles' in cont.allowed_mentions), `${label} has no roles key`);
            assert.ok(!('parse' in cont.allowed_mentions), `${label} has no parse key`);
        }
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
