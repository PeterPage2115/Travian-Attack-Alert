'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const impl = require(path.join(SRC, 'lease-impl.js'));
const lease = require(path.join(SRC, 'lease.js'));

const WORLD = 'S1.Example.COM';
const KEY = 'travianAllianceTabLease_v1';
const T0 = 1700000000000;
const CONTRACT = [
  'parseLease', 'classifyLease', 'isLeaseActive', 'createTabOwnerId',
  'getOrCreateTabOwnerId', 'createLeaseToken', 'loadLease',
  'loadLeaseRecord', 'saveLease', 'acquireLease', 'renewLease',
  'releaseLease', 'isLeaseFenceValid', 'checkLifecycleFence',
  'isLifecycleFenceValid', 'lockNameForHostname', 'hasExclusiveWebLocks',
];

function memoryStore(seed) {
  const values = new Map(Object.entries(seed || {}));
  return {
    values,
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => { values.set(String(key), String(value)); },
    removeItem: (key) => { values.delete(String(key)); },
  };
}

function configure(store, options) {
  const source = options || {};
  let uuidIndex = 0;
  impl.configureLeaseAdapters({
    keyValue: store,
    session: source.session || memoryStore(),
    clock: { nowFn: () => T0, monotonicFn: () => T0 },
    webLocks: { request: async (name, task) => task({ name }) },
    nodeEnvironment: source.nodeEnvironment !== false,
    randomUuid: () => `uuid-${++uuidIndex}`,
    random: () => 0.25,
  });
}

function installRuntimeStore(store) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = globalThis.localStorage;
  globalThis.localStorage = store;
  return () => { if (had) globalThis.localStorage = previous; else delete globalThis.localStorage; };
}

test.afterEach(() => { impl.resetLeaseAdapters(); });

test('lease source exposes exactly the 17-symbol contract without runtime-api', () => {
  assert.deepEqual(Object.keys(lease).sort(), [...CONTRACT].sort());
  assert.equal(Object.keys(lease).length, 17);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'lease.js'), 'utf8'), /runtime-api/u);
});

test('lease constants stay byte-for-byte frozen', () => {
  assert.deepEqual(impl.LEASE_CONSTANTS, {
    TAB_LEASE_STORAGE_KEY: KEY,
    TAB_LEASE_TTL_MS: 120000,
    TAB_LEASE_RENEW_MS: 30000,
    TAB_LEASE_RETRY_MS: 10000,
  });
});

test('lease parsing preserves owner/expiry and record fencing fields', () => {
  const raw = { ownerId: ' owner-1 ', expiresAtMs: T0 + 1, token: ' tok ', generation: 4, term: 7 };
  assert.deepEqual(impl.parseLease(raw), runtime.parseLease(raw));
  assert.deepEqual(impl.parseLeaseRecord(raw), { ownerId: 'owner-1', expiresAtMs: T0 + 1, token: 'tok', generation: 4, term: 7 });
  for (const invalid of [null, [], {}, { ownerId: ' ', expiresAtMs: 1 }, { ownerId: 'x', expiresAtMs: Infinity }]) {
    assert.equal(impl.parseLease(invalid), runtime.parseLease(invalid));
  }
});

test('classification pins none, own, foreign, and expired term outcomes', () => {
  const own = { ownerId: 'owner-1', expiresAtMs: T0 + 1 };
  assert.equal(impl.classifyLease(null, 'owner-1', T0), 'none');
  assert.equal(impl.classifyLease(own, 'owner-1', T0), 'own');
  assert.equal(impl.classifyLease(own, 'owner-2', T0), 'foreign');
  assert.equal(impl.classifyLease(own, 'owner-1', T0 + 1), 'expired');
});

test('active lease is true only for the unexpired owner', () => {
  const record = { ownerId: 'owner-1', expiresAtMs: T0 + 10 };
  assert.equal(impl.isLeaseActive(record, 'owner-1', T0), true);
  assert.equal(impl.isLeaseActive(record, 'owner-2', T0), false);
  assert.equal(impl.isLeaseActive(record, 'owner-1', T0 + 10), false);
});

test('stale generation, term, or owner fails the lease fence', () => {
  const expected = { ownerId: 'owner-1', generation: 3, term: 5 };
  assert.equal(impl.isLeaseFenceValid({ ...expected }, expected), true);
  assert.equal(impl.isLeaseFenceValid({ ...expected, generation: 2 }, expected), false);
  assert.equal(impl.isLeaseFenceValid({ ...expected, term: 4 }, expected), false);
  assert.equal(impl.isLeaseFenceValid({ ...expected, ownerId: 'owner-2' }, expected), false);
});

test('lifecycle token fence preserves exact outcomes', () => {
  assert.deepEqual(impl.checkLifecycleFence(true, 'tok', 'tok'), runtime.checkLifecycleFence(true, 'tok', 'tok'));
  assert.deepEqual(impl.checkLifecycleFence(false, 'tok', 'tok'), { outcome: 'fenced-reject' });
  assert.equal(impl.isLifecycleFenceValid(true, 'tok', 'tok'), true);
  assert.equal(impl.isLifecycleFenceValid(true, 'old', 'new'), false);
});

test('hostname lock naming remains identical', () => {
  for (const hostname of ['S1.Example.COM...', '  ', '', 'ż.example']) {
    assert.equal(impl.lockNameForHostname(hostname), runtime.lockNameForHostname(hostname));
  }
});

test('unavailable Web Locks fail capability detection and requests closed', () => {
  impl.configureLeaseAdapters({ webLocks: null, nodeEnvironment: false });
  assert.equal(impl.hasExclusiveWebLocks(), false);
  assert.throws(() => impl.requestExclusiveLock(WORLD, async () => true), /unavailable/u);
});

test('exclusive Web Locks use the normalized hostname and hold task', async () => {
  const calls = [];
  impl.configureLeaseAdapters({
    webLocks: { request: async (name, task) => { calls.push(name); return task(); } },
    nodeEnvironment: false,
  });
  assert.equal(impl.hasExclusiveWebLocks(), true);
  assert.equal(await impl.requestExclusiveLock(WORLD, async () => 'held'), 'held');
  assert.deepEqual(calls, ['taa-monitor:s1.example.com']);
});

test('owner identity is reused per session and tokens retain owner prefix', () => {
  const store = memoryStore(); configure(memoryStore(), { session: store });
  const first = impl.getOrCreateTabOwnerId();
  assert.equal(first, 'uuid-1');
  assert.equal(impl.getOrCreateTabOwnerId(), first);
  assert.match(impl.createLeaseToken(), /^uuid-2:/u);
});

test('load/save roundtrip normalizes host and preserves unrelated worlds', () => {
  const store = memoryStore({ [KEY]: JSON.stringify({ other: { ownerId: 'other', expiresAtMs: T0 + 9 } }) });
  configure(store);
  const record = { ownerId: 'owner-1', expiresAtMs: T0 + 5, token: 't', generation: 2, term: 3 };
  assert.equal(impl.saveLease(WORLD, record), true);
  assert.deepEqual(impl.loadLeaseRecord('s1.example.com'), record);
  assert.deepEqual(impl.loadLease(WORLD), { ownerId: 'owner-1', expiresAtMs: T0 + 5 });
  assert.equal(JSON.parse(store.values.get(KEY)).other.ownerId, 'other');
});

test('acquire returns null when persistence or authority is unavailable', () => {
  impl.configureLeaseAdapters({ keyValue: null, webLocks: null, nodeEnvironment: false });
  assert.equal(impl.acquireLease(WORLD, 'owner-1', T0), null);
});

test('foreign owner acquisition refuses without mutation', () => {
  const initial = JSON.stringify({ 's1.example.com': { ownerId: 'owner-1', expiresAtMs: T0 + 9, token: 't', generation: 2, term: 3 } });
  const store = memoryStore({ [KEY]: initial }); configure(store);
  assert.equal(impl.acquireLease(WORLD, 'owner-2', T0), false);
  assert.equal(store.values.get(KEY), initial);
});

test('expired acquisition increments generation and term with a new token', () => {
  const store = memoryStore({ [KEY]: JSON.stringify({ 's1.example.com': { ownerId: 'old', expiresAtMs: T0, token: 'old', generation: 8, term: 5 } }) });
  configure(store);
  assert.equal(impl.acquireLease(WORLD, 'owner-2', T0), true);
  assert.deepEqual(impl.loadLeaseRecord(WORLD), { ownerId: 'owner-2', expiresAtMs: T0 + 120000, token: `uuid-1:${T0.toString(36)}`, generation: 9, term: 6 });
});

test('renew preserves token, generation, and term while rejecting stale token', () => {
  const store = memoryStore(); configure(store);
  assert.equal(impl.acquireLease(WORLD, 'owner-1', T0), true);
  const before = impl.loadLeaseRecord(WORLD);
  assert.equal(impl.renewLease(WORLD, 'owner-1', T0 + 10, 'stale'), false);
  assert.equal(impl.renewLease(WORLD, 'owner-1', T0 + 10, before.token), true);
  assert.deepEqual(impl.loadLeaseRecord(WORLD), { ...before, expiresAtMs: T0 + 120010 });
});

test('wrong owner or term cannot release, while the acquired term deletes', () => {
  const runtimeStore = memoryStore(); const restore = installRuntimeStore(runtimeStore);
  const moduleStore = memoryStore(); configure(moduleStore);
  try {
    assert.equal(runtime.acquireLease(WORLD, 'owner-1', T0), true);
    assert.equal(impl.acquireLease(WORLD, 'owner-1', T0), true);
    const runtimeRecord = runtime.loadLeaseRecord(WORLD);
    const moduleRecord = impl.loadLeaseRecord(WORLD);
    assert.equal(impl.releaseLease(WORLD, 'owner-2', T0 + 1, moduleRecord.term), false);
    assert.equal(impl.releaseLease(WORLD, 'owner-1', T0 + 1, 999), false);
    assert.equal(runtime.releaseLease(WORLD, 'owner-1', T0 + 1, runtimeRecord.term), true);
    assert.equal(impl.releaseLease(WORLD, 'owner-1', T0 + 1, moduleRecord.term), true);
    assert.equal(impl.loadLeaseRecord(WORLD), null);
    assert.equal(runtime.loadLeaseRecord(WORLD), null);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// Same-document lease reacquisition around the first authoritative scan.
//
// These boot the real src/runtime.js browser branch in a Node shim
// (document/location/navigator.locks/MutationObserver/memory storage plus a
// captured-timer scheduler) so the genuine readiness + lease state machine
// runs without a browser. The shim exposes only observables the product
// already publishes: the lease-state dataset, lifecycle test hooks, the
// diagnostics store, and the readiness observers it creates.
// ---------------------------------------------------------------------------

const HOST = 's1.example.com';
const realSetTimeout = globalThis.setTimeout;
const SHIM_GLOBALS = [
  'document', 'location', 'navigator', 'window', 'localStorage', 'sessionStorage',
  'MutationObserver', 'GM_getValue', 'GM_setValue', 'GM_deleteValue',
  'GM_registerMenuCommand', 'setTimeout', 'clearTimeout',
];

function delay(ms) { return new Promise((resolve) => realSetTimeout(resolve, ms)); }

function shimElement(tag) {
  return {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    className: '',
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); return child; },
    addEventListener() {},
    click() {},
    classList: { contains: () => false },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function shimRow(playerId, name) {
  const row = shimElement('tr');
  const link = shimElement('a');
  link.setAttribute('href', `/profile/${playerId}`);
  link.textContent = name;
  row.querySelectorAll = (selector) => (selector === 'a' ? [link] : []);
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
  const hooks = { readiness: 0, extraction: 0, snapshots: [], leaseAcquired: [], standby: [] };
  const observers = [];
  const timers = [];
  const realClear = globalThis.clearTimeout;
  let capturing = false;

  class ShimMutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.active = true; this.target = target; this.options = options; }
    disconnect() { this.active = false; this.disconnected = true; }
  }

  const body = shimElement('body');
  const doc = {
    readyState: 'complete',
    location: { origin: `https://${HOST}` },
    documentElement: shimElement('html'),
    body,
    hidden: false,
    tables: [],
    querySelectorAll(selector) { return selector === 'table' ? doc.tables : []; },
    querySelector: () => null,
    getElementById: (id) => (id === 'taa-open-panel' || id === 'taa-panel-overlay' || id === 'taa-panel-style' ? shimElement('div') : null),
    createElement: (tag) => shimElement(tag),
    addEventListener() {},
  };
  const loc = { href: `https://${HOST}/alliance/profile/members`, hostname: HOST, origin: `https://${HOST}`, reload() { throw new Error('unexpected reload'); } };
  const nav = { locks: { request: async (name, options, task) => task({ name }) } };
  const win = {
    addEventListener() {},
    __TAA_TEST_HOOK__: {
      onReadinessCommit: () => { hooks.readiness += 1; },
      onExtractionStart: () => { hooks.extraction += 1; },
      onSnapshot: (snapshot) => { hooks.snapshots.push(snapshot.status); },
      onLeaseAcquired: (payload) => { hooks.leaseAcquired.push(payload); },
      onStandby: (payload) => { hooks.standby.push(payload); },
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
  define('GM_registerMenuCommand', () => {});
  define('setTimeout', (fn, delayMs, ...args) => {
    const handle = realSetTimeout(fn, delayMs, ...args);
    if (capturing) timers.push({ handle, fn, delayMs, args, cleared: false });
    return handle;
  });
  define('clearTimeout', (handle) => {
    for (const timer of timers) if (timer.handle === handle) timer.cleared = true;
    return realClear(handle);
  });

  return {
    localStorage,
    hooks,
    observers,
    timers,
    body,
    run(fn) { capturing = true; try { return fn(); } finally { capturing = false; } },
    invoke(timer) {
      assert.ok(timer, 'expected a captured runtime timer');
      for (const entry of timers) if (entry.handle === timer.handle) entry.cleared = true;
      realClear(timer.handle);
      timer.fn(...timer.args);
    },
    findTimer(predicate) { return timers.find((timer) => !timer.cleared && predicate(timer)); },
    setTable(rows) { doc.tables = rows === null ? [] : [shimTable(rows)]; },
    trigger() { for (const observer of observers) if (observer.active) observer.callback([], observer); },
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

// Boots one leader document and runs the startup jitter timer synchronously.
function bootLeaderDocument(options = {}) {
  const env = createRuntimeBootShim();
  if (Array.isArray(options.table)) env.setTable(options.table);
  const booted = freshRuntime();
  env.run(() => booted.startBrowserRuntime());
  env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs < 1000)));
  return { env, booted };
}

function diagnosticsText(env) {
  return String(env.localStorage.getItem('travianAllianceDiagnostics_v2') || '');
}

async function waitForPreScanLeaseTerminal(env, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/lease-lost-before-scan/u.test(diagnosticsText(env))) return true;
    await delay(50);
  }
  return /lease-lost-before-scan/u.test(diagnosticsText(env));
}

// The product reschedules readiness from a quiet-window remainder, so a clock
// tick between the mutation and the schedule can fire the check one tick early
// and let it return without rescheduling. Waiting past the quiet window and
// invoking the captured check timer settles that window deterministically.
async function driveReadinessCheck(env) {
  await delay(600);
  const pending = env.findTimer((timer) => timer.delayMs <= 1000);
  if (pending) env.run(() => env.invoke(pending));
}

test('pre-scan lease loss and same-document reacquisition perform exactly one authoritative scan', async () => {
  const { env } = bootLeaderDocument();
  try {
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.hooks.extraction, 0);
    env.run(() => {
      env.localStorage.removeItem(KEY);
      env.setTable([shimRow('101', 'Player 101')]);
      env.trigger();
    });
    await driveReadinessCheck(env);
    assert.equal(await waitForPreScanLeaseTerminal(env, 1000), true, 'the lease-lost-before-scan terminal must be recorded');
    assert.equal(env.hooks.extraction, 0);
    env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs === 30000)));
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.observers.length, 2, 'readiness observer must be reinstalled exactly once');
    assert.equal(env.hooks.extraction, 1, 'reacquisition before the first scan must resume the document scan');
    assert.deepEqual(env.hooks.snapshots, ['authoritative']);
    assert.equal(env.hooks.leaseAcquired.length, 1);
    assert.equal(env.hooks.leaseAcquired[0].sameDocument, true);
  } finally { env.restore(); }
});

test('reacquisition after an accepted scan performs no second scan', async () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.hooks.extraction, 1);
    assert.deepEqual(env.hooks.snapshots, ['authoritative']);
    env.run(() => env.localStorage.removeItem(KEY));
    env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs === 30000)));
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.observers.length, 1, 'accepted-scan terminal must never reset the document scan state');
    assert.equal(env.hooks.extraction, 1);
    assert.deepEqual(env.hooks.snapshots, ['authoritative']);
    assert.equal(env.hooks.leaseAcquired.length, 1);
  } finally { env.restore(); }
});

test('fenced same-document reacquisition cannot reset the pre-scan lease terminal', async () => {
  const { env } = bootLeaderDocument();
  try {
    env.run(() => {
      env.localStorage.removeItem(KEY);
      env.setTable([shimRow('101', 'Player 101')]);
      env.trigger();
    });
    await driveReadinessCheck(env);
    assert.equal(await waitForPreScanLeaseTerminal(env, 1000), true, 'the lease-lost-before-scan terminal must be recorded');
    env.run(() => {
      env.localStorage.setItem(KEY, JSON.stringify({ [HOST]: { ownerId: 'foreign-owner', expiresAtMs: Date.now() + 120000, term: 7, generation: 7, token: 'foreign-token' } }));
      env.invoke(env.findTimer((timer) => timer.delayMs === 30000));
    });
    assert.equal(env.body.dataset.taaLeaseState, 'standby');
    assert.equal(env.observers.length, 1);
    assert.equal(env.hooks.extraction, 0);
    assert.deepEqual(env.hooks.snapshots, []);
    assert.equal(env.hooks.leaseAcquired.length, 0);
    assert.equal(env.hooks.standby.length, 1);
  } finally { env.restore(); }
});

test('repeated pre-scan lease losses resume readiness exactly once per reacquisition', async () => {
  const { env } = bootLeaderDocument();
  try {
    env.run(() => {
      env.localStorage.removeItem(KEY);
      env.setTable([shimRow('101', 'Player 101')]);
      env.trigger();
    });
    await driveReadinessCheck(env);
    assert.equal(await waitForPreScanLeaseTerminal(env, 1000), true, 'the first lease-lost-before-scan terminal must be recorded');
    env.run(() => env.setTable(null));
    env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs === 30000)));
    env.run(() => env.localStorage.removeItem(KEY));
    env.run(() => env.invoke(env.findTimer((timer) => timer.delayMs === 30000)));
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.observers.length, 3, 'each same-document reacquisition must install readiness exactly once');
    env.run(() => {
      env.setTable([shimRow('101', 'Player 101')]);
      env.trigger();
    });
    await driveReadinessCheck(env);
    assert.equal(env.hooks.extraction, 1, 'repeated pre-scan interruptions must still end in exactly one accepted scan');
    assert.deepEqual(env.hooks.snapshots, ['authoritative']);
    assert.equal(env.hooks.leaseAcquired.length, 2);
  } finally { env.restore(); }
});
