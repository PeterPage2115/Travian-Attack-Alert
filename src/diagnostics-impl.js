'use strict';

// Extracted diagnostics kernel (plan Todo 14).
//
// Owns the bounded diagnostic schema, ring, serializer, and export contracts
// exactly as the legacy authority in src/runtime.js defines them (diagnostics
// band ~58-233: limits, stages, digest-redacted identities, bounded ring and
// serializers). World persistence flows only through the injected keyValue
// seam (configureDiagnosticsAdapters; default storage-less, matching the
// authority's behavior when no store is present); host capabilities arrive
// only through that seam. This file names no host global. The legacy authority
// in src/runtime.js is byte-untouched in this task; differential behavior is
// pinned by test/characterization/diagnostics-redaction.test.cjs.
const adapters = require('./adapters.js');
const { DIAGNOSTICS_LIMITS, DIAGNOSTICS_STORAGE_KEY } = require('./constants.js');

let activeKeyValue = null;

function configureDiagnosticsAdapters(seam) {
  const source = seam && typeof seam === 'object' ? seam : {};
  if (Object.prototype.hasOwnProperty.call(source, 'keyValue')) {
    const store = source.keyValue;
    activeKeyValue = (store === null || store === undefined)
      ? null
      : adapters.createSessionStorageAdapter({ store });
  }
  return { keyValue: activeKeyValue !== null };
}

function resetDiagnosticsAdapters() { activeKeyValue = null; }

function keyValueStore() { return activeKeyValue; }

const DIAGNOSTIC_STAGES = Object.freeze([
  "route",
  "lease",
  "snapshot",
  "diff",
  "filter",
  "queue",
  "dispatch",
  "reload"
]);
const DIAGNOSTIC_STATUSES = Object.freeze(["ok", "rejected", "overflow", "error"]);
function diagnosticString(value, limit) {
  let text = String(value === void 0 || value === null ? "" : value);
  text = text.replace(/[\uD800-\uDFFF]/g, (unit, index, source) => {
    const code = unit.charCodeAt(0);
    const next = source.charCodeAt(index + 1);
    const previous = source.charCodeAt(index - 1);
    if (code >= 55296 && code <= 56319 && next >= 56320 && next <= 57343) return unit;
    if (code >= 56320 && code <= 57343 && previous >= 55296 && previous <= 56319) return unit;
    return "�";
  }).normalize("NFC");
  return Array.from(text).slice(0, limit === 64 ? 64 : 320).join("");
}
function diagnosticTransform(value, seen, keyName) {
  if (typeof value === "string") return diagnosticString(value, keyName === "reason" ? 64 : 320);
  if (typeof value === "number") return Number.isFinite(value) ? Object.is(value, -0) ? 0 : value : null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return void 0;
  if (typeof value !== "object") return void 0;
  if (Object.prototype.toString.call(value) !== "[object Object]" && !Array.isArray(value)) return void 0;
  if (seen.has(value)) throw new TypeError("diagnostic cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    const result2 = value.map((item) => {
      const transformed = diagnosticTransform(item, seen, "");
      return transformed === void 0 ? null : transformed;
    });
    seen.delete(value);
    return result2;
  }
  const result = {};
  const entries = Object.keys(value).map((key) => ({ original: key, normalized: diagnosticString(key, 320) }));
  if (new Set(entries.map((entry) => entry.normalized)).size !== entries.length) throw new TypeError("duplicate normalized diagnostic key");
  entries.sort((left, right) => left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0);
  for (const entry of entries) {
    const transformed = diagnosticTransform(value[entry.original], seen, entry.normalized);
    if (transformed !== void 0) result[entry.normalized] = transformed;
  }
  seen.delete(value);
  return result;
}
function canonicalSerializeDiagnostics(value) {
  const transformed = diagnosticTransform(value, /* @__PURE__ */ new WeakSet(), "");
  return JSON.stringify(transformed === void 0 ? null : transformed);
}
function diagnosticByteLength(value) {
  const text = typeof value === "string" ? value : canonicalSerializeDiagnostics(value);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return unescape(encodeURIComponent(text)).length;
}
function diagnosticDigest(value) {
  const text = typeof value === "string" ? value : canonicalSerializeDiagnostics(value);
  let hash = 2166136261;
  const bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(text) : Array.from(unescape(encodeURIComponent(text)), (character) => character.charCodeAt(0));
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function diagnosticStage(value) {
  return DIAGNOSTIC_STAGES.includes(value) ? value : "route";
}
function diagnosticStatus(value) {
  return DIAGNOSTIC_STATUSES.includes(value) ? value : "error";
}
function createDiagnosticsWorldV2(worldHash) {
  return { schemaVersion: 2, sequence: 0, records: [], diagnosticIds: [], diagnosticIdOverflow: 0, worldHash: diagnosticDigest(diagnosticString(worldHash, 320)) };
}
function diagnosticRecordV2(input, sequence) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const record = { schemaVersion: 2, sequence, stage: diagnosticStage(source.stage), status: diagnosticStatus(source.status) };
  if (source.reason !== void 0) record.reason = diagnosticString(source.reason, 64);
  if (source.count !== void 0 && typeof source.count === "number") record.count = Number.isFinite(source.count) ? Object.is(source.count, -0) ? 0 : source.count : null;
  if (source.durationMs !== void 0 && typeof source.durationMs === "number") record.durationMs = Number.isFinite(source.durationMs) ? Math.max(0, source.durationMs) : null;
  if (source.diagnosticId !== void 0) record.diagnosticId = diagnosticDigest(diagnosticString(source.diagnosticId, 320));
  if (source.scanId !== void 0) record.scanId = diagnosticDigest(diagnosticString(source.scanId, 320));
  return record;
}
function diagnosticOverflowRecord(sequence) {
  return { schemaVersion: 2, status: "overflow", sequence, stage: "route", reason: "diagnostic-overflow" };
}
function appendDiagnosticTraceV2(world, input) {
  let base = world && typeof world === "object" && !Array.isArray(world) ? world : createDiagnosticsWorldV2("");
  const sequence = Number.isInteger(base.sequence) && base.sequence >= 0 ? base.sequence + 1 : 1;
  let record;
  try {
    record = diagnosticRecordV2(input, sequence);
    if (diagnosticByteLength(record) > DIAGNOSTICS_LIMITS.recordBytes) record = diagnosticOverflowRecord(sequence);
  } catch (error) {
    record = diagnosticOverflowRecord(sequence);
  }
  const records = Array.isArray(base.records) ? base.records.slice(-DIAGNOSTICS_LIMITS.records + 1) : [];
  records.push(record);
  const beforeBound = records.length;
  while (records.length > 1 && diagnosticByteLength(Object.assign({}, base, { records })) > DIAGNOSTICS_LIMITS.worldBytes) records.shift();
  const diagnosticOverflowCount = beforeBound - records.length;
  const ids = Array.isArray(base.diagnosticIds) ? base.diagnosticIds.slice(0, DIAGNOSTICS_LIMITS.ids) : [];
  if (record.diagnosticId && !ids.includes(record.diagnosticId)) {
    if (ids.length < DIAGNOSTICS_LIMITS.ids) ids.push(record.diagnosticId);
    else base = Object.assign({}, base, { diagnosticIdOverflow: (Number(base.diagnosticIdOverflow) || 0) + 1 });
  }
  return Object.assign({}, base, { schemaVersion: 2, sequence, records, diagnosticIds: ids, ...(diagnosticOverflowCount > 0 ? { overflowCount: (Number(base.overflowCount) || 0) + diagnosticOverflowCount, overflowReason: "diagnostics-cap", overflowMessage: "Diagnostics bounded: oldest records were omitted after the diagnostics cap." } : {}) });
}
function diagnosticFallbackConsole(sequence, stage, digest) {
  return canonicalSerializeDiagnostics({ schemaVersion: 2, status: "overflow", sequence: Number.isInteger(sequence) ? sequence : 0, stage: diagnosticStage(stage), digest: diagnosticDigest(digest || "") });
}
function diagnosticFallbackExport(worldHash, digest) {
  return canonicalSerializeDiagnostics({ schemaVersion: 2, status: "overflow", worldHash: diagnosticDigest(worldHash || ""), omitted: true, digest: diagnosticDigest(digest || "") });
}
function serializeDiagnosticsConsoleV2(input) {
  try {
    const source = input && typeof input === "object" ? input : {};
    const records = Array.isArray(source.records) ? source.records.slice(-DIAGNOSTICS_LIMITS.records) : [];
    let material = canonicalSerializeDiagnostics({ schemaVersion: 2, status: diagnosticStatus(source.status), sequence: source.sequence, stage: diagnosticStage(source.stage), records });
    while (records.length && diagnosticByteLength(material) > DIAGNOSTICS_LIMITS.consoleBytes) {
      records.shift();
      material = canonicalSerializeDiagnostics({ schemaVersion: 2, status: diagnosticStatus(source.status), sequence: source.sequence, stage: diagnosticStage(source.stage), records });
    }
    return diagnosticByteLength(material) <= DIAGNOSTICS_LIMITS.consoleBytes ? material : diagnosticFallbackConsole(source.sequence, source.stage, material);
  } catch (error) {
    return diagnosticFallbackConsole(0, "route", "error");
  }
}
function serializeDiagnosticsExportV2(worldHash, world) {
  try {
    const source = world && typeof world === "object" ? world : {};
    const records = Array.isArray(source.records) ? source.records.slice() : [];
    let material = canonicalSerializeDiagnostics({ schemaVersion: 2, worldHash: diagnosticDigest(worldHash || ""), sequence: source.sequence || 0, records });
    while (records.length && diagnosticByteLength(material) > DIAGNOSTICS_LIMITS.exportBytes) {
      records.shift();
      material = canonicalSerializeDiagnostics({ schemaVersion: 2, worldHash: diagnosticDigest(worldHash || ""), sequence: source.sequence || 0, records });
    }
    return diagnosticByteLength(material) <= DIAGNOSTICS_LIMITS.exportBytes ? material : diagnosticFallbackExport(worldHash, material);
  } catch (error) {
    return diagnosticFallbackExport(worldHash, "error");
  }
}
function loadDiagnosticsV2() {
  if (keyValueStore() === null) return {};
  try {
    const parsed = JSON.parse(keyValueStore().getItem(DIAGNOSTICS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}
function saveDiagnosticsV2(worldHash, world) {
  try {
    if (keyValueStore() === null) return false;
    const map = loadDiagnosticsV2();
    const key = diagnosticDigest(diagnosticString(worldHash, 320));
    const candidate2 = world && typeof world === "object" ? world : createDiagnosticsWorldV2(worldHash);
    const serialized = serializeDiagnosticsExportV2(worldHash, candidate2);
    const next = Object.assign({}, map, { [key]: JSON.parse(serialized) });
    const bytes = diagnosticByteLength(next);
    if (bytes > DIAGNOSTICS_LIMITS.worldBytes) return false;
    keyValueStore().setItem(DIAGNOSTICS_STORAGE_KEY, canonicalSerializeDiagnostics(next));
    return true;
  } catch (error) {
    return false;
  }
}
function recordDiagnosticTraceV2(worldHash, input) {
  try {
    const key = diagnosticDigest(diagnosticString(worldHash, 320));
    const current = loadDiagnosticsV2();
    const world = current[key] && typeof current[key] === "object" ? current[key] : createDiagnosticsWorldV2(worldHash);
    const next = appendDiagnosticTraceV2(world, input);
    return saveDiagnosticsV2(worldHash, next) ? next : world;
  } catch (error) {
    return createDiagnosticsWorldV2(worldHash);
  }
}
const canonicalSerializeDiagnosticValue = canonicalSerializeDiagnostics;
const createDiagnosticWorldV2 = createDiagnosticsWorldV2;
const appendDiagnosticRecordV2 = appendDiagnosticTraceV2;
const serializeDiagnosticConsoleV2 = serializeDiagnosticsConsoleV2;
const serializeDiagnosticExportV2 = serializeDiagnosticsExportV2;
module.exports = {
  configureDiagnosticsAdapters, resetDiagnosticsAdapters,
  loadDiagnosticsV2, saveDiagnosticsV2,
  createDiagnosticsWorldV2, appendDiagnosticTraceV2,
  serializeDiagnosticsConsoleV2, serializeDiagnosticsExportV2,
  recordDiagnosticTraceV2, createDiagnosticWorldV2,
  appendDiagnosticRecordV2, serializeDiagnosticConsoleV2,
  serializeDiagnosticExportV2,
};
