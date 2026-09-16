'use strict';

// Extracted storage domain: provenance inspection + text (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const MAPPING_STORAGE_KEY = kernel.MAPPING_STORAGE_KEY;
const DISCORD_CONFIG_STORAGE_KEY = kernel.DISCORD_CONFIG_STORAGE_KEY;
const validateDiscordRoleId = kernel.validateDiscordRoleId;
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
    const raw = keyValueStore() === null ? null : keyValueStore().getItem(MAPPING_STORAGE_KEY);
    return inspectMappingStorage(raw, hostname);
  }
  function loadDiscordConfigProvenance() {
    const raw = keyValueStore() === null ? null : keyValueStore().getItem(DISCORD_CONFIG_STORAGE_KEY);
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
module.exports = {
  inspectMappingStorage, inspectDiscordConfigStorage,
  loadMappingsProvenance, loadDiscordConfigProvenance,
  buildStorageProvenanceModel, storageProvenanceText,
};
