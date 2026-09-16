'use strict';

// Extracted acquisition kernel (plan Todo 16).
//
// Owns the full 8-symbol runtime-api.acquisition contract exactly as the
// legacy authority in src/runtime.js defines it: startup jitter scaling,
// the pure per-page scan-state value kernel, the attack lifecycle
// orchestration matrix, the monitor storage adapter, and the drain-wait
// gate. Host capabilities arrive only through the injected Todo 7 seam
// (configureAcquisitionAdapters takes a GM-style keyValue capability used
// as the no-store fallback; without it the stub matches the authority's
// Node-observable behavior). Mutable lifecycle state is never declared
// here: the controller built by src/lifecycle.js
// (configureAcquisitionLifecycle) is the single owner, and this module
// keeps no copy of any of its singletons. This file names no host global.
// The legacy authority in src/runtime.js is byte-untouched in this task;
// differential behavior is pinned by
// test/characterization/acquisition-extract.test.cjs.
const adapters = require('./adapters.js');
const { STARTUP_ACQUIRE_JITTER_MIN_MS, STARTUP_ACQUIRE_JITTER_MAX_MS } = require('./constants.js');

let activeKeyValue = null;
let activeLifecycle = null;

function configureAcquisitionAdapters(seam) {
  const source = seam && typeof seam === 'object' ? seam : {};
  if (Object.prototype.hasOwnProperty.call(source, 'keyValue')) {
    const caps = source.keyValue;
    activeKeyValue = (caps === null || caps === undefined)
      ? null
      : adapters.createStorageAdapter(caps);
  }
  return { keyValue: activeKeyValue !== null };
}

function resetAcquisitionAdapters() { activeKeyValue = null; }

function acquisitionKeyValue() { return activeKeyValue; }

function configureAcquisitionLifecycle(controller) {
  if (controller !== undefined) {
    activeLifecycle = controller && typeof controller === 'object' ? controller : null;
  }
  return { lifecycle: activeLifecycle !== null };
}

function resetAcquisitionLifecycle() { activeLifecycle = null; }

function acquisitionLifecycle() { return activeLifecycle; }

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
function monitorStorageAdapter(storage) {
  if (storage && typeof storage.get === "function" && typeof storage.set === "function") {
    return storage;
  }
  if (activeKeyValue) {
    const backing = activeKeyValue;
    return {
      get(key) { return backing.getValue(key, undefined); },
      set(key, value) { return backing.setValue(key, value); },
      delete(key) { return backing.deleteValue(key); }
    };
  }
  return {
    get(key) {
      return void 0;
    },
    set(key, value) {
      throw new Error("GM storage unavailable");
    },
    delete(key) {
      throw new Error("GM storage unavailable");
    }
  };
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

module.exports = {
  configureAcquisitionAdapters, resetAcquisitionAdapters, acquisitionKeyValue,
  configureAcquisitionLifecycle, resetAcquisitionLifecycle, acquisitionLifecycle,
  getStartupAcquisitionJitterMs, createDocumentScanState,
  shouldAttemptDocumentScan, markDocumentScanAttempted,
  resetDocumentScanState, runAttackLifecycleForDocument,
  monitorStorageAdapter, shouldKeepWaitingForDrain,
};
