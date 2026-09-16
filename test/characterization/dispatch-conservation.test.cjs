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
