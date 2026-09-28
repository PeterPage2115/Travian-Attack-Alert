'use strict';

// Extracted bounded envelope accounting kernel (scan-webhook-latency
// remediation): terminal compaction totals, byte-capacity normalization,
// and transport recovery gating. Pure module — no browser globals (byte
// measurement uses the host TextEncoder only). Envelope primitives arrive
// through configureEnvelopeAccountingAdapters (the configureMigrationAdapters
// precedent), so this file keeps no require edge back to src/envelope-impl.js
// and the dependency graph stays acyclic. Source-event identity is read from
// the dependency-free migration kernel.
const migration = require('./migration-impl.js');
const { sourceEventTuple, decodeSourceEventId } = migration;

const MONITOR_MAX_SERIALIZED_BYTES = 512 * 1024;
const TRANSPORT_METADATA_ALLOWANCE_BASE_BYTES = 16 * 1024;
const TRANSPORT_METADATA_ALLOWANCE_PER_RECORD_BYTES = 256;
const TRANSPORT_RECOVERY_TRANSITIONS = new Set(['pending-to-inFlight', 'dispatch-start', 'retry-attempt', 'retry', 'acknowledge', 'acknowledge-uncertain', 'failed', 'uncertain', 'requeue-failed']);
const TRANSPORT_PROGRESS_FIELDS = ['dispatchedAtMs', 'attemptCount', 'deliveryState', 'responseClass', 'status', 'reason'];

let envelopeApi = null;
function configureEnvelopeAccountingAdapters(seam = {}) {
  if (seam.envelope) envelopeApi = seam.envelope;
}
function requireEnvelope() { if (!envelopeApi) throw new Error('envelope accounting adapter is not configured'); return envelopeApi; }

function serializedEnvelopeCapacity(requested) { return Number.isInteger(requested) ? Math.min(requested, MONITOR_MAX_SERIALIZED_BYTES) : MONITOR_MAX_SERIALIZED_BYTES; }
function validCompactedSummary(range, canonicalId) {
  if (!range || typeof range !== 'object' || Array.isArray(range) || !Array.isArray(range.sourceEventIds) || !Number.isSafeInteger(range.from) || range.from < 0 || !Number.isSafeInteger(range.to) || range.to < range.from || !Number.isSafeInteger(range.count) || range.count < 1 || !Number.isFinite(range.attackDelta) || !Number.isFinite(range.raidDelta)) return false;
  if (range.sourceEventIds.length) return range.sourceEventIds.every(canonicalId) && range.sourceEventCount === undefined && range.lineageDigest === undefined;
  return Number.isSafeInteger(range.sourceEventCount) && range.sourceEventCount >= 0 && typeof range.lineageDigest === 'string' && /^[0-9a-f]{8}$/.test(range.lineageDigest);
}
function deliveryRangeDigest(entries) { return requireEnvelope().checksumMonitorCanonicalValue(entries.map(entry => ({ terminalSequence: entry.terminalSequence, sourceEventIds: entry.sourceEventIds || [], addedAttackCount: entry.addedAttackCount || 0, addedRaidCount: entry.addedRaidCount || 0 }))); }
function mergeCompactedTotals(accounting, range, rangeDigest) {
  const api = requireEnvelope();
  let previousDigest = '';
  let from = range ? range.from : null; let to = range ? range.to : null;
  let count = 0; let attackDelta = 0; let raidDelta = 0; let sourceEventCount = 0;
  for (const old of accounting.compactedTerminalTotals) {
    const digest = old.sourceEventIds.length ? api.checksumMonitorCanonicalValue({ from: old.from, to: old.to, count: old.count, attackDelta: old.attackDelta, raidDelta: old.raidDelta, sourceEventIds: old.sourceEventIds }) : old.lineageDigest;
    previousDigest = !previousDigest && !old.sourceEventIds.length ? digest : api.checksumMonitorCanonicalValue({ previousDigest, rangeDigest: digest });
    from = from === null ? old.from : Math.min(from, old.from);
    to = to === null ? old.to : Math.max(to, old.to);
    count += old.count; attackDelta += old.attackDelta; raidDelta += old.raidDelta;
    sourceEventCount += old.sourceEventIds.length ? old.sourceEventIds.length : old.sourceEventCount;
  }
  if (range) {
    previousDigest = api.checksumMonitorCanonicalValue({ previousDigest, rangeDigest });
    to = Math.max(to, range.to); count += range.count;
    attackDelta += range.attackDelta; raidDelta += range.raidDelta;
    sourceEventCount += range.sourceEventCount;
  }
  accounting.compactedTerminalTotals = count ? [{ from, to, count, attackDelta, raidDelta, sourceEventCount, lineageDigest: previousDigest, sourceEventIds: [] }] : [];
  return accounting.compactedTerminalTotals[0];
}
function compactTerminalRange(accounting, terminal, limit) {
  const range = terminal.slice(0, limit);
  const totals = { from: range[0].terminalSequence, to: range[range.length - 1].terminalSequence, count: range.length, attackDelta: range.reduce((sum, entry) => sum + (Number(entry.addedAttackCount) || 0), 0), raidDelta: range.reduce((sum, entry) => sum + (Number(entry.addedRaidCount) || 0), 0), sourceEventCount: range.reduce((sum, entry) => sum + (entry.sourceEventIds || []).length, 0) };
  const summary = mergeCompactedTotals(accounting, totals, deliveryRangeDigest(range));
  accounting.terminal = terminal.filter(entry => entry.terminalSequence > totals.to);
  accounting.compactedThroughTerminalSequence = Math.max(accounting.compactedThroughTerminalSequence || 0, totals.to);
  return summary;
}
function normalizeMonitorEnvelopeForPersistence(envelope, options = {}) {
  const api = requireEnvelope();
  let base = api.createMonitorEnvelopeV1(envelope.world, api.cloneMonitorValue(envelope));
  let accounting = api.deliveryAccountingFor(base);
  if (accounting.compactionClaim) {
    const resumed = api.resumeTerminalCompactionV1(base, options);
    if (resumed.outcome !== 'compacted') throw new Error('stale terminal compaction claim');
    base = resumed.envelope; accounting = api.deliveryAccountingFor(base);
  }
  if (accounting.compactedTerminalTotals.length > 1 || accounting.compactedTerminalTotals.some(range => range.sourceEventIds.length)) mergeCompactedTotals(accounting, null, null);
  for (const events of [base.pending, base.inFlight, base.failed, base.uncertain, accounting.recoverable, accounting.terminal]) {
    for (const event of events) {
      if (!Array.isArray(event.sourceEventIds) || !Array.isArray(event.sourceEventTuples)) continue;
      if (event.sourceEventTuples.length === event.sourceEventIds.length && event.sourceEventIds.every((id, index) => api.canonicalSerializeMonitorValue(event.sourceEventTuples[index]) === api.canonicalSerializeMonitorValue(sourceEventTuple(decodeSourceEventId(id))))) delete event.sourceEventTuples;
    }
  }
  const terminal = accounting.terminal.slice().sort((left, right) => left.terminalSequence - right.terminalSequence);
  const maxBytes = Number.isFinite(options.maxSerializedBytes) ? options.maxSerializedBytes : Infinity;
  if (new TextEncoder().encode(api.canonicalSerializeMonitorValue(base)).length > maxBytes && api.canonicalSerializeMonitorValue(accounting.recoverable) === api.canonicalSerializeMonitorValue([].concat(base.pending, base.inFlight, base.failed, base.uncertain))) accounting.recoverable = [];
  let limit = Math.max(0, terminal.length - 512);
  if (limit) compactTerminalRange(accounting, terminal, limit);
  while (accounting.terminal.length && new TextEncoder().encode(api.canonicalSerializeMonitorValue(base)).length > maxBytes) {
    const remaining = accounting.terminal.slice().sort((left, right) => left.terminalSequence - right.terminalSequence);
    compactTerminalRange(accounting, remaining, 1);
  }
  base.integrity = api.checksumMonitorCanonicalValue(api.monitorEnvelopeWithoutIntegrity(base));
  return base;
}
function recoverableMonitorRecords(envelope) { return [].concat(envelope.pending, envelope.inFlight, envelope.failed, envelope.uncertain); }
function transportRecoveryPermitted(current, candidate, type, currentBytes, candidateBytes) {
  const api = requireEnvelope();
  if (!TRANSPORT_RECOVERY_TRANSITIONS.has(type)) return false;
  const before = recoverableMonitorRecords(current); const after = recoverableMonitorRecords(candidate);
  if (after.length > before.length) return false;
  const lineage = new Map();
  for (const event of before) for (const id of event.sourceEventIds || []) lineage.set(id, (lineage.get(id) || 0) + 1);
  for (const event of after) for (const id of event.sourceEventIds || []) { const remaining = lineage.get(id) || 0; if (!remaining) return false; lineage.set(id, remaining - 1); }
  const stable = event => { const copy = Object.assign({}, event); for (const field of TRANSPORT_PROGRESS_FIELDS) delete copy[field]; return api.canonicalSerializeMonitorValue(copy); };
  const originals = new Map();
  for (const event of before) { const key = stable(event); originals.set(key, (originals.get(key) || 0) + 1); }
  for (const event of after) { const key = stable(event); const remaining = originals.get(key) || 0; if (!remaining) return false; originals.set(key, remaining - 1); }
  if (candidateBytes > currentBytes + TRANSPORT_METADATA_ALLOWANCE_BASE_BYTES + TRANSPORT_METADATA_ALLOWANCE_PER_RECORD_BYTES * before.length) return false;
  const settlement = type === 'acknowledge' || type === 'acknowledge-uncertain';
  const terminalCount = envelope => { const accounting = envelope.metrics.deliveryAccounting; return accounting.terminal.length + accounting.compactedTerminalTotals.reduce((count, range) => count + range.count, 0); };
  if (terminalCount(candidate) - terminalCount(current) !== (settlement ? before.length - after.length : 0)) return false;
  const outsideQueues = envelope => { const copy = api.cloneMonitorValue(envelope); delete copy.integrity; delete copy.generation; for (const key of ['pending', 'inFlight', 'failed', 'uncertain']) delete copy[key]; delete copy.metrics.deliveryAccounting.recoverable; if (settlement) { delete copy.metrics.deliveryAccounting.terminal; delete copy.metrics.deliveryAccounting.compactedTerminalTotals; delete copy.metrics.deliveryAccounting.compactedThroughTerminalSequence; delete copy.metrics.deliveryAccounting.nextTerminalSequence; delete copy.metrics.deliveryAccounting.lastCompaction; } return api.canonicalSerializeMonitorValue(copy); };
  return outsideQueues(current) === outsideQueues(candidate);
}

module.exports = {
  configureEnvelopeAccountingAdapters,
  serializedEnvelopeCapacity,
  validCompactedSummary,
  deliveryRangeDigest,
  compactTerminalRange,
  normalizeMonitorEnvelopeForPersistence,
  recoverableMonitorRecords,
  transportRecoveryPermitted,
  TRANSPORT_RECOVERY_TRANSITIONS,
};
