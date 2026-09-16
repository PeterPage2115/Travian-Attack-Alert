'use strict';

// Extracted storage domain: not-found marks + roster (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const PLAYER_NAMES_NOT_FOUND_KEY = kernel.PLAYER_NAMES_NOT_FOUND_KEY;
const ROSTER_STORAGE_KEY = kernel.ROSTER_STORAGE_KEY;
const cleanText = kernel.cleanText;
  const NAME_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  function loadPlayerNamesNotFound() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return;
    }
    try {
      keyValueStore().setItem(
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
  function loadRoster() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return;
    }
    try {
      keyValueStore().setItem(
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
module.exports = {
  loadPlayerNamesNotFound, savePlayerNamesNotFound,
  markPlayerNamesNotFound, buildNotFoundIdSet,
  loadRoster, saveRoster, buildRosterMap, diffRoster,
};
