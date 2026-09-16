'use strict';

// Module-architecture boundary test (plan Todo 7, Wave 2).
//
// Enumerates every extraction contract, the fixed src/lifecycle.js API, and
// every mutable lifecycle singleton exactly once; proves the src dependency
// graph is acyclic and inside the allowed-dependency map; fails when a
// temporary duplicate field/export, a later-layer import, a dormant entry,
// an illegal browser global, a hand-edited dist bundle, or a direct
// runtime dependency is introduced. src/runtime.js stays authoritative:
// production wiring is asserted unchanged, never extracted here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ATTEMPT_GRAPH = path.join(
  ROOT, '.omo', 'evidence', 'repository-structural-hardening',
  '20260916T081851Z-ff0605b1', 'task-7-graph.json',
);
const GRAPH_OUT = process.env.TAA_GRAPH_OUT || ATTEMPT_GRAPH;

const CONTRACT_DOMAINS = [
  'storage', 'lease', 'parser', 'snapshot', 'envelope', 'migration',
  'discord', 'transport', 'dispatch', 'conservation', 'diagnostics',
  'panel', 'acquisition',
];

// Duplicate exports that exist on purpose today (frozen until Todos 8-17
// extract each domain). Any other duplicate fails the suite.
const KNOWN_DUPLICATE_EXPORTS = {
  filterMutedEvents: ['discord', 'snapshot'],
  coalesceMonitorPendingEvents: ['conservation', 'envelope'],
  compactDeliveryAccountingV1: ['conservation', 'envelope'],
  prepareTerminalCompactionV1: ['conservation', 'envelope'],
  resumeTerminalCompactionV1: ['conservation', 'envelope'],
  createMonitorQueueEvent: ['conservation', 'envelope'],
  sourceEventIdFromTuple: ['conservation', 'migration'],
  sourceEventTuple: ['conservation', 'migration'],
};

const LIFECYCLE_API = [
  'getSnapshot', 'setLease', 'loseLease', 'beginScan', 'finishScan',
  'setReadinessObserver', 'setNextReloadAt', 'canMutate', 'dispose',
];

const ADAPTER_FACTORIES = [
  'createStorageAdapter', 'createClockAdapter', 'createSleepAdapter',
  'createGmRequestAdapter', 'createDocumentLocationAdapter',
  'createWebLocksAdapter', 'createSessionStorageAdapter',
];

// Mutable lifecycle singletons owned solely by src/lifecycle.js.
const NAMED_SINGLETONS = [
  'previousState', 'lastScanAtMs', 'nextReloadAtMs', 'tabLeaseActive',
  'tabLeaseBestEffort', 'tabLeaseToken', 'tabLeaseGeneration', 'tabLeaseTerm',
  'activeLeaseOwnerId', 'lifecycleEpoch', 'readinessObserver',
  'readinessStartedAtMono', 'visibilityDriftState',
];
const TIMER_HANDLE_SINGLETONS = [
  'readinessTimerId', 'scanDeadlineTimerId', 'scanCycleId',
  'scheduledReloadTimerId', 'flushTimerId', 'followerWatchdogTimerId',
  'followerWatchdogCheck', 'lifecycleTimerIds', 'cancelPanelAsyncWork',
  'panelRuntimeTimerId',
];

// Exact src inventory: any extra file is a dormant entry and fails.
const SRC_ALLOWLIST = [
  'src/acquisition.js', 'src/adapters.js', 'src/boot.js',
  'src/browser-entry.js', 'src/conservation-impl.js', 'src/conservation.js', 'src/constants.js',
  'src/diagnostics.js', 'src/discord-impl.js', 'src/discord.js', 'src/dispatch-impl.js', 'src/dispatch.js',
  'src/envelope-impl.js', 'src/envelope.js', 'src/lease-impl.js', 'src/lease.js', 'src/lifecycle.js',
  'src/migration-impl.js', 'src/migration.js', 'src/panel.js', 'src/parser-impl.js', 'src/parser.js', 'src/route.js',
  'src/runtime-api.js', 'src/runtime.js', 'src/snapshot-impl.js', 'src/snapshot.js',
  'src/storage-diagnostics.js', 'src/storage-failed.js',
  'src/storage-history.js', 'src/storage-identity.js', 'src/storage-impl.js',
  'src/storage-mappings.js', 'src/storage-mutes.js',
  'src/storage-provenance.js', 'src/storage-queue.js', 'src/storage-roster.js',
  'src/storage-settings.js', 'src/storage-webhook.js',
  'src/storage.js', 'src/text.js', 'src/transport-impl.js', 'src/transport.js',
  'src/userscript-entry.js',
];

// Acyclic allowed-dependency map: relative src path -> allowed relative deps.
const ALLOWED_DEPS = {
  'src/acquisition.js': ['src/runtime-api.js'],
  'src/adapters.js': [],
  'src/boot.js': ['src/route.js'],
  'src/browser-entry.js': ['src/boot.js'],
  'src/conservation.js': ['src/conservation-impl.js'],
  'src/conservation-impl.js': ['src/envelope-impl.js', 'src/migration-impl.js'],
  'src/constants.js': [],
  'src/diagnostics.js': ['src/runtime-api.js'],
  'src/discord-impl.js': ['src/constants.js', 'src/snapshot-impl.js', 'src/text.js'],
  'src/discord.js': ['src/discord-impl.js'],
  'src/dispatch.js': ['src/dispatch-impl.js'],
  'src/dispatch-impl.js': ['src/constants.js', 'src/envelope-impl.js'],
  'src/envelope-impl.js': ['src/lease-impl.js', 'src/migration-impl.js'],
  'src/envelope.js': ['src/envelope-impl.js'],
  'src/lease-impl.js': ['src/adapters.js', 'src/route.js'],
  'src/lease.js': ['src/lease-impl.js'],
  'src/lifecycle.js': [],
  'src/migration-impl.js': [],
  'src/migration.js': ['src/migration-impl.js'],
  'src/panel.js': ['src/runtime-api.js'],
  'src/parser-impl.js': ['src/text.js'],
  'src/parser.js': ['src/parser-impl.js'],
  'src/route.js': [],
  'src/runtime-api.js': ['src/runtime.js'],
  'src/runtime.js': [],
  'src/snapshot-impl.js': ['src/constants.js', 'src/storage-mutes.js', 'src/storage-settings.js', 'src/text.js'],
  'src/snapshot.js': ['src/snapshot-impl.js'],
  'src/storage-impl.js': ['src/adapters.js'],
  'src/storage-identity.js': ['src/storage-impl.js'],
  'src/storage-webhook.js': ['src/storage-impl.js'],
  'src/storage-mappings.js': ['src/storage-impl.js'],
  'src/storage-provenance.js': ['src/storage-impl.js'],
  'src/storage-mutes.js': ['src/storage-impl.js'],
  'src/storage-roster.js': ['src/storage-impl.js'],
  'src/storage-settings.js': ['src/storage-impl.js'],
  'src/storage-history.js': ['src/storage-impl.js', 'src/storage-identity.js', 'src/storage-mutes.js'],
  'src/storage-diagnostics.js': ['src/storage-impl.js'],
  'src/storage-queue.js': ['src/storage-impl.js', 'src/storage-identity.js'],
  'src/storage-failed.js': ['src/storage-impl.js', 'src/storage-queue.js'],
  'src/storage.js': ['src/storage-impl.js', 'src/storage-identity.js', 'src/storage-webhook.js', 'src/storage-mappings.js', 'src/storage-provenance.js', 'src/storage-mutes.js', 'src/storage-roster.js', 'src/storage-settings.js', 'src/storage-history.js', 'src/storage-queue.js', 'src/storage-failed.js', 'src/storage-diagnostics.js'],
  'src/text.js': [],
  'src/transport-impl.js': ['src/adapters.js', 'src/constants.js', 'src/text.js'],
  'src/transport.js': ['src/transport-impl.js'],
  'src/userscript-entry.js': ['src/runtime.js'],
};

const BROWSER_IDENT_PATTERN = /\b(?:document|window|localStorage|sessionStorage|navigator|location|fetch)\b/;
const HOST_API_PATTERN = /GM_[A-Za-z]+|__TAA_TEST_HOOK__/;
// Only the entry adapter and the legacy monolith may name host capabilities.
const GLOBAL_EXEMPT = new Set(['src/userscript-entry.js', 'src/runtime.js']);

function readSrc(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function declarationCount(source, name) {
  const matches = source.match(new RegExp(`(?:let|const)\\s+${name}(?![A-Za-z0-9_$])`, 'g'));
  return matches ? matches.length : 0;
}

function requireGraph() {
  const graph = new Map();
  for (const relative of SRC_ALLOWLIST) {
    const source = readSrc(relative);
    const deps = [];
    const pattern = /require\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g;
    let match = pattern.exec(source);
    while (match) {
      const raw = match[1].endsWith('.js') ? match[1] : `${match[1]}.js`;
      let target = path.normalize(path.join(path.dirname(relative), raw)).split(path.sep).join('/');
      if (SRC_ALLOWLIST.includes(target)) deps.push(target);
      match = pattern.exec(source);
    }
    graph.set(relative, [...new Set(deps)]);
  }
  return graph;
}

function hasCycle(graph) {
  const active = new Set();
  const visited = new Set();
  function visit(node, trail) {
    if (active.has(node)) return trail.concat(node);
    if (visited.has(node)) return null;
    active.add(node);
    for (const dep of graph.get(node) || []) {
      const found = visit(dep, trail.concat(node));
      if (found) return found;
    }
    active.delete(node);
    visited.add(node);
    return null;
  }
  for (const node of graph.keys()) {
    const found = visit(node, []);
    if (found) return found;
  }
  return null;
}

function fakeAdapters() {
  const store = new Map();
  const session = new Map();
  const adapters = require(path.join(SRC, 'adapters.js'));
  return {
    storage: adapters.createStorageAdapter({
      getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      setValue: (key, value) => { store.set(key, value); },
      deleteValue: (key) => { store.delete(key); },
    }),
    clock: adapters.createClockAdapter({ nowFn: () => 1700000000000, monotonicFn: () => 1234.5 }),
    sleep: adapters.createSleepAdapter({}),
    gmRequest: adapters.createGmRequestAdapter({ gmRequest: (details) => ({ queued: true, url: details.url }) }),
    docLoc: adapters.createDocumentLocationAdapter({
      doc: { title: 'probe' },
      loc: { href: 'https://example.com/alliance/profile/members', hostname: 'example.com', reload: () => true },
    }),
    webLocks: adapters.createWebLocksAdapter({ locks: null }),
    sessionStore: adapters.createSessionStorageAdapter({
      store: {
        getItem: (key) => (session.has(key) ? session.get(key) : null),
        setItem: (key, value) => { session.set(key, String(value)); },
        removeItem: (key) => { session.delete(key); },
      },
    }),
  };
}

test('contracts: runtime-api enumerates exactly the 13 extraction domains', () => {
  const api = require(path.join(SRC, 'runtime-api.js'));
  assert.deepEqual(Object.keys(api).filter((key) => key !== 'select').sort(), [...CONTRACT_DOMAINS].sort());
  for (const domain of CONTRACT_DOMAINS) {
    assert.ok(api[domain] && typeof api[domain] === 'object', `${domain} contract is missing`);
    assert.ok(Object.keys(api[domain]).length > 0, `${domain} contract is empty`);
  }
});

test('contracts: every selected symbol resolves and duplicates equal the frozen allowlist', () => {
  const api = require(path.join(SRC, 'runtime-api.js'));
  const owners = new Map();
  for (const domain of CONTRACT_DOMAINS) {
    for (const symbol of Object.keys(api[domain])) {
      if (!owners.has(symbol)) owners.set(symbol, []);
      owners.get(symbol).push(domain);
    }
  }
  const actual = {};
  for (const [symbol, domains] of owners) {
    if (domains.length > 1) actual[symbol] = [...domains].sort();
  }
  assert.deepEqual(actual, KNOWN_DUPLICATE_EXPORTS);
});

test('dedup: conservation holds no independent logic beyond envelope and migration', () => {
  const conservationImpl = require(path.join(SRC, 'conservation-impl.js'));
  const envelopeImpl = require(path.join(SRC, 'envelope-impl.js'));
  const migrationImpl = require(path.join(SRC, 'migration-impl.js'));
  assert.deepEqual(
    Object.keys(conservationImpl).sort(),
    ['coalesceMonitorPendingEvents', 'compactDeliveryAccountingV1', 'createMonitorQueueEvent', 'prepareTerminalCompactionV1', 'resumeTerminalCompactionV1', 'sourceEventIdFromTuple', 'sourceEventTuple'],
  );
  for (const name of Object.keys(conservationImpl)) {
    const owner = envelopeImpl[name] !== undefined ? envelopeImpl : migrationImpl;
    assert.equal(conservationImpl[name], owner[name], `${name} must be the identical reference, not a copied duplicate`);
  }
  assert.doesNotMatch(readSrc('src/conservation-impl.js'), /\bfunction\b/);
});

test('lifecycle: module exposes the fixed factory and controller API exactly', () => {
  const lifecycle = require(path.join(SRC, 'lifecycle.js'));
  assert.equal(typeof lifecycle.createLifecycleController, 'function');
  const controller = lifecycle.createLifecycleController(fakeAdapters());
  assert.deepEqual(Object.keys(controller).sort(), [...LIFECYCLE_API].sort());
  for (const method of LIFECYCLE_API) assert.equal(typeof controller[method], 'function', method);
});

test('ownership: every named mutable singleton lives exactly once in lifecycle.js', () => {
  const owned = readSrc('src/lifecycle.js');
  const legacy = readSrc('src/runtime.js');
  assert.deepEqual([...NAMED_SINGLETONS].sort(), [...new Set(NAMED_SINGLETONS)].sort());
  assert.equal(NAMED_SINGLETONS.length, 13);
  for (const name of NAMED_SINGLETONS) {
    assert.equal(declarationCount(owned, name), 1, `src/lifecycle.js must declare ${name} exactly once`);
    assert.ok(declarationCount(legacy, name) >= 1, `src/runtime.js authority must still declare ${name}`);
    for (const relative of SRC_ALLOWLIST) {
      if (relative === 'src/lifecycle.js' || relative === 'src/runtime.js') continue;
      assert.equal(declarationCount(readSrc(relative), name), 0, `${relative} must not retain a copy of ${name}`);
    }
  }
});

test('ownership: every lifecycle timer/listener handle lives exactly once in lifecycle.js', () => {
  const owned = readSrc('src/lifecycle.js');
  for (const name of TIMER_HANDLE_SINGLETONS) {
    assert.equal(declarationCount(owned, name), 1, `src/lifecycle.js must declare ${name} exactly once`);
    for (const relative of SRC_ALLOWLIST) {
      if (relative === 'src/lifecycle.js' || relative === 'src/runtime.js') continue;
      assert.equal(declarationCount(readSrc(relative), name), 0, `${relative} must not retain a copy of ${name}`);
    }
  }
});

test('lifecycle: lease fencing behavior (set/lose/canMutate)', () => {
  const lifecycle = require(path.join(SRC, 'lifecycle.js'));
  const controller = lifecycle.createLifecycleController(fakeAdapters());
  assert.equal(controller.canMutate(), false);
  assert.equal(controller.setLease(null), false);
  assert.equal(
    controller.setLease({ ownerId: 'tab-1', token: 'tok-1', generation: 2, term: 3, bestEffort: false }),
    true,
  );
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.tabLeaseActive, true);
  assert.equal(snapshot.tabLeaseToken, 'tok-1');
  assert.equal(snapshot.activeLeaseOwnerId, 'tab-1');
  assert.equal(controller.canMutate(), true);
  assert.equal(controller.canMutate({ token: 'tok-1' }), true);
  assert.equal(controller.canMutate({ token: 'tok-other' }), false);
  assert.equal(controller.loseLease('probe-reason'), 'probe-reason');
  assert.equal(controller.getSnapshot().tabLeaseActive, false);
  assert.equal(controller.canMutate(), false);
});

test('lifecycle: scan/readiness/reload/dispose behavior with immutable snapshots', () => {
  const lifecycle = require(path.join(SRC, 'lifecycle.js'));
  const controller = lifecycle.createLifecycleController(fakeAdapters());
  assert.equal(controller.finishScan({}), false);
  assert.equal(controller.beginScan('doc-token-7'), 'doc-token-7');
  assert.equal(controller.getSnapshot().lastScanAtMs, 1700000000000);
  assert.equal(controller.finishScan({ state: { attacks: 1 } }), true);
  assert.deepEqual(controller.getSnapshot().previousState, { attacks: 1 });
  const before = controller.getSnapshot();
  before.tabLeaseActive = true;
  before.previousState = null;
  const after = controller.getSnapshot();
  assert.equal(after.tabLeaseActive, false);
  assert.deepEqual(after.previousState, { attacks: 1 });
  assert.equal(controller.setReadinessObserver({ disconnect: () => {} }), null);
  assert.equal(controller.getSnapshot().readinessStartedAtMono, 1234.5);
  assert.equal(controller.setNextReloadAt(1700000060000), 1700000060000);
  assert.equal(controller.getSnapshot().nextReloadAtMs, 1700000060000);
  assert.equal(controller.dispose('probe-done'), 'probe-done');
  assert.equal(controller.getSnapshot().readinessObserver, null);
});

test('adapters: exactly the seven extraction adapters with delegating behavior', () => {
  const adapters = require(path.join(SRC, 'adapters.js'));
  assert.deepEqual(Object.keys(adapters).sort(), [...ADAPTER_FACTORIES].sort());
  const fakes = fakeAdapters();
  fakes.storage.setValue('k', 'v');
  assert.equal(fakes.storage.getValue('k', null), 'v');
  assert.equal(fakes.storage.getValue('missing', 'fallback'), 'fallback');
  assert.ok(Number.isFinite(fakes.clock.now()));
  assert.ok(Number.isFinite(fakes.clock.monotonic()));
  assert.equal(typeof fakes.sleep.delay, 'function');
  assert.equal(typeof fakes.sleep.cancel, 'function');
  assert.deepEqual(fakes.gmRequest.request({ url: 'https://example.com/hook' }), { queued: true, url: 'https://example.com/hook' });
  assert.equal(fakes.docLoc.hostname(), 'example.com');
  assert.ok(fakes.docLoc.href().includes('/alliance/'));
  assert.equal(fakes.webLocks.available(), false);
  fakes.sessionStore.setItem('draft', 'x');
  assert.equal(fakes.sessionStore.getItem('draft'), 'x');
});

test('dependencies: graph is acyclic and inside the allowed-dependency map', () => {
  const graph = requireGraph();
  assert.deepEqual([...graph.keys()].sort(), [...SRC_ALLOWLIST].sort());
  for (const [file, deps] of graph) {
    assert.deepEqual([...deps].sort(), [...(ALLOWED_DEPS[file] || [])].sort(), `${file} has an unlisted dependency`);
  }
  assert.equal(hasCycle(graph), null);
});

test('entries: src inventory is exact and every stub wires through runtime-api only', () => {
  const onDisk = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => `src/${entry.name}`)
    .sort();
  assert.deepEqual(onDisk, [...SRC_ALLOWLIST].sort());
  for (const relative of SRC_ALLOWLIST) {
    const moduleExports = require(path.join(ROOT, relative));
    assert.ok(moduleExports && (typeof moduleExports === 'object' || typeof moduleExports === 'function'), `${relative} must load`);
  }
});

test('browser surface: pure modules name no host global; production wiring is untouched', () => {
  for (const relative of SRC_ALLOWLIST) {
    if (GLOBAL_EXEMPT.has(relative)) continue;
    const source = readSrc(relative);
    assert.ok(!BROWSER_IDENT_PATTERN.test(source), `${relative} names a forbidden browser global`);
    assert.ok(!HOST_API_PATTERN.test(source), `${relative} names a forbidden host API`);
  }
  const entry = readSrc('src/userscript-entry.js');
  assert.ok(entry.includes("require('./runtime.js')"), 'entry must still wire the authoritative runtime');
  assert.ok(entry.includes('startBrowserRuntime'), 'entry must still start the browser runtime');
  const runtime = require(path.join(SRC, 'runtime.js'));
  assert.equal(typeof runtime.startBrowserRuntime, 'function');
});

test('dist: bundle is generated output, never hand-edited', () => {
  const dist = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');
  const body = fs.readFileSync(dist, 'utf8');
  assert.ok(body.startsWith('// ==UserScript=='), 'dist bundle must start with the generated metadata block');
  assert.ok(body.includes('taa-1.0.0'), 'dist bundle must carry the frozen release ID');
  assert.ok(!body.includes('__taaModuleProbe'), 'dist bundle must not contain a hand-edit probe');
});

test('runtime authority: legacy exports and mutable state stay intact', () => {
  const runtime = require(path.join(SRC, 'runtime.js'));
  for (const symbol of ['startBrowserRuntime', 'acquireLease', 'checkLifecycleFence', 'diffAttackStates']) {
    assert.ok(runtime[symbol] !== undefined, `src/runtime.js must still export ${symbol}`);
  }
  const source = readSrc('src/runtime.js');
  assert.ok(source.includes('let previousState'), 'runtime mutable authority must be unchanged');
  assert.ok(source.includes('startBrowserRuntime'), 'runtime browser start must be unchanged');
});

test('evidence: ownership graph is written for the attempt', () => {
  const api = require(path.join(SRC, 'runtime-api.js'));
  const graph = requireGraph();
  const contracts = {};
  for (const domain of CONTRACT_DOMAINS) contracts[domain] = Object.keys(api[domain]).length;
  const payload = {
    schemaVersion: 1,
    contracts,
    duplicateExports: KNOWN_DUPLICATE_EXPORTS,
    lifecycleApi: LIFECYCLE_API,
    adapters: ADAPTER_FACTORIES,
    singletonOwner: 'src/lifecycle.js',
    namedSingletons: NAMED_SINGLETONS,
    timerHandleSingletons: TIMER_HANDLE_SINGLETONS,
    dependencyMap: Object.fromEntries(graph),
    acyclic: hasCycle(graph) === null,
    runtimeAuthoritative: true,
    productionWiringUnchanged: true,
  };
  fs.mkdirSync(path.dirname(GRAPH_OUT), { recursive: true });
  fs.writeFileSync(GRAPH_OUT, `${JSON.stringify(payload, null, 2)}\n`);
  assert.equal(payload.acyclic, true);
});
