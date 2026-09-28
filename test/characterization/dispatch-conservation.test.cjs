'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const impl = require(path.join(SRC, 'dispatch-impl.js'));
const dispatch = require(path.join(SRC, 'dispatch.js'));
const conservationImpl = require(path.join(SRC, 'conservation-impl.js'));
const conservation = require(path.join(SRC, 'conservation.js'));
const envelopeImpl = require(path.join(SRC, 'envelope-impl.js'));
const migrationImpl = require(path.join(SRC, 'migration-impl.js'));
const constants = require(path.join(SRC, 'constants.js'));

const DISPATCH_CONTRACT = [
  'buildDispatchPlanV1', 'buildDispatchRequestV1',
  'ackHashForDiscordMessageId', 'applyDispatchPlanTransitionV1',
  'createDispatchPlanInAccountingV1', 'commitDispatchPlanTransitionV1',
];
const CONSERVATION_CONTRACT = [
  'sourceEventIdFromTuple', 'sourceEventTuple',
  'createMonitorQueueEvent', 'coalesceMonitorPendingEvents',
  'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
  'resumeTerminalCompactionV1',
];

function sourceId(playerId, eventType, scanSequence) {
  return migrationImpl.sourceEventIdFromTuple({
    world: 'dispatch.test', playerId, eventType,
    acceptedGeneration: 1, scanSequence, attackDelta: eventType === 'raid' ? 0 : 1,
    raidDelta: eventType === 'raid' ? 1 : 0,
  });
}

const ID_A = sourceId('7', 'attack', 1);
const ID_B = sourceId('7', 'attack', 2);
const ID_C = sourceId('9', 'raid', 3);

function dispatchEvents() {
  return [
    { eventId: 'e-1', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: [ID_B, ID_A] },
    { eventId: 'e-2', eventType: 'raid', addedAttackCount: 0, addedRaidCount: 1, sourceEventIds: [ID_C] },
  ];
}

function memoryStorage() {
  const map = new Map();
  return { get: (key) => map.get(key), set: (key, value) => { map.set(key, value); }, delete: (key) => { map.delete(key); } };
}

function baseEnvelope() {
  return runtime.createMonitorEnvelopeV1('dispatch.test', { nowMs: 1000 });
}

test('dispatch and conservation expose exact contracts without runtime-api', () => {
  assert.deepEqual(Object.keys(dispatch).sort(), [...DISPATCH_CONTRACT].sort());
  assert.deepEqual(Object.keys(conservation).sort(), [...CONSERVATION_CONTRACT].sort());
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'dispatch.js'), 'utf8'), /runtime-api/u);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'conservation.js'), 'utf8'), /runtime-api/u);
  assert.deepEqual(constants.DISPATCH_CHUNK_STATES, runtime.DISPATCH_CHUNK_STATES);
});

test('dispatch plan construction preserves batch, chunk, and request identities', () => {
  const plan = impl.buildDispatchPlanV1(dispatchEvents(), { chunkSize: 2, generation: 4 });
  assert.deepEqual(plan, runtime.buildDispatchPlanV1(dispatchEvents(), { chunkSize: 2, generation: 4 }));
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(plan.chunks[0].sourceEventIds, [ID_A, ID_B]);
  const request = impl.buildDispatchRequestV1(plan.chunks[0], { kind: 'probe' }, 'owner-1', 7);
  assert.deepEqual(request, runtime.buildDispatchRequestV1(plan.chunks[0], { kind: 'probe' }, 'owner-1', 7));
  assert.equal(impl.ackHashForDiscordMessageId('message-1'), runtime.ackHashForDiscordMessageId('message-1'));
});

test('dispatch plan transitions preserve claim, response, recover, and manual flows', () => {
  const plan = runtime.buildDispatchPlanV1(dispatchEvents(), { chunkSize: 2 });
  const chunkId = plan.chunks[0].chunkId;
  const claim = { type: 'claim', chunkId, generation: plan.generation, ownerId: 'owner-1', term: 7, payload: { kind: 'probe' } };
  const claimed = impl.applyDispatchPlanTransitionV1(plan, claim);
  assert.deepEqual(claimed, runtime.applyDispatchPlanTransitionV1(plan, claim));
  assert.equal(claimed.chunks[0].state, 'sending');
  const ack = { type: 'response', chunkId, generation: claimed.generation, ownerId: 'owner-1', term: 7, status: 200, messageId: 'message-1' };
  assert.deepEqual(
    impl.applyDispatchPlanTransitionV1(claimed, ack),
    runtime.applyDispatchPlanTransitionV1(claimed, ack),
  );
  assert.equal(impl.applyDispatchPlanTransitionV1(claimed, ack).chunks[0].state, 'acknowledged');
  const recover = { type: 'recover', chunkId, generation: claimed.generation };
  assert.deepEqual(
    impl.applyDispatchPlanTransitionV1(claimed, recover),
    runtime.applyDispatchPlanTransitionV1(claimed, recover),
  );
  assert.equal(impl.applyDispatchPlanTransitionV1(plan, { type: 'bogus' }), null);
  assert.equal(impl.applyDispatchPlanTransitionV1(plan, { type: 'claim', generation: -1 }), null);
});

test('dispatch accounting preserves creation, duplicate guard, and commit settlement', () => {
  const created = impl.createDispatchPlanInAccountingV1(baseEnvelope(), dispatchEvents(), { chunkSize: 2 });
  assert.deepEqual(created, runtime.createDispatchPlanInAccountingV1(baseEnvelope(), dispatchEvents(), { chunkSize: 2 }));
  assert.equal(created.outcome, 'created');
  const duplicate = impl.createDispatchPlanInAccountingV1(created.envelope, dispatchEvents(), { chunkSize: 2 });
  assert.equal(duplicate.outcome, 'duplicate-active-plan');
  assert.equal(
    duplicate.outcome,
    runtime.createDispatchPlanInAccountingV1(created.envelope, dispatchEvents(), { chunkSize: 2 }).outcome,
  );
  const commitTransition = (envelope, storage, plan) => ({
    currentEnvelope: envelope, batchId: plan.batchId,
    transition: { type: 'claim', chunkId: plan.chunks[0].chunkId, generation: plan.generation, ownerId: 'owner-1', term: 7, payload: {} },
    storage, beforeCommit: () => true,
  });
  // Frozen legacy quirk: the candidate reuses the live accounting reference,
  // so its integrity is stale by construction and every commit settles as
  // corrupt-active; parity requires the identical outcome, not success. Each
  // attempt also needs a pristine envelope because the legacy path mutates it.
  const implCreated = impl.createDispatchPlanInAccountingV1(baseEnvelope(), dispatchEvents(), { chunkSize: 2 });
  const runtimeCreated = runtime.createDispatchPlanInAccountingV1(baseEnvelope(), dispatchEvents(), { chunkSize: 2 });
  const expected = runtime.commitDispatchPlanTransitionV1(commitTransition(runtimeCreated.envelope, memoryStorage(), runtimeCreated.plan));
  const actual = impl.commitDispatchPlanTransitionV1(commitTransition(implCreated.envelope, memoryStorage(), implCreated.plan));
  assert.deepEqual(actual, expected);
  assert.equal(actual.outcome, expected.outcome);
  assert.equal(actual.memorySwapped, false);
});

test('conservation preserves the 7-symbol monitor lineage and compaction contract', () => {
  const legacy = {};
  for (const name of CONSERVATION_CONTRACT) legacy[name] = runtime[name];
  const tuple = { world: 'dispatch.test', playerId: '7', eventType: 'attack', acceptedGeneration: 1, scanSequence: 1, attackDelta: 1, raidDelta: 0 };
  assert.equal(conservation.sourceEventIdFromTuple(tuple), legacy.sourceEventIdFromTuple(tuple));
  assert.deepEqual(conservation.sourceEventTuple(tuple), legacy.sourceEventTuple(tuple));
  const queued = { world: 'dispatch.test', playerId: '7', eventType: 'attack', addedAttackCount: 1, sourceEventIds: [ID_A] };
  assert.deepEqual(conservation.createMonitorQueueEvent(queued, { queuedAtMs: 5 }), legacy.createMonitorQueueEvent(queued, { queuedAtMs: 5 }));
  const first = conservation.createMonitorQueueEvent({ world: 'dispatch.test', playerId: '7', eventType: 'attack', addedAttackCount: 1, sourceEventIds: [ID_A] }, { observedAtMs: 5, queuedAtMs: 6 });
  const second = conservation.createMonitorQueueEvent({ world: 'dispatch.test', playerId: '7', eventType: 'attack', addedAttackCount: 2, sourceEventIds: [ID_B] }, { observedAtMs: 5, queuedAtMs: 6 });
  assert.deepEqual(conservation.coalesceMonitorPendingEvents([first, second], 512, 9), legacy.coalesceMonitorPendingEvents([first, second], 512, 9));
  assert.equal(conservation.coalesceMonitorPendingEvents([first, second], 512, 9).events.length, 1);
  assert.deepEqual(conservation.compactDeliveryAccountingV1(baseEnvelope(), {}), legacy.compactDeliveryAccountingV1(baseEnvelope(), {}));
  assert.equal(conservation.resumeTerminalCompactionV1, conservation.compactDeliveryAccountingV1);
  assert.equal(legacy.resumeTerminalCompactionV1, legacy.compactDeliveryAccountingV1);
});

test('conservation compaction preserves the prepare and resume settlement path', () => {
  const terminal = [];
  for (let sequence = 1; sequence <= 513; sequence += 1) {
    terminal.push({ eventId: `t-${sequence}`, terminalSequence: sequence, addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: [`terminal-${sequence}`] });
  }
  function crowdedEnvelope() {
    const envelope = runtime.createMonitorEnvelopeV1('dispatch.test', { nowMs: 1000 });
    envelope.metrics.deliveryAccounting.terminal = terminal;
    return envelope;
  }
  const options = { operationId: 'op-1', ownerId: 'owner-1' };
  // The legacy compaction path mutates its input envelope, so each side
  // prepares and resumes a pristine (but deep-equal) envelope.
  const prepared = conservation.prepareTerminalCompactionV1(crowdedEnvelope(), options);
  const legacyPrepared = runtime.prepareTerminalCompactionV1(crowdedEnvelope(), options);
  assert.deepEqual(prepared, legacyPrepared);
  assert.equal(prepared.outcome, 'prepared');
  const resumed = conservation.resumeTerminalCompactionV1(prepared.envelope, options);
  const legacyResumed = runtime.resumeTerminalCompactionV1(legacyPrepared.envelope, options);
  assert.deepEqual(resumed, legacyResumed);
  assert.equal(resumed.outcome, 'compacted');
  assert.equal(resumed.totals.count, 1);
});

test('conservation holds no independent logic: every symbol re-exports envelope or migration', () => {
  const envelopeNames = ['coalesceMonitorPendingEvents', 'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1', 'resumeTerminalCompactionV1', 'createMonitorQueueEvent'];
  for (const name of envelopeNames) assert.equal(conservationImpl[name], envelopeImpl[name], `${name} must re-export envelope-impl`);
  for (const name of ['sourceEventIdFromTuple', 'sourceEventTuple']) assert.equal(conservationImpl[name], migrationImpl[name], `${name} must re-export migration-impl`);
  const source = fs.readFileSync(path.join(SRC, 'conservation-impl.js'), 'utf8');
  assert.doesNotMatch(source, /\bfunction\b/);
  assert.match(source, /require\(['"]\.\/envelope-impl\.js['"]\)/u);
  assert.match(source, /require\(['"]\.\/migration-impl\.js['"]\)/u);
  assert.doesNotMatch(source, /require\(['"]\.\/runtime(-api)?\.js['"]\)/u);
});

// ---------------------------------------------------------------------------
// Task 1 (scan-webhook-latency) — bounded terminal-accounting characterization.
//
// v1.0.3 keeps the newest 512 detailed terminal records but copies EVERY
// historical sourceEventId into compactedTerminalTotals, so the persisted
// envelope grows with acknowledged history rather than staying bounded. These
// tests pin the DESIRED canonical result on the untouched v1.0.3 kernel: one
// cumulative bounded summary, the empty sourceEventIds compatibility sentinel,
// conserved totals, a deterministic lineage digest, idempotent re-normalization,
// and byte-identical active queues. They are intentionally red until Tasks 2-4
// implement the bounded normalization; the failure messages name the defect.
// ---------------------------------------------------------------------------

function canonicalTerminalId(sequence) {
  return migrationImpl.sourceEventIdFromTuple({
    world: 'dispatch.test', playerId: String((sequence % 977) + 1),
    eventType: sequence % 3 === 0 ? 'raid' : 'attack', acceptedGeneration: 1,
    scanSequence: sequence, attackDelta: sequence % 3 === 0 ? 0 : 1,
    raidDelta: sequence % 3 === 0 ? 1 : 0,
  });
}

function terminalRange(fromSequence, toSequence) {
  const terminal = [];
  for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
    const raid = sequence % 3 === 0;
    terminal.push({
      eventId: `terminal-${sequence}`, terminalSequence: sequence,
      stage: 'acknowledged', terminalStatus: 'acknowledged',
      addedAttackCount: raid ? 0 : 1, addedRaidCount: raid ? 1 : 0,
      sourceEventIds: [canonicalTerminalId(sequence)],
    });
  }
  return terminal;
}

function rangeTotals(fromSequence, toSequence) {
  let count = 0; let attackDelta = 0; let raidDelta = 0;
  for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
    count += 1;
    if (sequence % 3 === 0) raidDelta += 1; else attackDelta += 1;
  }
  return { count, attackDelta, raidDelta };
}

function activeQueueRecords(count, lineagePerRecord) {
  const names = ['pending', 'inFlight', 'failed', 'uncertain'];
  const queues = { pending: [], inFlight: [], failed: [], uncertain: [] };
  for (let index = 0; index < count; index += 1) {
    const ids = [];
    for (let offset = 0; offset < lineagePerRecord; offset += 1) ids.push(canonicalTerminalId(20000 + index * lineagePerRecord + offset));
    queues[names[index % names.length]].push({
      eventId: `queue-${index}`, playerId: String(index + 1), eventType: 'attack',
      addedAttackCount: 1, addedRaidCount: 0, sourceEventIds: ids,
      sourceEventTuples: ids.map((id) => migrationImpl.sourceEventTuple(migrationImpl.decodeSourceEventId(id))),
    });
  }
  return queues;
}

const ACCOUNTING_DEFAULTS = {
  recoverable: [], terminal: [], compactedTerminalTotals: [], dispatchPlans: [],
  compactedThroughTerminalSequence: 0, nextTerminalSequence: 1,
  compactionClaim: null, lastCompaction: null,
};

function monitorEnvelope(accounting, queues) {
  const envelope = runtime.createMonitorEnvelopeV1('dispatch.test', {
    nowMs: 1000,
    pending: (queues && queues.pending) || [], inFlight: (queues && queues.inFlight) || [],
    failed: (queues && queues.failed) || [], uncertain: (queues && queues.uncertain) || [],
  });
  if (!accounting) return envelope;
  envelope.metrics.deliveryAccounting = Object.assign({}, ACCOUNTING_DEFAULTS, accounting);
  const roundTripped = runtime.parseMonitorEnvelopeV1(runtime.serializeMonitorEnvelopeV1(envelope), 'dispatch.test');
  assert.equal(roundTripped.ok, true, `fixture envelope must be parseable: ${JSON.stringify(roundTripped)}`);
  return roundTripped.envelope;
}

function compactOnce(envelope, options) {
  const prepared = runtime.prepareTerminalCompactionV1(envelope, options);
  assert.equal(prepared.outcome, 'prepared', 'fixture must prepare a compaction claim');
  const resumed = runtime.resumeTerminalCompactionV1(prepared.envelope, options);
  assert.equal(resumed.outcome, 'compacted', 'fixture must settle the prepared claim');
  return resumed;
}

function digestOf(summary) {
  const keys = Object.keys(summary).filter((key) => /digest/iu.test(key) && typeof summary[key] === 'string' && summary[key] !== '');
  assert.ok(keys.length >= 1, `compacted summary must expose a deterministic lineage digest; got keys ${JSON.stringify(Object.keys(summary))}`);
  return summary[keys[0]];
}

function assertBoundedSummary(summary, expected, label) {
  const retained = Array.isArray(summary.sourceEventIds) ? summary.sourceEventIds.length : `${typeof summary.sourceEventIds} (not an array)`;
  assert.ok(Array.isArray(summary.sourceEventIds) && summary.sourceEventIds.length === 0,
    `${label}: compacted summary must use the empty sourceEventIds compatibility sentinel, never historical full-ID arrays (retained ${retained})`);
  assert.equal(summary.count, expected.count, `${label}: terminal record count must be conserved`);
  assert.equal(summary.attackDelta, expected.attackDelta, `${label}: attack delta must be conserved`);
  assert.equal(summary.raidDelta, expected.raidDelta, `${label}: raid delta must be conserved`);
  assert.equal(summary.sourceEventCount, expected.count,
    `${label}: bounded summary must expose sourceEventCount instead of enumerating every historical ID`);
  assert.equal(typeof digestOf(summary), 'string', `${label}: deterministic lineage digest required`);
}

function queueSnapshot(envelope) {
  return {
    pending: JSON.parse(JSON.stringify(envelope.pending)),
    inFlight: JSON.parse(JSON.stringify(envelope.inFlight)),
    failed: JSON.parse(JSON.stringify(envelope.failed)),
    uncertain: JSON.parse(JSON.stringify(envelope.uncertain)),
  };
}

function normalizeForPersistence(envelope, options) {
  const kernel = envelopeImpl.normalizeMonitorEnvelopeForPersistence || runtime.normalizeMonitorEnvelopeForPersistence;
  assert.equal(typeof kernel, 'function',
    'missing canonical persistence normalization: normalizeMonitorEnvelopeForPersistence() must replace historical compacted sourceEventIds with a bounded digest summary');
  const result = kernel(envelope, options);
  const normalized = result && result.envelope ? result.envelope : result;
  assert.ok(normalized && normalized.metrics && normalized.metrics.deliveryAccounting,
    'normalizeMonitorEnvelopeForPersistence must return the normalized envelope (or { envelope })');
  return normalized;
}

test('terminal compaction bounds 10,000 acknowledged records to 512 plus one summary', () => {
  const envelope = monitorEnvelope({ terminal: terminalRange(1, 10000) });
  const result = compactOnce(envelope, { operationId: 'bound-10k', ownerId: 'owner-1' });
  const accounting = result.envelope.metrics.deliveryAccounting;
  assert.ok(accounting.terminal.length <= 512,
    `at most 512 detailed terminal records may remain, got ${accounting.terminal.length}`);
  assert.equal(accounting.compactedTerminalTotals.length, 1,
    `compactedTerminalTotals must be exactly one cumulative summary, got ${accounting.compactedTerminalTotals.length}`);
  assertBoundedSummary(accounting.compactedTerminalTotals[0], rangeTotals(1, 9488), '10k terminal');
  assert.equal(accounting.terminal.length + accounting.compactedTerminalTotals[0].count, 10000,
    'terminal record count must be conserved across detail and summary');
});

test('repeated compaction cycles canonicalize into one bounded summary', () => {
  const first = compactOnce(monitorEnvelope({ terminal: terminalRange(1, 600) }), { operationId: 'cycle-1', ownerId: 'owner-1' });
  const afterFirst = first.envelope.metrics.deliveryAccounting;
  const second = compactOnce(monitorEnvelope({
    terminal: afterFirst.terminal.concat(terminalRange(601, 1200)),
    compactedTerminalTotals: afterFirst.compactedTerminalTotals,
    compactedThroughTerminalSequence: afterFirst.compactedThroughTerminalSequence,
    nextTerminalSequence: 1201,
  }), { operationId: 'cycle-2', ownerId: 'owner-1' });
  const accounting = second.envelope.metrics.deliveryAccounting;
  assert.equal(accounting.compactedTerminalTotals.length, 1,
    `compactedTerminalTotals must not grow once per compaction cycle, got ${accounting.compactedTerminalTotals.length}`);
  assertBoundedSummary(accounting.compactedTerminalTotals[0], rangeTotals(1, 688), 'two cycles');
  assert.equal(accounting.terminal.length + accounting.compactedTerminalTotals[0].count, 1200,
    'terminal record count must be conserved across repeated cycles');
});

test('legacy summaries with thousands of historical IDs migrate to the empty sentinel idempotently', () => {
  const legacyIds = [];
  for (let sequence = 1; sequence <= 5000; sequence += 1) legacyIds.push(canonicalTerminalId(sequence));
  const legacy = monitorEnvelope({
    terminal: terminalRange(5001, 5512),
    compactedTerminalTotals: [Object.assign({ from: 1, to: 5000, sourceEventIds: legacyIds }, rangeTotals(1, 5000))],
    compactedThroughTerminalSequence: 5000, nextTerminalSequence: 5513,
  }, activeQueueRecords(512, 1));
  const before = queueSnapshot(legacy);
  const migrated = normalizeForPersistence(legacy, { operationId: 'legacy-1', ownerId: 'owner-1' });
  const summary = migrated.metrics.deliveryAccounting.compactedTerminalTotals[0];
  assertBoundedSummary(summary, rangeTotals(1, 5000), 'legacy 5k summary');
  const again = normalizeForPersistence(legacy, { operationId: 'legacy-2', ownerId: 'owner-1' });
  assert.equal(digestOf(again.metrics.deliveryAccounting.compactedTerminalTotals[0]), digestOf(summary),
    'lineage digest must be deterministic for identical legacy input');
  const repeated = normalizeForPersistence(migrated, { operationId: 'legacy-3', ownerId: 'owner-1' });
  assert.deepEqual(repeated.metrics.deliveryAccounting.compactedTerminalTotals, migrated.metrics.deliveryAccounting.compactedTerminalTotals,
    'second normalization must be idempotent');
  assert.deepEqual(queueSnapshot(repeated), before, 'active queues must be byte-identical after normalization');
});

test('an interrupted prepared compaction claim replays into the bounded summary', () => {
  const prepared = runtime.prepareTerminalCompactionV1(monitorEnvelope({ terminal: terminalRange(1, 10000) }), { operationId: 'interrupted', ownerId: 'owner-1' });
  assert.equal(prepared.outcome, 'prepared');
  const roundTripped = runtime.parseMonitorEnvelopeV1(runtime.serializeMonitorEnvelopeV1(prepared.envelope), 'dispatch.test');
  assert.equal(roundTripped.ok, true, `prepared envelope must survive a reload round-trip, got ${JSON.stringify(roundTripped)}`);
  const resumed = runtime.resumeTerminalCompactionV1(roundTripped.envelope, { operationId: 'interrupted', ownerId: 'owner-1' });
  assert.equal(resumed.outcome, 'compacted');
  const accounting = resumed.envelope.metrics.deliveryAccounting;
  assert.equal(accounting.compactionClaim, null, 'a resolved compaction claim must be cleared');
  assertBoundedSummary(accounting.compactedTerminalTotals[0], rangeTotals(1, 9488), 'interrupted replay');
});

test('terminal compaction preserves active queues carrying expanded lineage', () => {
  const envelope = monitorEnvelope({ terminal: terminalRange(1, 600) }, activeQueueRecords(512, 20));
  const before = queueSnapshot(envelope);
  const result = compactOnce(envelope, { operationId: 'expanded', ownerId: 'owner-1' });
  assert.deepEqual(queueSnapshot(result.envelope), before,
    'active queue records with expanded lineage must be byte-identical after terminal compaction');
  const retainedLineage = result.envelope.metrics.deliveryAccounting.compactedTerminalTotals[0].sourceEventIds;
  assert.ok(Array.isArray(retainedLineage) && retainedLineage.length === 0,
    `historical terminal lineage must not be retained in the compacted summary (retained ${Array.isArray(retainedLineage) ? retainedLineage.length : typeof retainedLineage})`);
});
