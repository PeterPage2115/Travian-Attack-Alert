'use strict';

// Extracted dispatch planning kernel (plan Todo 13).
//
// Owns durable dispatch-plan construction, chunk settlement, and
// acknowledgement exactly as the legacy authority in src/runtime.js defines
// them. Envelope persistence flows only through the injected envelope seam
// (default src/envelope-impl.js, overridable via
// configureDispatchAdapters); host capabilities arrive only through caller
// options (storage, beforeCommit). This file names no host global. The
// legacy authority in src/runtime.js is byte-untouched in this task;
// differential behavior is pinned by
// test/characterization/dispatch-conservation.test.cjs.
const { PAYLOAD_CHUNK_MAX } = require('./constants.js');

const defaultEnvelope = require('./envelope-impl.js');

let envelopeApi = defaultEnvelope;
function configureDispatchAdapters(seam = {}) {
  if (Object.prototype.hasOwnProperty.call(seam, 'envelope') && seam.envelope !== undefined) envelopeApi = seam.envelope;
  return { envelope: envelopeApi !== null };
}
function resetDispatchAdapters() { envelopeApi = defaultEnvelope; }
function requireEnvelope() { if (!envelopeApi) throw new Error('dispatch envelope adapter is not configured'); return envelopeApi; }

function isPlainMonitorObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function cloneMonitorValue(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function monitorEnvelopeWithoutIntegrity(envelope) { const copy = Object.assign({}, envelope); delete copy.integrity; return copy; }
function deliveryAccountingFor(envelope) {
  const accounting = envelope && envelope.metrics && envelope.metrics.deliveryAccounting;
  return isPlainMonitorObject(accounting) ? accounting : { recoverable: [], terminal: [], compactedTerminalTotals: [], dispatchPlans: [], compactedThroughTerminalSequence: 0, nextTerminalSequence: 1, compactionClaim: null, lastCompaction: null };
}
function syncDeliveryAccounting(envelope) {
  const accounting = deliveryAccountingFor(envelope);
  accounting.recoverable = [].concat(envelope.pending || [], envelope.inFlight || [], envelope.failed || [], envelope.uncertain || []).map((event) => cloneMonitorValue(event));
  envelope.metrics = Object.assign({}, envelope.metrics, { deliveryAccounting: accounting });
  return accounting;
}

function dispatchIdentityHash(prefix, values) { return `${prefix}${requireEnvelope().checksumMonitorCanonicalValue(values)}`; }
function dispatchSourceRecords(events) {
  const records = [];
  for (const event of Array.isArray(events) ? events : []) {
    const ids = Array.isArray(event.sourceEventIds) ? event.sourceEventIds.map(String) : [];
    const attackTotal = Number(event.addedAttackCount) || 0;
    ids.forEach((sourceEventId, index) => {
      const isRaid = event.eventType === 'raid' || event.eventType === 'mixed' && index >= attackTotal || !event.eventType && attackTotal === 0 && (Number(event.addedRaidCount) || 0) > 0;
      records.push({ sourceEventId, eventId: event.eventId, addedAttackCount: isRaid ? 0 : 1, addedRaidCount: isRaid ? 1 : 0 });
    });
  }
  records.sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
  const seen = new Set();
  for (const record of records) {
    if (!record.sourceEventId || seen.has(record.sourceEventId)) throw new Error('duplicate dispatch source ID');
    seen.add(record.sourceEventId);
  }
  return records;
}
function buildDispatchPlanV1(events, options = {}) {
  const records = dispatchSourceRecords(events);
  const sourceIds = records.map((record) => record.sourceEventId);
  const batchId = dispatchIdentityHash('b1:', sourceIds);
  const requestedSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : PAYLOAD_CHUNK_MAX;
  const chunks = [];
  for (let offset = 0; offset < records.length; offset += requestedSize) {
    const chunkRecords = records.slice(offset, offset + requestedSize);
    const chunkIds = chunkRecords.map((record) => record.sourceEventId);
    chunks.push({ batchId, chunkId: dispatchIdentityHash('c1:', [batchId, chunkIds]), sourceEventIds: chunkIds, sourceCount: chunkIds.length, attackCount: chunkRecords.reduce((sum, record) => sum + record.addedAttackCount, 0), raidCount: chunkRecords.reduce((sum, record) => sum + record.addedRaidCount, 0), state: 'prepared', attempt: 0, ownerId: null, term: null, retryAtMs: null, ackHash: null, responseClass: null });
  }
  return { schemaVersion: 1, batchId, generation: Number.isInteger(options.generation) ? options.generation : 0, chunks };
}
function buildDispatchRequestV1(chunk, payload, ownerId, term) {
  const sourceEventIds = Array.isArray(chunk && chunk.sourceEventIds) ? chunk.sourceEventIds.slice() : [];
  return { batchId: chunk && chunk.batchId, chunkId: chunk && chunk.chunkId, sourceEventIds, sourceCount: sourceEventIds.length, attackCount: Number(chunk && chunk.attackCount) || 0, raidCount: Number(chunk && chunk.raidCount) || 0, ownerId: ownerId === undefined ? null : ownerId, term: term === undefined ? null : term, payload: payload || {} };
}
function ackHashForDiscordMessageId(messageId) { return dispatchIdentityHash('a1:', String(messageId)); }
function applyDispatchPlanTransitionV1(plan, transition) {
  if (!plan || !Array.isArray(plan.chunks) || !transition) return null;
  const next = JSON.parse(JSON.stringify(plan));
  const index = transition.chunkId ? next.chunks.findIndex((chunk) => chunk.chunkId === transition.chunkId) : next.chunks.findIndex((chunk) => chunk.state === 'prepared' || chunk.state === 'retryable');
  if (index < 0) return null;
  const chunk = next.chunks[index];
  const bump = () => { next.generation += 1; };
  if (transition.type === 'claim') {
    if (!['prepared', 'retryable'].includes(chunk.state) || transition.generation !== next.generation) return null;
    chunk.state = 'sending'; chunk.ownerId = String(transition.ownerId); chunk.term = transition.term; chunk.attempt += 1;
    chunk.lastRequest = buildDispatchRequestV1(chunk, transition.payload, chunk.ownerId, chunk.term);
    chunk.lastRequest.attempt = chunk.attempt; next.ownerId = chunk.ownerId; next.term = chunk.term; bump();
  } else if (transition.type === 'response') {
    if (chunk.state !== 'sending' || transition.generation !== next.generation || transition.ownerId !== chunk.ownerId || transition.term !== chunk.term) return null;
    const status = Number(transition.status);
    if (status === 200 && typeof transition.messageId === 'string' && transition.messageId.length > 0) {
      if (transition.settled === false) { chunk.state = 'uncertain'; chunk.responseClass = 'acknowledgement-unsettled'; }
      else { chunk.state = 'acknowledged'; chunk.ackHash = ackHashForDiscordMessageId(transition.messageId); chunk.messageId = undefined; }
    } else if (status === 200) { chunk.state = 'uncertain'; chunk.responseClass = String(transition.responseClass || 'malformed-json-200'); }
    else if (status === 408 || status === 429 || status >= 500 || transition.errorClass === 'network' || transition.errorClass === 'timeout') { chunk.state = 'retryable'; chunk.retryAtMs = Number.isFinite(transition.retryAtMs) ? transition.retryAtMs : null; }
    else { chunk.state = 'failed'; chunk.responseClass = String(transition.responseClass || status || 'permanent'); }
    chunk.ownerId = null; chunk.term = null; next.ownerId = null; next.term = null; bump();
  } else if (transition.type === 'recover') {
    if (chunk.state !== 'sending' || transition.generation !== next.generation) return null;
    chunk.state = 'uncertain'; chunk.responseClass = String(transition.responseClass || 'lease-lost');
    chunk.ownerId = null; chunk.term = null; next.ownerId = null; next.term = null; bump();
  } else if (transition.type === 'manual-retry') {
    if (chunk.state !== 'uncertain' || transition.generation !== next.generation) return null;
    chunk.state = 'prepared'; chunk.responseClass = null; bump();
  } else if (transition.type === 'manual-acknowledge') {
    if (chunk.state !== 'uncertain' || transition.generation !== next.generation) return null;
    chunk.state = 'acknowledged'; chunk.ackHash = ackHashForDiscordMessageId(String(transition.messageId || 'manual')); bump();
  } else return null;
  return next;
}
function createDispatchPlanInAccountingV1(envelope, events, options = {}) {
  const api = requireEnvelope();
  const base = api.createMonitorEnvelopeV1(envelope && envelope.world, envelope || {});
  const accounting = deliveryAccountingFor(base);
  const candidate = buildDispatchPlanV1(events, Object.assign({}, options, { generation: base.generation }));
  const active = accounting.dispatchPlans.some((plan) => plan.batchId === candidate.batchId && plan.chunks.some((chunk) => !['acknowledged', 'failed'].includes(chunk.state)));
  if (active) return { outcome: 'duplicate-active-plan', envelope: base, plan: accounting.dispatchPlans.find((plan) => plan.batchId === candidate.batchId) };
  const sourceIds = new Set(candidate.chunks.flatMap((chunk) => chunk.sourceEventIds));
  if (accounting.dispatchPlans.some((plan) => plan.chunks.some((chunk) => chunk.sourceEventIds.some((id) => sourceIds.has(id) && !['acknowledged', 'failed'].includes(chunk.state))))) return { outcome: 'source-already-planned', envelope: base };
  accounting.dispatchPlans = accounting.dispatchPlans.concat(candidate);
  syncDeliveryAccounting(base);
  base.generation += 1;
  base.integrity = api.checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base));
  return { outcome: 'created', envelope: base, plan: candidate };
}
function commitDispatchPlanTransitionV1(options = {}) {
  const api = requireEnvelope();
  const current = options.currentEnvelope;
  const accounting = current ? deliveryAccountingFor(current) : null;
  const plan = accounting && accounting.dispatchPlans.find((item) => item.batchId === options.batchId);
  if (!plan || typeof options.beforeCommit === 'function' && options.beforeCommit() !== true) return { outcome: 'fenced-reject', memorySwapped: false };
  const nextPlan = applyDispatchPlanTransitionV1(plan, options.transition);
  if (!nextPlan) return { outcome: 'fenced-reject', memorySwapped: false };
  const candidate = api.createMonitorEnvelopeV1(current.world, current);
  candidate.metrics.deliveryAccounting.dispatchPlans = accounting.dispatchPlans.map((item) => item.batchId === plan.batchId ? nextPlan : item);
  candidate.generation = current.generation + 1;
  return api.commitMonitorEnvelopeV1({ world: current.world, currentEnvelope: current, candidateEnvelope: candidate, expectedGeneration: current.generation, storage: options.storage, beforeCommit: options.beforeCommit });
}

module.exports = {
  configureDispatchAdapters, resetDispatchAdapters,
  buildDispatchPlanV1, buildDispatchRequestV1,
  ackHashForDiscordMessageId, applyDispatchPlanTransitionV1,
  createDispatchPlanInAccountingV1, commitDispatchPlanTransitionV1,
};
