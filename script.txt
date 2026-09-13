// ==UserScript==
// @name         Travian Attack Alert
// @namespace    travian-attack-alert-public
// @version      1.0.0
// @description  Notifies on Discord about new attacks on alliance members
// @match        https://*.travian.com/alliance*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      discord.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function() {
  "use strict";
const RELEASE_VERSION = "1.0.0";
const RELEASE_ID = "taa-1.0.0";
  const CONFIG = {
    // Losowe odświeżanie strony co 1–2 minuty.
    reloadMinSeconds: 60,
    reloadMaxSeconds: 120
  };
  const STORAGE_KEY = "travianAllianceIncomingAttacks_v40";
  const MAPPING_STORAGE_KEY = "travianAlliancePlayerMappings_v1";
  const DISCORD_CONFIG_STORAGE_KEY = "travianAllianceDiscordConfig_v1";
  const WEBHOOK_STORAGE_KEY = "travianAllianceWebhookUrl_v1";
  const MUTED_PLAYERS_STORAGE_KEY = "travianAllianceMutedPlayers_v1";
  const PLAYER_NAMES_STORAGE_KEY = "travianAlliancePlayerNames_v1";
  const PLAYER_NAMES_NOT_FOUND_KEY = "travianAlliancePlayerNamesNotFound_v1";
  const ROSTER_STORAGE_KEY = "travianAllianceRoster_v1";
  const NAME_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  const NAME_BACKFILL_TIMEOUT_MS = 1e4;
  const NAME_BACKFILL_MAX_CONCURRENCY = 6;
  const SETTINGS_STORAGE_KEY = "travianAllianceSettings_v1";
  const HISTORY_STORAGE_KEY = "travianAllianceHistory_v1";
  const HISTORY_MAX_EVENTS = 500;
  const PENDING_BATCH_STORAGE_KEY = "travianAlliancePendingBatch_v1";
  const BATCH_FLUSH_MS = 3e4;
  const QUEUE_MAX_EVENTS = 50;
  const PAYLOAD_CHUNK_MAX = 20;
  const DISCORD_CONTENT_LIMIT = 2e3;
  const EMBED_DESCRIPTION_LIMIT = 4096;
  const EMBED_FIELD_VALUE_LIMIT = 1024;
  const EMBED_TOTAL_TEXT_LIMIT = 6e3;
  const DISCORD_EMBEDS_LIMIT = 10;
  const EMBED_DESCRIPTION_SAFE_BUDGET = 3800;
  const EMBED_TOTAL_SAFE_BUDGET = 5800;
  const EVENT_NAME_MAX = 80;
  const EVENT_URL_MAX = 300;
  const DIAGNOSTICS_STORAGE_KEY = "travianAllianceDiagnostics_v2";
  const DIAGNOSTICS_SCHEMA_VERSION = 2;
  const DIAGNOSTICS_LIMITS = Object.freeze({
    records: 256,
    recordBytes: 4096,
    worldBytes: 256 * 1024,
    ids: 32,
    consoleBytes: 2048,
    exportBytes: 512 * 1024
  });
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
    if (typeof localStorage === "undefined") return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  function saveDiagnosticsV2(worldHash, world) {
    try {
      if (typeof localStorage === "undefined") return false;
      const map = loadDiagnosticsV2();
      const key = diagnosticDigest(diagnosticString(worldHash, 320));
      const candidate2 = world && typeof world === "object" ? world : createDiagnosticsWorldV2(worldHash);
      const serialized = serializeDiagnosticsExportV2(worldHash, candidate2);
      const next = Object.assign({}, map, { [key]: JSON.parse(serialized) });
      const bytes = diagnosticByteLength(next);
      if (bytes > DIAGNOSTICS_LIMITS.worldBytes) return false;
      localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, canonicalSerializeDiagnostics(next));
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
  const DEBUG_VERBOSE_STORAGE_KEY = "travianAllianceDebugVerbose_v1";
  const MAX_DEBUG_ANOMALY_ROWS = 8;
  const MAX_DIAGNOSTIC_LOG_LENGTH = 320;
  const FAILED_BATCH_STORAGE_KEY = "travianAllianceFailedBatch_v1";
  const FAILED_QUEUE_MAX_EVENTS = 50;
  const TAB_LEASE_STORAGE_KEY = "travianAllianceTabLease_v1";
  const TAB_LEASE_TTL_MS = 12e4;
  const TAB_LEASE_RENEW_MS = 3e4;
  const TAB_LEASE_RETRY_MS = 1e4;
  const READINESS_QUIET_MS = 500;
  const STARTUP_ACQUIRE_JITTER_MIN_MS = 25;
  const STARTUP_ACQUIRE_JITTER_MAX_MS = 250;
  const MAX_ATTEMPT_COUNT = 3;
  const RETRY_DELAY_MS = [1e3, 3e3];
  const REQUEST_TIMEOUT_MS = 15e3;
  const MAX_RETRY_DELAY_MS = 6e4;
  const DRAIN_POLL_MS = 500;
  const DRAIN_MAX_WAIT_MS = 45e3;
  const DEFAULT_SETTINGS = {
    attackThreshold: 1,
    raidThreshold: 1,
    normalMax: 2,
    highMax: 5
  };
  const PRIORITY_COLORS = {
    normal: 15158332,
    high: 15844367,
    critical: 10038562
  };
  const isNodeEnvironment = Boolean(
    typeof module !== "undefined" && module.exports
  );
  const ROUTE_ROLES = Object.freeze({
    CANONICAL_MEMBER: "canonical-member",
    ALLIANCE_NONCANONICAL: "alliance-noncanonical",
    UNSUPPORTED: "unsupported"
  });
  function classifyAllianceRoute(input) {
    let url;
    try {
      url = new URL(String(input));
    } catch (error) {
      return { role: ROUTE_ROLES.UNSUPPORTED, pathname: "", query: "" };
    }
    const pathname = url.pathname;
    const isCanonicalPath = pathname === "/alliance/profile/members" || pathname === "/alliance/profile/members/";
    if (isCanonicalPath && url.search === "") {
      return { role: ROUTE_ROLES.CANONICAL_MEMBER, pathname, query: url.search };
    }
    if (pathname === "/alliance" || pathname.startsWith("/alliance/")) {
      return { role: ROUTE_ROLES.ALLIANCE_NONCANONICAL, pathname, query: url.search };
    }
    return { role: ROUTE_ROLES.UNSUPPORTED, pathname, query: url.search };
  }
  function lockNameForHostname(hostname) {
    return "taa-monitor:" + String(hostname || "").trim().toLowerCase().replace(/\.+$/, "");
  }
  function hasExclusiveWebLocks() {
    return isNodeEnvironment || Boolean(
      typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function"
    );
  }
  function isLeaseFenceValid(actual, expected) {
    return Boolean(actual && expected && actual.ownerId === expected.ownerId && actual.term === expected.term && actual.generation === expected.generation);
  }
  let previousState = isNodeEnvironment ? null : hasExclusiveWebLocks() && typeof location !== "undefined" && classifyAllianceRoute(location.href).role === ROUTE_ROLES.CANONICAL_MEMBER ? loadState() : null;
  let lastScanAtMs = null;
  let nextReloadAtMs = null;
  let tabLeaseActive = false;
  let tabLeaseToken = null;
  let tabLeaseGeneration = null;
  let tabLeaseTerm = null;
  let tabLeaseBestEffort = false;
  let activeLeaseOwnerId = null;
  let lifecycleEpoch = 0;
  let scanAttemptedForDocument = false;
  let readinessObserver = null;
  let readinessTimerId = null;
  let scanDeadlineTimerId = null;
  let scanCycleId = null;
  let scheduledReloadTimerId = null;
  let flushTimerId = null;
  let followerWatchdogTimerId = null;
  let followerWatchdogCheck = null;
  const lifecycleTimerIds = /* @__PURE__ */ new Set();
  let adminDraftReloadGate = null;
  let adminPanelRequestExit = null;
  let panelRuntimeUpdater = null;
  let cancelPanelAsyncWork = null;
  let panelRuntimeTimerId = null;
  let adminPanelOpener = null;
  let adminRecoveryActions = null;
  let readinessStartedAtMono = null;
  let visibilityDriftState = null;
  function monotonicNow() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }
  function monotonicDurationMs(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    return Math.max(0, endMs - startMs);
  }
  function recordDuration(target, key, startMs, endMs) {
    if (!target || typeof target !== "object") return target;
    const duration = monotonicDurationMs(startMs, endMs);
    if (duration !== null) target[key] = duration;
    return target;
  }
  function createVisibilityDriftTracker(nowMs, hidden) {
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    return {
      visibilityState: hidden === true ? "hidden" : "visible",
      hiddenSinceMs: hidden === true ? now : null,
      transitions: 0,
      nextReloadSlippageMs: null,
      lastTransitionAtMs: now
    };
  }
  function updateVisibilityDriftTracker(state, nowMs, hidden, expectedAtMs) {
    const current = state && typeof state === "object" ? Object.assign({}, state) : createVisibilityDriftTracker(nowMs, hidden);
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const nextState = hidden === true ? "hidden" : "visible";
    if (current.visibilityState !== nextState) {
      current.transitions = (Number(current.transitions) || 0) + 1;
      current.visibilityState = nextState;
      current.lastTransitionAtMs = now;
      current.hiddenSinceMs = nextState === "hidden" ? now : null;
    }
    if (Number.isFinite(expectedAtMs)) {
      current.nextReloadSlippageMs = Math.max(0, now - expectedAtMs);
    }
    return current;
  }
  const DIAGNOSTIC_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu;
  function stripDiagnosticUnsafeCharacters(value) {
    return String(value === void 0 || value === null ? "" : value).replace(DIAGNOSTIC_UNSAFE_CHARACTERS, "");
  }
  function sanitizeDiagnosticText(value) {
    return stripDiagnosticUnsafeCharacters(value).replace(/https?:\/\/[^\s]+/gi, "[url]").replace(/(?:webhook|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").replace(/\b\d{4,}\b/g, "[id]").slice(0, MAX_DIAGNOSTIC_LOG_LENGTH);
  }
  function buildScanSummaryLog(summary) {
    const source = summary && typeof summary === "object" ? summary : {};
     const output = {
      status: String(source.status || "unknown"),
      memberRows: Number(source.memberRows) || 0,
      icons: Number(source.icons) || 0,
      newDeltas: source.newDeltas && typeof source.newDeltas === "object" ? source.newDeltas : { attacks: 0, raids: 0, players: 0 },
      scanMs: Number.isFinite(source.scanMs) ? source.scanMs : null,
      generation: Number.isFinite(source.generation) ? source.generation : null,
      queueAge: Number.isFinite(source.queueAge) ? source.queueAge : null
     };
     if (MEMBER_TABLE_REASON_CODES.includes(source.rejectionReason)) output.rejectionReason = source.rejectionReason;
     return "Scan: " + JSON.stringify(output);
  }
  function sanitizeDiagnosticsExport(value, seen = /* @__PURE__ */ new Set()) {
    if (value === null || value === void 0) return value;
    if (typeof value === "string") return sanitizeDiagnosticText(value);
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticsExport(item, seen));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const safeKey = stripDiagnosticUnsafeCharacters(key);
      if (/webhook|token|secret|url|body|response/i.test(key)) {
        output[safeKey] = "[redacted]";
      } else {
        output[safeKey] = sanitizeDiagnosticsExport(item, seen);
      }
    }
    return output;
  }
  function loadDebugVerbose() {
    if (typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem(DEBUG_VERBOSE_STORAGE_KEY) === "true";
    } catch (error) {
      return false;
    }
  }
  function saveDebugVerbose(enabled) {
    if (typeof localStorage === "undefined") return false;
    try {
      localStorage.setItem(DEBUG_VERBOSE_STORAGE_KEY, enabled === true ? "true" : "false");
      return localStorage.getItem(DEBUG_VERBOSE_STORAGE_KEY) === (enabled === true ? "true" : "false");
    } catch (error) {
      return false;
    }
  }
  function reportLifecycleHook(name, payload) {
    if (typeof window !== "undefined" && window.__TAA_TEST_HOOK__ && typeof window.__TAA_TEST_HOOK__[name] === "function") {
      window.__TAA_TEST_HOOK__[name](payload || {});
    }
    try {
      const world = typeof location !== "undefined" ? location.hostname : "";
      recordDiagnosticTraceV2(world, { stage: name.replace(/^on/, "").toLowerCase(), status: "ok" });
    } catch (error) {
    }
  }
  function scheduleLifecycleTimeout(callback, delayMs) {
    const id = setTimeout(() => {
      lifecycleTimerIds.delete(id);
      callback();
    }, delayMs);
    lifecycleTimerIds.add(id);
    return id;
  }
  function cancelLifecycleCallbacks() {
    lifecycleEpoch += 1;
    if (typeof cancelPanelAsyncWork === "function") cancelPanelAsyncWork();
    for (const id of lifecycleTimerIds) {
      clearTimeout(id);
    }
    lifecycleTimerIds.clear();
    if (readinessTimerId !== null) {
      clearTimeout(readinessTimerId);
      readinessTimerId = null;
    }
    if (scanDeadlineTimerId !== null) {
      clearTimeout(scanDeadlineTimerId);
      lifecycleTimerIds.delete(scanDeadlineTimerId);
      scanDeadlineTimerId = null;
    }
    if (scheduledReloadTimerId !== null) {
      clearTimeout(scheduledReloadTimerId);
      scheduledReloadTimerId = null;
    }
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId);
      flushTimerId = null;
    }
    if (readinessObserver) {
      readinessObserver.disconnect();
      readinessObserver = null;
    }
  }
  function requestPanelExit(reason, continuation) {
    return typeof adminPanelRequestExit === "function" ? adminPanelRequestExit(reason, continuation) : false;
  }
  function requestLifecycleReload(reason, allowFollowerTakeover = false) {
    if (!tabLeaseActive && !allowFollowerTakeover) {
      recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), classifyReloadRefusal("lease-lost-before-reload", scanCycleId));
      return false;
    }
    const reload = () => {
      if (typeof location === "undefined" || typeof location.reload !== "function") {
        recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), classifyReloadRefusal("reload-unavailable", scanCycleId));
        return false;
      }
      recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), {
        stage: "reload",
        status: "ok",
        reason: String(reason || "unspecified"),
        scanId: scanCycleId
      });
      location.reload();
      return true;
    };
    if (typeof adminPanelRequestExit === "function") {
      const accepted = requestPanelExit("reload", reload);
      if (!accepted) recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), classifyReloadRefusal("reload-blocked-by-draft", scanCycleId));
      return accepted;
    }
    if (typeof adminDraftReloadGate === "function" && !adminDraftReloadGate()) {
      recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), classifyReloadRefusal("reload-blocked-by-draft", scanCycleId));
      return false;
    }
    return reload();
  }
  function normalizeAdminDraftScope(scope) {
    const source = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
    const sourceFilters = source.filters && typeof source.filters === "object" ? source.filters : {};
    const filters = {};
    for (const key of ["mapped", "unmapped", "muted", "orphaned"]) {
      if (sourceFilters[key] !== void 0) filters[key] = Boolean(sourceFilters[key]);
    }
    const selection = Array.isArray(source.selection) ? source.selection.map((item) => String(item)).filter(Boolean).slice(0, 100) : [];
    const page = Number.isFinite(Number(source.page)) ? Math.max(1, Math.floor(Number(source.page))) : 1;
    return {
      query: String(source.query || ""),
      filters,
      page,
      activeEditorId: source.activeEditorId == null ? null : String(source.activeEditorId),
      selection
    };
  }
  function readSessionStorageSafely(root, onDenied) {
    try {
      if (!root || typeof root.sessionStorage === "undefined") return null;
      return root.sessionStorage;
    } catch (error) {
      if (typeof onDenied === "function") onDenied(error);
      return null;
    }
  }
  function supportsInputSelection(element) {
    return Boolean(element && typeof element.setSelectionRange === "function" && ["text", "search", "url", "tel", "password"].indexOf(String(element.type)) !== -1);
  }
  function createAdminDraftState(tab, fields, focus, scope) {
    const safeFields = fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields).reduce((result, key) => {
      if (!/webhook|token|secret/i.test(key)) result[key] = String(fields[key] ?? "");
      return result;
    }, {}) : {};
    return {
      version: 1,
      tab: String(tab || "overview"),
      fields: safeFields,
      focus: focus && typeof focus === "object" ? { id: String(focus.id || ""), start: Number(focus.start) || 0, end: Number(focus.end) || 0 } : null,
      scope: normalizeAdminDraftScope(scope)
    };
  }
  function persistAdminDraft(storage, key, draft) {
    try {
      const serialized = JSON.stringify(createAdminDraftState(draft.tab, draft.fields, draft.focus, draft.scope));
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) return { ok: false, outcome: "readback-mismatch" };
      return { ok: true, outcome: "persisted" };
    } catch (error) {
      return { ok: false, outcome: "storage-failed", error };
    }
  }
  function restoreAdminDraft(storage, key) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return { ok: true, draft: null };
      const parsed = JSON.parse(raw);
      return parsed && parsed.version === 1 && parsed.fields && !/webhook|token|secret/i.test(raw) ? { ok: true, draft: createAdminDraftState(parsed.tab, parsed.fields, parsed.focus, parsed.scope) } : { ok: false, outcome: "invalid-draft" };
    } catch (error) {
      return { ok: false, outcome: "storage-failed", error };
    }
  }
  function isAdminDraftEmpty(draft) {
    const fields = draft && draft.fields && typeof draft.fields === "object" && !Array.isArray(draft.fields) ? draft.fields : {};
    return Object.values(fields).every((value) => String(value ?? "") === "");
  }
  function gateAdminDraftReload(storage, key, draft) {
    const saved = persistAdminDraft(storage, key, draft);
    if (!saved.ok) return isAdminDraftEmpty(draft) ? { ...saved, ok: true, outcome: "storage-failed-empty-draft" } : saved;
    const restored = restoreAdminDraft(storage, key);
    return restored.ok ? { ok: true, outcome: "readback-verified", draft: restored.draft } : restored;
  }
  function resolvePanelExit(reason, dirty, persistResult) {
    if (!dirty || persistResult && persistResult.ok) {
      return { proceed: true, actionGroup: [], focusAction: null, announce: false };
    }
    const isReload = String(reason) === "reload";
    const actionGroup = isReload ? ["Save", "Discard", "Reload"] : ["Save", "Discard", "Cancel"];
    return { proceed: false, actionGroup, focusAction: actionGroup[0], announce: true };
  }
  const PANEL_BACKFILL_ORPHAN_CAP = 12;
  function createNameBackfillPlan(ids, visibleIds, orphanCap = PANEL_BACKFILL_ORPHAN_CAP) {
    const source = Array.isArray(ids) ? ids : [];
    const sourceSet = new Set(source.map(String));
    const visible = new Set(Array.isArray(visibleIds) ? visibleIds.map(String) : []);
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of (Array.isArray(visibleIds) ? visibleIds : []).concat(source)) {
      const value = String(id || "");
      if (!value || seen.has(value) || !sourceSet.has(value)) continue;
      seen.add(value);
      ordered.push(value);
    }
    const capped = Number.isFinite(Number(orphanCap)) ? Math.max(0, Math.floor(Number(orphanCap))) : PANEL_BACKFILL_ORPHAN_CAP;
    const visiblePart = ordered.filter((id) => visible.has(id));
    const orphanPart = ordered.filter((id) => !visible.has(id)).slice(0, capped);
    return { ids: visiblePart.concat(orphanPart), visibleIds: visiblePart, orphanIds: orphanPart, orphanCap: capped };
  }
  async function runNameBackfill(ids, options = {}) {
    const source = Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))] : [];
    const fetchProfile = typeof options.fetchProfile === "function" ? options.fetchProfile : (id, signal) => fetch("/profile/" + encodeURIComponent(id), { signal });
    const concurrency = Number.isFinite(Number(options.concurrency)) ? Math.max(1, Math.floor(Number(options.concurrency))) : NAME_BACKFILL_MAX_CONCURRENCY;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : NAME_BACKFILL_TIMEOUT_MS;
    const signal = options.signal;
    const resolved = [];
    const deadIds = [];
    const failedIds = [];
    let cursor = 0;
    const fetchOne = async (id) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchProfile(id, controller.signal);
        if (!response) { failedIds.push(id); return; }
        if (response.status === 404 || response.status === 410) { deadIds.push(id); return; }
        if (!response.ok) { failedIds.push(id); return; }
        const name = extractNameFromProfileHtml(await response.text());
        if (name) resolved.push({ id, name }); else failedIds.push(id);
      } catch (error) {
        if (!error || error.name !== "AbortError") failedIds.push(id);
      } finally {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", abort);
      }
    };
    const worker = async () => {
      while (cursor < source.length) {
        const id = source[cursor];
        cursor += 1;
        await fetchOne(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, source.length) }, worker));
    return { resolved, deadIds, failedIds, failedCount: failedIds.length + deadIds.length };
  }
  function isPanelAsyncResultCurrent(requestEpoch, currentEpoch, requestTab, currentTab, isOpen, isLeader) {
    return requestEpoch === currentEpoch && requestTab === currentTab && isOpen === true && isLeader === true;
  }
  function patchPlayerNameNodes(root, updates, previousNames) {
    if (!root || typeof root.querySelectorAll !== "function" || !Array.isArray(updates)) return 0;
    const nodes = Array.from(root.querySelectorAll("[data-player-id]"));
    const previous = previousNames && typeof previousNames === "object" ? previousNames : {};
    let patched = 0;
    for (const update of updates) {
      const id = String(update && update.id || "");
      const name = String(update && update.name || "").trim();
      if (!id || !name) continue;
      for (const node of nodes) {
        if (!node || !node.dataset || String(node.dataset.playerId) !== id) continue;
        const current = String(node.textContent || "").trim();
        if (previous[id] !== void 0 && current !== String(previous[id])) continue;
        node.textContent = name;
        patched += 1;
      }
    }
    return patched;
  }
  function applyPanelLeaseState(isLeader, root) {
    const target = root || (typeof document !== "undefined" ? document : null);
    if (!target || typeof target.querySelectorAll !== "function") return { leader: Boolean(isLeader), controls: 0 };
    const controls = Array.from(target.querySelectorAll("[data-mutation-control]"));
    controls.forEach((control) => {
      control.disabled = !isLeader;
    });
    const banner = typeof target.querySelector === "function" ? target.querySelector("[data-taa-standby-banner]") : null;
    if (banner) {
      banner.textContent = isLeader ? "Leader — this tab owns monitoring and transport." : "Standby — this follower is read-only; configuration writes are disabled.";
    }
    return { leader: Boolean(isLeader), controls: controls.length };
  }
  function setStandbyVisibility(standby) {
    if (typeof document === "undefined") {
      return;
    }
    const body = document.body;
    if (!body) {
      return;
    }
    body.dataset.taaLeaseState = standby ? "standby" : "leader";
    applyPanelLeaseState(!standby);
    const existing = document.getElementById("taa-standby-status");
    if (!standby) {
      if (existing) {
        existing.remove();
      }
      return;
    }
    if (existing) {
      return;
    }
    const status = document.createElement("div");
    status.id = "taa-standby-status";
    status.setAttribute("role", "status");
    status.textContent = "Alert monitoring standby — waiting for this tab to reacquire leadership.";
    Object.assign(status.style, {
      position: "fixed",
      zIndex: "2147483647",
      inset: "0 0 auto 0",
      padding: "8px 12px",
      background: "#3a2b18",
      color: "#f8e6b0",
      font: "12px system-ui, sans-serif",
      textAlign: "center"
    });
    body.appendChild(status);
  }
  function startLeaseRenewal(worldHostname, ownerId) {
    const tokenAtSchedule = tabLeaseToken;
    const generationAtSchedule = tabLeaseGeneration;
    setTimeout(() => {
      if (!isLifecycleFenceValid(
        tabLeaseActive,
        tokenAtSchedule,
        tabLeaseToken
      ) || generationAtSchedule !== tabLeaseGeneration) {
        return;
      }
      if (!renewLease(
        worldHostname,
        ownerId,
        Date.now(),
        tabLeaseToken
      )) {
        enterLeaderStandby("renewal-failed");
        return;
      }
      startLeaseRenewal(worldHostname, ownerId);
    }, TAB_LEASE_RENEW_MS);
  }
  function startFollowerWatchdog(worldHostname, ownerId, resumeSameDocument) {
    if (followerWatchdogTimerId !== null) {
      if (followerWatchdogCheck) {
        followerWatchdogCheck();
      }
      return;
    }
    const checkLeaseAndRetry = () => {
      if (followerWatchdogTimerId !== null) {
        clearTimeout(followerWatchdogTimerId);
      }
      followerWatchdogTimerId = null;
      const lease = loadLease(worldHostname);
      const cls = classifyLease(lease, ownerId, Date.now());
      if (cls === "none" || cls === "expired") {
        const acquired = acquireLease(
          worldHostname,
          ownerId,
          Date.now()
        );
        if (acquired === true) {
          followerWatchdogCheck = null;
          const record = loadLeaseRecord(worldHostname);
          tabLeaseActive = true;
          tabLeaseBestEffort = false;
          activeLeaseOwnerId = ownerId;
          tabLeaseToken = record && record.token;
          tabLeaseGeneration = record && record.generation;
          tabLeaseTerm = record && record.term;
          setStandbyVisibility(false);
          reportLifecycleHook("onLeaseAcquired", {
            generation: tabLeaseGeneration,
            sameDocument: resumeSameDocument === true
          });
          if (resumeSameDocument) {
            startLeaseRenewal(worldHostname, ownerId);
            flushPendingBatch();
            if (!scanAttemptedForDocument) {
              installReadinessObserver();
            }
            scheduleRandomReload();
            scheduleBatchFlush();
          } else {
            requestLifecycleReload("follower-takeover", true);
          }
          return;
        }
      }
      followerWatchdogTimerId = setTimeout(
        checkLeaseAndRetry,
        TAB_LEASE_RETRY_MS
      );
    };
    followerWatchdogCheck = checkLeaseAndRetry;
    checkLeaseAndRetry();
  }
  function enterLeaderStandby(reason) {
    if (!tabLeaseActive && followerWatchdogTimerId !== null) {
      return;
    }
    if (!scanAttemptedForDocument) {
      finishScanCycle(decideScanCycleOutcome({ leaseHeld: false }));
    }
    tabLeaseActive = false;
    console.warn("[Alliance Discord] Leader standby (" + String(reason || "lease-lost") + ").");
    applyPanelLeaseState(false);
    cancelLifecycleCallbacks();
    setStandbyVisibility(true);
    reportLifecycleHook("onStandby", {
      reason: String(reason || "lease-lost"),
      atMs: Date.now()
    });
    if (activeLeaseOwnerId) {
      startFollowerWatchdog(
        location.hostname,
        activeLeaseOwnerId,
        true
      );
    }
  }
  async function runAttackLifecycleForDocument(options = {}) {
    const events = [];
    let snapshot = null;
    try {
      if (typeof options.scan !== "function") return { outcome: "scan-missing", events };
      snapshot = await options.scan();
      events.push("scan");
      if (snapshot && snapshot.status === "authoritative") {
        if (typeof options.commit === "function") {
          await options.commit(snapshot);
          events.push("commit");
        }
      }
    } catch (error) {
      return { outcome: "scan-failed", error, events };
    } finally {
      for (const [name, callback] of [["flush", options.flush], ["reload", options.reload], ["lease", options.lease]]) {
        if (typeof callback !== "function") continue;
        try {
          await callback();
          events.push(name);
        } catch (error) {
          events.push(name + "-failed");
        }
      }
    }
    return { outcome: "complete", snapshot, events };
  }
  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function escapeDiscordMarkdown(value) {
    return String(value || "").replace(/([\\`*_{}\[\]()~>#+\-.!|])/g, "\\$1");
  }
  function truncateText(value, maxLength) {
    const text = String(value || "");
    const max = typeof maxLength === "number" && Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 0;
    if (text.length <= max) {
      return text;
    }
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(void 0, {
        granularity: "grapheme"
      });
      return Array.from(segmenter.segment(text)).slice(0, max).map((segment) => segment.segment).join("");
    }
    return Array.from(text).slice(0, max).join("");
  }
  function encodeMarkdownUrl(url) {
    return String(url || "").replace(
      /([\\()\s<>])/g,
      "\\$1"
    );
  }
  function getLocationOrigin() {
    if (typeof location !== "undefined" && location && typeof location.origin === "string" && location.origin !== "") {
      return location.origin;
    }
    return null;
  }
  function getLocationHref() {
    if (typeof location !== "undefined" && location && typeof location.href === "string" && location.href !== "") {
      return location.href;
    }
    return null;
  }
  function safeProfileUrl(url, context) {
    const source = context && typeof context === "object" ? context : {};
    const origin = typeof source.origin === "string" && source.origin !== "" ? source.origin : getLocationOrigin();
    const fallbackHref = typeof source.fallbackHref === "string" && source.fallbackHref !== "" ? source.fallbackHref : getLocationHref();
    let trustedFallback = null;
    if (fallbackHref !== null && origin !== null) {
      try {
        const fallbackParsed = new URL(fallbackHref, origin);
        if (fallbackParsed.origin === origin) {
          trustedFallback = truncateText(
            fallbackParsed.href,
            EVENT_URL_MAX
          );
        }
      } catch (error) {
        trustedFallback = null;
      }
    }
    const raw = typeof url === "string" ? url : "";
    if (raw.trim() === "") {
      return trustedFallback !== null ? trustedFallback : "";
    }
    let parsed = null;
    if (origin !== null) {
      try {
        parsed = new URL(raw, origin);
      } catch (error) {
        parsed = null;
      }
    }
    const trusted = parsed !== null && parsed.origin === origin;
    if (!trusted) {
      return trustedFallback !== null ? trustedFallback : "";
    }
    return truncateText(parsed.href, EVENT_URL_MAX);
  }
  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Memory read error:",
        error
      );
      return {};
    }
  }
  function saveState(state) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(state)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Memory save error:",
        error
      );
    }
  }
  function normalizeHostname(hostname) {
    return String(hostname).toLowerCase();
  }
  function loadMappings() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(MAPPING_STORAGE_KEY);
      const mappings = saved ? JSON.parse(saved) : {};
      return mappings && typeof mappings === "object" && !Array.isArray(mappings) ? mappings : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Mappings read error:",
        error
      );
      return {};
    }
  }
  function inspectMappingStorage(rawValue, hostname) {
    if (rawValue === null || rawValue === void 0) return { status: "absent", currentEntries: 0, otherHostEntries: 0, otherHostBuckets: 0 };
    let parsed;
    try {
      parsed = JSON.parse(String(rawValue));
    } catch (error) {
      return { status: "malformed", currentEntries: 0, otherHostEntries: 0, otherHostBuckets: 0 };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "malformed", currentEntries: 0, otherHostEntries: 0, otherHostBuckets: 0 };
    const normalizedHost = (value) => String(value || "").toLowerCase().replace(/\.+$/, "");
    const currentHost = normalizedHost(hostname);
    let currentEntries = 0;
    let otherHostEntries = 0;
    const otherHosts = new Set();
    for (const [bucketHost, bucket] of Object.entries(parsed)) {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
      const count = Object.keys(bucket).length;
      if (normalizedHost(bucketHost) === currentHost) currentEntries += count;
      else if (count > 0) {
        otherHostEntries += count;
        otherHosts.add(normalizedHost(bucketHost));
      }
    }
    const result = { status: currentEntries ? "current" : otherHostEntries ? "other-host" : "empty", currentEntries, otherHostEntries, otherHostBuckets: otherHosts.size };
    return result;
  }
  function inspectDiscordConfigStorage(rawValue) {
    if (rawValue === null || rawValue === void 0) return { status: "absent", validFields: 0, invalidFields: 0 };
    let parsed;
    try {
      parsed = JSON.parse(String(rawValue));
    } catch (error) {
      return { status: "malformed", validFields: 0, invalidFields: 0 };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "malformed", validFields: 0, invalidFields: 0 };
    const fields = ["roleId", "leaveRoleId"];
    let validFields = 0;
    let invalidFields = 0;
    for (const field of fields) {
      if (parsed[field] === void 0 || parsed[field] === null || parsed[field] === "") continue;
      if (validateDiscordRoleId(parsed[field])) validFields += 1;
      else invalidFields += 1;
    }
    return { status: invalidFields > 0 ? "invalid" : validFields > 0 ? "valid" : "empty", validFields, invalidFields };
  }
  function loadMappingsProvenance(hostname) {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(MAPPING_STORAGE_KEY);
    return inspectMappingStorage(raw, hostname);
  }
  function loadDiscordConfigProvenance() {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DISCORD_CONFIG_STORAGE_KEY);
    return inspectDiscordConfigStorage(raw);
  }
  function buildStorageProvenanceModel(hostname, raw = null) {
    const supplied = raw && typeof raw === "object" ? raw : null;
    return {
      mappings: supplied ? inspectMappingStorage(supplied[MAPPING_STORAGE_KEY], hostname) : loadMappingsProvenance(hostname),
      discord: supplied ? inspectDiscordConfigStorage(supplied[DISCORD_CONFIG_STORAGE_KEY]) : loadDiscordConfigProvenance()
    };
  }
  function storageProvenanceText(model) {
    const source = model && typeof model === "object" ? model : {};
    const mappings = source.mappings || { status: "absent", currentEntries: 0, otherHostEntries: 0, otherHostBuckets: 0 };
    const discord = source.discord || { status: "absent", validFields: 0, invalidFields: 0 };
    const mappingText = mappings.status === "absent" ? "mapping data not found (storage key is absent)." : mappings.status === "malformed" ? "mapping data is malformed; no records were used." : mappings.status === "other-host" ? "mapping data found as other-world data (" + mappings.otherHostEntries + " entries in " + mappings.otherHostBuckets + " other hostname bucket(s)); nothing was copied." : mappings.status === "current" ? "mapping data stored for this world (" + mappings.currentEntries + " entries)." : "mapping data is empty (0 entries for this world).";
    const roleText = discord.status === "absent" ? "role configuration not found (storage key is absent)." : discord.status === "malformed" ? "role configuration is malformed; no values were used." : discord.status === "invalid" ? "role configuration has invalid values (" + discord.invalidFields + " invalid, " + discord.validFields + " valid). Nothing was normalized or written." : discord.status === "empty" ? "role configuration is empty (no values stored)." : "role configuration stored (" + discord.validFields + " valid value(s)).";
    return [mappingText, roleText];
  }
  function saveMappings(mappings) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      localStorage.setItem(
        MAPPING_STORAGE_KEY,
        JSON.stringify(mappings || {})
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Mappings save error:",
        error
      );
    }
  }
  function loadDiscordConfig() {
    const normalize = (value) => {
      const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      return {
        roleId: validateDiscordRoleId(source.roleId),
        leaveRoleId: validateDiscordRoleId(source.leaveRoleId)
      };
    };
    if (typeof localStorage === "undefined") {
      return { roleId: null, leaveRoleId: null };
    }
    try {
      const saved = localStorage.getItem(
        DISCORD_CONFIG_STORAGE_KEY
      );
      const config = saved ? JSON.parse(saved) : {};
      return normalize(config);
    } catch (error) {
      console.error(
        "[Alliance Discord] Discord config read error:",
        error
      );
      return { roleId: null, leaveRoleId: null };
    }
  }
  function saveDiscordConfig(config) {
    if (typeof localStorage === "undefined") {
      return;
    }
    const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const normalized = {
      roleId: validateDiscordRoleId(source.roleId),
      leaveRoleId: validateDiscordRoleId(source.leaveRoleId)
    };
    if (source.roleId != null && normalized.roleId === null || source.leaveRoleId != null && normalized.leaveRoleId === null) {
      return { ok: false, kind: "invalid-config" };
    }
    try {
      return writeVerifiedJson(
        localStorage,
        DISCORD_CONFIG_STORAGE_KEY,
        normalized
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Discord config save error:",
        error
      );
      return { ok: false, kind: "save-threw", error };
    }
  }
  function validateWebhookUrl(input) {
    if (typeof input !== "string") {
      return null;
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.hostname !== "discord.com") {
      return null;
    }
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
      return null;
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      return null;
    }
    const match = parsed.pathname.match(
      /^\/api\/webhooks\/(\d+)\/([^/]+)$/
    );
    if (!match) {
      return null;
    }
    if (match[2].trim() === "") {
      return null;
    }
    return parsed.href;
  }
  function maskWebhookUrl(input) {
    const validated = validateWebhookUrl(input);
    if (!validated) return input ? "[invalid webhook]" : "";
    const parts = validated.split("/");
    parts[parts.length - 1] = "••••••••";
    return parts.join("/");
  }
  function loadWebhookUrl() {
    if (typeof GM_getValue !== "function") {
      return null;
    }
    try {
      return validateWebhookUrl(
        GM_getValue(WEBHOOK_STORAGE_KEY, null)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL read error:",
        error
      );
      return null;
    }
  }
  function saveWebhookUrl(url) {
    if (typeof GM_setValue !== "function") {
      return false;
    }
    const validated = validateWebhookUrl(url);
    if (validated === null) {
      return false;
    }
    try {
      GM_setValue(WEBHOOK_STORAGE_KEY, validated);
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL save error:",
        error
      );
      return false;
    }
  }
  function clearWebhookUrl() {
    if (typeof GM_deleteValue !== "function") {
      return false;
    }
    try {
      GM_deleteValue(WEBHOOK_STORAGE_KEY);
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Webhook URL clear error:",
        error
      );
      return false;
    }
  }
  function loadMutedPlayers() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        MUTED_PLAYERS_STORAGE_KEY
      );
      const mutes = saved ? JSON.parse(saved) : {};
      return mutes && typeof mutes === "object" && !Array.isArray(mutes) ? mutes : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Muted players read error:",
        error
      );
      return {};
    }
  }
  function saveMutedPlayers(mutes) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      localStorage.setItem(
        MUTED_PLAYERS_STORAGE_KEY,
        JSON.stringify(mutes || {})
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Muted players save error:",
        error
      );
    }
  }
  function loadPlayerNames() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        PLAYER_NAMES_STORAGE_KEY
      );
      const names = saved ? JSON.parse(saved) : {};
      return names && typeof names === "object" && !Array.isArray(names) ? names : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Player names read error:",
        error
      );
      return {};
    }
  }
  function savePlayerNames(names) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      localStorage.setItem(
        PLAYER_NAMES_STORAGE_KEY,
        JSON.stringify(names || {})
      );
    } catch (error) {
      console.warn(
        "[Alliance Discord] Player names save error:",
        error
      );
    }
  }
  function addPlayerNamesBatch(names, hostname, entries) {
    const base = names && typeof names === "object" ? names : {};
    const worldKey = String(hostname).toLowerCase();
    const world = base[worldKey];
    const nextWorld = world && typeof world === "object" ? Object.assign({}, world) : {};
    let changed = false;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        if (typeof entry.id !== "string" || entry.id.length === 0) {
          continue;
        }
        const id = entry.id;
        const name = cleanText(entry.name);
        if (!name) {
          continue;
        }
        if (nextWorld[id] === name) {
          continue;
        }
        nextWorld[id] = name;
        changed = true;
      }
    }
    if (!changed) {
      return names;
    }
    const nextNames = Object.assign({}, base);
    nextNames[worldKey] = nextWorld;
    return nextNames;
  }
  function buildIdToName(names, hostname) {
    const base = names && typeof names === "object" ? names : {};
    const world = base[String(hostname).toLowerCase()];
    return new Map(
      world && typeof world === "object" ? Object.entries(world) : []
    );
  }
  function loadPlayerNamesNotFound() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        PLAYER_NAMES_NOT_FOUND_KEY
      );
      const notFound = saved ? JSON.parse(saved) : {};
      return notFound && typeof notFound === "object" && !Array.isArray(notFound) ? notFound : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Player names not-found read error:",
        error
      );
      return {};
    }
  }
  function savePlayerNamesNotFound(notFound) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      localStorage.setItem(
        PLAYER_NAMES_NOT_FOUND_KEY,
        JSON.stringify(notFound || {})
      );
    } catch (error) {
      console.warn(
        "[Alliance Discord] Player names not-found save error:",
        error
      );
    }
  }
  function loadRoster() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        ROSTER_STORAGE_KEY
      );
      const roster = saved ? JSON.parse(saved) : {};
      return roster && typeof roster === "object" && !Array.isArray(roster) ? roster : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Roster read error:",
        error
      );
      return {};
    }
  }
  function saveRoster(roster) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      localStorage.setItem(
        ROSTER_STORAGE_KEY,
        JSON.stringify(roster || {})
      );
    } catch (error) {
      console.warn(
        "[Alliance Discord] Roster save error:",
        error
      );
    }
  }
  function buildRosterMap(members) {
    if (!Array.isArray(members)) {
      return {};
    }
    const result = {};
    for (const member of members) {
      if (!member || typeof member !== "object" || typeof member.id !== "string" || member.id.length === 0) {
        continue;
      }
      const name = cleanText(member.name);
      if (!name) {
        continue;
      }
      result[member.id] = {
        name,
        url: member.url
      };
    }
    return result;
  }
  function diffRoster(previousMap, currentMap) {
    const previous = previousMap && typeof previousMap === "object" && !Array.isArray(previousMap) ? previousMap : {};
    const current = currentMap && typeof currentMap === "object" && !Array.isArray(currentMap) ? currentMap : {};
    const joined = [];
    const left = [];
    for (const [id, entry] of Object.entries(current)) {
      if (!entry || typeof entry !== "object" || Object.prototype.hasOwnProperty.call(previous, id)) {
        continue;
      }
      joined.push({
        id,
        name: entry.name,
        url: entry.url
      });
    }
    for (const [id, entry] of Object.entries(previous)) {
      if (!entry || typeof entry !== "object" || Object.prototype.hasOwnProperty.call(current, id)) {
        continue;
      }
      left.push({
        id,
        name: entry.name,
        url: entry.url
      });
    }
    return {
      joined,
      left,
      changed: joined.length > 0 || left.length > 0
    };
  }
  function markPlayerNamesNotFound(notFound, hostname, ids, now) {
    const base = notFound && typeof notFound === "object" ? notFound : {};
    const worldKey = String(hostname).toLowerCase();
    const world = base[worldKey];
    const nextWorld = world && typeof world === "object" ? Object.assign({}, world) : {};
    let changed = false;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0) {
          continue;
        }
        if (nextWorld[id] === now) {
          continue;
        }
        nextWorld[id] = now;
        changed = true;
      }
    }
    if (!changed) {
      return notFound;
    }
    const nextNotFound = Object.assign({}, base);
    nextNotFound[worldKey] = nextWorld;
    return nextNotFound;
  }
  function buildNotFoundIdSet(notFound, hostname, now) {
    const base = notFound && typeof notFound === "object" ? notFound : {};
    const world = base[String(hostname).toLowerCase()];
    const result = /* @__PURE__ */ new Set();
    if (world && typeof world === "object") {
      const cutoff = now - NAME_NOT_FOUND_TTL_MS;
      for (const [id, ts] of Object.entries(world)) {
        if (typeof ts === "number" && Number.isFinite(ts) && ts >= cutoff) {
          result.add(id);
        }
      }
    }
    return result;
  }
  function collectUnknownIds(mappingItems, mutedIds, idToName, excludeIds) {
    const seen = /* @__PURE__ */ new Set();
    const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
    const result = [];
    const consider = (id) => {
      if (typeof id !== "string" || id.length === 0 || seen.has(id) || idToName.has(id) || exclude.has(id)) {
        return;
      }
      seen.add(id);
      result.push(id);
    };
    if (Array.isArray(mappingItems)) {
      for (const item of mappingItems) {
        if (typeof item !== "string") {
          continue;
        }
        const idPart = item.split(" → ")[0];
        consider(idPart);
      }
    }
    if (Array.isArray(mutedIds)) {
      for (const id of mutedIds) {
        consider(id);
      }
    }
    return result;
  }
  function extractNameFromProfileHtml(html) {
    const m = String(html || "").match(
      /<h1[^>]*class="[^"]*titleInHeader[^"]*"[^>]*>([^<]+)<\/h1>/i
    );
    let name = m ? m[1] : null;
    if (name !== null) {
      name = String(name).replace(
        /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
        (match, entity) => {
          const lower = entity.toLowerCase();
          if (lower === "amp") {
            return "&";
          }
          if (lower === "lt") {
            return "<";
          }
          if (lower === "gt") {
            return ">";
          }
          if (lower === "quot") {
            return '"';
          }
          if (lower === "apos") {
            return "'";
          }
          const num = lower.charAt(0) === "#" ? lower.charAt(1) === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10) : NaN;
          if (Number.isFinite(num) && num >= 0 && num <= 1114111) {
            return String.fromCodePoint(num);
          }
          return match;
        }
      );
    }
    return cleanText(name) || null;
  }
  function getDefaultSettings() {
    return {
      attackThreshold: DEFAULT_SETTINGS.attackThreshold,
      raidThreshold: DEFAULT_SETTINGS.raidThreshold,
      normalMax: DEFAULT_SETTINGS.normalMax,
      highMax: DEFAULT_SETTINGS.highMax
    };
  }
  function validateSettings(raw) {
    const defaults = getDefaultSettings();
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const readThreshold = (value, fallback) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
      }
      return Math.min(
        999,
        Math.max(1, Math.floor(value))
      );
    };
    const readBand = (value, fallback) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
      }
      return Math.max(1, Math.floor(value));
    };
    const settings = {
      attackThreshold: readThreshold(
        source.attackThreshold,
        defaults.attackThreshold
      ),
      raidThreshold: readThreshold(
        source.raidThreshold,
        defaults.raidThreshold
      ),
      normalMax: readBand(
        source.normalMax,
        defaults.normalMax
      ),
      highMax: readBand(
        source.highMax,
        defaults.highMax
      )
    };
    if (settings.normalMax >= settings.highMax) {
      settings.normalMax = defaults.normalMax;
      settings.highMax = defaults.highMax;
    }
    return settings;
  }
  function loadSettings(hostname) {
    if (typeof localStorage === "undefined") {
      return getDefaultSettings();
    }
    try {
      const saved = localStorage.getItem(
        SETTINGS_STORAGE_KEY
      );
      const map = saved ? JSON.parse(saved) : {};
      const world = map && typeof map === "object" && !Array.isArray(map) ? map[normalizeHostname(hostname)] : null;
      return validateSettings(world);
    } catch (error) {
      console.error(
        "[Alliance Discord] Settings read error:",
        error
      );
      return getDefaultSettings();
    }
  }
  function saveSettings(settings, hostname) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const saved = localStorage.getItem(
        SETTINGS_STORAGE_KEY
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
      const worldKey = normalizeHostname(hostname);
      const nextMap = Object.assign({}, base);
      nextMap[worldKey] = validateSettings(settings);
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Settings save error:",
        error
      );
    }
  }
  const SETTINGS_BACKUP_DATA_KEYS = Object.freeze([
    MAPPING_STORAGE_KEY,
    DISCORD_CONFIG_STORAGE_KEY,
    WEBHOOK_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    MUTED_PLAYERS_STORAGE_KEY,
    PLAYER_NAMES_STORAGE_KEY,
    ROSTER_STORAGE_KEY
  ]);
  function parseSettingsBackupValue(value, fallback) {
    if (value === null || value === void 0 || value === "") return fallback;
    try {
      return JSON.parse(String(value));
    } catch (error) {
      return fallback;
    }
  }
  function settingsBackupStorageValue(storage, key) {
    if (!storage || typeof storage.getItem !== "function") return {};
    return parseSettingsBackupValue(storage.getItem(key), {});
  }
  function mergeSettingsBackupMap(current, imported, hostname, validateWorld) {
    const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    const source = imported && typeof imported === "object" && !Array.isArray(imported) ? imported : {};
    const worldKey = normalizeHostname(hostname);
    const next = Object.assign({}, base);
    let currentEntries = 0;
    let otherHostEntries = 0;
    let invalid = 0;
    for (const [rawHost, rawWorld] of Object.entries(source)) {
      const host = normalizeHostname(rawHost);
      if (!rawWorld || typeof rawWorld !== "object" || Array.isArray(rawWorld)) { invalid += 1; continue; }
      const accepted = validateWorld(rawWorld, () => { invalid += 1; });
      if (!accepted || !Object.keys(accepted).length) continue;
      const existing = host === worldKey && next[host] && typeof next[host] === "object" ? next[host] : {};
      next[host] = host === worldKey ? Object.assign({}, existing, accepted) : Object.assign({}, existing, Object.fromEntries(Object.entries(accepted).filter(([key]) => !Object.prototype.hasOwnProperty.call(existing, key))));
      const count = Object.keys(accepted).length;
      if (host === worldKey) currentEntries += count; else otherHostEntries += count;
    }
    return { value: next, currentEntries, otherHostEntries, invalid };
  }
  function buildSettingsBackup(input = {}) {
    const hostname = normalizeHostname(input.hostname || (typeof location !== "undefined" ? location.hostname : ""));
    const storage = input.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const data = {};
    for (const key of SETTINGS_BACKUP_DATA_KEYS) data[key] = key === WEBHOOK_STORAGE_KEY ? (() => { const value = String(input.webhook === void 0 ? loadWebhookUrl() || "" : input.webhook); return value ? { action: "set", url: value } : { action: "clear" }; })() : settingsBackupStorageValue(storage, key);
    const backup = { schemaVersion: 1, kind: "taa-settings-backup", exportedAt: new Date(Number.isFinite(input.nowMs) ? input.nowMs : Date.now()).toISOString(), releaseId: RELEASE_ID, hostname, data };
    const serialized = JSON.stringify(backup);
    return diagnosticByteLength(serialized) <= DIAGNOSTICS_LIMITS.exportBytes ? backup : { schemaVersion: 1, kind: "taa-settings-backup", bounded: true, boundedMessage: "Settings export bounded: content exceeded 512 KiB; sensitive data omitted.", releaseId: RELEASE_ID, hostname, data: {} };
  }
  function inspectSettingsBackup(raw, hostname, current = {}) {
    let backup;
    try { backup = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (error) { return { ok: false, reason: "invalid-json", invalid: ["json"] }; }
    if (!backup || backup.kind !== "taa-settings-backup" || backup.schemaVersion !== 1 || !backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) return { ok: false, reason: "unsupported-backup", invalid: ["envelope"] };
    const worldKey = normalizeHostname(hostname);
    if (!worldKey || !/^[a-z0-9.-]+$/.test(worldKey)) return { ok: false, reason: "invalid-host", invalid: ["hostname"] };
    const invalid = [];
    const data = backup.data;
    const known = new Set(SETTINGS_BACKUP_DATA_KEYS);
    for (const key of Object.keys(data)) if (!known.has(key)) invalid.push(key);
    const strictWorldMap = (key, validator) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return { value: current[key], currentEntries: 0, otherHostEntries: 0 };
      const source = data[key];
      if (!source || typeof source !== "object" || Array.isArray(source)) { invalid.push(key); return { value: current[key], currentEntries: 0, otherHostEntries: 0 }; }
      for (const rawHost of Object.keys(source)) {
        const host = normalizeHostname(rawHost);
        if (!host || !/^[a-z0-9.-]+$/.test(host) || host !== rawHost) { invalid.push(key); continue; }
        const world = source[rawHost];
        if (!world || typeof world !== "object" || Array.isArray(world)) { invalid.push(key); continue; }
        validator(world, key);
      }
      return mergeSettingsBackupMap(current[key], source, worldKey, (world, reject) => validator(world, key, reject));
    };
    const validateMapping = (world, key, reject = () => invalid.push(key)) => {
      const accepted = {};
      for (const [playerId, ids] of Object.entries(world)) {
        if (!/^\d+$/.test(playerId) || !Array.isArray(ids) || !ids.length || ids.some((id) => !validateDiscordUserId(id))) { reject(); continue; }
        accepted[playerId] = [...new Set(ids.map(validateDiscordUserId))];
      }
      return accepted;
    };
    const validateSettingsWorld = (world, key, reject = () => invalid.push(key)) => {
      const accepted = {};
      for (const field of ["attackThreshold", "raidThreshold", "normalMax", "highMax"]) if (Object.prototype.hasOwnProperty.call(world, field)) {
        const value = world[field];
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || (field.endsWith("Threshold") && value > 999)) reject(); else accepted[field] = value;
      }
      if (Object.keys(accepted).length !== Object.keys(world).length || accepted.normalMax !== void 0 && accepted.highMax !== void 0 && accepted.normalMax >= accepted.highMax) reject();
      return accepted;
    };
    const validateSimple = (expected) => (world, key, reject = () => invalid.push(key)) => {
      const accepted = {};
      for (const [id, value] of Object.entries(world)) { if (!expected(value) || String(id).trim() === "") reject(); else accepted[id] = value; }
      return accepted;
    };
    const plans = {
      mappings: strictWorldMap(MAPPING_STORAGE_KEY, validateMapping),
      settings: strictWorldMap(SETTINGS_STORAGE_KEY, validateSettingsWorld),
      muted: strictWorldMap(MUTED_PLAYERS_STORAGE_KEY, validateSimple((value) => value === true)),
      names: strictWorldMap(PLAYER_NAMES_STORAGE_KEY, validateSimple((value) => typeof value === "string")),
      roster: strictWorldMap(ROSTER_STORAGE_KEY, validateSimple((value) => value && typeof value === "object" && !Array.isArray(value)))
    };
    let roles = current[DISCORD_CONFIG_STORAGE_KEY] && typeof current[DISCORD_CONFIG_STORAGE_KEY] === "object" ? Object.assign({ roleId: null, leaveRoleId: null }, current[DISCORD_CONFIG_STORAGE_KEY]) : { roleId: null, leaveRoleId: null };
    if (Object.prototype.hasOwnProperty.call(data, DISCORD_CONFIG_STORAGE_KEY)) {
      const source = data[DISCORD_CONFIG_STORAGE_KEY];
      if (!source || typeof source !== "object" || Array.isArray(source)) invalid.push(DISCORD_CONFIG_STORAGE_KEY); else for (const field of Object.keys(source)) {
        if (!["roleId", "leaveRoleId"].includes(field)) { invalid.push(DISCORD_CONFIG_STORAGE_KEY); continue; }
        if (source[field] !== null && source[field] !== "" && !validateDiscordRoleId(source[field])) invalid.push(DISCORD_CONFIG_STORAGE_KEY); else roles[field] = source[field] === "" ? null : source[field];
      }
    }
    let webhook = { action: "noop" };
    if (Object.prototype.hasOwnProperty.call(data, WEBHOOK_STORAGE_KEY)) {
      const source = data[WEBHOOK_STORAGE_KEY];
      if (typeof source === "string") { const url = validateWebhookUrl(source); if (!url) invalid.push(WEBHOOK_STORAGE_KEY); else webhook = { action: "set", url }; }
      else if (source && typeof source === "object" && !Array.isArray(source) && source.action === "clear" && Object.keys(source).length === 1) webhook = { action: "clear" };
      else if (source && typeof source === "object" && !Array.isArray(source) && source.action === "set" && Object.keys(source).length === 2 && typeof source.url === "string" && validateWebhookUrl(source.url)) webhook = { action: "set", url: validateWebhookUrl(source.url) };
      else invalid.push(WEBHOOK_STORAGE_KEY);
    }
    const counts = { current: plans.mappings.currentEntries, otherHost: Object.values(plans).reduce((sum, plan) => sum + (plan.otherHostEntries || 0), 0), invalid: invalid.length };
    if (invalid.length) return { ok: false, reason: "invalid-fields", invalid };
    return { ok: true, backup, invalid, roles, webhook, plans, counts };
  }
  function applySettingsBackup(raw, options = {}) {
    const storage = options.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const hostname = normalizeHostname(options.hostname || (typeof location !== "undefined" ? location.hostname : ""));
    const gm = options.gm || {};
    const readGm = typeof gm.get === "function" ? gm.get : () => typeof GM_getValue === "function" ? GM_getValue(WEBHOOK_STORAGE_KEY, void 0) : void 0;
    const current = {};
    try { for (const key of SETTINGS_BACKUP_DATA_KEYS) current[key] = key === WEBHOOK_STORAGE_KEY ? (options.webhook ? options.webhook.value || "" : validateWebhookUrl(readGm()) || "") : settingsBackupStorageValue(storage, key); } catch (error) { return { ok: false, reason: "preimage-failed" }; }
    const plan = inspectSettingsBackup(raw, hostname, current);
    if (!plan.ok) return plan;
    const original = new Map();
    try { for (let index = 0; index < (storage ? storage.length : 0); index += 1) { const key = storage.key(index); if (key !== null) original.set(key, storage.getItem(key)); } } catch (error) { return { ok: false, reason: "preimage-failed" }; }
    const oldWebhook = current[WEBHOOK_STORAGE_KEY];
    const oldWebhookRaw = options.webhook ? options.webhook.value : readGm();
    const gmWasPresent = oldWebhookRaw !== void 0;
    const webhook = options.webhook || { value: oldWebhook };
    const setWebhook = options.setWebhook || ((value) => { if (options.webhook) webhook.value = value; else if (typeof gm.set === "function") gm.set(value); else if (!saveWebhookUrl(value)) throw new Error("webhook-write-failed"); });
    const clearWebhook = options.clearWebhook || (() => { if (options.webhook) webhook.value = null; else if (typeof gm.remove === "function") gm.remove(); else clearWebhookUrl(); });
    const changed = Object.keys(plan.plans).filter((key) => Object.prototype.hasOwnProperty.call(plan.backup.data, key));
    try {
      for (const [key, item] of [[MAPPING_STORAGE_KEY, plan.plans.mappings], [SETTINGS_STORAGE_KEY, plan.plans.settings], [MUTED_PLAYERS_STORAGE_KEY, plan.plans.muted], [PLAYER_NAMES_STORAGE_KEY, plan.plans.names], [ROSTER_STORAGE_KEY, plan.plans.roster]]) if (Object.prototype.hasOwnProperty.call(plan.backup.data, key)) { const result = writeVerifiedJson(storage, key, item.value); if (!result.ok) throw result; }
      if (Object.prototype.hasOwnProperty.call(plan.backup.data, DISCORD_CONFIG_STORAGE_KEY)) { const result = writeVerifiedJson(storage, DISCORD_CONFIG_STORAGE_KEY, plan.roles); if (!result.ok) throw result; }
      if (plan.webhook.action === "set") setWebhook(plan.webhook.url); else if (plan.webhook.action === "clear") clearWebhook();
      const webhookAfter = options.webhook ? webhook.value : validateWebhookUrl(typeof gm.get === "function" ? gm.get() : loadWebhookUrl()) || "";
      if (plan.webhook.action === "set" && webhookAfter !== plan.webhook.url || plan.webhook.action === "clear" && webhookAfter !== "") throw new Error("webhook-readback-mismatch");
      return { ok: true, kind: "imported", summary: { current: plan.counts.current, otherHost: plan.counts.otherHost, changed: changed.length } };
    } catch (error) {
      try { for (const key of [...new Set([...original.keys(), ...SETTINGS_BACKUP_DATA_KEYS])]) { if (original.has(key)) storage.setItem(key, original.get(key)); else storage.removeItem(key); } if (options.webhook) webhook.value = oldWebhook || null; else if (gmWasPresent && typeof gm.set === "function") gm.set(oldWebhookRaw); else if (gmWasPresent && typeof GM_setValue === "function") GM_setValue(WEBHOOK_STORAGE_KEY, oldWebhookRaw); else if (!gmWasPresent && typeof gm.remove === "function") gm.remove(); else if (!gmWasPresent && typeof GM_deleteValue === "function") GM_deleteValue(WEBHOOK_STORAGE_KEY); } catch (rollbackError) { return { ok: false, reason: "rollback-failed" }; }
      return { ok: false, reason: "write-failed" };
    }
  }
  function addMutedPlayer(mutes, hostname, playerId) {
    const base = mutes && typeof mutes === "object" ? mutes : {};
    if (typeof playerId !== "string") {
      return mutes;
    }
    if (playerId.trim() === "") {
      return mutes;
    }
    const worldKey = normalizeHostname(hostname);
    const nextWorld = Object.assign(
      {},
      base[worldKey] || {}
    );
    nextWorld[playerId] = true;
    const nextMutes = Object.assign({}, base);
    nextMutes[worldKey] = nextWorld;
    return nextMutes;
  }
  function removeMutedPlayer(mutes, hostname, playerId) {
    const base = mutes && typeof mutes === "object" ? mutes : {};
    if (typeof playerId !== "string") {
      return mutes;
    }
    const worldKey = normalizeHostname(hostname);
    const world = base[worldKey];
    if (!world || typeof world !== "object" || !Object.prototype.hasOwnProperty.call(
      world,
      playerId
    )) {
      return mutes;
    }
    const nextWorld = Object.assign({}, world);
    delete nextWorld[playerId];
    const nextMutes = Object.assign({}, base);
    if (Object.keys(nextWorld).length > 0) {
      nextMutes[worldKey] = nextWorld;
    } else {
      delete nextMutes[worldKey];
    }
    return nextMutes;
  }
  function isPlayerMuted(mutes, hostname, playerId) {
    const base = mutes && typeof mutes === "object" ? mutes : {};
    if (typeof playerId !== "string" || playerId.trim() === "") {
      return false;
    }
    const world = base[normalizeHostname(hostname)];
    return Boolean(
      world && typeof world === "object" && world[playerId] === true
    );
  }
  function listMutedPlayers(mutes, hostname) {
    const base = mutes && typeof mutes === "object" ? mutes : {};
    const world = base[normalizeHostname(hostname)];
    if (!world || typeof world !== "object") {
      return [];
    }
    return Object.keys(world);
  }
  function filterMutedEvents(events, hostname, mutedPlayers) {
    if (!Array.isArray(events)) {
      return [];
    }
    const mutes = mutedPlayers && typeof mutedPlayers === "object" ? mutedPlayers : {};
    return events.filter((event) => {
      if (!event || typeof event !== "object") {
        return true;
      }
      if (event.eventType === "join" || event.eventType === "leave") {
        return true;
      }
      const playerId = extractPlayerId(event.url);
      if (playerId === null) {
        return true;
      }
      return !isPlayerMuted(
        mutes,
        hostname,
        playerId
      );
    });
  }
  function buildHistoryRecord(event, hostname, nowMs, mutes) {
    if (!event || typeof event !== "object") {
      return null;
    }
    const playerId = extractPlayerId(event.url);
    const muted = playerId !== null && isPlayerMuted(
      mutes,
      hostname,
      playerId
    );
    return {
      detectedAtMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
      name: event.name,
      url: event.url,
      playerId,
      attackCount: event.attackCount,
      raidCount: event.raidCount,
      addedAttackCount: event.addedAttackCount,
      addedRaidCount: event.addedRaidCount,
      eventType: event.eventType,
      priority: event.priority,
      muted,
      thresholdBlocked: !event.thresholdPass
    };
  }
  function recordHistory(history, hostname, record) {
    if (!record || typeof record !== "object") {
      return history;
    }
    const base = history && typeof history === "object" && !Array.isArray(history) ? history : {};
    const worldKey = normalizeHostname(hostname);
    const world = base[worldKey];
    const existingEvents = world && typeof world === "object" && Array.isArray(world.events) ? world.events : [];
    const allEvents = [record].concat(existingEvents);
    const historyOverflow = Math.max(0, allEvents.length - HISTORY_MAX_EVENTS);
    const nextEvents = allEvents.slice(0, HISTORY_MAX_EVENTS);
    const next = Object.assign({}, base);
    next[worldKey] = Object.assign(
      {},
      world && typeof world === "object" ? world : {},
      { events: nextEvents, ...(historyOverflow > 0 ? { overflowCount: historyOverflow, overflowReason: "history-cap", overflowMessage: "History bounded: oldest records were omitted after the history cap." } : {}) }
    );
    return next;
  }
  function loadHistory() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        HISTORY_STORAGE_KEY
      );
      const history = saved ? JSON.parse(saved) : {};
      return history && typeof history === "object" && !Array.isArray(history) ? history : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] History read error:",
        error
      );
      return {};
    }
  }
  function saveHistory(history, hostname) {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const saved = localStorage.getItem(
        HISTORY_STORAGE_KEY
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
      const historyBase = history && typeof history === "object" && !Array.isArray(history) ? history : {};
      const worldKey = normalizeHostname(hostname);
      let worldEntry = historyBase[worldKey];
      if (worldEntry === void 0) {
        const matchedKey = Object.keys(
          historyBase
        ).find(
          (key) => normalizeHostname(key) === worldKey
        );
        if (matchedKey !== void 0) {
          worldEntry = historyBase[matchedKey];
        }
      }
      const nextMap = Object.assign({}, base);
      if (worldEntry !== void 0) {
        nextMap[worldKey] = worldEntry;
      }
      localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] History save error:",
        error
      );
    }
  }
  function loadPendingBatch() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        PENDING_BATCH_STORAGE_KEY
      );
      const batch = saved ? JSON.parse(saved) : {};
      return batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Pending batch read error:",
        error
      );
      return {};
    }
  }
  function loadInFlightBatch() {
    const pendingBatch = loadPendingBatch();
    const inFlightBatch = {};
    for (const [worldKey, world] of Object.entries(pendingBatch)) {
      if (!world || typeof world !== "object" || Array.isArray(world) || !Array.isArray(world.inFlight)) {
        continue;
      }
      inFlightBatch[worldKey] = {
        events: world.inFlight.slice(),
        createdAt: world.createdAt
      };
    }
    return inFlightBatch;
  }
  function savePendingBatch(batch, hostname) {
    if (typeof localStorage === "undefined") {
      return false;
    }
    try {
      const saved = localStorage.getItem(
        PENDING_BATCH_STORAGE_KEY
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
      const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
      const worldKey = normalizeHostname(hostname);
      let worldEntry = batchBase[worldKey];
      if (worldEntry === void 0) {
        const matchedKey = Object.keys(
          batchBase
        ).find(
          (key) => normalizeHostname(key) === worldKey
        );
        if (matchedKey !== void 0) {
          worldEntry = batchBase[matchedKey];
        }
      }
      const nextMap = Object.assign({}, base);
      if (worldEntry !== void 0) {
        nextMap[worldKey] = worldEntry;
      }
      localStorage.setItem(
        PENDING_BATCH_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Pending batch save error:",
        error
      );
      return false;
    }
  }
  function toPendingEvent(event, options = {}) {
    const pending = {
      name: event.name,
      url: event.url,
      attackCount: event.attackCount,
      raidCount: event.raidCount,
      oldAttackCount: event.oldAttackCount,
      oldRaidCount: event.oldRaidCount,
      addedAttackCount: event.addedAttackCount,
      addedRaidCount: event.addedRaidCount,
      eventType: event.eventType
    };
    const playerId = event.playerId !== void 0 ? event.playerId : event.id;
    if (playerId !== void 0 && playerId !== null) {
      pending.playerId = String(playerId);
    }
    if (event.approximateObserved === true) {
      pending.approximateObserved = true;
    }
    if (event.observedAtApproximate === true) {
      pending.observedAtApproximate = true;
    }
    if (options.enforceQueueContract !== true) {
      if (Number.isFinite(event.observedAtMs)) {
        pending.observedAtMs = event.observedAtMs;
      }
      return pending;
    }
    return createMonitorQueueEvent(pending, Object.assign({}, options, {
      playerId: options.playerId !== void 0 ? options.playerId : event.playerId || event.id || extractPlayerId(event.url),
      observedAtMs: Number.isFinite(options.observedAtMs) ? options.observedAtMs : event.observedAtMs,
      queuedAtMs: Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : event.queuedAtMs
    }));
  }
  function enqueueEvents(batch, hostname, events, options = {}) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    if (!Array.isArray(events)) {
      return batchBase;
    }
    const worldKey = normalizeHostname(hostname);
    const existing = batchBase[worldKey];
    const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
    const nextEvents = current && Array.isArray(current.events) ? current.events.slice() : [];
    const createdAt = current && typeof current.createdAt === "number" ? current.createdAt : Date.now();
    const attemptCount = current && typeof current.attemptCount === "number" ? current.attemptCount : 0;
    const queuedAtMs = Date.now();
    for (const event of events) {
      nextEvents.push(toPendingEvent(event, {
        world: worldKey,
        queuedAtMs,
        enforceQueueContract: options.enforceQueueContract === true
      }));
    }
    const overflowCount = Math.max(0, nextEvents.length - QUEUE_MAX_EVENTS);
    const capped = overflowCount > 0 ? nextEvents.slice(
      nextEvents.length - QUEUE_MAX_EVENTS
    ) : nextEvents;
    const nextWorld = Object.assign({}, current, {
      events: capped,
      createdAt,
      attemptCount,
      ...(overflowCount > 0 ? {
        overflowCount: (Number(current && current.overflowCount) || 0) + overflowCount,
        overflowReason: "queue-cap",
        overflowMessage: "Queue bounded: oldest events were omitted after the queue cap."
      } : {})
    });
    const nextBatch = Object.assign({}, batchBase);
    nextBatch[worldKey] = nextWorld;
    return nextBatch;
  }
  function snapshotBatch(batch, hostname) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const world = batchBase[worldKey];
    if (!world || typeof world !== "object" || Array.isArray(world)) {
      return null;
    }
    const events = Array.isArray(world.events) ? world.events.slice() : [];
    if (events.length === 0) {
      return null;
    }
    return {
      events,
      createdAt: world.createdAt,
      attemptCount: world.attemptCount
    };
  }
  function chunkEvents(events, maxSize) {
    if (!Array.isArray(events)) {
      return [];
    }
    const size = typeof maxSize === "number" && Number.isFinite(maxSize) && maxSize >= 1 ? Math.floor(maxSize) : PAYLOAD_CHUNK_MAX;
    const chunks = [];
    for (let i = 0; i < events.length; i += size) {
      chunks.push(events.slice(i, i + size));
    }
    return chunks;
  }
  function clearBatchEvents(batch, hostname) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const world = batchBase[worldKey];
    if (!world || typeof world !== "object" || Array.isArray(world)) {
      return batchBase;
    }
    const nextWorld = Object.assign({}, world, {
      events: [],
      createdAt: Date.now()
    });
    const nextBatch = Object.assign({}, batchBase);
    nextBatch[worldKey] = nextWorld;
    return nextBatch;
  }
  function loadFailedBatch() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
        FAILED_BATCH_STORAGE_KEY
      );
      const failed = saved ? JSON.parse(saved) : {};
      return failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
    } catch (error) {
      console.error(
        "[Alliance Discord] Failed batch read error:",
        error
      );
      return {};
    }
  }
  function saveFailedBatch(failed, hostname) {
    if (typeof localStorage === "undefined") {
      return false;
    }
    try {
      const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
      const nextMap = Object.assign({}, failedBase);
      localStorage.setItem(
        FAILED_BATCH_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Failed batch save error:",
        error
      );
      return false;
    }
  }
  function enqueueFailedEvents(failed, hostname, events, atMs, statusOrError) {
    const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
    if (!Array.isArray(events) || events.length === 0) {
      return failedBase;
    }
    const worldKey = normalizeHostname(hostname);
    const existing = failedBase[worldKey];
    const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
    const nextEvents = current && Array.isArray(current.events) ? current.events.slice() : [];
    for (const event of events) {
      nextEvents.push(toPendingEvent(event));
    }
    const overflowCount = Math.max(0, nextEvents.length - FAILED_QUEUE_MAX_EVENTS);
    const capped = overflowCount > 0 ? nextEvents.slice(
      nextEvents.length - FAILED_QUEUE_MAX_EVENTS
    ) : nextEvents;
    const nextWorld = Object.assign({}, current, {
      events: capped,
      lastFailure: {
        atMs: typeof atMs === "number" ? atMs : Date.now(),
        statusOrError: String(statusOrError)
      },
      ...(overflowCount > 0 ? { overflowCount: (Number(current && current.overflowCount) || 0) + overflowCount, overflowReason: "failed-queue-cap", overflowMessage: "Failed queue bounded: oldest records were omitted after the failed-queue cap." } : {})
    });
    const nextFailed = Object.assign({}, failedBase);
    nextFailed[worldKey] = nextWorld;
    return nextFailed;
  }
  function getFailedEvents(failed, hostname) {
    const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
    const world = failedBase[normalizeHostname(hostname)];
    if (!world || typeof world !== "object" || Array.isArray(world)) {
      return null;
    }
    const events = Array.isArray(world.events) ? world.events.slice() : [];
    if (events.length === 0) {
      return null;
    }
    return {
      events,
      lastFailure: world.lastFailure && typeof world.lastFailure === "object" && !Array.isArray(world.lastFailure) ? Object.assign({}, world.lastFailure) : null
    };
  }
  function countFailedEvents(failed, hostname) {
    const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
    const world = failedBase[normalizeHostname(hostname)];
    if (!world || typeof world !== "object" || Array.isArray(world) || !Array.isArray(world.events)) {
      return 0;
    }
    return world.events.length;
  }
  function clearFailedEvents(failed, hostname) {
    const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
    const worldKey = normalizeHostname(hostname);
    if (!Object.prototype.hasOwnProperty.call(
      failedBase,
      worldKey
    )) {
      return failedBase;
    }
    const nextFailed = Object.assign({}, failedBase);
    delete nextFailed[worldKey];
    return nextFailed;
  }
  function requeueFailedEvents(hostname) {
    const worldKey = normalizeHostname(hostname);
    const failed = loadFailedBatch();
    const snapshot = getFailedEvents(failed, worldKey);
    if (snapshot === null) {
      return {
        requeued: 0,
        failedCount: 0,
        saved: false
      };
    }
    const failedCount = snapshot.events.length;
    const beforePending = snapshotBatch(
      loadPendingBatch(),
      worldKey
    );
    const beforeCount = beforePending !== null ? beforePending.events.length : 0;
    const savedPending = savePendingBatch(
      enqueueEvents(
        loadPendingBatch(),
        worldKey,
        snapshot.events
      ),
      worldKey
    );
    if (!savedPending) {
      return {
        requeued: 0,
        failedCount,
        saved: false
      };
    }
    const afterPending = snapshotBatch(
      loadPendingBatch(),
      worldKey
    );
    const afterCount = afterPending !== null ? afterPending.events.length : 0;
    const confirmed = afterCount >= Math.min(
      beforeCount + failedCount,
      QUEUE_MAX_EVENTS
    );
    if (!confirmed) {
      return {
        requeued: 0,
        failedCount,
        saved: false
      };
    }
    const cleared = saveFailedBatch(
      clearFailedEvents(failed, worldKey),
      worldKey
    );
    if (!cleared) {
      return {
        requeued: failedCount,
        failedCount,
        saved: false
      };
    }
    return {
      requeued: failedCount,
      failedCount,
      saved: true
    };
  }
  function parseLeaseRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const ownerId = typeof raw.ownerId === "string" ? raw.ownerId.trim() : "";
    if (ownerId === "") {
      return null;
    }
    if (typeof raw.expiresAtMs !== "number" || !Number.isFinite(raw.expiresAtMs)) {
      return null;
    }
    const record = {
      ownerId,
      expiresAtMs: raw.expiresAtMs
    };
    if (typeof raw.token === "string" && raw.token.trim() !== "") {
      record.token = raw.token.trim();
    }
    if (Number.isInteger(raw.generation) && raw.generation >= 0) {
      record.generation = raw.generation;
    }
    if (Number.isInteger(raw.term) && raw.term >= 0) {
      record.term = raw.term;
    }
    return record;
  }
  function parseLease(raw) {
    const record = parseLeaseRecord(raw);
    if (!record) {
      return null;
    }
    return {
      ownerId: record.ownerId,
      expiresAtMs: record.expiresAtMs
    };
  }
  function classifyLease(parsed, ownerId, nowMs) {
    const lease = parseLease(parsed);
    if (lease === null) {
      return "none";
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (lease.expiresAtMs <= now) {
      return "expired";
    }
    if (lease.ownerId === ownerId) {
      return "own";
    }
    return "foreign";
  }
  function isLeaseActive(parsed, ownerId, nowMs) {
    return classifyLease(parsed, ownerId, nowMs) === "own";
  }
  function isCurrentLeaseOwner() {
    if (!tabLeaseActive) {
      return false;
    }
    if (tabLeaseBestEffort) {
      return true;
    }
    if (!activeLeaseOwnerId || !tabLeaseToken) {
      return false;
    }
    const current = loadLeaseRecord(location.hostname);
    return isLifecycleFenceValid(
      isLeaseActive(current, activeLeaseOwnerId, Date.now()),
      tabLeaseToken,
      current && current.token
    ) && current.generation === tabLeaseGeneration && current.term === tabLeaseTerm;
  }
  function createTabOwnerId() {
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (error) {
    }
    const randomPart = () => Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0");
    return "tab-" + randomPart() + randomPart() + "-" + randomPart() + "-" + Date.now().toString(36);
  }
  function getOrCreateTabOwnerId() {
    const key = "taa-tab-owner-id";
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage) {
        const existing = sessionStorage.getItem(key);
        if (typeof existing === "string" && existing.length > 0) {
          return existing;
        }
        const fresh = createTabOwnerId();
        sessionStorage.setItem(key, fresh);
        return fresh;
      }
    } catch (error) {
    }
    return createTabOwnerId();
  }
  function createLeaseToken() {
    return createTabOwnerId() + ":" + Date.now().toString(36);
  }
  function loadLease(hostname) {
    if (typeof localStorage === "undefined") {
      return null;
    }
    try {
      const saved = localStorage.getItem(
        TAB_LEASE_STORAGE_KEY
      );
      if (!saved) {
        return null;
      }
      const map = JSON.parse(saved);
      const world = map && typeof map === "object" && !Array.isArray(map) ? map[normalizeHostname(hostname)] : null;
      return parseLease(world);
    } catch (error) {
      console.error(
        "[Alliance Discord] Tab lease read error:",
        error
      );
      return null;
    }
  }
  function loadLeaseRecord(hostname) {
    if (typeof localStorage === "undefined") {
      return null;
    }
    try {
      const saved = localStorage.getItem(TAB_LEASE_STORAGE_KEY);
      const map = saved ? JSON.parse(saved) : null;
      const world = map && typeof map === "object" && !Array.isArray(map) ? map[normalizeHostname(hostname)] : null;
      return parseLeaseRecord(world);
    } catch (error) {
      return null;
    }
  }
  function saveLease(hostname, lease) {
    if (typeof localStorage === "undefined") {
      return false;
    }
    try {
      const saved = localStorage.getItem(
        TAB_LEASE_STORAGE_KEY
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
      const worldKey = normalizeHostname(hostname);
      const nextMap = Object.assign({}, base);
      nextMap[worldKey] = lease;
      localStorage.setItem(
        TAB_LEASE_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Tab lease save error:",
        error
      );
      return false;
    }
  }
  function acquireLease(hostname, ownerId, nowMs) {
    const worldKey = normalizeHostname(hostname);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (typeof localStorage === "undefined" || !hasExclusiveWebLocks()) {
      return null;
    }
    try {
      const existing = loadLeaseRecord(worldKey);
      if (classifyLease(existing, ownerId, now) === "foreign") {
        return false;
      }
      const previousTerm = existing && Number.isInteger(existing.term) ? existing.term : 0;
      const lease = {
        ownerId,
        expiresAtMs: now + TAB_LEASE_TTL_MS,
        term: previousTerm + 1,
        generation: existing && Number.isInteger(existing.generation) ? existing.generation + 1 : 1,
        token: createLeaseToken()
      };
      if (!saveLease(worldKey, lease)) {
        return null;
      }
      const verified = loadLeaseRecord(worldKey);
      return Boolean(
        verified && verified.ownerId === ownerId && verified.token === lease.token && verified.term === lease.term && verified.generation === lease.generation && isLeaseActive(verified, ownerId, now)
      );
    } catch (error) {
      console.error(
        "[Alliance Discord] Tab lease acquire error:",
        error
      );
      return null;
    }
  }
  function renewLease(hostname, ownerId, nowMs, expectedToken) {
    const worldKey = normalizeHostname(hostname);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!hasExclusiveWebLocks()) return false;
    const existing = loadLeaseRecord(worldKey);
    if (!isLeaseActive(existing, ownerId, now)) {
      return false;
    }
    if (typeof expectedToken === "string" && expectedToken !== existing.token) {
      return false;
    }
    return saveLease(worldKey, {
      ownerId,
      expiresAtMs: now + TAB_LEASE_TTL_MS,
      token: existing.token,
      generation: existing.generation,
      term: existing.term
    });
  }
  function releaseLease(hostname, ownerId, nowMs, expectedTerm) {
    if (typeof localStorage === "undefined" || !hasExclusiveWebLocks()) {
      return false;
    }
    try {
      const worldKey = normalizeHostname(hostname);
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const existing = loadLease(worldKey);
      if (!isLeaseActive(existing, ownerId, now)) {
        return false;
      }
      if (Number.isInteger(expectedTerm) && existing.term !== expectedTerm) return false;
      const saved = localStorage.getItem(
        TAB_LEASE_STORAGE_KEY
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
      const nextMap = Object.assign({}, base);
      delete nextMap[worldKey];
      localStorage.setItem(
        TAB_LEASE_STORAGE_KEY,
        JSON.stringify(nextMap)
      );
      return true;
    } catch (error) {
      console.error(
        "[Alliance Discord] Tab lease release error:",
        error
      );
      return false;
    }
  }
  function isRetryableOutcome(status, errorClass) {
    if (status === null) {
      return errorClass === "network" || errorClass === "timeout" || errorClass === "abort";
    }
    return status === 408 || status === 429 || status >= 500 && status <= 599;
  }
  function parseRetryAfterMs(response) {
    if (!response || typeof response !== "object") {
      return null;
    }
    try {
      const body = JSON.parse(
        String(response.responseText || "")
      );
      const value = body && typeof body === "object" ? body.retry_after : void 0;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return Math.floor(value * 1e3);
      }
    } catch (error) {
    }
    const headerText = typeof response.responseHeaders === "string" ? response.responseHeaders : "";
    for (const line of headerText.split(/\r?\n/)) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }
      const name = line.slice(0, separatorIndex).trim().toLowerCase();
      if (name !== "retry-after") {
        continue;
      }
      const raw = line.slice(separatorIndex + 1).trim();
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.floor(seconds * 1e3);
      }
      const dateMs = Date.parse(raw);
      if (Number.isFinite(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
      }
    }
    return null;
  }
  function sanitizeRetryDelay(retryAfterMs, fallback) {
    const base = Number.isFinite(retryAfterMs) ? retryAfterMs : NaN;
    if (Number.isNaN(base) || base < 0) {
      return Number.isFinite(fallback) ? fallback : 1e3;
    }
    return Math.min(
      MAX_RETRY_DELAY_MS,
      Math.floor(base)
    );
  }
  const SOURCE_ID_FIELDS = Object.freeze([
    ["world", "string"],
    ["playerId", "string"],
    ["eventType", "string"],
    ["acceptedGeneration", "integer"],
    ["scanSequence", "integer"],
    ["attackDelta", "integer"],
    ["raidDelta", "integer"]
  ]);
  function sourceUtf8(value) {
    return typeof TextEncoder === "function" ? new TextEncoder().encode(value) : Uint8Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0));
  }
  function sourceBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  function sourceDecodeBase64Url(payload) {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  function sourceUtf8Text(bytes) {
    return typeof TextDecoder === "function" ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : decodeURIComponent(String.fromCharCode(...bytes));
  }
  function sourceTupleValue(tuple, field, kind) {
    const value = tuple && tuple[field];
    if (kind === "string") {
      if (typeof value !== "string") throw new Error(`invalid source tuple ${field}`);
      return value;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid source tuple ${field}`);
    }
    return String(value);
  }
  function encodeSourceTuple(tuple) {
    const chunks = [];
    for (const [field, kind] of SOURCE_ID_FIELDS) {
      const tag = sourceUtf8(field);
      const bytes = sourceUtf8(sourceTupleValue(tuple, field, kind));
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.length);
      const tagLength = new Uint8Array(2);
      new DataView(tagLength.buffer).setUint16(0, tag.length);
      chunks.push(tagLength, tag, length, bytes);
    }
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  function sourceEventIdFromTuple(tuple) {
    return `s1:${sourceBase64Url(encodeSourceTuple(tuple))}`;
  }
  function decodeSourceEventId(id) {
    if (typeof id !== "string" || !id.startsWith("s1:")) throw new Error("malformed source ID");
    const payload = id.slice(3);
    if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw new Error("malformed source ID");
    let bytes;
    try {
      bytes = sourceDecodeBase64Url(payload);
    } catch (error) {
      throw new Error("malformed source ID");
    }
    if (sourceBase64Url(bytes) !== payload) throw new Error("noncanonical source ID");
    let offset = 0;
    const tuple = {};
    for (const [expectedField, kind] of SOURCE_ID_FIELDS) {
      if (offset + 2 > bytes.length) throw new Error("malformed source ID");
      const tagLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0);
      offset += 2;
      if (offset + tagLength + 4 > bytes.length) throw new Error("malformed source ID");
      const field = sourceUtf8Text(bytes.subarray(offset, offset + tagLength));
      offset += tagLength;
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      offset += 4;
      if (field !== expectedField || offset + length > bytes.length) throw new Error("malformed source ID");
      const text = sourceUtf8Text(bytes.subarray(offset, offset + length));
      offset += length;
      tuple[field] = kind === "integer" ? Number(text) : text;
      if (kind === "integer" && (!Number.isSafeInteger(tuple[field]) || String(tuple[field]) !== text)) throw new Error("invalid source tuple");
    }
    if (offset !== bytes.length || sourceEventIdFromTuple(tuple) !== id) throw new Error("non-round-tripping source ID");
    return Object.freeze(tuple);
  }
  function sourceEventTuple(tuple) {
    const canonical = {};
    for (const [field, kind] of SOURCE_ID_FIELDS) canonical[field] = kind === "integer" ? Number(sourceTupleValue(tuple, field, kind)) : sourceTupleValue(tuple, field, kind);
    const fingerprint = sourceEventIdFromTuple(canonical);
    return { tuple: canonical, fingerprint, sourceEventId: fingerprint };
  }
  function createMonitorQueueEvent(event, options = {}) {
    const input = event && typeof event === "object" ? event : {};
    const world = normalizeHostname(options.world || input.world || "");
    const rawPlayerId = options.playerId !== void 0 ? options.playerId : monitorEventPlayerId(input);
    const playerId = rawPlayerId === null || rawPlayerId === void 0 ? null : String(rawPlayerId);
    const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : Number.isFinite(input.observedAtMs) ? input.observedAtMs : null;
    const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : Number.isFinite(input.queuedAtMs) ? input.queuedAtMs : Date.now();
    const base = Object.assign({}, input, {
      world,
      playerId,
      observedAtMs,
      queuedAtMs
    });
    const eventId = typeof input.eventId === "string" && input.eventId ? input.eventId : checksumMonitorCanonicalValue({
      world,
      playerId,
      eventType: monitorEventType(input),
      observedAtMs,
      addedAttackCount: Number(input.addedAttackCount) || 0,
      addedRaidCount: Number(input.addedRaidCount) || 0
    });
    base.eventId = eventId;
    if (Array.isArray(input.sourceEventIds)) {
      base.sourceEventIds = [...new Set(input.sourceEventIds.map(String))];
      base.sourceEventTuples = base.sourceEventIds.map((id) => sourceEventTuple(decodeSourceEventId(id)));
    }
    if (input.approximateObserved === true || input.observedAtApproximate === true) {
      base.approximateObserved = true;
      base.observedAtApproximate = true;
    } else {
      delete base.approximateObserved;
      delete base.observedAtApproximate;
    }
    return base;
  }
  function computeQueueAge(event) {
    const input = event && typeof event === "object" ? event : {};
    const observedAtMs = Number(input.observedAtMs);
    const dispatchedAtMs = Number(input.dispatchedAtMs);
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(dispatchedAtMs)) {
      return { ageMs: null, approximate: input.approximateObserved === true };
    }
    return {
      ageMs: Math.max(0, dispatchedAtMs - observedAtMs),
      approximate: input.approximateObserved === true
    };
  }
  function buildDiscordRequestUrl(canonicalWebhookUrl) {
    const validated = validateWebhookUrl(canonicalWebhookUrl);
    if (validated === null) {
      return null;
    }
    const requestUrl = new URL(validated);
    requestUrl.searchParams.set("wait", "true");
    return requestUrl.href;
  }
  function classifyDiscordResponse(response) {
    const input = response && typeof response === "object" ? response : {};
    const status = Number.isInteger(input.status) ? input.status : null;
    if (status === 200) {
      try {
        const body = JSON.parse(String(input.responseText || ""));
        if (body && typeof body === "object" && !Array.isArray(body) && typeof body.id === "string" && body.id.length > 0) {
          return { kind: "acknowledged", messageId: body.id };
        }
        return { kind: "uncertain", responseClass: "malformed-json-200" };
      } catch (error) {
        return { kind: "uncertain", responseClass: "non-json-200" };
      }
    }
    if (status === null && (input.errorClass === "network" || input.errorClass === "timeout" || input.errorClass === "abort")) {
      return { kind: "retryable", errorClass: input.errorClass };
    }
    if (status === 408 || status === 429 || status !== null && status >= 500 && status <= 599) {
      return {
        kind: "retryable",
        status,
        retryAfterMs: parseRetryAfterMs(input)
      };
    }
    return {
      kind: "permanent",
      status,
      responseClass: status === null ? String(input.errorClass || "unknown") : void 0
    };
  }
  function sendDiscordPayload(options = {}) {
    const requestUrl = buildDiscordRequestUrl(options.webhookUrl);
    if (requestUrl === null || typeof options.gmRequest !== "function") {
      return Promise.resolve({ kind: "permanent", responseClass: "configuration" });
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (response) => {
        if (settled) {
          return;
        }
        settled = true;
        const nowMs = typeof options.nowMs === "function" ? options.nowMs() : options.nowMs;
        resolve(classifyDiscordResponse(response, { nowMs }));
      };
      try {
        options.gmRequest({
          method: "POST",
          url: requestUrl,
          timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify(options.payload || {}),
          onload: settle,
          onerror: (error) => settle({ status: null, errorClass: "network", error }),
          ontimeout: () => settle({ status: null, errorClass: "timeout" }),
          onabort: () => settle({ status: null, errorClass: "abort" })
        });
      } catch (error) {
        settle({ status: null, errorClass: "network", error });
      }
    });
  }
  async function sendDiscordPayloadWithRetry(options = {}) {
    const maxAttempts = Math.min(
      MAX_ATTEMPT_COUNT,
      Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : MAX_ATTEMPT_COUNT
    );
    const sleep = typeof options.sleep === "function" ? options.sleep : async () => {
    };
    let attempts = 0;
    const delays = [];
    let outcome;
    do {
      if (typeof options.fence === "function" && options.fence("before-attempt") !== true) return { outcome: { kind: "fenced" }, attempts, delays };
      attempts += 1;
      outcome = await sendDiscordPayload(options);
      if (typeof options.fence === "function" && options.fence("after-response") !== true) return { outcome: { kind: "fenced" }, attempts, delays };
      if (outcome.kind !== "retryable" || attempts >= maxAttempts) {
        break;
      }
      const delay = sanitizeRetryDelay(
        outcome.retryAfterMs,
        RETRY_DELAY_MS[attempts - 1] || 1e3
      );
      delays.push(delay);
      await sleep(delay);
      if (typeof options.fence === "function" && options.fence("before-retry") !== true) return { outcome: { kind: "fenced" }, attempts, delays };
    } while (attempts < maxAttempts);
    return { outcome, attempts, delays };
  }
  function loadDiagnostics() {
    if (typeof localStorage === "undefined") {
      return {};
    }
    try {
      const saved = localStorage.getItem(
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
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const saved = localStorage.getItem(
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
      localStorage.setItem(
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
   function safeDiagnosticCounter(value) {
     return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1e4) : 0;
   }
   function recordFailure(diag, hostname, atMs, statusOrError, eventCount, rejectionReason, counters) {
    const diagBase = diag && typeof diag === "object" && !Array.isArray(diag) ? diag : {};
    const worldKey = normalizeHostname(hostname);
    const existing = diagBase[worldKey];
    const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
     const lastFailure = {
         atMs: typeof atMs === "number" ? atMs : Date.now(),
         statusOrError: String(statusOrError),
         eventCount: typeof eventCount === "number" ? eventCount : 0
     };
     if (MEMBER_TABLE_REASON_CODES.includes(rejectionReason)) lastFailure.rejectionReason = rejectionReason;
     if (counters !== undefined) {
       const source = counters && typeof counters === "object" && !Array.isArray(counters) ? counters : {};
       lastFailure.memberRows = safeDiagnosticCounter(source.memberRows);
       lastFailure.rows = safeDiagnosticCounter(source.rows);
       lastFailure.icons = safeDiagnosticCounter(source.icons);
     }
     const nextWorld = Object.assign({}, current, { lastFailure });
    const nextDiag = Object.assign({}, diagBase);
    nextDiag[worldKey] = nextWorld;
    return nextDiag;
  }
  function addInFlightChunk(batch, hostname, chunk) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const existing = batchBase[worldKey];
    const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
    const inFlight = current && Array.isArray(current.inFlight) ? current.inFlight.slice() : [];
    if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
      inFlight.push({
        events: Array.isArray(chunk.events) ? chunk.events.slice() : [],
        attemptCount: typeof chunk.attemptCount === "number" ? chunk.attemptCount : 0
      });
    }
    const nextWorld = Object.assign({}, current, {
      inFlight
    });
    const nextBatch = Object.assign({}, batchBase);
    nextBatch[worldKey] = nextWorld;
    return nextBatch;
  }
  function getInFlightChunks(batch, hostname) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const world = batchBase[worldKey];
    return world && Array.isArray(world.inFlight) ? world.inFlight.slice() : [];
  }
  function dropInFlightHead(batch, hostname) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const world = batchBase[worldKey];
    if (!world || typeof world !== "object" || Array.isArray(world)) {
      return batchBase;
    }
    const inFlight = Array.isArray(world.inFlight) ? world.inFlight.slice() : [];
    inFlight.shift();
    const nextWorld = Object.assign({}, world, {
      inFlight
    });
    const nextBatch = Object.assign({}, batchBase);
    nextBatch[worldKey] = nextWorld;
    return nextBatch;
  }
  function replaceInFlightHeadAttempt(batch, hostname, attemptCount) {
    const batchBase = batch && typeof batch === "object" && !Array.isArray(batch) ? batch : {};
    const worldKey = normalizeHostname(hostname);
    const world = batchBase[worldKey];
    if (!world || typeof world !== "object" || Array.isArray(world)) {
      return batchBase;
    }
    const inFlight = Array.isArray(world.inFlight) ? world.inFlight.slice() : [];
    if (inFlight.length === 0) {
      return batchBase;
    }
    inFlight[0] = Object.assign({}, inFlight[0], {
      attemptCount: typeof attemptCount === "number" ? attemptCount : inFlight[0].attemptCount
    });
    const nextWorld = Object.assign({}, world, {
      inFlight
    });
    const nextBatch = Object.assign({}, batchBase);
    nextBatch[worldKey] = nextWorld;
    return nextBatch;
  }
  function aggregateHistory(events, nowMs) {
    const list = Array.isArray(events) ? events : [];
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const windowStart = now - 24 * 60 * 60 * 1e3;
    const summary = {
      total: 0,
      attacks: 0,
      raids: 0,
      mixed: 0,
      attackDelta: 0,
      raidDelta: 0,
      players: {},
      playerCount: 0,
      muted: 0,
      thresholdBlocked: 0,
      last24h: {
        total: 0,
        attacks: 0,
        raids: 0,
        mixed: 0,
        attackDelta: 0,
        raidDelta: 0,
        muted: 0,
        thresholdBlocked: 0,
        playerCount: 0
      }
    };
    const seenPlayers = /* @__PURE__ */ new Set();
    const seenPlayers24h = /* @__PURE__ */ new Set();
    for (const event of list) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const detectedAtMs = Number.isFinite(event.detectedAtMs) ? event.detectedAtMs : 0;
      const in24h = detectedAtMs >= windowStart && detectedAtMs <= now;
      const eventType = event.eventType;
      const attackDelta = Number.isFinite(event.addedAttackCount) ? event.addedAttackCount : 0;
      const raidDelta = Number.isFinite(event.addedRaidCount) ? event.addedRaidCount : 0;
      const muted = event.muted === true;
      const blocked = event.thresholdBlocked === true;
      const name = typeof event.name === "string" ? event.name : "(unknown)";
      summary.total += 1;
      summary.attackDelta += attackDelta;
      summary.raidDelta += raidDelta;
      if (eventType === "attack") {
        summary.attacks += 1;
      } else if (eventType === "raid") {
        summary.raids += 1;
      } else if (eventType === "mixed") {
        summary.mixed += 1;
      }
      summary.players[name] = (summary.players[name] || 0) + 1;
      seenPlayers.add(name);
      if (muted) {
        summary.muted += 1;
      }
      if (blocked) {
        summary.thresholdBlocked += 1;
      }
      if (in24h) {
        summary.last24h.total += 1;
        summary.last24h.attackDelta += attackDelta;
        summary.last24h.raidDelta += raidDelta;
        if (eventType === "attack") {
          summary.last24h.attacks += 1;
        } else if (eventType === "raid") {
          summary.last24h.raids += 1;
        } else if (eventType === "mixed") {
          summary.last24h.mixed += 1;
        }
        if (muted) {
          summary.last24h.muted += 1;
        }
        if (blocked) {
          summary.last24h.thresholdBlocked += 1;
        }
        seenPlayers24h.add(name);
      }
    }
    summary.playerCount = seenPlayers.size;
    summary.last24h.playerCount = seenPlayers24h.size;
    return summary;
  }
  function panelDate(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }
  function buildHistoryPanelRows(events, limit = 50) {
    const list = Array.isArray(events) ? events : [];
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    return list.slice(0, max).map((event) => {
     const source = event && typeof event === "object" ? event : {};
      return {
        name: typeof source.name === "string" ? source.name : "(unknown)",
        eventType: typeof source.eventType === "string" ? source.eventType : "—",
        priority: typeof source.priority === "string" ? source.priority : "—",
        addedAttack: Number.isFinite(
          source.addedAttackCount
        ) ? source.addedAttackCount : 0,
        addedRaid: Number.isFinite(
          source.addedRaidCount
        ) ? source.addedRaidCount : 0,
        detectedAt: panelDate(source.detectedAtMs)
      };
    });
  }
  function buildStatsPanelModel(summary) {
    const source = summary && typeof summary === "object" ? summary : {};
    const last24h = source.last24h && typeof source.last24h === "object" ? source.last24h : {};
    return {
      total: Number.isFinite(source.total) ? source.total : 0,
      attacks: Number.isFinite(source.attacks) ? source.attacks : 0,
      raids: Number.isFinite(source.raids) ? source.raids : 0,
      mixed: Number.isFinite(source.mixed) ? source.mixed : 0,
      attackDelta: Number.isFinite(source.attackDelta) ? source.attackDelta : 0,
      raidDelta: Number.isFinite(source.raidDelta) ? source.raidDelta : 0,
      playerCount: Number.isFinite(source.playerCount) ? source.playerCount : 0,
      muted: Number.isFinite(source.muted) ? source.muted : 0,
      thresholdBlocked: Number.isFinite(source.thresholdBlocked) ? source.thresholdBlocked : 0,
      last24h: {
        total: Number.isFinite(last24h.total) ? last24h.total : 0,
        attacks: Number.isFinite(last24h.attacks) ? last24h.attacks : 0,
        raids: Number.isFinite(last24h.raids) ? last24h.raids : 0,
        mixed: Number.isFinite(last24h.mixed) ? last24h.mixed : 0,
        attackDelta: Number.isFinite(last24h.attackDelta) ? last24h.attackDelta : 0,
        raidDelta: Number.isFinite(last24h.raidDelta) ? last24h.raidDelta : 0,
        playerCount: Number.isFinite(last24h.playerCount) ? last24h.playerCount : 0,
        muted: Number.isFinite(last24h.muted) ? last24h.muted : 0,
        thresholdBlocked: Number.isFinite(
          last24h.thresholdBlocked
        ) ? last24h.thresholdBlocked : 0
      }
    };
  }
  function buildDiagnosticsPanelModel(lastFailure) {
    if (!lastFailure || typeof lastFailure !== "object") {
      return null;
    }
       const model = {
        releaseId: RELEASE_ID,
       at: panelDate(lastFailure.atMs),
       statusOrError: lastFailure.statusOrError === void 0 ? "—" : String(lastFailure.statusOrError),
       eventCount: Number.isFinite(lastFailure.eventCount) ? lastFailure.eventCount : 0
     };
     if (MEMBER_TABLE_REASON_CODES.includes(lastFailure.rejectionReason)) model.rejectionReason = lastFailure.rejectionReason;
     if (lastFailure.memberRows !== undefined || lastFailure.rows !== undefined || lastFailure.icons !== undefined) {
       model.memberRows = safeDiagnosticCounter(lastFailure.memberRows);
       model.rows = safeDiagnosticCounter(lastFailure.rows);
       model.icons = safeDiagnosticCounter(lastFailure.icons);
     }
     return model;
  }
  function boundedDiagnosticRecords(records, filters = {}) {
    const list = Array.isArray(records) ? records : [];
    const rawScanId = filters && filters.scanId ? String(filters.scanId) : null;
    const scanId = rawScanId ? diagnosticDigest(rawScanId) : null;
    const stage = filters && typeof filters.stage === "string" ? filters.stage : null;
    const outcome = filters && typeof filters.outcome === "string" ? filters.outcome : null;
    return list.slice(-32).reverse().filter((record) => {
      if (!record || typeof record !== "object") return false;
      return (!scanId || record.scanId === rawScanId || record.scanId === scanId || record.diagnosticId === scanId) && (!stage || record.stage === stage) && (!outcome || record.status === outcome);
    }).slice(0, 32).map((record) => ({
      sequence: Number.isInteger(record.sequence) ? record.sequence : 0,
      scanId: typeof record.scanId === "string" ? record.scanId.slice(0, 64) : null,
      diagnosticId: typeof record.diagnosticId === "string" ? record.diagnosticId.slice(0, 64) : null,
      stage: diagnosticStage(record.stage),
      status: diagnosticStatus(record.status),
      reason: record.reason === void 0 ? null : sanitizeDiagnosticText(record.reason).slice(0, 64)
    }));
  }
  function representedEventCount(events) {
    return (Array.isArray(events) ? events : []).reduce((total, event) => {
      const ids = event && Array.isArray(event.sourceEventIds) ? event.sourceEventIds.length : 1;
      return total + ids;
    }, 0);
  }
  function buildCountReconciliationPanelModel(input = {}) {
    const envelope = input.envelope && typeof input.envelope === "object" ? input.envelope : {};
    const diagnostics = input.diagnostics && typeof input.diagnostics === "object" ? input.diagnostics : {};
    const records = Array.isArray(input.traces) ? input.traces : Array.isArray(diagnostics.records) ? diagnostics.records : [];
    const latest = selectLatestScanTerminalRecord(records) || {};
    const latestReload = records.slice().reverse().find((record) => record && record.stage === "reload" && record.status === "rejected" && (record.reason === "reload-blocked" || RELOAD_REFUSAL_REASONS.includes(record.reason))) || null;
    const metrics = envelope.metrics && typeof envelope.metrics === "object" ? envelope.metrics : {};
    const accounting = metrics.deliveryAccounting && typeof metrics.deliveryAccounting === "object" ? metrics.deliveryAccounting : {};
    const active = metrics.activeTotals && typeof metrics.activeTotals === "object" ? metrics.activeTotals : {};
    const deltas = metrics.newNetDeltas && typeof metrics.newNetDeltas === "object" ? metrics.newNetDeltas : {};
    const dispositions = metrics.dispositions && typeof metrics.dispositions === "object" ? metrics.dispositions : {};
    const conservation = metrics.conservation && typeof metrics.conservation === "object" ? metrics.conservation : {};
    const plans = Array.isArray(accounting.dispatchPlans) ? accounting.dispatchPlans : [];
    const acknowledgedFromPlans = plans.flatMap((plan) => Array.isArray(plan.chunks) ? plan.chunks : []).filter((chunk) => chunk && chunk.state === "acknowledged").reduce((total, chunk) => total + (Number(chunk.sourceCount) || 0), 0);
    const terminal = Array.isArray(accounting.terminal) ? accounting.terminal : [];
    const routeRole = Object.values(ROUTE_ROLES).includes(input.routeRole) ? input.routeRole : "unknown";
    const rawScanId = typeof latest.scanId === "string" ? latest.scanId : typeof latest.diagnosticId === "string" ? latest.diagnosticId : null;
    const scanId = rawScanId !== null && rawScanId.length <= 64 && !/https?:|discord|webhook|token|secret|cookie/i.test(rawScanId) ? (/^(?:sc1:[0-9a-f]{8}|[0-9a-f]{8})$/.test(rawScanId) ? rawScanId.slice(0, 64) : diagnosticDigest(rawScanId)) : null;
    const mismatchCandidate = typeof conservation.firstMismatch === "string" ? conservation.firstMismatch : typeof input.firstConservationMismatch === "string" ? input.firstConservationMismatch : null;
    const firstConservationMismatch = mismatchCandidate !== null && !/https?:|discord|webhook|token|secret|cookie/i.test(mismatchCandidate) ? diagnosticString(mismatchCandidate, 128).slice(0, 128) : null;
    return {
      routeRole,
      leaseGeneration: Number.isInteger(input.leaseGeneration) ? input.leaseGeneration : Number.isInteger(metrics.leaseGeneration) ? metrics.leaseGeneration : null,
      monitorGeneration: Number.isInteger(envelope.generation) ? envelope.generation : null,
      scanId,
      scanReason: latest.reason ? diagnosticString(latest.reason, 64) : String(diagnostics.scanReason || "not recorded"),
      scanOutcome: latest.status ? diagnosticString(latest.status, 16) : String(diagnostics.scanOutcome || "unknown"),
      scanLabel: latest.stage ? describeScanTerminal(latest) : "not recorded",
      reloadLabel: latestReload ? describeScanTerminal(latestReload) : null,
      activeTotals: { players: Number(active.players) || 0, attacks: Number(active.attacks) || 0, raids: Number(active.raids) || 0 },
      newNetDeltas: { players: Number(deltas.players) || 0, attacks: Number(deltas.attacks) || 0, raids: Number(deltas.raids) || 0, sampled: true },
      dispositions: { muted: Number(dispositions.muted) || 0, blocked: Number(dispositions.blocked || dispositions.thresholdBlocked) || 0, eligible: Number(dispositions.eligible) || 0 },
      deliveryTotals: {
        pending: representedEventCount(envelope.pending),
        inFlight: representedEventCount(envelope.inFlight),
        failed: representedEventCount(envelope.failed),
        uncertain: representedEventCount(envelope.uncertain),
        acknowledged: representedEventCount(terminal) + acknowledgedFromPlans
      },
      firstConservationMismatch
    };
  }
  function buildIncidentBundle(input = {}) {
    const model = buildCountReconciliationPanelModel(input);
    const diagnostics = input.diagnostics && typeof input.diagnostics === "object" ? input.diagnostics : {};
    const traces = boundedDiagnosticRecords(input.traces || diagnostics.records, input.filters);
    const envelope = input.envelope && typeof input.envelope === "object" ? input.envelope : {};
    const accounting = envelope.metrics && envelope.metrics.deliveryAccounting || {};
    const safe = {
      schemaVersion: 1,
      kind: "taa-incident-bundle",
       build: { version: RELEASE_VERSION, releaseId: RELEASE_ID, identity: "userscript" },
      config: { endpointConfigured: input.webhookConfigured === true },
      routeRole: model.routeRole,
      generations: { lease: model.leaseGeneration, monitor: model.monitorGeneration },
      scan: { id: model.scanId, reason: model.scanReason, outcome: model.scanOutcome },
      recentTraces: traces.map((record) => ({ sequence: record.sequence, scanId: record.scanId || record.diagnosticId || null, stage: record.stage, outcome: record.status, reason: record.reason || null })),
      deliveryLedger: { pending: model.deliveryTotals.pending, inFlight: model.deliveryTotals.inFlight, failed: model.deliveryTotals.failed, uncertain: model.deliveryTotals.uncertain, acknowledged: model.deliveryTotals.acknowledged, compacted: Array.isArray(accounting.compactedTerminalTotals) ? accounting.compactedTerminalTotals.reduce((sum, range) => sum + (Number(range.count) || 0), 0) : 0 },
      queueCounts: model.deliveryTotals,
      conservation: { firstMismatch: model.firstConservationMismatch, netSampled: true },
      labels: { players: "players", messages: "messages", attacks: "attacks", raids: "raids", net: "net, sampled" }
    };
    const serialized = canonicalSerializeDiagnostics(safe);
    let sourceBytes = 0;
    try { sourceBytes = JSON.stringify(input).length; } catch (error) { sourceBytes = DIAGNOSTICS_LIMITS.exportBytes + 1; }
    return sourceBytes <= DIAGNOSTICS_LIMITS.exportBytes && diagnosticByteLength(serialized) <= DIAGNOSTICS_LIMITS.exportBytes ? safe : { schemaVersion: 1, kind: "taa-incident-bundle", bounded: true, boundedMessage: "Incident export bounded: content exceeded 512 KiB; sensitive data omitted.", recentTraces: [], conservation: { firstMismatch: null, netSampled: true } };
  }
  function buildStatusPanelModel(lastScan, nextReload, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const next = Number.isFinite(nextReload) ? nextReload : null;
    return {
      lastScan: Number.isFinite(lastScan) ? panelDate(lastScan) : "never",
      nextReload: next === null ? "never" : panelDate(next),
      nextReloadInMs: next === null ? null : Math.max(0, next - now)
    };
  }
  function applyEventThresholds(events, settings) {
    if (!Array.isArray(events)) {
      return [];
    }
    const validated = validateSettings(settings);
    return events.filter((event) => {
      if (!event || typeof event !== "object") {
        return false;
      }
      if (event.eventType === "join" || event.eventType === "leave") {
        return true;
      }
      const addedAttackCount = Number.isFinite(event.addedAttackCount) ? event.addedAttackCount : 0;
      const addedRaidCount = Number.isFinite(event.addedRaidCount) ? event.addedRaidCount : 0;
      if (event.eventType === "attack") {
        return addedAttackCount >= validated.attackThreshold;
      }
      if (event.eventType === "raid") {
        return addedRaidCount >= validated.raidThreshold;
      }
      return addedAttackCount >= validated.attackThreshold || addedRaidCount >= validated.raidThreshold;
    });
  }
  function classifyPriority(event, settings) {
    const validated = validateSettings(settings);
    const addedAttackCount = event && Number.isFinite(event.addedAttackCount) ? event.addedAttackCount : 0;
    const addedRaidCount = event && Number.isFinite(event.addedRaidCount) ? event.addedRaidCount : 0;
    const peak = Math.max(
      addedAttackCount,
      addedRaidCount
    );
    if (peak <= validated.normalMax) {
      return "normal";
    }
    if (peak <= validated.highMax) {
      return "high";
    }
    return "critical";
  }
  function isVisible(element) {
    return Boolean(
      element && element.isConnected && element.getClientRects().length > 0
    );
  }
  function getAttackDescription(icon) {
    const values = [
      icon.getAttribute("alt"),
      icon.getAttribute("title"),
      icon.getAttribute("aria-label"),
      icon.getAttribute("data-tooltip"),
      icon.getAttribute("data-title"),
      icon.getAttribute("data-original-title"),
      icon.parentElement?.getAttribute("alt"),
      icon.parentElement?.getAttribute("title"),
      icon.parentElement?.getAttribute("aria-label"),
      icon.parentElement?.getAttribute("data-tooltip")
    ];
    return cleanText(
      values.filter(Boolean).join(" ")
    );
  }
  function parseAttackCount(description) {
    const text = cleanText(description);
    const match = text.match(
      /(\d+)\s*(?:atak(?:\(ów\)|ów|i)?|attack(?:\(s\)|s)?|angriff(?:e)?)/iu
    );
    if (!match) {
      return null;
    }
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > 0) {
      return count;
    }
    return null;
  }
  function parseRaidCount(description) {
    const text = cleanText(description);
    const match = text.match(
      /(\d+)\s*(?:grabież(?:y|e)?|raid(?:s)?|raubz(?:ü|ue)ge|raubzug(?:e)?)/iu
    );
    if (!match) {
      return null;
    }
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > 0) {
      return count;
    }
    return null;
  }
  function classifyEvent(description) {
    return {
      attackCount: parseAttackCount(description),
      raidCount: parseRaidCount(description)
    };
  }
  function isAttackIcon({
    description,
    className,
    hasAttackClass
  }) {
    const attackClass = hasAttackClass !== void 0 ? Boolean(hasAttackClass) : Boolean(
      className && /(?:^|\s)attack(?:\s|$)/i.test(
        String(className)
      )
    );
    if (!attackClass) {
      return false;
    }
    const event = classifyEvent(description);
    return event.attackCount !== null || event.raidCount !== null;
  }
  function findAttackIcons() {
    let skipped = 0;
    const icons = [
      ...document.querySelectorAll("img")
    ].filter((icon) => {
      if (!isVisible(icon)) {
        return false;
      }
      const description = getAttackDescription(icon);
      const className = cleanText(icon.className);
      const hasAttackClass = icon.classList.contains("attack") || /(?:^|\s)attack(?:\s|$)/i.test(
        className
      );
      const isAttack = isAttackIcon({
        description,
        className,
        hasAttackClass
      });
      if (!isAttack) {
        skipped += 1;
      }
      return isAttack;
    });
    if (skipped > 0) {
      console.debug(
        "[Alliance Discord] Skipped " + skipped + " non-attack icons."
      );
    }
    return icons;
  }
  function createPlayerData(link) {
    const name = cleanText(link.textContent);
    if (!name) {
      return null;
    }
    let url;
    try {
      url = new URL(
        link.getAttribute("href") || "",
        location.origin
      ).href;
    } catch {
      url = location.href;
    }
    return {
      name,
      url,
      key: `player:${name.toLocaleLowerCase("pl-PL")}`
    };
  }
  function extractPlayerId(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }
    if (url.includes("/alliance/")) {
      return null;
    }
    const patterns = [
      /\/profile\/(\d+)/i,
      /\/player\/(\d+)/i,
      /spieler\.php\?[^#]*uid=(\d+)/i,
      /uid=(\d+)/i
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  }
  function buildMappingKey(hostname, playerId) {
    if (typeof playerId !== "string" || playerId.length === 0) {
      return "";
    }
    return `${String(hostname).toLowerCase()}:${String(playerId)}`;
  }
  function parseDiscordSnowflake(input) {
    if (typeof input !== "string") {
      return null;
    }
    const trimmed = input.trim();
    if (!/^\d{17,20}$/.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  function validateDiscordUserId(input) {
    return parseDiscordSnowflake(input);
  }
  function validateDiscordRoleId(input) {
    return parseDiscordSnowflake(input);
  }
  function normalizeProfileInput(input) {
    if (typeof input !== "string") {
      return null;
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    return extractPlayerId(input);
  }
  function buildPlayerWorkspaceModel(input) {
    const source = input && typeof input === "object" ? input : {};
    const roster = Array.isArray(source.roster) ? source.roster : [];
    const mappings = source.mappings && typeof source.mappings === "object" && !Array.isArray(source.mappings) ? source.mappings : {};
    const cachedNames = source.cachedNames && typeof source.cachedNames === "object" ? source.cachedNames : {};
    const liveNames = source.liveNames && typeof source.liveNames === "object" ? source.liveNames : {};
    const ids = /* @__PURE__ */ new Set();
    const live = {};
    const memberId = (member) => {
      const entry = member && typeof member === "object" ? member : { id: member };
      return entry.id === void 0 ? entry.playerId : entry.id;
    };
    for (const member of roster) {
      const rawId = memberId(member);
      if (rawId === void 0 || rawId === null || String(rawId).trim() === "") continue;
      const id = String(rawId).trim();
      ids.add(id);
      if (member && typeof member === "object" && typeof member.name === "string" && member.name.trim()) live[id] = member.name;
    }
    Object.assign(live, liveNames);
    Object.keys(mappings).forEach((id) => ids.add(String(id)));
    const mutedSet = /* @__PURE__ */ new Set();
    if (Array.isArray(source.muted)) source.muted.forEach((id) => {
      if (id !== null && id !== void 0 && String(id).trim()) mutedSet.add(String(id).trim());
    });
    else if (source.muted && typeof source.muted === "object") Object.entries(source.muted).forEach(([id, enabled]) => {
      if (enabled) mutedSet.add(String(id).trim());
    });
    mutedSet.forEach((id) => ids.add(id));
    Object.keys(cachedNames).forEach((id) => ids.add(String(id)));
    Object.keys(liveNames).forEach((id) => ids.add(String(id)));
    const recipients = (value) => {
      const seen = /* @__PURE__ */ new Set();
      return (Array.isArray(value) ? value : []).filter((item) => {
        if (typeof item !== "string") return false;
        const id = item.trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).map((item) => item.trim());
    };
    const rows = [...ids].map((id) => {
      const present = roster.some((member) => {
        const rawId = memberId(member);
        return rawId !== void 0 && rawId !== null && String(rawId).trim() === id;
      });
      const mapped = Object.prototype.hasOwnProperty.call(mappings, id);
      const muted = mutedSet.has(id);
      return { id, name: typeof live[id] === "string" && live[id].trim() ? live[id] : typeof cachedNames[id] === "string" && cachedNames[id].trim() ? cachedNames[id] : id, present, mapped, muted, orphaned: !present, recipients: recipients(mappings[id]) };
    });
    const group = (row) => row.orphaned ? 2 : row.present && !row.mapped && !row.muted ? 0 : 1;
    rows.sort((a, b) => group(a) - group(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { rows, summary: { monitored: rows.filter((row) => row.present).length, mapped: rows.filter((row) => row.mapped).length, unmapped: rows.filter((row) => row.present && !row.mapped && !row.muted).length, muted: rows.filter((row) => row.muted).length, orphaned: rows.filter((row) => row.orphaned).length } };
  }
  function buildPlayerWorkspaceReadModel(input) {
    const source = input && typeof input === "object" ? input : {};
    const snapshot = source.snapshot && typeof source.snapshot === "object" ? source.snapshot : {};
    const cachedRoster = source.cachedRoster && typeof source.cachedRoster === "object" && !Array.isArray(source.cachedRoster) ? source.cachedRoster : {};
    const rosterFromMembers = (members) => Object.entries(members && typeof members === "object" && !Array.isArray(members) ? members : {}).map(([id, member]) => ({
      id,
      name: member && typeof member.name === "string" ? member.name : "",
      url: member && typeof member.url === "string" ? member.url : ""
    }));
    const cachedMembers = rosterFromMembers(cachedRoster);
    const authoritative = snapshot.status === "authoritative";
    const roster = authoritative ? rosterFromMembers(snapshot.membersById) : cachedMembers;
    const reason = typeof snapshot.reason === "string" && snapshot.reason ? snapshot.reason : "unknown";
    const cachedCount = cachedMembers.length;
    const rosterStatus = authoritative ? "authoritative" : cachedCount ? "cached" : "empty";
    const rosterStatusText = authoritative ? "" : cachedCount
      ? "Live roster unavailable — showing last accepted roster (" + cachedCount + " players). Reason: " + reason
      : "Live roster unavailable — no accepted roster is stored. Reason: " + reason;
    return Object.assign(buildPlayerWorkspaceModel(Object.assign({}, source, { roster })), {
      rosterSource: authoritative ? "live" : cachedCount ? "cache" : "none",
      rosterStatus,
      rosterStatusText,
      cachedCount,
      failureReason: authoritative ? null : reason
    });
  }
  function paginatePlayerWorkspaceRows(rows, options) {
    const source = Array.isArray(rows) ? rows : [];
    const settings = options && typeof options === "object" ? options : {};
    const query = typeof settings.query === "string" ? settings.query.trim().toLocaleLowerCase() : "";
    const flags = ["mapped", "unmapped", "muted", "orphaned"];
    const group = (row) => row.orphaned ? 2 : row.present && !row.mapped && !row.muted ? 0 : 1;
    const filtered = source.filter((row) => (!query || String(row.name).toLocaleLowerCase().includes(query) || String(row.id).toLocaleLowerCase().includes(query)) && flags.every((flag) => !settings[flag] || (flag === "unmapped" ? Boolean(row.present && !row.mapped && !row.muted) : Boolean(row[flag]))));
    const sorted = filtered.map((row, index) => ({ row, index })).sort((a, b) => group(a.row) - group(b.row) || String(a.row.name).localeCompare(String(b.row.name)) || String(a.row.id).localeCompare(String(b.row.id)) || a.index - b.index).map((item) => item.row);
    const pageCount = Math.max(1, Math.ceil(sorted.length / 20));
    const requested = Number(settings.page);
    const page = Math.min(pageCount, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 1));
    const offset = (page - 1) * 20;
    const pageRows = sorted.slice(offset, offset + 20);
    return { page, pageCount, total: sorted.length, start: pageRows.length ? offset + 1 : 0, end: pageRows.length ? offset + pageRows.length : 0, rows: pageRows };
  }
  function formatPlayerPaginationStatus(paged) {
    const total = paged && Number.isFinite(paged.total) ? Math.max(0, Math.trunc(paged.total)) : 0;
    if (!total) {
      return "Showing 0 of 0 players · Page 1 of 1";
    }
    const page = paged && Number.isFinite(paged.page) ? paged.page : 1;
    const pageCount = paged && Number.isFinite(paged.pageCount) ? paged.pageCount : 1;
    return "Showing " + paged.start + "–" + paged.end + " of " + total + " players · Page " + page + " of " + pageCount;
  }
  function describePlayerFilterState(options) {
    const settings = options && typeof options === "object" ? options : {};
    const parts = [];
    const query = typeof settings.query === "string" ? settings.query.trim() : "";
    if (query) {
      parts.push("search \"" + query + "\"");
    }
    for (const flag of ["mapped", "unmapped", "muted", "orphaned"]) {
      if (settings[flag]) {
        parts.push(flag);
      }
    }
    return parts.length ? "Filters: " + parts.join(", ") : "No filters";
  }
  function formatTraceCountStatus(shown, total, filters) {
    const shownCount = Number.isFinite(shown) ? Math.max(0, Math.trunc(shown)) : 0;
    const totalCount = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
    const source = filters && typeof filters === "object" ? filters : {};
    const active = [];
    if (typeof source.scanId === "string" && source.scanId.trim() !== "") {
      active.push("scan " + source.scanId.trim());
    }
    if (typeof source.stage === "string" && source.stage.trim() !== "") {
      active.push("stage " + source.stage.trim());
    }
    if (typeof source.outcome === "string" && source.outcome.trim() !== "") {
      active.push("outcome " + source.outcome.trim());
    }
    return "Showing " + shownCount + " of " + totalCount + " traces · " + (active.length ? "filtered by " + active.join(", ") : "no filters");
  }
  function describeFreshnessState(observedMs, nowMs) {
    if (!Number.isFinite(observedMs) || observedMs <= 0) {
      return "Not recorded";
    }
    const now = Number.isFinite(nowMs) ? nowMs : observedMs;
    const ageSec = Math.max(0, Math.floor((now - observedMs) / 1e3));
    return (ageSec <= 120 ? "Fresh — observed " : "Stale — observed ") + ageSec + "s ago";
  }
  function describeAlertRoleError(value) {
    return validateDiscordRoleId(value) === null ? "Enter a valid Discord role ID (17–20 digits)." : null;
  }
  function describeAlertThresholdError(raw, kind) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      return null;
    }
    if (kind !== "attack" && kind !== "raid" && kind !== "normal" && kind !== "high") {
      return "Unknown threshold field.";
    }
    if (!/^\d+$/.test(text)) {
      return kind === "attack" || kind === "raid" ? "Enter a whole number from 1 to 999." : "Enter a whole number of 1 or more.";
    }
    const number = Number(text);
    if (kind === "attack" || kind === "raid") {
      return number >= 1 && number <= 999 ? null : "Enter a whole number from 1 to 999.";
    }
    return number >= 1 ? null : "Enter a whole number of 1 or more.";
  }
  function writeVerifiedJson(storageApi, key, value) {
    const api = storageApi && typeof storageApi === "object" ? storageApi : {};
    const write = typeof api.setItem === "function" ? api.setItem.bind(api) : api.write;
    const read = typeof api.getItem === "function" ? api.getItem.bind(api) : api.read;
    const canonical = (inputValue) => {
      const parsed = typeof inputValue === "string" ? JSON.parse(inputValue) : inputValue;
      if (Array.isArray(parsed)) return "[" + parsed.map(canonical).join(",") + "]";
      if (parsed && typeof parsed === "object") return "{" + Object.keys(parsed).sort().map((name) => JSON.stringify(name) + ":" + canonical(parsed[name])).join(",") + "}";
      return JSON.stringify(parsed);
    };
    const bytes = JSON.stringify(value);
    try {
      if (typeof write !== "function") throw new TypeError("storage-write-unavailable");
      write(key, bytes);
    } catch (error) {
      return { ok: false, kind: "write-threw", error };
    }
    try {
      if (typeof read !== "function" || canonical(read(key)) !== canonical(value)) return { ok: false, kind: "readback-mismatch" };
    } catch (error) {
      return { ok: false, kind: "readback-mismatch", error };
    }
    return { ok: true, kind: "written" };
  }
  function addMapping(mappings, hostname, playerId, discordIds) {
    const base = mappings && typeof mappings === "object" ? mappings : {};
    const worldKey = normalizeHostname(hostname);
    const profileKey = String(playerId);
    const source = Array.isArray(discordIds) ? discordIds : String(discordIds || "").split(",");
    const validBatch = [];
    const invalidIds = [];
    const seen = /* @__PURE__ */ new Set();
    for (const raw of source) {
      const valid = validateDiscordUserId(raw);
      if (valid) {
        if (!seen.has(valid)) {
          seen.add(valid);
          validBatch.push(valid);
        }
      } else if (typeof raw === "string" && raw.trim() !== "") {
        invalidIds.push(raw.trim());
      }
    }
    const existingList = Array.isArray(
      base[worldKey] && base[worldKey][profileKey]
    ) ? base[worldKey][profileKey] : [];
    const merged = new Set(existingList);
    for (const id of validBatch) {
      merged.add(id);
    }
    const validIds = [...merged];
    const nextWorld = Object.assign(
      {},
      base[worldKey] || {}
    );
    if (validIds.length > 0) {
      nextWorld[profileKey] = validIds;
    }
    const nextMappings = Object.assign({}, base);
    if (Object.prototype.hasOwnProperty.call(
      base,
      worldKey
    ) || Object.keys(nextWorld).length > 0) {
      nextMappings[worldKey] = nextWorld;
    }
    return {
      mappings: nextMappings,
      validIds,
      invalidIds
    };
  }
  function removeMapping(mappings, hostname, playerId, discordId) {
    const base = mappings && typeof mappings === "object" ? mappings : {};
    const worldKey = normalizeHostname(hostname);
    const profileKey = String(playerId);
    const world = base[worldKey];
    const list = world ? world[profileKey] : void 0;
    if (!world || !list || !Array.isArray(list)) {
      return base;
    }
    if (discordId === void 0 || discordId === null) {
      const nextWorld2 = Object.assign({}, world);
      delete nextWorld2[profileKey];
      const nextMappings2 = Object.assign({}, base);
      nextMappings2[worldKey] = nextWorld2;
      return nextMappings2;
    }
    const target = validateDiscordUserId(discordId);
    if (target === null || !list.includes(target)) {
      return base;
    }
    const remaining = list.filter(
      (id) => id !== target
    );
    const nextWorld = Object.assign({}, world);
    if (remaining.length > 0) {
      nextWorld[profileKey] = remaining;
    } else {
      delete nextWorld[profileKey];
    }
    const nextMappings = Object.assign({}, base);
    nextMappings[worldKey] = nextWorld;
    return nextMappings;
  }
  function listMappings(mappings, hostname) {
    const base = mappings && typeof mappings === "object" ? mappings : {};
    const worldKey = normalizeHostname(hostname);
    const world = base[worldKey] || {};
    const items = [];
    for (const [profileId, ids] of Object.entries(world)) {
      const list = Array.isArray(ids) ? ids : [];
      if (list.length === 0) {
        continue;
      }
      items.push(
        `${profileId} → ${list.join(", ")}`
      );
    }
    return items;
  }
  function setAlertRoleId(config, roleId) {
    const base = config && typeof config === "object" ? config : {};
    const valid = validateDiscordRoleId(roleId);
    if (valid === null) {
      return base;
    }
    return Object.assign({}, base, { roleId: valid });
  }
  function clearAlertRoleId(config) {
    const base = config && typeof config === "object" ? config : {};
    return Object.assign({}, base, { roleId: null });
  }
  function setLeaveRoleId(config, roleId) {
    const base = config && typeof config === "object" ? config : {};
    const valid = validateDiscordRoleId(roleId);
    if (valid === null) return base;
    return Object.assign({}, base, { leaveRoleId: valid });
  }
  function clearLeaveRoleId(config) {
    const base = config && typeof config === "object" ? config : {};
    return Object.assign({}, base, { leaveRoleId: null });
  }
  function findPlayerInRow(row, attackIcon) {
    const attackCell = attackIcon.closest("td");
    const containers = [
      attackCell,
      row
    ].filter(Boolean);
    for (const container of containers) {
      const links = [
        ...container.querySelectorAll("a")
      ];
      const profileLink = links.find((link) => {
        const href = link.getAttribute("href") || "";
        const text = cleanText(link.textContent);
        if (!text || /^\d+[.]?$/.test(text)) {
          return false;
        }
        return (href.includes("/profile/") || href.includes("/player/") || href.includes("spieler.php") || href.includes("uid=")) && !href.includes("/alliance/");
      });
      if (profileLink) {
        return createPlayerData(profileLink);
      }
      const fallbackLink = links.find((link) => {
        const href = link.getAttribute("href") || "";
        const text = cleanText(link.textContent);
        return text.length >= 2 && !/^\d+[.]?$/.test(text) && !href.includes("/alliance/");
      });
      if (fallbackLink) {
        return createPlayerData(fallbackLink);
      }
    }
    if (attackCell) {
      const clonedCell = attackCell.cloneNode(true);
      clonedCell.querySelectorAll(
        "img, svg, script, style"
      ).forEach((element) => element.remove());
      const cellText = cleanText(clonedCell.textContent);
      if (cellText) {
        return {
          name: cellText,
          url: location.href,
          key: `player:${cellText.toLocaleLowerCase("pl-PL")}`
        };
      }
    }
    return null;
  }
  const SNAPSHOT_COUNT_MAX = Number.MAX_SAFE_INTEGER;
  function snapshotAnomalies() {
    return {
      missingId: false,
      duplicateId: false,
      conflictingTooltip: false,
      malformedCount: false,
      paginationOrFilter: false
    };
  }
  function snapshotNumber(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > SNAPSHOT_COUNT_MAX) {
        return { count: 0, malformed: true };
      }
      return { count: value, malformed: false };
    }
    if (typeof value !== "string") {
      return { count: 0, malformed: true };
    }
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return { count: 0, malformed: true };
    }
    const count = Number(text);
    if (!Number.isSafeInteger(count) || count < 0 || count > SNAPSHOT_COUNT_MAX) {
      return { count: 0, malformed: true };
    }
    return { count, malformed: false };
  }
  function snapshotTooltipCount(source, type) {
    const text = typeof source === "string" ? source : "";
    const attackWords = "atak(?:\\(ów\\)|ów|i)?|attack(?:\\(s\\)|s)?|angriff(?:e)?";
    const raidWords = "grabież(?:y|e)?|raid(?:s)?|raubz(?:ü|ue)ge|raubzug(?:e)?";
    const words = type === "attack" ? attackWords : raidWords;
    const token = new RegExp(
      `([+-]?\\d+(?:[.,]\\d+)?|NaN|Infinity|∞)\\s*(?:${words})`,
      "iu"
    );
    const match = text.match(token);
    if (!match) {
      const wordOnly = new RegExp(`(?:${words})`, "iu");
      return {
        found: wordOnly.test(text),
        count: 0,
        malformed: wordOnly.test(text)
      };
    }
    const parsed = snapshotNumber(match[1]);
    return {
      found: true,
      count: parsed.count,
       malformed: parsed.malformed || parsed.count < 0 || match[1].includes(".") || match[1].includes(",") || match[1].startsWith("-") || match[1].startsWith("+")
    };
  }
  function normalizedTooltipSources(icon) {
    if (!icon || typeof icon !== "object") {
      return [];
    }
    if (Array.isArray(icon.tooltipSources)) {
      return icon.tooltipSources.filter((value) => typeof value === "string").map((value) => cleanText(value)).filter(Boolean);
    }
    if (typeof icon.tooltip === "string") {
      return [cleanText(icon.tooltip)].filter(Boolean);
    }
    const attributes = icon.attributes;
    if (!attributes || typeof attributes !== "object") {
      return [];
    }
    return [
      attributes.alt,
      attributes.title,
      attributes["aria-label"],
      attributes["data-tooltip"],
      attributes["data-title"],
      attributes["data-original-title"]
    ].filter((value) => typeof value === "string").map((value) => cleanText(value)).filter(Boolean);
  }
  function checkTooltipSourceAgreement(sources) {
    const normalized = (Array.isArray(sources) ? sources : []).filter((value) => typeof value === "string").map((value) => cleanText(value)).filter(Boolean);
    let attackCount = 0;
    let raidCount = 0;
    let malformedCount = false;
    let found = false;
    let agreement = null;
    for (const source of normalized) {
      const attack = snapshotTooltipCount(source, "attack");
      const raid = snapshotTooltipCount(source, "raid");
      const value = {
        attackCount: attack.found ? attack.count : 0,
        raidCount: raid.found ? raid.count : 0
      };
      malformedCount = malformedCount || attack.malformed || raid.malformed;
      if (!attack.found && !raid.found) {
        continue;
      }
      found = true;
      if (agreement === null) {
        agreement = value;
        attackCount = value.attackCount;
        raidCount = value.raidCount;
      } else if (agreement.attackCount !== value.attackCount || agreement.raidCount !== value.raidCount) {
        return {
          agrees: false,
          attackCount,
          raidCount,
          conflictingTooltip: true,
          malformedCount
        };
      }
    }
    return {
      agrees: true,
      attackCount: found ? attackCount : 0,
      raidCount: found ? raidCount : 0,
      conflictingTooltip: false,
      malformedCount
    };
  }
  function parseNormalizedMemberIcon(icon, context = {}) {
    const className = String(
      icon && icon.className !== void 0 ? icon.className : ""
    );
    const hasAttackClass = context.hasAttackClass !== void 0 ? Boolean(context.hasAttackClass) : /(?:^|\s)attack(?:\s|$)/i.test(className);
    if (!hasAttackClass) {
      return null;
    }
    const agreement = checkTooltipSourceAgreement(
      normalizedTooltipSources(icon)
    );
    return {
      attackCount: agreement.attackCount,
      raidCount: agreement.raidCount,
      hasEvent: agreement.attackCount > 0 || agreement.raidCount > 0,
      conflictingTooltip: agreement.conflictingTooltip,
      malformedCount: agreement.malformedCount
    };
  }
  function parseNormalizedMemberRow(row, context = {}) {
    const input = row && typeof row === "object" ? row : {};
    const id = input.id === null || input.id === void 0 ? "" : String(input.id).trim();
    const name = cleanText(input.name);
    const url = typeof input.url === "string" ? input.url.trim() : "";
    const icons = Array.isArray(input.icons) ? input.icons : [];
    const parseIcon = typeof context.parseIcon === "function" ? context.parseIcon : parseNormalizedMemberIcon;
    let attackCount = 0;
    let raidCount = 0;
    let conflictingTooltip = false;
    let malformedCount = false;
    let iconBearing = false;
    for (const icon of icons) {
      const parsed = parseIcon(icon, context);
      if (!parsed) {
        continue;
      }
      iconBearing = true;
      attackCount = Math.max(attackCount, parsed.attackCount);
      raidCount = Math.max(raidCount, parsed.raidCount);
      conflictingTooltip = conflictingTooltip || parsed.conflictingTooltip === true;
      malformedCount = malformedCount || parsed.malformedCount === true;
    }
    return {
      id,
      name,
      url,
      attackCount,
      raidCount,
      missingId: id.length === 0 || name.length === 0,
      conflictingTooltip,
      malformedCount,
      iconBearing
    };
  }
  function snapshotRowValue(row) {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      attackCount: row.attackCount,
      raidCount: row.raidCount
    };
  }
  function snapshotStableString(value) {
    if (Array.isArray(value)) {
      return `[${value.map(snapshotStableString).sort().join(",")}]`;
    }
    if (!value || typeof value !== "object") {
      return JSON.stringify(value);
    }
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${snapshotStableString(value[key])}`
    ).join(",")}}`;
  }
  function buildStableTableSignature(table) {
    const input = table && typeof table === "object" ? table : {};
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const shape = rows.map((row) => {
      const item = row && typeof row === "object" ? row : {};
      const icons = Array.isArray(item.icons) ? item.icons : [];
      return {
        id: item.id === null || item.id === void 0 ? "" : String(item.id).trim(),
        name: cleanText(item.name),
        url: typeof item.url === "string" ? item.url.trim() : "",
        icons: icons.map((icon) => normalizedTooltipSources(icon).sort())
      };
    });
    const inputText = snapshotStableString({
      rows: shape,
      paginationOrFilter: Boolean(
        input.paginationOrFilter || input.pagination || input.filtered || input.hasPagination || input.hasFilter
      )
    });
    let hash = 2166136261;
    for (let index = 0; index < inputText.length; index += 1) {
      hash ^= inputText.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `alliance-members-v1:${hash.toString(16).padStart(8, "0")}`;
  }
  function extractAllianceSnapshotFromRows(rows, options = {}) {
    const inputRows = Array.isArray(rows) ? rows : [];
    const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : Date.now();
    const anomalies = snapshotAnomalies();
    const membersById = {};
    const parsedRows = [];
    let iconCount = 0;
    const parseRow = typeof options.parseRow === "function" ? options.parseRow : parseNormalizedMemberRow;
    for (const row of inputRows) {
      iconCount += row && Array.isArray(row.icons) ? row.icons.length : 0;
      const parsed = parseRow(row, options);
      parsedRows.push(parsed);
      anomalies.missingId = anomalies.missingId || parsed.missingId === true;
      anomalies.conflictingTooltip = anomalies.conflictingTooltip || parsed.conflictingTooltip === true;
      anomalies.malformedCount = anomalies.malformedCount || parsed.malformedCount === true;
      if (!parsed.id) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(membersById, parsed.id)) {
        anomalies.duplicateId = true;
        continue;
      }
      membersById[parsed.id] = {
        name: parsed.name,
        url: parsed.url,
        attackCount: parsed.attackCount,
        raidCount: parsed.raidCount
      };
    }
    const table = {
      rows: parsedRows,
      paginationOrFilter: Boolean(
        options.paginationOrFilter || options.pagination || options.filtered || options.hasPagination || options.hasFilter
      )
    };
    anomalies.paginationOrFilter = table.paginationOrFilter;
    let status = "authoritative";
    if (inputRows.length === 0 || Object.keys(membersById).length === 0 || anomalies.missingId || anomalies.duplicateId || anomalies.conflictingTooltip || anomalies.malformedCount) {
      status = "invalid";
    } else if (anomalies.paginationOrFilter) {
      status = "partial";
    }
    const result = {
      status,
      observedAtMs,
      tableSignature: buildStableTableSignature(table),
      membersById,
      anomalies
    };
    Object.defineProperty(result, "rowCount", {
      value: parsedRows.length,
      enumerable: false
    });
    Object.defineProperty(result, "iconCount", {
      value: iconCount,
      enumerable: false
    });
    Object.defineProperty(result, "rowAnomalies", {
      value: parsedRows.filter((row) => row.missingId || row.conflictingTooltip || row.malformedCount),
      enumerable: false
    });
    return result;
  }
  function buildAllianceSnapshot(table, observedAtMs, options = {}) {
    const input = table && typeof table === "object" ? table : {};
    return extractAllianceSnapshotFromRows(
      input.rows,
      Object.assign({}, input, options, { observedAtMs })
    );
  }
  function diffAllianceSnapshots(previous, current) {
    if (!current || current.status !== "authoritative") {
      return {
        commit: false,
        events: [],
        current: current && current.membersById ? current.membersById : {},
        observedAtMs: current && current.observedAtMs
      };
    }
    const previousMembers = previous && previous.status === "authoritative" ? previous.membersById || {} : {};
    const events = [];
    for (const [id, member] of Object.entries(current.membersById)) {
      const old = previousMembers[id] || {};
      const oldAttackCount = Number.isFinite(old.attackCount) ? old.attackCount : 0;
      const oldRaidCount = Number.isFinite(old.raidCount) ? old.raidCount : 0;
      const addedAttackCount = Math.max(
        0,
        member.attackCount - oldAttackCount
      );
      const addedRaidCount = Math.max(
        0,
        member.raidCount - oldRaidCount
      );
      if (addedAttackCount === 0 && addedRaidCount === 0) {
        continue;
      }
      events.push({
        id,
        name: member.name,
        url: member.url,
        attackCount: member.attackCount,
        raidCount: member.raidCount,
        oldAttackCount,
        oldRaidCount,
        addedAttackCount,
        addedRaidCount,
        eventType: addedAttackCount > 0 && addedRaidCount > 0 ? "mixed" : addedAttackCount > 0 ? "attack" : "raid"
      });
    }
    return {
      commit: true,
      events,
      current: current.membersById,
      observedAtMs: current.observedAtMs
    };
  }
  function migrationFriendlyCountRecords(snapshot) {
    if (!snapshot || snapshot.status !== "authoritative" || !snapshot.membersById) {
      return [];
    }
    return Object.entries(snapshot.membersById).sort(([left], [right]) => left.localeCompare(right)).map(([id, member]) => ({
      id,
      name: member.name,
      url: member.url,
      attackCount: member.attackCount,
      raidCount: member.raidCount
    }));
  }
  const MONITOR_ENVELOPE_SCHEMA_VERSION = 1;
  const MONITOR_ACTIVE_STORAGE_KEY_PREFIX = "travianAllianceMonitor_v1:";
  const MONITOR_BACKUP_STORAGE_KEY_PREFIX = "travianAllianceMonitorBackup_v1:";
  const MONITOR_QUARANTINE_STORAGE_KEY_PREFIX = "travianAllianceMonitorQuarantine_v1:";
  const MONITOR_QUARANTINE_INDEX_SUFFIX = ":index";
  const MONITOR_MAX_PENDING_RECORDS = 512;
  const MONITOR_QUARANTINE_MAX_ENTRIES = 3;
  const MONITOR_QUARANTINE_MAX_BYTES = 128 * 1024;
  function cloneMonitorValue(value) {
    if (value === void 0) {
      return void 0;
    }
    return JSON.parse(JSON.stringify(value));
  }
  function canonicalSerializeMonitorValue(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(
        (item) => canonicalSerializeMonitorValue(item)
      ).join(",") + "]";
    }
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().filter((key) => value[key] !== void 0).map(
        (key) => JSON.stringify(key) + ":" + canonicalSerializeMonitorValue(value[key])
      ).join(",") + "}";
    }
    return JSON.stringify(value);
  }
  function checksumMonitorCanonicalValue(value) {
    const source = typeof value === "string" ? value : canonicalSerializeMonitorValue(value);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function monitorEnvelopeWithoutIntegrity(envelope) {
    const copy = Object.assign({}, envelope);
    delete copy.integrity;
    return copy;
  }
  function monitorEnvelopeDefaults(world, overrides = {}) {
    const input = overrides && typeof overrides === "object" ? overrides : {};
    const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
    const sourceAccounting = input.metrics && input.metrics.deliveryAccounting;
    const deliveryAccounting = Object.assign({
      recoverable: [],
      terminal: [],
      compactedTerminalTotals: [],
      dispatchPlans: [],
      compactedThroughTerminalSequence: 0,
      nextTerminalSequence: 1,
      compactionClaim: null,
      lastCompaction: null
    }, sourceAccounting || {});
    deliveryAccounting.recoverable = Array.isArray(deliveryAccounting.recoverable) ? deliveryAccounting.recoverable.slice() : [];
    deliveryAccounting.terminal = Array.isArray(deliveryAccounting.terminal) ? deliveryAccounting.terminal.slice() : [];
    deliveryAccounting.compactedTerminalTotals = Array.isArray(deliveryAccounting.compactedTerminalTotals) ? deliveryAccounting.compactedTerminalTotals.slice() : [];
    deliveryAccounting.dispatchPlans = Array.isArray(deliveryAccounting.dispatchPlans) ? deliveryAccounting.dispatchPlans.slice() : [];
    return {
      schemaVersion: MONITOR_ENVELOPE_SCHEMA_VERSION,
      world: normalizeHostname(world),
      generation: Number.isInteger(input.generation) && input.generation >= 0 ? input.generation : 0,
      integrity: "",
      migration: Object.assign({
        completedAtMs: null,
        sources: []
      }, input.migration || {}),
      baselineByPlayerId: Object.assign({}, input.baselineByPlayerId || {}),
      rosterByPlayerId: Object.assign({}, input.rosterByPlayerId || {}),
      pending: Array.isArray(input.pending) ? input.pending.slice() : [],
      inFlight: Array.isArray(input.inFlight) ? input.inFlight.slice() : [],
      failed: Array.isArray(input.failed) ? input.failed.slice() : [],
      uncertain: Array.isArray(input.uncertain) ? input.uncertain.slice() : [],
      diagnostics: Object.assign({
        migrationAmbiguities: 0,
        lastCorruption: null,
        blockedQueueAtMs: null
      }, input.diagnostics || {}),
      metrics: Object.assign({
        lastAuthoritativeScanAtMs: null,
        lastCommitAtMs: null,
        lastError: null,
        deliveryAccounting
      }, input.metrics || {}, {
        lastCommitAtMs: input.metrics && Number.isFinite(input.metrics.lastCommitAtMs) ? input.metrics.lastCommitAtMs : null
      }),
      createdAtMs: input.createdAtMs === void 0 ? now : input.createdAtMs
    };
  }
  function createMonitorEnvelopeV1(world, overrides = {}) {
    const envelope = monitorEnvelopeDefaults(world, overrides);
    envelope.integrity = checksumMonitorCanonicalValue(
      monitorEnvelopeWithoutIntegrity(envelope)
    );
    return envelope;
  }
  function serializeMonitorEnvelopeV1(envelope) {
    const normalized = monitorEnvelopeDefaults(
      envelope && envelope.world,
      envelope || {}
    );
    normalized.integrity = checksumMonitorCanonicalValue(
      monitorEnvelopeWithoutIntegrity(normalized)
    );
    return canonicalSerializeMonitorValue(normalized);
  }
  function isPlainMonitorObject(value) {
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value)
    );
  }
  function parseMonitorEnvelopeV1(raw, expectedWorld) {
    let value = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch (error) {
        return { ok: false, outcome: "corrupt", reason: "invalid-json" };
      }
    }
    if (!isPlainMonitorObject(value)) {
      return { ok: false, outcome: "corrupt", reason: "not-object" };
    }
    const normalizedExpectedWorld = expectedWorld === void 0 ? null : normalizeHostname(expectedWorld);
    const queueBoundExceeded = [
      value.pending,
      value.inFlight,
      value.failed,
      value.uncertain
    ].some(
      (events) => Array.isArray(events) && events.length > MONITOR_MAX_PENDING_RECORDS
    );
    const validShape = value.schemaVersion === MONITOR_ENVELOPE_SCHEMA_VERSION && typeof value.world === "string" && (normalizedExpectedWorld === null || value.world === normalizedExpectedWorld) && Number.isInteger(value.generation) && value.generation >= 0 && typeof value.integrity === "string" && isPlainMonitorObject(value.migration) && isPlainMonitorObject(value.baselineByPlayerId) && isPlainMonitorObject(value.rosterByPlayerId) && Array.isArray(value.pending) && Array.isArray(value.inFlight) && Array.isArray(value.failed) && Array.isArray(value.uncertain) && !queueBoundExceeded && isPlainMonitorObject(value.diagnostics) && isPlainMonitorObject(value.metrics) && (value.metrics.deliveryAccounting === void 0 || isPlainMonitorObject(value.metrics.deliveryAccounting));
    if (!validShape) {
      if (queueBoundExceeded) {
        return { ok: false, outcome: "bound-exceeded", reason: "queue-bound" };
      }
      if (normalizedExpectedWorld !== null && value.world !== normalizedExpectedWorld) {
        return { ok: false, outcome: "corrupt", reason: "world-mismatch" };
      }
      return { ok: false, outcome: "corrupt", reason: "invalid-shape" };
    }
    const lineageValid = [
      value.pending,
      value.inFlight,
      value.failed,
      value.uncertain,
      value.metrics.deliveryAccounting?.recoverable || [],
      value.metrics.deliveryAccounting?.terminal || []
    ].flat().every((event) => !Array.isArray(event.sourceEventIds) || event.sourceEventIds.every((id) => {
      try {
        return sourceEventTuple(decodeSourceEventId(String(id))).sourceEventId === id;
      } catch (error) {
        return false;
      }
    }));
    const compactedLineageValid = (value.metrics.deliveryAccounting?.compactedTerminalTotals || []).every(
      (range) => Array.isArray(range.sourceEventIds) && range.sourceEventIds.every((id) => {
        try {
          return sourceEventTuple(decodeSourceEventId(String(id))).sourceEventId === id;
        } catch (error) {
          return false;
        }
      })
    );
    if (!lineageValid || !compactedLineageValid) return { ok: false, outcome: "corrupt", reason: "invalid-source-lineage" };
    const expected = checksumMonitorCanonicalValue(
      monitorEnvelopeWithoutIntegrity(value)
    );
    if (expected !== value.integrity) {
      return { ok: false, outcome: "corrupt", reason: "integrity-mismatch" };
    }
    return {
      ok: true,
      envelope: cloneMonitorValue(value)
    };
  }
  function compareMonitorGenerations(left, right) {
    const leftNumber = Number.isInteger(left) ? left : -1;
    const rightNumber = Number.isInteger(right) ? right : -1;
    return leftNumber > rightNumber ? 1 : leftNumber < rightNumber ? -1 : 0;
  }
  function isMonitorGenerationFenced(currentGeneration, candidateGeneration) {
    return compareMonitorGenerations(candidateGeneration, currentGeneration) > 0;
  }
  function monitorActiveStorageKey(world) {
    return MONITOR_ACTIVE_STORAGE_KEY_PREFIX + normalizeHostname(world);
  }
  function monitorBackupStorageKey(world) {
    return MONITOR_BACKUP_STORAGE_KEY_PREFIX + normalizeHostname(world);
  }
  function monitorQuarantineStorageKey(world, timestamp) {
    return MONITOR_QUARANTINE_STORAGE_KEY_PREFIX + normalizeHostname(world) + ":" + String(timestamp);
  }
  function monitorStorageAdapter(storage) {
    if (storage && typeof storage.get === "function" && typeof storage.set === "function") {
      return storage;
    }
    return {
      get(key) {
        if (typeof GM_getValue !== "function") {
          return void 0;
        }
        return GM_getValue(key, void 0);
      },
      set(key, value) {
        if (typeof GM_setValue !== "function") {
          throw new Error("GM storage unavailable");
        }
        return GM_setValue(key, value);
      },
      delete(key) {
        if (typeof GM_deleteValue !== "function") {
          throw new Error("GM storage unavailable");
        }
        return GM_deleteValue(key);
      }
    };
  }
  function monitorReadRaw(storage, key) {
    try {
      return {
        ok: true,
        value: monitorStorageAdapter(storage).get(key)
      };
    } catch (error) {
      return { ok: false, error };
    }
  }
  function mergeRuntimeDiagnostics(hostname, patch) {
    const world = normalizeHostname(hostname);
    const current = loadDiagnostics();
    const existing = current[world] && typeof current[world] === "object" ? current[world] : {};
    const next = Object.assign({}, current, {
      [world]: Object.assign({}, existing, patch || {})
    });
    saveDiagnostics(next, world);
    return next[world];
  }
  function monitorWriteRaw(storage, key, value) {
    try {
      const result = monitorStorageAdapter(storage).set(key, value);
      return result === false ? { ok: false, error: new Error("storage rejected write") } : { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
  function monitorWriteReadback(storage, key, serialized) {
    const write = monitorWriteRaw(storage, key, serialized);
    if (!write.ok) {
      return { ok: false, outcome: "wrote-failed" };
    }
    const read = monitorReadRaw(storage, key);
    if (!read.ok || read.value !== serialized) {
      return { ok: false, outcome: "readback-mismatch" };
    }
    return { ok: true, outcome: "ok" };
  }
  function monitorRestoreRaw(storage, key, raw) {
    if (raw !== void 0) return monitorWriteRaw(storage, key, raw).ok;
    try {
      const adapter = monitorStorageAdapter(storage);
      if (typeof adapter.delete === "function") return adapter.delete(key) !== false;
      if (storage && typeof storage.removeItem === "function") return storage.removeItem(key) !== false;
      if (typeof GM_deleteValue === "function") {
        GM_deleteValue(key);
        return true;
      }
    } catch (_) {
      return false;
    }
    return false;
  }
  function quarantineMonitorRawV1(world, raw, nowMs, storage) {
    if (typeof raw !== "string") {
      return { ok: false, outcome: "no-raw-input", quarantineKey: null };
    }
    if (raw.length > MONITOR_QUARANTINE_MAX_BYTES) {
      return { ok: false, outcome: "quarantine-size-exceeded", quarantineKey: null };
    }
    const adapter = monitorStorageAdapter(storage);
    const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now();
    const key = monitorQuarantineStorageKey(world, timestamp);
    const write = monitorWriteRaw(adapter, key, raw);
    if (!write.ok) {
      return { ok: false, outcome: "wrote-failed", quarantineKey: null };
    }
    let index = [];
    const indexKey = MONITOR_QUARANTINE_STORAGE_KEY_PREFIX + normalizeHostname(world) + MONITOR_QUARANTINE_INDEX_SUFFIX;
    const oldIndex = monitorReadRaw(adapter, indexKey);
    if (oldIndex.ok && typeof oldIndex.value === "string") {
      try {
        index = JSON.parse(oldIndex.value);
      } catch (error) {
        index = [];
      }
    }
    index = Array.isArray(index) ? index.filter((item) => item !== key) : [];
    index.push(key);
    while (index.length > MONITOR_QUARANTINE_MAX_ENTRIES) {
      const removed = index.shift();
      if (removed) {
        monitorWriteRaw(adapter, removed, "");
      }
    }
    monitorWriteRaw(adapter, indexKey, JSON.stringify(index));
    return { ok: true, outcome: "ok", quarantineKey: key };
  }
  function loadMonitorEnvelopeV1(world, options = {}) {
    const adapter = monitorStorageAdapter(options.storage);
    const activeKey = monitorActiveStorageKey(world);
    const backupKey = monitorBackupStorageKey(world);
    const activeRawResult = monitorReadRaw(adapter, activeKey);
    const backupRawResult = monitorReadRaw(adapter, backupKey);
    const activeRaw = activeRawResult.ok ? activeRawResult.value : void 0;
    const backupRaw = backupRawResult.ok ? backupRawResult.value : void 0;
    const active = parseMonitorEnvelopeV1(activeRaw, world);
    if (active.ok) {
      return {
        outcome: "ok",
        envelope: active.envelope,
        source: "active",
        blocked: false
      };
    }
    const quarantineKeys = [];
    if (activeRaw !== void 0) {
      const quarantine = quarantineMonitorRawV1(
        world,
        String(activeRaw),
        options.nowMs,
        adapter
      );
      if (quarantine.quarantineKey) {
        quarantineKeys.push(quarantine.quarantineKey);
      }
    }
    const backup = parseMonitorEnvelopeV1(backupRaw, world);
    if (backup.ok) {
      const repaired = monitorWriteReadback(
        adapter,
        activeKey,
        serializeMonitorEnvelopeV1(backup.envelope)
      );
      return {
        outcome: repaired.ok ? "recovered-from-backup" : "recovery-write-failed",
        envelope: repaired.ok ? backup.envelope : void 0,
        source: "backup",
        repaired: repaired.ok,
        quarantineKeys,
        blocked: !repaired.ok
      };
    }
    if (backupRaw !== void 0) {
      const quarantine = quarantineMonitorRawV1(
        world,
        String(backupRaw),
        Number.isFinite(options.nowMs) ? options.nowMs + 1 : Date.now() + 1,
        adapter
      );
      if (quarantine.quarantineKey) {
        quarantineKeys.push(quarantine.quarantineKey);
      }
    }
    const hasActive = activeRaw !== void 0;
    const hasBackup = backupRaw !== void 0;
    const activeRequiresBlock = active.outcome === "bound-exceeded" || active.reason === "world-mismatch";
    return {
      outcome: activeRequiresBlock ? active.outcome === "bound-exceeded" ? "bound-exceeded" : "corrupt-active" : hasActive && hasBackup ? "corrupt-backup" : "missing",
      source: null,
      blocked: activeRequiresBlock || hasActive && hasBackup,
      canExport: hasActive && hasBackup,
      canReset: hasActive && hasBackup,
      activeRaw,
      backupRaw,
      quarantineKeys
    };
  }
  function monitorEventPlayerId(event) {
    if (!event || typeof event !== "object") {
      return null;
    }
    const value = event.playerId !== void 0 ? event.playerId : event.id;
    return value === void 0 || value === null || String(value) === "" ? null : String(value);
  }
  function monitorEventType(event) {
    return event && typeof event.eventType === "string" ? event.eventType : "attack";
  }
  function isMonitorDeltaType(type) {
    return type === "attack" || type === "raid" || type === "mixed";
  }
  function monitorEventsCompatible(left, right) {
    const leftType = monitorEventType(left);
    const rightType = monitorEventType(right);
    const sameWorld = normalizeHostname(left.world || "") === normalizeHostname(right.world || "");
    const samePlayer = monitorEventPlayerId(left) === monitorEventPlayerId(right);
    if (!sameWorld || !samePlayer) {
      return false;
    }
    if (isMonitorDeltaType(leftType) && isMonitorDeltaType(rightType)) {
      return true;
    }
    return (leftType === "join" || leftType === "leave") && leftType === rightType;
  }
  function monitorMergedDeltaType(event) {
    const attacks = Number(event.addedAttackCount) || 0;
    const raids = Number(event.addedRaidCount) || 0;
    return attacks > 0 && raids > 0 ? "mixed" : attacks > 0 ? "attack" : "raid";
  }
  function coalesceMonitorPendingEvents(events, maxRecords = MONITOR_MAX_PENDING_RECORDS, blockedAtMs = Date.now()) {
    if (!Array.isArray(events)) {
      return { ok: true, outcome: "ok", events: [] };
    }
    const limit = Number.isInteger(maxRecords) && maxRecords >= 0 ? maxRecords : MONITOR_MAX_PENDING_RECORDS;
    const result = [];
    for (const input of events) {
      const event = isPlainMonitorObject(input) ? Object.assign({}, input, {
        playerId: monitorEventPlayerId(input)
      }) : null;
      if (!event || event.playerId === null) {
        result.push(event || {});
        continue;
      }
      if (Array.isArray(event.sourceEventIds)) {
        try {
          event.sourceEventIds = [...new Set(event.sourceEventIds.map((id) => {
            const canonical = sourceEventTuple(decodeSourceEventId(String(id)));
            if (canonical.sourceEventId !== id) throw new Error("noncanonical source ID");
            return id;
          }))];
        } catch (error) {
          return { ok: false, outcome: "invalid-source-lineage", events: [], healthError: "source-id-validation-failed" };
        }
      }
      const index = result.findIndex(
        (existing) => monitorEventsCompatible(existing, event)
      );
      if (index < 0) {
        result.push(event);
        continue;
      }
      const current = result[index];
      const currentType = monitorEventType(current);
      if (isMonitorDeltaType(currentType) && isMonitorDeltaType(monitorEventType(event))) {
        const merged = Object.assign({}, current, event, {
          world: event.world || current.world,
          playerId: event.playerId,
          eventId: current.eventId || event.eventId,
          sourceEventIds: [...new Set((current.sourceEventIds || []).concat(event.sourceEventIds || []))],
          sourceEventTuples: [...new Set((current.sourceEventIds || []).concat(event.sourceEventIds || []))].map((id) => sourceEventTuple(decodeSourceEventId(id))),
          addedAttackCount: (Number(current.addedAttackCount) || 0) + (Number(event.addedAttackCount) || 0),
          addedRaidCount: (Number(current.addedRaidCount) || 0) + (Number(event.addedRaidCount) || 0),
          observedAtMs: Number.isFinite(current.observedAtMs) || Number.isFinite(event.observedAtMs) ? Math.min(
            Number.isFinite(current.observedAtMs) ? current.observedAtMs : Infinity,
            Number.isFinite(event.observedAtMs) ? event.observedAtMs : Infinity
          ) : void 0,
          queuedAtMs: Number.isFinite(current.queuedAtMs) || Number.isFinite(event.queuedAtMs) ? Math.min(
            Number.isFinite(current.queuedAtMs) ? current.queuedAtMs : Infinity,
            Number.isFinite(event.queuedAtMs) ? event.queuedAtMs : Infinity
          ) : void 0
        });
        merged.eventType = monitorMergedDeltaType(merged);
        result[index] = merged;
      } else {
        result[index] = Object.assign({}, current, event);
      }
    }
    if (result.length > limit) {
      return {
        ok: false,
        outcome: "bound-exhausted",
        events: [],
        blockedQueueAtMs: Number.isFinite(blockedAtMs) ? blockedAtMs : Date.now(),
        healthError: "monitor-pending-bound-exhausted"
      };
    }
    return { ok: true, outcome: "ok", events: result };
  }
  function deliveryAccountingFor(envelope) {
    const metrics = envelope.metrics || {};
    const accounting = metrics.deliveryAccounting;
    return isPlainMonitorObject(accounting) ? accounting : monitorEnvelopeDefaults(envelope.world).metrics.deliveryAccounting;
  }
  const DISPATCH_CHUNK_STATES = Object.freeze(["prepared", "sending", "acknowledged", "retryable", "failed", "uncertain"]);
  function dispatchIdentityHash(prefix, values) {
    return `${prefix}${checksumMonitorCanonicalValue(values)}`;
  }
  function dispatchSourceRecords(events) {
    const records = [];
    for (const event of Array.isArray(events) ? events : []) {
      const ids = Array.isArray(event.sourceEventIds) ? event.sourceEventIds.map(String) : [];
      const attackTotal = Number(event.addedAttackCount) || 0;
      ids.forEach((sourceEventId, index) => {
        const isRaid = event.eventType === "raid" || event.eventType === "mixed" && index >= attackTotal || !event.eventType && attackTotal === 0 && (Number(event.addedRaidCount) || 0) > 0;
        records.push({ sourceEventId, eventId: event.eventId, addedAttackCount: isRaid ? 0 : 1, addedRaidCount: isRaid ? 1 : 0 });
      });
    }
    records.sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
    const seen = /* @__PURE__ */ new Set();
    for (const record of records) {
      if (!record.sourceEventId || seen.has(record.sourceEventId)) throw new Error("duplicate dispatch source ID");
      seen.add(record.sourceEventId);
    }
    return records;
  }
  function buildDispatchPlanV1(events, options = {}) {
    const records = dispatchSourceRecords(events);
    const sourceIds = records.map((record) => record.sourceEventId);
    const batchId = dispatchIdentityHash("b1:", sourceIds);
    const requestedSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : PAYLOAD_CHUNK_MAX;
    const chunks = [];
    for (let offset = 0; offset < records.length; offset += requestedSize) {
      const chunkRecords = records.slice(offset, offset + requestedSize);
      const chunkIds = chunkRecords.map((record) => record.sourceEventId);
      chunks.push({
        batchId,
        chunkId: dispatchIdentityHash("c1:", [batchId, chunkIds]),
        sourceEventIds: chunkIds,
        sourceCount: chunkIds.length,
        attackCount: chunkRecords.reduce((sum, record) => sum + record.addedAttackCount, 0),
        raidCount: chunkRecords.reduce((sum, record) => sum + record.addedRaidCount, 0),
        state: "prepared",
        attempt: 0,
        ownerId: null,
        term: null,
        retryAtMs: null,
        ackHash: null,
        responseClass: null
      });
    }
    return { schemaVersion: 1, batchId, generation: Number.isInteger(options.generation) ? options.generation : 0, chunks };
  }
  function buildDispatchRequestV1(chunk, payload, ownerId, term) {
    const sourceEventIds = Array.isArray(chunk && chunk.sourceEventIds) ? chunk.sourceEventIds.slice() : [];
    return {
      batchId: chunk && chunk.batchId,
      chunkId: chunk && chunk.chunkId,
      sourceEventIds,
      sourceCount: sourceEventIds.length,
      attackCount: Number(chunk && chunk.attackCount) || 0,
      raidCount: Number(chunk && chunk.raidCount) || 0,
      ownerId: ownerId === void 0 ? null : ownerId,
      term: term === void 0 ? null : term,
      payload: payload || {}
    };
  }
  function ackHashForDiscordMessageId(messageId) {
    return dispatchIdentityHash("a1:", String(messageId));
  }
  function applyDispatchPlanTransitionV1(plan, transition) {
    if (!plan || !Array.isArray(plan.chunks) || !transition) return null;
    const next = JSON.parse(JSON.stringify(plan));
    const index = transition.chunkId ? next.chunks.findIndex((chunk2) => chunk2.chunkId === transition.chunkId) : next.chunks.findIndex((chunk2) => chunk2.state === "prepared" || chunk2.state === "retryable");
    if (index < 0) return null;
    const chunk = next.chunks[index];
    const bump = () => {
      next.generation += 1;
    };
    if (transition.type === "claim") {
      if (!["prepared", "retryable"].includes(chunk.state) || transition.generation !== next.generation) return null;
      chunk.state = "sending";
      chunk.ownerId = String(transition.ownerId);
      chunk.term = transition.term;
      chunk.attempt += 1;
      chunk.lastRequest = buildDispatchRequestV1(chunk, transition.payload, chunk.ownerId, chunk.term);
      chunk.lastRequest.attempt = chunk.attempt;
      next.ownerId = chunk.ownerId;
      next.term = chunk.term;
      bump();
    } else if (transition.type === "response") {
      if (chunk.state !== "sending" || transition.generation !== next.generation || transition.ownerId !== chunk.ownerId || transition.term !== chunk.term) return null;
      const status = Number(transition.status);
      if (status === 200 && typeof transition.messageId === "string" && transition.messageId.length > 0) {
        if (transition.settled === false) {
          chunk.state = "uncertain";
          chunk.responseClass = "acknowledgement-unsettled";
        } else {
          chunk.state = "acknowledged";
          chunk.ackHash = ackHashForDiscordMessageId(transition.messageId);
          chunk.messageId = void 0;
        }
      } else if (status === 200) {
        chunk.state = "uncertain";
        chunk.responseClass = String(transition.responseClass || "malformed-json-200");
      } else if (status === 408 || status === 429 || status >= 500 || transition.errorClass === "network" || transition.errorClass === "timeout") {
        chunk.state = "retryable";
        chunk.retryAtMs = Number.isFinite(transition.retryAtMs) ? transition.retryAtMs : null;
      } else {
        chunk.state = "failed";
        chunk.responseClass = String(transition.responseClass || status || "permanent");
      }
      chunk.ownerId = null;
      chunk.term = null;
      next.ownerId = null;
      next.term = null;
      bump();
    } else if (transition.type === "recover") {
      if (chunk.state !== "sending" || transition.generation !== next.generation) return null;
      chunk.state = "uncertain";
      chunk.responseClass = String(transition.responseClass || "lease-lost");
      chunk.ownerId = null;
      chunk.term = null;
      next.ownerId = null;
      next.term = null;
      bump();
    } else if (transition.type === "manual-retry") {
      if (chunk.state !== "uncertain" || transition.generation !== next.generation) return null;
      chunk.state = "prepared";
      chunk.responseClass = null;
      bump();
    } else if (transition.type === "manual-acknowledge") {
      if (chunk.state !== "uncertain" || transition.generation !== next.generation) return null;
      chunk.state = "acknowledged";
      chunk.ackHash = ackHashForDiscordMessageId(String(transition.messageId || "manual"));
      bump();
    } else return null;
    return next;
  }
  function createDispatchPlanInAccountingV1(envelope, events, options = {}) {
    const base = createMonitorEnvelopeV1(envelope && envelope.world, envelope || {});
    const accounting = deliveryAccountingFor(base);
    const candidate2 = buildDispatchPlanV1(events, Object.assign({}, options, { generation: base.generation }));
    const active = accounting.dispatchPlans.some((plan) => plan.batchId === candidate2.batchId && plan.chunks.some((chunk) => !["acknowledged", "failed"].includes(chunk.state)));
    if (active) return { outcome: "duplicate-active-plan", envelope: base, plan: accounting.dispatchPlans.find((plan) => plan.batchId === candidate2.batchId) };
    const sourceIds = new Set(candidate2.chunks.flatMap((chunk) => chunk.sourceEventIds));
    if (accounting.dispatchPlans.some((plan) => plan.chunks.some((chunk) => chunk.sourceEventIds.some((id) => sourceIds.has(id) && !["acknowledged", "failed"].includes(chunk.state))))) return { outcome: "source-already-planned", envelope: base };
    accounting.dispatchPlans = accounting.dispatchPlans.concat(candidate2);
    syncDeliveryAccounting(base);
    base.generation += 1;
    base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base));
    return { outcome: "created", envelope: base, plan: candidate2 };
  }
  function commitDispatchPlanTransitionV1(options = {}) {
    const current = options.currentEnvelope;
    const accounting = current ? deliveryAccountingFor(current) : null;
    const plan = accounting && accounting.dispatchPlans.find((item) => item.batchId === options.batchId);
    if (!plan || typeof options.beforeCommit === "function" && options.beforeCommit() !== true) return { outcome: "fenced-reject", memorySwapped: false };
    const nextPlan = applyDispatchPlanTransitionV1(plan, options.transition);
    if (!nextPlan) return { outcome: "fenced-reject", memorySwapped: false };
    const candidate2 = createMonitorEnvelopeV1(current.world, current);
    candidate2.metrics.deliveryAccounting.dispatchPlans = accounting.dispatchPlans.map((item) => item.batchId === plan.batchId ? nextPlan : item);
    candidate2.generation = current.generation + 1;
    return commitMonitorEnvelopeV1({ world: current.world, currentEnvelope: current, candidateEnvelope: candidate2, expectedGeneration: current.generation, storage: options.storage, beforeCommit: options.beforeCommit });
  }
  function syncDeliveryAccounting(envelope) {
    const accounting = deliveryAccountingFor(envelope);
    accounting.recoverable = [].concat(
      envelope.pending || [],
      envelope.inFlight || [],
      envelope.failed || [],
      envelope.uncertain || []
    ).map((event) => cloneMonitorValue(event));
    envelope.metrics = Object.assign({}, envelope.metrics, { deliveryAccounting: accounting });
    return accounting;
  }
  function terminalDeliveryEntry(event, sequence, status) {
    return Object.assign({}, cloneMonitorValue(event), {
      stage: "acknowledged",
      terminalStatus: status,
      terminalSequence: sequence,
      sourceEventIds: [...new Set((event.sourceEventIds || []).map(String))]
    });
  }
  function deliveryRangeDigest(entries) {
    return checksumMonitorCanonicalValue(entries.map((entry) => ({
      terminalSequence: entry.terminalSequence,
      sourceEventIds: entry.sourceEventIds || [],
      addedAttackCount: entry.addedAttackCount || 0,
      addedRaidCount: entry.addedRaidCount || 0
    })));
  }
  function compactDeliveryAccountingV1(envelope, options = {}) {
    const base = createMonitorEnvelopeV1(envelope && envelope.world, envelope || {});
    const accounting = syncDeliveryAccounting(base);
    const terminal = accounting.terminal.slice().sort((left, right) => left.terminalSequence - right.terminalSequence);
    const limit = Math.max(0, terminal.length - 512);
    if (limit === 0 && !accounting.compactionClaim) return { outcome: "nothing-to-compact", envelope: base };
    const first = terminal[0];
    const last = terminal[limit - 1];
    const claim = accounting.compactionClaim || {
      operationId: String(options.operationId || `compact-${Date.now()}`),
      ownerId: String(options.ownerId || ""),
      leaseTerm: options.leaseTerm,
      expectedGeneration: base.generation,
      fromTerminalSequence: first ? first.terminalSequence : 0,
      toTerminalSequence: last ? last.terminalSequence : 0,
      rangeDigest: deliveryRangeDigest(terminal.slice(0, limit)),
      status: "prepared"
    };
    if (!accounting.compactionClaim || options.phase === "prepare") {
      accounting.compactionClaim = claim;
      base.generation += 1;
      base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base));
      return { outcome: "prepared", envelope: base, claim };
    }
    if (claim.expectedGeneration !== base.generation - 1 || claim.status !== "prepared") return { outcome: "stale-claim", envelope: base };
    const range = terminal.filter((entry) => entry.terminalSequence >= claim.fromTerminalSequence && entry.terminalSequence <= claim.toTerminalSequence);
    if (deliveryRangeDigest(range) !== claim.rangeDigest || range.length === 0) return { outcome: "stale-claim", envelope: base };
    const totals = {
      from: claim.fromTerminalSequence,
      to: claim.toTerminalSequence,
      count: range.length,
      attackDelta: range.reduce((sum, entry) => sum + (Number(entry.addedAttackCount) || 0), 0),
      raidDelta: range.reduce((sum, entry) => sum + (Number(entry.addedRaidCount) || 0), 0),
      sourceEventIds: range.flatMap((entry) => entry.sourceEventIds || [])
    };
    accounting.compactedTerminalTotals = accounting.compactedTerminalTotals.concat(totals);
    accounting.terminal = terminal.filter((entry) => entry.terminalSequence > claim.toTerminalSequence);
    accounting.compactedThroughTerminalSequence = Math.max(accounting.compactedThroughTerminalSequence || 0, claim.toTerminalSequence);
    accounting.compactionClaim = null;
    accounting.lastCompaction = { operationId: claim.operationId, from: claim.fromTerminalSequence, to: claim.toTerminalSequence };
    base.generation += 1;
    base.integrity = checksumMonitorCanonicalValue(monitorEnvelopeWithoutIntegrity(base));
    return { outcome: "compacted", envelope: base, totals };
  }
  const prepareTerminalCompactionV1 = (envelope, options) => compactDeliveryAccountingV1(envelope, Object.assign({}, options, { phase: "prepare" }));
  const resumeTerminalCompactionV1 = compactDeliveryAccountingV1;
  function monitorWorldLegacyValue(legacy, name, world) {
    if (!legacy || typeof legacy !== "object") {
      return void 0;
    }
    const value = legacy[name];
    if (value && typeof value === "object" && value[normalizeHostname(world)] !== void 0) {
      return value[normalizeHostname(world)];
    }
    return value;
  }
  const LEGACY_CANONICAL_EVENT_FIELDS = Object.freeze([
    "name",
    "url",
    "attackCount",
    "raidCount",
    "oldAttackCount",
    "oldRaidCount",
    "addedAttackCount",
    "addedRaidCount",
    "eventType",
    "observedAtMs",
    "queuedAtMs",
    "attemptCount",
    "responseClass"
  ]);
  function legacySafeString(value) {
    return typeof value === "string" ? value : "";
  }
  function legacySafeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function legacySafeTime(value) {
    return Number.isSafeInteger(value) ? value : null;
  }
  function canonicalLegacyEventFields(event) {
    const input = isPlainMonitorObject(event) ? event : {};
    return {
      name: legacySafeString(input.name),
      url: legacySafeString(input.url),
      attackCount: legacySafeCount(input.attackCount),
      raidCount: legacySafeCount(input.raidCount),
      oldAttackCount: legacySafeCount(input.oldAttackCount),
      oldRaidCount: legacySafeCount(input.oldRaidCount),
      addedAttackCount: legacySafeCount(input.addedAttackCount),
      addedRaidCount: legacySafeCount(input.addedRaidCount),
      eventType: legacySafeString(input.eventType || "attack"),
      observedAtMs: legacySafeTime(input.observedAtMs),
      queuedAtMs: legacySafeTime(input.queuedAtMs),
      attemptCount: legacySafeCount(input.attemptCount),
      responseClass: input.responseClass === null || typeof input.responseClass === "string" ? input.responseClass : null
    };
  }
  function legacyLengthPrefixed(parts) {
    const bytes = parts.map((part) => sourceUtf8(part));
    const output = [];
    for (const value of bytes) {
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, value.length);
      output.push(length, value);
    }
    const result = new Uint8Array(output.reduce((sum, item) => sum + item.length, 0));
    let offset = 0;
    for (const item of output) {
      result.set(item, offset);
      offset += item.length;
    }
    return result;
  }
  function legacyDecodeParts(payload, count) {
    if (typeof payload !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw new Error("malformed legacy identity");
    let bytes;
    try {
      bytes = sourceDecodeBase64Url(payload);
    } catch (error) {
      throw new Error("malformed legacy identity");
    }
    if (sourceBase64Url(bytes) !== payload) throw new Error("noncanonical legacy identity");
    const parts = [];
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      if (offset + 4 > bytes.length) throw new Error("malformed legacy identity");
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      offset += 4;
      if (offset + length > bytes.length) throw new Error("malformed legacy identity");
      try {
        parts.push(sourceUtf8Text(bytes.subarray(offset, offset + length)));
      } catch (error) {
        throw new Error("malformed legacy identity");
      }
      offset += length;
    }
    if (offset !== bytes.length) throw new Error("non-round-tripping legacy identity");
    return parts;
  }
  function canonicalLegacyIdentityFields(fields) {
    const canonical = canonicalLegacyEventFields(fields);
    if (JSON.stringify(Object.keys(fields || {})) !== JSON.stringify(LEGACY_CANONICAL_EVENT_FIELDS)) throw new Error("malformed canonical fields");
    if (JSON.stringify(fields) !== JSON.stringify(canonical)) throw new Error("malformed canonical fields");
    return canonical;
  }
  function canonicalizeLegacyActiveEvent(event, options = {}) {
    const input = isPlainMonitorObject(event) ? event : {};
    const world = normalizeHostname(options.world || input.world || "");
    const sourceStore = legacySafeString(options.sourceStore || "legacy");
    const originalIndex = Number.isSafeInteger(options.originalIndex) && options.originalIndex >= 0 ? options.originalIndex : 0;
    const legacyEventIdOrEmpty = typeof options.legacyEventId === "string" ? options.legacyEventId : typeof input.eventId === "string" ? input.eventId : "";
    if (input.canonicalEventFields !== void 0) canonicalLegacyIdentityFields(input.canonicalEventFields);
    const canonicalEventFields = canonicalLegacyEventFields(input);
    const tuple = { world, sourceStore, originalIndex, legacyEventIdOrEmpty, canonicalEventFields };
    const payload = sourceBase64Url(legacyLengthPrefixed([
      world,
      sourceStore,
      String(originalIndex),
      legacyEventIdOrEmpty,
      JSON.stringify(canonicalEventFields)
    ]));
    const eventId = `ls1:${payload}`;
    return Object.assign({}, input, canonicalEventFields, {
      world,
      eventId,
      rawEventId: legacyEventIdOrEmpty || null,
      canonicalEventFields,
      legacyIdentity: tuple,
      playerId: monitorEventPlayerId(input),
      deliveryState: input.deliveryState
    });
  }
  function decodeLegacyIdentity(identity) {
    if (typeof identity !== "string") throw new Error("malformed legacy identity");
    const prefix = identity.slice(0, 4);
    if (prefix !== "ls1:" && prefix !== "lh1:") throw new Error("malformed legacy identity");
    const parts = legacyDecodeParts(identity.slice(4), prefix === "ls1:" ? 5 : 3);
    const fields = JSON.parse(parts[prefix === "ls1:" ? 4 : 2]);
    canonicalLegacyIdentityFields(fields);
    if (prefix === "ls1:") {
      const tuple2 = { world: parts[0], sourceStore: parts[1], originalIndex: Number(parts[2]), legacyEventIdOrEmpty: parts[3], canonicalEventFields: fields };
      if (!Number.isSafeInteger(tuple2.originalIndex) || `ls1:${sourceBase64Url(legacyLengthPrefixed([parts[0], parts[1], parts[2], parts[3], parts[4]]))}` !== identity) throw new Error("non-round-tripping legacy identity");
      return tuple2;
    }
    const tuple = { world: parts[0], historyIndex: Number(parts[1]), canonicalHistoryFields: fields };
    if (!Number.isSafeInteger(tuple.historyIndex) || `lh1:${sourceBase64Url(legacyLengthPrefixed([parts[0], parts[1], parts[2]]))}` !== identity) throw new Error("non-round-tripping legacy identity");
    return tuple;
  }
  function canonicalizeLegacyHistoryRecord(event, world, historyIndex) {
    const canonicalHistoryFields = canonicalLegacyEventFields(event);
    const fieldsJson = JSON.stringify(canonicalHistoryFields);
    const recordIdentity = `lh1:${sourceBase64Url(legacyLengthPrefixed([normalizeHostname(world), String(historyIndex), fieldsJson]))}`;
    return Object.assign({}, canonicalHistoryFields, { world: normalizeHostname(world), recordIdentity, canonicalHistoryFields, deliveryState: "unknown-legacy" });
  }
  function monitorLegacyEvents(legacy, name, world) {
    const value = monitorWorldLegacyValue(legacy, name, world);
    const events = Array.isArray(value) ? value : value && Array.isArray(value.events) ? value.events : [];
    const createdAt = value && Number.isFinite(value.createdAt) ? value.createdAt : null;
    return events.map((event, originalIndex) => {
      const normalized = Object.assign({}, event, {
        world: normalizeHostname(world),
        playerId: monitorEventPlayerId(event)
      });
      if (!Number.isFinite(normalized.observedAtMs) && Number.isFinite(createdAt)) {
        normalized.observedAtMs = createdAt;
        normalized.approximateObserved = true;
      }
      const canonical = canonicalizeLegacyActiveEvent(normalized, {
        world,
        sourceStore: name,
        originalIndex,
        legacyEventId: typeof event.eventId === "string" ? event.eventId : ""
      });
      return createMonitorQueueEvent(canonical, {
        world: normalizeHostname(world),
        playerId: normalized.playerId,
        observedAtMs: normalized.observedAtMs,
        queuedAtMs: Number.isFinite(createdAt) ? createdAt : void 0
      });
    });
  }
  function monitorLegacyHistory(legacy, name, world) {
    const value = monitorWorldLegacyValue(legacy, name, world);
    const events = Array.isArray(value) ? value : value && Array.isArray(value.events) ? value.events : [];
    return events.map((event, index) => canonicalizeLegacyHistoryRecord(event, world, index));
  }
  function planMonitorLegacyMigration(legacy, snapshot, world) {
    const members = snapshot && snapshot.status === "authoritative" ? snapshot.membersById || {} : {};
    const attackState = legacy && (legacy.attackState || legacy.baseline || legacy.state) ? legacy.attackState || legacy.baseline || legacy.state : legacy;
    const source = isPlainMonitorObject(attackState) ? attackState : {};
    const byName = /* @__PURE__ */ new Map();
    for (const [id, member] of Object.entries(members)) {
      const key = String(member.name || "").trim().toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, []);
      }
      byName.get(key).push(id);
    }
    const carriedById = {};
    let migrationAmbiguities = 0;
    for (const key of Object.keys(source).sort()) {
      if (key === "filterVersion") {
        continue;
      }
      const record = source[key];
      if (!isPlainMonitorObject(record)) {
        continue;
      }
      const directId = record.id && members[String(record.id)] ? String(record.id) : members[key] ? key : null;
      const candidates = directId ? [directId] : byName.get(String(key).trim().toLowerCase()) || [];
      if (candidates.length !== 1) {
        migrationAmbiguities += 1;
        continue;
      }
      const id = candidates[0];
      carriedById[id] = {
        name: members[id].name,
        url: members[id].url,
        attackCount: Number.isFinite(record.attackCount) ? record.attackCount : 0,
        raidCount: Number.isFinite(record.raidCount) ? record.raidCount : 0
      };
    }
    const baselineByPlayerId = {};
    for (const [id, member] of Object.entries(members)) {
      baselineByPlayerId[id] = carriedById[id] || Object.assign({}, member);
    }
    const sources = [];
    for (const name of ["attackState", "roster", "pending", "inFlight", "failed"]) {
      if (legacy && legacy[name] !== void 0) {
        sources.push(name);
      }
    }
    const pending = monitorLegacyEvents(legacy, "pending", world);
    const inFlight = monitorLegacyEvents(legacy, "inFlight", world);
    const failed = monitorLegacyEvents(legacy, "failed", world);
    const uncertain = monitorLegacyEvents(legacy, "uncertain", world);
    const removed = monitorLegacyEvents(legacy, "removed", world).map((event) => Object.assign({}, event, {
      deliveryState: "uncertain-legacy-settlement",
      responseClass: "uncertain-legacy-settlement"
    }));
    const history = ["history", "terminal"].flatMap((name) => monitorLegacyHistory(legacy, name, world));
    return {
      baselineByPlayerId,
      rosterByPlayerId: snapshot && snapshot.membersById ? Object.fromEntries(Object.entries(snapshot.membersById).map(([id, member]) => [
        id,
        { name: member.name, url: member.url }
      ])) : {},
      pending,
      inFlight,
      failed,
      uncertain: uncertain.concat(removed),
      history,
      migrationAmbiguities,
      migrationSources: sources.sort(),
      events: [],
      alerts: []
    };
  }
  function migrateLegacyMonitorStateV1(options = {}) {
    const world = normalizeHostname(options.world || "");
    const existing = options.existingEnvelope;
    if (existing && existing.migration && existing.migration.completedAtMs !== null && existing.migration.completedAtMs !== void 0) {
      return {
        outcome: "already-complete",
        envelope: cloneMonitorValue(existing),
        events: [],
        alerts: []
      };
    }
    const plan = planMonitorLegacyMigration(
      options.legacy || {},
      options.snapshot,
      world
    );
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const envelope = createMonitorEnvelopeV1(world, {
      generation: existing && Number.isInteger(existing.generation) ? existing.generation + 1 : 1,
      migration: {
        completedAtMs: nowMs,
        sources: plan.migrationSources
      },
      baselineByPlayerId: plan.baselineByPlayerId,
      rosterByPlayerId: plan.rosterByPlayerId,
      pending: plan.pending,
      inFlight: plan.inFlight,
      failed: plan.failed,
      uncertain: plan.uncertain,
      diagnostics: {
        migrationAmbiguities: plan.migrationAmbiguities,
        lastCorruption: null,
        blockedQueueAtMs: null
      }
    });
    return {
      outcome: "migrated",
      envelope,
      events: [],
      alerts: []
    };
  }
  function loadOrMigrateMonitorEnvelopeV1(world, snapshot, options = {}) {
    const loaded = loadMonitorEnvelopeV1(world, options);
    if (loaded.envelope) {
      return loaded;
    }
    if (loaded.blocked) {
      return loaded;
    }
    const hostname = normalizeHostname(world);
    const legacy = options.legacy || {
      attackState: typeof localStorage === "undefined" ? {} : loadState(),
      pending: typeof localStorage === "undefined" ? {} : loadPendingBatch(),
      inFlight: typeof localStorage === "undefined" ? {} : loadInFlightBatch(),
      failed: typeof localStorage === "undefined" ? {} : loadFailedBatch()
    };
    const migration = migrateLegacyMonitorStateV1({
      world: hostname,
      snapshot,
      legacy,
      nowMs: options.nowMs
    });
    if (typeof options.beforeCommit === "function" && options.beforeCommit() !== true) {
      return {
        outcome: "fenced-reject",
        blocked: true,
        commit: { outcome: "fenced-reject", memorySwapped: false }
      };
    }
    const committed = commitMonitorEnvelopeV1({
      world: hostname,
      candidateEnvelope: migration.envelope,
      expectedGeneration: -1,
      storage: options.storage,
      nowMs: options.nowMs
    });
    return committed.outcome === "ok" ? Object.assign({}, migration, {
      outcome: "migrated",
      commit: committed
    }) : Object.assign({}, migration, {
      outcome: "failed-migration",
      commit: committed,
      blocked: true
    });
  }
  function planAcceptedScanTransition(snapshot, previousBaseline, muteSet, threshold, generation, fence, queue = {}) {
    if (!snapshot || snapshot.status !== "authoritative" || !isPlainMonitorObject(snapshot.membersById)) {
      return { outcome: "invalid-snapshot", baselineByPlayerId: {}, detections: [], eligibleEvents: [] };
    }
    const previous = isPlainMonitorObject(previousBaseline) ? previousBaseline : {};
    const members = snapshot.membersById;
    const muted = muteSet instanceof Set ? muteSet : new Set(Array.isArray(muteSet) ? muteSet.map(String) : []);
    const attackLimit = threshold && typeof threshold === "object" && Number.isFinite(threshold.attackThreshold) && threshold.attackThreshold > 0 ? threshold.attackThreshold : Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
    const raidLimit = threshold && typeof threshold === "object" && Number.isFinite(threshold.raidThreshold) && threshold.raidThreshold > 0 ? threshold.raidThreshold : Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
    const world = normalizeHostname(queue.world || snapshot.world || "");
    const scanSequence = Number.isInteger(queue.scanSequence) ? queue.scanSequence : 0;
    const nextGeneration = Number.isInteger(generation) ? generation + 1 : 1;
    const baselineByPlayerId = {};
    const detections = [];
    const eligibleEvents = [];
    const sourceIds = [];
    const sourceTuples = [];
    const addSources = (playerId, eventType, count) => {
      const ids = [];
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const tuple = {
          world,
          playerId: String(playerId),
          eventType,
          acceptedGeneration: nextGeneration,
          scanSequence,
          attackDelta: eventType === "attack" ? ordinal : 0,
          raidDelta: eventType === "raid" ? ordinal : 0
        };
        const identity = sourceEventTuple(tuple);
        const id = identity.sourceEventId;
        ids.push(id);
        sourceTuples.push(identity);
        sourceIds.push(id);
      }
      return ids;
    };
    for (const [playerId, member] of Object.entries(members)) {
      const current = Object.assign({}, member);
      baselineByPlayerId[playerId] = current;
      const old = previous[playerId] || {};
      const addedAttackCount = Math.max(0, (Number(member.attackCount) || 0) - (Number(old.attackCount) || 0));
      const addedRaidCount = Math.max(0, (Number(member.raidCount) || 0) - (Number(old.raidCount) || 0));
      if (addedAttackCount === 0 && addedRaidCount === 0) continue;
      const eventType = addedAttackCount > 0 && addedRaidCount > 0 ? "mixed" : addedAttackCount > 0 ? "attack" : "raid";
      const ids = addSources(playerId, "attack", addedAttackCount).concat(addSources(playerId, "raid", addedRaidCount));
      const thresholdPass = eventType === "attack" ? addedAttackCount >= attackLimit : eventType === "raid" ? addedRaidCount >= raidLimit : addedAttackCount >= attackLimit || addedRaidCount >= raidLimit;
      const disposition = muted.has(String(playerId)) ? "muted" : thresholdPass ? "eligible" : "threshold-blocked";
      const detection = Object.assign({}, current, {
        playerId: String(playerId),
        oldAttackCount: Number(old.attackCount) || 0,
        oldRaidCount: Number(old.raidCount) || 0,
        addedAttackCount,
        addedRaidCount,
        eventType,
        sourceEventIds: ids,
        disposition
      });
      detections.push(detection);
      if (disposition === "eligible") {
        eligibleEvents.push(createMonitorQueueEvent(detection, {
          world,
          playerId,
          observedAtMs: snapshot.observedAtMs,
          queuedAtMs: snapshot.observedAtMs
        }));
        eligibleEvents[eligibleEvents.length - 1].sourceEventIds = ids;
        eligibleEvents[eligibleEvents.length - 1].sourceEventTuples = ids.map((id) => sourceEventTuple(decodeSourceEventId(id)));
      }
    }
    return { outcome: "ok", world, generation: nextGeneration, ownerId: fence && fence.ownerId, term: fence && fence.term, baselineByPlayerId, detections, eligibleEvents, sourceIds, sourceTuples };
  }
  function commitMonitorEnvelope(options = {}) {
    const current = options.currentEnvelope;
    const transition = options.transition;
    if (!current || !transition || transition.outcome !== "ok") return { outcome: "invalid-transition", memorySwapped: false };
    const ownerId = options.ownerId === void 0 ? transition.ownerId : options.ownerId;
    const term = options.term === void 0 ? transition.term : options.term;
    const expectedGeneration = Number.isInteger(options.expectedGeneration) ? options.expectedGeneration : current.generation;
    const fence = () => {
      const actual = typeof options.currentFence === "function" ? options.currentFence() : { ownerId, term, generation: expectedGeneration };
      return isLeaseFenceValid(actual, { ownerId, term, generation: expectedGeneration });
    };
    if (typeof options.beforeCommit === "function" && options.beforeCommit() !== true) return { outcome: "fenced-reject", memorySwapped: false };
    const fenced = ownerId !== null && ownerId !== void 0 && term !== null && term !== void 0;
    if (fenced && !fence()) return { outcome: "fenced-reject", memorySwapped: false };
    const pending = Array.isArray(current.pending) ? current.pending.concat(transition.eligibleEvents || []) : transition.eligibleEvents || [];
    const allQueues = pending.concat(current.inFlight || [], current.failed || [], current.uncertain || []);
    const capacity = Number.isInteger(options.queueCapacity) ? options.queueCapacity : MONITOR_MAX_PENDING_RECORDS;
    const queuedSourceIds = allQueues.flatMap((event) => event.sourceEventIds || []);
    const sourceCapacity = Number.isInteger(options.activeSourceCapacity) ? options.activeSourceCapacity : Number.POSITIVE_INFINITY;
    if (allQueues.length > capacity || queuedSourceIds.length > sourceCapacity || new Set(queuedSourceIds).size !== queuedSourceIds.length) return { outcome: "capacity-reject", memorySwapped: false };
    const candidate2 = createMonitorEnvelopeV1(current.world, Object.assign({}, current, {
      generation: expectedGeneration + 1,
      baselineByPlayerId: transition.baselineByPlayerId,
      rosterByPlayerId: transition.rosterByPlayerId || current.rosterByPlayerId,
      pending,
      metrics: Object.assign({}, current.metrics, transition.metrics || {}, { lastCommitAtMs: Date.now(), lastError: null })
    }));
    const serializedCandidate = serializeMonitorEnvelopeV1(candidate2);
    const serializedCapacity = Number.isInteger(options.serializedEnvelopeCapacity) ? options.serializedEnvelopeCapacity : Number.POSITIVE_INFINITY;
    if (serializedCandidate.length > serializedCapacity) return { outcome: "capacity-reject", memorySwapped: false };
    const result = commitMonitorEnvelopeV1({
      world: current.world,
      currentEnvelope: current,
      candidateEnvelope: candidate2,
      expectedGeneration,
      storage: options.storage,
      beforeCommit: () => (typeof options.beforeCommit !== "function" || options.beforeCommit() === true) && (!fenced || fence())
    });
    if (result.outcome !== "ok" || fenced && !fence()) {
      if (result.outcome === "ok" && fenced) {
        const storage = monitorStorageAdapter(options.storage);
        monitorRestoreRaw(storage, monitorActiveStorageKey(current.world), serializeMonitorEnvelopeV1(current));
        monitorRestoreRaw(storage, monitorBackupStorageKey(current.world), serializeMonitorEnvelopeV1(current));
        return { outcome: "fenced-reject", memorySwapped: false };
      }
      return result;
    }
    return result;
  }
  function commitMonitorEnvelopeV1(options = {}) {
    const storage = monitorStorageAdapter(options.storage);
    const current = options.currentEnvelope && parseMonitorEnvelopeV1(options.currentEnvelope, options.world).ok ? parseMonitorEnvelopeV1(options.currentEnvelope, options.world).envelope : null;
    const candidateParsed = parseMonitorEnvelopeV1(
      options.candidateEnvelope,
      options.world
    );
    if (!candidateParsed.ok) {
      return { outcome: "corrupt-active", memorySwapped: false };
    }
    const candidate2 = candidateParsed.envelope;
    const expectedGeneration = current ? current.generation : Number.isInteger(options.expectedGeneration) ? options.expectedGeneration : -1;
    if (!isMonitorGenerationFenced(expectedGeneration, candidate2.generation)) {
      return { outcome: "fenced-reject", memorySwapped: false };
    }
    const coalesced = coalesceMonitorPendingEvents(
      candidate2.pending,
      MONITOR_MAX_PENDING_RECORDS,
      options.nowMs
    );
    if (!coalesced.ok) {
      return Object.assign({}, coalesced, {
        envelope: current,
        memorySwapped: false
      });
    }
    candidate2.pending = coalesced.events;
    const activeKey = monitorActiveStorageKey(candidate2.world);
    const backupKey = monitorBackupStorageKey(candidate2.world);
    const oldActiveRead = monitorReadRaw(storage, activeKey);
    const oldBackupRead = monitorReadRaw(storage, backupKey);
    const oldActive = oldActiveRead.ok ? oldActiveRead.value : void 0;
    const oldBackup = oldBackupRead.ok ? oldBackupRead.value : void 0;
    const previous = current || (oldActive === void 0 ? null : parseMonitorEnvelopeV1(oldActive, candidate2.world).envelope);
    const backupPayload = previous ? serializeMonitorEnvelopeV1(previous) : serializeMonitorEnvelopeV1(candidate2);
    const activePayload = serializeMonitorEnvelopeV1(candidate2);
    if (typeof options.beforeCommit === "function" && options.beforeCommit() !== true) {
      return { outcome: "fenced-reject", memorySwapped: false };
    }
    const backupResult = monitorWriteReadback(storage, backupKey, backupPayload);
    if (!backupResult.ok) {
      monitorRestoreRaw(storage, backupKey, oldBackup);
      return { outcome: backupResult.outcome, memorySwapped: false };
    }
    if (typeof options.beforeCommit === "function" && options.beforeCommit() !== true) {
      monitorRestoreRaw(storage, backupKey, oldBackup);
      return { outcome: "fenced-reject", memorySwapped: false };
    }
    const activeResult = monitorWriteReadback(storage, activeKey, activePayload);
    if (!activeResult.ok) {
      monitorRestoreRaw(storage, backupKey, oldBackup);
      monitorRestoreRaw(storage, activeKey, oldActive);
      return { outcome: activeResult.outcome, memorySwapped: false };
    }
    const committed = cloneMonitorValue(candidate2);
    committed.integrity = parseMonitorEnvelopeV1(
      activePayload,
      candidate2.world
    ).envelope.integrity;
    return {
      outcome: "ok",
      envelope: committed,
      memorySwapped: true,
      generation: committed.generation
    };
  }
  function applyMonitorQueueTransitionV1(envelope, transition) {
    const base = createMonitorEnvelopeV1(
      envelope && envelope.world,
      envelope || {}
    );
    const input = transition && typeof transition === "object" ? transition : {};
    const type = input.type;
    const ids = new Set(Array.isArray(input.eventIds) ? input.eventIds : []);
    const copyEvents = (value) => Array.isArray(value) ? value.slice() : [];
    if (type === "enqueue") {
      const coalesced = coalesceMonitorPendingEvents(
        base.pending.concat(Array.isArray(input.events) ? input.events : []),
        MONITOR_MAX_PENDING_RECORDS,
        input.atMs
      );
      if (!coalesced.ok) {
        return Object.assign({}, coalesced, { envelope: base });
      }
      base.pending = coalesced.events;
    } else if (type === "pending-to-inFlight") {
      const inFlight = copyEvents(base.inFlight);
      if (inFlight.length + base.pending.length > MONITOR_MAX_PENDING_RECORDS) {
        return {
          outcome: "bound-exceeded",
          envelope: base
        };
      }
      base.inFlight = inFlight.concat(base.pending);
      base.pending = [];
    } else if (type === "dispatch-start") {
      const dispatchedAtMs = Number.isFinite(input.atMs) ? input.atMs : Date.now();
      base.inFlight = base.inFlight.map(
        (event) => ids.size === 0 || ids.has(event.eventId) ? Object.assign({}, event, { dispatchedAtMs }) : event
      );
    } else if (type === "retry-attempt") {
      const attemptCount = Number.isInteger(input.attemptCount) && input.attemptCount >= 0 ? input.attemptCount : 0;
      base.inFlight = base.inFlight.map(
        (event) => ids.size === 0 || ids.has(event.eventId) ? Object.assign({}, event, { attemptCount }) : event
      );
    } else if (type === "acknowledge") {
      const accounting = deliveryAccountingFor(base);
      let nextSequence = Number.isSafeInteger(accounting.nextTerminalSequence) ? accounting.nextTerminalSequence : 1;
      base.inFlight = base.inFlight.filter(
        (event) => !ids.has(event.eventId)
      );
      for (const event of envelope.inFlight || []) {
        if (ids.size === 0 || ids.has(event.eventId)) {
          accounting.terminal.push(terminalDeliveryEntry(event, nextSequence, "acknowledged"));
          nextSequence += 1;
        }
      }
      accounting.nextTerminalSequence = nextSequence;
    } else if (type === "retry") {
      base.pending = base.pending.concat(
        base.inFlight.filter((event) => ids.size === 0 || ids.has(event.eventId)),
        base.uncertain.filter((event) => ids.size === 0 || ids.has(event.eventId))
      );
      base.inFlight = base.inFlight.filter(
        (event) => ids.size > 0 && !ids.has(event.eventId)
      );
      base.uncertain = base.uncertain.filter(
        (event) => ids.size > 0 && !ids.has(event.eventId)
      );
    } else if (type === "acknowledge-uncertain") {
      const accounting = deliveryAccountingFor(base);
      let nextSequence = Number.isSafeInteger(accounting.nextTerminalSequence) ? accounting.nextTerminalSequence : 1;
      for (const event of envelope.uncertain || []) {
        if (ids.size === 0 || ids.has(event.eventId)) {
          accounting.terminal.push(terminalDeliveryEntry(event, nextSequence, "manual-delivered"));
          nextSequence += 1;
        }
      }
      base.uncertain = base.uncertain.filter(
        (event) => !ids.has(event.eventId)
      );
      accounting.nextTerminalSequence = nextSequence;
    } else if (type === "failed" || type === "uncertain") {
      const selected = base.inFlight.filter(
        (event) => ids.size === 0 || ids.has(event.eventId)
      ).map((event) => type === "uncertain" ? Object.assign({}, event, {
        responseClass: String(input.responseClass || "unknown")
      }) : event);
      base[type] = copyEvents(base[type]).concat(selected);
      base.inFlight = base.inFlight.filter(
        (event) => ids.size > 0 && !ids.has(event.eventId)
      );
    } else if (type === "requeue-failed") {
      base.pending = base.pending.concat(base.failed);
      base.failed = [];
    } else {
      return { outcome: "invalid-transition", envelope };
    }
    syncDeliveryAccounting(base);
    base.generation += 1;
    base.integrity = checksumMonitorCanonicalValue(
      monitorEnvelopeWithoutIntegrity(base)
    );
    return { outcome: "ok", envelope: base };
  }
  function commitMonitorQueueTransitionV1(options = {}) {
    const transition = applyMonitorQueueTransitionV1(
      options.currentEnvelope,
      options.transition
    );
    if (transition.outcome !== "ok") {
      return Object.assign({}, transition, { memorySwapped: false });
    }
    return commitMonitorEnvelopeV1({
      world: options.world || transition.envelope.world,
      currentEnvelope: options.currentEnvelope,
      candidateEnvelope: transition.envelope,
      expectedGeneration: options.expectedGeneration,
      storage: options.storage,
      nowMs: options.nowMs,
      beforeCommit: options.beforeCommit
    });
  }
  function getTooltipSources(icon) {
    const values = [
      icon.getAttribute("alt"),
      icon.getAttribute("title"),
      icon.getAttribute("aria-label"),
      icon.getAttribute("data-tooltip"),
      icon.getAttribute("data-title"),
      icon.getAttribute("data-original-title"),
      icon.parentElement?.getAttribute("alt"),
      icon.parentElement?.getAttribute("title"),
      icon.parentElement?.getAttribute("aria-label"),
      icon.parentElement?.getAttribute("data-tooltip")
    ];
    return values.filter((value) => typeof value === "string").map((value) => cleanText(value)).filter(Boolean);
  }
  const MEMBER_TABLE_REASON_CODES = Object.freeze([
    "no-member-table",
    "multiple-member-tables",
    "pagination-or-filter",
    "missing-player-id",
    "duplicate-player-id",
    "conflicting-tooltip",
    "malformed-count"
  ]);
  function selectMemberTable(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") {
      return { status: "rejected", reason: "no-member-table", table: null };
    }
    const tables = [...doc.querySelectorAll("table")].filter((table2) => /(?:^|\s)allianceMembers(?:\s|$)/i.test(
      String(table2.className || "")
    ));
    if (tables.length === 0) {
      return { status: "rejected", reason: "no-member-table", table: null };
    }
    if (tables.length > 1) {
      return { status: "rejected", reason: "multiple-member-tables", table: null };
    }
    const table = tables[0];
    if (tableSignalsPartial(table)) {
      return { status: "rejected", reason: "pagination-or-filter", table: null };
    }
    return { status: "accepted", reason: null, table };
  }
  function selectAuthoritativeMemberTable(doc) {
    const selection = selectMemberTable(doc);
    return selection.status === "accepted" ? selection.table : null;
  }
  function tableSignalsPartial(table) {
    if (!table) {
      return false;
    }
    const attributes = [
      "data-partial",
      "data-pagination",
      "data-filtered",
      "data-filter"
    ];
    const attributeSignal = attributes.some((name) => {
      const value = table.getAttribute(name);
      return value !== null && value !== "false";
    });
    const classSignal = /(?:^|\s)(?:partial|filtered|pagination)(?:\s|$)/i.test(String(table.className || ""));
    return attributeSignal || classSignal;
  }
  function reportSnapshotToTestHook(snapshot) {
    if (typeof window !== "undefined" && window.__TAA_TEST_HOOK__ && typeof window.__TAA_TEST_HOOK__.onSnapshot === "function") {
      window.__TAA_TEST_HOOK__.onSnapshot(snapshot);
    }
    return snapshot;
  }
  function extractAllianceSnapshotFromDocument(doc, observedAtMs, options = {}) {
    const selection = selectMemberTable(doc);
    const table = selection.table;
    if (selection.status !== "accepted" || !table) {
      return reportSnapshotToTestHook({
        status: "rejected",
        reason: selection.reason,
        observedAtMs,
        membersById: {},
        anomalies: {
          missingId: false,
          duplicateId: false,
          conflictingTooltip: false,
          malformedCount: false,
          paginationOrFilter: selection.reason === "pagination-or-filter"
        }
      });
    }
    const rows = [];
    const origin = doc.location && doc.location.origin ? doc.location.origin : typeof location !== "undefined" ? location.origin : "https://travian.invalid";
    for (const row of table.querySelectorAll("tr")) {
      const links = [...row.querySelectorAll("a")];
      const link = links.find((candidate2) => {
        const href2 = candidate2.getAttribute("href") || "";
        const text = cleanText(candidate2.textContent);
        return Boolean(
          text && !/^\d+[.]?$/.test(text) && extractPlayerId(href2) !== null
        );
      });
      const icons = [...row.querySelectorAll("img")].map((icon) => ({
        className: cleanText(icon.className),
        tooltipSources: getTooltipSources(icon),
        hasAttackClass: icon.classList.contains("attack")
      })).filter((icon) => icon.hasAttackClass);
      const hasHeaderCell = row.querySelectorAll("th").length > 0;
      const hasAnyLink = links.length > 0;
      if (!link && icons.length === 0 && hasHeaderCell) {
        continue;
      }
      if (!link && icons.length === 0 && !hasAnyLink) continue;
      const href = link ? link.getAttribute("href") || "" : "";
      let url = "";
      if (href) {
        try {
          url = new URL(href, origin).href;
        } catch {
          url = href;
        }
      }
      rows.push({
        id: link ? extractPlayerId(href) : null,
        name: link ? cleanText(link.textContent) : "",
        url,
        icons
      });
    }
    const snapshot = extractAllianceSnapshotFromRows(rows, Object.assign({}, options, {
      observedAtMs,
      paginationOrFilter: false
    }));
    const reason = snapshot.anomalies.missingId ? "missing-player-id" : snapshot.anomalies.duplicateId ? "duplicate-player-id" : snapshot.anomalies.conflictingTooltip ? "conflicting-tooltip" : snapshot.anomalies.malformedCount ? "malformed-count" : null;
    if (reason) {
      return reportSnapshotToTestHook({
        ...snapshot,
        status: "rejected",
        reason,
        membersById: {}
      });
    }
    return reportSnapshotToTestHook(snapshot);
  }
  function parseMemberSnapshot(doc, observedAtMs, options = {}) {
    return extractAllianceSnapshotFromDocument(doc, observedAtMs, options);
  }
  function extractMembersFromTable() {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
      return [];
    }
    const snapshot = parseMemberSnapshot(document, Date.now());
    if (snapshot.status !== "authoritative") return [];
    return Object.entries(snapshot.membersById).map(([id, member]) => ({
      id,
      name: member.name,
      url: member.url
    }));
    const LINK_SELECTOR = 'a[href*="/profile/"], a[href*="/player/"], a[href*="spieler.php"], a[href*="uid="]';
    const candidates = [...document.querySelectorAll("table")].filter((t) => t.querySelector(LINK_SELECTOR)).map((t) => ({ table: t, links: t.querySelectorAll(LINK_SELECTOR).length })).sort((a, b) => b.links - a.links);
    const table = candidates.length > 0 ? candidates[0].table : null;
    if (!table) {
      return [];
    }
    const byId = /* @__PURE__ */ new Map();
    for (const row of table.querySelectorAll("tr")) {
      const link = [...row.querySelectorAll("a")].find((candidate2) => {
        const href2 = candidate2.getAttribute("href") || "";
        const text = cleanText(candidate2.textContent);
        if (!text || /^\d+[.]?$/.test(text)) {
          return false;
        }
        return (href2.includes("/profile/") || href2.includes("/player/") || href2.includes("spieler.php") || href2.includes("uid=")) && !href2.includes("/alliance/");
      });
      if (!link) {
        continue;
      }
      const href = link.getAttribute("href") || "";
      const id = extractPlayerId(href);
      const name = cleanText(link.textContent);
      if (id === null || !name) {
        continue;
      }
      if (byId.has(id)) {
        continue;
      }
      byId.set(id, {
        id,
        name,
        url: new URL(href, location.origin).href
      });
    }
    return [...byId.values()];
  }
  function computeUnmappedPlayers(members, mappings, muted, hostname) {
    if (!Array.isArray(members)) {
      return [];
    }
    const result = members.filter((member) => {
      if (!member || typeof member !== "object" || typeof member.id !== "string") {
        return false;
      }
      const mapped = mappings && mappings[hostname] && Array.isArray(mappings[hostname][member.id]) && mappings[hostname][member.id].length > 0;
      const silenced = muted && muted[hostname] && muted[hostname][member.id] === true;
      return !mapped && !silenced;
    });
    const sorted = result.slice();
    sorted.sort((a, b) => {
      const an = String(a.name || "");
      const bn = String(b.name || "");
      if (typeof an.localeCompare === "function") {
        return an.localeCompare(bn, "pl");
      }
      const la = an.toLowerCase();
      const lb = bn.toLowerCase();
      if (la < lb) {
        return -1;
      }
      if (la > lb) {
        return 1;
      }
      return 0;
    });
    return sorted;
  }
  function getStoredAttackCount(state, key) {
    if (key === "filterVersion") {
      return 0;
    }
    const savedValue = state ? state[key] : void 0;
    if (savedValue && typeof savedValue === "object") {
      if (typeof savedValue.attackCount === "number") {
        return savedValue.attackCount;
      }
      return Number(savedValue.count) || 0;
    }
    return Number(savedValue) || 0;
  }
  function getStoredRaidCount(state, key) {
    if (key === "filterVersion") {
      return 0;
    }
    const savedValue = state ? state[key] : void 0;
    if (savedValue && typeof savedValue === "object") {
      return Number(savedValue.raidCount) || 0;
    }
    return 0;
  }
  function getStoredCount(state, key) {
    return getStoredAttackCount(state, key);
  }
  function attackWord(count) {
    return count === 1 ? "attack" : "attacks";
  }
  function raidWord(count) {
    return count === 1 ? "raid" : "raids";
  }
  function selectMentions(roleIds, userIds) {
    const rawRoles = Array.isArray(roleIds) ? roleIds : roleIds === null || roleIds === void 0 ? [] : [roleIds];
    const roles = [];
    const seenRoles = /* @__PURE__ */ new Set();
    for (const rawRole of rawRoles) {
      const role = validateDiscordRoleId(rawRole);
      if (role !== null && !seenRoles.has(role)) {
        seenRoles.add(role);
        roles.push(role);
      }
    }
    let length = roles.reduce(
      (total, role, index) => total + (index === 0 ? 0 : 1) + `<@&${role}>`.length,
      0
    );
    const selected = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of Array.isArray(userIds) ? userIds : []) {
      const valid = validateDiscordUserId(id);
      if (valid === null || seen.has(valid)) {
        continue;
      }
      const token = `<@${valid}>`;
      const nextLength = length === 0 ? token.length : length + 1 + token.length;
      if (nextLength > DISCORD_CONTENT_LIMIT) {
        break;
      }
      seen.add(valid);
      selected.push(valid);
      length = nextLength;
    }
    return Array.isArray(roleIds) ? { roleIds: roles, userIds: selected } : { roleId: roles[0] || null, userIds: selected };
  }
  function buildMentionContent(roleIds, userIds) {
    const selected = selectMentions(roleIds, userIds);
    const roles = Array.isArray(selected.roleIds) ? selected.roleIds : selected.roleId === null ? [] : [selected.roleId];
    const tokens = roles.map((role) => `<@&${role}>`);
    for (const id of selected.userIds) {
      tokens.push(`<@${id}>`);
    }
    return tokens.join(" ");
  }
  function buildAllowedMentions(roleIds, userIds) {
    const selected = selectMentions(roleIds, userIds);
    const mentions = { users: selected.userIds.slice() };
    const roles = Array.isArray(selected.roleIds) ? selected.roleIds : selected.roleId === null ? [] : [selected.roleId];
    if (roles.length > 0) {
      mentions.roles = roles.slice();
    }
    return mentions;
  }
  function resolveEventPriority(event, settings) {
    const explicit = event && typeof event.priority === "string" && (event.priority === "normal" || event.priority === "high" || event.priority === "critical") ? event.priority : null;
    return explicit || classifyPriority(event, settings);
  }
  function highestBatchPriority(events, settings) {
    const rank = {
      normal: 0,
      high: 1,
      critical: 2
    };
    let top = "normal";
    for (const event of Array.isArray(events) ? events : []) {
      const current = resolveEventPriority(event, settings);
      if (rank[current] > rank[top]) {
        top = current;
      }
    }
    return top;
  }
  function batchPriorityColor(events, settings) {
    return PRIORITY_COLORS[highestBatchPriority(events, settings)];
  }
  function priorityLabel(priority) {
    if (priority === "high") {
      return "High";
    }
    if (priority === "critical") {
      return "Critical";
    }
    return "Normal";
  }
  function safeAllianceUrl(allianceUrl, context) {
    const source = context && typeof context === "object" ? context : {};
    let trustedOrigin = null;
    if (typeof source.origin === "string" && source.origin !== "") {
      try {
        const parsedOrigin = new URL(source.origin);
        if (parsedOrigin.protocol === "https:" && parsedOrigin.pathname === "/" && parsedOrigin.search === "" && parsedOrigin.hash === "" && parsedOrigin.username === "" && parsedOrigin.password === "") {
          trustedOrigin = parsedOrigin.origin;
        }
      } catch (error) {
        trustedOrigin = null;
      }
    }
    if (trustedOrigin === null) {
      throw new TypeError("discord-alliance-url-unavailable");
    }
    const validate = (value) => {
      if (typeof value !== "string" || value === "") {
        return null;
      }
      try {
        const parsed = new URL(value, trustedOrigin);
        if (parsed.protocol !== "https:" || parsed.origin !== trustedOrigin || parsed.username !== "" || parsed.password !== "" || parsed.href.length > 2048) {
          return null;
        }
        return parsed.href;
      } catch (error) {
        return null;
      }
    };
    const candidate2 = validate(allianceUrl);
    if (candidate2 !== null) {
      return candidate2;
    }
    const fallback = validate(source.fallbackHref);
    if (fallback !== null) {
      return fallback;
    }
    throw new TypeError("discord-alliance-url-unavailable");
  }
  function compactDiscordEventClass(events) {
    const list = Array.isArray(events) ? events : [];
    const hasAttack = list.some(
      (event) => event && (event.eventType === "attack" || event.eventType === "mixed") || discordEventCount(event, "addedAttackCount") > 0
    );
    const hasRaid = list.some(
      (event) => event && (event.eventType === "raid" || event.eventType === "mixed") || discordEventCount(event, "addedRaidCount") > 0
    );
    return hasAttack ? "attack" : hasRaid ? "raid" : "roster";
  }
  function compactDiscordPlayerIdentity(event, sourceIndex) {
    const source = event && typeof event === "object" ? event : {};
    const candidates = [
      source.playerId,
      source.profileId,
      source.id,
      extractPlayerId(source.url)
    ];
    for (const candidate2 of candidates) {
      if (typeof candidate2 === "string" && candidate2.trim() !== "") {
        return candidate2.trim();
      }
      if (typeof candidate2 === "number" && Number.isSafeInteger(candidate2)) {
        return String(candidate2);
      }
    }
    return `source:${sourceIndex}`;
  }
  function compactDiscordSortedEntries(events) {
    return events.map((event, sourceIndex) => ({ event, sourceIndex })).sort((left, right) => {
      const rankDifference = discordEventSortRank(left.event) - discordEventSortRank(right.event);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      const attackDifference = discordEventCount(right.event, "addedAttackCount") - discordEventCount(left.event, "addedAttackCount");
      if (attackDifference !== 0) {
        return attackDifference;
      }
      const raidDifference = discordEventCount(right.event, "addedRaidCount") - discordEventCount(left.event, "addedRaidCount");
      if (raidDifference !== 0) {
        return raidDifference;
      }
       const leftName = String(left.event && left.event.name || "");
       const rightName = String(right.event && right.event.name || "");
       return leftName.localeCompare(rightName, "pl", { sensitivity: "base" }) || (leftName < rightName ? -1 : rightName < leftName ? 1 : 0) || left.sourceIndex - right.sourceIndex;
    });
  }
  function requireValidatedDiscordSettings(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Number.isInteger(settings.attackThreshold) || !Number.isInteger(settings.raidThreshold) || !Number.isInteger(settings.normalMax) || !Number.isInteger(settings.highMax) || settings.attackThreshold < 1 || settings.raidThreshold < 1 || settings.normalMax < 1 || settings.normalMax >= settings.highMax) {
      throw new TypeError("discord-settings-must-be-validated");
    }
    return settings;
  }
   function configuredDiscordPriority(event, settings) {
     return classifyPriority(event, requireValidatedDiscordSettings(settings));
  }
  function compactDiscordAggregate(events) {
    const aggregate = {
      addedAttackCount: 0,
      addedRaidCount: 0,
      attackCount: 0,
      raidCount: 0,
      changes: 0
    };
    for (const event of Array.isArray(events) ? events : []) {
      if (event && (event.eventType === "join" || event.eventType === "leave")) {
        aggregate.changes += 1;
        continue;
      }
      aggregate.addedAttackCount += discordEventCount(event, "addedAttackCount");
      aggregate.addedRaidCount += discordEventCount(event, "addedRaidCount");
      aggregate.attackCount += discordEventCount(event, "attackCount");
      aggregate.raidCount += discordEventCount(event, "raidCount");
    }
    return aggregate;
  }
  function buildCompactDiscordTitle(events, settings) {
    const list = Array.isArray(events) ? events : [];
    const validatedSettings = requireValidatedDiscordSettings(settings);
    const eventClass = compactDiscordEventClass(list);
    const prefix = eventClass === "attack" ? "🚨 Alliance attack" : eventClass === "raid" ? "🛡️ Alliance raid" : "🔄 Alliance changes";
    const uniquePlayers = new Set(
      list.map((event, index) => compactDiscordPlayerIdentity(event, index))
    ).size;
    return {
      text: `${prefix} · ${uniquePlayers} ${uniquePlayers === 1 ? "player" : "players"}`,
      eventClass,
      playerCount: uniquePlayers,
      color: PRIORITY_COLORS[highestConfiguredBatchPriority(list, validatedSettings)]
    };
  }
  function buildCompactDiscordPlayerLine(event, context, settings) {
    const source = event && typeof event === "object" ? event : {};
    const name = truncateText(
      cleanText(source.name) || "Unknown player",
      EVENT_NAME_MAX
    );
    const profileLink = buildProfileLink({
      name,
      url: source.url
    }, context);
    if (source.eventType === "join") {
      return `${profileLink} — joined the alliance`;
    }
    if (source.eventType === "leave") {
      return `${profileLink} — left the alliance`;
    }
    const priority = configuredDiscordPriority(
      source,
      requireValidatedDiscordSettings(settings)
    );
    const addedAttackCount = discordEventCount(source, "addedAttackCount");
    const addedRaidCount = discordEventCount(source, "addedRaidCount");
    const segments = [];
    if (addedAttackCount > 0) {
      segments.push(`**+${addedAttackCount} ${attackWord(addedAttackCount)}**`);
    }
    if (addedRaidCount > 0) {
      segments.push(`**+${addedRaidCount} ${raidWord(addedRaidCount)}**`);
    }
    const activeAttackCount = discordEventCount(source, "attackCount");
    const activeRaidCount = discordEventCount(source, "raidCount");
    const currentText = `Now: ${activeAttackCount} ${attackWord(activeAttackCount)} / ${activeRaidCount} ${raidWord(activeRaidCount)}`;
    const prioritySuffix = priority === "critical" ? " · Priority: Critical" : priority === "high" ? " · Priority: High" : "";
     const deltaText = segments.length > 0 ? ` — ${segments.join(" · ")}` : " — no new activity";
    return `${profileLink}${deltaText}
${currentText}${prioritySuffix}`;
  }
  function highestConfiguredBatchPriority(events, settings) {
    const rank = { normal: 0, high: 1, critical: 2 };
    let highest = "normal";
    for (const event of Array.isArray(events) ? events : []) {
      const current = configuredDiscordPriority(event, settings);
      if (rank[current] > rank[highest]) {
        highest = current;
      }
    }
    return highest;
  }
  function buildCompactDiscordSummaryFields(events, settings, observedText) {
    const list = Array.isArray(events) ? events : [];
    const validatedSettings = requireValidatedDiscordSettings(settings);
    const aggregate = compactDiscordAggregate(list);
    const eventClass = compactDiscordEventClass(list);
    const newSegments = [];
    if (eventClass === "roster") {
      const joined = list.filter((event) => event && event.eventType === "join").length;
      const left = list.filter((event) => event && event.eventType === "leave").length;
      if (joined > 0) newSegments.push(`**${joined} joined**`);
      if (left > 0) newSegments.push(`**${left} left**`);
    } else {
      if (aggregate.addedAttackCount > 0) {
        newSegments.push(`**+${aggregate.addedAttackCount} ${attackWord(aggregate.addedAttackCount)}**`);
      }
      if (aggregate.addedRaidCount > 0) {
        newSegments.push(`**+${aggregate.addedRaidCount} ${raidWord(aggregate.addedRaidCount)}**`);
      }
    }
    return [
      {
        name: "New",
        value: newSegments.length > 0 ? newSegments.join(" · ") : "No new activity",
        inline: true
      },
      {
        name: "Active now",
        value: eventClass === "roster" ? "—" : `${aggregate.attackCount} ${attackWord(aggregate.attackCount)} / ${aggregate.raidCount} ${raidWord(aggregate.raidCount)}`,
        inline: true
      },
      {
        name: "Priority",
        value: priorityLabel(highestConfiguredBatchPriority(list, validatedSettings)),
        inline: true
      }
    ];
  }
  function isValidDiscordTime(value) {
    return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
  }
  function buildCompactDiscordTiming(observedAtMs, dispatchedAtMs, approximateObserved = false) {
    const observedValid = isValidDiscordTime(observedAtMs);
    const dispatchedValid = isValidDiscordTime(dispatchedAtMs);
    const timing = {
      footer: { text: "Observation time unavailable" }
    };
    if (!dispatchedValid) {
      if (observedValid) {
        timing.footer.text = "Observation time unavailable";
      }
      return timing;
    }
    timing.timestamp = new Date(dispatchedAtMs).toISOString();
    if (!observedValid) {
      return timing;
    }
    if (observedAtMs > dispatchedAtMs) {
      return timing;
    }
    if (approximateObserved === true) {
      timing.footer.text = "Approximate observation";
      return timing;
    }
    const elapsedMs = dispatchedAtMs - observedAtMs;
    const elapsedSeconds = Math.floor(elapsedMs / 1e3);
     timing.footer.text = elapsedMs < 1e3 ? "Observed <1s before dispatch" : `Observed ${elapsedSeconds}s before dispatch`;
    return timing;
  }
  function normalizeDiscordWorldHostname(hostname) {
    if (typeof hostname !== "string" || hostname.trim() === "") {
      throw new TypeError("discord-world-hostname-required");
    }
    const normalized = normalizeHostname(hostname).replace(/[^a-z0-9.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (normalized === "") {
      throw new TypeError("discord-world-hostname-invalid");
    }
    return truncateText(normalized, 256);
  }
  function buildCompactDiscordPresentation(events, options) {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) {
      return null;
    }
    const source = options && typeof options === "object" ? options : {};
    const context = source.context && typeof source.context === "object" ? source.context : {};
    const settings = requireValidatedDiscordSettings(source.settings);
    const title = buildCompactDiscordTitle(list, settings);
    const sortedEvents = compactDiscordSortedEntries(list);
    const timing = buildCompactDiscordTiming(
      source.observedAtMs,
      source.dispatchedAtMs,
      source.approximateObserved === true
    );
    const presentation = {
      baseTitle: title.text,
      eventClass: title.eventClass,
      allianceUrl: safeAllianceUrl(source.allianceUrl, context),
      color: title.color,
      summaryFields: buildCompactDiscordSummaryFields(
        list,
        settings,
        timing.footer.text
      ),
      lineEntries: sortedEvents.map((entry) => ({
        event: entry.event,
        sourceIndex: entry.sourceIndex,
        line: buildCompactDiscordPlayerLine(entry.event, context, settings)
      })),
      footer: {
         text: truncateText(`${normalizeDiscordWorldHostname(source.worldHostname)} · ${timing.footer.text}`, 256)
      }
    };
    if (Object.prototype.hasOwnProperty.call(timing, "timestamp")) {
      presentation.timestamp = timing.timestamp;
    }
    return presentation;
  }
  function measureDiscordEmbedText(embeds) {
    let total = 0;
    for (const embed of Array.isArray(embeds) ? embeds : []) {
      if (typeof embed.title === "string") {
        total += embed.title.length;
      }
      if (typeof embed.description === "string") {
        total += embed.description.length;
      }
      for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
        if (typeof field.name === "string") {
          total += field.name.length;
        }
        if (typeof field.value === "string") {
          total += field.value.length;
        }
      }
      if (embed.footer && typeof embed.footer.text === "string") {
        total += embed.footer.text.length;
      }
    }
    return total;
  }
  function compactDiscordEmbedGroups(presentation, groups, title) {
    return groups.map((lineEntries, index) => {
      const isFirst = index === 0;
      const isLast = index === groups.length - 1;
      const description = "**Players**" + (lineEntries.length > 0 ? `
${lineEntries.map((entry) => entry.line).join("\n\n")}` : "");
      const embed = {
        description,
        color: presentation.color
      };
      if (isFirst) {
        embed.title = title;
        embed.url = presentation.allianceUrl;
        embed.fields = presentation.summaryFields.map((field) => ({
          name: field.name,
          value: field.value,
          inline: field.inline
        }));
      }
      if (isLast) {
        embed.footer = { text: presentation.footer.text };
        if (Object.prototype.hasOwnProperty.call(presentation, "timestamp")) {
          embed.timestamp = presentation.timestamp;
        }
      }
      return embed;
    });
  }
  function compactDiscordRequestFits(presentation, groups, title) {
    const embeds = compactDiscordEmbedGroups(presentation, groups, title);
    if (embeds.length === 0 || embeds.length > DISCORD_EMBEDS_LIMIT || measureDiscordEmbedText(embeds) > EMBED_TOTAL_TEXT_LIMIT) {
      return false;
    }
    return embeds.every((embed) => {
      if (typeof embed.title === "string" && embed.title.length > 256) {
        return false;
      }
      if (typeof embed.description !== "string" || embed.description.length > EMBED_DESCRIPTION_LIMIT) {
        return false;
      }
      return (Array.isArray(embed.fields) ? embed.fields : []).every(
        (field) => typeof field.name === "string" && field.name.length <= 256 && typeof field.value === "string" && field.value.length <= EMBED_FIELD_VALUE_LIMIT
      );
    });
  }
  function partitionCompactDiscordEntries(presentation) {
    if (!presentation || !Array.isArray(presentation.lineEntries) || presentation.lineEntries.length === 0) {
      return [];
    }
    const entries = presentation.lineEntries;
    const markerWidth = String(entries.length).length;
    const reservedMarker = ` · part ${"9".repeat(markerWidth)}/${"9".repeat(markerWidth)}`;
    const reservedTitle = presentation.baseTitle + reservedMarker;
    for (const entry of entries) {
      const rowDescription = `**Players**
${entry.line}`;
      const oneRowFits = compactDiscordRequestFits(
        presentation,
        [[entry]],
        reservedTitle
      );
      if (rowDescription.length > EMBED_DESCRIPTION_LIMIT || !oneRowFits) {
        throw new RangeError("discord-row-over-budget");
      }
    }
    if (compactDiscordRequestFits(presentation, [entries], presentation.baseTitle)) {
      const embeds = compactDiscordEmbedGroups(
        presentation,
        [entries.slice()],
        presentation.baseTitle
      );
      return [{
        requestIndex: 0,
        embedPlans: [
          {
            lineEntries: entries.slice(),
            embed: embeds[0]
          }
        ]
      }];
    }
    const requests = [];
    let finalizedGroups = [];
    let currentEntries = [];
    const finishRequest = () => {
      if (currentEntries.length > 0) {
        finalizedGroups = finalizedGroups.concat([currentEntries]);
        currentEntries = [];
      }
      if (finalizedGroups.length === 0) {
        return;
      }
      requests.push({ groups: finalizedGroups });
      finalizedGroups = [];
    };
    for (const entry of entries) {
      let placed = false;
      while (!placed) {
        const candidateGroups = finalizedGroups.concat([
          currentEntries.concat([entry])
        ]);
        const fits = compactDiscordRequestFits(
          presentation,
          candidateGroups,
          reservedTitle
        );
        if (fits) {
          currentEntries = currentEntries.concat([entry]);
          placed = true;
          continue;
        }
        if (currentEntries.length > 0) {
          if (finalizedGroups.length >= DISCORD_EMBEDS_LIMIT - 1) {
            finishRequest();
            continue;
          }
          finalizedGroups = finalizedGroups.concat([currentEntries]);
          currentEntries = [];
          continue;
        }
        if (finalizedGroups.length > 0) {
          finishRequest();
          continue;
        }
        throw new RangeError("discord-row-over-budget");
      }
    }
    finishRequest();
    const totalRequests = requests.length;
    return requests.map((request, requestIndex) => {
      const title = totalRequests > 1 ? `${presentation.baseTitle} · part ${requestIndex + 1}/${totalRequests}` : presentation.baseTitle;
      const embeds = compactDiscordEmbedGroups(
        presentation,
        request.groups,
        title
      );
      return {
        requestIndex,
        embedPlans: request.groups.map((lineEntries, embedIndex) => ({
          lineEntries: lineEntries.slice(),
          embed: embeds[embedIndex]
        }))
      };
    });
  }
  function serializeCompactDiscordRequestPlans(plans, mentions, events) {
    const source = mentions && typeof mentions === "object" ? mentions : {};
    const list = Array.isArray(events) ? events : [];
    const hasLeave = list.some((event) => event && event.eventType === "leave");
    const hasAttack = list.some((event) => event && (event.eventType === "attack" || event.eventType === "mixed"));
    const roleIds = [];
    if (hasAttack) roleIds.push(source.roleId);
    if (hasLeave) roleIds.push(source.leaveRoleId);
     const prioritizedUserIds = (Array.isArray(source.userIds) ? source.userIds : []).map((userId, index) => ({
       userId,
       index,
       score: discordEventCount(list[index], "addedAttackCount") + discordEventCount(list[index], "addedRaidCount")
     })).sort((left, right) => right.score - left.score || left.index - right.index).map((entry) => entry.userId);
     const selected = selectMentions(roleIds, prioritizedUserIds);
    const content = buildMentionContent(
      selected.roleIds,
      selected.userIds
    );
    const allowedMentions = buildAllowedMentions(
      selected.roleIds,
      selected.userIds
    );
    return plans.map((plan, requestIndex) => {
      if (requestIndex > 0) {
        return {
          content: "",
          username: "Travian — attack alarm",
          embeds: plan.embedPlans.map((embedPlan) => embedPlan.embed),
          allowed_mentions: { users: [] }
        };
      }
      return {
        content,
        username: "Travian — attack alarm",
        embeds: plan.embedPlans.map((embedPlan) => embedPlan.embed),
        allowed_mentions: {
          users: allowedMentions.users.slice(),
          ...Array.isArray(allowedMentions.roles) ? { roles: allowedMentions.roles.slice() } : {}
        }
      };
    });
  }
  function assertCompactDiscordPayloadLimits(payloads) {
    for (const payload of payloads) {
      if (typeof payload.content !== "string" || payload.content.length > DISCORD_CONTENT_LIMIT || !Array.isArray(payload.embeds) || payload.embeds.length > DISCORD_EMBEDS_LIMIT) {
        throw new RangeError("discord-payload-over-budget");
      }
      for (const embed of payload.embeds) {
        if (typeof embed.description !== "string" || embed.description.length > EMBED_DESCRIPTION_LIMIT) {
          throw new RangeError("discord-payload-over-budget");
        }
        if (typeof embed.title === "string" && embed.title.length > 256) {
          throw new RangeError("discord-payload-over-budget");
        }
        for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
          if (typeof field.name !== "string" || field.name.length > 256 || typeof field.value !== "string" || field.value.length > EMBED_FIELD_VALUE_LIMIT) {
            throw new RangeError("discord-payload-over-budget");
          }
        }
      }
      if (measureDiscordEmbedText(payload.embeds) > EMBED_TOTAL_TEXT_LIMIT) {
        throw new RangeError("discord-payload-over-budget");
      }
    }
    return payloads;
  }
  function buildEventDescriptionLine(event) {
    const source = event && typeof event === "object" ? event : {};
    const safeName = escapeDiscordMarkdown(
      truncateText(source.name || "Unknown player", EVENT_NAME_MAX)
    );
    if (source.eventType === "join") {
      return `${safeName} — joined the alliance`;
    }
    if (source.eventType === "leave") {
      return `${safeName} — left the alliance`;
    }
    const attackCount = Number.isFinite(source.attackCount) ? Math.max(0, Math.floor(source.attackCount)) : 0;
    const raidCount = Number.isFinite(source.raidCount) ? Math.max(0, Math.floor(source.raidCount)) : 0;
    const addedAttackCount = Number.isFinite(source.addedAttackCount) ? Math.max(0, Math.floor(source.addedAttackCount)) : 0;
    const addedRaidCount = Number.isFinite(source.addedRaidCount) ? Math.max(0, Math.floor(source.addedRaidCount)) : 0;
    return `${safeName} — +${addedAttackCount} ${attackWord(addedAttackCount)} · +${addedRaidCount} ${raidWord(addedRaidCount)} (${attackCount} ${attackWord(attackCount)} / ${raidCount} ${raidWord(raidCount)} active)`;
  }
  function buildProfileLink(event, context) {
    const source = event && typeof event === "object" ? event : {};
    const name = escapeDiscordMarkdown(
      truncateText(source.name, EVENT_NAME_MAX)
    );
    const url = safeProfileUrl(source.url, context);
    return `[${name}](${encodeMarkdownUrl(url)})`;
  }
  function chunkEventsForDiscord(events, maxSize, budget, estimate) {
    if (!Array.isArray(events)) {
      return [];
    }
    const size = typeof maxSize === "number" && Number.isFinite(maxSize) && maxSize >= 1 ? Math.floor(maxSize) : PAYLOAD_CHUNK_MAX;
    const limit = typeof budget === "number" && Number.isFinite(budget) && budget >= 1 ? Math.floor(budget) : EMBED_DESCRIPTION_SAFE_BUDGET;
    const estimator = typeof estimate === "function" ? estimate : (event, index) => buildEventDescriptionLine(event, index).length;
    const chunks = [];
    let current = [];
    let currentCost = 0;
    for (const event of events) {
      if (current.length > 0 && (current.length >= size || currentCost + estimator(event, current.length + 1) > limit)) {
        chunks.push(current);
        current = [];
        currentCost = 0;
      }
      current.push(event);
      currentCost += estimator(event, current.length);
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }
  function formatDiscordLocalTime(tsMs) {
    const value = Number(tsMs);
    if (!Number.isFinite(value)) {
      return "--:--:--";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "--:--:--";
    }
    return [
      date.getHours(),
      date.getMinutes(),
      date.getSeconds()
    ].map((part) => String(part).padStart(2, "0")).join(":");
  }
  function discordEventCount(event, key) {
    const value = event && Number(event[key]);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  function discordEventSortRank(event) {
    if (event && (event.eventType === "join" || event.eventType === "leave")) {
      return 2;
    }
    return event && event.eventType === "raid" && discordEventCount(event, "addedAttackCount") === 0 ? 1 : 0;
  }
  function sortDiscordEvents(events) {
    return events.map((event, index) => ({ event, index })).sort((left, right) => {
      const rankDifference = discordEventSortRank(left.event) - discordEventSortRank(right.event);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      const attackDifference = discordEventCount(right.event, "addedAttackCount") - discordEventCount(left.event, "addedAttackCount");
      if (attackDifference !== 0) {
        return attackDifference;
      }
      const raidDifference = discordEventCount(right.event, "addedRaidCount") - discordEventCount(left.event, "addedRaidCount");
      if (raidDifference !== 0) {
        return raidDifference;
      }
       const leftName = String(left.event && left.event.name || "");
       const rightName = String(right.event && right.event.name || "");
       return leftName.localeCompare(rightName, "pl", { sensitivity: "base" }) || (leftName < rightName ? -1 : rightName < leftName ? 1 : 0) || left.index - right.index;
    }).map((item) => item.event);
  }
  function buildDiscordWaveTitle(events) {
    const attacks = events.reduce(
      (sum, event) => sum + discordEventCount(event, "addedAttackCount"),
      0
    );
    const raids = events.reduce(
      (sum, event) => sum + discordEventCount(event, "addedRaidCount"),
      0
    );
    const hasAttack = events.some(
      (event) => event && (event.eventType === "attack" || event.eventType === "mixed") || discordEventCount(event, "addedAttackCount") > 0
    );
    const hasRaid = events.some(
      (event) => event && (event.eventType === "raid" || event.eventType === "mixed") || discordEventCount(event, "addedRaidCount") > 0
    );
    const severity = hasAttack ? "ATTACK WAVE" : hasRaid ? "RAID WAVE" : "ROSTER WAVE";
    const playerWord = events.length === 1 ? "player" : "players";
    return `${severity} · +${attacks} ${attackWord(attacks)} · +${raids} ${raidWord(raids)} · ${events.length} ${playerWord}`;
  }
  function buildDiscordTimingText(observedAtMs, dispatchedAtMs) {
    const observed = Number(observedAtMs);
    const dispatched = Number(dispatchedAtMs);
    const queueSeconds = Number.isFinite(observed) && Number.isFinite(dispatched) ? Math.max(0, Math.floor((dispatched - observed) / 1e3)) : 0;
    return `Observed ${formatDiscordLocalTime(observedAtMs)} · Sent ${formatDiscordLocalTime(dispatchedAtMs)} · queue ${queueSeconds} s`;
  }
  function buildDiscordPayloads(events, options = {}) {
    const sourceEvents = Array.isArray(events) ? events.slice() : [];
    if (sourceEvents.length === 0) {
      return [];
    }
    const sortedEvents = sortDiscordEvents(sourceEvents);
    const context = options.context && typeof options.context === "object" ? options.context : {};
    const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : sortedEvents.reduce((earliest, event) => {
      const rawValue = event && event.observedAtMs;
      const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : NaN;
      return Number.isFinite(value) ? Math.min(earliest, value) : earliest;
    }, Infinity);
    const dispatchedAtMs = Number.isFinite(options.dispatchedAtMs) ? options.dispatchedAtMs : sortedEvents.reduce((latest, event) => {
      const rawValue = event && event.dispatchedAtMs;
      const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : NaN;
      return Number.isFinite(value) ? Math.max(latest, value) : latest;
    }, -Infinity);
    const presentation = buildCompactDiscordPresentation(sourceEvents, {
      allianceUrl: options.allianceUrl,
      context,
      worldHostname: options.worldHostname,
      settings: options.settings,
      approximateObserved: options.approximateObserved === true || sortedEvents.some((event) => event && (event.approximateObserved === true || event.observedAtApproximate === true)),
      observedAtMs,
      dispatchedAtMs
    });
    const plans = partitionCompactDiscordEntries(presentation);
    const payloads = serializeCompactDiscordRequestPlans(
      plans,
      {
        roleId: options.roleId,
        leaveRoleId: options.leaveRoleId,
        userIds: options.userIds
      },
      sourceEvents
    );
    return assertCompactDiscordPayloadLimits(payloads);
  }
  function sendDiscordBatch(attacks, onComplete) {
    if (!isCurrentLeaseOwner()) {
      if (typeof onComplete === "function") {
        onComplete({
          status: null,
          responseText: null,
          errorClass: "leader-lost",
          error: null,
          retryAfterMs: null
        });
      }
      return;
    }
    if (!attacks.length) {
      return;
    }
    {
      const worldHostname = normalizeHostname(location.hostname);
      const currentSettings = requireValidatedDiscordSettings(
        loadSettings(worldHostname)
      );
      const discordConfig = loadDiscordConfig();
      const roleId = discordConfig.roleId || null;
      const leaveRoleId = discordConfig.leaveRoleId || null;
      const mappings = loadMappings();
      const worldMappings = mappings[worldHostname] || {};
      const userIds = [];
      const seenUserIds = /* @__PURE__ */ new Set();
      for (const attack of attacks) {
        if (attack.eventType === "join") {
          continue;
        }
        const rawPlayerId = attack.playerId !== void 0 ? attack.playerId : extractPlayerId(attack.url);
        const playerId = rawPlayerId === null || rawPlayerId === void 0 ? null : String(rawPlayerId);
        if (!playerId) {
          continue;
        }
        const recipients = Array.isArray(worldMappings[playerId]) ? worldMappings[playerId] : [];
        for (const id of recipients) {
          const key = validateDiscordUserId(id);
          if (key !== null && !seenUserIds.has(key)) {
            seenUserIds.add(key);
            userIds.push(key);
          }
        }
      }
      const observedCandidateAtMs = attacks.reduce((earliest, attack) => {
        const value = Number(attack.observedAtMs);
        return Number.isFinite(value) ? Math.min(earliest, value) : earliest;
      }, Infinity);
      const observedAtMs = Number.isFinite(observedCandidateAtMs) ? observedCandidateAtMs : void 0;
      const dispatchedAtMs = Date.now();
      const payloads = buildDiscordPayloads(attacks, {
        allianceUrl: location.href,
        context: {
          origin: location.origin,
          fallbackHref: location.href
        },
        worldHostname,
        observedAtMs,
        dispatchedAtMs,
        roleId,
        leaveRoleId,
        userIds,
        settings: currentSettings
      });
      let payloadIndex = 0;
      const finish = (outcome) => {
        if (outcome && Number.isFinite(outcome.requestMs)) {
          mergeRuntimeDiagnostics(worldHostname, {
            dispatchedAtMs,
            request: {
              requestStartedAtMs: outcome.requestStartedAtMs,
              requestEndedAtMs: outcome.requestEndedAtMs,
              requestMs: outcome.requestMs
            }
          });
        }
        if (typeof onComplete === "function") {
          onComplete(outcome);
          return;
        }
        if (outcome.errorClass === "configuration") {
          console.warn(
            "[Alliance Discord] No webhook configured — set it via the userscript menu."
          );
        } else if (outcome.delivery && outcome.delivery.kind === "acknowledged") {
          console.log(
            `[Alliance Discord] Batch alert sent. Players: ${attacks.length}, new attacks: ${attacks.reduce(
              (sum, event) => sum + discordEventCount(event, "addedAttackCount"),
              0
            )}, new raids: ${attacks.reduce(
              (sum, event) => sum + discordEventCount(event, "addedRaidCount"),
              0
            )}.`
          );
        } else if (outcome.status !== null) {
          console.error("[Alliance Discord] Discord error:", outcome.status);
        } else {
          console.error(
            "[Alliance Discord] Discord connection error:",
            outcome.errorClass || "unknown"
          );
        }
      };
      const sendNextPayload = () => {
        if (payloadIndex >= payloads.length) {
          return;
        }
        const payload = payloads[payloadIndex];
        payloadIndex += 1;
        if (!isCurrentLeaseOwner()) {
          finish({
            status: null,
            responseText: null,
            errorClass: "leader-lost",
            error: null,
            retryAfterMs: null
          });
          return;
        }
        postPayload(payload, (outcome) => {
          const acknowledged = outcome.delivery && outcome.delivery.kind === "acknowledged";
          if (!acknowledged) {
            finish(outcome);
            return;
          }
          if (payloadIndex < payloads.length) {
            sendNextPayload();
            return;
          }
          finish(outcome);
        });
      };
      if (!isCurrentLeaseOwner()) {
        if (typeof onComplete === "function") {
          onComplete({
            status: null,
            responseText: null,
            errorClass: "leader-lost",
            error: null,
            retryAfterMs: null
          });
        }
        return;
      }
      reportLifecycleHook("onDiscordSendStart", {
        atMs: dispatchedAtMs,
        eventCount: attacks.length
      });
      sendNextPayload();
      return;
    }
  }
  function postPayload(payload, onComplete) {
    const webhookUrl = loadWebhookUrl();
    const requestStartedMono = monotonicNow();
    const requestStartedAtMs = Date.now();
    if (webhookUrl === null) {
      if (typeof onComplete === "function") {
        onComplete({
          status: null,
          responseText: null,
          errorClass: "configuration",
          error: null,
          retryAfterMs: null
        });
      }
      return;
    }
    let settled = false;
    const settleOnce = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      const completedAtMs = Date.now();
      const enriched = Object.assign({}, outcome, {
        requestStartedAtMs,
        requestEndedAtMs: completedAtMs,
        requestMs: monotonicDurationMs(requestStartedMono, monotonicNow())
      });
      reportLifecycleHook("onDiscordRequest", enriched);
      if (typeof onComplete === "function") {
        onComplete(enriched);
      }
    };
    GM_xmlhttpRequest({
      method: "POST",
      url: buildDiscordRequestUrl(webhookUrl),
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json"
      },
      data: JSON.stringify(payload),
      onload(response) {
        const delivery = classifyDiscordResponse(response);
        settleOnce({
          status: response.status,
          responseText: response.responseText,
          errorClass: delivery.kind === "retryable" ? delivery.errorClass || null : null,
          error: null,
          retryAfterMs: delivery.retryAfterMs ?? parseRetryAfterMs(response),
          delivery
        });
      },
      onerror(error) {
        settleOnce({
          status: null,
          responseText: null,
          errorClass: "network",
          error,
          retryAfterMs: null
        });
      },
      ontimeout() {
        settleOnce({
          status: null,
          responseText: null,
          errorClass: "timeout",
          error: null,
          retryAfterMs: null
        });
      },
      onabort() {
        settleOnce({
          status: null,
          responseText: null,
          errorClass: "abort",
          error: null,
          retryAfterMs: null
        });
      }
    });
  }
  function isAlliancePageReady(readyState, hasTable, hasPlayerRow) {
    return readyState === "complete" && hasTable === true && hasPlayerRow === true;
  }
  function isReadinessReady(readyState, tablePresent, quietMs, quietWindowMs = READINESS_QUIET_MS) {
    return readyState === "complete" && tablePresent === true && typeof quietMs === "number" && Number.isFinite(quietMs) && quietMs >= quietWindowMs;
  }
  const SCAN_CYCLE_DEADLINE_MS = 15000;
  const SCAN_CYCLE_QUIET_MS = READINESS_QUIET_MS;
  const SCAN_COMMIT_ERROR_REASONS = Object.freeze([
    "monitor-blocked",
    "fence-before-monitor-commit",
    "monitor-commit-blocked",
    "scan-error"
  ]);
  const RELOAD_REFUSAL_REASONS = Object.freeze([
    "reload-blocked-by-draft",
    "reload-unavailable",
    "lease-lost-before-reload"
  ]);
  function isScanCycleReady(readyState, tablePresent, quietMs) {
    return isReadinessReady(readyState, tablePresent, quietMs, SCAN_CYCLE_QUIET_MS);
  }
  function createScanCycleId(seed) {
    return "sc1:" + diagnosticDigest(String(seed === void 0 || seed === null ? "" : seed));
  }
  function decideScanCycleOutcome(input) {
    const source = input && typeof input === "object" ? input : {};
    const elapsedMs = typeof source.elapsedMs === "number" && Number.isFinite(source.elapsedMs) ? source.elapsedMs : 0;
    const quietMs = typeof source.quietMs === "number" && Number.isFinite(source.quietMs) ? source.quietMs : 0;
    if (source.leaseHeld !== true) return { terminal: true, stage: "lease", status: "rejected", reason: "lease-lost-before-scan" };
    const parserResult = source.parserResult && typeof source.parserResult === "object" ? source.parserResult : null;
    if (!parserResult && elapsedMs >= SCAN_CYCLE_DEADLINE_MS) return { terminal: true, stage: "snapshot", status: "rejected", reason: "readiness-timeout" };
    if (!parserResult || quietMs < SCAN_CYCLE_QUIET_MS) return null;
    if (parserResult.status === "rejected") {
      if (MEMBER_TABLE_REASON_CODES.includes(parserResult.reason)) return { terminal: true, stage: "snapshot", status: "rejected", reason: parserResult.reason };
      return { terminal: true, stage: "snapshot", status: "error", reason: "scan-error" };
    }
    if (parserResult.status !== "accepted") return { terminal: true, stage: "snapshot", status: "error", reason: "scan-error" };
    const commitResult = source.commitResult && typeof source.commitResult === "object" ? source.commitResult : null;
    if (!commitResult || commitResult.status === "ok") return { terminal: true, stage: "snapshot", status: "ok", reason: "authoritative" };
    if (commitResult.status === "blocked" && (commitResult.reason === void 0 || commitResult.reason === null)) return { terminal: true, stage: "snapshot", status: "error", reason: "monitor-commit-blocked" };
    if (SCAN_COMMIT_ERROR_REASONS.includes(commitResult.reason)) return { terminal: true, stage: "snapshot", status: "error", reason: commitResult.reason };
    return { terminal: true, stage: "snapshot", status: "error", reason: "scan-error" };
  }
  function isScanTerminalRecord(record) {
    if (!record || typeof record !== "object") return false;
    if (record.stage === "snapshot" && record.status === "ok") return record.reason === "authoritative";
    if (record.stage === "snapshot" && record.status === "rejected") return record.reason === "readiness-timeout" || MEMBER_TABLE_REASON_CODES.includes(record.reason);
    if (record.stage === "snapshot" && record.status === "error") return SCAN_COMMIT_ERROR_REASONS.includes(record.reason);
    if (record.stage === "lease" && record.status === "rejected") return record.reason === "lease-lost-before-scan";
    return false;
  }
  function selectScanTerminalRecord(records) {
    if (!Array.isArray(records)) return null;
    return records.find((record) => isScanTerminalRecord(record)) || null;
  }
  function selectLatestScanTerminalRecord(records) {
    if (!Array.isArray(records)) return null;
    return records.slice().reverse().find((record) => isScanTerminalRecord(record)) || null;
  }
  function describeScanTerminal(record) {
    const source = record && typeof record === "object" ? record : {};
    const stage = source.stage;
    const status = source.status;
    const reason = diagnosticString(source.reason, 64);
    if (stage === "snapshot" && status === "ok" && reason === "authoritative") return "accepted/authoritative";
    if (stage === "snapshot" && status === "rejected" && MEMBER_TABLE_REASON_CODES.includes(reason)) return "parser-rejected/" + reason;
    if (stage === "snapshot" && status === "rejected" && reason === "readiness-timeout") return "readiness-timeout/rejected";
    if (stage === "lease" && status === "rejected" && reason === "lease-lost-before-scan") return "lease-lost/rejected";
    if (stage === "reload" && status === "rejected" && (reason === "reload-blocked" || RELOAD_REFUSAL_REASONS.includes(reason))) return "reload-blocked/rejected";
    if (stage === "snapshot" && status === "error" && SCAN_COMMIT_ERROR_REASONS.includes(reason)) return "fence-storage-error/" + reason;
    if (stage === "snapshot" && status === "error" && reason === "scan-error") return "scan-error/error";
    return "scan-error/error";
  }
  function classifyReloadRefusal(reason, scanId) {
    return { stage: "reload", status: "rejected", reason: RELOAD_REFUSAL_REASONS.includes(reason) ? reason : "reload-unavailable", scanId };
  }
  function checkLifecycleFence(active, expectedToken, currentToken) {
    return {
      outcome: active === true && typeof expectedToken === "string" && expectedToken.length > 0 && expectedToken === currentToken ? "ok" : "fenced-reject"
    };
  }
  function isLifecycleFenceValid(active, expectedToken, currentToken) {
    return checkLifecycleFence(
      active,
      expectedToken,
      currentToken
    ).outcome === "ok";
  }
  function getStartupAcquisitionJitterMs(randomValue) {
    const random = typeof randomValue === "number" && Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
    const span = STARTUP_ACQUIRE_JITTER_MAX_MS - STARTUP_ACQUIRE_JITTER_MIN_MS;
    return STARTUP_ACQUIRE_JITTER_MIN_MS + Math.floor(random * span);
  }
  function createDocumentScanState() {
    return { scanAttemptedForDocument: false };
  }
  function shouldAttemptDocumentScan(state) {
    return !(state && state.scanAttemptedForDocument === true);
  }
  function markDocumentScanAttempted(state) {
    if (!shouldAttemptDocumentScan(state)) {
      return state;
    }
    return { scanAttemptedForDocument: true };
  }
  function resetDocumentScanState() {
    return createDocumentScanState();
  }
  function clearScanDeadlineTimer() {
    if (scanDeadlineTimerId === null) return;
    clearTimeout(scanDeadlineTimerId);
    lifecycleTimerIds.delete(scanDeadlineTimerId);
    scanDeadlineTimerId = null;
  }
  function emitScanCycleTerminal(outcome) {
    if (!isScanTerminalRecord(outcome) || scanAttemptedForDocument) return false;
    scanAttemptedForDocument = true;
    clearScanDeadlineTimer();
    if (readinessTimerId !== null) {
      clearTimeout(readinessTimerId);
      readinessTimerId = null;
    }
    if (readinessObserver) {
      readinessObserver.disconnect();
      readinessObserver = null;
    }
    recordDiagnosticTraceV2(normalizeHostname(typeof location !== "undefined" ? location.hostname : ""), {
      stage: String(outcome.stage),
      status: String(outcome.status),
      reason: String(outcome.reason),
      scanId: scanCycleId
    });
    return true;
  }
  function finishScanCycle(outcome) {
    return emitScanCycleTerminal(Object.assign({}, outcome, { scanId: scanCycleId }));
  }
  function pageLooksLoaded() {
    const selection = selectMemberTable(document);
    const hasTable = selection.status === "accepted";
    if (!hasTable) {
      return isAlliancePageReady(
        document.readyState,
        false,
        false
      );
    }
    let hasPlayerRow = false;
    for (const link of selection.table.querySelectorAll("tr a")) {
      const href = link.getAttribute("href") || "";
      if (extractPlayerId(href) !== null) {
        hasPlayerRow = true;
        break;
      }
    }
    return isAlliancePageReady(
      document.readyState,
      hasTable,
      hasPlayerRow
    );
  }
  function installReadinessObserver() {
    if (typeof document === "undefined" || typeof MutationObserver !== "function") {
      return;
    }
    if (scanAttemptedForDocument) return;
    if (scanCycleId === null) scanCycleId = createScanCycleId(String(Date.now()) + ":" + String(monotonicNow()));
    readinessStartedAtMono = monotonicNow();
    let lastMutationAtMs = Date.now() - READINESS_QUIET_MS;
    const check = () => {
      readinessTimerId = null;
      if (scanAttemptedForDocument || !tabLeaseActive) {
        return;
      }
      const tablePresent = selectMemberTable(document).status === "accepted";
      const quietMs = Date.now() - lastMutationAtMs;
      if (!isReadinessReady(
        document.readyState,
        tablePresent,
        quietMs
      )) {
        return;
      }
      clearScanDeadlineTimer();
      if (readinessObserver) {
        readinessObserver.disconnect();
        readinessObserver = null;
      }
      reportLifecycleHook("onReadinessCommit", {
        atMs: Date.now(),
        quietMs,
        readinessWaitMs: monotonicDurationMs(readinessStartedAtMono, monotonicNow())
      });
      scanAttacks(false);
    };
    const scheduleCheck = () => {
      if (readinessTimerId !== null) {
        clearTimeout(readinessTimerId);
      }
      const remaining = Math.max(
        0,
        READINESS_QUIET_MS - (Date.now() - lastMutationAtMs)
      );
      readinessTimerId = scheduleLifecycleTimeout(check, remaining);
    };
    readinessObserver = new MutationObserver(() => {
      lastMutationAtMs = Date.now();
      scheduleCheck();
    });
    readinessObserver.observe(
      document.documentElement || document,
      {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      }
    );
    document.addEventListener("DOMContentLoaded", check, { once: true });
    scanDeadlineTimerId = scheduleLifecycleTimeout(() => {
      scanDeadlineTimerId = null;
      if (scanAttemptedForDocument) return;
      if (!tabLeaseActive) {
        finishScanCycle(decideScanCycleOutcome({ leaseHeld: false }));
        return;
      }
      finishScanCycle(decideScanCycleOutcome({
        elapsedMs: SCAN_CYCLE_DEADLINE_MS,
        quietMs: Date.now() - lastMutationAtMs,
        leaseHeld: true,
        parserResult: null
      }));
    }, SCAN_CYCLE_DEADLINE_MS);
    check();
  }
  function diffAttackStates(previousState2, currentState) {
    const newEvents = [];
    const previous = previousState2 || {};
    for (const [key, attack] of Object.entries(currentState || {})) {
      if (key === "filterVersion") {
        continue;
      }
      const currentAttackCount = Number.isFinite(attack.attackCount) ? attack.attackCount : Number.isFinite(attack.count) ? attack.count : 0;
      const currentRaidCount = Number.isFinite(attack.raidCount) ? attack.raidCount : 0;
      const oldAttackCount = getStoredAttackCount(previous, key);
      const oldRaidCount = getStoredRaidCount(previous, key);
      const addedAttackCount = currentAttackCount > oldAttackCount ? Math.max(
        1,
        currentAttackCount - oldAttackCount
      ) : 0;
      const addedRaidCount = currentRaidCount > oldRaidCount ? Math.max(
        1,
        currentRaidCount - oldRaidCount
      ) : 0;
      if (addedAttackCount === 0 && addedRaidCount === 0) {
        continue;
      }
      let eventType = "mixed";
      if (addedAttackCount > 0 && addedRaidCount === 0) {
        eventType = "attack";
      } else if (addedRaidCount > 0 && addedAttackCount === 0) {
        eventType = "raid";
      }
      newEvents.push({
        name: attack.name,
        url: attack.url,
        attackCount: currentAttackCount,
        raidCount: currentRaidCount,
        oldAttackCount,
        oldRaidCount,
        addedAttackCount,
        addedRaidCount,
        eventType
      });
    }
    return {
      newEvents,
      shouldSave: Object.keys(currentState || {}).length > 0
    };
  }
  function shouldRebaseline(previousState2) {
    const hasStoredPlayers = Boolean(
      previousState2 && Object.keys(previousState2).some(
        (key) => key !== "filterVersion"
      )
    );
    return hasStoredPlayers && previousState2.filterVersion !== 4;
  }
  function scanAttacks(finalScan = false) {
    if (!isCurrentLeaseOwner() || scanAttemptedForDocument) {
      if (!scanAttemptedForDocument) finishScanCycle(decideScanCycleOutcome({ leaseHeld: false }));
      return;
    }
    const observedAtMs = Date.now();
    const scanStartedMono = monotonicNow();
    const durations = {};
    reportLifecycleHook("onExtractionStart", {
      observedAtMs,
      finalScan: finalScan === true
    });
    try {
      const extractionStartedMono = monotonicNow();
      const snapshot = extractAllianceSnapshotFromDocument(
        document,
        observedAtMs
      );
      recordDuration(durations, "extractionMs", extractionStartedMono, monotonicNow());
      if (readinessStartedAtMono !== null) {
        durations.readinessWaitMs = monotonicDurationMs(readinessStartedAtMono, extractionStartedMono);
      }
      if (snapshot.status !== "authoritative") {
        durations.scanMs = monotonicDurationMs(scanStartedMono, monotonicNow());
        if (loadDebugVerbose() && Array.isArray(snapshot.rowAnomalies)) {
          snapshot.rowAnomalies.slice(0, MAX_DEBUG_ANOMALY_ROWS).forEach((row) => {
            console.debug("[Alliance Discord] Scan anomaly: " + sanitizeDiagnosticText(
              JSON.stringify({ id: row.id, name: row.name, anomaly: {
                missingId: row.missingId,
                conflictingTooltip: row.conflictingTooltip,
                malformedCount: row.malformedCount
              } })
            ));
          });
        }
        reportLifecycleHook("onHealth", {
          kind: "invalid-snapshot",
          observedAtMs,
          status: snapshot.status,
          anomalies: snapshot.anomalies,
          durations
        });
        saveDiagnostics(
          recordFailure(
            loadDiagnostics(),
            normalizeHostname(location.hostname),
            observedAtMs,
             "invalid-snapshot",
             0,
             snapshot.reason,
             { memberRows: snapshot.memberRows || 0, rows: snapshot.rowCount || 0, icons: snapshot.iconCount || 0 }
          ),
          normalizeHostname(location.hostname)
        );
        console.warn(buildScanSummaryLog({
          status: snapshot.status,
          memberRows: snapshot.rowCount,
           icons: snapshot.iconCount,
           rejectionReason: snapshot.reason,
           scanMs: durations.scanMs,
          queueAge: null
        }));
        finishScanCycle(decideScanCycleOutcome({
          elapsedMs: SCAN_CYCLE_QUIET_MS,
          quietMs: SCAN_CYCLE_QUIET_MS,
          leaseHeld: true,
          parserResult: { status: "rejected", reason: snapshot.reason }
        }));
        return;
      }
      const currentState = Object.fromEntries(
        Object.entries(snapshot.membersById).map(([id, member]) => [
          id,
          Object.assign({}, member)
        ])
      );
      const currentHostname = normalizeHostname(location.hostname);
      const monitorLoaded = loadOrMigrateMonitorEnvelopeV1(
        currentHostname,
        snapshot,
        {
          nowMs: observedAtMs,
          beforeCommit: isCurrentLeaseOwner
        }
      );
      if (monitorLoaded.blocked || !monitorLoaded.envelope) {
        console.error(
          "[Alliance Discord] Monitor storage blocked:",
          monitorLoaded.outcome
        );
        finishScanCycle(decideScanCycleOutcome({
          elapsedMs: SCAN_CYCLE_QUIET_MS,
          quietMs: SCAN_CYCLE_QUIET_MS,
          leaseHeld: true,
          parserResult: { status: "accepted" },
          commitResult: { status: "blocked", reason: "monitor-blocked" }
        }));
        return;
      }
      const monitorPreviousState = Object.assign(
        {},
        monitorLoaded.envelope.baselineByPlayerId,
        { filterVersion: 4 }
      );
      const isRebaseline = shouldRebaseline(monitorPreviousState);
      const diffStartedMono = monotonicNow();
      const diff = diffAttackStates(
        monitorPreviousState,
        currentState
      );
      recordDuration(durations, "diffMs", diffStartedMono, monotonicNow());
      const newEvents = isRebaseline ? [] : diff.newEvents;
      const settings = loadSettings(
        normalizeHostname(location.hostname)
      );
      const passingEvents = new Set(
        applyEventThresholds(
          newEvents,
          settings
        )
      );
      for (const event of newEvents) {
        const priority = classifyPriority(
          event,
          settings
        );
        Object.defineProperty(
          event,
          "priority",
          {
            value: priority,
            enumerable: false,
            writable: true,
            configurable: true
          }
        );
        Object.defineProperty(
          event,
          "priorityColor",
          {
            value: PRIORITY_COLORS[priority],
            enumerable: false,
            writable: true,
            configurable: true
          }
        );
        Object.defineProperty(
          event,
          "thresholdPass",
          {
            value: passingEvents.has(event),
            enumerable: false,
            writable: true,
            configurable: true
          }
        );
      }
      const currentMutes = loadMutedPlayers();
      const detectedAtMs = observedAtMs;
      let history = loadHistory();
      let monitorRosterByPlayerId = monitorLoaded.envelope.rosterByPlayerId;
      let nextRoster = null;
      for (const event of newEvents) {
        history = recordHistory(
          history,
          currentHostname,
          buildHistoryRecord(
            event,
            currentHostname,
            detectedAtMs,
            currentMutes
          )
        );
      }
      const mutedPlayers = loadMutedPlayers();
      const filteredEvents = filterMutedEvents(
        newEvents,
        normalizeHostname(location.hostname),
        mutedPlayers
      );
      const pendingEvents = filteredEvents.filter(
        (event) => event.thresholdPass === true
      );
      const queuedAtMs = Date.now();
      const queuedMonitorEvents = pendingEvents.map(
        (event) => Object.assign(toPendingEvent(event, {
          world: currentHostname,
          enforceQueueContract: true,
          queuedAtMs
        }), {
          world: currentHostname,
          playerId: event.playerId || event.id || extractPlayerId(event.url),
          observedAtMs
        })
      );
      let monitorPendingEvents = queuedMonitorEvents;
      if (pendingEvents.length > 0) {
        console.warn(
          `[Alliance Discord] Detected new attacks/raids on ${pendingEvents.length} players (queued for dispatch).`
        );
      }
      const rosterMembers = Object.entries(
        snapshot.membersById
      ).map(([id, member]) => Object.assign({ id }, member));
      if (rosterMembers.length > 0) {
        const roster = loadRoster();
        const worldKey = normalizeHostname(location.hostname);
        const previousMap = roster[worldKey] && typeof roster[worldKey] === "object" ? roster[worldKey] : null;
        const currentMap = buildRosterMap(rosterMembers);
        monitorRosterByPlayerId = currentMap;
        const rosterDiff = diffRoster(
          previousMap,
          currentMap
        );
        nextRoster = Object.assign({}, roster);
        nextRoster[worldKey] = currentMap;
        if (previousMap !== null && rosterDiff.changed) {
          const toRosterEvent = (member, type) => ({
            playerId: String(member.id),
            name: member.name,
            url: member.url,
            attackCount: 0,
            raidCount: 0,
            oldAttackCount: 0,
            oldRaidCount: 0,
            addedAttackCount: 0,
            addedRaidCount: 0,
            eventType: type
          });
          const rosterEvents = rosterDiff.joined.map(
            (member) => toRosterEvent(member, "join")
          ).concat(
            rosterDiff.left.map(
              (member) => toRosterEvent(member, "leave")
            )
          );
          history = loadHistory();
          for (const event of rosterEvents) {
            history = recordHistory(
              history,
              currentHostname,
              buildHistoryRecord(
                event,
                currentHostname,
                detectedAtMs,
                currentMutes
              )
            );
          }
          monitorPendingEvents = monitorPendingEvents.concat(
            rosterEvents.map((event) => Object.assign(
              toPendingEvent(event, {
                world: currentHostname,
                enforceQueueContract: true,
                queuedAtMs
              }),
              {
                world: currentHostname,
                playerId: event.playerId || event.id || extractPlayerId(event.url),
                observedAtMs: detectedAtMs
              }
            ))
          );
          console.warn(
            "[Alliance Discord] Roster change: " + rosterDiff.joined.length + " joined, " + rosterDiff.left.length + " left (queued)."
          );
        }
      }
      const shouldCommitMonitor = diff.shouldSave || monitorPendingEvents.length > 0;
      if (shouldCommitMonitor) {
        const acceptedPlan = planAcceptedScanTransition(
          snapshot,
          monitorLoaded.envelope.baselineByPlayerId,
          currentMutes,
          {
            attackThreshold: settings.attackThreshold,
            raidThreshold: settings.raidThreshold
          },
          monitorLoaded.envelope.generation,
          { ownerId: activeLeaseOwnerId, term: tabLeaseTerm },
          { world: currentHostname }
        );
        const transition = Object.assign({}, acceptedPlan, {
          baselineByPlayerId: currentState,
          eligibleEvents: monitorPendingEvents,
          rosterByPlayerId: monitorRosterByPlayerId,
          metrics: {
             lastAuthoritativeScanAtMs: observedAtMs,
            observedAtMs,
            timings: durations
          }
        });
        if (!isCurrentLeaseOwner()) {
          enterLeaderStandby("fence-before-monitor-commit");
          return;
        }
        reportLifecycleHook("onMonitorCommitAttempt", {
          observedAtMs,
          generation: transition.generation
        });
        const persistStartedMono = monotonicNow();
        const commit = commitMonitorEnvelope({
          world: currentHostname,
          currentEnvelope: monitorLoaded.envelope,
          transition,
          nowMs: observedAtMs,
          beforeCommit: isCurrentLeaseOwner,
          ownerId: activeLeaseOwnerId,
          term: tabLeaseTerm,
          expectedGeneration: monitorLoaded.envelope.generation
        });
        recordDuration(durations, "persistMs", persistStartedMono, monotonicNow());
        if (commit.outcome !== "ok") {
          console.error(
            "[Alliance Discord] Monitor commit blocked:",
            commit.outcome
          );
          finishScanCycle(decideScanCycleOutcome({
            elapsedMs: SCAN_CYCLE_QUIET_MS,
            quietMs: SCAN_CYCLE_QUIET_MS,
            leaseHeld: true,
            parserResult: { status: "accepted" },
            commitResult: { status: "error", reason: commit.outcome }
          }));
          return;
        }
        lastScanAtMs = observedAtMs;
        const nextPending = commit.envelope.pending;
        reportLifecycleHook("onMonitorCommit", {
          observedAtMs,
          generation: commit.generation
        });
        if (nextRoster !== null) {
          saveRoster(nextRoster);
        }
        saveHistory(history, currentHostname);
        if (monitorPendingEvents.length > 0) {
          const queued = savePendingBatch(
            enqueueEvents(
              loadPendingBatch(),
              currentHostname,
              monitorPendingEvents,
              { enforceQueueContract: true }
            ),
            currentHostname
          );
          if (!queued) {
            reportLifecycleHook("onHealth", {
              kind: "legacy-queue-bridge-failed",
              observedAtMs
            });
          }
        }
        previousState = Object.assign({}, currentState, {
          filterVersion: 4
        });
      }
      durations.queueMs = pendingEvents.length > 0 ? Math.max(0, queuedAtMs - observedAtMs) : 0;
      durations.scanMs = monotonicDurationMs(scanStartedMono, monotonicNow());
      const debugEnabled = loadDebugVerbose();
      if (debugEnabled && Array.isArray(snapshot.rowAnomalies)) {
        snapshot.rowAnomalies.slice(0, MAX_DEBUG_ANOMALY_ROWS).forEach((row) => {
          console.debug("[Alliance Discord] Scan anomaly: " + sanitizeDiagnosticText(
            JSON.stringify({ id: row.id, name: row.name, anomaly: {
              missingId: row.missingId,
              conflictingTooltip: row.conflictingTooltip,
              malformedCount: row.malformedCount
            } })
          ));
        });
      }
      const generation = monitorLoaded && monitorLoaded.envelope ? monitorLoaded.envelope.generation + (shouldCommitMonitor ? 1 : 0) : null;
      const newDeltas = {
        attacks: newEvents.reduce((sum, event) => sum + (event.addedAttackCount || 0), 0),
        raids: newEvents.reduce((sum, event) => sum + (event.addedRaidCount || 0), 0),
        players: newEvents.length
      };
      const firstPending = monitorLoaded.envelope && monitorLoaded.envelope.pending && monitorLoaded.envelope.pending[0];
      const queueAge = firstPending && Number.isFinite(firstPending.observedAtMs) ? Math.max(0, Date.now() - firstPending.observedAtMs) : null;
      console.log(buildScanSummaryLog({
        status: snapshot.status,
        memberRows: snapshot.rowCount,
        icons: snapshot.iconCount,
        newDeltas,
        scanMs: durations.scanMs,
        generation,
        queueAge
      }));
      const runtimePatch = {
        timings: durations,
        visibility: visibilityDriftState
      };
      if (shouldCommitMonitor) {
        runtimePatch.observedAtMs = observedAtMs;
        runtimePatch.lastScan = Object.assign({}, durations, { observedAtMs, generation, queueAge });
      }
      mergeRuntimeDiagnostics(currentHostname, runtimePatch);
      reportLifecycleHook("onScanComplete", {
        observedAtMs,
        generation,
        durations,
        newDeltas,
        queueAge
      });
      finishScanCycle(decideScanCycleOutcome({
        elapsedMs: SCAN_CYCLE_QUIET_MS,
        quietMs: SCAN_CYCLE_QUIET_MS,
        leaseHeld: true,
        parserResult: { status: "accepted" },
        commitResult: { status: "ok" }
      }));
    } catch (error) {
      console.error(
        "[Alliance Discord] Scan error:",
        error
      );
      finishScanCycle(decideScanCycleOutcome({
        elapsedMs: SCAN_CYCLE_QUIET_MS,
        quietMs: SCAN_CYCLE_QUIET_MS,
        leaseHeld: true,
        parserResult: { status: "rejected", reason: "scan-error" }
      }));
    }
  }
  function shouldKeepWaitingForDrain(hostActive, elapsedMs, maxWaitMs) {
    if (!hostActive) {
      return false;
    }
    if (typeof maxWaitMs !== "number" || !Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
      return false;
    }
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      return false;
    }
    return elapsedMs < maxWaitMs;
  }
  function scheduleRandomReload() {
    const seconds = Math.floor(
      Math.random() * (CONFIG.reloadMaxSeconds - CONFIG.reloadMinSeconds + 1)
    ) + CONFIG.reloadMinSeconds;
    console.log("[Alliance Discord] Next refresh scheduled: " + seconds + " seconds.");
    nextReloadAtMs = Date.now() + seconds * 1e3;
    visibilityDriftState = updateVisibilityDriftTracker(
      visibilityDriftState,
      Date.now(),
      typeof document !== "undefined" && document.hidden === true,
      nextReloadAtMs
    );
    if (typeof panelRuntimeUpdater === "function") panelRuntimeUpdater();
    const reloadAfterDrain = () => {
      const hostname = normalizeHostname(location.hostname);
      if (!activeInFlightHosts.has(hostname)) {
        visibilityDriftState = updateVisibilityDriftTracker(
          visibilityDriftState,
          Date.now(),
          typeof document !== "undefined" && document.hidden === true,
          nextReloadAtMs
        );
        mergeRuntimeDiagnostics(hostname, { visibility: visibilityDriftState });
        requestLifecycleReload("scheduled-refresh");
        return;
      }
      const startedAtMs = Date.now();
      const drainCheck = () => {
        if (!tabLeaseActive) {
          requestLifecycleReload("scheduled-refresh-after-drain");
          return;
        }
        const elapsedMs = Date.now() - startedAtMs;
        if (!shouldKeepWaitingForDrain(
          activeInFlightHosts.has(hostname),
          elapsedMs,
          DRAIN_MAX_WAIT_MS
        )) {
          requestLifecycleReload("scheduled-refresh-after-drain");
          return;
        }
        scheduleLifecycleTimeout(drainCheck, DRAIN_POLL_MS);
      };
      scheduleLifecycleTimeout(drainCheck, DRAIN_POLL_MS);
    };
    scheduledReloadTimerId = scheduleLifecycleTimeout(() => {
      scheduledReloadTimerId = null;
      if (!tabLeaseActive) {
        requestLifecycleReload("scheduled-refresh");
        return;
      }
      flushPendingBatch();
      reloadAfterDrain();
    }, seconds * 1e3);
  }
  const activeInFlightHosts = /* @__PURE__ */ new Set();
  function ensureMonitorEnvelopeForTransport(hostname) {
    const loaded = loadMonitorEnvelopeV1(hostname);
    if (loaded.envelope || loaded.blocked) {
      return loaded.envelope || null;
    }
    const legacyPending = loadPendingBatch();
    const legacyFailed = loadFailedBatch();
    const worldKey = normalizeHostname(hostname);
    const pendingWorld = legacyPending[worldKey];
    const failedWorld = legacyFailed[worldKey];
    const hasLegacyQueue = Boolean(
      pendingWorld && (Array.isArray(pendingWorld.events) && pendingWorld.events.length > 0 || Array.isArray(pendingWorld.inFlight) && pendingWorld.inFlight.length > 0) || failedWorld && Array.isArray(failedWorld.events) && failedWorld.events.length > 0
    );
    if (!hasLegacyQueue) return null;
    const migrated = loadOrMigrateMonitorEnvelopeV1(
      hostname,
      null,
      {
        legacy: {
          pending: loadPendingBatch(),
          inFlight: loadInFlightBatch(),
          failed: loadFailedBatch()
        },
        beforeCommit: isCurrentLeaseOwner
      }
    );
    return migrated.commit && migrated.commit.outcome === "ok" ? migrated.envelope : null;
  }
  function commitMonitorTransportTransition(hostname, envelope, transition) {
    if (!envelope || !isCurrentLeaseOwner()) {
      return { outcome: "fenced-reject", memorySwapped: false };
    }
    return commitMonitorQueueTransitionV1({
      world: hostname,
      currentEnvelope: envelope,
      expectedGeneration: envelope.generation,
      transition,
      beforeCommit: isCurrentLeaseOwner
    });
  }
  function monitorTransportChunk(envelope) {
    return envelope && Array.isArray(envelope.inFlight) && envelope.inFlight.length > 0 ? envelope.inFlight.slice() : null;
  }
  function startMonitorDispatch(hostname, events) {
    const current = loadMonitorEnvelopeV1(hostname).envelope;
    const ids = events.map((event) => event.eventId).filter(Boolean);
    const result = commitMonitorTransportTransition(
      hostname,
      current,
      { type: "dispatch-start", eventIds: ids, atMs: Date.now() }
    );
    if (result.outcome !== "ok") {
      return null;
    }
    return result.envelope;
  }
  function settleMonitorTransport(hostname, events, outcome, delivery) {
    const current = loadMonitorEnvelopeV1(hostname).envelope;
    const ids = events.map((event) => event.eventId).filter(Boolean);
    if (!current || ids.length === 0) {
      return { outcome: "missing-monitor-state" };
    }
    if (delivery.kind === "acknowledged") {
      return commitMonitorTransportTransition(
        hostname,
        current,
        { type: "acknowledge", eventIds: ids }
      );
    }
    if (delivery.kind === "uncertain") {
      return commitMonitorTransportTransition(
        hostname,
        current,
        {
          type: "uncertain",
          eventIds: ids,
          responseClass: delivery.responseClass
        }
      );
    }
    if (delivery.kind === "permanent") {
      return commitMonitorTransportTransition(
        hostname,
        current,
        {
          type: "failed",
          eventIds: ids,
          responseClass: delivery.responseClass || String(delivery.status || "permanent")
        }
      );
    }
    return commitMonitorTransportTransition(
      hostname,
      current,
      {
        type: "retry-attempt",
        eventIds: ids,
        attemptCount: (events[0].attemptCount || 0) + 1
      }
    );
  }
  function deliverChunkWithRetry(hostname, chunk, queueKind = "legacy") {
    const events = Array.isArray(chunk.events) ? chunk.events : [];
    const attempt = typeof chunk.attemptCount === "number" ? chunk.attemptCount : 0;
    function settle(outcome) {
      if (!isCurrentLeaseOwner() && outcome.errorClass !== "leader-lost") {
        outcome = {
          status: null,
          responseText: null,
          errorClass: "leader-lost",
          error: null,
          retryAfterMs: null
        };
      }
      const status = outcome.status;
      const delivery = outcome.delivery || classifyDiscordResponse(outcome);
      const isSuccess = delivery.kind === "acknowledged";
      if (outcome.errorClass === "configuration") {
        activeInFlightHosts.delete(hostname);
        console.warn(
          "[Alliance Discord] Batch delivery skipped for " + hostname + " (" + events.length + " events): no webhook configured. Queue preserved."
        );
        return;
      }
      if (outcome.errorClass === "leader-lost") {
        activeInFlightHosts.delete(hostname);
        console.warn(
          "[Alliance Discord] Leader lease lost for " + hostname + " — delivery paused; queue preserved."
        );
        return;
      }
      if (isSuccess) {
        console.log(
          `[Alliance Discord] Batch alert sent. Targets: ${events.length}, attacks: ${events.reduce(
            (sum, event) => sum + (event.attackCount || 0),
            0
          )}, raids: ${events.reduce(
            (sum, event) => sum + (event.raidCount || 0),
            0
          )}.`
        );
        if (queueKind === "monitor") {
          const persisted = settleMonitorTransport(hostname, events, outcome, delivery);
          if (persisted.outcome !== "ok") {
            activeInFlightHosts.delete(hostname);
            return;
          }
          activeInFlightHosts.delete(hostname);
          deliverNextMonitorInFlightChunk(hostname);
        } else {
          activeInFlightHosts.delete(hostname);
          savePendingBatch(
            dropInFlightHead(loadPendingBatch(), hostname),
            hostname
          );
          deliverNextInFlightChunk(hostname);
        }
        return;
      }
      if (delivery.kind === "uncertain" && queueKind === "monitor") {
        const persisted = settleMonitorTransport(hostname, events, outcome, delivery);
        activeInFlightHosts.delete(hostname);
        if (persisted.outcome === "ok") {
          reportLifecycleHook("onDiscordDeliveryUncertain", {
            atMs: Date.now(),
            eventCount: events.length,
            responseClass: delivery.responseClass
          });
          deliverNextMonitorInFlightChunk(hostname);
        }
        return;
      }
      const retryable = isRetryableOutcome(
        status,
        outcome.errorClass
      );
      if (retryable && attempt < MAX_ATTEMPT_COUNT - 1) {
        const nextAttempt = attempt + 1;
        const delay = sanitizeRetryDelay(
          outcome.retryAfterMs,
          RETRY_DELAY_MS[attempt] || 1e3
        );
        if (queueKind === "monitor") {
          const persisted = settleMonitorTransport(hostname, events, outcome, delivery);
          if (persisted.outcome !== "ok") {
            activeInFlightHosts.delete(hostname);
            return;
          }
        } else {
          savePendingBatch(
            replaceInFlightHeadAttempt(loadPendingBatch(), hostname, nextAttempt),
            hostname
          );
        }
        scheduleLifecycleTimeout(() => {
          if (!isCurrentLeaseOwner()) {
            settle({
              status: null,
              responseText: null,
              errorClass: "leader-lost",
              error: null,
              retryAfterMs: null
            });
            return;
          }
          deliverChunkWithRetry(hostname, {
            events: events.map((event) => Object.assign({}, event, {
              attemptCount: nextAttempt
            })),
            attemptCount: nextAttempt
          }, queueKind);
        }, delay);
        return;
      }
      const statusOrError = status !== null ? String(status) : String(
        outcome.errorClass || "network"
      );
      if (queueKind === "monitor") {
        const persisted = settleMonitorTransport(hostname, events, outcome, delivery);
        activeInFlightHosts.delete(hostname);
        if (persisted.outcome === "ok") {
          deliverNextMonitorInFlightChunk(hostname);
        }
        return;
      }
      const failedSaved = saveFailedBatch(
        enqueueFailedEvents(
          loadFailedBatch(),
          hostname,
          events,
          Date.now(),
          statusOrError
        ),
        hostname
      );
      if (!failedSaved) {
        activeInFlightHosts.delete(hostname);
        console.error(
          "[Alliance Discord] Failed queue write failed for " + hostname + " (" + events.length + " events, " + statusOrError + "): chunk kept in inFlight for a later retry instead of being lost."
        );
        return;
      }
      activeInFlightHosts.delete(hostname);
      savePendingBatch(
        dropInFlightHead(
          loadPendingBatch(),
          hostname
        ),
        hostname
      );
      console.error(
        "[Alliance Discord] Batch delivery failed for " + hostname + " (" + events.length + " events, " + statusOrError + "): " + (retryable ? "retries exhausted" : "permanent failure")
      );
      saveDiagnostics(
        recordFailure(
          loadDiagnostics(),
          hostname,
          Date.now(),
          statusOrError,
          events.length
        ),
        hostname
      );
      deliverNextInFlightChunk(hostname);
    }
    try {
      if (queueKind === "monitor") {
        if (!startMonitorDispatch(hostname, events)) {
          activeInFlightHosts.delete(hostname);
          return;
        }
      }
      sendDiscordBatch(events, settle);
    } catch (error) {
      settle({
        status: null,
        responseText: null,
        errorClass: "exception",
        error
      });
    }
  }
  function deliverNextInFlightChunk(hostname) {
    if (activeInFlightHosts.has(hostname)) {
      return;
    }
    const chunks = getInFlightChunks(
      loadPendingBatch(),
      hostname
    );
    if (chunks.length === 0) {
      return;
    }
    activeInFlightHosts.add(hostname);
    deliverChunkWithRetry(hostname, chunks[0]);
  }
  function deliverNextMonitorInFlightChunk(hostname) {
    if (activeInFlightHosts.has(hostname)) {
      return;
    }
    const envelope = loadMonitorEnvelopeV1(hostname).envelope;
    const chunk = envelope ? monitorTransportChunk(envelope) : null;
    if (!chunk) {
      return;
    }
    activeInFlightHosts.add(hostname);
    deliverChunkWithRetry(hostname, {
      events: chunk,
      attemptCount: chunk[0] && chunk[0].attemptCount || 0
    }, "monitor");
  }
  function flushPendingBatch() {
    if (!isCurrentLeaseOwner()) {
      return;
    }
    reportLifecycleHook("onFlushStart", { atMs: Date.now() });
    const hostname = normalizeHostname(location.hostname);
    const monitor = ensureMonitorEnvelopeForTransport(hostname);
    if (monitor) {
      let current = monitor;
      if (current.pending.length > 0) {
        const moved = commitMonitorTransportTransition(
          hostname,
          current,
          { type: "pending-to-inFlight" }
        );
        if (moved.outcome !== "ok") {
          return;
        }
        current = moved.envelope;
      }
      deliverNextMonitorInFlightChunk(hostname);
      return;
    }
    const batch = loadPendingBatch();
    const snapshot = snapshotBatch(batch, hostname);
    if (snapshot !== null) {
      let next = clearBatchEvents(batch, hostname);
      next = addInFlightChunk(next, hostname, {
        events: snapshot.events,
        attemptCount: 0
      });
      savePendingBatch(next, hostname);
    }
    deliverNextInFlightChunk(hostname);
  }
  function scheduleBatchFlush() {
    if (flushTimerId !== null) {
      return;
    }
    flushTimerId = scheduleLifecycleTimeout(() => {
      flushTimerId = null;
      if (!tabLeaseActive) {
        return;
      }
      flushPendingBatch();
      scheduleBatchFlush();
    }, BATCH_FLUSH_MS);
  }
  function initAdminPanel() {
    if (isNodeEnvironment || typeof document === "undefined") {
      return null;
    }
    const existingOpenButton = document.getElementById("taa-open-panel");
    const existingOverlay = document.getElementById(
      "taa-panel-overlay"
    );
    const existingPanelStyle = document.getElementById("taa-panel-style");
    if (existingOpenButton && existingOverlay && existingPanelStyle) {
      adminPanelOpener = () => existingOpenButton.click();
      return existingOverlay;
    }
    if (existingOpenButton) {
      document.body.removeChild(existingOpenButton);
    }
    if (existingOverlay) {
      document.body.removeChild(existingOverlay);
    }
    const hostname = normalizeHostname(location.hostname);
    const create = (tag) => document.createElement(tag);
    const append = (parent, child) => {
      parent.appendChild(child);
      return child;
    };
    const clear = (element) => {
      while (element.children && element.children.length > 0) {
        element.removeChild(element.children[0]);
      }
    };
    const style = (element, values) => {
      Object.assign(element.style, values);
      return element;
    };
    const text = (element, value) => {
      element.textContent = String(value);
      return element;
    };
    const makeSpan = (value, className) => {
      const element = create("span");
      if (className) {
        element.className = className;
      }
      return text(element, value);
    };
    const makeButton = (label, id, handler, className, buttonType = "button") => {
      const button = create("button");
      button.type = buttonType;
      button.textContent = label;
      button.id = id;
      button.className = className || "taa-button";
      button.addEventListener("click", (event) => {
        if (buttonType === "submit" && event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        handler(event);
      });
      return button;
    };
    const makeInput = (id, value, type = "text") => {
      const input = create("input");
      input.id = id;
      input.type = type;
      input.value = value === null || value === void 0 ? "" : String(value);
      input.className = "taa-input";
      return input;
    };
    const makeLabel = (caption, input, hintId = "") => {
      const label = create("label");
      label.className = "taa-label";
      label.setAttribute("for", input.id);
      if (hintId) {
        input.setAttribute("aria-describedby", hintId);
      }
      append(label, makeSpan(caption, "taa-label-text"));
      append(label, input);
      return label;
    };
    const makeSection = (id, title) => {
      const section = create("section");
      section.id = id;
      section.className = "taa-section";
      const heading = create("h2");
      heading.className = "taa-section-title";
      heading.id = id + "-title";
      append(section, text(heading, title));
      section.setAttribute("aria-labelledby", heading.id);
      return section;
    };
    const makeForm = (className) => {
      const form = create("form");
      form.className = className || "taa-form";
      form.addEventListener("submit", (event) => {
        if (event && typeof event.preventDefault === "function") {
          event.preventDefault();
        }
      });
      form.addEventListener("keydown", (event) => {
        if (!event || event.key !== "Enter" || event.isComposing) {
          return;
        }
        const target = event.target;
        if (!target || String(target.tagName || "").toLowerCase() !== "input") {
          return;
        }
        const submitButton = typeof form.querySelector === "function" ? form.querySelector('button[type="submit"]') : null;
        if (!submitButton || submitButton.disabled || typeof submitButton.click !== "function") {
          return;
        }
        if (typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        submitButton.click();
      });
      return form;
    };
    const makeFeedback = (id, polite = true) => {
      const element = create("p");
      element.id = id;
      element.className = "taa-feedback";
      element.setAttribute("role", polite ? "status" : "alert");
      element.setAttribute("aria-live", polite ? "polite" : "assertive");
      element.setAttribute("aria-atomic", "true");
      return element;
    };
    const makeTabList = (label, tabs) => {
      const nav = create("nav");
      nav.setAttribute("aria-label", label);
      const list = create("div");
      list.className = "taa-tabs";
      list.setAttribute("role", "tablist");
      list.setAttribute("aria-label", label);
      const buttons = [];
      tabs.forEach((tab, index) => {
        const button = makeButton(tab.label, tab.id, tab.onSelect);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", tab.panelId);
        button.setAttribute("aria-selected", tab.selected ? "true" : "false");
        button.tabIndex = tab.selected ? 0 : -1;
        buttons.push(button);
        append(list, button);
      });
      list.addEventListener("keydown", (event) => {
        if (!event || buttons.length === 0) {
          return;
        }
        const active = typeof document !== "undefined" ? document.activeElement : null;
        const current = buttons.indexOf(active);
        if (current === -1) {
          return;
        }
        let next = -1;
        if (event.key === "ArrowRight") {
          next = (current + 1) % buttons.length;
        } else if (event.key === "ArrowLeft") {
          next = (current - 1 + buttons.length) % buttons.length;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = buttons.length - 1;
        } else {
          return;
        }
        if (typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        const target = tabs[next];
        if (target && typeof target.onSelect === "function") {
          target.onSelect();
        }
        if (typeof document !== "undefined" && typeof document.getElementById === "function") {
          const selected = document.getElementById(target.id);
          if (selected && selected.getAttribute("aria-selected") === "true" && typeof selected.focus === "function") {
            try {
              selected.focus({ preventScroll: true });
            } catch (error) {
              selected.focus();
            }
          }
        }
      });
      append(nav, list);
      return nav;
    };
    const makeTabPanel = (id, tabId) => {
      const panelElement = create("section");
      panelElement.id = id;
      panelElement.setAttribute("role", "tabpanel");
      panelElement.setAttribute("aria-labelledby", tabId);
      panelElement.tabIndex = 0;
      return panelElement;
    };
    const makeStatusBanner = (heading, message, tone = "standby", assertive = false) => {
      const banner = create("div");
      banner.className = "taa-banner";
      banner.dataset.tone = tone;
      banner.setAttribute("role", assertive ? "alert" : "status");
      append(banner, makeSpan(heading, "taa-banner-heading"));
      append(banner, makeSpan(message, "taa-banner-message"));
      return banner;
    };
    const makeListRow = (value, action) => {
      const row = create("article");
      row.className = "taa-list-row";
      append(row, makeSpan(value, "taa-list-value"));
      if (action) {
        append(row, action);
      }
      return row;
    };
    const markInvalid = (input, invalid) => {
      if (!input || typeof input.setAttribute !== "function") {
        return;
      }
      if (invalid) {
        input.setAttribute("aria-invalid", "true");
      } else {
        input.removeAttribute("aria-invalid");
      }
    };
    const makeFieldError = (id) => {
      const element = create("p");
      element.id = id;
      element.className = "taa-feedback taa-field-error";
      element.setAttribute("role", "alert");
      element.hidden = true;
      return element;
    };
    const setFieldError = (input, errorElement, message) => {
      const invalid = Boolean(message);
      markInvalid(input, invalid);
      if (!errorElement || typeof errorElement.setAttribute !== "function") {
        return invalid;
      }
      if (invalid) {
        errorElement.textContent = message;
        errorElement.hidden = false;
        if (input && typeof input.setAttribute === "function") {
          input.setAttribute("aria-describedby", errorElement.id);
        }
      } else {
        errorElement.textContent = "";
        errorElement.hidden = true;
        if (input && typeof input.removeAttribute === "function") {
          input.removeAttribute("aria-describedby");
        }
      }
      return invalid;
    };
    const getWorldEntry = (map) => {
      const source = map && typeof map === "object" ? map : {};
      if (source[hostname] !== void 0) {
        return source[hostname];
      }
      const key = Object.keys(source).find(
        (item) => normalizeHostname(item) === hostname
      );
      return key === void 0 ? null : source[key];
    };
    const setFeedback = (message, isError) => {
      feedbackMessage = message;
      feedbackError = Boolean(isError);
      if (typeof feedback !== "undefined" && feedback) {
        feedback.textContent = feedbackMessage;
        feedback.dataset.tone = feedbackError ? "error" : "success";
        feedback.setAttribute("role", feedbackError ? "alert" : "status");
        feedback.setAttribute("aria-live", feedbackError ? "assertive" : "polite");
      }
    };
    const readPanelNumber = (input) => {
      const raw = String(input.value || "").trim();
      if (raw === "") {
        return null;
      }
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    };
    let feedbackMessage = "";
    let feedbackError = false;
    const openButton = create("button");
    openButton.id = "taa-open-panel";
    openButton.className = "taa-button taa-open-button";
    openButton.type = "button";
    openButton.textContent = "Alert monitor";
    openButton.setAttribute("aria-expanded", "false");
    openButton.setAttribute("aria-controls", "taa-panel");
    const overlay = create("div");
    overlay.id = "taa-panel-overlay";
    overlay.className = "taa-overlay";
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
    const panel = create("div");
    panel.id = "taa-panel";
    panel.className = "taa-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "taa-panel-title");
    panel.setAttribute("tabindex", "-1");
    const header = create("div");
    header.id = "taa-panel-header";
    header.className = "taa-panel-header";
    const panelTitle = create("h1");
    panelTitle.className = "taa-panel-title";
    text(
      panelTitle,
      "Alliance alert monitor"
    );
    panelTitle.id = "taa-panel-title";
    append(header, panelTitle);
    const closeButton = makeButton(
      "Close",
      "taa-panel-close",
      () => requestPanelExit2("close"),
      "taa-button taa-close-button"
    );
    append(header, closeButton);
    const feedback = makeFeedback("taa-feedback");
    const content = create("div");
    content.id = "taa-panel-content";
    content.className = "taa-panel-content";
    append(panel, header);
    append(panel, feedback);
    append(panel, content);
    append(overlay, panel);
    let bodyScrollLock = null;
    let returnFocusElement = null;
    let backfillController = null;
    let panelEpoch = 0;
    let historyEpoch = 0;
    let exitConfirmation = null;
    let pendingPanelExit = null;
    let adminDraftDirty = false;
    let panelDraftScope = normalizeAdminDraftScope(null);
    let restoredDraftFocus = false;
    let lastDraftFocus = null;
    cancelPanelAsyncWork = () => {
      panelEpoch += 1;
      historyEpoch += 1;
      if (backfillController) {
        backfillController.abort();
        backfillController = null;
      }
    };
    const lockBodyScroll = () => {
      const body = document.body;
      if (!body || !body.style || bodyScrollLock !== null) {
        return;
      }
      bodyScrollLock = {
        body,
        overflow: body.style.overflow,
        overscrollBehavior: body.style.overscrollBehavior
      };
      body.style.overflow = "hidden";
      body.style.overscrollBehavior = "none";
    };
    const unlockBodyScroll = () => {
      if (bodyScrollLock === null) {
        return;
      }
      const { body } = bodyScrollLock;
      if (body && body.style) {
        body.style.overflow = bodyScrollLock.overflow;
        body.style.overscrollBehavior = bodyScrollLock.overscrollBehavior;
      }
      bodyScrollLock = null;
    };
    const getFocusableElements = () => {
      if (typeof panel.querySelectorAll !== "function") {
        return [];
      }
      return Array.from(panel.querySelectorAll(
        "button, input, select, textarea, a[href], [tabindex]"
      )).filter((element) => element && !element.hidden && !element.disabled && element.getAttribute("aria-hidden") !== "true" && element.getAttribute("tabindex") !== "-1");
    };
    const trapPanelFocus = (event) => {
      if (!event || event.key !== "Tab" || overlay.style.display === "none") {
        return;
      }
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        if (typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        if (typeof panel.focus === "function") {
          panel.focus();
        }
        return;
      }
      const activeElement = document.activeElement;
      const activeIndex = focusable.indexOf(activeElement);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
      const shouldWrapForward = !event.shiftKey && (activeIndex === focusable.length - 1 || activeIndex === -1);
      if (!shouldWrapBackward && !shouldWrapForward) {
        return;
      }
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      const nextElement = shouldWrapBackward ? last : first;
      if (nextElement && typeof nextElement.focus === "function") {
        nextElement.focus();
      }
    };
    const closePanel = () => {
      const wasOpen = overlay.style.display !== "none";
      overlay.style.display = "none";
      overlay.setAttribute("aria-hidden", "true");
      openButton.setAttribute("aria-expanded", "false");
      openButton.hidden = false;
      openButton.disabled = false;
      openButton.removeAttribute("aria-hidden");
      unlockBodyScroll();
      if (typeof cancelPanelAsyncWork === "function") cancelPanelAsyncWork();
      if (panelRuntimeTimerId !== null) {
        clearTimeout(panelRuntimeTimerId);
        panelRuntimeTimerId = null;
      }
      if (!wasOpen) {
        return;
      }
      const focusTarget = returnFocusElement || openButton;
      returnFocusElement = null;
      if (focusTarget && typeof focusTarget.focus === "function") {
        focusTarget.focus();
      }
    };
    const openPanel = () => {
      if (overlay.style.display !== "none") {
        return;
      }
      returnFocusElement = openButton;
      overlay.style.display = "block";
      overlay.setAttribute("aria-hidden", "false");
      openButton.setAttribute("aria-expanded", "true");
      openButton.hidden = true;
      openButton.disabled = true;
      openButton.setAttribute("aria-hidden", "true");
      lockBodyScroll();
      renderPanel();
      const tick = () => {
        panelRuntimeTimerId = null;
        if (overlay.style.display === "none") return;
        if (typeof panelRuntimeUpdater === "function") panelRuntimeUpdater();
        panelRuntimeTimerId = setTimeout(tick, 1e3);
      };
      tick();
      if (adminTab === "players" && pendingBackfillIds.length > 0) {
        triggerNameBackfill(hostname, pendingBackfillIds);
      }
      const draftFocus = adminDraft && adminDraft.focus && adminDraft.focus.id ? document.getElementById(adminDraft.focus.id) : null;
      if (draftFocus && !draftFocus.hidden && typeof draftFocus.focus === "function") {
        try {
          draftFocus.focus({ preventScroll: true });
        } catch (error) {
          draftFocus.focus();
        }
        if (supportsInputSelection(draftFocus)) {
          try {
            draftFocus.setSelectionRange(adminDraft.focus.start, adminDraft.focus.end);
          } catch (error) {
          }
        }
      } else if (!restoredDraftFocus && typeof closeButton.focus === "function") {
        closeButton.focus();
      }
    };
    try {
      const styleHost = document.head || document.body;
      if (styleHost) {
        const panelStyle = existingPanelStyle || create("style");
        panelStyle.id = "taa-panel-style";
        panelStyle.textContent = `
                    #taa-open-panel, #taa-panel-overlay {
                        --taa-launcher-surface: #26384a;
                        --taa-launcher-text: #ffe8a6;
                        --taa-launcher-border: #d7a23a;
                        --taa-launcher-focus: #ffe8a6;
                        --taa-launcher-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
                    }
                    #taa-panel-overlay {
                        --ta-bg: #080d14; --ta-overlay-alpha: .78;
                        --ta-surface: #101923; --ta-surface-raised: #14212d;
                        --ta-surface-input: #182633; --ta-surface-control: #26384a;
                        --ta-border: #40536a; --ta-border-subtle: #53677c; --ta-border-strong: #65798e;
                        --ta-text: #edf3f7; --ta-text-muted: #a9d6a1; --ta-text-disabled: #82909b;
                        --ta-accent: #d7a23a; --ta-accent-hover: #ffe8a6;
                        --ta-accent-olive: #9aa66f; --ta-accent-olive-strong: #c2cc8b;
                        --ta-status-red: #ffb4ab; --ta-status-red-strong: #ff8f86;
                        --ta-status-amber: #f5c36b; --ta-status-amber-strong: #d99a2b;
                        --ta-status-green: #a9d6a1; --ta-status-green-strong: #77b56f;
                        --ta-focus-ring: #ffe8a6; --ta-on-accent: #101923;
                        --ta-border-width: 1px; --ta-focus-width: 2px; --ta-panel-max: 940px;
                        --ta-space-1: 4px; --ta-space-2: 8px; --ta-space-3: 12px; --ta-space-4: 16px;
                        --ta-space-5: 20px; --ta-space-6: 24px; --ta-space-8: 32px;
                        --ta-radius-control: 6px; --ta-radius-section: 8px; --ta-radius-dialog: 12px;
                        --ta-font-system: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
                        --ta-font-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
                        --ta-text-xs: .6875rem; --ta-text-sm: .75rem; --ta-text-md: .8125rem;
                        --ta-text-body: .875rem; --ta-text-lg: 1.0625rem; --ta-leading-tight: 1.2;
                        --ta-leading-body: 1.45; --ta-label-tracking: .02em;
                        --ta-duration-micro: 120ms; --ta-duration-standard: 220ms; --ta-press-y: 1px;
                        --ta-shadow-section: 0 4px 12px rgba(0,0,0,.18);
                        --ta-shadow-dialog: 0 24px 70px rgba(0,0,0,.5);
                        position: fixed; inset: 0; z-index: 2147482999; overflow-y: auto; overflow-x: hidden;
                        overscroll-behavior: contain; padding: clamp(var(--ta-space-4), 4vw, var(--ta-space-8)) clamp(var(--ta-space-3), 4vw, var(--ta-space-6));
                        background: color-mix(in srgb, var(--ta-bg) calc(var(--ta-overlay-alpha) * 100%), transparent); color: var(--ta-text);
                        font: var(--ta-text-body)/var(--ta-leading-body) var(--ta-font-system);
                    }
                    #taa-panel-overlay * { box-sizing: border-box; min-inline-size: 0; }
                    #taa-panel { inline-size: min(var(--ta-panel-max), 100%); margin: 0 auto; padding: clamp(var(--ta-space-4), 3vw, var(--ta-space-6)); border: var(--ta-border-width) solid var(--ta-border); border-radius: var(--ta-radius-dialog); background: var(--ta-surface); color: var(--ta-text); box-shadow: var(--ta-shadow-dialog); min-block-size: 0; }
                     #taa-open-panel, #taa-panel-overlay .taa-button { border: var(--ta-border-width) solid var(--ta-accent); border-radius: var(--ta-radius-control); padding: var(--ta-space-2) var(--ta-space-3); background: var(--ta-surface-control); color: var(--ta-accent-hover); font: inherit; font-weight: 700; line-height: var(--ta-leading-tight); cursor: pointer; transition: background-color var(--ta-duration-micro) ease-out, color var(--ta-duration-micro) ease-out, transform var(--ta-duration-micro) ease-out; }
                     #taa-open-panel { position: fixed; inset: auto 16px 16px auto; z-index: 2147483000; display: inline-flex; visibility: visible; opacity: 1; appearance: none; min-width: 96px; min-height: 36px; border: 1px solid #d7a23a; border-radius: 6px; padding: 8px 12px; background: #26384a; color: #ffe8a6; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.2; outline: 2px solid #ffe8a6; }
                     #taa-open-panel:focus-visible { outline: 2px solid #ffe8a6; outline-offset: 2px; }
                    #taa-panel-overlay .taa-button:hover, #taa-panel-overlay .taa-button:focus-visible, #taa-open-panel:hover { background: var(--ta-border); border-color: var(--ta-accent-hover); color: var(--ta-accent-hover); }
                    #taa-panel-overlay .taa-button:active, #taa-open-panel:active { transform: translateY(var(--ta-press-y)); }
                    #taa-panel-overlay .taa-button:disabled { border-color: var(--ta-border); color: var(--ta-text-disabled); background: var(--ta-surface); cursor: not-allowed; }
                    #taa-panel-overlay .taa-small-button { flex: 0 0 auto; padding: var(--ta-space-1) var(--ta-space-2); font-size: var(--ta-text-xs); }
                    #taa-panel-overlay .taa-input { inline-size: 100%; padding: var(--ta-space-2) var(--ta-space-3); border: var(--ta-border-width) solid var(--ta-border-strong); border-radius: var(--ta-radius-control); background: var(--ta-surface-input); color: var(--ta-text); caret-color: var(--ta-accent-hover); font: inherit; }
                    #taa-panel-overlay .taa-input:focus-visible { outline: var(--ta-focus-width) solid var(--ta-focus-ring); outline-offset: var(--ta-space-1); border-color: var(--ta-accent-hover); }
                    #taa-panel-overlay .taa-button:focus-visible, #taa-panel-overlay [role="tab"]:focus-visible, #taa-open-panel:focus-visible { outline: var(--ta-focus-width) solid var(--ta-focus-ring); outline-offset: var(--ta-space-1); }
                     #taa-panel-overlay .taa-input[aria-invalid="true"] { border-color: var(--ta-status-red); }
                     #taa-panel-overlay .taa-field-error { margin: 0; color: var(--ta-status-red); font-size: var(--ta-text-sm); line-height: var(--ta-leading-body); overflow-wrap: anywhere; }
                    #taa-panel-overlay .taa-label { display: grid; gap: var(--ta-space-2); color: var(--ta-text); }
                    #taa-panel-overlay .taa-label-text { color: var(--ta-text-muted); font-family: var(--ta-font-mono); font-size: var(--ta-text-xs); font-weight: 700; letter-spacing: var(--ta-label-tracking); }
                    #taa-panel-overlay .taa-tabs { display: flex; flex-wrap: wrap; gap: var(--ta-space-2); border-block-end: var(--ta-border-width) solid var(--ta-border); margin-block-end: var(--ta-space-3); }
                    #taa-panel-overlay [role="tab"] { border: 0; border-block-end: var(--ta-space-1) solid transparent; border-radius: var(--ta-radius-control) var(--ta-radius-control) 0 0; padding: var(--ta-space-2) var(--ta-space-3); background: transparent; color: var(--ta-text-muted); }
                    #taa-panel-overlay [role="tab"]:hover, #taa-panel-overlay [role="tab"][aria-selected="true"] { border-color: var(--ta-accent); background: var(--ta-surface-control); color: var(--ta-accent-hover); }
                    #taa-panel-overlay [role="tab"]:disabled { color: var(--ta-text-disabled); }
                    #taa-panel-overlay .taa-section { display: grid; gap: var(--ta-space-3); padding: var(--ta-space-4); border: var(--ta-border-width) solid var(--ta-border); border-radius: var(--ta-radius-section); background: var(--ta-surface-raised); box-shadow: var(--ta-shadow-section); min-block-size: 0; }
                    #taa-panel-overlay .taa-section-title { margin: 0; color: var(--ta-accent-hover); font-size: var(--ta-text-md); line-height: var(--ta-leading-tight); }
                     #taa-panel-overlay .taa-form, #taa-panel-overlay .taa-stats, #taa-panel-overlay .taa-diagnostics-block, #taa-panel-overlay .taa-status { display: grid; gap: var(--ta-space-3); min-block-size: 0; }
                     #taa-panel-content { display: flex; flex-direction: column; gap: var(--ta-space-3); min-block-size: 0; }
                    #taa-panel-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--ta-space-3); margin-block-end: var(--ta-space-4); min-block-size: 0; }
                    #taa-panel-title { margin: 0; color: var(--ta-accent-hover); font-size: var(--ta-text-lg); line-height: var(--ta-leading-tight); overflow-wrap: anywhere; }
                    #taa-feedback { min-block-size: var(--ta-space-6); margin-block-end: var(--ta-space-4); overflow-wrap: anywhere; }
                    #taa-feedback[data-tone="error"] { color: var(--ta-status-red); } #taa-feedback[data-tone="success"] { color: var(--ta-status-green); }
                    #taa-panel-content > * { min-block-size: 0; }
                    #taa-panel-overlay .taa-list, #taa-panel-overlay .taa-history-rows { display: grid; gap: var(--ta-space-2); margin-block-start: var(--ta-space-3); padding: 0; list-style: none; }
                    #taa-panel-overlay .taa-list-row, #taa-panel-overlay .taa-history-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--ta-space-3); padding-block: var(--ta-space-2); border-block-start: var(--ta-border-width) solid var(--ta-border-subtle); min-block-size: 0; }
                    #taa-panel-overlay .taa-list-row:first-child, #taa-panel-overlay .taa-history-row:first-child { border-block-start: 0; }
                    #taa-panel-overlay .taa-list-value, #taa-panel-overlay .taa-history-value, #taa-panel-overlay .taa-stat, #taa-panel-overlay .taa-role-current { min-inline-size: 0; color: var(--ta-text); overflow-wrap: anywhere; word-break: break-word; }
                    #taa-panel-overlay .taa-empty { display: block; color: var(--ta-text-muted); text-align: center; }
                    #taa-panel-overlay .taa-banner { display: grid; gap: var(--ta-space-1); padding: var(--ta-space-3); border: var(--ta-border-width) solid var(--ta-border-subtle); background: var(--ta-surface-input); overflow-wrap: anywhere; }
                    #taa-panel-overlay .taa-banner[data-tone="error"] { border-color: var(--ta-status-red-strong); } #taa-panel-overlay .taa-banner[data-tone="warning"] { border-color: var(--ta-status-amber-strong); } #taa-panel-overlay .taa-banner[data-tone="standby"] { border-color: var(--ta-accent-olive); }
                    #taa-panel-overlay .taa-actions { display: flex; flex-wrap: wrap; gap: var(--ta-space-2); }
                    #taa-panel-overlay .taa-metric, #taa-panel-overlay .taa-field-group { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: var(--ta-space-2); }
                    #taa-panel-overlay .taa-metric .taa-label-text::after { content: ':'; }
                    #taa-panel-overlay .taa-row-actions { display: inline-flex; flex-wrap: nowrap; align-items: center; margin-inline-start: auto; }
                    #taa-panel-overlay .taa-panel-header, #taa-panel-overlay .taa-panel-content { min-inline-size: 0; }
                     @media (min-width: 768px) { #taa-panel-overlay .taa-overview-metrics { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); } }
                    @media (prefers-reduced-motion: reduce) { #taa-panel-overlay *, #taa-panel-overlay *::before, #taa-panel-overlay *::after { scroll-behavior: auto !important; transition-duration: 0ms !important; animation-duration: 0ms !important; animation-iteration-count: 1 !important; } #taa-panel-overlay .taa-button:active, #taa-open-panel:active { transform: none; } }
                    @media (forced-colors: active) { #taa-panel-overlay, #taa-panel, #taa-panel-overlay .taa-section, #taa-panel-overlay .taa-input, #taa-panel-overlay .taa-button { forced-color-adjust: auto; border: var(--ta-border-width) solid ButtonText; box-shadow: none; } #taa-panel-overlay :where(button, input):focus-visible { outline: var(--ta-focus-width) solid Highlight; } #taa-panel-overlay .taa-button { background: ButtonFace; color: ButtonText; } }
                `;
        if (!panelStyle.parentNode) {
          append(styleHost, panelStyle);
        }
      }
    } catch (error) {
      console.error("[Alliance Discord] Panel style injection failed.", error);
    }
    let adminTab = "overview";
    let adminBooted = false;
    let adminDraft = createAdminDraftState(adminTab, {});
    let draftStorageFailed = false;
    let draftStorageDenied = false;
    const draftKey = (tab) => "taa-draft:" + hostname + ":" + tab;
    const readDraftStorage = () => {
      draftStorageDenied = false;
      return readSessionStorageSafely(
        typeof window === "undefined" ? null : window,
        () => {
          draftStorageDenied = true;
        }
      );
    };
    const captureDraft = () => {
      const fields = {};
      content.querySelectorAll("input, select, textarea").forEach((input) => {
        if (!input.id || /webhook|token|secret/i.test(input.id)) return;
        fields[input.id] = input.type === "checkbox" ? input.checked ? "true" : "false" : input.value;
      });
      const active = document.activeElement;
      const focus = active && active.id && String(active.id).indexOf("taa-") === 0 && active.tagName === "INPUT" ? { id: active.id, start: active.selectionStart || 0, end: active.selectionEnd || 0 } : lastDraftFocus;
      const query = fields["taa-player-search"] || panelDraftScope.query || "";
      const filters = {};
      for (const key of ["mapped", "unmapped", "muted", "orphaned"]) {
        if (fields["taa-filter-" + key] !== void 0) filters[key] = fields["taa-filter-" + key] === "true";
      }
      return createAdminDraftState(adminTab, fields, focus, Object.assign({}, panelDraftScope, {
        query,
        filters: Object.keys(filters).length ? filters : panelDraftScope.filters
      }));
    };
    const persistDraft = () => {
      const storage = readDraftStorage();
      if (!storage) {
        draftStorageFailed = draftStorageDenied;
        return draftStorageDenied ? { ok: false, outcome: "storage-failed" } : { ok: true, outcome: "unavailable" };
      }
      const result = persistAdminDraft(storage, draftKey(adminTab), captureDraft());
      draftStorageFailed = !result.ok;
      return result;
    };
    const restoreDraft = () => {
      const storage = readDraftStorage();
      if (!storage) {
        draftStorageFailed = draftStorageDenied;
        return null;
      }
      const result = restoreAdminDraft(storage, draftKey(adminTab));
      draftStorageFailed = !result.ok;
      if (result.ok && result.draft) panelDraftScope = normalizeAdminDraftScope(result.draft.scope);
      return result.ok ? result.draft : null;
    };
    const mutationAllowed = () => Boolean(tabLeaseActive);
    const persistLocal = (key, expected, message) => {
      try {
        if (typeof localStorage === "undefined") throw new Error("storage unavailable");
        localStorage.setItem(key, expected);
        if (localStorage.getItem(key) !== expected) throw new Error("readback mismatch");
        setFeedback(message, false);
        return { ok: true, outcome: "persisted" };
      } catch (error) {
        setFeedback("Could not save changes; your values are still here.", true);
        return { ok: false, outcome: "storage-failed", error };
      }
    };
    const makeMetric = (label, value, id) => {
      const item = create("div");
      item.className = "taa-stat taa-metric";
      append(item, makeSpan(label, "taa-label-text"));
      append(item, makeSpan(value, "taa-list-value")).id = id || "";
      return item;
    };
    const setDraftFields = (draft) => {
      if (!draft || !draft.fields) return;
      Object.keys(draft.fields).forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.value = draft.fields[id];
      });
      Object.keys(draft.fields).forEach((id) => {
        const input = document.getElementById(id);
        if (input && input.type === "checkbox") input.checked = draft.fields[id] === "true";
      });
      if (draft.focus && draft.focus.id) {
        const input = document.getElementById(draft.focus.id);
        const active = document.activeElement;
        const activeInteraction = active && active !== document.body && active !== panel && active !== openButton && active !== input;
        if (input && !activeInteraction) {
          if (typeof input.focus === "function") {
            try {
              input.focus({ preventScroll: true });
            } catch (error) {
              input.focus();
            }
          }
          if (supportsInputSelection(input)) {
            try {
              input.setSelectionRange(draft.focus.start, draft.focus.end);
            } catch (error) {
            }
          }
          restoredDraftFocus = true;
          lastDraftFocus = { id: input.id, start: draft.focus.start, end: draft.focus.end };
        }
      }
    };
    const clearExitConfirmation = () => {
      if (exitConfirmation && exitConfirmation.parentNode) exitConfirmation.parentNode.removeChild(exitConfirmation);
      exitConfirmation = null;
      pendingPanelExit = null;
    };
    const performPanelExit = (reason, continuation) => {
      clearExitConfirmation();
      adminDraftDirty = false;
      if (typeof continuation === "function") return continuation();
      if (reason === "reload") return false;
      closePanel();
      return true;
    };
    const showExitConfirmation = (reason, continuation) => {
      clearExitConfirmation();
      pendingPanelExit = { reason, continuation };
      const group = create("section");
      group.id = "taa-panel-exit-confirmation";
      group.className = "taa-banner taa-exit-confirmation";
      group.setAttribute("role", "alert");
      group.setAttribute("aria-live", "assertive");
      const isReload = reason === "reload";
      append(group, makeSpan("Unsaved panel work", "taa-banner-heading"));
      append(group, makeSpan(isReload ? "Save or discard the draft before reloading." : "Save or discard the draft before leaving this panel.", "taa-banner-message"));
      const actions = create("div");
      actions.className = "taa-actions";
      const save = makeButton("Save", "taa-exit-save", () => {
        const result = persistDraft();
        if (!result.ok) {
          setFeedback("Draft storage failed. Your values remain here; choose another action.", true);
          return;
        }
        performPanelExit(reason, continuation);
      }, "taa-button");
      const discard = makeButton("Discard", "taa-exit-discard", () => {
        try {
          const storage = readDraftStorage();
          if (storage) storage.removeItem(draftKey(adminTab));
        } catch (error) {
          setFeedback("Could not discard the draft safely.", true);
          return;
        }
        performPanelExit(reason, continuation);
      }, "taa-button");
      append(actions, save);
      append(actions, discard);
      if (isReload) {
        append(actions, makeButton("Reload", "taa-exit-reload", () => performPanelExit(reason, continuation), "taa-button"));
      } else {
        append(actions, makeButton("Cancel", "taa-exit-cancel", () => clearExitConfirmation(), "taa-button"));
      }
      append(group, actions);
      exitConfirmation = group;
      append(panel, group);
      setFeedback(isReload ? "Reload blocked until draft is saved, discarded, or explicitly reloaded." : "Exit blocked until draft is saved, discarded, or cancelled.", true);
      if (typeof save.focus === "function") save.focus();
    };
    const requestPanelExit2 = (reason, continuation) => {
      const result = resolvePanelExit(reason, adminDraftDirty, null);
      if (result.proceed) return performPanelExit(reason, continuation);
      const persisted = persistDraft();
      const finalResult = resolvePanelExit(reason, adminDraftDirty, persisted);
      if (finalResult.proceed) return performPanelExit(reason, continuation);
      showExitConfirmation(reason, continuation);
      return false;
    };
    adminPanelRequestExit = requestPanelExit2;
    const retryFailed = () => {
      if (!mutationAllowed()) {
        setFeedback("Standby is read-only.", true);
        return { outcome: "read-only" };
      }
      const current = loadMonitorEnvelopeV1(hostname).envelope;
      if (!current || current.failed.length === 0) return { outcome: "nothing-to-retry" };
      const result = commitMonitorQueueTransitionV1({ world: hostname, currentEnvelope: current, transition: { type: "requeue-failed" }, beforeCommit: mutationAllowed });
      if (result.outcome !== "ok") {
        setFeedback("Could not retry failed delivery.", true);
        return result;
      }
      setFeedback("Failed delivery requeued; retry may duplicate.", false);
      renderPanel();
      return result;
    };
    const retryUncertain = () => {
      if (!mutationAllowed()) {
        setFeedback("Standby is read-only.", true);
        return { outcome: "read-only" };
      }
      const current = loadMonitorEnvelopeV1(hostname).envelope;
      if (!current || current.uncertain.length === 0) return { outcome: "nothing-to-retry" };
      const eventIds = current && current.uncertain ? current.uncertain.map((event) => event.eventId) : [];
      const result = commitMonitorQueueTransitionV1({ world: hostname, currentEnvelope: current, transition: { type: "retry", eventIds }, beforeCommit: mutationAllowed });
      if (result.outcome !== "ok") {
        setFeedback("Could not retry uncertain delivery.", true);
        return result;
      }
      setFeedback("Uncertain delivery requeued; retry may duplicate.", false);
      renderPanel();
      return result;
    };
    const markUncertainDelivered = () => {
      if (!mutationAllowed()) {
        setFeedback("Standby is read-only.", true);
        return { outcome: "read-only" };
      }
      const current = loadMonitorEnvelopeV1(hostname).envelope;
      if (!current || current.uncertain.length === 0) return { outcome: "nothing-to-mark" };
      const eventIds = current && current.uncertain ? current.uncertain.map((event) => event.eventId) : [];
      const result = commitMonitorQueueTransitionV1({ world: hostname, currentEnvelope: current, transition: { type: "acknowledge-uncertain", eventIds }, beforeCommit: mutationAllowed });
      if (result.outcome !== "ok") {
        setFeedback("Could not mark uncertain delivery.", true);
        return result;
      }
      setFeedback("Uncertain delivery marked delivered.", false);
      renderPanel();
      return result;
    };
    const flushAlerts = async () => {
      if (!mutationAllowed()) {
        setFeedback("Standby is read-only.", true);
        return { outcome: "read-only" };
      }
      await Promise.resolve(flushPendingBatch());
      setFeedback("Flush settled.", false);
      return { outcome: "ok" };
    };
    const loadDiagnosticsHistory = (onLoaded) => {
      const requestEpoch = ++historyEpoch;
      const history = getWorldEntry(loadHistory());
      const events = history && history.events || [];
      const stats = buildStatsPanelModel(aggregateHistory(events, Date.now()));
      const result = { events, stats };
      if (typeof onLoaded !== "function") return result;
      if (requestEpoch !== historyEpoch || adminTab !== "diagnostics" || overlay.style.display === "none") return null;
      if (typeof onLoaded === "function") onLoaded(result);
      return result;
    };
    const toggleDebugDetails = () => {
      const enabled = saveDebugVerbose(!loadDebugVerbose());
      setFeedback(enabled ? "Debug details enabled." : "Could not save debug details.", !enabled);
      return enabled;
    };
    adminRecoveryActions = { retryFailed, retryUncertain, markUncertainDelivered, flushAlerts, loadDiagnosticsHistory, toggleDebugDetails };
    const renderWorkspace = () => {
      const tabs = ["overview", "players", "alerts", "diagnostics"];
      restoredDraftFocus = false;
      if (adminTab !== "players") pendingBackfillIds = [];
      const restoredDraft = restoreDraft();
      if (restoredDraft) {
        adminDraft = restoredDraft;
        panelDraftScope = normalizeAdminDraftScope(restoredDraft.scope);
      }
      const state = loadMonitorEnvelopeV1(hostname);
      const envelope = state && state.envelope ? state.envelope : null;
       const failed = envelope && envelope.failed || [];
       const uncertain = envelope && envelope.uncertain || [];
       const runtimeDiag = getWorldEntry(loadDiagnostics()) || {};
       const diagnosticsV2 = loadDiagnosticsV2();
       const traceWorld = diagnosticsV2[diagnosticDigest(hostname)] || {};
       const traces = Array.isArray(traceWorld.records) ? traceWorld.records : [];
       const reconciliation = buildCountReconciliationPanelModel({ envelope, diagnostics: runtimeDiag, traces, routeRole: classifyAllianceRoute(location.href).role });
      clear(content);
      const tabNav = makeTabList("Monitor views", tabs.map((tab) => ({ label: tab[0].toUpperCase() + tab.slice(1), id: "taa-tab-" + tab, panelId: "taa-tabpanel-" + tab, selected: adminTab === tab, onSelect: () => requestPanelExit2("tab", () => {
        if (tab !== "players" && backfillController) {
          backfillController.abort();
          backfillController = null;
          panelEpoch += 1;
        }
        if (tab !== "diagnostics") historyEpoch += 1;
        adminTab = tab;
        try {
          if (sessionStorage) sessionStorage.setItem("taa-active-tab:" + hostname, tab);
        } catch (error) {
        }
        renderPanel();
      }) })));
      append(content, tabNav);
      const panelView = makeTabPanel("taa-tabpanel-" + adminTab, "taa-tab-" + adminTab);
      append(content, panelView);
      const readOnly = !mutationAllowed();
      const panelLeaseBanner = makeStatusBanner(readOnly ? "Standby" : "Leader", readOnly ? "This follower is read-only. Monitoring and configuration writes are disabled." : "This tab owns monitoring and transport.", readOnly ? "standby" : "success");
      panelLeaseBanner.dataset.taaStandbyBanner = "true";
      append(panelView, panelLeaseBanner);
      if (adminTab === "overview") {
        const section = makeSection("taa-overview", "Overview");
        const grid = create("div");
        grid.className = "taa-stats";
        const metrics = envelope && envelope.metrics || {};
        const pending = envelope && envelope.pending || [];
        const inFlight = envelope && envelope.inFlight || [];
        append(grid, makeMetric("Last authoritative observation", runtimeDiag.observedAtMs || metrics.lastAuthoritativeScanAtMs ? new Date(runtimeDiag.observedAtMs || metrics.lastAuthoritativeScanAtMs).toLocaleString() : "Not recorded", "taa-last-observation-value"));
        append(grid, makeMetric("Next refresh", nextReloadAtMs ? Math.max(0, Math.ceil((nextReloadAtMs - Date.now()) / 1e3)) + "s" : "Not scheduled", "taa-next-refresh-value"));
        append(grid, makeMetric("Queue / in flight", pending.length + " / " + inFlight.length, "taa-queue-count-value"));
        append(grid, makeMetric("Failed / uncertain", envelope ? envelope.failed.length + " / " + envelope.uncertain.length : "0 / 0", "taa-failure-count-value"));
        append(grid, makeMetric("Storage health", state && state.outcome ? state.outcome : "Unavailable", "taa-storage-health-value"));
        append(grid, makeMetric("Scan duration", runtimeDiag.timings && runtimeDiag.timings.scanMs != null ? runtimeDiag.timings.scanMs + "ms" : metrics.timings && metrics.timings.scanMs != null ? metrics.timings.scanMs + "ms" : "Not recorded", "taa-scan-duration-value"));
        append(grid, makeMetric("Queue age", pending[0] && pending[0].observedAtMs ? Math.max(0, Date.now() - pending[0].observedAtMs) + "ms" : "0ms", "taa-queue-age-value"));
        append(grid, makeMetric("Last sent", runtimeDiag.dispatchedAtMs ? new Date(runtimeDiag.dispatchedAtMs).toLocaleString() : "Not recorded", "taa-last-sent-value"));
        const observedAtMs = Number(runtimeDiag.observedAtMs) || Number(metrics.lastAuthoritativeScanAtMs) || 0;
         append(grid, makeMetric("Freshness", describeFreshnessState(observedAtMs, Date.now()), "taa-freshness-value"));
         append(grid, makeMetric("Scan result", reconciliation.scanLabel, "taa-overview-scan-result-value"));
        append(section, grid);
        append(panelView, section);
      } else if (adminTab === "players") {
        const section = makeSection("taa-players", "Players and mappings");
        append(section, makeStatusBanner("Storage provenance", storageProvenanceText(buildStorageProvenanceModel(hostname)).join(" "), "info"));
        const rawMappings = loadMappings();
        const worldMappings = rawMappings[hostname] && typeof rawMappings[hostname] === "object" ? rawMappings[hostname] : {};
        const mutedWorld = listMutedPlayers(loadMutedPlayers(), hostname);
        const idToName = buildIdToName(loadPlayerNames(), hostname);
        const snapshot = parseMemberSnapshot(document, Date.now());
        const workspace = () => buildPlayerWorkspaceReadModel({
          snapshot,
          cachedRoster: loadRoster()[hostname],
          mappings: worldMappings,
          muted: mutedWorld,
          cachedNames: Object.fromEntries(idToName.entries())
        });
        const model = workspace();
        if (model.rosterStatus !== "authoritative") append(section, makeStatusBanner(
          model.rosterStatus === "cached" ? "Cached roster" : "Roster unavailable",
          model.rosterStatusText,
          model.rosterStatus === "cached" ? "warning" : "error"
        ));
        pendingBackfillIds = collectUnknownIds(worldMappings, mutedWorld, idToName, buildNotFoundIdSet(loadPlayerNamesNotFound(), hostname, Date.now()));
        const countStrip = create("dl");
        countStrip.id = "taa-player-count-strip";
        countStrip.className = "taa-count-strip";
        for (const [label, key] of [["Monitored", "monitored"], ["Mapped", "mapped"], ["Unmapped", "unmapped"], ["Muted", "muted"], ["Orphaned", "orphaned"]]) {
          const item = create("div");
          const dt = create("dt");
          const dd = create("dd");
          text(dt, label);
          text(dd, model.summary[key]);
          dd.className = "taa-list-value";
          append(item, dt);
          append(item, dd);
          append(countStrip, item);
        }
        append(section, countStrip);
        const search = makeInput("taa-player-search", "");
        search.type = "search";
        search.placeholder = "Search player ID or login";
        append(section, makeLabel("Search players", search));
        const filter = create("div");
        filter.id = "taa-player-filter-group";
        filter.className = "taa-actions";
        filter.setAttribute("role", "group");
        filter.setAttribute("aria-label", "Player state filters");
        const filters = {};
        for (const [key, label] of [["mapped", "Mapped"], ["unmapped", "Unmapped"], ["muted", "Muted"], ["orphaned", "Orphaned"]]) {
          const input = create("input");
          input.type = "checkbox";
          input.id = "taa-filter-" + key;
          filters[key] = input;
          append(filter, makeLabel(label, input));
        }
        search.value = panelDraftScope.query || adminDraft.fields && adminDraft.fields["taa-player-search"] || "";
        for (const key of Object.keys(filters)) filters[key].checked = panelDraftScope.filters[key] === true || adminDraft.fields && adminDraft.fields["taa-filter-" + key] === "true";
        append(section, filter);
        const filterStatus = makeSpan("", "taa-stat");
        filterStatus.id = "taa-player-filter-status";
        append(section, filterStatus);
        const list = create("ul");
        list.id = "taa-player-list";
        list.className = "taa-list";
        list.setAttribute("aria-label", "Players");
        const paginationStatus = makeFeedback("taa-player-pagination-status");
        const pagination = create("div");
        pagination.className = "taa-actions";
        pagination.setAttribute("aria-label", "Player pagination");
        const previous = makeButton("Previous page", "taa-player-prev", () => {
          page -= 1;
          draw();
        });
        const pageLabel = makeSpan("", "taa-stat");
        pageLabel.setAttribute("aria-current", "page");
        const next = makeButton("Next page", "taa-player-next", () => {
          page += 1;
          draw();
        });
        append(pagination, previous);
        append(pagination, pageLabel);
        append(pagination, next);
        const addForm = makeForm("taa-form");
        const profile = makeInput("taa-mapping-profile", "");
        const recipients = makeInput("taa-mapping-discord", "");
        append(addForm, makeLabel("Player ID or profile URL", profile));
        append(addForm, makeLabel("Discord user IDs", recipients));
        const persistWorkspace = (key, value, focusId, message) => {
          if (!mutationAllowed()) {
            setFeedback("Standby is read-only.", true);
            return false;
          }
          const result = writeVerifiedJson(localStorage, key, value);
          if (!result.ok) {
            setFeedback("Could not save changes; your values are still here.", true);
            return false;
          }
          setFeedback(message, false);
          renderPanel();
          const focus = document.getElementById(focusId);
          if (focus && typeof focus.focus === "function") focus.focus();
          return true;
        };
        append(addForm, makeButton("Add mapping", "taa-mapping-add", () => {
          const pid = normalizeProfileInput(profile.value);
          const result = addMapping(loadMappings(), hostname, pid, recipients.value);
          if (!pid || !result.validIds.length) {
            markInvalid(profile, !pid);
            markInvalid(recipients, !result.validIds.length);
            setFeedback("Enter a valid profile and at least one Discord ID.", true);
            return;
          }
          persistWorkspace(MAPPING_STORAGE_KEY, result.mappings, "taa-mapping-profile", "Mapping saved for player " + pid + ".");
        }, "taa-button", "submit"));
        append(section, addForm);
        let page = panelDraftScope.page || 1;
        const draw = () => {
          const options = { query: search.value, page };
          for (const key of Object.keys(filters)) options[key] = filters[key].checked;
          const paged = paginatePlayerWorkspaceRows(workspace().rows, options);
          page = paged.page;
          panelDraftScope = normalizeAdminDraftScope(Object.assign({}, panelDraftScope, { query: search.value, filters: Object.fromEntries(Object.keys(filters).map((key) => [key, filters[key].checked])), page }));
          const visibleUnknownIds = paged.rows.filter((row) => !idToName.has(row.id)).map((row) => row.id);
          pendingBackfillIds = createNameBackfillPlan(pendingBackfillIds.concat(visibleUnknownIds), visibleUnknownIds).ids;
          text(paginationStatus, formatPlayerPaginationStatus(paged));
          text(filterStatus, describePlayerFilterState(options) + " · " + paged.total + (paged.total === 1 ? " player matches" : " players match"));
          text(pageLabel, "Page " + paged.page);
          previous.disabled = paged.page <= 1 || readOnly;
          next.disabled = paged.page >= paged.pageCount || readOnly;
          clear(list);
          if (!paged.rows.length) {
            append(list, makeSpan("No players match these filters.", "taa-empty"));
            return;
          }
          for (const row of paged.rows) {
            const item = create("li");
            item.className = "taa-list-row";
            const article = create("article");
            article.className = "taa-list-row";
            const details = create("div");
            details.className = "taa-list-value taa-field-group";
            const nameNode = makeSpan(row.name, "taa-list-value");
            nameNode.dataset.playerId = row.id;
            append(details, nameNode);
            append(details, makeSpan("profile/" + row.id + " · " + (row.orphaned ? "Orphaned" : row.muted ? "Muted" : row.mapped ? "Mapped" : "Unmapped"), "taa-stat"));
            if (row.mapped) append(details, makeSpan(row.recipients.length + " recipient(s)", "taa-stat"));
            append(article, details);
            const actions = create("div");
            actions.className = "taa-actions taa-row-actions";
            const editInput = makeInput("taa-player-editor-" + row.id, row.recipients.join(", "));
            editInput.hidden = panelDraftScope.activeEditorId !== row.id;
            editInput.setAttribute("aria-label", "Recipients for profile " + row.id);
            const edit = makeButton(row.mapped ? "Edit recipients for profile " + row.id : "Map player " + row.name, "taa-player-edit-" + row.id, () => {
              panelDraftScope.activeEditorId = row.id;
              editInput.hidden = false;
              save.hidden = false;
              cancel.hidden = false;
              edit.hidden = true;
              editInput.focus();
              adminDraftDirty = true;
              adminDraft = captureDraft();
              persistDraft();
            }, "taa-button taa-small-button");
            edit.hidden = panelDraftScope.activeEditorId === row.id;
            const save = makeButton("Save recipients for profile " + row.id, "taa-player-save-" + row.id, () => {
              const result = addMapping(loadMappings(), hostname, row.id, editInput.value);
              if (!result.validIds.length) {
                markInvalid(editInput, true);
                setFeedback("Enter at least one valid Discord ID for player " + row.id + ".", true);
                return;
              }
              persistWorkspace(MAPPING_STORAGE_KEY, result.mappings, "taa-player-edit-" + row.id, "Mapping saved for player " + row.id + ".");
            }, "taa-button taa-small-button");
            save.hidden = panelDraftScope.activeEditorId !== row.id;
            const cancel = makeButton("Cancel editing profile " + row.id, "taa-player-cancel-" + row.id, () => {
              panelDraftScope.activeEditorId = null;
              draw();
            }, "taa-button taa-small-button");
            cancel.hidden = panelDraftScope.activeEditorId !== row.id;
            const mute = makeButton(row.muted ? "Unmute player " + row.name : "Mute player " + row.name, "taa-player-mute-" + row.id, () => {
              const nextMutes = loadMutedPlayers();
              const nextWorld = Object.assign({}, nextMutes);
              const listMutes = listMutedPlayers(nextMutes, hostname);
              const updated = listMutes.includes(row.id) ? listMutes.filter((id) => id !== row.id) : listMutes.concat(row.id);
              nextWorld[hostname] = Object.fromEntries(updated.map((id) => [id, true]));
              persistWorkspace(MUTED_PLAYERS_STORAGE_KEY, nextWorld, "taa-player-mute-" + row.id, "Player " + row.name + (row.muted ? " unmuted." : " muted."));
            }, "taa-button taa-small-button");
            append(actions, edit);
            append(actions, save);
            append(actions, cancel);
            append(actions, mute);
            if (row.mapped) {
              const remove = makeButton("Remove mapping for profile " + row.id, "taa-player-remove-" + row.id, () => {
                confirmation.hidden = false;
                edit.hidden = true;
                confirmation.querySelector("button").focus();
              }, "taa-button taa-small-button");
              append(actions, remove);
            }
            append(article, actions);
            append(article, editInput);
            const confirmation = create("fieldset");
            confirmation.hidden = true;
            const legend = create("legend");
            text(legend, "Remove mapping for profile " + row.id + "?");
            append(confirmation, legend);
            append(confirmation, makeSpan("This removes recipients for " + row.name + ".", "taa-stat"));
            const confirmActions = create("div");
            confirmActions.className = "taa-actions";
            const dismiss = makeButton("Cancel removal for profile " + row.id, "taa-player-remove-cancel-" + row.id, () => {
              confirmation.hidden = true;
              edit.focus();
            });
            const confirm = makeButton("Confirm removal for profile " + row.id, "taa-player-remove-confirm-" + row.id, () => {
              const result = removeMapping(loadMappings(), hostname, row.id);
              persistWorkspace(MAPPING_STORAGE_KEY, result, "taa-player-edit-" + row.id, "Mapping removed for player " + row.id + ".");
            });
            append(confirmActions, dismiss);
            append(confirmActions, confirm);
            append(confirmation, confirmActions);
            append(article, confirmation);
            append(item, article);
            append(list, item);
          }
        };
        search.addEventListener("input", () => {
          page = 1;
          draw();
        });
        for (const input of Object.values(filters)) input.addEventListener("change", () => {
          page = 1;
          draw();
        });
        append(section, paginationStatus);
        append(section, list);
        append(section, pagination);
        append(panelView, section);
        draw();
        for (const control of panelView.querySelectorAll('[id^="taa-mapping-"], [id^="taa-player-"]')) if (control.tagName === "BUTTON" || control.tagName === "INPUT") {
          control.dataset.mutationControl = "true";
          control.disabled = readOnly;
        }
        setDraftFields(adminDraft);
      } else if (adminTab === "alerts") {
        const section = makeSection("taa-alerts", "Alerts and delivery");
        const settings = loadSettings(hostname);
        const form = makeForm("taa-form");
        const attack = makeInput("taa-alert-attack", settings.attackThreshold, "number");
        const raid = makeInput("taa-alert-raid", settings.raidThreshold, "number");
        const normal = makeInput("taa-alert-normal", settings.normalMax, "number");
        const high = makeInput("taa-alert-high", settings.highMax, "number");
        const attackErrorElement = makeFieldError("taa-alert-attack-error");
        const raidErrorElement = makeFieldError("taa-alert-raid-error");
        const normalErrorElement = makeFieldError("taa-alert-normal-error");
        const highErrorElement = makeFieldError("taa-alert-high-error");
        append(form, makeLabel("Attack threshold", attack));
        append(form, attackErrorElement);
        append(form, makeLabel("Raid threshold", raid));
        append(form, raidErrorElement);
        append(form, makeLabel("Normal priority max", normal));
        append(form, normalErrorElement);
        append(form, makeLabel("High priority max", high));
        append(form, highErrorElement);
        append(form, makeButton("Save alert settings", "taa-alert-save", () => {
          if (!mutationAllowed()) return setFeedback("Standby is read-only.", true);
          const attackError = describeAlertThresholdError(attack.value, "attack");
          const raidError = describeAlertThresholdError(raid.value, "raid");
          const normalError = describeAlertThresholdError(normal.value, "normal");
          const highError = describeAlertThresholdError(high.value, "high");
          let bandError = null;
          if (!attackError && !raidError && !normalError && !highError) {
            const normalNumber = readPanelNumber(normal);
            const highNumber = readPanelNumber(high);
            if (normalNumber !== null && highNumber !== null && normalNumber >= highNumber) {
              bandError = "Normal priority max must be below High priority max.";
            }
          }
          const fieldsInvalid = [
            setFieldError(attack, attackErrorElement, attackError),
            setFieldError(raid, raidErrorElement, raidError),
            setFieldError(normal, normalErrorElement, bandError || normalError),
            setFieldError(high, highErrorElement, bandError || highError)
          ].some(Boolean);
          if (fieldsInvalid) return setFeedback("Fix the highlighted alert fields before saving.", true);
          const next = validateSettings({ attackThreshold: readPanelNumber(attack), raidThreshold: readPanelNumber(raid), normalMax: readPanelNumber(normal), highMax: readPanelNumber(high) });
          const result = persistLocal(SETTINGS_STORAGE_KEY, JSON.stringify(Object.assign({}, loadJsonMap(SETTINGS_STORAGE_KEY), { [hostname]: next })), "Alert settings saved.");
          if (result.ok) saveSettings(next, hostname);
        }, "taa-button", "submit"));
        append(section, form);
        const discordConfig = loadDiscordConfig();
        const role = makeInput("taa-alert-role", discordConfig.roleId || "");
        const roleErrorElement = makeFieldError("taa-alert-role-error");
        append(section, makeLabel("Discord role ID", role));
        append(section, roleErrorElement);
        append(section, makeButton("Save role", "taa-alert-role-save", () => {
          if (!mutationAllowed()) return setFeedback("Standby is read-only.", true);
          const roleError = describeAlertRoleError(role.value);
          if (setFieldError(role, roleErrorElement, roleError)) return setFeedback(roleError, true);
          const id = validateDiscordRoleId(role.value);
          const result = saveDiscordConfig(setAlertRoleId(loadDiscordConfig(), id));
          if (!result || !result.ok) return setFeedback("Could not save changes; your values are still here.", true);
          setFeedback("Alert role saved.", false);
        }));
        const leaveSection = makeSection("taa-leave-role", "Leave-moderator role");
        const leaveInput = makeInput("taa-leave-role-input", discordConfig.leaveRoleId || "");
        const leaveErrorElement = makeFieldError("taa-leave-role-error");
        append(leaveSection, makeLabel("Discord leave-moderator role ID", leaveInput));
        append(leaveSection, leaveErrorElement);
        const leaveActions = create("div");
        leaveActions.className = "taa-actions";
        append(leaveActions, makeButton("Set leave role", "taa-leave-role-set", () => {
          if (!mutationAllowed()) return setFeedback("Standby is read-only.", true);
          const leaveError = describeAlertRoleError(leaveInput.value);
          if (setFieldError(leaveInput, leaveErrorElement, leaveError)) return setFeedback(leaveError, true);
          const id = validateDiscordRoleId(leaveInput.value);
          const result = saveDiscordConfig(setLeaveRoleId(loadDiscordConfig(), id));
          if (!result || !result.ok) return setFeedback("Could not save changes; your values are still here.", true);
          setFeedback("Leave-moderator role saved.", false);
        }));
        append(leaveActions, makeButton("Clear leave role", "taa-leave-role-clear", () => {
          if (!mutationAllowed()) return setFeedback("Standby is read-only.", true);
          const result = saveDiscordConfig(clearLeaveRoleId(loadDiscordConfig()));
          if (!result || !result.ok) return setFeedback("Could not save changes; your values are still here.", true);
          leaveInput.value = "";
          setFeedback("Leave-moderator role cleared.", false);
        }));
        append(leaveSection, leaveActions);
        append(leaveSection, makeSpan(discordConfig.leaveRoleId ? "Current leave role: " + discordConfig.leaveRoleId : "Current leave role: none", "taa-leave-role-current"));
        append(section, leaveSection);
        const action = create("div");
        action.className = "taa-actions";
        append(action, makeButton("Send test alert", "taa-alert-test", async () => {
          if (!mutationAllowed()) return setFeedback("Standby is read-only.", true);
          await Promise.resolve(sendDiscordBatch([{ name: "Panel test", url: location.href, attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0, eventType: "attack" }]));
          setFeedback("Test transport settled.", false);
        }));
        append(section, action);
         append(section, makeStatusBanner("Failed / uncertain delivery", failed.length + " failed, " + uncertain.length + " uncertain. Recovery actions are available in the Tampermonkey menu.", failed.length || uncertain.length ? "warning" : "success"));
        append(panelView, section);
        const draft = restoreDraft();
        if (draft) setDraftFields(draft);
      } else {
         const section = makeSection("taa-diagnostics-view", "Diagnostics and incident bundle");
        append(section, makeStatusBanner("Storage provenance", storageProvenanceText(buildStorageProvenanceModel(hostname)).join(" "), "info"));
        const metricsSection = makeSection("taa-count-reconciliation", "Count reconciliation");
        const metricGrid = create("div");
        metricGrid.className = "taa-stats taa-overview-metrics";
        const metricsToShow = [
          ["Route role", reconciliation.routeRole, "taa-route-role-value"],
          ["Lease generation", reconciliation.leaseGeneration === null ? "—" : reconciliation.leaseGeneration, "taa-lease-generation-value"],
          ["Monitor generation", reconciliation.monitorGeneration === null ? "—" : reconciliation.monitorGeneration, "taa-monitor-generation-value"],
           ["Scan reason", reconciliation.scanReason, "taa-scan-reason-value"],
           ["Scan outcome", reconciliation.scanOutcome, "taa-scan-outcome-value"],
           ["Scan result", reconciliation.scanLabel, "taa-scan-result-value"],
           ["Reload result", reconciliation.reloadLabel || "not recorded", "taa-reload-result-value"],
          ["Active totals (players / attacks / raids)", reconciliation.activeTotals.players + " / " + reconciliation.activeTotals.attacks + " / " + reconciliation.activeTotals.raids, "taa-active-totals-value"],
          ["New net deltas (players / attacks / raids; net, sampled)", reconciliation.newNetDeltas.players + " / " + reconciliation.newNetDeltas.attacks + " / " + reconciliation.newNetDeltas.raids, "taa-net-deltas-value"],
          ["Muted / blocked / eligible", reconciliation.dispositions.muted + " / " + reconciliation.dispositions.blocked + " / " + reconciliation.dispositions.eligible, "taa-disposition-counts-value"],
          ["Delivery represented (pending / inFlight / failed / uncertain / acknowledged)", Object.values(reconciliation.deliveryTotals).join(" / "), "taa-delivery-totals-value"],
          ["First conservation mismatch", reconciliation.firstConservationMismatch || "none", "taa-conservation-mismatch-value"]
        ];
        for (const [label, value, id] of metricsToShow) append(metricGrid, makeMetric(label, value, id));
        append(metricsSection, metricGrid);
        append(metricsSection, makeSpan("Player/message counts are separate from attack/raid counts. New deltas are net, sampled.", "taa-stat"));
        append(section, metricsSection);
        const filterForm = makeForm("taa-form taa-trace-filter-form");
        const scanFilter = makeInput("taa-trace-scan-id", "");
        const stageFilter = makeInput("taa-trace-stage", "");
        const outcomeFilter = makeInput("taa-trace-outcome", "");
        append(filterForm, makeLabel("Scan ID", scanFilter));
        append(filterForm, makeLabel("Stage", stageFilter));
        append(filterForm, makeLabel("Outcome", outcomeFilter));
        const traceList = create("div");
        traceList.id = "taa-recent-traces";
        traceList.className = "taa-list";
        const traceCount = makeSpan("", "taa-stat");
        traceCount.id = "taa-trace-count";
        const drawTraces = () => {
          clear(traceList);
          const activeFilters = { scanId: scanFilter.value, stage: stageFilter.value, outcome: outcomeFilter.value };
          const filtered = boundedDiagnosticRecords(traces, activeFilters);
          text(traceCount, formatTraceCountStatus(filtered.length, traces.length, activeFilters));
          if (!filtered.length) append(traceList, makeSpan("No recent traces match these filters.", "taa-empty"));
          for (const trace of filtered) append(traceList, makeSpan("scan " + (trace.scanId || trace.diagnosticId || "—") + " · " + (trace.stage || "—") + " · " + (trace.status || "—") + " · " + (trace.reason || "—"), "taa-list-value"));
        };
        scanFilter.addEventListener("input", drawTraces);
        stageFilter.addEventListener("input", drawTraces);
        outcomeFilter.addEventListener("input", drawTraces);
        append(filterForm, makeSpan("Recent traces (maximum 32)", "taa-stat"));
         const bounds = envelope && envelope.bounds && typeof envelope.bounds === "object" ? envelope.bounds : {};
         const overflowCount = Number(bounds.overflowCount) || Number(runtimeDiag.overflowCount) || 0;
         const overflowReason = String(bounds.overflowReason || runtimeDiag.overflowReason || "queue-cap");
         append(section, makeStatusBanner("Bounded state", "Queue overflow count: " + overflowCount + "; reason: " + overflowReason + ". Export bound: 512 KiB; sensitive data omitted.", "warning"));
         append(section, filterForm);
        append(section, traceCount);
        append(section, traceList);
        drawTraces();
        const exportButton = makeButton("Export incident bundle", "taa-incident-bundle-export", () => {
          const bundle = buildIncidentBundle({ envelope, diagnostics: runtimeDiag, traces, routeRole: reconciliation.routeRole, filters: { scanId: scanFilter.value, stage: stageFilter.value, outcome: outcomeFilter.value }, webhookConfigured: Boolean(loadWebhookUrl()) });
          const blob = new Blob([canonicalSerializeDiagnostics(bundle)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = create("a");
          link.href = url;
          link.download = "taa-incident-bundle.json";
          link.click();
          URL.revokeObjectURL(url);
          setFeedback("Incident bundle prepared; raw queue payloads and player data omitted.", false);
        });
         exportButton.dataset.exportControl = "true";
         exportButton.dataset.legacyControl = "taa-diagnostics-export";
         append(section, exportButton);
         const settingsActions = create("div");
         settingsActions.className = "taa-actions";
         settingsActions.setAttribute("role", "group");
         settingsActions.setAttribute("aria-label", "Settings backup");
         const settingsPreview = create("textarea");
         settingsPreview.id = "taa-settings-backup-preview";
         settingsPreview.className = "taa-input";
         settingsPreview.rows = 4;
         settingsPreview.readOnly = true;
         settingsPreview.placeholder = "Backup preview (webhook token is masked here)";
         settingsPreview.setAttribute("aria-label", "Settings backup preview");
         const settingsFile = create("input");
         settingsFile.type = "file";
         settingsFile.accept = "application/json,.json";
         settingsFile.id = "taa-settings-import-file";
         settingsFile.hidden = true;
         const settingsFallback = create("textarea");
         settingsFallback.id = "taa-settings-import-textarea";
         settingsFallback.className = "taa-input";
         settingsFallback.rows = 4;
         settingsFallback.placeholder = "Optional: paste taa-settings-backup.json here";
         settingsFallback.setAttribute("aria-label", "Paste settings backup JSON");
         const previewBackup = (backup) => {
           const preview = JSON.parse(JSON.stringify(backup));
            if (preview.data && preview.data[WEBHOOK_STORAGE_KEY]) { const webhook = preview.data[WEBHOOK_STORAGE_KEY]; preview.data[WEBHOOK_STORAGE_KEY] = typeof webhook === "string" ? maskWebhookUrl(webhook) : webhook.action === "set" ? { action: "set", url: maskWebhookUrl(webhook.url) } : { action: "clear" }; }
           settingsPreview.value = JSON.stringify(preview, null, 2);
         };
         const applySettingsImport = (raw) => {
           if (!mutationAllowed()) { setFeedback("Standby is read-only; settings import is disabled.", true); return; }
            const plan = inspectSettingsBackup(raw, hostname, Object.fromEntries(SETTINGS_BACKUP_DATA_KEYS.map((key) => [key, key === WEBHOOK_STORAGE_KEY ? loadWebhookUrl() || "" : settingsBackupStorageValue(localStorage, key)])));
            if (!plan.ok) { setFeedback("Settings backup rejected: malformed data; no settings were changed.", true); return; }
            const summary = "Settings backup validated. Current-host entries: " + plan.counts.current + "; other-host entries: " + plan.counts.otherHost + ". Import after merge?";
            if (typeof confirm !== "function" || !confirm(summary)) { setFeedback("Settings import cancelled.", false); return; }
            const result = applySettingsBackup(raw, { hostname, storage: localStorage });
            if (!result.ok) { setFeedback("Settings import rejected; existing settings were restored.", true); return; }
            settingsFallback.value = "";
            const status = result.summary.changed === 0 ? "no changes were needed" : "merged without clearing absent fields";
            setFeedback("Settings imported: " + status + "; " + plan.counts.current + " current-host entr(y/ies), " + plan.counts.otherHost + " other-host entr(y/ies).", false);
           renderPanel();
         };
         const importButton = makeButton("Import settings", "taa-settings-import", () => {
           if (!mutationAllowed()) { setFeedback("Standby is read-only; settings import is disabled.", true); return; }
           const pasted = settingsFallback.value.trim();
           if (pasted) { applySettingsImport(pasted); return; }
           settingsFile.click();
         });
         importButton.dataset.mutationControl = "true";
         settingsFile.addEventListener("change", () => {
           const file = settingsFile.files && settingsFile.files[0];
           if (!file || typeof file.text !== "function") { setFeedback("Choose a JSON backup file.", true); return; }
           file.text().then(applySettingsImport).catch(() => setFeedback("Could not read the settings backup file.", true));
         });
         const exportSettingsButton = makeButton("Export settings", "taa-settings-export", () => {
           const backup = buildSettingsBackup({ hostname, storage: localStorage });
           previewBackup(backup);
           if (backup.bounded) { setFeedback("Settings backup exceeds the 512 KiB limit and was not downloaded.", true); return; }
           const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
           const url = URL.createObjectURL(blob);
           const link = create("a");
           link.href = url;
           link.download = "taa-settings-backup.json";
           link.click();
           URL.revokeObjectURL(url);
           setFeedback("Settings backup prepared; the webhook is masked only in the preview.", false);
         });
          exportSettingsButton.dataset.exportControl = "true";
          append(settingsActions, exportSettingsButton);
          append(settingsActions, importButton);
          const settingsDetails = create("details");
          settingsDetails.id = "taa-settings-details";
          const settingsSummary = create("summary");
          settingsSummary.textContent = "Backup ustawień";
          append(settingsDetails, settingsSummary);
          append(settingsDetails, settingsActions);
          append(settingsDetails, settingsFile);
          append(settingsDetails, settingsPreview);
          append(settingsDetails, settingsFallback);
          append(section, settingsDetails);
           append(section, makeSpan("Load history and toggle debug details from the Tampermonkey menu.", "taa-stat"));
        append(section, makeSpan("Visibility: " + ((getWorldEntry(loadDiagnostics()) || {}).visibility || {}).visibilityState || "unknown", "taa-stat"));
        append(panelView, section);
      }
      if (readOnly) {
        panelView.querySelectorAll("button").forEach((button) => {
          if (!button.dataset.exportControl) {
            button.disabled = true;
            button.dataset.mutationControl = "true";
          }
        });
         panelView.querySelectorAll('#taa-mapping-profile, #taa-mapping-discord, #taa-settings-import-textarea, [id^="taa-player-editor-"], [id^="taa-alert-"] , [id^="taa-leave-role-"]').forEach((input) => {
          input.disabled = true;
          input.dataset.mutationControl = "true";
        });
      }
      panelView.addEventListener("input", () => {
        adminDraftDirty = true;
        adminDraft = captureDraft();
        persistDraft();
      });
      panelView.addEventListener("change", () => {
        adminDraftDirty = true;
        adminDraft = captureDraft();
        persistDraft();
      });
      panel.addEventListener("focusin", (event) => {
        const input = event && event.target;
        if (input && input.tagName === "INPUT" && input.id) lastDraftFocus = { id: input.id, start: input.selectionStart || 0, end: input.selectionEnd || 0 };
      });
      panel.addEventListener("mousedown", () => {
        const input = document.activeElement;
        if (input && input.tagName === "INPUT" && input.id) lastDraftFocus = { id: input.id, start: input.selectionStart || 0, end: input.selectionEnd || 0 };
      });
      adminDraftReloadGate = () => {
        const result = gateAdminDraftReload(readDraftStorage(), draftKey(adminTab), captureDraft());
        if (!result.ok) {
          draftStorageFailed = true;
          setFeedback("Draft storage failed. Save, Discard, or Reload is required; reload blocked.", true);
          return false;
        }
        draftStorageFailed = result.outcome === "storage-failed-empty-draft";
        return true;
      };
      if (draftStorageFailed) {
        const emptyDraft = isAdminDraftEmpty(captureDraft());
        append(panelView, makeStatusBanner("Draft storage failed", emptyDraft ? "Scheduled reload proceeds because this draft is empty. Enter a value to require Save, Discard, or Reload." : "Save, Discard, or Reload is required. Scheduled reload is blocked.", emptyDraft ? "warning" : "error", true));
      }
      applyPanelLeaseState(mutationAllowed(), panel);
    };
    const loadJsonMap = (key) => {
      try {
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) : {};
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch (error) {
        return {};
      }
    };
    const updateRuntimeNodes = () => {
      if (overlay.style.display === "none") return;
      const next = document.getElementById("taa-next-refresh-value");
      if (next) next.textContent = nextReloadAtMs ? Math.max(0, Math.ceil((nextReloadAtMs - Date.now()) / 1e3)) + "s" : "Not scheduled";
      const age = document.getElementById("taa-queue-age-value");
      const current = loadMonitorEnvelopeV1(hostname).envelope;
      const first = current && current.pending && current.pending[0];
      if (age) age.textContent = first && Number.isFinite(first.observedAtMs) ? Math.max(0, Date.now() - first.observedAtMs) + "ms" : "0ms";
      reportLifecycleHook("onPanelRuntimeUpdate", { fullRender: false, atMs: Date.now() });
    };
    panelRuntimeUpdater = updateRuntimeNodes;
    const renderPanel = () => {
      if (!adminBooted) {
        try {
          const storage = readDraftStorage();
          const savedTab = storage && storage.getItem("taa-active-tab:" + hostname);
          if (savedTab && ["overview", "players", "alerts", "diagnostics"].indexOf(savedTab) !== -1) adminTab = savedTab;
        } catch (error) {
        }
        adminBooted = true;
      }
      reportLifecycleHook("onPanelRender", { tab: adminTab });
      renderWorkspace();
      if (overlay.style.display !== "none" && adminTab === "players" && pendingBackfillIds.length > 0) triggerNameBackfill(hostname, pendingBackfillIds);
    };
    let pendingBackfillIds = [];
    let backfillInFlight = false;
    let lastBackfillFailureCount = 0;
    const isPanelInputFocused = () => {
      const el = typeof document !== "undefined" ? document.activeElement : null;
      return Boolean(el && el.id && el.id.indexOf("taa-") === 0 && el.tagName === "INPUT");
    };
    async function triggerNameBackfill(hostname2, ids, visibleIds) {
      if (backfillInFlight || typeof fetch !== "function" || !Array.isArray(ids) || ids.length === 0) return;
      const visible = Array.isArray(visibleIds) ? visibleIds : typeof panel.querySelectorAll === "function" ? Array.from(panel.querySelectorAll("[data-player-id]")).map((node) => node.dataset && node.dataset.playerId).filter(Boolean) : [];
      const plan = createNameBackfillPlan(ids, visible);
      if (plan.ids.length === 0) return;
      backfillInFlight = true;
      const requestEpoch = panelEpoch;
      const requestTab = adminTab;
      const batchController = new AbortController();
      backfillController = batchController;
      let failedCount = 0;
      const namesAtStart = loadPlayerNames();
      const startWorldNames = namesAtStart && namesAtStart[hostname2] && typeof namesAtStart[hostname2] === "object" ? Object.assign({}, namesAtStart[hostname2]) : {};
      const resolved = [];
      const deadIds = [];
      const previousVisibleNames = {};
      if (typeof panel.querySelectorAll === "function") Array.from(panel.querySelectorAll("[data-player-id]")).forEach((node) => {
        if (node.dataset && node.dataset.playerId) previousVisibleNames[node.dataset.playerId] = String(node.textContent || "").trim();
      });
       try {
         const result = await runNameBackfill(plan.ids, { signal: batchController.signal, concurrency: NAME_BACKFILL_MAX_CONCURRENCY, timeoutMs: NAME_BACKFILL_TIMEOUT_MS });
         resolved.push(...result.resolved);
         deadIds.push(...result.deadIds);
         failedCount = result.failedCount;
      } finally {
        backfillInFlight = false;
        lastBackfillFailureCount = failedCount;
        if (backfillController === batchController) backfillController = null;
        const current = isPanelAsyncResultCurrent(requestEpoch, panelEpoch, requestTab, adminTab, overlay.style.display !== "none", tabLeaseActive);
        if (!current) return;
        if (deadIds.length > 0) {
          const notFound = loadPlayerNamesNotFound();
          const nextNotFound = markPlayerNamesNotFound(notFound, hostname2, deadIds, Date.now());
          if (nextNotFound !== notFound && tabLeaseActive) savePlayerNamesNotFound(nextNotFound);
        }
        const latest = loadPlayerNames();
        let nextNames = latest;
        const validUpdates = [];
        for (const update of resolved) {
          const latestWorld = latest && latest[hostname2] && latest[hostname2][update.id];
          if (latestWorld !== void 0 && latestWorld !== startWorldNames[update.id]) continue;
          nextNames = addPlayerNamesBatch(nextNames, hostname2, [update]);
          validUpdates.push(update);
        }
        if (validUpdates.length > 0 && tabLeaseActive) {
          savePlayerNames(nextNames);
          patchPlayerNameNodes(panel, validUpdates, previousVisibleNames);
        }
        reportLifecycleHook("onPanelBackfillSettled", { count: validUpdates.length, failed: failedCount, bounded: plan.ids.length <= plan.visibleIds.length + plan.orphanCap });
      }
    }
    openButton.addEventListener("click", openPanel);
    overlay.addEventListener("click", (event) => {
      if (event && event.target === overlay) {
        requestPanelExit2("backdrop");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (overlay.style.display === "none") {
        return;
      }
      if (event && event.key === "Escape") {
        requestPanelExit2("escape");
        return;
      }
      trapPanelFocus(event);
    });
    append(document.body, openButton);
    append(document.body, overlay);
    adminPanelOpener = openPanel;
    applyPanelLeaseState(tabLeaseActive, panel);
    renderPanel();
    return overlay;
  }
  if (!isNodeEnvironment) {
    const initialRoute = classifyAllianceRoute(location.href);
    const browserCanOwnAuthority = initialRoute.role === ROUTE_ROLES.CANONICAL_MEMBER && hasExclusiveWebLocks();
    if (!browserCanOwnAuthority) {
      tabLeaseActive = false;
      tabLeaseBestEffort = false;
      setStandbyVisibility(true);
      initAdminPanel();
      return;
    }
    const worldHostname = normalizeHostname(location.hostname);
    const tabOwnerId = getOrCreateTabOwnerId();
    let releaseWebLock = null;
    visibilityDriftState = createVisibilityDriftTracker(
      Date.now(),
      typeof document !== "undefined" && document.hidden === true
    );
    document.addEventListener("visibilitychange", () => {
      visibilityDriftState = updateVisibilityDriftTracker(
        visibilityDriftState,
        Date.now(),
        document.hidden === true,
        nextReloadAtMs
      );
      mergeRuntimeDiagnostics(worldHostname, { visibility: visibilityDriftState });
      reportLifecycleHook("onVisibilityChange", visibilityDriftState);
    });
    setTimeout(() => {
      navigator.locks.request(
        lockNameForHostname(worldHostname),
        { mode: "exclusive" },
        async () => {
          const leaseResult = acquireLease(
            worldHostname,
            tabOwnerId,
            Date.now()
          );
          if (leaseResult === false) {
            console.warn(
              "[Alliance Discord] Another tab holds the leader lease for " + worldHostname + " — this tab stays inactive (no menu, no scans, no flush); auto-retry will acquire the leader lease when it expires."
            );
            window.addEventListener(
              "visibilitychange",
              () => {
                if (document.visibilityState === "visible") {
                  startFollowerWatchdog(
                    worldHostname,
                    tabOwnerId,
                    false
                  );
                }
              }
            );
            window.addEventListener("focus", () => {
              startFollowerWatchdog(
                worldHostname,
                tabOwnerId,
                false
              );
            });
            setStandbyVisibility(true);
            initAdminPanel();
            startFollowerWatchdog(worldHostname, tabOwnerId, false);
            return;
          }
          tabLeaseActive = true;
          activeLeaseOwnerId = tabOwnerId;
          tabLeaseBestEffort = leaseResult === null;
          const acquiredRecord = loadLeaseRecord(worldHostname);
          tabLeaseToken = acquiredRecord && acquiredRecord.token;
          tabLeaseGeneration = acquiredRecord && acquiredRecord.generation;
          tabLeaseTerm = acquiredRecord && acquiredRecord.term;
          setStandbyVisibility(false);
          if (leaseResult === true) {
            startLeaseRenewal(worldHostname, tabOwnerId);
            const releaseLeaseOnUnload = () => {
              releaseLease(
                worldHostname,
                tabOwnerId,
                Date.now(),
                tabLeaseTerm
              );
              if (releaseWebLock) releaseWebLock();
            };
            window.addEventListener("pagehide", releaseLeaseOnUnload);
            window.addEventListener("beforeunload", releaseLeaseOnUnload);
          }
          GM_registerMenuCommand(
            "Open alert monitor panel",
            () => {
              if (typeof adminPanelOpener === "function") {
                adminPanelOpener();
                return;
              }
              window.alert("[Alliance Discord] Panel is not ready yet — reload the page.");
            }
          );
          GM_registerMenuCommand(
            "Send batch test to Discord",
            () => {
              sendDiscordBatch([
                {
                  name: "Test player 1",
                  url: location.href,
                  attackCount: 2,
                  raidCount: 0,
                  oldAttackCount: 0,
                  oldRaidCount: 0,
                  addedAttackCount: 2,
                  addedRaidCount: 0,
                  eventType: "attack",
                  description: "Test"
                },
                {
                  name: "Test player 2",
                  url: location.href,
                  attackCount: 1,
                  raidCount: 2,
                  oldAttackCount: 0,
                  oldRaidCount: 0,
                  addedAttackCount: 1,
                  addedRaidCount: 2,
                  eventType: "mixed",
                  description: "Test"
                }
              ]);
            }
          );
          GM_registerMenuCommand(
            "Send raid-only batch test to Discord",
            () => {
              sendDiscordBatch([
                {
                  name: "Test raid player",
                  url: location.href,
                  attackCount: 0,
                  raidCount: 3,
                  oldAttackCount: 0,
                  oldRaidCount: 1,
                  addedAttackCount: 0,
                  addedRaidCount: 2,
                  eventType: "raid",
                  description: "Test"
                }
              ]);
            }
          );
          GM_registerMenuCommand(
            "Scan now",
            () => {
              scanAttacks(true);
            }
          );
          GM_registerMenuCommand(
            "Clear attack memory",
            () => {
              localStorage.removeItem(STORAGE_KEY);
              previousState = {};
              alert(
                "Attack memory has been cleared."
              );
              scanAttacks(true);
            }
          );
          GM_registerMenuCommand(
            "Add Discord mapping",
            () => {
              const rawProfile = prompt(
                "Enter the Travian profile ID or profile URL (e.g. 385 or /profile/385):",
                ""
              );
              if (rawProfile === null || rawProfile === "") {
                return;
              }
              const playerId = normalizeProfileInput(rawProfile);
              if (playerId === null) {
                alert(
                  "Invalid player profile or Discord IDs"
                );
                return;
              }
              const rawIds = prompt(
                "Enter one or more comma-separated Discord user IDs (raw snowflakes only):",
                ""
              );
              if (rawIds === null || rawIds === "") {
                return;
              }
              const hostname = normalizeHostname(location.hostname);
              const result = addMapping(
                loadMappings(),
                hostname,
                playerId,
                rawIds
              );
              if (result.validIds.length === 0) {
                alert(
                  "Invalid player profile or Discord IDs"
                );
                return;
              }
              saveMappings(result.mappings);
              const feedback = `Mapping added: ${playerId} → ${result.validIds.length} recipients`;
              alert(
                result.invalidIds.length > 0 ? feedback + ` (${result.invalidIds.length} invalid skipped)` : feedback
              );
            }
          );
          GM_registerMenuCommand(
            "Remove Discord mapping",
            () => {
              const rawProfile = prompt(
                "Enter the Travian profile ID or profile URL to remove:",
                ""
              );
              if (rawProfile === null || rawProfile === "") {
                return;
              }
              const playerId = normalizeProfileInput(rawProfile);
              if (playerId === null) {
                alert("Invalid player profile");
                return;
              }
              const hostname = normalizeHostname(location.hostname);
              const mappings = loadMappings();
              const world = mappings[hostname] || {};
              const existing = world[playerId];
              if (!existing || !Array.isArray(existing) || existing.length === 0) {
                alert(
                  `No mapping for profile ${playerId} in this world.`
                );
                return;
              }
              const rawId = prompt(
                `Remove one Discord ID from profile ${playerId}? Leave empty to remove the whole mapping:`,
                ""
              );
              if (rawId === null) {
                return;
              }
              if (rawId.trim() === "") {
                const next2 = removeMapping(
                  mappings,
                  hostname,
                  playerId
                );
                saveMappings(next2);
                alert(
                  `Mapping removed for profile ${playerId}.`
                );
                return;
              }
              const target = validateDiscordUserId(rawId);
              if (target === null) {
                alert("Invalid Discord ID");
                return;
              }
              const next = removeMapping(
                mappings,
                hostname,
                playerId,
                target
              );
              if ((next[hostname] || {})[playerId] === world[playerId]) {
                alert(
                  `Discord ID ${target} is not mapped to profile ${playerId}.`
                );
                return;
              }
              saveMappings(next);
              alert(
                `Discord ID ${target} removed from profile ${playerId}.`
              );
            }
          );
          GM_registerMenuCommand(
            "List Discord mappings",
            () => {
              const hostname = normalizeHostname(location.hostname);
              const items = listMappings(
                loadMappings(),
                hostname
              );
              if (items.length === 0) {
                alert("No mappings for this world.");
                return;
              }
              if (items.join("\n").length > 1800) {
                console.log(
                  "[Alliance Discord] Mappings for " + hostname + ":\n" + items.join("\n")
                );
                alert(
                  "Mappings for this world are too long for a dialog — see console."
                );
                return;
              }
              alert(
                "Mappings for " + hostname + ":\n" + items.join("\n")
              );
            }
          );
          GM_registerMenuCommand(
            "Set alert role ID",
            () => {
              const rawRole = prompt(
                "Enter the Discord ROLE ID to mention on every alert (raw 17-20 digits, no <@&...>):",
                ""
              );
              if (rawRole === null || rawRole === "") {
                return;
              }
              const roleId = validateDiscordRoleId(rawRole);
              if (roleId === null) {
                alert(
                  "Invalid role ID (expected 17-20 digits)."
                );
                return;
              }
              const config = setAlertRoleId(
                loadDiscordConfig(),
                roleId
              );
              saveDiscordConfig(config);
              alert("Alert role ID set.");
            }
          );
          GM_registerMenuCommand(
            "Clear alert role ID",
            () => {
              const confirmation = prompt(
                'Clear the configured alert role ID? Type "yes" to confirm:',
                ""
              );
              if (confirmation === null || String(confirmation).toLowerCase() !== "yes") {
                return;
              }
              const config = clearAlertRoleId(
                loadDiscordConfig()
              );
              saveDiscordConfig(config);
              alert("Alert role ID cleared.");
            }
          );
          GM_registerMenuCommand(
            "Show alert role ID",
            () => {
              const config = loadDiscordConfig();
              if (config.roleId) {
                alert(
                  "Configured alert role ID: " + config.roleId
                );
              } else {
                alert("No alert role configured.");
              }
            }
          );
          GM_registerMenuCommand(
            "Set leave-moderator role ID",
            () => {
              const rawRole = prompt(
                "Enter the leave-moderator Discord ROLE ID (raw 17-20 digits, no <@&...>):",
                ""
              );
              if (rawRole === null || rawRole === "") return;
              const roleId = validateDiscordRoleId(rawRole);
              if (roleId === null) {
                alert("Invalid role ID (expected 17-20 digits).");
                return;
              }
              const result = saveDiscordConfig(setLeaveRoleId(loadDiscordConfig(), roleId));
              alert(result && result.ok ? "Leave-moderator role ID set." : "Could not save leave-moderator role ID.");
            }
          );
          GM_registerMenuCommand(
            "Clear leave-moderator role ID",
            () => {
              const confirmation = prompt(
                'Clear the configured leave-moderator role ID? Type "yes" to confirm:',
                ""
              );
              if (confirmation === null || String(confirmation).toLowerCase() !== "yes") return;
              const result = saveDiscordConfig(clearLeaveRoleId(loadDiscordConfig()));
              alert(result && result.ok ? "Leave-moderator role ID cleared." : "Could not clear leave-moderator role ID.");
            }
          );
          GM_registerMenuCommand(
            "Show leave-moderator role ID",
            () => {
              const roleId = loadDiscordConfig().leaveRoleId;
              alert(roleId ? "Configured leave-moderator role ID: " + roleId : "No leave-moderator role configured.");
            }
          );
          GM_registerMenuCommand(
            "Set Discord webhook URL",
            () => {
              const rawUrl = prompt(
                "Paste the Discord webhook URL. It is stored locally in the userscript storage and is never logged or displayed:",
                ""
              );
              if (rawUrl === null || rawUrl === "") {
                return;
              }
              if (saveWebhookUrl(rawUrl)) {
                alert("Discord webhook URL set.");
              } else {
                alert(
                  "Invalid webhook URL. Expected https://discord.com/api/webhooks/<id>/<token> with no query string or fragment."
                );
              }
            }
          );
          GM_registerMenuCommand(
            "Clear Discord webhook URL",
            () => {
              const confirmation = prompt(
                'Clear the configured Discord webhook URL? Type "yes" to confirm:',
                ""
              );
              if (confirmation === null || String(confirmation).toLowerCase() !== "yes") {
                return;
              }
              clearWebhookUrl();
              alert("Discord webhook URL cleared.");
            }
          );
          GM_registerMenuCommand(
            "Show Discord webhook status",
            () => {
              if (loadWebhookUrl() !== null) {
                alert("A Discord webhook is configured.");
              } else {
                alert("No Discord webhook configured.");
              }
            }
          );
          GM_registerMenuCommand(
            "Retry failed Discord batches",
            () => {
              const result = adminRecoveryActions.retryFailed();
              if (result.outcome === "nothing-to-retry") {
                alert("No failed batches to retry.");
                return;
              }
              alert(result.outcome === "ok" ? "Failed delivery requeued; retry may duplicate." : "Could not retry failed delivery.");
            }
          );
          GM_registerMenuCommand(
            "Retry uncertain Discord batches",
            () => {
              const result = adminRecoveryActions.retryUncertain();
              alert(result.outcome === "ok" ? "Uncertain delivery requeued; retry may duplicate." : result.outcome === "nothing-to-retry" ? "No uncertain batches to retry." : "Could not retry uncertain delivery.");
            }
          );
          GM_registerMenuCommand(
            "Mark uncertain Discord batches delivered",
            () => {
              const result = adminRecoveryActions.markUncertainDelivered();
              alert(result.outcome === "ok" ? "Uncertain delivery marked delivered." : result.outcome === "nothing-to-mark" ? "No uncertain batches to mark delivered." : "Could not mark uncertain delivery.");
            }
          );
          GM_registerMenuCommand(
            "Flush pending Discord batches",
            () => {
              adminRecoveryActions.flushAlerts().then(() => alert("Flush settled."));
            }
          );
          GM_registerMenuCommand(
            "Load history and health",
            () => {
              const result = adminRecoveryActions.loadDiagnosticsHistory();
              alert(result ? result.events.length + " history records loaded; " + result.stats.last24h.total + " in the last 24 hours." : "History is not available yet.");
            }
          );
          GM_registerMenuCommand(
            "Toggle debug details",
            () => {
              alert(adminRecoveryActions.toggleDebugDetails() ? "Debug details enabled." : "Debug details disabled or could not be saved.");
            }
          );
          GM_registerMenuCommand(
            "Add muted player",
            () => {
              const rawProfile = prompt(
                "Enter the Travian profile ID or profile URL (e.g. 385 or /profile/385):",
                ""
              );
              if (rawProfile === null || rawProfile === "") {
                return;
              }
              const playerId = normalizeProfileInput(rawProfile);
              if (playerId === null) {
                alert("Invalid player profile");
                return;
              }
              const hostname = normalizeHostname(location.hostname);
              const mutes = loadMutedPlayers();
              if (isPlayerMuted(mutes, hostname, playerId)) {
                alert(
                  `Player ${playerId} is already muted for this world.`
                );
                return;
              }
              const next = addMutedPlayer(
                mutes,
                hostname,
                playerId
              );
              saveMutedPlayers(next);
              alert(
                `Player ${playerId} muted for this world.`
              );
            }
          );
          GM_registerMenuCommand(
            "Remove muted player",
            () => {
              const rawProfile = prompt(
                "Enter the Travian profile ID or profile URL (e.g. 385 or /profile/385):",
                ""
              );
              if (rawProfile === null || rawProfile === "") {
                return;
              }
              const playerId = normalizeProfileInput(rawProfile);
              if (playerId === null) {
                alert("Invalid player profile");
                return;
              }
              const hostname = normalizeHostname(location.hostname);
              const mutes = loadMutedPlayers();
              const next = removeMutedPlayer(
                mutes,
                hostname,
                playerId
              );
              if (next === mutes) {
                alert(
                  `No muted player with profile ${playerId} in this world.`
                );
                return;
              }
              saveMutedPlayers(next);
              alert(`Player ${playerId} unmuted.`);
            }
          );
          GM_registerMenuCommand(
            "List muted players",
            () => {
              const hostname = normalizeHostname(location.hostname);
              const items = listMutedPlayers(
                loadMutedPlayers(),
                hostname
              );
              if (items.length === 0) {
                alert("No muted players for this world.");
                return;
              }
              if (items.join("\n").length > 1800) {
                console.log(
                  "[Alliance Discord] Muted players for " + hostname + ":\n" + items.join("\n")
                );
                alert(
                  "Muted players for this world are too long for a dialog — see console."
                );
                return;
              }
              alert(
                "Muted players for " + hostname + ":\n" + items.join("\n")
              );
            }
          );
          const startupVersion = typeof GM_info !== "undefined" && GM_info && GM_info.script && typeof GM_info.script.version === "string" && GM_info.script.version !== "" ? GM_info.script.version : "unknown";
          console.log(
            "[Alliance Discord] Script " + startupVersion + " started."
          );
          initAdminPanel();
          flushPendingBatch();
          installReadinessObserver();
          scheduleRandomReload();
          scheduleBatchFlush();
          await new Promise((resolve) => {
            releaseWebLock = resolve;
          });
        }
      ).catch((error) => {
        tabLeaseActive = false;
        setStandbyVisibility(true);
        console.warn("[Alliance Discord] Web Lock authority unavailable.", error);
      });
    }, getStartupAcquisitionJitterMs(Math.random()));
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ROUTE_ROLES,
      classifyAllianceRoute,
      lockNameForHostname,
      hasExclusiveWebLocks,
      isLeaseFenceValid,
      isAttackIcon,
      parseAttackCount,
      parseRaidCount,
      classifyEvent,
      diffAttackStates,
      getStoredCount,
      getStoredAttackCount,
      getStoredRaidCount,
      raidWord,
      shouldRebaseline,
      extractPlayerId,
      extractMembersFromTable,
      computeUnmappedPlayers,
      buildMappingKey,
      validateDiscordUserId,
      validateDiscordRoleId,
      normalizeProfileInput,
       buildPlayerWorkspaceModel,
       buildPlayerWorkspaceReadModel,
       inspectMappingStorage,
       inspectDiscordConfigStorage,
       loadMappingsProvenance,
       loadDiscordConfigProvenance,
       buildStorageProvenanceModel,
       storageProvenanceText,
       paginatePlayerWorkspaceRows,
       formatPlayerPaginationStatus,
       describePlayerFilterState,
       formatTraceCountStatus,
       describeFreshnessState,
       describeAlertRoleError,
       describeAlertThresholdError,
      writeVerifiedJson,
      addMapping,
      removeMapping,
      listMappings,
      setAlertRoleId,
      clearAlertRoleId,
      setLeaveRoleId,
      clearLeaveRoleId,
      loadMappings,
      saveMappings,
      loadDiscordConfig,
      saveDiscordConfig,
      loadMutedPlayers,
      saveMutedPlayers,
      addMutedPlayer,
      removeMutedPlayer,
      isPlayerMuted,
      listMutedPlayers,
      PLAYER_NAMES_STORAGE_KEY,
      loadPlayerNames,
      savePlayerNames,
      addPlayerNamesBatch,
      buildIdToName,
       PLAYER_NAMES_NOT_FOUND_KEY,
       NAME_NOT_FOUND_TTL_MS,
       NAME_BACKFILL_TIMEOUT_MS,
       NAME_BACKFILL_MAX_CONCURRENCY,
      loadPlayerNamesNotFound,
      savePlayerNamesNotFound,
      markPlayerNamesNotFound,
      buildNotFoundIdSet,
      ROSTER_STORAGE_KEY,
      loadRoster,
      saveRoster,
      buildRosterMap,
      diffRoster,
      collectUnknownIds,
      extractNameFromProfileHtml,
      filterMutedEvents,
      buildMentionContent,
      buildAllowedMentions,
      getDefaultSettings,
       validateSettings,
       loadSettings,
       saveSettings,
       SETTINGS_BACKUP_DATA_KEYS,
       maskWebhookUrl,
       buildSettingsBackup,
       inspectSettingsBackup,
       applySettingsBackup,
       applyEventThresholds,
      classifyPriority,
      PRIORITY_COLORS,
      resolveEventPriority,
      highestBatchPriority,
      batchPriorityColor,
      priorityLabel,
      DISCORD_CONTENT_LIMIT,
      EMBED_DESCRIPTION_LIMIT,
      EMBED_FIELD_VALUE_LIMIT,
      EMBED_TOTAL_TEXT_LIMIT,
      DISCORD_EMBEDS_LIMIT,
      EMBED_DESCRIPTION_SAFE_BUDGET,
      EMBED_TOTAL_SAFE_BUDGET,
      EVENT_NAME_MAX,
      EVENT_URL_MAX,
      toPendingEvent,
      truncateText,
      encodeMarkdownUrl,
      safeProfileUrl,
      safeAllianceUrl,
      buildCompactDiscordTitle,
      buildCompactDiscordPlayerLine,
      buildCompactDiscordSummaryFields,
      buildCompactDiscordTiming,
      buildCompactDiscordPresentation,
      isValidDiscordTime,
      measureDiscordEmbedText,
      partitionCompactDiscordEntries,
      selectMentions,
      buildEventDescriptionLine,
      buildDiscordPayloads,
      buildProfileLink,
      chunkEventsForDiscord,
      SETTINGS_STORAGE_KEY,
      HISTORY_STORAGE_KEY,
      HISTORY_MAX_EVENTS,
      buildHistoryRecord,
      recordHistory,
      loadHistory,
      saveHistory,
      aggregateHistory,
      PENDING_BATCH_STORAGE_KEY,
      BATCH_FLUSH_MS,
      QUEUE_MAX_EVENTS,
      PAYLOAD_CHUNK_MAX,
      loadPendingBatch,
      savePendingBatch,
      enqueueEvents,
      snapshotBatch,
      chunkEvents,
      clearBatchEvents,
      DIAGNOSTICS_STORAGE_KEY,
      MAX_ATTEMPT_COUNT,
      RETRY_DELAY_MS,
      isRetryableOutcome,
      WEBHOOK_STORAGE_KEY,
      REQUEST_TIMEOUT_MS,
      MAX_RETRY_DELAY_MS,
      validateWebhookUrl,
      loadWebhookUrl,
      saveWebhookUrl,
      clearWebhookUrl,
      parseRetryAfterMs,
      sanitizeRetryDelay,
      createMonitorQueueEvent,
      encodeSourceTuple,
      sourceEventIdFromTuple,
      sourceEventTuple,
      decodeSourceEventId,
      computeQueueAge,
      buildDiscordRequestUrl,
      classifyDiscordResponse,
      sendDiscordPayload,
      sendDiscordPayloadWithRetry,
      DRAIN_POLL_MS,
      DRAIN_MAX_WAIT_MS,
      shouldKeepWaitingForDrain,
      MEMBER_TABLE_REASON_CODES,
      selectMemberTable,
      selectAuthoritativeMemberTable,
      isAlliancePageReady,
      isReadinessReady,
      SCAN_CYCLE_DEADLINE_MS,
      SCAN_CYCLE_QUIET_MS,
      SCAN_COMMIT_ERROR_REASONS,
      RELOAD_REFUSAL_REASONS,
      isScanCycleReady,
      createScanCycleId,
      decideScanCycleOutcome,
       isScanTerminalRecord,
       selectScanTerminalRecord,
       selectLatestScanTerminalRecord,
       describeScanTerminal,
       classifyReloadRefusal,
      checkLifecycleFence,
      isLifecycleFenceValid,
      STARTUP_ACQUIRE_JITTER_MIN_MS,
      STARTUP_ACQUIRE_JITTER_MAX_MS,
      getStartupAcquisitionJitterMs,
      createDocumentScanState,
      shouldAttemptDocumentScan,
      markDocumentScanAttempted,
      resetDocumentScanState,
      checkTooltipSourceAgreement,
      parseNormalizedMemberIcon,
      parseNormalizedMemberRow,
      buildStableTableSignature,
      extractAllianceSnapshotFromRows,
      extractAllianceSnapshotFromDocument,
      parseMemberSnapshot,
      buildAllianceSnapshot,
      diffAllianceSnapshots,
      migrationFriendlyCountRecords,
      MONITOR_ENVELOPE_SCHEMA_VERSION,
      MONITOR_ACTIVE_STORAGE_KEY_PREFIX,
      MONITOR_BACKUP_STORAGE_KEY_PREFIX,
      MONITOR_QUARANTINE_STORAGE_KEY_PREFIX,
      MONITOR_MAX_PENDING_RECORDS,
      MONITOR_QUARANTINE_MAX_ENTRIES,
      MONITOR_QUARANTINE_MAX_BYTES,
      canonicalSerializeMonitorValue,
      checksumMonitorCanonicalValue,
      createMonitorEnvelopeV1,
      serializeMonitorEnvelopeV1,
      parseMonitorEnvelopeV1,
      compareMonitorGenerations,
      isMonitorGenerationFenced,
      monitorActiveStorageKey,
      monitorBackupStorageKey,
      monitorQuarantineStorageKey,
      quarantineMonitorRawV1,
      loadMonitorEnvelopeV1,
      planMonitorLegacyMigration,
      migrateLegacyMonitorStateV1,
      loadOrMigrateMonitorEnvelopeV1,
      LEGACY_CANONICAL_EVENT_FIELDS,
      canonicalLegacyEventFields,
      canonicalizeLegacyActiveEvent,
      canonicalizeLegacyHistoryRecord,
      decodeLegacyIdentity,
      coalesceMonitorPendingEvents,
      planAcceptedScanTransition,
      commitMonitorEnvelope,
      commitMonitorEnvelopeV1,
      applyMonitorQueueTransitionV1,
      commitMonitorQueueTransitionV1,
      compactDeliveryAccountingV1,
      prepareTerminalCompactionV1,
      resumeTerminalCompactionV1,
      DISPATCH_CHUNK_STATES,
      buildDispatchPlanV1,
      buildDispatchRequestV1,
      ackHashForDiscordMessageId,
      applyDispatchPlanTransitionV1,
      createDispatchPlanInAccountingV1,
      commitDispatchPlanTransitionV1,
      FAILED_BATCH_STORAGE_KEY,
      FAILED_QUEUE_MAX_EVENTS,
      loadFailedBatch,
      saveFailedBatch,
      enqueueFailedEvents,
      getFailedEvents,
      countFailedEvents,
      clearFailedEvents,
      requeueFailedEvents,
      TAB_LEASE_STORAGE_KEY,
      TAB_LEASE_TTL_MS,
      TAB_LEASE_RENEW_MS,
      TAB_LEASE_RETRY_MS,
      parseLease,
      classifyLease,
      isLeaseActive,
      createTabOwnerId,
      getOrCreateTabOwnerId,
      createLeaseToken,
      loadLease,
      loadLeaseRecord,
      saveLease,
      acquireLease,
      renewLease,
      releaseLease,
      loadDiagnostics,
      saveDiagnostics,
      DIAGNOSTICS_SCHEMA_VERSION,
      DIAGNOSTICS_LIMITS,
      canonicalSerializeDiagnostics,
      diagnosticByteLength,
      createDiagnosticsWorldV2,
      appendDiagnosticTraceV2,
      serializeDiagnosticsConsoleV2,
      serializeDiagnosticsExportV2,
      loadDiagnosticsV2,
      saveDiagnosticsV2,
      recordDiagnosticTraceV2,
      canonicalSerializeDiagnosticValue,
      createDiagnosticWorldV2,
      appendDiagnosticRecordV2,
      serializeDiagnosticConsoleV2,
      serializeDiagnosticExportV2,
      boundedDiagnosticRecords,
      buildCountReconciliationPanelModel,
      buildIncidentBundle,
      monotonicDurationMs,
      recordDuration,
      createVisibilityDriftTracker,
      updateVisibilityDriftTracker,
      sanitizeDiagnosticText,
      sanitizeDiagnosticsExport,
      buildScanSummaryLog,
      DEBUG_VERBOSE_STORAGE_KEY,
      recordFailure,
      addInFlightChunk,
      getInFlightChunks,
      dropInFlightHead,
      replaceInFlightHeadAttempt,
      buildHistoryPanelRows,
      buildStatsPanelModel,
      buildDiagnosticsPanelModel,
      buildStatusPanelModel,
      createAdminDraftState,
      isAdminDraftEmpty,
      supportsInputSelection,
      readSessionStorageSafely,
      persistAdminDraft,
      restoreAdminDraft,
      gateAdminDraftReload,
      resolvePanelExit,
      PANEL_BACKFILL_ORPHAN_CAP,
       createNameBackfillPlan,
       runNameBackfill,
      isPanelAsyncResultCurrent,
      patchPlayerNameNodes,
      applyPanelLeaseState,
      runAttackLifecycleForDocument,
      monitorStorageAdapter
    };
  }
})();
