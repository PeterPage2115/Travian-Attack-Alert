'use strict';

// Extracted storage domain: pending queue (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const PENDING_BATCH_STORAGE_KEY = kernel.PENDING_BATCH_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
const identity = require('./storage-identity.js');
const extractPlayerId = identity.extractPlayerId;
  const QUEUE_MAX_EVENTS = 50;
  const PAYLOAD_CHUNK_MAX = 20;
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
    return requireQueueEventFactory()(pending, Object.assign({}, options, {
      playerId: options.playerId !== void 0 ? options.playerId : event.playerId || event.id || extractPlayerId(event.url),
      observedAtMs: Number.isFinite(options.observedAtMs) ? options.observedAtMs : event.observedAtMs,
      queuedAtMs: Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : event.queuedAtMs
    }));
  }
  function loadPendingBatch() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
  function savePendingBatch(batch, hostname) {
    if (keyValueStore() === null) {
      return false;
    }
    try {
      const saved = keyValueStore().getItem(
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
      keyValueStore().setItem(
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
module.exports = {
  QUEUE_MAX_EVENTS,
  PAYLOAD_CHUNK_MAX,
  toPendingEvent,
  loadPendingBatch, savePendingBatch, enqueueEvents,
  snapshotBatch, chunkEvents, clearBatchEvents,
};
