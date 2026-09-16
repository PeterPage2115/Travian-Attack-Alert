'use strict';

// Sole owner of mutable lifecycle state (plan Todo 7).
//
// Every field below previously lived as scattered module state inside the
// legacy authority. This file is now the single place that may declare and
// mutate these bindings; all other domains receive the controller object
// built by createLifecycleController(adapters) and must never retain copies
// of its fields. Capabilities (clocks, timers, stores, page handles, locks,
// request bridges) arrive only through the injected adapters seam, so this
// file names no host global directly. Production wiring is unchanged in this
// task: the legacy authority still runs until Todos 8-17 extract each domain.

let previousState = null;
let lastScanAtMs = null;
let nextReloadAtMs = null;
let tabLeaseActive = false;
let tabLeaseBestEffort = false;
let tabLeaseToken = null;
let tabLeaseGeneration = null;
let tabLeaseTerm = null;
let activeLeaseOwnerId = null;
let lifecycleEpoch = 0;
let readinessObserver = null;
let readinessStartedAtMono = null;
let visibilityDriftState = null;
let readinessTimerId = null;
let scanDeadlineTimerId = null;
let scanCycleId = null;
let scheduledReloadTimerId = null;
let flushTimerId = null;
let followerWatchdogTimerId = null;
let followerWatchdogCheck = null;
const lifecycleTimerIds = new Set();
let cancelPanelAsyncWork = null;
let panelRuntimeTimerId = null;
/** @type {any} */
let activeAdapters = null;

function requireAdapters() {
  if (!activeAdapters) throw new Error('lifecycle controller has no adapters');
  return activeAdapters;
}

/**
 * @param {any} adapters seven extraction adapters (see src/adapters.js)
 * @returns {any} controller bound to the sole copy of lifecycle state
 */
function createLifecycleController(adapters) {
  if (!adapters || typeof adapters !== 'object') throw new Error('lifecycle controller requires adapters');
  activeAdapters = adapters;
  return {
    getSnapshot() {
      return {
        previousState,
        lastScanAtMs,
        nextReloadAtMs,
        tabLeaseActive,
        tabLeaseBestEffort,
        tabLeaseToken,
        tabLeaseGeneration,
        tabLeaseTerm,
        activeLeaseOwnerId,
        lifecycleEpoch,
        readinessObserver,
        readinessStartedAtMono,
        visibilityDriftState,
        readinessTimerId,
        scanDeadlineTimerId,
        scanCycleId,
        scheduledReloadTimerId,
        flushTimerId,
        followerWatchdogTimerId,
        followerWatchdogCheck,
        lifecycleTimerIds: [...lifecycleTimerIds],
        cancelPanelAsyncWork,
        panelRuntimeTimerId,
      };
    },
    setLease(record) {
      if (!record || typeof record !== 'object' || typeof record.token !== 'string' || record.token.length === 0) {
        return false;
      }
      tabLeaseActive = true;
      tabLeaseBestEffort = record.bestEffort === true;
      tabLeaseToken = record.token;
      tabLeaseGeneration = Number.isFinite(record.generation) ? record.generation : null;
      tabLeaseTerm = Number.isFinite(record.term) ? record.term : null;
      activeLeaseOwnerId = typeof record.ownerId === 'string' ? record.ownerId : null;
      lifecycleEpoch += 1;
      return true;
    },
    loseLease(reason) {
      tabLeaseActive = false;
      tabLeaseBestEffort = false;
      tabLeaseToken = null;
      tabLeaseGeneration = null;
      tabLeaseTerm = null;
      activeLeaseOwnerId = null;
      lifecycleEpoch += 1;
      return String(reason);
    },
    beginScan(documentToken) {
      const seam = requireAdapters();
      scanCycleId = typeof documentToken === 'string' ? documentToken : null;
      const clock = seam.clock;
      lastScanAtMs = clock && typeof clock.now === 'function' ? clock.now() : Date.now();
      return scanCycleId;
    },
    finishScan(outcome) {
      if (scanCycleId === null) return false;
      if (outcome && typeof outcome === 'object' && outcome.state !== undefined) {
        previousState = outcome.state;
      }
      scanCycleId = null;
      return true;
    },
    setReadinessObserver(observer) {
      const seam = requireAdapters();
      const previous = readinessObserver;
      readinessObserver = observer || null;
      const clock = seam.clock;
      readinessStartedAtMono = clock && typeof clock.monotonic === 'function' ? clock.monotonic() : Date.now();
      return previous;
    },
    setNextReloadAt(ms) {
      nextReloadAtMs = Number.isFinite(ms) ? ms : null;
      return nextReloadAtMs;
    },
    canMutate(fence) {
      if (tabLeaseActive !== true) return false;
      if (fence === undefined || fence === null) return true;
      return Boolean(fence && typeof fence === 'object' && fence.token === tabLeaseToken);
    },
    dispose(reason) {
      const label = String(reason);
      readinessTimerId = null;
      scanDeadlineTimerId = null;
      scanCycleId = null;
      scheduledReloadTimerId = null;
      flushTimerId = null;
      followerWatchdogTimerId = null;
      followerWatchdogCheck = null;
      lifecycleTimerIds.clear();
      cancelPanelAsyncWork = null;
      panelRuntimeTimerId = null;
      readinessObserver = null;
      readinessStartedAtMono = null;
      return label;
    },
  };
}

module.exports = { createLifecycleController };
