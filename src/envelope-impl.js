'use strict';

const { isLeaseFenceValid } = require('./lease-impl.js');
const migration = require('./migration-impl.js');
const { sourceEventTuple, decodeSourceEventId } = migration;

const MONITOR_ENVELOPE_SCHEMA_VERSION = 1;
const MONITOR_ACTIVE_STORAGE_KEY_PREFIX = 'travianAllianceMonitor_v1:';
const MONITOR_BACKUP_STORAGE_KEY_PREFIX = 'travianAllianceMonitorBackup_v1:';
const MONITOR_QUARANTINE_STORAGE_KEY_PREFIX = 'travianAllianceMonitorQuarantine_v1:';
const MONITOR_QUARANTINE_INDEX_SUFFIX = ':index';
const MONITOR_MAX_PENDING_RECORDS = 512;
const MONITOR_QUARANTINE_MAX_ENTRIES = 3;
const MONITOR_QUARANTINE_MAX_BYTES = 128 * 1024;

function normalizeHostname(hostname) { return String(hostname || '').trim().toLowerCase().replace(/\.+$/, ''); }
function cloneMonitorValue(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function canonicalSerializeMonitorValue(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalSerializeMonitorValue(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalSerializeMonitorValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function checksumMonitorCanonicalValue(value) {
  const source = typeof value === 'string' ? value : canonicalSerializeMonitorValue(value); let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function monitorEnvelopeWithoutIntegrity(envelope) { const copy = Object.assign({}, envelope); delete copy.integrity; return copy; }
function monitorEnvelopeDefaults(world, overrides = {}) {
  /** @type {any} */
  const input = overrides && typeof overrides === 'object' ? overrides : {}; const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const sourceAccounting = input.metrics && input.metrics.deliveryAccounting;
  const deliveryAccounting = Object.assign({ recoverable: [], terminal: [], compactedTerminalTotals: [], dispatchPlans: [], compactedThroughTerminalSequence: 0, nextTerminalSequence: 1, compactionClaim: null, lastCompaction: null }, sourceAccounting || {});
  for (const name of ['recoverable', 'terminal', 'compactedTerminalTotals', 'dispatchPlans']) deliveryAccounting[name] = Array.isArray(deliveryAccounting[name]) ? deliveryAccounting[name].slice() : [];
  return { schemaVersion: MONITOR_ENVELOPE_SCHEMA_VERSION, world: normalizeHostname(world), generation: Number.isInteger(input.generation) && input.generation >= 0 ? input.generation : 0, integrity: '', migration: Object.assign({ completedAtMs: null, sources: [] }, input.migration || {}), baselineByPlayerId: Object.assign({}, input.baselineByPlayerId || {}), rosterByPlayerId: Object.assign({}, input.rosterByPlayerId || {}), pending: Array.isArray(input.pending) ? input.pending.slice() : [], inFlight: Array.isArray(input.inFlight) ? input.inFlight.slice() : [], failed: Array.isArray(input.failed) ? input.failed.slice() : [], uncertain: Array.isArray(input.uncertain) ? input.uncertain.slice() : [], diagnostics: Object.assign({ migrationAmbiguities: 0, lastCorruption: null, blockedQueueAtMs: null }, input.diagnostics || {}), metrics: Object.assign({ lastAuthoritativeScanAtMs: null, lastCommitAtMs: null, lastError: null, deliveryAccounting }, input.metrics || {}, { lastCommitAtMs: input.metrics && Number.isFinite(input.metrics.lastCommitAtMs) ? input.metrics.lastCommitAtMs : null }), createdAtMs: input.createdAtMs === undefined ? now : input.createdAtMs };
}
function createMonitorEnvelopeV1(world, overrides = {}) { const envelope = monitorEnvelopeDefaults(world, overrides); envelope.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(envelope)); return envelope; }
function serializeMonitorEnvelopeV1(envelope) { const normalized = monitorEnvelopeDefaults(envelope && envelope.world, envelope || {}); normalized.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(normalized)); return canonicalSerializeMonitorValue(normalized); }
function isPlainMonitorObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function parseMonitorEnvelopeV1(raw, expectedWorld) {
  let value = raw; if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { return { ok: false, outcome: 'corrupt', reason: 'invalid-json' }; } }
  if (!isPlainMonitorObject(value)) return { ok: false, outcome: 'corrupt', reason: 'not-object' };
  const normalizedExpectedWorld = expectedWorld === undefined ? null : normalizeHostname(expectedWorld);
  const queueBoundExceeded = [value.pending, value.inFlight, value.failed, value.uncertain].some(events => Array.isArray(events) && events.length > MONITOR_MAX_PENDING_RECORDS);
  const validShape = value.schemaVersion === MONITOR_ENVELOPE_SCHEMA_VERSION && typeof value.world === 'string' && (normalizedExpectedWorld === null || value.world === normalizedExpectedWorld) && Number.isInteger(value.generation) && value.generation >= 0 && typeof value.integrity === 'string' && isPlainMonitorObject(value.migration) && isPlainMonitorObject(value.baselineByPlayerId) && isPlainMonitorObject(value.rosterByPlayerId) && Array.isArray(value.pending) && Array.isArray(value.inFlight) && Array.isArray(value.failed) && Array.isArray(value.uncertain) && !queueBoundExceeded && isPlainMonitorObject(value.diagnostics) && isPlainMonitorObject(value.metrics) && (value.metrics.deliveryAccounting === undefined || isPlainMonitorObject(value.metrics.deliveryAccounting));
  if (!validShape) {
    if (queueBoundExceeded) return { ok: false, outcome: 'bound-exceeded', reason: 'queue-bound' };
    if (normalizedExpectedWorld !== null && value.world !== normalizedExpectedWorld) return { ok: false, outcome: 'corrupt', reason: 'world-mismatch' };
    return { ok: false, outcome: 'corrupt', reason: 'invalid-shape' };
  }
  const canonicalId = id => { try { return sourceEventTuple(decodeSourceEventId(String(id))).sourceEventId === id; } catch { return false; } };
  const lineageValid = [value.pending, value.inFlight, value.failed, value.uncertain, value.metrics.deliveryAccounting?.recoverable || [], value.metrics.deliveryAccounting?.terminal || []].flat().every(event => !Array.isArray(event.sourceEventIds) || event.sourceEventIds.every(canonicalId));
  const compactedLineageValid = (value.metrics.deliveryAccounting?.compactedTerminalTotals || []).every(range => Array.isArray(range.sourceEventIds) && range.sourceEventIds.every(canonicalId));
  if (!lineageValid || !compactedLineageValid) return { ok: false, outcome: 'corrupt', reason: 'invalid-source-lineage' };
  if (checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(value)) !== value.integrity) return { ok: false, outcome: 'corrupt', reason: 'integrity-mismatch' };
  return { ok: true, envelope: cloneMonitorValue(value) };
}
function compareMonitorGenerations(left, right) { const leftNumber = Number.isInteger(left) ? left : -1; const rightNumber = Number.isInteger(right) ? right : -1; return leftNumber > rightNumber ? 1 : leftNumber < rightNumber ? -1 : 0; }
function isMonitorGenerationFenced(currentGeneration, candidateGeneration) { return compareMonitorGenerations(candidateGeneration, currentGeneration) > 0; }
function monitorActiveStorageKey(world) { return MONITOR_ACTIVE_STORAGE_KEY_PREFIX + normalizeHostname(world); }
function monitorBackupStorageKey(world) { return MONITOR_BACKUP_STORAGE_KEY_PREFIX + normalizeHostname(world); }
function monitorQuarantineStorageKey(world, timestamp) { return `${MONITOR_QUARANTINE_STORAGE_KEY_PREFIX}${normalizeHostname(world)}:${String(timestamp)}`; }
function monitorStorageAdapter(storage) {
  if (storage && typeof storage.get === 'function' && typeof storage.set === 'function') return storage;
  if (storage && typeof storage.getValue === 'function' && typeof storage.setValue === 'function') return { get: key => storage.getValue(key, undefined), set: (key, value) => storage.setValue(key, value), delete: key => storage.deleteValue(key) };
  return { get: () => undefined, set: () => { throw new Error('GM storage unavailable'); }, delete: () => { throw new Error('GM storage unavailable'); } };
}
function monitorReadRaw(storage, key) { try { return { ok: true, value: monitorStorageAdapter(storage).get(key) }; } catch (error) { return { ok: false, error }; } }
function monitorWriteRaw(storage, key, value) { try { const result = monitorStorageAdapter(storage).set(key, value); return result === false ? { ok: false, error: new Error('storage rejected write') } : { ok: true }; } catch (error) { return { ok: false, error }; } }
function monitorWriteReadback(storage, key, serialized) { const write = monitorWriteRaw(storage, key, serialized); if (!write.ok) return { ok: false, outcome: 'wrote-failed' }; const read = monitorReadRaw(storage, key); return !read.ok || read.value !== serialized ? { ok: false, outcome: 'readback-mismatch' } : { ok: true, outcome: 'ok' }; }
function monitorRestoreRaw(storage, key, raw) { if (raw !== undefined) return monitorWriteRaw(storage, key, raw).ok; try { const adapter = monitorStorageAdapter(storage); return typeof adapter.delete === 'function' ? adapter.delete(key) !== false : false; } catch { return false; } }
function quarantineMonitorRawV1(world, raw, nowMs, storage) {
  if (typeof raw !== 'string') return { ok: false, outcome: 'no-raw-input', quarantineKey: null };
  if (raw.length > MONITOR_QUARANTINE_MAX_BYTES) return { ok: false, outcome: 'quarantine-size-exceeded', quarantineKey: null };
  const adapter = monitorStorageAdapter(storage); const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now(); const key = monitorQuarantineStorageKey(world, timestamp);
  if (!monitorWriteRaw(adapter, key, raw).ok) return { ok: false, outcome: 'wrote-failed', quarantineKey: null };
  let index = []; const indexKey = `${MONITOR_QUARANTINE_STORAGE_KEY_PREFIX}${normalizeHostname(world)}${MONITOR_QUARANTINE_INDEX_SUFFIX}`; const oldIndex = monitorReadRaw(adapter, indexKey);
  if (oldIndex.ok && typeof oldIndex.value === 'string') { try { index = JSON.parse(oldIndex.value); } catch { index = []; } }
  index = Array.isArray(index) ? index.filter(item => item !== key) : []; index.push(key);
  while (index.length > MONITOR_QUARANTINE_MAX_ENTRIES) { const removed = index.shift(); if (removed) monitorWriteRaw(adapter, removed, ''); }
  monitorWriteRaw(adapter, indexKey, JSON.stringify(index)); return { ok: true, outcome: 'ok', quarantineKey: key };
}
function loadMonitorEnvelopeV1(world, options = {}) {
  const adapter = monitorStorageAdapter(options.storage); const activeKey = monitorActiveStorageKey(world); const backupKey = monitorBackupStorageKey(world);
  const activeRead = monitorReadRaw(adapter, activeKey); const backupRead = monitorReadRaw(adapter, backupKey); const activeRaw = activeRead.ok ? activeRead.value : undefined; const backupRaw = backupRead.ok ? backupRead.value : undefined; const active = parseMonitorEnvelopeV1(activeRaw, world);
  if (active.ok) return { outcome: 'ok', envelope: active.envelope, source: 'active', blocked: false };
  const quarantineKeys = [];
  if (activeRaw !== undefined) { const quarantine = quarantineMonitorRawV1(world, String(activeRaw), options.nowMs, adapter); if (quarantine.quarantineKey) quarantineKeys.push(quarantine.quarantineKey); }
  const backup = parseMonitorEnvelopeV1(backupRaw, world);
  if (backup.ok) { const repaired = monitorWriteReadback(adapter, activeKey, serializeMonitorEnvelopeV1(backup.envelope)); return { outcome: repaired.ok ? 'recovered-from-backup' : 'recovery-write-failed', envelope: repaired.ok ? backup.envelope : undefined, source: 'backup', repaired: repaired.ok, quarantineKeys, blocked: !repaired.ok }; }
  if (backupRaw !== undefined) { const quarantine = quarantineMonitorRawV1(world, String(backupRaw), Number.isFinite(options.nowMs) ? options.nowMs + 1 : Date.now() + 1, adapter); if (quarantine.quarantineKey) quarantineKeys.push(quarantine.quarantineKey); }
  const hasActive = activeRaw !== undefined; const hasBackup = backupRaw !== undefined; const activeRequiresBlock = active.outcome === 'bound-exceeded' || active.reason === 'world-mismatch';
  return { outcome: activeRequiresBlock ? active.outcome === 'bound-exceeded' ? 'bound-exceeded' : 'corrupt-active' : hasActive && hasBackup ? 'corrupt-backup' : 'missing', source: null, blocked: activeRequiresBlock || hasActive && hasBackup, canExport: hasActive && hasBackup, canReset: hasActive && hasBackup, activeRaw, backupRaw, quarantineKeys };
}
function monitorEventPlayerId(event) { if (!event || typeof event !== 'object') return null; const value = event.playerId !== undefined ? event.playerId : event.id; return value === undefined || value === null || String(value) === '' ? null : String(value); }
function monitorEventType(event) { return event && typeof event.eventType === 'string' ? event.eventType : 'attack'; }
function isMonitorDeltaType(type) { return type === 'attack' || type === 'raid' || type === 'mixed'; }
function monitorEventsCompatible(left, right) { const leftType = monitorEventType(left); const rightType = monitorEventType(right); if (normalizeHostname(left.world || '') !== normalizeHostname(right.world || '') || monitorEventPlayerId(left) !== monitorEventPlayerId(right)) return false; return isMonitorDeltaType(leftType) && isMonitorDeltaType(rightType) || (leftType === 'join' || leftType === 'leave') && leftType === rightType; }
function monitorMergedDeltaType(event) { const attacks = Number(event.addedAttackCount) || 0; const raids = Number(event.addedRaidCount) || 0; return attacks > 0 && raids > 0 ? 'mixed' : attacks > 0 ? 'attack' : 'raid'; }
function coalesceMonitorPendingEvents(events, maxRecords = MONITOR_MAX_PENDING_RECORDS, blockedAtMs = Date.now()) {
  if (!Array.isArray(events)) return { ok: true, outcome: 'ok', events: [] }; const limit = Number.isInteger(maxRecords) && maxRecords >= 0 ? maxRecords : MONITOR_MAX_PENDING_RECORDS; const result = [];
  for (const input of events) {
    const event = isPlainMonitorObject(input) ? Object.assign({}, input, { playerId: monitorEventPlayerId(input) }) : null; if (!event || event.playerId === null) { result.push(event || {}); continue; }
    if (Array.isArray(event.sourceEventIds)) { try { event.sourceEventIds = [...new Set(event.sourceEventIds.map(id => { const canonical = sourceEventTuple(decodeSourceEventId(String(id))); if (canonical.sourceEventId !== id) throw new Error('noncanonical source ID'); return id; }))]; } catch { return { ok: false, outcome: 'invalid-source-lineage', events: [], healthError: 'source-id-validation-failed' }; } }
    const index = result.findIndex(existing => monitorEventsCompatible(existing, event)); if (index < 0) { result.push(event); continue; } const current = result[index];
    if (isMonitorDeltaType(monitorEventType(current)) && isMonitorDeltaType(monitorEventType(event))) {
      const sourceEventIds = [...new Set((current.sourceEventIds || []).concat(event.sourceEventIds || []))];
      const merged = Object.assign({}, current, event, { world: event.world || current.world, playerId: event.playerId, eventId: current.eventId || event.eventId, sourceEventIds, sourceEventTuples: sourceEventIds.map(id => sourceEventTuple(decodeSourceEventId(id))), addedAttackCount: (Number(current.addedAttackCount) || 0) + (Number(event.addedAttackCount) || 0), addedRaidCount: (Number(current.addedRaidCount) || 0) + (Number(event.addedRaidCount) || 0), observedAtMs: Number.isFinite(current.observedAtMs) || Number.isFinite(event.observedAtMs) ? Math.min(Number.isFinite(current.observedAtMs) ? current.observedAtMs : Infinity, Number.isFinite(event.observedAtMs) ? event.observedAtMs : Infinity) : undefined, queuedAtMs: Number.isFinite(current.queuedAtMs) || Number.isFinite(event.queuedAtMs) ? Math.min(Number.isFinite(current.queuedAtMs) ? current.queuedAtMs : Infinity, Number.isFinite(event.queuedAtMs) ? event.queuedAtMs : Infinity) : undefined });
      merged.eventType = monitorMergedDeltaType(merged); result[index] = merged;
    } else result[index] = Object.assign({}, current, event);
  }
  if (result.length > limit) return { ok: false, outcome: 'bound-exhausted', events: [], blockedQueueAtMs: Number.isFinite(blockedAtMs) ? blockedAtMs : Date.now(), healthError: 'monitor-pending-bound-exhausted' };
  return { ok: true, outcome: 'ok', events: result };
}
function deliveryAccountingFor(envelope) { const accounting = (envelope.metrics || {}).deliveryAccounting; return isPlainMonitorObject(accounting) ? accounting : monitorEnvelopeDefaults(envelope.world).metrics.deliveryAccounting; }
function syncDeliveryAccounting(envelope) { const accounting = deliveryAccountingFor(envelope); accounting.recoverable = [].concat(envelope.pending || [], envelope.inFlight || [], envelope.failed || [], envelope.uncertain || []).map(event => cloneMonitorValue(event)); envelope.metrics = Object.assign({}, envelope.metrics, { deliveryAccounting: accounting }); return accounting; }
function terminalDeliveryEntry(event, sequence, status) { return Object.assign({}, cloneMonitorValue(event), { stage: 'acknowledged', terminalStatus: status, terminalSequence: sequence, sourceEventIds: [...new Set((event.sourceEventIds || []).map(String))] }); }
function deliveryRangeDigest(entries) { return checksumMonitorCanonicalValue(entries.map(entry => ({ terminalSequence: entry.terminalSequence, sourceEventIds: entry.sourceEventIds || [], addedAttackCount: entry.addedAttackCount || 0, addedRaidCount: entry.addedRaidCount || 0 }))); }
function compactDeliveryAccountingV1(envelope, options = {}) {
  const base = createMonitorEnvelopeV1(envelope && envelope.world, envelope || {}); const accounting = syncDeliveryAccounting(base); const terminal = accounting.terminal.slice().sort((left, right) => left.terminalSequence - right.terminalSequence); const limit = Math.max(0, terminal.length - 512);
  if (limit === 0 && !accounting.compactionClaim) return { outcome: 'nothing-to-compact', envelope: base };
  const first = terminal[0]; const last = terminal[limit - 1]; const claim = accounting.compactionClaim || { operationId: String(options.operationId || `compact-${Date.now()}`), ownerId: String(options.ownerId || ''), leaseTerm: options.leaseTerm, expectedGeneration: base.generation, fromTerminalSequence: first ? first.terminalSequence : 0, toTerminalSequence: last ? last.terminalSequence : 0, rangeDigest: deliveryRangeDigest(terminal.slice(0, limit)), status: 'prepared' };
  if (!accounting.compactionClaim || options.phase === 'prepare') { accounting.compactionClaim = claim; base.generation += 1; base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base)); return { outcome: 'prepared', envelope: base, claim }; }
  if (claim.expectedGeneration !== base.generation - 1 || claim.status !== 'prepared') return { outcome: 'stale-claim', envelope: base };
  const range = terminal.filter(entry => entry.terminalSequence >= claim.fromTerminalSequence && entry.terminalSequence <= claim.toTerminalSequence);
  if (deliveryRangeDigest(range) !== claim.rangeDigest || range.length === 0) return { outcome: 'stale-claim', envelope: base };
  const totals = { from: claim.fromTerminalSequence, to: claim.toTerminalSequence, count: range.length, attackDelta: range.reduce((sum, entry) => sum + (Number(entry.addedAttackCount) || 0), 0), raidDelta: range.reduce((sum, entry) => sum + (Number(entry.addedRaidCount) || 0), 0), sourceEventIds: range.flatMap(entry => entry.sourceEventIds || []) };
  accounting.compactedTerminalTotals = accounting.compactedTerminalTotals.concat(totals); accounting.terminal = terminal.filter(entry => entry.terminalSequence > claim.toTerminalSequence); accounting.compactedThroughTerminalSequence = Math.max(accounting.compactedThroughTerminalSequence || 0, claim.toTerminalSequence); accounting.compactionClaim = null; accounting.lastCompaction = { operationId: claim.operationId, from: claim.fromTerminalSequence, to: claim.toTerminalSequence };
  base.generation += 1; base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base)); return { outcome: 'compacted', envelope: base, totals };
}
const prepareTerminalCompactionV1 = (envelope, options) => compactDeliveryAccountingV1(envelope, Object.assign({}, options, { phase: 'prepare' }));
const resumeTerminalCompactionV1 = compactDeliveryAccountingV1;
function createMonitorQueueEvent(event, options = {}) {
  const input = event && typeof event === 'object' ? event : {}; const world = normalizeHostname(options.world || input.world || ''); const rawPlayerId = options.playerId !== undefined ? options.playerId : monitorEventPlayerId(input); const playerId = rawPlayerId === null || rawPlayerId === undefined ? null : String(rawPlayerId);
  const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : Number.isFinite(input.observedAtMs) ? input.observedAtMs : null; const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : Number.isFinite(input.queuedAtMs) ? input.queuedAtMs : Date.now();
  const base = Object.assign({}, input, { world, playerId, observedAtMs, queuedAtMs }); base.eventId = typeof input.eventId === 'string' && input.eventId ? input.eventId : checksumMonitorCanonicalValue({ world, playerId, eventType: monitorEventType(input), observedAtMs, addedAttackCount: Number(input.addedAttackCount) || 0, addedRaidCount: Number(input.addedRaidCount) || 0 });
  if (Array.isArray(input.sourceEventIds)) { base.sourceEventIds = [...new Set(input.sourceEventIds.map(String))]; base.sourceEventTuples = base.sourceEventIds.map(id => sourceEventTuple(decodeSourceEventId(id))); }
  if (input.approximateObserved === true || input.observedAtApproximate === true) { base.approximateObserved = true; base.observedAtApproximate = true; } else { delete base.approximateObserved; delete base.observedAtApproximate; }
  return base;
}
function computeQueueAge(event) { const input = event && typeof event === 'object' ? event : {}; const observedAtMs = Number(input.observedAtMs); const dispatchedAtMs = Number(input.dispatchedAtMs); return !Number.isFinite(observedAtMs) || !Number.isFinite(dispatchedAtMs) ? { ageMs: null, approximate: input.approximateObserved === true } : { ageMs: Math.max(0, dispatchedAtMs - observedAtMs), approximate: input.approximateObserved === true }; }
function addInFlightChunk(batch, hostname, chunk) { const base = isPlainMonitorObject(batch) ? batch : {}; const key = normalizeHostname(hostname); const current = isPlainMonitorObject(base[key]) ? base[key] : null; const inFlight = current && Array.isArray(current.inFlight) ? current.inFlight.slice() : []; if (isPlainMonitorObject(chunk)) inFlight.push({ events: Array.isArray(chunk.events) ? chunk.events.slice() : [], attemptCount: typeof chunk.attemptCount === 'number' ? chunk.attemptCount : 0 }); return Object.assign({}, base, { [key]: Object.assign({}, current, { inFlight }) }); }
function getInFlightChunks(batch, hostname) { const base = isPlainMonitorObject(batch) ? batch : {}; const world = base[normalizeHostname(hostname)]; return world && Array.isArray(world.inFlight) ? world.inFlight.slice() : []; }
function dropInFlightHead(batch, hostname) { const base = isPlainMonitorObject(batch) ? batch : {}; const key = normalizeHostname(hostname); const world = base[key]; if (!isPlainMonitorObject(world)) return base; const inFlight = Array.isArray(world.inFlight) ? world.inFlight.slice() : []; inFlight.shift(); return Object.assign({}, base, { [key]: Object.assign({}, world, { inFlight }) }); }
function replaceInFlightHeadAttempt(batch, hostname, attemptCount) { const base = isPlainMonitorObject(batch) ? batch : {}; const key = normalizeHostname(hostname); const world = base[key]; if (!isPlainMonitorObject(world)) return base; const inFlight = Array.isArray(world.inFlight) ? world.inFlight.slice() : []; if (inFlight.length === 0) return base; inFlight[0] = Object.assign({}, inFlight[0], { attemptCount: typeof attemptCount === 'number' ? attemptCount : inFlight[0].attemptCount }); return Object.assign({}, base, { [key]: Object.assign({}, world, { inFlight }) }); }
function planAcceptedScanTransition(snapshot, previousBaseline, muteSet, threshold, generation, fence, queue = {}) {
  if (!snapshot || snapshot.status !== 'authoritative' || !isPlainMonitorObject(snapshot.membersById)) return { outcome: 'invalid-snapshot', baselineByPlayerId: {}, detections: [], eligibleEvents: [] };
  const previous = isPlainMonitorObject(previousBaseline) ? previousBaseline : {}; const members = snapshot.membersById; const muted = muteSet instanceof Set ? muteSet : new Set(Array.isArray(muteSet) ? muteSet.map(String) : []);
  const attackLimit = threshold && typeof threshold === 'object' && Number.isFinite(threshold.attackThreshold) && threshold.attackThreshold > 0 ? threshold.attackThreshold : Number.isFinite(threshold) && threshold > 0 ? threshold : 1; const raidLimit = threshold && typeof threshold === 'object' && Number.isFinite(threshold.raidThreshold) && threshold.raidThreshold > 0 ? threshold.raidThreshold : Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
  const world = normalizeHostname(queue.world || snapshot.world || ''); const scanSequence = Number.isInteger(queue.scanSequence) ? queue.scanSequence : 0; const nextGeneration = Number.isInteger(generation) ? generation + 1 : 1; const baselineByPlayerId = {}; const detections = []; const eligibleEvents = []; const sourceIds = []; const sourceTuples = [];
  const addSources = (playerId, eventType, count) => { const ids = []; for (let ordinal = 1; ordinal <= count; ordinal += 1) { const identity = sourceEventTuple({ world, playerId: String(playerId), eventType, acceptedGeneration: nextGeneration, scanSequence, attackDelta: eventType === 'attack' ? ordinal : 0, raidDelta: eventType === 'raid' ? ordinal : 0 }); ids.push(identity.sourceEventId); sourceTuples.push(identity); sourceIds.push(identity.sourceEventId); } return ids; };
  for (const [playerId, member] of Object.entries(members)) {
    const current = Object.assign({}, member); baselineByPlayerId[playerId] = current; const old = previous[playerId] || {}; const addedAttackCount = Math.max(0, (Number(member.attackCount) || 0) - (Number(old.attackCount) || 0)); const addedRaidCount = Math.max(0, (Number(member.raidCount) || 0) - (Number(old.raidCount) || 0)); if (addedAttackCount === 0 && addedRaidCount === 0) continue;
    const eventType = addedAttackCount > 0 && addedRaidCount > 0 ? 'mixed' : addedAttackCount > 0 ? 'attack' : 'raid'; const ids = addSources(playerId, 'attack', addedAttackCount).concat(addSources(playerId, 'raid', addedRaidCount)); const thresholdPass = eventType === 'attack' ? addedAttackCount >= attackLimit : eventType === 'raid' ? addedRaidCount >= raidLimit : addedAttackCount >= attackLimit || addedRaidCount >= raidLimit; const disposition = muted.has(String(playerId)) ? 'muted' : thresholdPass ? 'eligible' : 'threshold-blocked';
    const detection = Object.assign({}, current, { playerId: String(playerId), oldAttackCount: Number(old.attackCount) || 0, oldRaidCount: Number(old.raidCount) || 0, addedAttackCount, addedRaidCount, eventType, sourceEventIds: ids, disposition }); detections.push(detection);
    if (disposition === 'eligible') { const queued = createMonitorQueueEvent(detection, { world, playerId, observedAtMs: snapshot.observedAtMs, queuedAtMs: snapshot.observedAtMs }); queued.sourceEventIds = ids; queued.sourceEventTuples = ids.map(id => sourceEventTuple(decodeSourceEventId(id))); eligibleEvents.push(queued); }
  }
  return { outcome: 'ok', world, generation: nextGeneration, ownerId: fence && fence.ownerId, term: fence && fence.term, baselineByPlayerId, detections, eligibleEvents, sourceIds, sourceTuples };
}
function commitMonitorEnvelope(options = {}) {
  const current = options.currentEnvelope; const transition = options.transition; if (!current || !transition || transition.outcome !== 'ok') return { outcome: 'invalid-transition', memorySwapped: false };
  const ownerId = options.ownerId === undefined ? transition.ownerId : options.ownerId; const term = options.term === undefined ? transition.term : options.term; const expectedGeneration = Number.isInteger(options.expectedGeneration) ? options.expectedGeneration : current.generation;
  const fence = () => isLeaseFenceValid(typeof options.currentFence === 'function' ? options.currentFence() : { ownerId, term, generation: expectedGeneration }, { ownerId, term, generation: expectedGeneration });
  if (typeof options.beforeCommit === 'function' && options.beforeCommit() !== true) return { outcome: 'fenced-reject', memorySwapped: false }; const fenced = ownerId !== null && ownerId !== undefined && term !== null && term !== undefined; if (fenced && !fence()) return { outcome: 'fenced-reject', memorySwapped: false };
  const pending = Array.isArray(current.pending) ? current.pending.concat(transition.eligibleEvents || []) : transition.eligibleEvents || []; const allQueues = pending.concat(current.inFlight || [], current.failed || [], current.uncertain || []); const capacity = Number.isInteger(options.queueCapacity) ? options.queueCapacity : MONITOR_MAX_PENDING_RECORDS; const queuedSourceIds = allQueues.flatMap(event => event.sourceEventIds || []); const sourceCapacity = Number.isInteger(options.activeSourceCapacity) ? options.activeSourceCapacity : Infinity;
  if (allQueues.length > capacity || queuedSourceIds.length > sourceCapacity || new Set(queuedSourceIds).size !== queuedSourceIds.length) return { outcome: 'capacity-reject', memorySwapped: false };
  const candidate = createMonitorEnvelopeV1(current.world, Object.assign({}, current, { generation: expectedGeneration + 1, baselineByPlayerId: transition.baselineByPlayerId, rosterByPlayerId: transition.rosterByPlayerId || current.rosterByPlayerId, pending, metrics: Object.assign({}, current.metrics, transition.metrics || {}, { lastCommitAtMs: Date.now(), lastError: null }) }));
  if (serializeMonitorEnvelopeV1(candidate).length > (Number.isInteger(options.serializedEnvelopeCapacity) ? options.serializedEnvelopeCapacity : Infinity)) return { outcome: 'capacity-reject', memorySwapped: false };
  const result = commitMonitorEnvelopeV1({ world: current.world, currentEnvelope: current, candidateEnvelope: candidate, expectedGeneration, storage: options.storage, beforeCommit: () => (typeof options.beforeCommit !== 'function' || options.beforeCommit() === true) && (!fenced || fence()) });
  if (result.outcome !== 'ok' || fenced && !fence()) { if (result.outcome === 'ok' && fenced) { const storage = monitorStorageAdapter(options.storage); monitorRestoreRaw(storage, monitorActiveStorageKey(current.world), serializeMonitorEnvelopeV1(current)); monitorRestoreRaw(storage, monitorBackupStorageKey(current.world), serializeMonitorEnvelopeV1(current)); return { outcome: 'fenced-reject', memorySwapped: false }; } return result; }
  return result;
}
function commitMonitorEnvelopeV1(options = {}) {
  const storage = monitorStorageAdapter(options.storage); const parsedCurrent = options.currentEnvelope && parseMonitorEnvelopeV1(options.currentEnvelope, options.world); const current = parsedCurrent && parsedCurrent.ok ? parsedCurrent.envelope : null; const candidateParsed = parseMonitorEnvelopeV1(options.candidateEnvelope, options.world);
  if (!candidateParsed.ok) return { outcome: 'corrupt-active', memorySwapped: false }; const candidate = candidateParsed.envelope; const expectedGeneration = current ? current.generation : Number.isInteger(options.expectedGeneration) ? options.expectedGeneration : -1;
  if (!isMonitorGenerationFenced(expectedGeneration, candidate.generation)) return { outcome: 'fenced-reject', memorySwapped: false };
  const coalesced = coalesceMonitorPendingEvents(candidate.pending, MONITOR_MAX_PENDING_RECORDS, options.nowMs); if (!coalesced.ok) return Object.assign({}, coalesced, { envelope: current, memorySwapped: false }); candidate.pending = coalesced.events;
  const activeKey = monitorActiveStorageKey(candidate.world); const backupKey = monitorBackupStorageKey(candidate.world); const oldActiveRead = monitorReadRaw(storage, activeKey); const oldBackupRead = monitorReadRaw(storage, backupKey); const oldActive = oldActiveRead.ok ? oldActiveRead.value : undefined; const oldBackup = oldBackupRead.ok ? oldBackupRead.value : undefined; const previousParsed = oldActive === undefined ? null : parseMonitorEnvelopeV1(oldActive, candidate.world); const previous = current || previousParsed && previousParsed.envelope; const backupPayload = previous ? serializeMonitorEnvelopeV1(previous) : serializeMonitorEnvelopeV1(candidate); const activePayload = serializeMonitorEnvelopeV1(candidate);
  if (typeof options.beforeCommit === 'function' && options.beforeCommit() !== true) return { outcome: 'fenced-reject', memorySwapped: false };
  const backupResult = monitorWriteReadback(storage, backupKey, backupPayload); if (!backupResult.ok) { monitorRestoreRaw(storage, backupKey, oldBackup); return { outcome: backupResult.outcome, memorySwapped: false }; }
  if (typeof options.beforeCommit === 'function' && options.beforeCommit() !== true) { monitorRestoreRaw(storage, backupKey, oldBackup); return { outcome: 'fenced-reject', memorySwapped: false }; }
  const activeResult = monitorWriteReadback(storage, activeKey, activePayload); if (!activeResult.ok) { monitorRestoreRaw(storage, backupKey, oldBackup); monitorRestoreRaw(storage, activeKey, oldActive); return { outcome: activeResult.outcome, memorySwapped: false }; }
  const committed = cloneMonitorValue(candidate); committed.integrity = parseMonitorEnvelopeV1(activePayload, candidate.world).envelope.integrity; return { outcome: 'ok', envelope: committed, memorySwapped: true, generation: committed.generation };
}
function applyMonitorQueueTransitionV1(envelope, transition) {
  const base = createMonitorEnvelopeV1(envelope && envelope.world, envelope || {}); const input = transition && typeof transition === 'object' ? transition : {}; const type = input.type; const ids = new Set(Array.isArray(input.eventIds) ? input.eventIds : []); const copyEvents = value => Array.isArray(value) ? value.slice() : [];
  if (type === 'enqueue') { const coalesced = coalesceMonitorPendingEvents(base.pending.concat(Array.isArray(input.events) ? input.events : []), MONITOR_MAX_PENDING_RECORDS, input.atMs); if (!coalesced.ok) return Object.assign({}, coalesced, { envelope: base }); base.pending = coalesced.events; }
  else if (type === 'pending-to-inFlight') { const inFlight = copyEvents(base.inFlight); if (inFlight.length + base.pending.length > MONITOR_MAX_PENDING_RECORDS) return { outcome: 'bound-exceeded', envelope: base }; base.inFlight = inFlight.concat(base.pending); base.pending = []; }
  else if (type === 'dispatch-start') { const dispatchedAtMs = Number.isFinite(input.atMs) ? input.atMs : Date.now(); base.inFlight = base.inFlight.map(event => ids.size === 0 || ids.has(event.eventId) ? Object.assign({}, event, { dispatchedAtMs }) : event); }
  else if (type === 'retry-attempt') { const attemptCount = Number.isInteger(input.attemptCount) && input.attemptCount >= 0 ? input.attemptCount : 0; base.inFlight = base.inFlight.map(event => ids.size === 0 || ids.has(event.eventId) ? Object.assign({}, event, { attemptCount }) : event); }
  else if (type === 'acknowledge') { const accounting = deliveryAccountingFor(base); let sequence = Number.isSafeInteger(accounting.nextTerminalSequence) ? accounting.nextTerminalSequence : 1; base.inFlight = base.inFlight.filter(event => !ids.has(event.eventId)); for (const event of envelope.inFlight || []) if (ids.size === 0 || ids.has(event.eventId)) accounting.terminal.push(terminalDeliveryEntry(event, sequence++, 'acknowledged')); accounting.nextTerminalSequence = sequence; }
  else if (type === 'retry') { base.pending = base.pending.concat(base.inFlight.filter(event => ids.size === 0 || ids.has(event.eventId)), base.uncertain.filter(event => ids.size === 0 || ids.has(event.eventId))); base.inFlight = base.inFlight.filter(event => ids.size > 0 && !ids.has(event.eventId)); base.uncertain = base.uncertain.filter(event => ids.size > 0 && !ids.has(event.eventId)); }
  else if (type === 'acknowledge-uncertain') { const accounting = deliveryAccountingFor(base); let sequence = Number.isSafeInteger(accounting.nextTerminalSequence) ? accounting.nextTerminalSequence : 1; for (const event of envelope.uncertain || []) if (ids.size === 0 || ids.has(event.eventId)) accounting.terminal.push(terminalDeliveryEntry(event, sequence++, 'manual-delivered')); base.uncertain = base.uncertain.filter(event => !ids.has(event.eventId)); accounting.nextTerminalSequence = sequence; }
  else if (type === 'failed' || type === 'uncertain') { const selected = base.inFlight.filter(event => ids.size === 0 || ids.has(event.eventId)).map(event => type === 'uncertain' ? Object.assign({}, event, { responseClass: String(input.responseClass || 'unknown') }) : event); base[type] = copyEvents(base[type]).concat(selected); base.inFlight = base.inFlight.filter(event => ids.size > 0 && !ids.has(event.eventId)); }
  else if (type === 'requeue-failed') { base.pending = base.pending.concat(base.failed); base.failed = []; }
  else return { outcome: 'invalid-transition', envelope };
  syncDeliveryAccounting(base); base.generation += 1; base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base)); return { outcome: 'ok', envelope: base };
}
function commitMonitorQueueTransitionV1(options = {}) { const transition = applyMonitorQueueTransitionV1(options.currentEnvelope, options.transition); if (transition.outcome !== 'ok') return Object.assign({}, transition, { memorySwapped: false }); return commitMonitorEnvelopeV1({ world: options.world || transition.envelope.world, currentEnvelope: options.currentEnvelope, candidateEnvelope: transition.envelope, expectedGeneration: options.expectedGeneration, storage: options.storage, nowMs: options.nowMs, beforeCommit: options.beforeCommit }); }

const api = {
  canonicalSerializeMonitorValue, checksumMonitorCanonicalValue,
  createMonitorEnvelopeV1, serializeMonitorEnvelopeV1, parseMonitorEnvelopeV1,
  compareMonitorGenerations, isMonitorGenerationFenced,
  monitorActiveStorageKey, monitorBackupStorageKey, monitorQuarantineStorageKey,
  quarantineMonitorRawV1, loadMonitorEnvelopeV1, coalesceMonitorPendingEvents,
  planAcceptedScanTransition, commitMonitorEnvelope, commitMonitorEnvelopeV1,
  applyMonitorQueueTransitionV1, commitMonitorQueueTransitionV1,
  compactDeliveryAccountingV1, prepareTerminalCompactionV1,
  resumeTerminalCompactionV1, createMonitorQueueEvent, computeQueueAge,
  addInFlightChunk, getInFlightChunks, dropInFlightHead,
  replaceInFlightHeadAttempt,
};
migration.configureMigrationAdapters({ envelope: api });
module.exports = api;
