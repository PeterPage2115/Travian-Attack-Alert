'use strict';

// Focused characterization suite for the Tampermonkey menu command
// "Clear attack memory" (plan Task 21).
//
// The command must reset ONLY the normalized current world's monitor-envelope
// baseline, through the existing envelope writer, and must run exactly one
// fresh accepted scan in this document. It must never touch another world, the
// delivery queues, configuration, secrets, lease, history, roster, or the
// recovery workflow, and it must fail closed (pre-write failure preserves the
// original bytes; an unverifiable rollback reports baseline-reset-indeterminate
// without a success message and without a rescan).
//
// These tests boot the real src/runtime.js browser branch in a Node shim
// (document/location/navigator.locks/MutationObserver/memory localStorage +
// GM storage + captured-timer scheduler) so the genuine lease/scan/reset state
// machine runs without a browser. Failure injection is storage-only: the shim
// can throw or corrupt the next (or every) GM write for a key.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));

const HOST = 's1.example.com';
const OTHER = 's2.example.com';
const T0 = 1700000000000;

const ACTIVE_KEY = runtime.monitorActiveStorageKey(HOST);
const BACKUP_KEY = runtime.monitorBackupStorageKey(HOST);
const OTHER_ACTIVE_KEY = runtime.monitorActiveStorageKey(OTHER);
const OTHER_BACKUP_KEY = runtime.monitorBackupStorageKey(OTHER);
const LEGACY_KEY = 'travianAllianceIncomingAttacks_v40';
const LEASE_KEY = runtime.TAB_LEASE_STORAGE_KEY;
const WEBHOOK_KEY = 'travianAllianceWebhookUrl_v1';
const DIAGNOSTICS_KEY = 'travianAllianceDiagnostics_v2';

// Every preserved localStorage store except the legacy attack memory itself.
const PRESERVED_LOCAL_KEYS = [
  runtime.MAPPING_STORAGE_KEY,
  runtime.DISCORD_CONFIG_STORAGE_KEY,
  runtime.SETTINGS_STORAGE_KEY,
  'travianAllianceMutedPlayers_v1',
  runtime.PLAYER_NAMES_STORAGE_KEY,
  runtime.ROSTER_STORAGE_KEY,
  runtime.HISTORY_STORAGE_KEY,
  runtime.PENDING_BATCH_STORAGE_KEY,
  runtime.FAILED_BATCH_STORAGE_KEY,
];

// ---------------------------------------------------------------------------
// Browser boot shim (mirrors test/characterization/lease-fence-matrix.test.cjs,
// plus alert capture, menu capture, GM visibility, and GM write-fault seams).
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const SHIM_GLOBALS = [
  'document', 'location', 'navigator', 'window', 'localStorage', 'sessionStorage',
  'MutationObserver', 'GM_getValue', 'GM_setValue', 'GM_deleteValue',
  'GM_registerMenuCommand', 'setTimeout', 'clearTimeout', 'alert',
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
  const menu = new Map();
  const alerts = [];
  const deletes = [];
  const hooks = { readiness: 0, extraction: 0, snapshots: [], leaseAcquired: [], standby: [] };
  const observers = [];
  const timers = [];
  const realClear = globalThis.clearTimeout;
  let capturing = false;
  let writeFault = null;
  let readFault = null;

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
  define('GM_getValue', (key, fallback) => {
    if (readFault && String(key).includes(readFault.keySubstring)) {
      if (readFault.skip > 0) {
        readFault.skip -= 1;
      } else {
        if (readFault.once) readFault = null;
        throw new Error('injected GM read failure');
      }
    }
    return gm.has(key) ? gm.get(key) : fallback;
  });
  define('GM_setValue', (key, value) => {
    if (writeFault && String(key).includes(writeFault.keySubstring)) {
      const fault = writeFault;
      if (fault.once) writeFault = null;
      if (fault.mode === 'throw') throw new Error('injected GM write failure');
      gm.set(key, `${String(value)}corrupt`);
      return;
    }
    gm.set(key, value);
  });
  define('GM_deleteValue', (key) => { deletes.push(String(key)); gm.delete(key); });
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

  return {
    localStorage,
    sessionStorage,
    gm,
    menu,
    alerts,
    deletes,
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
    failNextWrite(keySubstring, mode = 'throw') { writeFault = { keySubstring, mode, once: true }; },
    failEveryWrite(keySubstring, mode = 'throw') { writeFault = { keySubstring, mode, once: false }; },
    clearWriteFault() { writeFault = null; },
    // Fail the next read of a matching key after `skip` successful reads, so a
    // test can let the envelope load read pass and fail the reset's own
    // pre-reset snapshot read.
    failReadAfter(keySubstring, skip = 0) { readFault = { keySubstring, skip, once: true }; },
    clearReadFault() { readFault = null; },
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

function invokeMenu(env, label) {
  const callback = env.menu.get(label);
  assert.equal(typeof callback, 'function', `menu command ${label} must be registered`);
  return env.run(() => callback());
}

function activeRaw(env, key) { return env.gm.get(key); }

function readEnvelope(env, world) {
  const parsed = runtime.parseMonitorEnvelopeV1(env.gm.get(runtime.monitorActiveStorageKey(world)), world);
  assert.equal(parsed.ok, true, `envelope for ${world} must parse`);
  return parsed.envelope;
}

function writeEnvelope(env, world, envelope) {
  const serialized = runtime.serializeMonitorEnvelopeV1(envelope);
  env.gm.set(runtime.monitorActiveStorageKey(world), serialized);
  env.gm.set(runtime.monitorBackupStorageKey(world), serialized);
  return serialized;
}

function seedEnvelope(env, world, baseline, generation) {
  const envelope = runtime.createMonitorEnvelopeV1(world, {
    generation,
    baselineByPlayerId: baseline,
  });
  return { envelope, raw: writeEnvelope(env, world, envelope) };
}

function seedPreservedStores(env) {
  env.localStorage.setItem(LEGACY_KEY, JSON.stringify({ '101': { attackCount: 9 } }));
  env.localStorage.setItem(runtime.MAPPING_STORAGE_KEY, JSON.stringify({ [HOST]: { '101': ['111111111111111111'] }, [OTHER]: { '202': ['222222222222222222'] } }));
  env.localStorage.setItem(runtime.DISCORD_CONFIG_STORAGE_KEY, JSON.stringify({ roleId: '333333333333333333', leaveRoleId: null }));
  env.localStorage.setItem(runtime.SETTINGS_STORAGE_KEY, JSON.stringify({ [HOST]: { attackThreshold: 2, raidThreshold: 1 }, [OTHER]: { attackThreshold: 4, raidThreshold: 2 } }));
  env.localStorage.setItem('travianAllianceMutedPlayers_v1', JSON.stringify({ [HOST]: { '101': true } }));
  env.localStorage.setItem(runtime.PLAYER_NAMES_STORAGE_KEY, JSON.stringify({ [HOST]: { '101': 'Alpha' } }));
  env.localStorage.setItem(runtime.ROSTER_STORAGE_KEY, JSON.stringify({ [HOST]: { '101': { name: 'Player 101', url: `https://${HOST}/profile/101` } }, [OTHER]: { '202': { name: 'Other', url: '/profile/202' } } }));
  env.localStorage.setItem(runtime.HISTORY_STORAGE_KEY, JSON.stringify({ [HOST]: [{ playerId: '101', eventType: 'attack' }], [OTHER]: [{ playerId: '202', eventType: 'raid' }] }));
  env.localStorage.setItem(runtime.PENDING_BATCH_STORAGE_KEY, JSON.stringify({ [OTHER]: { events: [], inFlight: [] } }));
  env.localStorage.setItem(runtime.FAILED_BATCH_STORAGE_KEY, JSON.stringify({ [OTHER]: [] }));
  env.gm.set(WEBHOOK_KEY, 'https://discord.com/api/webhooks/444444444444444444/synthetic-token-value');
}

function preservedLocalBytes(env) {
  return Object.fromEntries(PRESERVED_LOCAL_KEYS.map((key) => [key, env.localStorage.getItem(key)]));
}

function seedQueues(envelope) {
  return runtime.createMonitorEnvelopeV1(envelope.world, Object.assign({}, envelope, {
    pending: [{ world: envelope.world, playerId: '777', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, name: 'Queued', url: '/profile/777' }],
    inFlight: [{ world: envelope.world, playerId: '778', eventType: 'raid', addedAttackCount: 0, addedRaidCount: 2, name: 'InFlight', url: '/profile/778' }],
    failed: [{ world: envelope.world, playerId: '779', eventType: 'attack', addedAttackCount: 3, addedRaidCount: 0, name: 'Failed', url: '/profile/779' }],
    uncertain: [{ world: envelope.world, playerId: '780', eventType: 'mixed', addedAttackCount: 1, addedRaidCount: 1, name: 'Uncertain', url: '/profile/780' }],
    metrics: Object.assign({}, envelope.metrics, {
      deliveryAccounting: Object.assign({}, envelope.metrics.deliveryAccounting, {
        terminal: [{ world: envelope.world, playerId: '781', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, name: 'Terminal', url: '/profile/781' }],
      }),
    }),
  }));
}

function canonical(value) { return runtime.canonicalSerializeMonitorValue(value); }

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

test('clear attack memory resets only the current world baseline and runs one fresh accepted scan', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    assert.equal(env.body.dataset.taaLeaseState, 'leader');
    assert.equal(env.hooks.extraction, 1, 'boot performs the first accepted scan');
    assert.deepEqual(env.hooks.snapshots, ['authoritative']);

    seedPreservedStores(env);
    seedEnvelope(env, OTHER, { '202': { name: 'Other', url: '/profile/202', attackCount: 4, raidCount: 1 } }, 3);
    const otherActiveBefore = activeRaw(env, OTHER_ACTIVE_KEY);
    const otherBackupBefore = activeRaw(env, OTHER_BACKUP_KEY);

    // Overwrite the current world baseline with a stale count, and add live
    // delivery accounting that the reset must preserve.
    const live = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, live);
    const originalGeneration = live.generation;
    const preservedLocalBefore = preservedLocalBytes(env);
    const webhookBefore = env.gm.get(WEBHOOK_KEY);

    invokeMenu(env, 'Clear attack memory');

    // Exactly one fresh accepted scan, not a no-op.
    assert.equal(env.hooks.extraction, 2, 'reset must run exactly one fresh accepted scan');
    assert.deepEqual(env.hooks.snapshots, ['authoritative', 'authoritative']);

    const after = readEnvelope(env, HOST);
    assert.deepEqual(Object.keys(after.baselineByPlayerId), ['101'], 'the fresh scan re-establishes the baseline from the document');
    assert.equal(after.baselineByPlayerId['101'].attackCount, 0, 'the stale baseline count is replaced by the observed count');
    assert.equal(after.generation, originalGeneration + 2, 'one generation for the reset write and one for the fresh scan commit');

    // Delivery accounting preserved byte-for-byte.
    assert.equal(canonical(after.pending), canonical(live.pending));
    assert.equal(canonical(after.inFlight), canonical(live.inFlight));
    assert.equal(canonical(after.failed), canonical(live.failed));
    assert.equal(canonical(after.uncertain), canonical(live.uncertain));
    assert.equal(canonical(after.metrics.deliveryAccounting), canonical(live.metrics.deliveryAccounting));

    // Legacy attack memory cleared, confirmation explicit.
    assert.equal(env.localStorage.getItem(LEGACY_KEY), null, 'legacy attack-memory key is cleared');
    const success = env.alerts[env.alerts.length - 1];
    assert.match(success, /fresh baseline/u);
    assert.match(success, /does not clear site data/u);

    // Every preserved store and the other world are byte-identical.
    assert.deepEqual(preservedLocalBytes(env), preservedLocalBefore, 'preserved localStorage stores must be byte-identical');
    assert.equal(env.gm.get(WEBHOOK_KEY), webhookBefore, 'webhook secret must be byte-identical');
    assert.equal(activeRaw(env, OTHER_ACTIVE_KEY), otherActiveBefore, 'other world active envelope must be byte-identical');
    assert.equal(activeRaw(env, OTHER_BACKUP_KEY), otherBackupBefore, 'other world backup envelope must be byte-identical');
  } finally { env.restore(); }
});

test('clear attack memory leaves the other world diagnostics bucket byte-identical', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedEnvelope(env, OTHER, {}, 1);
    const before = JSON.parse(env.localStorage.getItem(DIAGNOSTICS_KEY) || '{}');
    invokeMenu(env, 'Clear attack memory');
    const after = JSON.parse(env.localStorage.getItem(DIAGNOSTICS_KEY) || '{}');
    assert.deepEqual(after[OTHER], before[OTHER], 'another world diagnostics bucket must not change');
  } finally { env.restore(); }
});

// ---------------------------------------------------------------------------
// Failure paths.
// ---------------------------------------------------------------------------

test('pre-write failure (lease lost) preserves the original envelope and does not rescan', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);
    const extractionBefore = env.hooks.extraction;

    // Revoke the leader lease: the reset must fence before any write.
    env.localStorage.removeItem(LEASE_KEY);
    invokeMenu(env, 'Clear attack memory');

    assert.equal(env.hooks.extraction, extractionBefore, 'a fenced reset must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'active envelope must be unchanged');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'backup envelope must be unchanged');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'a failed reset must not claim success');
    assert.match(alertMessage, /no fresh scan/u);
  } finally { env.restore(); }
});

test('post-write readback failure completes one verified rollback and does not rescan', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);
    const extractionBefore = env.hooks.extraction;

    // One-shot failure on the active envelope write: the writer restores the
    // previous bytes, and the reset's bounded rollback re-verifies them.
    env.failNextWrite(ACTIVE_KEY, 'throw');
    invokeMenu(env, 'Clear attack memory');
    env.clearWriteFault();

    assert.equal(env.hooks.extraction, extractionBefore, 'a rolled-back reset must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'rollback restores the original active bytes');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'rollback restores the original backup bytes');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'a rolled-back reset must not claim success');
    assert.match(alertMessage, /no fresh scan/u);
  } finally { env.restore(); }
});

test('unverifiable rollback reports baseline-reset-indeterminate without success or rescan', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const extractionBefore = env.hooks.extraction;

    // Every active write fails: neither the reset write nor the rollback can be
    // verified, so the command must fail closed with operator recovery guidance.
    env.failEveryWrite(ACTIVE_KEY, 'throw');
    invokeMenu(env, 'Clear attack memory');
    env.clearWriteFault();

    assert.equal(env.hooks.extraction, extractionBefore, 'an indeterminate reset must not start a fresh scan');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.match(alertMessage, /indeterminate|could not be verified/u);
    assert.match(alertMessage, /incident bundle|recovery/u);
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'an indeterminate reset must not claim success');
  } finally { env.restore(); }
});

test('pre-reset active read failure aborts before any reset write and does not rescan', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);
    const extractionBefore = env.hooks.extraction;

    // The envelope load reads the active key once; the pre-reset snapshot read
    // is the second read and fails. A one-shot reset write failure is armed on
    // top: the defect needed BOTH to delete the unread active bytes.
    env.failReadAfter(ACTIVE_KEY, 1);
    env.failNextWrite(ACTIVE_KEY, 'throw');
    invokeMenu(env, 'Clear attack memory');
    env.clearWriteFault();
    env.clearReadFault();

    assert.equal(env.hooks.extraction, extractionBefore, 'an unread pre-reset snapshot must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'the unread active bytes must never be deleted');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'the backup bytes must be unchanged');
    assert.deepEqual(env.deletes.filter((key) => key === ACTIVE_KEY || key === BACKUP_KEY), [], 'no envelope key may be deleted');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.match(alertMessage, /indeterminate|could not be verified/u);
    assert.match(alertMessage, /incident bundle|recovery/u);
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'an aborted reset must not claim success');
  } finally { env.restore(); }
});

test('pre-reset backup read failure aborts before any reset write', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);
    const extractionBefore = env.hooks.extraction;

    env.failReadAfter(BACKUP_KEY, 1);
    env.failNextWrite(ACTIVE_KEY, 'throw');
    invokeMenu(env, 'Clear attack memory');
    env.clearWriteFault();
    env.clearReadFault();

    assert.equal(env.hooks.extraction, extractionBefore, 'an unread pre-reset snapshot must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'the active bytes must be unchanged');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'the unread backup bytes must never be deleted');
    assert.deepEqual(env.deletes.filter((key) => key === ACTIVE_KEY || key === BACKUP_KEY), [], 'no envelope key may be deleted');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.match(alertMessage, /indeterminate|could not be verified/u);
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'an aborted reset must not claim success');
  } finally { env.restore(); }
});

test('unread pre-reset snapshot is reported indeterminate and never deleted when the reset write fails', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const stale = seedQueues(readEnvelope(env, HOST));
    writeEnvelope(env, HOST, stale);
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);
    const extractionBefore = env.hooks.extraction;

    // Transient read failure plus a persistent reset write failure: before the
    // fix the rollback deleted the unread active key and reported a verified
    // rollback ("previous baseline was restored") over erased bytes.
    env.failReadAfter(ACTIVE_KEY, 1);
    env.failEveryWrite(ACTIVE_KEY, 'throw');
    invokeMenu(env, 'Clear attack memory');
    env.clearWriteFault();
    env.clearReadFault();

    assert.equal(env.hooks.extraction, extractionBefore, 'an indeterminate reset must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'the unread active bytes survive an unverifiable reset');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'the backup bytes must be unchanged');
    assert.deepEqual(env.deletes, [], 'no key may be deleted while its pre-reset value was never read');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.match(alertMessage, /indeterminate|could not be verified/u);
    assert.match(alertMessage, /incident bundle|recovery/u);
    assert.doesNotMatch(alertMessage, /previous baseline was restored/u, 'an unread snapshot cannot be reported as a verified rollback');
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'an indeterminate reset must not claim success');
  } finally { env.restore(); }
});

test('malformed envelope reports baseline-reset-indeterminate without writing or rescanning', () => {
  const { env } = bootLeaderDocument({ table: [shimRow('101', 'Player 101')] });
  try {
    seedPreservedStores(env);
    const extractionBefore = env.hooks.extraction;
    env.gm.set(ACTIVE_KEY, '{not valid json');
    env.gm.set(BACKUP_KEY, 'also not json');
    const activeBefore = activeRaw(env, ACTIVE_KEY);
    const backupBefore = activeRaw(env, BACKUP_KEY);

    invokeMenu(env, 'Clear attack memory');

    assert.equal(env.hooks.extraction, extractionBefore, 'a corrupt envelope must not start a fresh scan');
    assert.equal(activeRaw(env, ACTIVE_KEY), activeBefore, 'the corrupt active bytes are left for the recovery workflow');
    assert.equal(activeRaw(env, BACKUP_KEY), backupBefore, 'the corrupt backup bytes are left for the recovery workflow');
    const alertMessage = env.alerts[env.alerts.length - 1];
    assert.match(alertMessage, /indeterminate|could not be verified/u);
    assert.match(alertMessage, /incident bundle|recovery/u);
    assert.doesNotMatch(alertMessage, /fresh baseline/u, 'a corrupt envelope must not claim success');
  } finally { env.restore(); }
});
