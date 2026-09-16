'use strict';

const adapters = require('./adapters.js');
const { lockNameForHostname } = require('./route.js');

const TAB_LEASE_STORAGE_KEY = 'travianAllianceTabLease_v1';
const TAB_LEASE_TTL_MS = 120000;
const TAB_LEASE_RENEW_MS = 30000;
const TAB_LEASE_RETRY_MS = 10000;
const LEASE_CONSTANTS = Object.freeze({
  TAB_LEASE_STORAGE_KEY,
  TAB_LEASE_TTL_MS,
  TAB_LEASE_RENEW_MS,
  TAB_LEASE_RETRY_MS,
});

let activeStore = null;
let activeSession = null;
let activeClock = adapters.createClockAdapter({});
let activeLocks = adapters.createWebLocksAdapter({ locks: null });
let activeNodeEnvironment = true;
let activeRandomUuid = null;
let activeRandom = Math.random;

function configureLeaseAdapters(seam) {
  const source = seam && typeof seam === 'object' ? seam : {};
  if (Object.prototype.hasOwnProperty.call(source, 'keyValue')) {
    activeStore = source.keyValue == null ? null : adapters.createSessionStorageAdapter({ store: source.keyValue });
  }
  if (Object.prototype.hasOwnProperty.call(source, 'session')) {
    activeSession = source.session == null ? null : adapters.createSessionStorageAdapter({ store: source.session });
  }
  if (Object.prototype.hasOwnProperty.call(source, 'clock')) activeClock = adapters.createClockAdapter(source.clock || {});
  if (Object.prototype.hasOwnProperty.call(source, 'webLocks')) activeLocks = adapters.createWebLocksAdapter({ locks: source.webLocks });
  if (Object.prototype.hasOwnProperty.call(source, 'nodeEnvironment')) activeNodeEnvironment = source.nodeEnvironment === true;
  if (Object.prototype.hasOwnProperty.call(source, 'randomUuid')) activeRandomUuid = typeof source.randomUuid === 'function' ? source.randomUuid : null;
  if (Object.prototype.hasOwnProperty.call(source, 'random')) activeRandom = typeof source.random === 'function' ? source.random : Math.random;
  return { keyValue: activeStore !== null, session: activeSession !== null, webLocks: activeLocks.available() };
}

function resetLeaseAdapters() {
  activeStore = null;
  activeSession = null;
  activeClock = adapters.createClockAdapter({});
  activeLocks = adapters.createWebLocksAdapter({ locks: null });
  activeNodeEnvironment = true;
  activeRandomUuid = null;
  activeRandom = Math.random;
}

function parseLeaseRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId.trim() : '';
  if (ownerId === '' || typeof raw.expiresAtMs !== 'number' || !Number.isFinite(raw.expiresAtMs)) return null;
  const record = { ownerId, expiresAtMs: raw.expiresAtMs };
  if (typeof raw.token === 'string' && raw.token.trim() !== '') record.token = raw.token.trim();
  if (Number.isInteger(raw.generation) && raw.generation >= 0) record.generation = raw.generation;
  if (Number.isInteger(raw.term) && raw.term >= 0) record.term = raw.term;
  return record;
}

function parseLease(raw) {
  const record = parseLeaseRecord(raw);
  return record ? { ownerId: record.ownerId, expiresAtMs: record.expiresAtMs } : null;
}

function classifyLease(parsed, ownerId, nowMs) {
  const lease = parseLease(parsed);
  if (lease === null) return 'none';
  const now = Number.isFinite(nowMs) ? nowMs : activeClock.now();
  if (lease.expiresAtMs <= now) return 'expired';
  return lease.ownerId === ownerId ? 'own' : 'foreign';
}

function isLeaseActive(parsed, ownerId, nowMs) {
  return classifyLease(parsed, ownerId, nowMs) === 'own';
}

function isLeaseFenceValid(actual, expected) {
  return Boolean(actual && expected && actual.ownerId === expected.ownerId && actual.term === expected.term && actual.generation === expected.generation);
}

function hasExclusiveWebLocks() {
  return activeNodeEnvironment || activeLocks.available();
}

function requestExclusiveLock(hostname, task) {
  return activeLocks.request(lockNameForHostname(hostname), task);
}

function createTabOwnerId() {
  try {
    if (activeRandomUuid) return activeRandomUuid();
  } catch (error) {}
  const randomPart = () => Math.floor(activeRandom() * 4294967296).toString(16).padStart(8, '0');
  return `tab-${randomPart()}${randomPart()}-${randomPart()}-${activeClock.now().toString(36)}`;
}

function getOrCreateTabOwnerId() {
  const key = 'taa-tab-owner-id';
  try {
    if (activeSession) {
      const existing = activeSession.getItem(key);
      if (typeof existing === 'string' && existing.length > 0) return existing;
      const fresh = createTabOwnerId();
      activeSession.setItem(key, fresh);
      return fresh;
    }
  } catch (error) {}
  return createTabOwnerId();
}

function createLeaseToken() {
  return `${createTabOwnerId()}:${activeClock.now().toString(36)}`;
}

function normalizeHostname(hostname) {
  return String(hostname).toLowerCase();
}

function readLeaseMap() {
  if (!activeStore) return null;
  const saved = activeStore.getItem(TAB_LEASE_STORAGE_KEY);
  const parsed = saved ? JSON.parse(saved) : null;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function loadLease(hostname) {
  if (!activeStore) return null;
  try {
    const map = readLeaseMap();
    return parseLease(map ? map[normalizeHostname(hostname)] : null);
  } catch (error) {
    console.error('[Alliance Discord] Tab lease read error:', error);
    return null;
  }
}

function loadLeaseRecord(hostname) {
  if (!activeStore) return null;
  try {
    const map = readLeaseMap();
    return parseLeaseRecord(map ? map[normalizeHostname(hostname)] : null);
  } catch (error) {
    return null;
  }
}

function saveLease(hostname, lease) {
  if (!activeStore) return false;
  try {
    let map = {};
    try { map = readLeaseMap() || {}; } catch (error) { map = {}; }
    const nextMap = Object.assign({}, map);
    nextMap[normalizeHostname(hostname)] = lease;
    activeStore.setItem(TAB_LEASE_STORAGE_KEY, JSON.stringify(nextMap));
    return true;
  } catch (error) {
    console.error('[Alliance Discord] Tab lease save error:', error);
    return false;
  }
}

function acquireLease(hostname, ownerId, nowMs) {
  const worldKey = normalizeHostname(hostname);
  const now = Number.isFinite(nowMs) ? nowMs : activeClock.now();
  if (!activeStore || !hasExclusiveWebLocks()) return null;
  try {
    const existing = loadLeaseRecord(worldKey);
    if (classifyLease(existing, ownerId, now) === 'foreign') return false;
    const lease = {
      ownerId,
      expiresAtMs: now + TAB_LEASE_TTL_MS,
      term: (existing && Number.isInteger(existing.term) ? existing.term : 0) + 1,
      generation: existing && Number.isInteger(existing.generation) ? existing.generation + 1 : 1,
      token: createLeaseToken(),
    };
    if (!saveLease(worldKey, lease)) return null;
    const verified = loadLeaseRecord(worldKey);
    return Boolean(verified && verified.ownerId === ownerId && verified.token === lease.token && verified.term === lease.term && verified.generation === lease.generation && isLeaseActive(verified, ownerId, now));
  } catch (error) {
    console.error('[Alliance Discord] Tab lease acquire error:', error);
    return null;
  }
}

function renewLease(hostname, ownerId, nowMs, expectedToken) {
  const worldKey = normalizeHostname(hostname);
  const now = Number.isFinite(nowMs) ? nowMs : activeClock.now();
  if (!hasExclusiveWebLocks()) return false;
  const existing = loadLeaseRecord(worldKey);
  if (!isLeaseActive(existing, ownerId, now)) return false;
  if (typeof expectedToken === 'string' && expectedToken !== existing.token) return false;
  return saveLease(worldKey, { ownerId, expiresAtMs: now + TAB_LEASE_TTL_MS, token: existing.token, generation: existing.generation, term: existing.term });
}

function releaseLease(hostname, ownerId, nowMs, expectedTerm) {
  if (!activeStore || !hasExclusiveWebLocks()) return false;
  try {
    const worldKey = normalizeHostname(hostname);
    const now = Number.isFinite(nowMs) ? nowMs : activeClock.now();
    const existing = loadLeaseRecord(worldKey);
    if (!isLeaseActive(existing, ownerId, now)) return false;
    if (Number.isInteger(expectedTerm) && existing.term !== expectedTerm) return false;
    const nextMap = Object.assign({}, readLeaseMap() || {});
    delete nextMap[worldKey];
    activeStore.setItem(TAB_LEASE_STORAGE_KEY, JSON.stringify(nextMap));
    return true;
  } catch (error) {
    console.error('[Alliance Discord] Tab lease release error:', error);
    return false;
  }
}

function checkLifecycleFence(active, expectedToken, currentToken) {
  return { outcome: active === true && typeof expectedToken === 'string' && expectedToken.length > 0 && expectedToken === currentToken ? 'ok' : 'fenced-reject' };
}

function isLifecycleFenceValid(active, expectedToken, currentToken) {
  return checkLifecycleFence(active, expectedToken, currentToken).outcome === 'ok';
}

module.exports = {
  LEASE_CONSTANTS, configureLeaseAdapters, resetLeaseAdapters, parseLeaseRecord,
  requestExclusiveLock, parseLease, classifyLease, isLeaseActive,
  createTabOwnerId, getOrCreateTabOwnerId, createLeaseToken, loadLease,
  loadLeaseRecord, saveLease, acquireLease, renewLease, releaseLease,
  isLeaseFenceValid, checkLifecycleFence, isLifecycleFenceValid,
  lockNameForHostname, hasExclusiveWebLocks,
};
