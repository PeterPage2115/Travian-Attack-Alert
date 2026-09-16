'use strict';

// Characterization: panel session-draft extraction (plan Todo 15).
//
// Pins the exact runtime-api.panel behavior BEFORE extraction (differential
// against src/runtime.js) and verifies the same contract AFTER: the 12-symbol
// session-draft kernel lives in src/panel-impl.js behind the Todo 7 adapter
// seam, while the 10-symbol model-builder tail stays on the frozen runtime
// authority until Todos 16-17. src/panel.js preserves all 22 symbols by
// reference. Fails while the extracted module is missing; passes only when
// the 12 kernel symbols, the draft redaction/roundtrip/gate behavior, the
// backfill planner, the lease-state patch, the seam isolation, and the full
// 22-symbol facade contract match.
//
// Host strategy: no browser globals are touched. The runtime side runs draft
// persistence against raw Map-backed session stores; the extracted side runs
// against Todo 7 adapter-wrapped stores. DOM patching runs against minimal
// querySelectorAll fakes on both sides.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const runtimeApi = require(path.join(SRC, 'runtime-api.js'));
const adapters = require(path.join(SRC, 'adapters.js'));
const impl = require(path.join(SRC, 'panel-impl.js'));
const panel = require(path.join(SRC, 'panel.js'));

const IMPL_CONTRACT = [
  'createAdminDraftState', 'isAdminDraftEmpty',
  'supportsInputSelection', 'readSessionStorageSafely', 'persistAdminDraft',
  'restoreAdminDraft', 'gateAdminDraftReload', 'resolvePanelExit',
  'createNameBackfillPlan', 'isPanelAsyncResultCurrent',
  'patchPlayerNameNodes', 'applyPanelLeaseState',
];

const TAIL_CONTRACT = [
  'computeUnmappedPlayers', 'buildPlayerWorkspaceModel',
  'paginatePlayerWorkspaceRows', 'collectUnknownIds', 'buildHistoryPanelRows',
  'buildStatsPanelModel', 'buildDiagnosticsPanelModel',
  'buildStatusPanelModel', 'buildCountReconciliationPanelModel',
  'buildIncidentBundle',
];

const PANEL_CONTRACT = [...IMPL_CONTRACT, ...TAIL_CONTRACT];

function memorySession() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(String(key)); },
    _map: map,
  };
}

function adaptedSession() {
  const store = memorySession();
  const adapter = adapters.createSessionStorageAdapter({ store });
  adapter._map = store._map;
  return adapter;
}

function throwingSession() {
  const fail = () => { throw new Error('denied'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function both(name, args) {
  const target = IMPL_CONTRACT.includes(name) ? impl[name] : panel[name];
  return [runtime[name](...args), target(...args)];
}

test('panel exposes the exact 22-symbol contract by reference', () => {
  assert.deepEqual(Object.keys(runtimeApi.panel).sort(), [...PANEL_CONTRACT].sort());
  assert.deepEqual(Object.keys(panel).sort(), [...PANEL_CONTRACT].sort());
  for (const name of PANEL_CONTRACT) {
    assert.equal(typeof panel[name], typeof runtime[name], `${name} type differs`);
    if (IMPL_CONTRACT.includes(name)) {
      assert.equal(typeof impl[name], typeof runtime[name], `${name} type differs`);
      assert.equal(panel[name], impl[name], `${name} must be the identical reference, not a copied duplicate`);
    } else {
      assert.equal(panel[name], runtimeApi.panel[name], `${name} tail must stay on the frozen authority by reference`);
    }
  }
  assert.equal(typeof impl.configurePanelAdapters, 'function');
  assert.equal(typeof impl.resetPanelAdapters, 'function');
});

test('workspace model groups, names, and summarizes identically', () => {
  const inputs = [
    {},
    { roster: [{ id: '7', name: 'Zeta' }, { id: '3', name: 'Ala' }, '9'], mappings: { 3: ['<@1>'], 9: [] }, muted: ['7'], cachedNames: { 9: 'Cached Nine' }, liveNames: { 7: 'Live Seven' } },
    { roster: [{ playerId: '5', name: '  ' }, { id: '', name: 'x' }, null], mappings: {}, muted: { 5: true, 6: false }, cachedNames: { 6: 'Six' } },
    { roster: [], mappings: { 1: ['a', 'a', 7, ' '] }, muted: [], cachedNames: {}, liveNames: {} },
  ];
  for (const input of inputs) {
    const [left, right] = both('buildPlayerWorkspaceModel', [input]);
    assert.deepEqual(right, left, `workspace mismatch for ${JSON.stringify(input).slice(0, 80)}`);
  }
  const model = panel.buildPlayerWorkspaceModel(inputs[1]);
  assert.deepEqual(model.summary, { monitored: 3, mapped: 2, unmapped: 0, muted: 1, orphaned: 0 });
  assert.equal(model.rows[0].orphaned, false);
});

test('workspace pagination filters, sorts, and clamps identically', () => {
  const model = runtime.buildPlayerWorkspaceModel({
    roster: [{ id: '1', name: 'Ala' }, { id: '2', name: 'Beta' }, { id: '3', name: 'Gamma' }],
    mappings: { 1: ['x'] }, muted: ['3'],
  });
  const optionSets = [
    {}, { query: 'al' }, { query: '2' }, { mapped: true }, { unmapped: true },
    { muted: true }, { orphaned: true }, { page: 99 }, { page: 0 }, { page: NaN },
    { query: 'a', mapped: true, page: 1 },
  ];
  for (const options of optionSets) {
    const [left, right] = both('paginatePlayerWorkspaceRows', [model.rows, options]);
    assert.deepEqual(right, left, `pagination mismatch for ${JSON.stringify(options)}`);
  }
  const [notArray] = both('paginatePlayerWorkspaceRows', [null, {}]);
  assert.deepEqual(panel.paginatePlayerWorkspaceRows(null, {}), notArray);
});

test('unmapped, unknown-id, history, stats, diagnostics, and status models match', () => {
  const members = [{ id: '1', name: 'Beta' }, { id: '2', name: 'Ala' }, { id: '3' }, null, 'x'];
  const mappings = { 'world.test': { 1: ['<@9>'] } };
  const muted = { 'world.test': { 2: true } };
  for (const args of [[members, mappings, muted, 'world.test'], ['nope', {}, {}, 'h'], [members, null, null, 'world.test']]) {
    const [left, right] = both('computeUnmappedPlayers', args);
    assert.deepEqual(right, left);
  }
  assert.deepEqual(panel.computeUnmappedPlayers(members, {}, {}, 'world.test').map((m) => m.id), ['3', '2', '1']);

  const idToName = new Set(['known']);
  for (const args of [[['7 → <@1>', 'known → <@2>', 7, ''], ['9'], idToName, new Set(['9'])], [null, null, new Set(), null]]) {
    const [left, right] = both('collectUnknownIds', args);
    assert.deepEqual(right, left);
  }
  assert.deepEqual(panel.collectUnknownIds(['7 → <@1>'], [], new Set(), new Set()), ['7']);

  const events = [
    { name: 'Ala', eventType: 'attack', priority: 'high', addedAttackCount: 2, addedRaidCount: 0, detectedAtMs: 1700000000000 },
    { name: 7, priority: null }, null,
  ];
  for (const args of [[events, 1], [events, NaN], [null, 50], [events]]) {
    const [left, right] = both('buildHistoryPanelRows', args);
    assert.deepEqual(right, left);
  }

  for (const summary of [{}, { total: 5, attacks: 2, last24h: { total: 1, muted: 2 } }, { total: NaN, last24h: null }]) {
    const [left, right] = both('buildStatsPanelModel', [summary]);
    assert.deepEqual(right, left);
  }

  const failure = { atMs: 1700000000000, statusOrError: 'boom', eventCount: 3, rejectionReason: 'no-member-table', memberRows: 5.7, rows: 2, icons: 1 };
  for (const lastFailure of [null, 7, failure, { ...failure, rejectionReason: 'nope' }, { atMs: 1 }]) {
    const [left, right] = both('buildDiagnosticsPanelModel', [lastFailure]);
    assert.deepEqual(right, left);
  }
  assert.equal(panel.buildDiagnosticsPanelModel({ ...failure, rejectionReason: 'nope' }).rejectionReason, undefined);

  for (const args of [[1000, 2000, 1500], [null, null, 0], [1700000000000, null, 1700000000000]]) {
    const [left, right] = both('buildStatusPanelModel', args);
    assert.deepEqual(right, left);
  }
  assert.deepEqual(panel.buildStatusPanelModel(null, null, 0), { lastScan: 'never', nextReload: 'never', nextReloadInMs: null });
});

test('draft state redacts secrets and roundtrips through session stores', () => {
  const draft = { tab: 'players', fields: { nickname: 'Ala', webhookUrl: 'https://x', tokenX: 's3cr3t', note: '' }, focus: { id: 'a', start: 1, end: 2 }, scope: { query: 'q', filters: { mapped: true, nope: 1 }, page: 2.7, activeEditorId: 'e', selection: ['1', '', '2'] } };
  const [left, right] = both('createAdminDraftState', [draft.tab, draft.fields, draft.focus, draft.scope]);
  assert.deepEqual(right, left);
  assert.deepEqual(Object.keys(right.fields).sort(), ['nickname', 'note']);
  assert.deepEqual(right.scope, { query: 'q', filters: { mapped: true }, page: 2, activeEditorId: 'e', selection: ['1', '2'] });

  for (const probe of [{ fields: {} }, { fields: { a: '' } }, { fields: { a: 'x' } }, null]) {
    const [l, r] = both('isAdminDraftEmpty', [probe]);
    assert.deepEqual(r, l);
  }
  assert.equal(impl.isAdminDraftEmpty({ fields: { a: '' } }), true);

  for (const element of [{ setSelectionRange() {}, type: 'text' }, { setSelectionRange() {}, type: 'number' }, { type: 'text' }, null]) {
    const [l, r] = both('supportsInputSelection', [element]);
    assert.deepEqual(r, l);
  }

  const rawStore = memorySession();
  const saved = runtime.persistAdminDraft(rawStore, 'k', draft);
  assert.equal(saved.ok, true);
  const seamStore = adaptedSession();
  const seamSaved = impl.persistAdminDraft(seamStore, 'k', draft);
  assert.deepEqual({ ok: seamSaved.ok, outcome: seamSaved.outcome }, { ok: saved.ok, outcome: saved.outcome });
  assert.deepEqual([...seamStore._map.entries()], [...rawStore._map.entries()]);
  const restored = impl.restoreAdminDraft(seamStore, 'k');
  assert.deepEqual(restored, runtime.restoreAdminDraft(rawStore, 'k'));
  assert.equal(restored.ok, true);
  assert.deepEqual(Object.keys(restored.draft.fields).sort(), ['nickname', 'note']);

  const tampered = memorySession();
  tampered.setItem('k', '{"version":1,"tab":"overview","fields":{"a":"b"},"focus":null,"scope":{},"webhook":"x"}');
  const seamTampered = adaptedSession();
  seamTampered.setItem('k', tampered.getItem('k'));
  assert.deepEqual(impl.restoreAdminDraft(seamTampered, 'k'), runtime.restoreAdminDraft(tampered, 'k'));
  assert.equal(impl.restoreAdminDraft(seamTampered, 'k').ok, false);
  assert.deepEqual(impl.restoreAdminDraft(adaptedSession(), 'missing'), { ok: true, draft: null });
});

test('draft reload gate covers verified, empty-denied, and failing stores', () => {
  const drafts = [
    { tab: 'overview', fields: { a: 'x' }, focus: null, scope: {} },
    { tab: 'overview', fields: {}, focus: null, scope: {} },
  ];
  for (const draft of drafts) {
    const left = runtime.gateAdminDraftReload(memorySession(), 'k', draft);
    const right = impl.gateAdminDraftReload(adaptedSession(), 'k', draft);
    assert.deepEqual({ ok: right.ok, outcome: right.outcome }, { ok: left.ok, outcome: left.outcome });
    assert.deepEqual(right.draft, left.draft);
  }
  for (const draft of drafts) {
    const left = runtime.gateAdminDraftReload(throwingSession(), 'k', draft);
    const right = impl.gateAdminDraftReload(throwingSession(), 'k', draft);
    assert.deepEqual({ ok: right.ok, outcome: right.outcome }, { ok: left.ok, outcome: left.outcome });
  }
  const gated = impl.gateAdminDraftReload(throwingSession(), 'k', { tab: 't', fields: {}, focus: null, scope: {} });
  assert.deepEqual(gated, { ok: true, outcome: 'storage-failed-empty-draft', error: gated.error });

  for (const args of [['reload', false, null], ['reload', true, { ok: true }], ['backdrop', true, { ok: false }], ['escape', true, null]]) {
    const [left, right] = both('resolvePanelExit', args);
    assert.deepEqual(right, left);
  }
  assert.deepEqual(impl.resolvePanelExit('reload', true, { ok: false }).actionGroup, ['Save', 'Discard', 'Reload']);
});

test('session root access and backfill planner match', () => {
  const store = memorySession();
  assert.equal(impl.readSessionStorageSafely({ sessionStorage: store }, null), store);
  assert.deepEqual(impl.readSessionStorageSafely({ sessionStorage: store }, null), runtime.readSessionStorageSafely({ sessionStorage: store }, null));
  assert.equal(impl.readSessionStorageSafely({}, null), null);
  let denied = 0;
  const explosive = {};
  Object.defineProperty(explosive, 'sessionStorage', { get() { throw new Error('denied'); } });
  assert.equal(impl.readSessionStorageSafely(explosive, () => { denied += 1; }), null);
  assert.equal(denied, 1);

  for (const args of [[['a', 'b', 'c'], ['b'], 12], [['a', 'b'], ['a', 'b', 'c'], 0], [['a'], [], NaN], [null, null, -3], [['a', 'a', ''], ['a'], 1]]) {
    const [left, right] = both('createNameBackfillPlan', args);
    assert.deepEqual(right, left);
  }
  assert.deepEqual(impl.createNameBackfillPlan(['a', 'b', 'c'], ['b'], 1), { ids: ['b', 'a'], visibleIds: ['b'], orphanIds: ['a'], orphanCap: 1 });

  for (const args of [[1, 1, 'a', 'a', true, true], [1, 2, 'a', 'a', true, true], [1, 1, 'a', 'b', true, true], [1, 1, 'a', 'a', false, true], [1, 1, 'a', 'a', true, false]]) {
    const [left, right] = both('isPanelAsyncResultCurrent', args);
    assert.deepEqual(right, left);
  }
});

function fakeDom() {
  const nodes = [
    { dataset: { playerId: '7' }, textContent: 'Old' },
    { dataset: { playerId: '9' }, textContent: 'Nine' },
    { dataset: {}, textContent: 'x' },
  ];
  const controls = [{ disabled: false }, { disabled: false }];
  const banner = { textContent: '' };
  const root = {
    querySelectorAll: (selector) => (selector === '[data-player-id]' ? nodes : selector === '[data-mutation-control]' ? controls : []),
    querySelector: (selector) => (selector === '[data-taa-standby-banner]' ? banner : null),
  };
  return { nodes, controls, banner, root };
}

test('name patching and lease state match on DOM fakes', () => {
  for (const [updates, previous] of [[[{ id: '7', name: 'New' }], { 7: 'Old' }], [[{ id: '7', name: 'New' }], { 7: 'Changed' }], [[{ id: '', name: 'x' }], {}], ['nope', {}]]) {
    const left = runtime.patchPlayerNameNodes(fakeDom().root, updates, previous);
    const right = impl.patchPlayerNameNodes(fakeDom().root, updates, previous);
    assert.deepEqual(right, left);
  }
  const dom = fakeDom();
  assert.equal(impl.patchPlayerNameNodes(dom.root, [{ id: '7', name: 'New' }], { 7: 'Old' }), 1);
  assert.equal(dom.nodes[0].textContent, 'New');
  assert.equal(impl.patchPlayerNameNodes(null, [], {}), 0);

  for (const leader of [true, false]) {
    const left = runtime.applyPanelLeaseState(leader, fakeDom().root);
    const right = impl.applyPanelLeaseState(leader, fakeDom().root);
    assert.deepEqual(right, left);
  }
  const dom2 = fakeDom();
  assert.deepEqual(impl.applyPanelLeaseState(false, dom2.root), { leader: false, controls: 2 });
  assert.equal(dom2.controls[0].disabled, true);
  assert.ok(dom2.banner.textContent.includes('Standby'));
  assert.deepEqual(impl.applyPanelLeaseState(true, null), runtime.applyPanelLeaseState(true, undefined));
});

function reconciliationInput() {
  return {
    envelope: {
      generation: 3,
      pending: [{ sourceEventIds: ['a', 'b'] }, {}],
      inFlight: [],
      failed: [{ sourceEventIds: ['c'] }],
      uncertain: [],
      metrics: {
        leaseGeneration: 2,
        activeTotals: { players: 4, attacks: 1, raids: 0 },
        newNetDeltas: { players: 1, attacks: 0, raids: 0 },
        dispositions: { muted: 1, blocked: 2, eligible: 3 },
        conservation: {},
        deliveryAccounting: {
          dispatchPlans: [{ chunks: [{ state: 'acknowledged', sourceCount: 2 }, { state: 'sending', sourceCount: 5 }] }],
          terminal: [{ sourceEventIds: ['t'] }],
          compactedTerminalTotals: [{ count: 4 }],
        },
      },
    },
    diagnostics: { scanReason: 'tick', scanOutcome: 'ok' },
    traces: [
      { stage: 'snapshot', status: 'ok', reason: 'authoritative', scanId: 'abcdef12' },
      { stage: 'reload', status: 'rejected', reason: 'reload-blocked' },
    ],
    routeRole: 'canonical-member',
  };
}

test('reconciliation and incident bundle match, including bounds', () => {
  for (const input of [reconciliationInput(), {}, { routeRole: 'nope' }, { traces: [{ stage: 'lease', status: 'rejected', reason: 'lease-lost-before-scan', scanId: 'https://evil/token-secret' }] }]) {
    const [left, right] = both('buildCountReconciliationPanelModel', [input]);
    assert.deepEqual(right, left);
  }
  const model = panel.buildCountReconciliationPanelModel(reconciliationInput());
  assert.deepEqual(model.deliveryTotals, { pending: 3, inFlight: 0, failed: 1, uncertain: 0, acknowledged: 3 });
  assert.equal(model.scanLabel, 'accepted/authoritative');
  assert.equal(model.reloadLabel, 'reload-blocked/rejected');

  for (const input of [reconciliationInput(), { ...reconciliationInput(), webhookConfigured: true, filters: { stage: 'snapshot' } }]) {
    const [left, right] = both('buildIncidentBundle', [input]);
    assert.deepEqual(right, left);
  }
  const bundle = panel.buildIncidentBundle(reconciliationInput());
  assert.equal(bundle.kind, 'taa-incident-bundle');
  assert.equal(bundle.deliveryLedger.compacted, 4);

  const huge = reconciliationInput();
  huge.traces = [{ stage: 'snapshot', status: 'ok', reason: 'x'.repeat(600000), scanId: 'abcdef12' }];
  const [boundedLeft, boundedRight] = both('buildIncidentBundle', [huge]);
  assert.deepEqual(boundedRight, boundedLeft);
  assert.equal(boundedRight.bounded, true);
});

test('panel session seam isolates injected stores from globals', () => {
  const store = memorySession();
  assert.deepEqual(impl.configurePanelAdapters({ session: store }), { session: true, panelRoot: false });
  assert.equal(impl.panelSessionStore().getItem('probe'), null);
  store.setItem('probe', 'v');
  assert.equal(impl.panelSessionStore().getItem('probe'), 'v');
  const root = fakeDom().root;
  assert.deepEqual(impl.configurePanelAdapters({ panelRoot: root }), { session: true, panelRoot: true });
  assert.deepEqual(impl.applyPanelLeaseState(true), { leader: true, controls: 2 });
  impl.resetPanelAdapters();
  assert.deepEqual(impl.configurePanelAdapters({}), { session: false, panelRoot: false });
  assert.deepEqual(impl.applyPanelLeaseState(true, null), runtime.applyPanelLeaseState(true, undefined));
  impl.resetPanelAdapters();
});
