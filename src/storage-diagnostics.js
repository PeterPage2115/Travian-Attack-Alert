'use strict';

// Extracted storage domain: diagnostics stores (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const DIAGNOSTICS_STORAGE_KEY = kernel.DIAGNOSTICS_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
  const DIAGNOSTICS_LIMITS = Object.freeze({
    records: 256,
    recordBytes: 4096,
    worldBytes: 256 * 1024,
    ids: 32,
    consoleBytes: 2048,
    exportBytes: 512 * 1024
  });
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
  function diagnosticFallbackExport(worldHash, digest) {
    return canonicalSerializeDiagnostics({ schemaVersion: 2, status: "overflow", worldHash: diagnosticDigest(worldHash || ""), omitted: true, digest: diagnosticDigest(digest || "") });
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
  function createDiagnosticsWorldV2(worldHash) {
    return { schemaVersion: 2, sequence: 0, records: [], diagnosticIds: [], diagnosticIdOverflow: 0, worldHash: diagnosticDigest(diagnosticString(worldHash, 320)) };
  }
  function loadDiagnostics() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
        DIAGNOSTICS_STORAGE_KEY
      );
      const diag = saved ? JSON.parse(saved) : {};
      return diag && typeof diag === "object" && !Array.isArray(diag) ? diag : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Diagnostics read error:",
        error
      );
      return {};
    }
  }
  function saveDiagnostics(diag, hostname) {
    if (keyValueStore() === null) {
      return;
    }
    try {
      const saved = keyValueStore().getItem(
        DIAGNOSTICS_STORAGE_KEY
      );
      let map = {};
      if (saved) {
        try {
          map = JSON.parse(saved);
        } catch (error) {
          map = {};
        }
      }
      const base = map && typeof map === "object" && !Array.isArray(map) ? map : {};
      const diagBase = diag && typeof diag === "object" && !Array.isArray(diag) ? diag : {};
      const worldKey = normalizeHostname(hostname);
      let worldEntry = diagBase[worldKey];
      if (worldEntry === void 0) {
        const matchedKey = Object.keys(
          diagBase
        ).find(
          (key) => normalizeHostname(key) === worldKey
        );
        if (matchedKey !== void 0) {
          worldEntry = diagBase[matchedKey];
        }
      }
      const nextMap = Object.assign({}, base);
      if (worldEntry !== void 0) {
        nextMap[worldKey] = worldEntry;
      }
      keyValueStore().setItem(
        DIAGNOSTICS_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Diagnostics save error:",
        error
      );
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
module.exports = {
  loadDiagnostics, saveDiagnostics, loadDiagnosticsV2, saveDiagnosticsV2,
};
