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
