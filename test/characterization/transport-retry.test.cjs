'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const impl = require(path.join(SRC, 'transport-impl.js'));
const transport = require(path.join(SRC, 'transport.js'));

const CONTRACT = [
  'isRetryableOutcome', 'parseRetryAfterMs', 'sanitizeRetryDelay',
  'buildDiscordRequestUrl', 'classifyDiscordResponse',
  'sendDiscordPayload', 'sendDiscordPayloadWithRetry',
];
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fake-token';

test('transport source exposes exactly the 7-symbol contract without runtime-api', () => {
  assert.deepEqual(Object.keys(transport).sort(), [...CONTRACT].sort());
  assert.equal(Object.keys(transport).length, 7);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'transport.js'), 'utf8'), /runtime-api/u);
});

test('retryability preserves network states and retryable HTTP ranges', () => {
  for (const fixture of [[null, 'network'], [null, 'timeout'], [null, 'abort'], [null, 'other'], [408], [429], [500], [599], [404], [600]]) {
    assert.equal(impl.isRetryableOutcome(...fixture), runtime.isRetryableOutcome(...fixture));
  }
});

test('retry-after parsing preserves JSON seconds and header seconds', () => {
  const fixtures = [
    { responseText: '{"retry_after":1.25}' },
    { responseText: '{}', responseHeaders: 'Retry-After: 3\r\nContent-Type: text/plain' },
    { responseText: 'not-json', responseHeaders: '' },
  ];
  for (const fixture of fixtures) assert.equal(impl.parseRetryAfterMs(fixture), runtime.parseRetryAfterMs(fixture));
});

test('retry delay preserves fallback, floor, zero, and maximum cap', () => {
  for (const fixture of [[null, 1000], [-1, 3000], [0, 1000], [1234.9, 1000], [3600000, 1000]]) {
    assert.equal(impl.sanitizeRetryDelay(...fixture), runtime.sanitizeRetryDelay(...fixture));
  }
});

test('request URL validation preserves Discord origin and wait=true query', () => {
  assert.equal(impl.buildDiscordRequestUrl(WEBHOOK), runtime.buildDiscordRequestUrl(WEBHOOK));
  assert.equal(new URL(impl.buildDiscordRequestUrl(WEBHOOK)).searchParams.get('wait'), 'true');
  assert.equal(impl.buildDiscordRequestUrl('https://example.test/hook'), null);
});

test('response classification preserves acknowledged, uncertain, retryable, and permanent states', () => {
  const fixtures = [
    { status: 200, responseText: '{"id":"message-1"}' },
    { status: 200, responseText: '{}' },
    { status: 200, responseText: 'bad' },
    { status: 429, responseText: '{"retry_after":1}' },
    { status: 503, responseText: '{}' },
    { status: 404, responseText: '{}' },
    { status: null, errorClass: 'timeout' },
  ];
  for (const fixture of fixtures) assert.deepEqual(impl.classifyDiscordResponse(fixture), runtime.classifyDiscordResponse(fixture));
});

test('send maps GM load, network, timeout, abort, and throw callbacks once', async () => {
  const scenarios = [
    [(details) => details.onload({ status: 200, responseText: '{"id":"m1"}' }), 'acknowledged'],
    [(details) => details.onerror(new Error('network')), 'retryable'],
    [(details) => details.ontimeout(), 'retryable'],
    [(details) => details.onabort(), 'retryable'],
    [() => { throw new Error('network'); }, 'retryable'],
  ];
  for (const [gmRequest, kind] of scenarios) {
    const outcome = await impl.sendDiscordPayload({ webhookUrl: WEBHOOK, payload: { content: 'probe' }, gmRequest });
    assert.equal(outcome.kind, kind);
  }
  assert.deepEqual(await impl.sendDiscordPayload({ webhookUrl: 'bad', payload: {} }), { kind: 'permanent', responseClass: 'configuration' });
});

test('429 then acknowledgement preserves attempts, delays, and payload bytes', async () => {
  const calls = [];
  const sleeps = [];
  const outcome = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    payload: { content: 'Żółć 😀' },
    gmRequest(details) {
      calls.push(JSON.parse(details.data));
      if (calls.length === 1) details.onload({ status: 429, responseText: '{"retry_after":1}' });
      else details.onload({ status: 200, responseText: '{"id":"m2"}' });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(outcome, { outcome: { kind: 'acknowledged', messageId: 'm2' }, attempts: 2, delays: [1000] });
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(calls, [{ content: 'Żółć 😀' }, { content: 'Żółć 😀' }]);
});

test('persistent retryable failure stops at three attempts with frozen delays', async () => {
  let attempts = 0;
  const outcome = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    gmRequest(details) { attempts += 1; details.onload({ status: 503, responseText: '{}' }); },
    sleep: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(outcome.delays, [1000, 3000]);
  assert.equal(outcome.outcome.kind, 'retryable');
});

test('404 and malformed 200 are single-attempt permanent or uncertain outcomes', async () => {
  for (const response of [{ status: 404, responseText: '{}' }, { status: 200, responseText: '{}' }]) {
    let attempts = 0;
    const outcome = await impl.sendDiscordPayloadWithRetry({
      webhookUrl: WEBHOOK,
      gmRequest(details) { attempts += 1; details.onload(response); },
      sleep: async () => assert.fail('must not sleep'),
    });
    assert.equal(attempts, 1);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.delays, []);
  }
});

test('fence rejection preserves before-attempt, after-response, and before-retry states', async () => {
  const before = await impl.sendDiscordPayloadWithRetry({ webhookUrl: WEBHOOK, fence: () => false });
  assert.deepEqual(before, { outcome: { kind: 'fenced' }, attempts: 0, delays: [] });
  const stages = [];
  const after = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    gmRequest(details) { details.onload({ status: 503, responseText: '{}' }); },
    sleep: async () => {},
    fence(stage) { stages.push(stage); return stage !== 'after-response'; },
  });
  assert.deepEqual(after, { outcome: { kind: 'fenced' }, attempts: 1, delays: [] });
  assert.deepEqual(stages, ['before-attempt', 'after-response']);
});

// ---------------------------------------------------------------------------
// Task 22 — a live multi-payload chunk retry must resume at the first
// unacknowledged payload instead of replaying payload 1.
//
// The real src/runtime.js browser branch is booted under a Node shim
// (document/location/navigator.locks/MutationObserver/memory localStorage +
// GM storage + a scripted GM_xmlhttpRequest). A valid monitor envelope is
// seeded with enough synthetic attack records to force several Discord
// payloads; the startup flush (flushPendingBatch -> sendDiscordBatch) drives
// the wire. GM_xmlhttpRequest settles synchronously so the bounded retry timer
// is captured and invoked deterministically instead of waited on.
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const SHIM_HOST = 's1.example.com';
const SHIM_T0 = 1700000000000;
const SHIM_WEBHOOK = ['https://discord.com/api/webhooks', '123456789012345678', 'fake-retry-token'].join('/');
const SHIM_GLOBALS = [
  'document', 'location', 'navigator', 'window', 'localStorage', 'sessionStorage',
  'MutationObserver', 'GM_getValue', 'GM_setValue', 'GM_deleteValue',
  'GM_registerMenuCommand', 'alert', 'setTimeout', 'clearTimeout', 'GM_xmlhttpRequest',
];

function shimElement(tag) {
  return {
    tagName: tag, style: {}, dataset: {}, children: [], className: '', textContent: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); return child; },
    addEventListener() {}, click() {}, classList: { contains: () => false },
    querySelectorAll: () => [], querySelector: () => null,
  };
}

function shimMemory() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => { values.set(String(key), String(value)); },
    removeItem: (key) => { values.delete(String(key)); },
    clear: () => { values.clear(); },
  };
}

function createRuntimeBootShim() {
  const descriptors = {};
  for (const name of SHIM_GLOBALS) descriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  const define = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const localStorage = shimMemory();
  const sessionStorage = shimMemory();
  const gm = new Map();
  const menu = new Map();
  const alerts = [];
  const timers = [];
  const requests = [];
  const realClear = globalThis.clearTimeout;
  let responder = null;
  let capturing = false;

  class ShimMutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }

  const doc = {
    readyState: 'complete',
    location: { origin: `https://${SHIM_HOST}` },
    documentElement: shimElement('html'),
    body: shimElement('body'),
    head: shimElement('head'),
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    tables: [],
    querySelectorAll(selector) { return selector === 'table' ? doc.tables : []; },
    querySelector: () => null,
    getElementById: (id) => (id === 'taa-open-panel' || id === 'taa-panel-overlay' || id === 'taa-panel-style' ? shimElement('div') : null),
    createElement: (tag) => shimElement(tag),
    addEventListener() {},
  };
  const loc = { href: `https://${SHIM_HOST}/alliance/profile/members`, hostname: SHIM_HOST, origin: `https://${SHIM_HOST}`, reload() { throw new Error('unexpected reload'); } };
  const nav = { userAgent: 'node', locks: { request: async (name, options, task) => task({ name }) } };
  const win = {
    addEventListener() {},
    __TAA_TEST_HOOK__: {
      onReadinessCommit() {}, onExtractionStart() {}, onSnapshot() {}, onLeaseAcquired() {}, onStandby() {},
    },
  };

  define('document', doc);
  define('location', loc);
  define('navigator', nav);
  define('window', win);
  define('localStorage', localStorage);
  define('sessionStorage', sessionStorage);
  define('MutationObserver', ShimMutationObserver);
  define('GM_getValue', (key, fallback) => (gm.has(key) ? gm.get(key) : fallback));
  define('GM_setValue', (key, value) => { gm.set(key, value); });
  define('GM_deleteValue', (key) => { gm.delete(key); });
  define('GM_registerMenuCommand', (name, callback) => { menu.set(String(name), callback); });
  define('alert', (message) => { alerts.push(String(message)); });
  define('setTimeout', (fn, delayMs, ...args) => {
    const handle = realSetTimeout(fn, delayMs, ...args);
    if (capturing) timers.push({ handle, fn, delayMs, args, cleared: false });
    return handle;
  });
  define('clearTimeout', (handle) => {
    for (const timer of timers) if (timer.handle === handle) timer.cleared = true;
    return realClear(handle);
  });
  define('GM_xmlhttpRequest', (options) => {
    const attempt = requests.length + 1;
    requests.push({ attempt, data: String(options.data || '') });
    const response = responder ? responder(attempt, options) : { status: 200, responseText: `{"id":"auto-${attempt}"}`, responseHeaders: '' };
    // Synchronous settle: the retry timer is scheduled while capturing is true.
    if (response.errorClass) options.onerror && options.onerror(new Error(response.errorClass));
    else options.onload && options.onload(response);
  });

  return {
    localStorage, sessionStorage, gm, menu, alerts, timers, requests,
    setResponder(fn) { responder = fn; },
    run(fn) { capturing = true; try { return fn(); } finally { capturing = false; } },
    invoke(timer) {
      for (const entry of timers) if (entry.handle === timer.handle) entry.cleared = true;
      realClear(timer.handle);
      timer.fn(...timer.args);
    },
    findTimer(predicate) { return timers.find((timer) => !timer.cleared && predicate(timer)); },
    restore() {
      for (const timer of timers) if (!timer.cleared) realClear(timer.handle);
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function freshBrowserRuntime() {
  const runtimePath = path.join(SRC, 'runtime.js');
  delete require.cache[require.resolve(runtimePath)];
  return require(runtimePath);
}

function syntheticAttackRecords(count) {
  const events = [];
  for (let i = 1; i <= count; i += 1) {
    events.push(runtime.createMonitorQueueEvent({
      name: `Synthetic Player ${String(i).padStart(3, '0')} ${'X'.repeat(24)}`,
      url: `https://${SHIM_HOST}/profile/${i}`,
      attackCount: 1, raidCount: 0, oldAttackCount: 0, oldRaidCount: 0,
      addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack',
    }, { world: SHIM_HOST, playerId: String(i), observedAtMs: SHIM_T0, queuedAtMs: SHIM_T0 }));
  }
  return events;
}

function seedEnvelope(env, events) {
  const envelope = runtime.createMonitorEnvelopeV1(SHIM_HOST, { generation: 3, pending: events, baselineByPlayerId: {} });
  const raw = runtime.serializeMonitorEnvelopeV1(envelope);
  env.gm.set(runtime.monitorActiveStorageKey(SHIM_HOST), raw);
  env.gm.set(runtime.monitorBackupStorageKey(SHIM_HOST), raw);
  return envelope;
}

function bootLeaderWithEnvelope(count, buildResponder) {
  const env = createRuntimeBootShim();
  const events = syntheticAttackRecords(count);
  seedEnvelope(env, events);
  env.gm.set(runtime.WEBHOOK_STORAGE_KEY, SHIM_WEBHOOK);
  if (typeof buildResponder === 'function') env.setResponder(buildResponder(env));
  const booted = freshBrowserRuntime();
  env.run(() => booted.startBrowserRuntime());
  const jitter = env.findTimer((timer) => timer.delayMs < 1000);
  assert.ok(jitter, 'startup acquisition jitter timer must be scheduled');
  env.run(() => env.invoke(jitter));
  return { env, booted, events };
}

function playerIdsOf(data) {
  const text = String(data || '');
  return [...new Set((text.match(/\/profile\/(\d+)/gu) || []).map((token) => Number(token.split('/').pop())))].sort((left, right) => left - right);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readEnvelope(env) {
  const parsed = runtime.parseMonitorEnvelopeV1(env.gm.get(runtime.monitorActiveStorageKey(SHIM_HOST)), SHIM_HOST);
  assert.equal(parsed.ok, true, 'seeded envelope must still parse after delivery');
  return parsed.envelope;
}

// Drives every captured bounded retry timer (1s then 3s) to completion.
function drainRetryTimers(env) {
  let guard = 0;
  let timer = env.findTimer((entry) => entry.delayMs === 1000 || entry.delayMs === 3000);
  while (timer && guard < 10) {
    env.run(() => env.invoke(timer));
    guard += 1;
    timer = env.findTimer((entry) => entry.delayMs === 1000 || entry.delayMs === 3000);
  }
  return guard;
}

// Responder that fails the FIRST non-payload-1 payload (the second Discord
// request), then answers per mode. Player id 1 is only in payload 1, so the
// failing payload is identified by its stable player-id set.
function makePayloadResponder(mode, env) {
  let failedIds = null;
  let failedAttempts = 0;
  let counter = 0;
  return (attempt, options) => {
    const ids = playerIdsOf(options.data);
    if (failedIds === null && !ids.includes(1)) failedIds = ids;
    const isFailing = failedIds !== null && sameIds(ids, failedIds);
    if (isFailing) failedAttempts += 1;
    counter += 1;
    const ok = { status: 200, responseText: `{"id":"message-${counter}"}`, responseHeaders: '' };
    if (mode === 'leader-loss') {
      if (attempt === 1) env.localStorage.setItem(runtime.TAB_LEASE_STORAGE_KEY, JSON.stringify({ [SHIM_HOST]: { ownerId: 'foreign-owner', expiresAtMs: Date.now() + 60000, token: 'foreign', generation: 9, term: 9 } }));
      return ok;
    }
    if (!isFailing) return ok;
    if (mode === 'retry-once') return failedAttempts === 1 ? { status: 429, responseText: '{"retry_after":1}', responseHeaders: '' } : ok;
    if (mode === 'exhaust-then-permanent') return failedAttempts <= 3 ? { status: 429, responseText: '{"retry_after":1}', responseHeaders: '' } : { status: 404, responseText: '{}', responseHeaders: '' };
    if (mode === 'permanent') return { status: 404, responseText: '{}', responseHeaders: '' };
    if (mode === 'uncertain') return { status: 200, responseText: '{}', responseHeaders: '' };
    return ok;
  };
}

test('live multi-payload retry resumes at the first unacknowledged payload (payload 1 posted once)', () => {
  const { env } = bootLeaderWithEnvelope(180, (boot) => makePayloadResponder('retry-once', boot));
  try {
    // Boot already posted payload 1 (ack) and payload 2 (retryable 429); the
    // bounded retry timer is captured but not yet invoked.
    assert.equal(env.requests.length, 2, 'boot posts payload 1 then the failed payload 2 once');
    const fired = drainRetryTimers(env);
    assert.ok(fired >= 1, 'at least one bounded retry timer must fire');
    const sets = env.requests.map((request) => playerIdsOf(request.data));
    const unique = new Set(sets.map((ids) => ids.join(',')));
    assert.ok(unique.size >= 3, `fixture must force at least three payloads, got ${unique.size}`);
    const firstPayloadRepeats = sets.filter((ids) => sameIds(ids, sets[0])).length;
    assert.equal(firstPayloadRepeats, 1, 'payload 1 (acknowledged) must be posted exactly once');
    assert.ok(sameIds(sets[1], sets[2]), 'retry must resume at the failed payload, not restart at payload 1');
    assert.notEqual(sets[2].join(','), sets[0].join(','), 'retry must not replay payload 1');
    assert.equal(env.requests[1].data, env.requests[2].data, 'failed payload bytes must be immutable across retry');
    assert.ok(env.requests.length < unique.size + 3, 'no retry storm beyond the failed payload');
    const envelope = readEnvelope(env);
    assert.equal(envelope.pending.length, 0);
    assert.equal(envelope.inFlight.length, 0);
    assert.equal(envelope.failed.length, 0);
    assert.equal(envelope.uncertain.length, 0);
    assert.equal(envelope.metrics.deliveryAccounting.terminal.filter((entry) => entry.terminalStatus === 'acknowledged').length, 180);
  } finally {
    env.restore();
  }
});

test('retryable exhaustion keeps acknowledged payload 1 posted once and the chunk recoverable', () => {
  const { env } = bootLeaderWithEnvelope(180, (boot) => makePayloadResponder('exhaust-then-permanent', boot));
  try {
    assert.equal(env.requests.length, 2, 'boot posts payload 1 then the failed payload 2 once');
    drainRetryTimers(env);
    const sets = env.requests.map((request) => playerIdsOf(request.data));
    assert.equal(sets.filter((ids) => sameIds(ids, sets[0])).length, 1, 'acknowledged payload 1 must not be replayed on bounded retries');
    const failedPosts = sets.filter((ids) => sameIds(ids, sets[1])).length;
    assert.ok(failedPosts <= runtime.MAX_ATTEMPT_COUNT, `failed payload retried at most MAX_ATTEMPT_COUNT times, got ${failedPosts}`);
    const envelope = readEnvelope(env);
    const recoverable = envelope.inFlight.length + envelope.failed.length + envelope.uncertain.length;
    assert.equal(recoverable, 180, 'every event stays recoverable, none silently dropped');
    assert.equal(envelope.metrics.deliveryAccounting.terminal.filter((entry) => entry.terminalStatus === 'acknowledged').length, 0);
    // Simulated restart: a fresh parse of the persisted bytes keeps the same
    // recoverable lineage (at-least-once, no new persisted fields).
    const restarted = runtime.parseMonitorEnvelopeV1(env.gm.get(runtime.monitorActiveStorageKey(SHIM_HOST)), SHIM_HOST);
    assert.equal(restarted.ok, true);
    const lineage = (events) => events.map((event) => `${event.playerId}:${event.eventType}:${event.addedAttackCount}`).sort();
    const before = lineage([...envelope.inFlight, ...envelope.failed, ...envelope.uncertain]);
    const after = lineage([...restarted.envelope.inFlight, ...restarted.envelope.failed, ...restarted.envelope.uncertain]);
    assert.deepEqual(after, before);
  } finally {
    env.restore();
  }
});

test('permanent failure and ID-less uncertain 200 settle without replaying payload 1', () => {
  for (const [mode, bucket] of [['permanent', 'failed'], ['uncertain', 'uncertain']]) {
    const { env } = bootLeaderWithEnvelope(180, (boot) => makePayloadResponder(mode, boot));
    try {
      const sets = env.requests.map((request) => playerIdsOf(request.data));
      assert.equal(env.requests.length, 2, `${mode}: exactly payload 1 then the failed payload`);
      assert.equal(sets.filter((ids) => sameIds(ids, sets[0])).length, 1, `${mode}: payload 1 posted exactly once`);
      assert.equal(env.findTimer((entry) => entry.delayMs === 1000 || entry.delayMs === 3000), undefined, `${mode}: no retry timer`);
      const envelope = readEnvelope(env);
      assert.equal(envelope.inFlight.length, 0);
      assert.equal(envelope[bucket].length, 180, `${mode}: whole chunk settled into ${bucket}`);
      assert.equal(envelope.metrics.deliveryAccounting.terminal.filter((entry) => entry.terminalStatus === 'acknowledged').length, 0);
    } finally {
      env.restore();
    }
  }
});

test('leader loss between payloads preserves the in-flight chunk', () => {
  const { env } = bootLeaderWithEnvelope(180, (boot) => makePayloadResponder('leader-loss', boot));
  try {
    assert.equal(env.requests.length, 1, 'only payload 1 is posted before the lease is lost');
    assert.equal(playerIdsOf(env.requests[0].data).includes(1), true);
    assert.equal(env.findTimer((entry) => entry.delayMs === 1000 || entry.delayMs === 3000), undefined, 'leader loss must not schedule a retry');
    const envelope = readEnvelope(env);
    assert.equal(envelope.inFlight.length, 180, 'the whole chunk stays recoverable in inFlight');
    assert.equal(envelope.failed.length, 0);
    assert.equal(envelope.uncertain.length, 0);
  } finally {
    env.restore();
  }
});
