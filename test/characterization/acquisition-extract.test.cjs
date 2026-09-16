'use strict';

// Characterization: acquisition extraction (plan Todo 16).
//
// Pins the exact runtime-api.acquisition behavior BEFORE extraction
// (differential against src/runtime.js) and verifies the same contract AFTER:
// the full 8-symbol acquisition kernel lives in src/acquisition-impl.js behind
// the Todo 7 adapter seam, with the lifecycle controller in src/lifecycle.js
// wired as the single owner of mutable lifecycle state (this module keeps
// none). src/acquisition.js preserves all 8 symbols by reference and loads
// even when the runtime authority is blocked. Fails while the extracted
// module is missing; passes only when the 8 kernel symbols, the jitter/scan/
// drain behavior, the lifecycle orchestration matrix, the storage-adapter
// seam, and the facade contract all match.
//
// Host strategy: no browser globals are touched. The storage adapter runs
// against explicit get/set fakes or the injected Todo 7 keyValue seam; the
// no-store stub path matches the authority's Node-observable behavior
// (get -> undefined, set/delete -> 'GM storage unavailable' throw).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const runtimeApi = require(path.join(SRC, 'runtime-api.js'));
const impl = require(path.join(SRC, 'acquisition-impl.js'));
const acquisition = require(path.join(SRC, 'acquisition.js'));

const ACQUISITION_CONTRACT = [
  'getStartupAcquisitionJitterMs', 'createDocumentScanState',
  'shouldAttemptDocumentScan', 'markDocumentScanAttempted',
  'resetDocumentScanState', 'runAttackLifecycleForDocument',
  'monitorStorageAdapter', 'shouldKeepWaitingForDrain',
];

const LIFECYCLE_SINGLETONS = [
  'previousState', 'lastScanAtMs', 'nextReloadAtMs', 'tabLeaseActive',
  'tabLeaseBestEffort', 'tabLeaseToken', 'tabLeaseGeneration', 'tabLeaseTerm',
  'activeLeaseOwnerId', 'lifecycleEpoch', 'readinessObserver',
  'readinessStartedAtMono', 'visibilityDriftState', 'readinessTimerId',
  'scanDeadlineTimerId', 'scanCycleId', 'scheduledReloadTimerId',
  'flushTimerId', 'followerWatchdogTimerId', 'followerWatchdogCheck',
  'lifecycleTimerIds', 'cancelPanelAsyncWork', 'panelRuntimeTimerId',
];

function memoryKeyValue() {
  const map = new Map();
  return {
    getValue: (key, fallback) => (map.has(String(key)) ? map.get(String(key)) : fallback),
    setValue: (key, value) => { map.set(String(key), value); },
    deleteValue: (key) => { map.delete(String(key)); },
    _map: map,
  };
}

function memoryGetSet() {
  const map = new Map();
  return {
    get: (key) => (map.has(String(key)) ? map.get(String(key)) : undefined),
    set: (key, value) => { map.set(String(key), value); },
    delete: (key) => { map.delete(String(key)); },
    _map: map,
  };
}

function normalizeOutcome(record) {
  const copy = { ...record };
  if (copy.error instanceof Error) copy.error = `Error: ${copy.error.message}`;
  return copy;
}

async function bothLifecycle(options) {
  const left = normalizeOutcome(await runtime.runAttackLifecycleForDocument(options));
  const right = normalizeOutcome(await impl.runAttackLifecycleForDocument(options));
  return [left, right];
}

test('acquisition exposes the exact 8-symbol contract by reference', () => {
  assert.deepEqual(Object.keys(runtimeApi.acquisition).sort(), [...ACQUISITION_CONTRACT].sort());
  assert.deepEqual(Object.keys(acquisition).sort(), [...ACQUISITION_CONTRACT].sort());
  for (const name of ACQUISITION_CONTRACT) {
    assert.equal(acquisition[name], impl[name], `${name} must re-export acquisition-impl without duplicate logic`);
    assert.equal(typeof acquisition[name], typeof runtime[name], `${name} type differs from the runtime authority`);
  }
});

test('startup jitter clamps and scales exactly like the authority', () => {
  for (const value of [0, 0.25, 0.5, 0.75, 1, -0.5, 2, NaN, Infinity, undefined, null, '0.5', {}]) {
    assert.equal(impl.getStartupAcquisitionJitterMs(value), runtime.getStartupAcquisitionJitterMs(value), `jitter(${String(value)})`);
  }
  assert.equal(impl.getStartupAcquisitionJitterMs(0), 25);
  assert.equal(impl.getStartupAcquisitionJitterMs(1), 250);
  assert.equal(impl.getStartupAcquisitionJitterMs(0.5), 137);
});

test('document scan state is a pure value kernel with stable references', () => {
  const fresh = impl.createDocumentScanState();
  assert.deepEqual(fresh, runtime.createDocumentScanState());
  assert.equal(impl.shouldAttemptDocumentScan(fresh), true);
  assert.equal(impl.shouldAttemptDocumentScan(null), true);
  assert.equal(impl.shouldAttemptDocumentScan({}), true);
  const marked = impl.markDocumentScanAttempted(fresh);
  assert.deepEqual(marked, { scanAttemptedForDocument: true });
  assert.deepEqual(fresh, { scanAttemptedForDocument: false });
  assert.equal(impl.shouldAttemptDocumentScan(marked), false);
  assert.equal(impl.markDocumentScanAttempted(marked), marked);
  assert.deepEqual(impl.resetDocumentScanState(), runtime.resetDocumentScanState());
  assert.deepEqual(impl.resetDocumentScanState(), { scanAttemptedForDocument: false });
});

test('lifecycle orchestration matches the authority across the callback matrix', async () => {
  const authoritative = { status: 'authoritative', attacks: 2 };
  const draft = { status: 'draft' };
  const calls = [];
  const hook = (name, behavior) => async (...args) => {
    calls.push([name, ...args]);
    if (behavior === 'throw') throw new Error(`${name}-boom`);
    return behavior === 'snapshot' ? authoritative : `${name}-ok`;
  };

  let [left, right] = await bothLifecycle({});
  assert.deepEqual(right, left);
  assert.deepEqual(right, { outcome: 'scan-missing', events: [] });

  [left, right] = await bothLifecycle({ scan: async () => { throw new Error('scan-boom'); } });
  assert.deepEqual(right, left);
  assert.equal(right.outcome, 'scan-failed');
  assert.deepEqual(right.events, []);
  assert.equal(right.error, 'Error: scan-boom');

  [left, right] = await bothLifecycle({
    scan: async () => draft,
    flush: hook('flush'), reload: hook('reload'), lease: hook('lease'),
  });
  assert.deepEqual(right, left);
  assert.deepEqual(right, { outcome: 'complete', snapshot: draft, events: ['scan', 'flush', 'reload', 'lease'] });

  [left, right] = await bothLifecycle({
    scan: async () => authoritative,
    commit: hook('commit'), flush: hook('flush', 'throw'), reload: hook('reload'), lease: hook('lease'),
  });
  assert.deepEqual(right, left);
  assert.deepEqual(right.events, ['scan', 'commit', 'flush-failed', 'reload', 'lease']);

  [left, right] = await bothLifecycle({
    scan: async () => { throw new Error('late-scan-boom'); },
    flush: hook('flush'), reload: hook('reload', 'throw'), lease: 'not-a-function',
  });
  assert.deepEqual(right, left);
  assert.equal(right.outcome, 'scan-failed');
  assert.deepEqual(right.events, ['flush', 'reload-failed']);
  assert.ok(calls.length > 0);
});

test('storage adapter passes get/set stores through and stubs the host path', () => {
  const store = memoryGetSet();
  assert.equal(impl.monitorStorageAdapter(store), store);
  assert.equal(runtime.monitorStorageAdapter(store), store);
  store.set('k', 'v');
  assert.equal(impl.monitorStorageAdapter(store).get('k'), 'v');

  for (const empty of [undefined, null, {}, { get: () => 1 }]) {
    const mine = impl.monitorStorageAdapter(empty);
    const theirs = runtime.monitorStorageAdapter(empty);
    assert.equal(mine.get('missing'), theirs.get('missing'));
    assert.equal(mine.get('missing'), undefined);
    assert.throws(() => mine.set('k', 'v'), /GM storage unavailable/);
    assert.throws(() => theirs.set('k', 'v'), /GM storage unavailable/);
    assert.throws(() => mine.delete('k'), /GM storage unavailable/);
    assert.throws(() => theirs.delete('k'), /GM storage unavailable/);
  }
});

test('storage adapter delegates to the injected keyValue seam', () => {
  impl.configureAcquisitionAdapters({ keyValue: null });
  assert.deepEqual(impl.configureAcquisitionAdapters({ keyValue: memoryKeyValue() }), { keyValue: true });
  const seamAdapter = impl.monitorStorageAdapter(undefined);
  seamAdapter.set('seam-key', 'seam-value');
  assert.equal(seamAdapter.get('seam-key'), 'seam-value');
  seamAdapter.delete('seam-key');
  assert.equal(seamAdapter.get('seam-key'), undefined);
  impl.resetAcquisitionAdapters();
  const stub = impl.monitorStorageAdapter(undefined);
  assert.equal(stub.get('seam-key'), undefined);
  assert.throws(() => stub.set('seam-key', 'x'), /GM storage unavailable/);
  const raw = memoryKeyValue();
  impl.configureAcquisitionAdapters({ keyValue: raw });
  assert.ok(impl.acquisitionKeyValue());
  const viaSeam = impl.monitorStorageAdapter(undefined);
  viaSeam.set('k2', 'v2');
  assert.equal(raw.getValue('k2', null), 'v2');
  impl.resetAcquisitionAdapters();
  assert.equal(impl.acquisitionKeyValue(), null);
});

test('drain wait predicate matches the authority across the gate matrix', () => {
  const cases = [
    [false, 0, 100], [false, 10, 50], [true, 10, 50], [true, 49, 50],
    [true, 50, 50], [true, 60, 50], [true, -1, 50], [true, 10, 0],
    [true, 10, -5], [true, NaN, 50], [true, 10, NaN], [true, 10, Infinity],
    [true, Infinity, 100], [0, 10, 50], ['', 10, 50], [true, '10', 50],
  ];
  for (const args of cases) {
    assert.equal(impl.shouldKeepWaitingForDrain(...args), runtime.shouldKeepWaitingForDrain(...args), `drain(${args.map(String).join(',')})`);
  }
  assert.equal(impl.shouldKeepWaitingForDrain(true, 10, 50), true);
  assert.equal(impl.shouldKeepWaitingForDrain(false, 10, 50), false);
  assert.equal(impl.shouldKeepWaitingForDrain(true, 50, 50), false);
});

test('lifecycle controller is the single owner of mutable lifecycle state', () => {
  const source = fs.readFileSync(path.join(SRC, 'acquisition-impl.js'), 'utf8');
  for (const name of LIFECYCLE_SINGLETONS) {
    const matches = source.match(new RegExp(`(?:let|const)\\s+${name}(?![A-Za-z0-9_$])`, 'g'));
    assert.equal(matches ? matches.length : 0, 0, `acquisition-impl.js must not retain a copy of ${name}`);
  }
  const lifecycle = require(path.join(SRC, 'lifecycle.js'));
  const controller = lifecycle.createLifecycleController({
    storage: null, clock: null, sleep: null, gmRequest: null, docLoc: null, webLocks: null, sessionStore: null,
  });
  impl.resetAcquisitionLifecycle();
  assert.equal(impl.acquisitionLifecycle(), null);
  assert.deepEqual(impl.configureAcquisitionLifecycle(controller), { lifecycle: true });
  assert.equal(impl.acquisitionLifecycle(), controller);
  assert.deepEqual(impl.configureAcquisitionLifecycle(null), { lifecycle: false });
  assert.equal(impl.acquisitionLifecycle(), null);
  impl.resetAcquisitionLifecycle();
});
