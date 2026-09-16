'use strict';

// Extracted storage domain: mutes + player names (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const MUTED_PLAYERS_STORAGE_KEY = kernel.MUTED_PLAYERS_STORAGE_KEY;
const PLAYER_NAMES_STORAGE_KEY = kernel.PLAYER_NAMES_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
const cleanText = kernel.cleanText;
  function loadMutedPlayers() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return;
    }
    try {
      keyValueStore().setItem(
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
  function loadPlayerNames() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return;
    }
    try {
      keyValueStore().setItem(
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
module.exports = {
  loadMutedPlayers, saveMutedPlayers, addMutedPlayer, removeMutedPlayer,
  isPlayerMuted, listMutedPlayers,
  loadPlayerNames, savePlayerNames, addPlayerNamesBatch, buildIdToName,
};
