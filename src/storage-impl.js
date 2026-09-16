'use strict';

// Extracted storage persistence kernel (plan Todo 8).
//
// Owns the injected persistence seam plus the shared storage primitives that
// every storage domain module builds on: the frozen key registry, verified
// JSON writes with readback, mapping-key construction, webhook persistence,
// and the small pure validators every domain needs. Host capabilities arrive
// only through configureStorageAdapters/createStorageImpl (key-value,
// host-value, and queue-contract factory seams); this file names no host
// global. The legacy authority in src/runtime.js is byte-untouched in this
// task; differential behavior is pinned by
// test/characterization/storage-roundtrip.test.cjs.
const adapters = require('./adapters.js');

let activeKvStore = null;
let activeGmStore = null;
let activeQueueEventFactory = null;

function configureStorageAdapters(seam) {
  const source = seam && typeof seam === 'object' ? seam : {};
  if (Object.prototype.hasOwnProperty.call(source, 'keyValue')) {
    const kv = source.keyValue;
    activeKvStore = (kv === null || kv === undefined)
      ? null
      : adapters.createSessionStorageAdapter({ store: kv });
  }
  if (Object.prototype.hasOwnProperty.call(source, 'gm')) {
    activeGmStore = source.gm === null || source.gm === undefined
      ? null
      : adapters.createStorageAdapter(source.gm);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'queueEventFactory')) {
    const factory = source.queueEventFactory;
    if (factory !== null && factory !== undefined && typeof factory !== 'function') {
      throw new Error('storage seam requires a queue event factory function');
    }
    activeQueueEventFactory = factory === undefined ? activeQueueEventFactory : factory;
  }
  return { keyValue: activeKvStore !== null, gm: activeGmStore !== null, queueEventFactory: activeQueueEventFactory !== null };
}

function resetStorageAdapters() {
  activeKvStore = null;
  activeGmStore = null;
  activeQueueEventFactory = null;
}

function keyValueStore() {
  return activeKvStore;
}

function gmStore() {
  return activeGmStore;
}

function requireQueueEventFactory() {
  if (typeof activeQueueEventFactory !== 'function') {
    throw new Error('storage queue contract requires a queue event factory');
  }
  return activeQueueEventFactory;
}
  const STORAGE_KEY = "travianAllianceIncomingAttacks_v40";
  const MAPPING_STORAGE_KEY = "travianAlliancePlayerMappings_v1";
  const DISCORD_CONFIG_STORAGE_KEY = "travianAllianceDiscordConfig_v1";
  const WEBHOOK_STORAGE_KEY = "travianAllianceWebhookUrl_v1";
  const MUTED_PLAYERS_STORAGE_KEY = "travianAllianceMutedPlayers_v1";
  const PLAYER_NAMES_STORAGE_KEY = "travianAlliancePlayerNames_v1";
  const PLAYER_NAMES_NOT_FOUND_KEY = "travianAlliancePlayerNamesNotFound_v1";
  const ROSTER_STORAGE_KEY = "travianAllianceRoster_v1";
  const SETTINGS_STORAGE_KEY = "travianAllianceSettings_v1";
  const HISTORY_STORAGE_KEY = "travianAllianceHistory_v1";
  const PENDING_BATCH_STORAGE_KEY = "travianAlliancePendingBatch_v1";
  const DIAGNOSTICS_STORAGE_KEY = "travianAllianceDiagnostics_v2";
  const FAILED_BATCH_STORAGE_KEY = "travianAllianceFailedBatch_v1";
  function normalizeHostname(hostname) {
    return String(hostname).toLowerCase();
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
  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function writeVerifiedJson(storageApi, key, value) {
    const api = storageApi && typeof storageApi === "object" ? storageApi : {};
    const write = typeof api.setItem === "function" ? api.setItem.bind(api) : api.write;
    const read = typeof api.getItem === "function" ? api.getItem.bind(api) : api.read;
    const canonicalVerifiedValue = (parsed) => {
      if (Array.isArray(parsed)) return "[" + parsed.map(canonicalVerifiedValue).join(",") + "]";
      if (parsed && typeof parsed === "object") return "{" + Object.keys(parsed).sort().map((name) => JSON.stringify(name) + ":" + canonicalVerifiedValue(parsed[name])).join(",") + "}";
      return JSON.stringify(parsed);
    };
    const canonical = (inputValue) => canonicalVerifiedValue(typeof inputValue === "string" ? JSON.parse(inputValue) : inputValue);
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
const STORAGE_KEYS = {
  STORAGE_KEY,
  MAPPING_STORAGE_KEY,
  DISCORD_CONFIG_STORAGE_KEY,
  WEBHOOK_STORAGE_KEY,
  MUTED_PLAYERS_STORAGE_KEY,
  PLAYER_NAMES_STORAGE_KEY,
  PLAYER_NAMES_NOT_FOUND_KEY,
  ROSTER_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  PENDING_BATCH_STORAGE_KEY,
  DIAGNOSTICS_STORAGE_KEY,
  FAILED_BATCH_STORAGE_KEY,
};

module.exports = {
  STORAGE_KEYS,
  STORAGE_KEY,
  MAPPING_STORAGE_KEY,
  DISCORD_CONFIG_STORAGE_KEY,
  WEBHOOK_STORAGE_KEY,
  MUTED_PLAYERS_STORAGE_KEY,
  PLAYER_NAMES_STORAGE_KEY,
  PLAYER_NAMES_NOT_FOUND_KEY,
  ROSTER_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  PENDING_BATCH_STORAGE_KEY,
  DIAGNOSTICS_STORAGE_KEY,
  FAILED_BATCH_STORAGE_KEY,
  configureStorageAdapters,
  resetStorageAdapters,
  keyValueStore,
  gmStore,
  requireQueueEventFactory,
  normalizeHostname,
  parseDiscordSnowflake,
  validateDiscordUserId,
  validateDiscordRoleId,
  validateWebhookUrl,
  cleanText,
  writeVerifiedJson,
};
