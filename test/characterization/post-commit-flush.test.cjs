'use strict';

// Task 1/4 (scan-webhook-latency) — post-commit immediate flush characterization.
//
// v1.0.3 durably queued detected events during scanAttacks() but never requested
// a flush; only the 30-second watchdog (`scheduleBatchFlush`) and startup/reload
// drain the queue, so a healthy alert waited almost the full watchdog period
// (measured real-artifact onScanComplete -> GM_xmlhttpRequest start = 29,501 ms).
//
// Task 4 adds an INTERNAL, deduplicated zero-delay `requestImmediateBatchFlush()`
// next to `scheduleBatchFlush()`, requested only after a successful durable
// commit that leaves pending work (and after successful operator retry/requeue).
// It must not be an export, so these tests observe the real behavior through the
// existing browser-boot harness: a real booted runtime, the real readiness/scan
// path, and captured setTimeout / GM_xmlhttpRequest. No real Discord/Travian
// request is made.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));

const HOST = 's1.example.com';
const T0 = 1700000000000;
const WEBHOOK = ['https://discord.com/api/webhooks', '123456789012345678', 'fake-flush-token'].join('/');
const ACTIVE_KEY = runtime.monitorActiveStorageKey(HOST);
const BACKUP_KEY = runtime.monitorBackupStorageKey(HOST);
const WEBHOOK_KEY = runtime.WEBHOOK_STORAGE_KEY;
const LEASE_KEY = runtime.TAB_LEASE_STORAGE_KEY;
const WATCHDOG_MS = runtime.BATCH_FLUSH_MS;

const realSetTimeout = globalThis.setTimeout;
const SHIM_GLOBALS = [
  'document', 'location', 'navigator', 'window', 'localStorage', 'sessionStorage',
  'MutationObserver', 'GM_getValue', 'GM_setValue', 'GM_deleteValue',
  'GM_registerMenuCommand', 'setTimeout', 'clearTimeout', 'alert', 'GM_xmlhttpRequest',
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

function shimAttackIcon(count) {
  const icon = shimElement('img');
  icon.className = 'attack';
  icon.classList = { contains: (name) => name === 'attack' };
  icon.setAttribute('title', `${count} ataków`);
  return icon;
}

function shimRow(playerId, name, attackCount) {
  const row = shimElement('tr');
  const link = shimElement('a');
  link.setAttribute('href', `/profile/${playerId}`);
  link.textContent = name;
  const icon = attackCount === undefined ? null : shimAttackIcon(attackCount);
  row.querySelectorAll = (selector) => {
    if (selector === 'a') return [link];
    if (selector === 'img') return icon ? [icon] : [];
    return [];
  };
  return row;
}

function shimTable(rows) {
  const table = shimElement('table');
  table.className = 'allianceMembers';
  table.querySelectorAll = (selector) => (selector === 'tr' ? rows : []);
  return table;
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
  const hooks = { extraction: 0, flush: 0 };
  const realClear = globalThis.clearTimeout;
  let capturing = false;
  let writeFault = null;

  class ShimMutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }

  const doc = {
    readyState: 'complete',
    location: { origin: `https://${HOST}` },
    documentElement: shimElement('html'),
    body: shimElement('body'),
    hidden: false,
    tables: [],
    querySelectorAll(selector) { return selector === 'table' ? doc.tables : []; },
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag) => shimElement(tag),
    addEventListener() {},
  };
  const loc = { href: `https://${HOST}/alliance/profile/members`, hostname: HOST, origin: `https://${HOST}`, reload() { throw new Error('unexpected reload'); } };
  const nav = { locks: { request: async (name, options, task) => task({ name }) } };
  const win = {
    addEventListener() {},
    __TAA_TEST_HOOK__: {
       onExtractionStart: () => { hooks.extraction += 1; },
       onFlushStart: () => { hooks.flush += 1; },
      onLeaseAcquired() {}, onStandby() {},
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
  define('GM_setValue', (key, value) => {
    if (writeFault && String(key).includes(writeFault.keySubstring)) {
      if (writeFault.once) writeFault = null;
      throw new Error('injected GM write failure');
    }
    gm.set(key, value);
  });
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
    requests.push({ attempt: requests.length + 1, data: String(options.data || '') });
    if (typeof options.onload === 'function') options.onload({ status: 200, responseText: `{"id":"auto-${requests.length}"}`, responseHeaders: '' });
  });

  return {
    localStorage, sessionStorage, gm, menu, alerts, timers, requests, hooks,
    run(fn) { capturing = true; try { return fn(); } finally { capturing = false; } },
    invoke(timer) {
      assert.ok(timer, 'expected a captured runtime timer');
      for (const entry of timers) if (entry.handle === timer.handle) entry.cleared = true;
      realClear(timer.handle);
      timer.fn(...timer.args);
    },
    findTimer(predicate) { return timers.find((timer) => !timer.cleared && predicate(timer)); },
    zeroDelayTimers() { return timers.filter((timer) => !timer.cleared && timer.delayMs === 0); },
    setTable(rows) { doc.tables = rows === null ? [] : [shimTable(rows)]; },
    failNextWrite(keySubstring) { writeFault = { keySubstring, once: true }; },
    restore() {
      for (const timer of timers) if (!timer.cleared) realClear(timer.handle);
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function freshRuntime() {
  const runtimePath = path.join(SRC, 'runtime.js');
  delete require.cache[require.resolve(runtimePath)];
  return require(runtimePath);
}

function queuedAttackEvent(playerId, addedAttackCount) {
  return runtime.createMonitorQueueEvent({
    name: `Player ${playerId}`,
    url: `https://${HOST}/profile/${playerId}`,
    attackCount: addedAttackCount, raidCount: 0, oldAttackCount: 0, oldRaidCount: 0,
    addedAttackCount, addedRaidCount: 0, eventType: 'attack',
  }, { world: HOST, playerId: String(playerId), observedAtMs: T0, queuedAtMs: T0 });
}

function seedBaselineEnvelope(env, options = {}) {
  const baselineByPlayerId = options.baselineByPlayerId || {
    '101': { name: 'Player 101', url: `https://${HOST}/profile/101`, attackCount: 0, raidCount: 0 },
  };
  const envelope = runtime.createMonitorEnvelopeV1(HOST, {
    generation: options.generation || 1,
    baselineByPlayerId,
    pending: options.pending || [],
    failed: options.failed || [],
    uncertain: options.uncertain || [],
  });
  const raw = runtime.serializeMonitorEnvelopeV1(envelope);
  env.gm.set(ACTIVE_KEY, raw);
  env.gm.set(BACKUP_KEY, raw);
  return envelope;
}

// Boots the real runtime as lease leader with an EMPTY document (no member
// table), so scanAttemptedForDocument stays false and a later same-document
// `Scan now` scan can still commit. The startup jitter timer is invoked
// synchronously.
function bootLeaderWithoutScan(options = {}) {
  const env = createRuntimeBootShim();
  if (options.webhook !== false) {
    env.gm.set(WEBHOOK_KEY, WEBHOOK);
  }
  const booted = freshRuntime();
  env.run(() => booted.startBrowserRuntime());
  const jitter = env.findTimer((timer) => timer.delayMs < 1000);
  assert.ok(jitter, 'startup acquisition jitter timer must be scheduled');
  env.run(() => env.invoke(jitter));
  return { env, booted };
}

// Runs the real `Scan now` menu command against the current document, so a
// genuine accepted scan executes. Every timer created by the scan (including
// the immediate flush) is captured.
function runDocumentScan(env) {
  invokeMenu(env, 'Scan now');
}

function invokeMenu(env, label) {
  const callback = env.menu.get(label);
  assert.equal(typeof callback, 'function', `menu command ${label} must be registered`);
  return env.run(() => callback());
}

function dispatchedPlayerIds(env) {
  const text = env.requests.map((request) => request.data).join('\n');
  return [...new Set((text.match(/\/profile\/(\d+)/gu) || []).map((token) => token.split('/').pop()))];
}

test('a successful durable commit with pending work schedules exactly one zero-delay flush and dispatches it', () => {
  const { env } = bootLeaderWithoutScan();
  try {
    // Pre-existing durable pending work plus a fresh detected delta: the
    // committed envelope has pending work, so one immediate flush is requested.
    seedBaselineEnvelope(env, { pending: [queuedAttackEvent('303', 2)] });
    env.setTable([shimRow('101', 'Player 101', 3)]);
    runDocumentScan(env);

    assert.equal(env.hooks.extraction, 1, 'the real scan path must run exactly once');
    assert.equal(env.requests.length, 0, 'no request may start during the synchronous scan');
    assert.equal(env.zeroDelayTimers().length, 1, 'exactly one immediate zero-delay flush must be scheduled');
    assert.ok(env.findTimer((timer) => timer.delayMs === WATCHDOG_MS), 'the 30-second watchdog must remain scheduled before the immediate request');

    env.run(() => env.invoke(env.zeroDelayTimers()[0]));

    assert.equal(env.requests.length, 1, 'the immediate callback must dispatch the durable pending queue exactly once');
    assert.deepEqual(dispatchedPlayerIds(env).sort(), ['101', '303'], 'the single request must carry both the fresh delta and the pre-existing pending work');
    assert.equal(env.zeroDelayTimers().length, 0, 'the immediate timer id must be cleared before flushing');
    assert.ok(env.findTimer((timer) => timer.delayMs === WATCHDOG_MS), 'the immediate flush must not cancel or replace the 30-second watchdog');
  } finally { env.restore(); }
});

test('a successful durable commit with pending work but no webhook schedules no immediate flush and keeps the queue pending', () => {
  const { env } = bootLeaderWithoutScan({ webhook: false });
  try {
    seedBaselineEnvelope(env);
    env.setTable([shimRow('101', 'Player 101', 3)]);
    runDocumentScan(env);

    assert.equal(env.hooks.extraction, 1, 'the real scan path must run exactly once');
    assert.equal(env.zeroDelayTimers().length, 0, 'an install with no webhook must not schedule a zero-delay flush');
    assert.equal(env.requests.length, 0, 'an install with no webhook must never send');
    const persisted = JSON.parse(env.gm.get(ACTIVE_KEY));
    assert.equal(persisted.pending.length, 1, 'the detected attack must stay pending (recoverable) when no webhook is configured');
    assert.equal(persisted.inFlight.length, 0, 'the immediate path must not promote pending work to inFlight without a send');
    assert.equal(persisted.failed.length, 0, 'no record may be misclassified as failed');
    assert.ok(env.findTimer((timer) => timer.delayMs === WATCHDOG_MS), 'the 30-second watchdog must remain scheduled');
  } finally { env.restore(); }
});

test('watchdog leaves unwired detections pending until a webhook is configured', () => {
  const { env } = bootLeaderWithoutScan({ webhook: false });
  try {
    // Given one detected attack committed without a webhook.
    seedBaselineEnvelope(env);
    env.setTable([shimRow('101', 'Player 101', 3)]);
    runDocumentScan(env);
    const pendingBefore = JSON.parse(env.gm.get(ACTIVE_KEY)).pending;
    const watchdog = env.findTimer((timer) => timer.delayMs === WATCHDOG_MS);
    // When the 30-second watchdog fires without a configured webhook.
    env.run(() => env.invoke(watchdog));
    const queued = JSON.parse(env.gm.get(ACTIVE_KEY));
    // Then the work stays pending, no request occurs, and the watchdog reschedules.
    assert.equal(env.hooks.flush, 0, 'the lease-owning watchdog must stop before transport without a webhook');
    assert.deepEqual(queued.pending, pendingBefore);
    assert.equal(queued.inFlight.length, 0);
    assert.equal(env.requests.length, 0);
    assert.ok(env.findTimer((timer) => timer.delayMs === WATCHDOG_MS));

    // Given a valid webhook configured after the watchdog tick.
    env.gm.set(WEBHOOK_KEY, WEBHOOK);
    // When the subsequent scheduled watchdog flushes.
    env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs === WATCHDOG_MS)));
    // Then one request delivers and acknowledges the record once.
    const delivered = JSON.parse(env.gm.get(ACTIVE_KEY));
    assert.equal(env.requests.length, 1);
    assert.equal(delivered.pending.length, 0);
    assert.equal(delivered.inFlight.length, 0);
    assert.equal(delivered.metrics.deliveryAccounting.terminal.length, 1);
  } finally { env.restore(); }
});

test('repeated enqueue requests before the callback runs still execute exactly one flush', () => {
  const { env } = bootLeaderWithoutScan();
  try {
    // Observed counts equal the baseline, so the scan commit itself leaves an
    // empty pending queue; the successful operator requeues are the only
    // durable enqueue requests and must coalesce to one zero-delay flush.
    seedBaselineEnvelope(env, {
      baselineByPlayerId: { '101': { name: 'Player 101', url: `https://${HOST}/profile/101`, attackCount: 3, raidCount: 0 } },
      failed: [queuedAttackEvent('202', 2)],
      uncertain: [queuedAttackEvent('404', 1)],
    });
    env.setTable([shimRow('101', 'Player 101', 3)]);
    runDocumentScan(env);
    assert.equal(env.zeroDelayTimers().length, 0, 'an empty scan commit schedules no immediate flush');

    invokeMenu(env, 'Retry failed Discord batches');
    assert.match(env.alerts[env.alerts.length - 1], /requeued/u, 'the operator requeue must succeed');
    assert.equal(env.zeroDelayTimers().length, 1, 'a successful operator requeue must request exactly one immediate flush');

    invokeMenu(env, 'Retry uncertain Discord batches');
    assert.match(env.alerts[env.alerts.length - 1], /requeued/u, 'the uncertain requeue must succeed');
    assert.equal(env.zeroDelayTimers().length, 1, 'a second enqueue must reuse the pending zero-delay timer');

    env.run(() => env.invoke(env.zeroDelayTimers()[0]));
    assert.equal(env.requests.length, 1, 'both durable triggers must drain in a single request');
    assert.deepEqual(dispatchedPlayerIds(env).sort(), ['202', '404'], 'both requeued batches must drain in that single request');
  } finally { env.restore(); }
});

test('a failed durable commit schedules no immediate flush', () => {
  const { env } = bootLeaderWithoutScan();
  try {
    seedBaselineEnvelope(env);
    env.setTable([shimRow('101', 'Player 101', 3)]);
    env.failNextWrite(BACKUP_KEY);
    runDocumentScan(env);
    assert.equal(env.zeroDelayTimers().length, 0, 'a blocked commit must not schedule a zero-delay flush');
    assert.equal(env.requests.length, 0, 'a blocked commit must never send');
  } finally { env.restore(); }
});

test('parser rejection and an empty pending queue schedule no immediate flush', () => {
  {
    const { env } = bootLeaderWithoutScan();
    try {
      seedBaselineEnvelope(env);
      env.setTable([shimRow('101', 'Player 101'), shimRow('101', 'Duplicate 101')]);
      runDocumentScan(env);
      assert.equal(env.hooks.extraction, 1, 'the rejected scan path must still run');
      assert.equal(env.zeroDelayTimers().length, 0, 'a rejected parse must not schedule a flush');
      assert.equal(env.requests.length, 0, 'a rejected parse must never send');
    } finally { env.restore(); }
  }
  {
    const { env } = bootLeaderWithoutScan();
    try {
      // Observed counts equal the baseline: the commit succeeds with no pending
      // work, so no immediate flush is requested.
      seedBaselineEnvelope(env, {
        baselineByPlayerId: { '101': { name: 'Player 101', url: `https://${HOST}/profile/101`, attackCount: 3, raidCount: 0 } },
      });
      env.setTable([shimRow('101', 'Player 101', 3)]);
      runDocumentScan(env);
      assert.equal(env.zeroDelayTimers().length, 0, 'an empty pending queue must not schedule a flush');
      assert.equal(env.requests.length, 0, 'an empty pending queue must never send');
    } finally { env.restore(); }
  }
});

test('a lease lost before the immediate callback runs dispatches nothing', () => {
  const { env } = bootLeaderWithoutScan();
  try {
    seedBaselineEnvelope(env);
    env.setTable([shimRow('101', 'Player 101', 3)]);
    runDocumentScan(env);
    assert.equal(env.zeroDelayTimers().length, 1, 'the scan commit schedules one immediate flush');

    env.localStorage.removeItem(LEASE_KEY);
    env.run(() => env.invoke(env.zeroDelayTimers()[0]));

    assert.equal(env.requests.length, 0, 'a fenced/lease-lost callback must never send');
  } finally { env.restore(); }
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
