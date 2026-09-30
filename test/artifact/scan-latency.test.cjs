'use strict';

// Deterministic node:test artifact proof for the 1.0.4 bounded-scan fix.
//
// Loads the BUILT userscript (dist/travian-attack-alert.user.js) so every
// assertion locks shipped behavior, and drives the real envelope commit with
// the same synthetic 10,000-terminal legacy ledger the Chromium spec seeds.
// The relative oracle is a byte ratio against the pre-migration state (>=10x
// reduction) plus absolute phase caps, so it never depends on host CPU timing.
//
// Run: node --test test/artifact/scan-latency.test.cjs

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_FILE = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');
const runtime = require(DIST_FILE);
const { buildLegacyTerminalEnvelope } = require(path.join(ROOT, 'test', 'fixtures', 'performance', 'legacy-terminal-envelope.cjs'));

const WORLD = 'scan-latency.test';
const TERMINALS = 10000;
const CAP_BYTES = 512 * 1024;
const PHASE_CAP_MS = 750;

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get: (key) => (values.has(key) ? values.get(key) : undefined),
    set: (key, value) => { values.set(key, String(value)); },
    delete: (key) => { values.delete(key); },
  };
}

function commitLegacy(terminalCount, timings) {
  const storage = memoryStorage();
  const legacyRaw = buildLegacyTerminalEnvelope(WORLD, terminalCount);
  const legacyBytes = Buffer.byteLength(legacyRaw, 'utf8');
  const parsed = runtime.parseMonitorEnvelopeV1(legacyRaw, WORLD);
  assert.equal(parsed.ok, true, `synthetic legacy envelope must parse: ${JSON.stringify(parsed)}`);
  const committed = runtime.commitMonitorEnvelopeV1({
    world: WORLD,
    storage,
    currentEnvelope: null,
    candidateEnvelope: parsed.envelope,
    expectedGeneration: -1,
    maxSerializedBytes: CAP_BYTES,
    timings,
  });
  return { storage, legacyBytes, committed };
}

function persistedAccounting(storage) {
  const raw = storage.get(runtime.monitorActiveStorageKey(WORLD));
  const parsed = runtime.parseMonitorEnvelopeV1(raw, WORLD);
  assert.equal(parsed.ok, true, `persisted envelope must parse: ${JSON.stringify(parsed)}`);
  return { raw, accounting: parsed.envelope.metrics.deliveryAccounting, envelope: parsed.envelope };
}

test('commit bounds a 10,000-terminal legacy ledger to <=512 detail plus one summary and stays bounded on the next commit', () => {
  const { storage, legacyBytes, committed } = commitLegacy(TERMINALS, {});
  assert.equal(committed.outcome, 'ok');
  const first = persistedAccounting(storage);
  const firstBytes = Buffer.byteLength(first.raw, 'utf8');
  assert.ok(firstBytes < CAP_BYTES, `bounded below the 512 KiB ceiling, got ${firstBytes} bytes`);
  assert.ok(firstBytes * 10 < legacyBytes, `at least 10x byte reduction, got ${firstBytes} from ${legacyBytes}`);
  assert.ok(first.accounting.terminal.length <= 512, `<=512 detailed terminal records, got ${first.accounting.terminal.length}`);
  assert.equal(first.accounting.compactedTerminalTotals.length, 1, 'exactly one canonical bounded summary');
  assert.equal(
    first.accounting.terminal.length + first.accounting.compactedTerminalTotals[0].count,
    TERMINALS,
    'terminal records conserved across detail plus summary',
  );

  const nextCandidate = runtime.createMonitorEnvelopeV1(WORLD, Object.assign({}, first.envelope, {
    generation: first.envelope.generation + 1,
  }));
  const next = runtime.commitMonitorEnvelopeV1({
    world: WORLD,
    storage,
    currentEnvelope: first.envelope,
    candidateEnvelope: nextCandidate,
    expectedGeneration: first.envelope.generation,
    maxSerializedBytes: CAP_BYTES,
  });
  assert.equal(next.outcome, 'ok');
  const second = persistedAccounting(storage);
  assert.ok(Buffer.byteLength(second.raw, 'utf8') < CAP_BYTES, 'the next commit remains bounded');
  assert.ok(second.accounting.terminal.length <= 512, 'the next commit keeps <=512 detailed terminal records');
});

test('phase timings are finite bounded redacted numerics with no payload or URL', () => {
  const timings = {};
  const { committed } = commitLegacy(2000, timings);
  assert.equal(committed.outcome, 'ok');
  assert.deepEqual(Object.keys(timings).sort(), ['activeWriteMs', 'backupWriteMs', 'normalizeMs']);
  for (const [key, value] of Object.entries(timings)) {
    assert.equal(Number.isFinite(value), true, `${key} must be a finite number, got ${value}`);
    assert.ok(value >= 0 && value < PHASE_CAP_MS, `${key}=${value} must stay below ${PHASE_CAP_MS} ms`);
  }
  const serialized = JSON.stringify(timings);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /webhook|token|payload|sourceEventIds/iu);
});
