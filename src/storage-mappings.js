'use strict';

// Extracted storage domain: mappings + discord config (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const MAPPING_STORAGE_KEY = kernel.MAPPING_STORAGE_KEY;
const DISCORD_CONFIG_STORAGE_KEY = kernel.DISCORD_CONFIG_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
const validateDiscordUserId = kernel.validateDiscordUserId;
const validateDiscordRoleId = kernel.validateDiscordRoleId;
const writeVerifiedJson = kernel.writeVerifiedJson;
  function loadMappings() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(MAPPING_STORAGE_KEY);
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
  function saveMappings(mappings) {
    if (keyValueStore() === null) {
      return;
    }
    try {
      keyValueStore().setItem(
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
    if (keyValueStore() === null) {
      return { roleId: null, leaveRoleId: null };
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
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
        keyValueStore(),
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
module.exports = {
  loadMappings, saveMappings, loadDiscordConfig, saveDiscordConfig,
  addMapping, removeMapping, listMappings,
  setAlertRoleId, clearAlertRoleId, setLeaveRoleId, clearLeaveRoleId,
};
