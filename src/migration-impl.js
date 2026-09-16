'use strict';

const SOURCE_ID_FIELDS = Object.freeze([
  ['world', 'string'], ['playerId', 'string'], ['eventType', 'string'],
  ['acceptedGeneration', 'integer'], ['scanSequence', 'integer'],
  ['attackDelta', 'integer'], ['raidDelta', 'integer'],
]);
const LEGACY_CANONICAL_EVENT_FIELDS = Object.freeze([
  'name', 'url', 'attackCount', 'raidCount', 'oldAttackCount', 'oldRaidCount',
  'addedAttackCount', 'addedRaidCount', 'eventType', 'observedAtMs', 'queuedAtMs',
  'attemptCount', 'responseClass',
]);

let envelopeApi = null;
let legacyReaders = { attackState: () => ({}), pending: () => ({}), inFlight: () => ({}), failed: () => ({}) };
function configureMigrationAdapters(seam = {}) {
  if (seam.envelope) envelopeApi = seam.envelope;
  if (seam.legacyReaders) legacyReaders = Object.assign({}, legacyReaders, seam.legacyReaders);
}
function requireEnvelope() { if (!envelopeApi) throw new Error('migration envelope adapter is not configured'); return envelopeApi; }
function normalizeHostname(hostname) { return String(hostname || '').trim().toLowerCase().replace(/\.+$/, ''); }
function isPlainMonitorObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function monitorEventPlayerId(event) {
  if (!event || typeof event !== 'object') return null;
  const value = event.playerId !== undefined ? event.playerId : event.id;
  return value === undefined || value === null || String(value) === '' ? null : String(value);
}
function sourceUtf8(value) { return typeof TextEncoder === 'function' ? new TextEncoder().encode(value) : Uint8Array.from(unescape(encodeURIComponent(value)), character => character.charCodeAt(0)); }
function sourceBase64Url(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function sourceDecodeBase64Url(payload) { const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4)); return Uint8Array.from(binary, character => character.charCodeAt(0)); }
function sourceUtf8Text(bytes) { return typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : decodeURIComponent(String.fromCharCode(...bytes)); }
function sourceTupleValue(tuple, field, kind) {
  const value = tuple && tuple[field];
  if (kind === 'string') { if (typeof value !== 'string') throw new Error(`invalid source tuple ${field}`); return value; }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid source tuple ${field}`);
  return String(value);
}
function encodeSourceTuple(tuple) {
  const chunks = [];
  for (const [field, kind] of SOURCE_ID_FIELDS) {
    const tag = sourceUtf8(field); const bytes = sourceUtf8(sourceTupleValue(tuple, field, kind));
    const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, bytes.length);
    const tagLength = new Uint8Array(2); new DataView(tagLength.buffer).setUint16(0, tag.length);
    chunks.push(tagLength, tag, length, bytes);
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function sourceEventIdFromTuple(tuple) { return `s1:${sourceBase64Url(encodeSourceTuple(tuple))}`; }
function decodeSourceEventId(id) {
  if (typeof id !== 'string' || !id.startsWith('s1:')) throw new Error('malformed source ID');
  const payload = id.slice(3); if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw new Error('malformed source ID');
  let bytes; try { bytes = sourceDecodeBase64Url(payload); } catch { throw new Error('malformed source ID'); }
  if (sourceBase64Url(bytes) !== payload) throw new Error('noncanonical source ID');
  let offset = 0; const tuple = {};
  for (const [expectedField, kind] of SOURCE_ID_FIELDS) {
    if (offset + 2 > bytes.length) throw new Error('malformed source ID');
    const tagLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0); offset += 2;
    if (offset + tagLength + 4 > bytes.length) throw new Error('malformed source ID');
    const field = sourceUtf8Text(bytes.subarray(offset, offset + tagLength)); offset += tagLength;
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); offset += 4;
    if (field !== expectedField || offset + length > bytes.length) throw new Error('malformed source ID');
    const text = sourceUtf8Text(bytes.subarray(offset, offset + length)); offset += length;
    tuple[field] = kind === 'integer' ? Number(text) : text;
    if (kind === 'integer' && (!Number.isSafeInteger(tuple[field]) || String(tuple[field]) !== text)) throw new Error('invalid source tuple');
  }
  if (offset !== bytes.length || sourceEventIdFromTuple(tuple) !== id) throw new Error('non-round-tripping source ID');
  return Object.freeze(tuple);
}
function sourceEventTuple(tuple) {
  const canonical = {}; for (const [field, kind] of SOURCE_ID_FIELDS) canonical[field] = kind === 'integer' ? Number(sourceTupleValue(tuple, field, kind)) : sourceTupleValue(tuple, field, kind);
  const fingerprint = sourceEventIdFromTuple(canonical); return { tuple: canonical, fingerprint, sourceEventId: fingerprint };
}
function legacySafeString(value) { return typeof value === 'string' ? value : ''; }
function legacySafeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function legacySafeTime(value) { return Number.isSafeInteger(value) ? value : null; }
function canonicalLegacyEventFields(event) {
  const input = isPlainMonitorObject(event) ? event : {};
  return { name: legacySafeString(input.name), url: legacySafeString(input.url), attackCount: legacySafeCount(input.attackCount), raidCount: legacySafeCount(input.raidCount), oldAttackCount: legacySafeCount(input.oldAttackCount), oldRaidCount: legacySafeCount(input.oldRaidCount), addedAttackCount: legacySafeCount(input.addedAttackCount), addedRaidCount: legacySafeCount(input.addedRaidCount), eventType: legacySafeString(input.eventType || 'attack'), observedAtMs: legacySafeTime(input.observedAtMs), queuedAtMs: legacySafeTime(input.queuedAtMs), attemptCount: legacySafeCount(input.attemptCount), responseClass: input.responseClass === null || typeof input.responseClass === 'string' ? input.responseClass : null };
}
function legacyLengthPrefixed(parts) {
  const bytes = parts.map(part => sourceUtf8(part)); const output = [];
  for (const value of bytes) { const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, value.length); output.push(length, value); }
  const result = new Uint8Array(output.reduce((sum, item) => sum + item.length, 0)); let offset = 0;
  for (const item of output) { result.set(item, offset); offset += item.length; } return result;
}
function legacyDecodeParts(payload, count) {
  if (typeof payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw new Error('malformed legacy identity');
  let bytes; try { bytes = sourceDecodeBase64Url(payload); } catch { throw new Error('malformed legacy identity'); }
  if (sourceBase64Url(bytes) !== payload) throw new Error('noncanonical legacy identity');
  const parts = []; let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > bytes.length) throw new Error('malformed legacy identity');
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); offset += 4;
    if (offset + length > bytes.length) throw new Error('malformed legacy identity');
    try { parts.push(sourceUtf8Text(bytes.subarray(offset, offset + length))); } catch { throw new Error('malformed legacy identity'); }
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('non-round-tripping legacy identity'); return parts;
}
function canonicalLegacyIdentityFields(fields) {
  const canonical = canonicalLegacyEventFields(fields);
  if (JSON.stringify(Object.keys(fields || {})) !== JSON.stringify(LEGACY_CANONICAL_EVENT_FIELDS) || JSON.stringify(fields) !== JSON.stringify(canonical)) throw new Error('malformed canonical fields');
  return canonical;
}
function canonicalizeLegacyActiveEvent(event, options = {}) {
  const input = isPlainMonitorObject(event) ? event : {}; const world = normalizeHostname(options.world || input.world || '');
  const sourceStore = legacySafeString(options.sourceStore || 'legacy'); const originalIndex = Number.isSafeInteger(options.originalIndex) && options.originalIndex >= 0 ? options.originalIndex : 0;
  const legacyEventIdOrEmpty = typeof options.legacyEventId === 'string' ? options.legacyEventId : typeof input.eventId === 'string' ? input.eventId : '';
  if (input.canonicalEventFields !== undefined) canonicalLegacyIdentityFields(input.canonicalEventFields);
  const canonicalEventFields = canonicalLegacyEventFields(input); const tuple = { world, sourceStore, originalIndex, legacyEventIdOrEmpty, canonicalEventFields };
  const payload = sourceBase64Url(legacyLengthPrefixed([world, sourceStore, String(originalIndex), legacyEventIdOrEmpty, JSON.stringify(canonicalEventFields)]));
  return Object.assign({}, input, canonicalEventFields, { world, eventId: `ls1:${payload}`, rawEventId: legacyEventIdOrEmpty || null, canonicalEventFields, legacyIdentity: tuple, playerId: monitorEventPlayerId(input), deliveryState: input.deliveryState });
}
function decodeLegacyIdentity(identity) {
  if (typeof identity !== 'string') throw new Error('malformed legacy identity'); const prefix = identity.slice(0, 4);
  if (prefix !== 'ls1:' && prefix !== 'lh1:') throw new Error('malformed legacy identity');
  const parts = legacyDecodeParts(identity.slice(4), prefix === 'ls1:' ? 5 : 3); const fields = JSON.parse(parts[prefix === 'ls1:' ? 4 : 2]); canonicalLegacyIdentityFields(fields);
  if (prefix === 'ls1:') { const tuple = { world: parts[0], sourceStore: parts[1], originalIndex: Number(parts[2]), legacyEventIdOrEmpty: parts[3], canonicalEventFields: fields }; if (!Number.isSafeInteger(tuple.originalIndex) || `ls1:${sourceBase64Url(legacyLengthPrefixed(parts))}` !== identity) throw new Error('non-round-tripping legacy identity'); return tuple; }
  const tuple = { world: parts[0], historyIndex: Number(parts[1]), canonicalHistoryFields: fields };
  if (!Number.isSafeInteger(tuple.historyIndex) || `lh1:${sourceBase64Url(legacyLengthPrefixed(parts))}` !== identity) throw new Error('non-round-tripping legacy identity'); return tuple;
}
function canonicalizeLegacyHistoryRecord(event, world, historyIndex) {
  const canonicalHistoryFields = canonicalLegacyEventFields(event); const fieldsJson = JSON.stringify(canonicalHistoryFields);
  const recordIdentity = `lh1:${sourceBase64Url(legacyLengthPrefixed([normalizeHostname(world), String(historyIndex), fieldsJson]))}`;
  return Object.assign({}, canonicalHistoryFields, { world: normalizeHostname(world), recordIdentity, canonicalHistoryFields, deliveryState: 'unknown-legacy' });
}
function monitorWorldLegacyValue(legacy, name, world) { if (!legacy || typeof legacy !== 'object') return undefined; const value = legacy[name]; return value && typeof value === 'object' && value[normalizeHostname(world)] !== undefined ? value[normalizeHostname(world)] : value; }
function monitorLegacyEvents(legacy, name, world) {
  const value = monitorWorldLegacyValue(legacy, name, world); const events = Array.isArray(value) ? value : value && Array.isArray(value.events) ? value.events : []; const createdAt = value && Number.isFinite(value.createdAt) ? value.createdAt : null;
  return events.map((event, originalIndex) => {
    const normalized = Object.assign({}, event, { world: normalizeHostname(world), playerId: monitorEventPlayerId(event) });
    if (!Number.isFinite(normalized.observedAtMs) && Number.isFinite(createdAt)) { normalized.observedAtMs = createdAt; normalized.approximateObserved = true; }
    const canonical = canonicalizeLegacyActiveEvent(normalized, { world, sourceStore: name, originalIndex, legacyEventId: typeof event.eventId === 'string' ? event.eventId : '' });
    return requireEnvelope().createMonitorQueueEvent(canonical, { world: normalizeHostname(world), playerId: normalized.playerId, observedAtMs: normalized.observedAtMs, queuedAtMs: Number.isFinite(createdAt) ? createdAt : undefined });
  });
}
function monitorLegacyHistory(legacy, name, world) { const value = monitorWorldLegacyValue(legacy, name, world); const events = Array.isArray(value) ? value : value && Array.isArray(value.events) ? value.events : []; return events.map((event, index) => canonicalizeLegacyHistoryRecord(event, world, index)); }
function planMonitorLegacyMigration(legacy, snapshot, world) {
  const members = snapshot && snapshot.status === 'authoritative' ? snapshot.membersById || {} : {}; const attackState = legacy && (legacy.attackState || legacy.baseline || legacy.state) ? legacy.attackState || legacy.baseline || legacy.state : legacy; const source = isPlainMonitorObject(attackState) ? attackState : {};
  const byName = new Map(); for (const [id, member] of Object.entries(members)) { const key = String(member.name || '').trim().toLowerCase(); if (!byName.has(key)) byName.set(key, []); byName.get(key).push(id); }
  const carriedById = {}; let migrationAmbiguities = 0;
  for (const key of Object.keys(source).sort()) {
    if (key === 'filterVersion') continue; const record = source[key]; if (!isPlainMonitorObject(record)) continue;
    const directId = record.id && members[String(record.id)] ? String(record.id) : members[key] ? key : null; const candidates = directId ? [directId] : byName.get(String(key).trim().toLowerCase()) || [];
    if (candidates.length !== 1) { migrationAmbiguities += 1; continue; } const id = candidates[0]; carriedById[id] = { name: members[id].name, url: members[id].url, attackCount: Number.isFinite(record.attackCount) ? record.attackCount : 0, raidCount: Number.isFinite(record.raidCount) ? record.raidCount : 0 };
  }
  const baselineByPlayerId = {}; for (const [id, member] of Object.entries(members)) baselineByPlayerId[id] = carriedById[id] || Object.assign({}, member);
  const sources = []; for (const name of ['attackState', 'roster', 'pending', 'inFlight', 'failed']) if (legacy && legacy[name] !== undefined) sources.push(name);
  const removed = monitorLegacyEvents(legacy, 'removed', world).map(event => Object.assign({}, event, { deliveryState: 'uncertain-legacy-settlement', responseClass: 'uncertain-legacy-settlement' }));
  return { baselineByPlayerId, rosterByPlayerId: snapshot && snapshot.membersById ? Object.fromEntries(Object.entries(snapshot.membersById).map(([id, member]) => [id, { name: member.name, url: member.url }])) : {}, pending: monitorLegacyEvents(legacy, 'pending', world), inFlight: monitorLegacyEvents(legacy, 'inFlight', world), failed: monitorLegacyEvents(legacy, 'failed', world), uncertain: monitorLegacyEvents(legacy, 'uncertain', world).concat(removed), history: ['history', 'terminal'].flatMap(name => monitorLegacyHistory(legacy, name, world)), migrationAmbiguities, migrationSources: sources.sort(), events: [], alerts: [] };
}
function migrateLegacyMonitorStateV1(options = {}) {
  const world = normalizeHostname(options.world || ''); const existing = options.existingEnvelope;
  if (existing && existing.migration && existing.migration.completedAtMs !== null && existing.migration.completedAtMs !== undefined) return { outcome: 'already-complete', envelope: JSON.parse(JSON.stringify(existing)), events: [], alerts: [] };
  const plan = planMonitorLegacyMigration(options.legacy || {}, options.snapshot, world); const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const envelope = requireEnvelope().createMonitorEnvelopeV1(world, { generation: existing && Number.isInteger(existing.generation) ? existing.generation + 1 : 1, migration: { completedAtMs: nowMs, sources: plan.migrationSources }, baselineByPlayerId: plan.baselineByPlayerId, rosterByPlayerId: plan.rosterByPlayerId, pending: plan.pending, inFlight: plan.inFlight, failed: plan.failed, uncertain: plan.uncertain, diagnostics: { migrationAmbiguities: plan.migrationAmbiguities, lastCorruption: null, blockedQueueAtMs: null } });
  return { outcome: 'migrated', envelope, events: [], alerts: [] };
}
function loadOrMigrateMonitorEnvelopeV1(world, snapshot, options = {}) {
  const api = requireEnvelope(); const loaded = api.loadMonitorEnvelopeV1(world, options); if (loaded.envelope || loaded.blocked) return loaded; const hostname = normalizeHostname(world);
  const legacy = options.legacy || { attackState: legacyReaders.attackState(), pending: legacyReaders.pending(), inFlight: legacyReaders.inFlight(), failed: legacyReaders.failed() };
  const migration = migrateLegacyMonitorStateV1({ world: hostname, snapshot, legacy, nowMs: options.nowMs });
  if (typeof options.beforeCommit === 'function' && options.beforeCommit() !== true) return { outcome: 'fenced-reject', blocked: true, commit: { outcome: 'fenced-reject', memorySwapped: false } };
  const committed = api.commitMonitorEnvelopeV1({ world: hostname, candidateEnvelope: migration.envelope, expectedGeneration: -1, storage: options.storage, nowMs: options.nowMs });
  return committed.outcome === 'ok' ? Object.assign({}, migration, { outcome: 'migrated', commit: committed }) : Object.assign({}, migration, { outcome: 'failed-migration', commit: committed, blocked: true });
}

module.exports = {
  configureMigrationAdapters, LEGACY_CANONICAL_EVENT_FIELDS,
  canonicalLegacyEventFields, canonicalizeLegacyActiveEvent,
  canonicalizeLegacyHistoryRecord, decodeLegacyIdentity,
  planMonitorLegacyMigration, migrateLegacyMonitorStateV1,
  loadOrMigrateMonitorEnvelopeV1, encodeSourceTuple, sourceEventIdFromTuple,
  sourceEventTuple, decodeSourceEventId,
};
