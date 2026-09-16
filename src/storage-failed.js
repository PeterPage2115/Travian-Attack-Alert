'use strict';

// Extracted storage domain: failed queue (Todo 8).
const kernel = require('./storage-impl.js');
const keyValueStore = kernel.keyValueStore;
const gmStore = kernel.gmStore;
const requireQueueEventFactory = kernel.requireQueueEventFactory;
const FAILED_BATCH_STORAGE_KEY = kernel.FAILED_BATCH_STORAGE_KEY;
const normalizeHostname = kernel.normalizeHostname;
const pendingQueue = require('./storage-queue.js');
const QUEUE_MAX_EVENTS = pendingQueue.QUEUE_MAX_EVENTS;
const toPendingEvent = pendingQueue.toPendingEvent;
const loadPendingBatch = pendingQueue.loadPendingBatch;
const savePendingBatch = pendingQueue.savePendingBatch;
const enqueueEvents = pendingQueue.enqueueEvents;
const snapshotBatch = pendingQueue.snapshotBatch;
  const FAILED_QUEUE_MAX_EVENTS = 50;
  function loadFailedBatch() {
    if (keyValueStore() === null) {
      return {};
    }
    try {
      const saved = keyValueStore().getItem(
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
    if (keyValueStore() === null) {
      return false;
    }
    try {
      const failedBase = failed && typeof failed === "object" && !Array.isArray(failed) ? failed : {};
      const nextMap = Object.assign({}, failedBase);
      keyValueStore().setItem(
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
module.exports = {
  loadFailedBatch, saveFailedBatch, enqueueFailedEvents,
  getFailedEvents, countFailedEvents, clearFailedEvents, requeueFailedEvents,
};
