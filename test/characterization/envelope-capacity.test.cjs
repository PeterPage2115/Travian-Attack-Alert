'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const kernel = require(path.join(root, 'src/envelope-impl.js'));
const runtime = require(path.join(root, 'src/runtime.js'));
const migration = require(path.join(root, 'src/migration-impl.js'));
const world = 'capacity.test';
const ceiling = 512 * 1024;
const bytes = value => Buffer.byteLength(value, 'utf8');

function store() {
  const data = new Map();
  let fault = null;
  return {
    data,
    fail(mode, key) { fault = { mode, key, skip: mode === 'readback' }; },
    get(key) { if (fault?.mode === 'readback' && fault.key === key) { if (fault.skip) fault.skip = false; else { fault = null; return 'corrupt'; } } return data.get(key); },
    set(key, value) { if (fault?.mode === 'write' && fault.key === key) { fault = null; throw Error('injected write failure'); } data.set(key, value); },
    delete(key) { data.delete(key); },
  };
}

function event(id = 'e-1', length = 0) {
  const sourceEventId = migration.sourceEventIdFromTuple({ world, playerId: '7', eventType: 'attack', acceptedGeneration: 1, scanSequence: 1, attackDelta: 1, raidDelta: 0 });
  return { eventId: id, world, playerId: '7', eventType: 'attack', addedAttackCount: 1, addedRaidCount: 0,
    sourceEventIds: [sourceEventId], sourceEventTuples: [migration.sourceEventTuple(migration.decodeSourceEventId(sourceEventId))], name: '界'.repeat(length) };
}

function oversizedRecords() {
  return [7, 8, 9].map((playerId, index) => {
    const record = event(`e-${index + 1}`, 180000);
    const id = migration.sourceEventIdFromTuple({ world, playerId: String(playerId), eventType: 'attack', acceptedGeneration: 1, scanSequence: index + 1, attackDelta: 1, raidDelta: 0 });
    return { ...record, playerId: String(playerId), sourceEventIds: [id], sourceEventTuples: [migration.sourceEventTuple(migration.decodeSourceEventId(id))] };
  });
}

function envelope(overrides = {}) { return kernel.createMonitorEnvelopeV1(world, { nowMs: 1000, ...overrides }); }
function commit(api, storage, candidate, current = null, options = {}) {
  return api.commitMonitorEnvelopeV1({ world, storage, currentEnvelope: current, candidateEnvelope: candidate,
    expectedGeneration: current ? current.generation : -1, ...options });
}

test('derivable tuples are elided from persisted queues and accounting without losing identity', () => {
  for (const api of [kernel, runtime]) {
    // Given a canonical queue record whose tuple is redundant.
    const storage = store();
    const candidate = envelope({ pending: [event()] });
    candidate.metrics.deliveryAccounting.recoverable = [event()];
    const valid = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(candidate), world).envelope;
    // When it is committed and parsed again.
    const result = commit(api, storage, valid);
    // Then neither copy persists tuples, and both retain the canonical ID.
    assert.equal(result.outcome, 'ok');
    const raw = storage.get(api.monitorActiveStorageKey(world));
    assert.equal(raw.includes('sourceEventTuples'), false);
    assert.equal(api.parseMonitorEnvelopeV1(raw, world).ok, true);
    assert.deepEqual(result.envelope.pending[0].sourceEventIds, candidate.pending[0].sourceEventIds);
  }
});

test('UTF-8 capacity−1 and capacity succeed, capacity+1 fails before either write', () => {
  for (const api of [kernel, runtime]) {
    // Given an envelope with a multibyte name and a measured normalized payload.
    const current = envelope({ generation: 2 });
    const candidate = envelope({ generation: 3, pending: [event('e-1', 32)] });
    const measured = bytes(api.serializeMonitorEnvelopeV1(kernel.normalizeMonitorEnvelopeForPersistence(candidate)));
    for (const [capacity, accepted] of [[measured - 1, false], [measured, true], [measured + 1, true]]) {
      const storage = store();
      const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
      storage.set(active, api.serializeMonitorEnvelopeV1(current));
      storage.set(backup, 'original-backup');
      // When the exact byte budget is supplied to the direct writer.
      const result = commit(api, storage, candidate, current, { maxSerializedBytes: capacity });
      // Then the byte boundary decides atomically, without touching either key on rejection.
      assert.equal(result.outcome, accepted ? 'ok' : 'capacity-reject', `capacity ${capacity}, bytes ${measured}`);
      if (accepted) assert.equal(bytes(storage.get(active)), measured);
      else { assert.equal(storage.get(active), api.serializeMonitorEnvelopeV1(current)); assert.equal(storage.get(backup), 'original-backup'); }
    }
  }
});

test('terminal details shrink below 512 before an over-budget active queue is rejected', () => {
  for (const api of [kernel, runtime]) {
    // Given 512 terminal details with substantial but compactable history.
    const candidate = envelope({ generation: 1 });
    candidate.metrics.deliveryAccounting.terminal = Array.from({ length: 512 }, (_, i) => ({
      ...event(`t-${i}`, 400), terminalSequence: i + 1, stage: 'acknowledged', terminalStatus: 'acknowledged',
    }));
    const parsed = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(candidate), world).envelope;
    // When persisted with the finite default ceiling.
    const result = commit(api, store(), parsed);
    // Then it retains accounting but compacts enough detail to fit.
    assert.equal(result.outcome, 'ok');
    const accounting = result.envelope.metrics.deliveryAccounting;
    assert.ok(accounting.terminal.length < 512);
    assert.equal(accounting.terminal.length + accounting.compactedTerminalTotals[0].count, 512);
    assert.ok(bytes(api.serializeMonitorEnvelopeV1(result.envelope)) <= ceiling);
  }
});

test('oversized scan/enqueue rejects without touching active or backup or dropping recoverable work', () => {
  for (const api of [kernel, runtime]) {
    // Given a legacy active envelope with irreducible recoverable lineage.
    const storage = store(); const current = envelope({ generation: 3, pending: [event('e-1', 180000)] });
    const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
    storage.set(active, api.serializeMonitorEnvelopeV1(current)); storage.set(backup, 'backup-sentinel');
    const candidate = envelope({ ...current, generation: 4 });
    // When a no-delta scan commits without a custom byte override.
    const result = api.commitMonitorEnvelope({ currentEnvelope: current, transition: { outcome: 'ok', baselineByPlayerId: {}, eligibleEvents: [] }, storage });
    const direct = commit(api, storage, candidate, current);
    // Then both paths reject, and neither key changes.
    assert.equal(result.outcome, 'capacity-reject'); assert.equal(direct.outcome, 'capacity-reject');
    for (const rejection of [result, direct]) {
      assert.ok(rejection.serializedBytes > ceiling);
      assert.equal(rejection.capacityBytes, ceiling);
      assert.equal(rejection.recoverableRecords, 1);
      assert.equal(JSON.stringify(rejection).includes('sourceEventIds'), false);
    }
    assert.equal(storage.get(active), api.serializeMonitorEnvelopeV1(current)); assert.equal(storage.get(backup), 'backup-sentinel');
    assert.equal(current.pending.length, 1);
  }
});

test('oversized transport progresses through claim, dispatch, retry and settlement without lineage growth', () => {
  for (const api of [kernel, runtime]) {
    // Given an already oversized legacy queue with a canonical identity.
    const storage = store(); let current = envelope({ generation: 1, pending: [event('e-1', 180000)] });
    current.metrics.deliveryAccounting.recoverable = [event('e-1', 180000)];
    current = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(current), world).envelope;
    storage.set(api.monitorActiveStorageKey(world), api.serializeMonitorEnvelopeV1(current));
    storage.set(api.monitorBackupStorageKey(world), api.serializeMonitorEnvelopeV1(current));
    const identity = current.pending[0].sourceEventIds;
    const steps = [
      { type: 'pending-to-inFlight' }, { type: 'dispatch-start', eventIds: ['e-1'], atMs: 1234 },
      { type: 'retry-attempt', eventIds: ['e-1'], attemptCount: 1 },
      { type: 'retry', eventIds: ['e-1'] }, { type: 'pending-to-inFlight' },
      { type: 'dispatch-start', eventIds: ['e-1'], atMs: 2000 },
      { type: 'acknowledge', eventIds: ['e-1'] },
    ];
    for (const transition of steps) {
      // When the real transport transition commits to GM storage.
      const before = bytes(api.serializeMonitorEnvelopeV1(current));
      const result = api.commitMonitorQueueTransitionV1({ world, storage, currentEnvelope: current, transition });
      // Then the request can progress, metadata is bounded, and recoverable work never increases.
      assert.equal(result.outcome, 'ok', transition.type);
      current = result.envelope;
      const after = bytes(storage.get(api.monitorActiveStorageKey(world)));
      assert.ok(after <= before + 16 * 1024 + 256, `${transition.type}: ${before} -> ${after}`);
      assert.ok(current.pending.length + current.inFlight.length <= 1);
      if (current.pending.length + current.inFlight.length) assert.deepEqual((current.pending[0] || current.inFlight[0]).sourceEventIds, identity);
      console.log(`transport ${transition.type}: ${before} -> ${after} bytes; recoverable=${current.pending.length + current.inFlight.length}`);
    }
    assert.equal(current.inFlight.length, 0); assert.equal(current.pending.length, 0);
    assert.equal(current.metrics.deliveryAccounting.terminal.length + current.metrics.deliveryAccounting.compactedTerminalTotals.reduce((n, range) => n + range.count, 0), 1);
  }
});

test('oversized transport drains uncertainty and failure settlements without deadlock', () => {
  for (const api of [kernel, runtime]) {
    // Given a legacy oversized queue that has already been dispatched once.
    const storage = store(); let current = envelope({ generation: 1, pending: [event('e-1', 180000)] });
    const initial = api.serializeMonitorEnvelopeV1(current);
    storage.set(api.monitorActiveStorageKey(world), initial); storage.set(api.monitorBackupStorageKey(world), initial);
    const steps = [
      { type: 'pending-to-inFlight' }, { type: 'dispatch-start', atMs: 1000 },
      { type: 'uncertain', eventIds: ['e-1'], responseClass: 'network-timeout' },
      { type: 'retry', eventIds: ['e-1'] }, { type: 'pending-to-inFlight' },
      { type: 'failed', eventIds: ['e-1'] }, { type: 'requeue-failed' },
      { type: 'pending-to-inFlight' }, { type: 'dispatch-start', atMs: 2000 },
      { type: 'acknowledge', eventIds: ['e-1'] },
    ];
    for (const transition of steps) {
      // When each transport settlement commits against oversized storage.
      const before = bytes(api.serializeMonitorEnvelopeV1(current));
      const result = api.commitMonitorQueueTransitionV1({ world, storage, currentEnvelope: current, transition });
      // Then progress stays bounded and recoverable work never grows.
      assert.equal(result.outcome, 'ok', transition.type);
      current = result.envelope;
      const after = bytes(storage.get(api.monitorActiveStorageKey(world)));
      assert.ok(after <= before + 16 * 1024 + 256, `${transition.type}: ${before} -> ${after}`);
      assert.ok(current.pending.length + current.inFlight.length + current.failed.length + current.uncertain.length <= 1, transition.type);
    }
    const accounting = current.metrics.deliveryAccounting;
    assert.equal(accounting.terminal.length + accounting.compactedTerminalTotals.reduce((count, range) => count + range.count, 0), 1);
  }
});

test('oversized enqueue and unrecognized recovery mode cannot inject new lineage', () => {
  for (const api of [kernel, runtime]) {
    // Given an oversized current envelope and a changed source identity.
    const storage = store(); const current = envelope({ generation: 1, pending: [event('e-1', 180000)] });
    const injected = event('e-2', 180000); injected.sourceEventIds = [migration.sourceEventIdFromTuple({ world, playerId: '8', eventType: 'attack', acceptedGeneration: 1, scanSequence: 2, attackDelta: 1, raidDelta: 0 })];
    const candidate = envelope({ generation: 2, pending: [injected] });
    // When a direct caller pretends this is a transport commit.
    const result = commit(api, storage, candidate, current, { transportTransitionType: 'dispatch-start' });
    // Then a transition label cannot authorize new lineage.
    assert.equal(result.outcome, 'capacity-reject'); assert.equal(storage.data.size, 0);
  }
});

test('oversized dispatch-start cannot remove a pending record without settlement', () => {
  for (const api of [kernel, runtime]) {
    // Given three oversized pending records and byte-identical active/backup storage.
    const storage = store();
    const current = envelope({ generation: 1, pending: oversizedRecords() });
    const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
    const original = api.serializeMonitorEnvelopeV1(current);
    assert.ok(bytes(original) > ceiling);
    storage.set(active, original); storage.set(backup, original);
    let writes = 0;
    const originalSet = storage.set;
    storage.set = (key, value) => { writes += 1; originalSet(key, value); };
    const candidate = envelope({ ...JSON.parse(JSON.stringify(current)), generation: 2, pending: current.pending.slice(1) });
    // When a direct caller falsely labels a removal as dispatch-start.
    const result = commit(api, storage, candidate, current, { transportTransitionType: 'dispatch-start' });
    // Then recovery rejects before writing either storage key.
    assert.equal(result.outcome, 'capacity-reject');
    assert.equal(result.memorySwapped, false);
    assert.equal(storage.get(active), original); assert.equal(storage.get(backup), original);
    assert.equal(writes, 0);
  }
});

test('oversized dispatch-start permits a progress-only update', () => {
  for (const api of [kernel, runtime]) {
    // Given the same oversized three-record pending queue already in storage.
    const storage = store();
    const current = envelope({ generation: 1, pending: oversizedRecords() });
    storage.set(api.monitorActiveStorageKey(world), api.serializeMonitorEnvelopeV1(current));
    // When only an allowlisted transport progress field changes.
    const candidate = envelope({ ...JSON.parse(JSON.stringify(current)), generation: 2,
      pending: current.pending.map((record, index) => index === 0 ? { ...record, dispatchedAtMs: 1234 } : record) });
    const result = commit(api, storage, candidate, current, { transportTransitionType: 'dispatch-start' });
    // Then every recoverable identity survives the permitted commit.
    assert.equal(result.outcome, 'ok');
    assert.equal(result.envelope.pending.length, 3);
    assert.equal(result.envelope.pending[0].dispatchedAtMs, 1234);
  }
});

test('legacy oversized queue without an accounting mirror can enter inFlight and dispatch', () => {
  for (const api of [kernel, runtime]) {
    // Given a valid old envelope whose recoverable accounting is still empty.
    const storage = store(); let current = envelope({ generation: 1, pending: [event('e-1', 180000)] });
    const initial = api.serializeMonitorEnvelopeV1(current);
    storage.set(api.monitorActiveStorageKey(world), initial); storage.set(api.monitorBackupStorageKey(world), initial);
    // When the transport claims and starts its pending request.
    for (const transition of [{ type: 'pending-to-inFlight' }, { type: 'dispatch-start', atMs: 1234 }]) {
      const result = api.commitMonitorQueueTransitionV1({ currentEnvelope: current, storage, transition });
      // Then it can persist progress without duplicating the payload into accounting.
      assert.equal(result.outcome, 'ok', transition.type);
      current = result.envelope;
      assert.ok(bytes(storage.get(api.monitorActiveStorageKey(world))) <= bytes(initial) + 16 * 1024 + 256);
    }
    assert.equal(current.inFlight[0].dispatchedAtMs, 1234);
  }
});

test('oversized settlement cannot invent acknowledged accounting without reducing work', () => {
  for (const api of [kernel, runtime]) {
    // Given a legacy oversized in-flight record and an invented terminal entry.
    const current = envelope({ generation: 1, inFlight: [event('e-1', 180000)] });
    const candidate = envelope({ ...JSON.parse(JSON.stringify(current)), generation: 2 });
    candidate.metrics.deliveryAccounting.terminal = [{ ...event('invented'), terminalSequence: 1, stage: 'acknowledged', terminalStatus: 'acknowledged' }];
    candidate.metrics.deliveryAccounting.nextTerminalSequence = 2;
    const parsed = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(candidate), world).envelope;
    // When the candidate pretends to be an acknowledgment without settling the in-flight record.
    const result = commit(api, store(), parsed, current, { transportTransitionType: 'acknowledge' });
    // Then transport recovery cannot mint terminal accounting while work is unchanged.
    assert.equal(result.outcome, 'capacity-reject');
  }
});

test('oversized settlement rejects an unrelated terminal lineage before any storage write', () => {
  for (const api of [kernel, runtime]) {
    // Given three oversized records and a forged terminal entry for another source.
    const storage = store(); const records = oversizedRecords();
    const current = envelope({ generation: 3, pending: records });
    const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
    const original = api.serializeMonitorEnvelopeV1(current);
    storage.set(active, original); storage.set(backup, original);
    let writes = 0;
    const originalSet = storage.set;
    storage.set = (key, value) => { writes += 1; originalSet(key, value); };
    const candidate = envelope({ ...JSON.parse(JSON.stringify(current)), generation: 4, pending: records.slice(0, 2) });
    const unrelated = migration.sourceEventIdFromTuple({ world, playerId: '9', eventType: 'attack', acceptedGeneration: 1, scanSequence: 9, attackDelta: 1, raidDelta: 0 });
    candidate.metrics.deliveryAccounting.terminal = [{ ...event('forged'), sourceEventIds: [unrelated], terminalSequence: 1, stage: 'acknowledged', terminalStatus: 'acknowledged' }];
    candidate.metrics.deliveryAccounting.nextTerminalSequence = 2;
    // When the candidate claims an acknowledgment for the dropped third record.
    const parsed = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(candidate), world).envelope;
    const result = commit(api, storage, parsed, current, { transportTransitionType: 'acknowledge' });
    // Then it fails closed without changing either stored byte string.
    assert.equal(result.outcome, 'capacity-reject'); assert.equal(result.memorySwapped, false);
    assert.equal(writes, 0); assert.equal(storage.get(active), original); assert.equal(storage.get(backup), original);
  }
});

test('oversized settlement accepts the removed record’s own terminal lineage', () => {
  for (const api of [kernel, runtime]) {
    // Given an oversized in-flight queue eligible for a real acknowledgment.
    const storage = store(); const current = envelope({ generation: 3, inFlight: oversizedRecords() });
    const removedId = current.inFlight[2].sourceEventIds[0];
    const transition = api.applyMonitorQueueTransitionV1(current, { type: 'acknowledge', eventIds: ['e-3'] });
    assert.equal(transition.outcome, 'ok');
    // When the real transition is committed while the remaining records still exceed capacity.
    const result = commit(api, storage, transition.envelope, current, { transportTransitionType: 'acknowledge' });
    // Then the matching terminal identity permits progress, even if normalization compacts its detail.
    assert.equal(result.outcome, 'ok'); assert.equal(result.memorySwapped, true);
    assert.deepEqual(result.envelope.inFlight.map(record => record.eventId), ['e-1', 'e-2']);
    assert.equal(transition.envelope.metrics.deliveryAccounting.terminal[0].sourceEventIds[0], removedId);
  }
});

test('legacy backup recovery migrates on next commit and stale claim/corrupt pair fail closed', () => {
  for (const api of [kernel, runtime]) {
    // Given a corrupt active and a valid legacy backup containing redundant tuples.
    const storage = store(); const legacy = envelope({ generation: 2, pending: [event()] });
    const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
    storage.set(active, '{broken'); storage.set(backup, api.serializeMonitorEnvelopeV1(legacy));
    // When backup recovery runs, followed by a normal commit.
    const recovered = api.loadMonitorEnvelopeV1(world, { storage, nowMs: 1000 });
    assert.equal(recovered.outcome, 'recovered-from-backup');
    const result = commit(api, storage, envelope({ ...recovered.envelope, generation: 3 }), recovered.envelope);
    // Then legacy tuples migrate in one fenced write.
    assert.equal(result.outcome, 'ok'); assert.equal(storage.get(active).includes('sourceEventTuples'), false);
    const corrupt = store(); corrupt.set(active, '{bad'); corrupt.set(backup, '{bad');
    assert.equal(api.loadMonitorEnvelopeV1(world, { storage: corrupt, nowMs: 1000 }).blocked, true);
    const stale = envelope({ generation: 4 }); stale.metrics.deliveryAccounting.compactionClaim = { status: 'prepared', expectedGeneration: -1 };
    const staleParsed = api.parseMonitorEnvelopeV1(api.serializeMonitorEnvelopeV1(stale), world).envelope;
    const before = storage.get(active);
    assert.equal(commit(api, storage, staleParsed, result.envelope).outcome, 'corrupt-active');
    assert.equal(storage.get(active), before);
  }
});

test('write and readback failures roll back both keys', () => {
  for (const api of [kernel, runtime]) {
    for (const mode of ['write', 'readback']) {
      // Given a valid committed active/backup pair and an injected active failure.
      const storage = store(); const current = envelope({ generation: 1 });
      const active = api.monitorActiveStorageKey(world), backup = api.monitorBackupStorageKey(world);
      const original = api.serializeMonitorEnvelopeV1(current);
      storage.set(active, original); storage.set(backup, 'previous-backup'); storage.fail(mode, active);
      // When the candidate is committed.
      const result = commit(api, storage, envelope({ generation: 2 }), current);
      // Then the writer reports failure and restores both original values.
      assert.equal(result.outcome, mode === 'write' ? 'wrote-failed' : 'readback-mismatch');
      assert.equal(storage.data.get(active), original); assert.equal(storage.data.get(backup), 'previous-backup');
    }
  }
});
