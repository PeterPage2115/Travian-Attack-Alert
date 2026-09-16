'use strict';

// Extraction adapters (plan Todo 7).
//
// Each factory wraps one host capability behind an injected seam so domain
// modules never name host globals directly. The caller supplies the raw
// capability (page handle, lock manager, key/value store, timer pair,
// request bridge); the adapter exposes a narrow typed surface used by
// src/lifecycle.js and, from Todos 8-17, the extracted domains.
// Production wiring is unchanged in this task: nothing requires this file
// yet, so the shipped bundle bytes are identical.

/**
 * @param {any} host
 */
function createStorageAdapter(host) {
  const caps = host || {};
  if (typeof caps.getValue !== 'function' || typeof caps.setValue !== 'function' || typeof caps.deleteValue !== 'function') {
    throw new Error('storage adapter requires getValue/setValue/deleteValue');
  }
  return {
    getValue: (key, fallback) => caps.getValue(key, fallback),
    setValue: (key, value) => { caps.setValue(key, value); },
    deleteValue: (key) => { caps.deleteValue(key); },
  };
}

/**
 * @param {any} host
 */
function createClockAdapter(host) {
  const caps = host || {};
  const nowFn = typeof caps.nowFn === 'function' ? caps.nowFn : () => Date.now();
  const monotonicFn = typeof caps.monotonicFn === 'function' ? caps.monotonicFn : () => Date.now();
  return {
    now: () => nowFn(),
    monotonic: () => monotonicFn(),
  };
}

/**
 * @param {any} host
 */
function createSleepAdapter(host) {
  const caps = host || {};
  const setTimer = typeof caps.setTimer === 'function' ? caps.setTimer : setTimeout;
  const clearTimer = typeof caps.clearTimer === 'function' ? caps.clearTimer : clearTimeout;
  /** @type {Map<any, (value: boolean) => void>} */
  const pending = new Map();
  return {
    delay: (ms) => {
      /** @type {(value: boolean) => void} */
      let settle = () => {};
      const done = new Promise((resolve) => { settle = resolve; });
      const id = setTimer(() => { pending.delete(id); settle(true); }, ms);
      pending.set(id, settle);
      return { id, done };
    },
    cancel: (id) => {
      const settle = pending.get(id);
      if (!settle) return false;
      pending.delete(id);
      clearTimer(id);
      settle(false);
      return true;
    },
  };
}

/**
 * @param {any} host
 */
function createGmRequestAdapter(host) {
  const caps = host || {};
  if (typeof caps.gmRequest !== 'function') throw new Error('request adapter requires gmRequest');
  return {
    request: (details) => caps.gmRequest(details),
  };
}

/**
 * @param {any} host
 */
function createDocumentLocationAdapter(host) {
  const caps = host || {};
  if (!caps.doc || !caps.loc) throw new Error('page adapter requires doc/loc handles');
  return {
    href: () => String(caps.loc.href),
    hostname: () => String(caps.loc.hostname),
    reload: () => caps.loc.reload(),
    title: () => String(caps.doc.title),
  };
}

/**
 * @param {any} host
 */
function createWebLocksAdapter(host) {
  const caps = host || {};
  const locks = caps.locks || null;
  return {
    available: () => Boolean(locks && typeof locks.request === 'function'),
    request: (name, task) => {
      if (!locks || typeof locks.request !== 'function') throw new Error('exclusive locks are unavailable');
      return locks.request(name, task);
    },
  };
}

/**
 * @param {any} host
 */
function createSessionStorageAdapter(host) {
  const caps = host || {};
  const store = caps.store || null;
  if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function' || typeof store.removeItem !== 'function') {
    throw new Error('session adapter requires a getItem/setItem/removeItem store');
  }
  return {
    getItem: (key) => store.getItem(key),
    setItem: (key, value) => { store.setItem(key, String(value)); },
    removeItem: (key) => { store.removeItem(key); },
  };
}

module.exports = {
  createStorageAdapter,
  createClockAdapter,
  createSleepAdapter,
  createGmRequestAdapter,
  createDocumentLocationAdapter,
  createWebLocksAdapter,
  createSessionStorageAdapter,
};
