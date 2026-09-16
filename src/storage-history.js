'use strict';

// Extracted storage domain: history (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const HISTORY_STORAGE_KEY = kernel.HISTORY_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
const identity = require('./storage-identity.js');
const extractPlayerId = identity.extractPlayerId;
const mutes = require('./storage-mutes.js');
const isPlayerMuted = mutes.isPlayerMuted;
  const HISTORY_MAX_EVENTS = 500;
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
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return;
    }
    try {
      const saved = keyValueStore().getItem(
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
      keyValueStore().setItem(
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
module.exports = {
  buildHistoryRecord, recordHistory, loadHistory, saveHistory,
  aggregateHistory,
};
