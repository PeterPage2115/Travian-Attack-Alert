'use strict';

// Task 1 (scan-webhook-latency) — post-commit immediate flush characterization.
//
// v1.0.3 durably queues detected events during scanAttacks() but never requests
// a flush; only the 30-second watchdog (`scheduleBatchFlush`) and startup/reload
// drain the queue, so a healthy alert waits almost the full watchdog period
// (measured real-artifact onScanComplete -> GM_xmlhttpRequest start = 29,501 ms).
//
// Tasks 2-4 add a deduplicated zero-delay `requestImmediateBatchFlush()` next to
// `scheduleBatchFlush()`, requested only after a successful durable commit that
// leaves pending work. These tests pin that scheduling contract on the real
// browser runtime under a Node shim (loopback host, memory GM storage, scripted
// GM_xmlhttpRequest, captured timers). No real Discord/Travian request is made.
// They are intentionally red on v1.0.3 and the red reason names the missing
// post-commit dispatch rather than an opaque crash.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));

const MISSING_POST_COMMIT = 'missing post-commit flush scheduling: runtime.requestImmediateBatchFlush() must schedule one zero-delay flush after a successful durable commit with pending work (v1.0.3 only waits for the 30-second watchdog)';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const SHIM_HOST = 's1.example.com';
const SHIM_T0 = 1700000000000;
const SHIM_WEBHOOK = ['https://discord.com/api/webhooks', '123456789012345678', 'fake-flush-token'].join('/');
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
  const timers = [];
  const requests = [];
  const realClear = globalThis.clearTimeout;
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
  define('alert', () => {});
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
    options.onload && options.onload({ status: 200, responseText: `{"id":"auto-${attempt}"}`, responseHeaders: '' });
  });

  return {
    localStorage, sessionStorage, gm, menu, timers, requests,
    run(fn) { capturing = true; try { return fn(); } finally { capturing = false; } },
    invoke(timer) {
      for (const entry of timers) if (entry.handle === timer.handle) entry.cleared = true;
      realClear(timer.handle);
      timer.fn(...timer.args);
    },
    findTimer(predicate) { return timers.find((timer) => !timer.cleared && predicate(timer)); },
    zeroDelayTimers() { return timers.filter((timer) => !timer.cleared && timer.delayMs === 0); },
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
      name: `Synthetic Player ${String(i).padStart(3, '0')}`,
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

// Boots the real runtime as the lease leader with a durable envelope holding
// `count` pending events, then drains the startup flush so every later request
// in a test is attributable to the immediate scheduler under test.
function bootLeader(count) {
  const env = createRuntimeBootShim();
  seedEnvelope(env, syntheticAttackRecords(count));
  env.gm.set(runtime.WEBHOOK_STORAGE_KEY, SHIM_WEBHOOK);
  const booted = freshBrowserRuntime();
  env.run(() => booted.startBrowserRuntime());
  const jitter = env.findTimer((timer) => timer.delayMs < 1000);
  assert.ok(jitter, 'startup acquisition jitter timer must be scheduled');
  env.run(() => env.invoke(jitter));
  return { env, booted };
}

function requireImmediateScheduler(booted) {
  assert.equal(typeof booted.requestImmediateBatchFlush, 'function', MISSING_POST_COMMIT);
}

function seedPendingAfterBoot(env, count) {
  seedEnvelope(env, syntheticAttackRecords(count));
}

test('runtime exposes a deduplicated immediate post-commit flush scheduler', () => {
  assert.equal(typeof runtime.requestImmediateBatchFlush, 'function', MISSING_POST_COMMIT);
});

test('a durable pending queue schedules exactly one zero-delay flush and dispatches it', () => {
  const { env, booted } = bootLeader(0);
  try {
    requireImmediateScheduler(booted);
    seedPendingAfterBoot(env, 3);
    env.run(() => { booted.requestImmediateBatchFlush(); booted.requestImmediateBatchFlush(); booted.requestImmediateBatchFlush(); });
    assert.equal(env.zeroDelayTimers().length, 1, 'repeated requests before the callback runs must deduplicate to one zero-delay timer');
    env.run(() => env.invoke(env.zeroDelayTimers()[0]));
    assert.equal(env.requests.length, 1, 'the zero-delay callback must flush the durable pending queue exactly once');
    assert.equal(env.zeroDelayTimers().length, 0, 'the callback must clear the immediate timer id before flushing');
  } finally {
    env.restore();
  }
});

test('repeated enqueue requests before the callback runs still execute one flush', () => {
  const { env, booted } = bootLeader(0);
  try {
    requireImmediateScheduler(booted);
    seedPendingAfterBoot(env, 4);
    env.run(() => booted.requestImmediateBatchFlush());
    seedPendingAfterBoot(env, 6);
    env.run(() => booted.requestImmediateBatchFlush());
    assert.equal(env.zeroDelayTimers().length, 1, 'a second enqueue must reuse the pending zero-delay timer');
    env.run(() => env.invoke(env.zeroDelayTimers()[0]));
    assert.equal(env.requests.length, 1, 'only one flush may execute for the coalesced requests');
  } finally {
    env.restore();
  }
});

test('a lease lost before the immediate callback runs dispatches nothing', () => {
  const { env, booted } = bootLeader(0);
  try {
    requireImmediateScheduler(booted);
    seedPendingAfterBoot(env, 3);
    env.run(() => booted.requestImmediateBatchFlush());
    env.localStorage.setItem(runtime.TAB_LEASE_STORAGE_KEY, JSON.stringify({
      [SHIM_HOST]: { ownerId: 'foreign-owner', expiresAtMs: Date.now() + 60000, token: 'foreign', generation: 9, term: 9 },
    }));
    env.run(() => env.invoke(env.zeroDelayTimers()[0]));
    assert.equal(env.requests.length, 0, 'a fenced callback must never send');
  } finally {
    env.restore();
  }
});

test('the 30-second watchdog remains scheduled alongside the immediate request', () => {
  const { env, booted } = bootLeader(0);
  try {
    requireImmediateScheduler(booted);
    assert.ok(env.findTimer((timer) => timer.delayMs === runtime.BATCH_FLUSH_MS), 'the 30-second recovery watchdog must stay scheduled');
    seedPendingAfterBoot(env, 2);
    env.run(() => booted.requestImmediateBatchFlush());
    env.run(() => env.invoke(env.zeroDelayTimers()[0]));
    assert.ok(env.findTimer((timer) => timer.delayMs === runtime.BATCH_FLUSH_MS), 'the immediate flush must not cancel or replace the 30-second watchdog');
  } finally {
    env.restore();
  }
});

test('scanAttacks requests the immediate flush only after a successful durable commit with pending work', () => {
  const source = fs.readFileSync(path.join(SRC, 'runtime.js'), 'utf8');
  const okGuard = source.indexOf('if (commit.outcome !== "ok")');
  const scanComplete = source.indexOf('reportLifecycleHook("onScanComplete"', okGuard);
  assert.ok(okGuard > 0 && scanComplete > okGuard, 'scanAttacks must keep its fail-closed commit guard before onScanComplete');
  const successRegion = source.slice(okGuard, scanComplete);
  const requestMatch = /requestImmediateBatchFlush\s*\(/u.exec(successRegion);
  assert.ok(requestMatch, 'scanAttacks must request an immediate batch flush after a successful durable commit (commit failure, lease loss, parser rejection, and empty pending queues must schedule none)');
  const guardWindow = successRegion.slice(Math.max(0, requestMatch.index - 400), requestMatch.index);
  assert.match(guardWindow, /pending/iu, 'the post-commit immediate flush must be guarded by committed pending work');
});
