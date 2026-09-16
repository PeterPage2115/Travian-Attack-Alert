'use strict';

// Characterization: diagnostics kernel extraction (plan Todo 14).
//
// Pins the exact runtime-api.diagnostics behavior BEFORE extraction (differential
// against src/runtime.js through Map-backed global fakes) and verifies the same
// contract AFTER: the bounded schema/ring/serializer/persistence kernel lives in
// src/diagnostics-impl.js behind the Todo 7 adapter seam, while the
// drift/redaction/failure tail stays on the frozen runtime authority until
// Todos 15-17. src/diagnostics.js preserves all 16 symbols by reference.
// Fails while the extracted module is missing; passes only when the 9 kernel
// symbols, every bound (records/recordBytes/worldBytes/ids/consoleBytes/
// exportBytes), the digest-based redaction of world/scan/diagnostic identities,
// and the global-storage vs injected-adapter persistence behavior match.
//
// Host strategy: the runtime side runs against a Map-backed global.localStorage
// fake; the extracted side runs against a Map-backed injected keyValue adapter.
// Both maps are seeded identically, then return values AND stored bytes are
// compared.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const runtimeApi = require(path.join(SRC, 'runtime-api.js'));
const impl = require(path.join(SRC, 'diagnostics-impl.js'));
const diagnostics = require(path.join(SRC, 'diagnostics.js'));

const IMPL_CONTRACT = [
  'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
  'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
  'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
  'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
  'serializeDiagnosticExportV2',
];

const TAIL_CONTRACT = [
  'boundedDiagnosticRecords',
  'monotonicDurationMs', 'recordDuration', 'createVisibilityDriftTracker',
  'updateVisibilityDriftTracker', 'buildScanSummaryLog', 'recordFailure',
];

const DIAGNOSTICS_CONTRACT = [...IMPL_CONTRACT, ...TAIL_CONTRACT];

const WORLD = 'ts1.travian.com';

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(String(key)); },
    _map: map,
  };
}

function withRuntimeStorage(seed, fn) {
  const fake = memoryStore();
  for (const [key, value] of seed) fake.setItem(key, value);
  const previous = global.localStorage;
  global.localStorage = fake;
  try {
    return { result: fn(), stored: new Map(fake._map) };
  } finally {
    if (previous === undefined) delete global.localStorage;
    else global.localStorage = previous;
  }
}

function withImplStorage(seed, fn) {
  const store = memoryStore();
  for (const [key, value] of seed) store.setItem(key, value);
  impl.configureDiagnosticsAdapters({ keyValue: store });
  try {
    return { result: fn(), stored: new Map(store._map) };
  } finally {
    impl.resetDiagnosticsAdapters();
  }
}

test('diagnostics preserves the exact 16-symbol contract by reference', () => {
  assert.deepEqual(Object.keys(diagnostics).sort(), [...DIAGNOSTICS_CONTRACT].sort());
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'diagnostics-impl.js'), 'utf8'), /runtime-api/u);
  for (const name of IMPL_CONTRACT) {
    assert.equal(typeof impl[name], typeof runtime[name], `type differs: ${name}`);
    assert.equal(diagnostics[name], impl[name], `kernel symbol must re-export impl reference: ${name}`);
  }
  for (const name of TAIL_CONTRACT) {
    assert.equal(diagnostics[name], runtimeApi.diagnostics[name], `tail symbol must re-export frozen authority reference: ${name}`);
    assert.equal(diagnostics[name], runtime[name], `tail symbol must match runtime authority: ${name}`);
  }
});

test('diagnostics kernel names no host global and keeps the runtime authoritative', () => {
  const source = fs.readFileSync(path.join(SRC, 'diagnostics-impl.js'), 'utf8');
  assert.ok(!/\b(?:document|window|localStorage|sessionStorage|navigator|location|fetch)\b/.test(source), 'impl names a forbidden browser global');
  assert.ok(!/GM_[A-Za-z]+|__TAA_TEST_HOOK__/.test(source), 'impl names a forbidden host API');
  for (const name of DIAGNOSTICS_CONTRACT) {
    assert.ok(runtime[name] !== undefined, `src/runtime.js must still export ${name}`);
  }
});

test('world construction and alias identities match the authority', () => {
  for (const worldHash of [WORLD, '', '  Mixed Case WORLD  ', 'żółć']) {
    assert.deepEqual(impl.createDiagnosticsWorldV2(worldHash), runtime.createDiagnosticsWorldV2(worldHash));
    assert.deepEqual(impl.createDiagnosticWorldV2(worldHash), runtime.createDiagnosticWorldV2(worldHash));
    assert.equal(impl.createDiagnosticWorldV2, impl.createDiagnosticsWorldV2);
  }
  assert.deepEqual(impl.createDiagnosticsWorldV2(WORLD).worldHash.length, 8);
});

test('append trace preserves sequence, digest redaction, and bounded caps', () => {
  const inputs = [
    { stage: 'snapshot', status: 'ok', reason: 'baseline accepted', count: 3, durationMs: 12.5, diagnosticId: 'diag-1', scanId: 'scan-9' },
    { stage: 'bogus-stage', status: 'bogus-status', reason: 'x'.repeat(500) },
    { stage: 'dispatch', status: 'error', count: NaN, durationMs: Infinity, diagnosticId: 'diag-2' },
    { stage: 'queue', status: 'rejected', count: -0, durationMs: -5 },
    'not-an-object',
    null,
  ];
  for (const input of inputs) {
    assert.deepEqual(
      impl.appendDiagnosticTraceV2(impl.createDiagnosticsWorldV2(WORLD), input),
      runtime.appendDiagnosticTraceV2(runtime.createDiagnosticsWorldV2(WORLD), input),
      `append mismatch for ${JSON.stringify(input)}`,
    );
  }
  assert.equal(impl.appendDiagnosticRecordV2, impl.appendDiagnosticTraceV2);

  let implWorld = impl.createDiagnosticsWorldV2(WORLD);
  let runtimeWorld = runtime.createDiagnosticsWorldV2(WORLD);
  for (let index = 0; index < 300; index += 1) {
    const input = { stage: 'diff', status: 'ok', diagnosticId: `diag-${index}`, scanId: 'scan-cap' };
    implWorld = impl.appendDiagnosticTraceV2(implWorld, input);
    runtimeWorld = runtime.appendDiagnosticTraceV2(runtimeWorld, input);
  }
  assert.deepEqual(implWorld, runtimeWorld);
  assert.equal(implWorld.records.length, 256);
  assert.equal(implWorld.sequence, 300);
  assert.ok(implWorld.diagnosticIds.length <= 32);

  const cyclic = { stage: 'route', status: 'ok' };
  cyclic.self = cyclic;
  assert.deepEqual(
    impl.appendDiagnosticTraceV2(impl.createDiagnosticsWorldV2(WORLD), cyclic),
    runtime.appendDiagnosticTraceV2(runtime.createDiagnosticsWorldV2(WORLD), cyclic),
  );
  const oversize = { stage: 'route', status: 'ok', reason: 'r'.repeat(100000), diagnosticId: 'd'.repeat(100000) };
  assert.deepEqual(
    impl.appendDiagnosticTraceV2(impl.createDiagnosticsWorldV2(WORLD), oversize),
    runtime.appendDiagnosticTraceV2(runtime.createDiagnosticsWorldV2(WORLD), oversize),
  );
});

test('console and export serializers preserve bounds and fallbacks', () => {
  const worlds = [
    { schemaVersion: 2, status: 'ok', sequence: 7, stage: 'snapshot', records: [{ schemaVersion: 2, sequence: 1, stage: 'route', status: 'ok', reason: 'probe' }] },
    { schemaVersion: 2, status: 'error', sequence: 3, stage: 'bogus', records: [] },
    {},
    null,
  ];
  for (const world of worlds) {
    assert.equal(impl.serializeDiagnosticsConsoleV2(world), runtime.serializeDiagnosticsConsoleV2(world));
    assert.equal(impl.serializeDiagnosticsExportV2(WORLD, world), runtime.serializeDiagnosticsExportV2(WORLD, world));
  }
  assert.equal(impl.serializeDiagnosticConsoleV2, impl.serializeDiagnosticsConsoleV2);
  assert.equal(impl.serializeDiagnosticExportV2, impl.serializeDiagnosticsExportV2);

  let big = runtime.createDiagnosticsWorldV2(WORLD);
  for (let index = 0; index < 256; index += 1) {
    big = runtime.appendDiagnosticTraceV2(big, { stage: 'diff', status: 'ok', reason: `reason-${index}-${'p'.repeat(60)}` });
  }
  assert.equal(impl.serializeDiagnosticsConsoleV2(big), runtime.serializeDiagnosticsConsoleV2(big));
  assert.ok(impl.serializeDiagnosticsConsoleV2(big).length <= 2048 + 256);
  assert.equal(impl.serializeDiagnosticsExportV2(WORLD, big), runtime.serializeDiagnosticsExportV2(WORLD, big));
});

test('injected persistence matches global-storage behavior byte for byte', () => {
  const cases = [
    (api) => api.loadDiagnosticsV2(),
    (api) => api.saveDiagnosticsV2(WORLD, api.createDiagnosticsWorldV2(WORLD)),
    (api) => api.saveDiagnosticsV2(WORLD, 'not-an-object'),
    (api) => api.recordDiagnosticTraceV2(WORLD, { stage: 'filter', status: 'ok', scanId: 'scan-persist' }),
  ];
  for (const run of cases) {
    const left = withRuntimeStorage([], () => run(runtime));
    const right = withImplStorage([], () => run(impl));
    assert.deepEqual(right.result, left.result);
    assert.deepEqual([...right.stored.values()], [...left.stored.values()]);
  }

  const prefilled = (() => {
    const world = runtime.appendDiagnosticTraceV2(runtime.createDiagnosticsWorldV2(WORLD), { stage: 'lease', status: 'ok' });
    const payload = JSON.stringify({ [world.worldHash]: JSON.parse(runtime.serializeDiagnosticsExportV2(WORLD, world)) });
    return [['travianAllianceDiagnostics_v2', payload]];
  })();
  const left = withRuntimeStorage(prefilled, () => runtime.recordDiagnosticTraceV2(WORLD, { stage: 'reload', status: 'ok', reason: 'prefilled' }));
  const right = withImplStorage(prefilled, () => impl.recordDiagnosticTraceV2(WORLD, { stage: 'reload', status: 'ok', reason: 'prefilled' }));
  assert.deepEqual(right.result, left.result);
  assert.deepEqual([...right.stored.entries()], [...left.stored.entries()]);

  const oversizedWorld = { schemaVersion: 2, sequence: 1, records: [{ schemaVersion: 2, sequence: 1, stage: 'route', status: 'ok', reason: 'x'.repeat(4000) }], diagnosticIds: [] };
  const leftRefused = withRuntimeStorage([], () => runtime.saveDiagnosticsV2(WORLD, oversizedWorld));
  const rightRefused = withImplStorage([], () => impl.saveDiagnosticsV2(WORLD, oversizedWorld));
  assert.deepEqual(rightRefused.result, leftRefused.result);

  const malformed = withRuntimeStorage([['travianAllianceDiagnostics_v2', '{not-json']], () => runtime.loadDiagnosticsV2());
  const malformedImpl = withImplStorage([['travianAllianceDiagnostics_v2', '{not-json']], () => impl.loadDiagnosticsV2());
  assert.deepEqual(malformedImpl.result, malformed.result);
});

test('adapter isolation: reset restores the storage-less behavior', () => {
  impl.resetDiagnosticsAdapters();
  assert.deepEqual(impl.loadDiagnosticsV2(), {});
  assert.equal(impl.saveDiagnosticsV2(WORLD, impl.createDiagnosticsWorldV2(WORLD)), false);
  const fresh = impl.createDiagnosticsWorldV2(WORLD);
  assert.deepEqual(impl.recordDiagnosticTraceV2(WORLD, { stage: 'route', status: 'ok' }), fresh);
});

test('facade tail preserves filters, redaction, drift, and failure behavior', () => {
  let world = runtime.createDiagnosticsWorldV2(WORLD);
  const reasons = [
    'clean reason',
    'token=super-secret https://example.test/hook/123456789 payload-body',
    'contact https://evil.example/x and secret: hunter2 with id 9876543210',
    'x'.repeat(400),
  ];
  reasons.forEach((reason, index) => {
    world = runtime.appendDiagnosticTraceV2(world, {
      stage: ['route', 'snapshot', 'dispatch'][index % 3],
      status: index % 2 === 0 ? 'ok' : 'error',
      reason,
      scanId: index < 2 ? 'scan-filter-me' : `scan-${index}`,
    });
  });
  const filterCases = [{}, { stage: 'route' }, { outcome: 'ok' }, { scanId: 'scan-filter-me' }, { stage: 'dispatch', outcome: 'error' }];
  for (const filters of filterCases) {
    assert.deepEqual(diagnostics.boundedDiagnosticRecords(world.records, filters), runtime.boundedDiagnosticRecords(world.records, filters), `filter mismatch ${JSON.stringify(filters)}`);
  }
  const bounded = diagnostics.boundedDiagnosticRecords(world.records, {});
  for (const record of bounded) {
    assert.ok(!/https?:\/\//.test(record.reason || ''), 'reason must redact urls');
    assert.ok(!/super-secret|hunter2/.test(record.reason || ''), 'reason must redact secrets');
    assert.ok(!/\b\d{4,}\b/.test(record.reason || ''), 'reason must redact long ids');
    assert.ok((record.reason || '').length <= 64);
  }
  assert.deepEqual(diagnostics.boundedDiagnosticRecords('not-an-array', {}), []);

  for (const [start, end] of [[0, 10], [5.5, 5.5], [10, 2], [NaN, 4], [null, 1]]) {
    assert.equal(diagnostics.monotonicDurationMs(start, end), runtime.monotonicDurationMs(start, end));
  }
  assert.deepEqual(diagnostics.recordDuration({ a: 1 }, 'scanMs', 100, 150), runtime.recordDuration({ a: 1 }, 'scanMs', 100, 150));
  assert.deepEqual(diagnostics.recordDuration(null, 'scanMs', 100, 150), null);

  assert.deepEqual(
    diagnostics.updateVisibilityDriftTracker(diagnostics.createVisibilityDriftTracker(1000, true), 1500, false, 1200),
    runtime.updateVisibilityDriftTracker(runtime.createVisibilityDriftTracker(1000, true), 1500, false, 1200),
  );
  assert.deepEqual(
    diagnostics.updateVisibilityDriftTracker(null, 2000, true, NaN),
    runtime.updateVisibilityDriftTracker(null, 2000, true, NaN),
  );

  const summaries = [
    { status: 'authoritative', memberRows: 12, icons: 3, newDeltas: { attacks: 1, raids: 0, players: 1 }, scanMs: 42, generation: 2, queueAge: 5 },
    { status: 'rejected', rejectionReason: 'no-member-table' },
    { status: 'rejected', rejectionReason: 'bogus-reason' },
    {},
    null,
  ];
  for (const summary of summaries) {
    assert.equal(diagnostics.buildScanSummaryLog(summary), runtime.buildScanSummaryLog(summary));
  }

  const failures = [
    [{}, WORLD, 1700000000000, 'net-error', 4, 'no-member-table', { memberRows: 9, rows: 9, icons: 2 }],
    [{}, 'TS1.Travian.COM', 1700000000000, 'boom', 0, 'bogus-reason', { memberRows: -3, rows: 1e9, icons: 1.7 }],
    [{}, WORLD, 1700000000000, 'boom', 0, undefined, undefined],
    [null, WORLD, 1700000000000, 'boom', 2, 'duplicate-player-id', null],
  ];
  for (const args of failures) {
    assert.deepEqual(diagnostics.recordFailure(...args), runtime.recordFailure(...args), `recordFailure mismatch ${JSON.stringify(args.slice(1))}`);
  }
});
