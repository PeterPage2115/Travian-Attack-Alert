'use strict';

// Characterization: storage serialization + persistence contract (plan Todo 8).
//
// Pins the exact runtime-api.storage behavior BEFORE extraction (differential
// against src/runtime.js through mocked host globals) and verifies the same
// contract AFTER (src/storage*.js behind injected adapters). Fails while the
// extracted modules are missing; passes only when all 60 symbols, every
// STORAGE_KEY byte, the mapping schema, diagnostic output, provenance model,
// and GM_getValue/GM_setValue/GM_deleteValue behavior match the authority.
//
// Host strategy: the runtime side runs against Map-backed global fakes
// (global.localStorage, global.GM_*); the extracted side runs against
// Map-backed injected adapters. Both maps are seeded identically, then return
// values AND stored bytes are compared. Date.now is frozen per case.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const impl = require(path.join(SRC, 'storage-impl.js'));
const identity = require(path.join(SRC, 'storage-identity.js'));
const webhook = require(path.join(SRC, 'storage-webhook.js'));
const mappingsMod = require(path.join(SRC, 'storage-mappings.js'));
const provenanceMod = require(path.join(SRC, 'storage-provenance.js'));
const mutesMod = require(path.join(SRC, 'storage-mutes.js'));
const rosterMod = require(path.join(SRC, 'storage-roster.js'));
const settingsMod = require(path.join(SRC, 'storage-settings.js'));
const historyMod = require(path.join(SRC, 'storage-history.js'));
const diagnostics = require(path.join(SRC, 'storage-diagnostics.js'));
const queueMod = require(path.join(SRC, 'storage-queue.js'));
const failedMod = require(path.join(SRC, 'storage-failed.js'));
const mappings = Object.assign({}, mappingsMod, provenanceMod);
const players = Object.assign({}, mutesMod, rosterMod);
const settings = Object.assign({}, settingsMod, historyMod);
const queue = Object.assign({}, queueMod, failedMod);
impl.buildMappingKey = identity.buildMappingKey;
impl.loadWebhookUrl = webhook.loadWebhookUrl;
impl.saveWebhookUrl = webhook.saveWebhookUrl;
impl.clearWebhookUrl = webhook.clearWebhookUrl;
const storage = require(path.join(SRC, 'storage.js'));
const runtime = require(path.join(SRC, 'runtime.js'));

const WORLD = 'ts1.travian.com';
const OTHER_WORLD = 'ts2.travian.com';
const FROZEN_NOW = 1700000000000;

const STORAGE_CONTRACT = [
  'writeVerifiedJson', 'buildMappingKey', 'loadMappings', 'saveMappings',
  'addMapping', 'removeMapping', 'listMappings',
  'loadDiscordConfig', 'saveDiscordConfig', 'setAlertRoleId',
  'clearAlertRoleId', 'setLeaveRoleId', 'clearLeaveRoleId',
  'loadMutedPlayers', 'saveMutedPlayers', 'addMutedPlayer',
  'removeMutedPlayer', 'isPlayerMuted', 'listMutedPlayers',
  'loadPlayerNames', 'savePlayerNames', 'addPlayerNamesBatch',
  'buildIdToName', 'loadPlayerNamesNotFound', 'savePlayerNamesNotFound',
  'markPlayerNamesNotFound', 'buildNotFoundIdSet', 'loadRoster', 'saveRoster',
  'buildRosterMap', 'diffRoster', 'buildHistoryRecord', 'recordHistory',
  'loadHistory', 'saveHistory', 'aggregateHistory', 'getDefaultSettings',
  'validateSettings', 'loadSettings', 'saveSettings', 'loadPendingBatch',
  'savePendingBatch', 'enqueueEvents', 'snapshotBatch', 'chunkEvents',
  'clearBatchEvents', 'loadFailedBatch', 'saveFailedBatch',
  'enqueueFailedEvents', 'getFailedEvents', 'countFailedEvents',
  'clearFailedEvents', 'requeueFailedEvents', 'loadWebhookUrl',
  'saveWebhookUrl', 'clearWebhookUrl', 'loadDiagnostics', 'saveDiagnostics',
  'loadDiagnosticsV2', 'saveDiagnosticsV2',
];

const FROZEN_KEYS = {
  STORAGE_KEY: 'travianAllianceIncomingAttacks_v40',
  MAPPING_STORAGE_KEY: 'travianAlliancePlayerMappings_v1',
  DISCORD_CONFIG_STORAGE_KEY: 'travianAllianceDiscordConfig_v1',
  WEBHOOK_STORAGE_KEY: 'travianAllianceWebhookUrl_v1',
  MUTED_PLAYERS_STORAGE_KEY: 'travianAllianceMutedPlayers_v1',
  PLAYER_NAMES_STORAGE_KEY: 'travianAlliancePlayerNames_v1',
  PLAYER_NAMES_NOT_FOUND_KEY: 'travianAlliancePlayerNamesNotFound_v1',
  ROSTER_STORAGE_KEY: 'travianAllianceRoster_v1',
  SETTINGS_STORAGE_KEY: 'travianAllianceSettings_v1',
  HISTORY_STORAGE_KEY: 'travianAllianceHistory_v1',
  PENDING_BATCH_STORAGE_KEY: 'travianAlliancePendingBatch_v1',
  DIAGNOSTICS_STORAGE_KEY: 'travianAllianceDiagnostics_v2',
  FAILED_BATCH_STORAGE_KEY: 'travianAllianceFailedBatch_v1',
};

const VALID_HOOK = 'https://discord.com/api/webhooks/100000000000000001/FAKE_TOKEN_SYNTHETIC_0123456789abcdef';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeKvMap(seed) {
  return new Map(Object.entries(seed || {}));
}

function kvFacade(map, faults) {
  const F = faults || {};
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (F.quota) throw new Error('quota-exceeded-probe');
      map.set(key, String(value));
    },
    removeItem: (key) => { map.delete(key); },
  };
}

function gmFacade(map, faults) {
  const F = faults || {};
  return {
    getValue: (key, fallback) => (map.has(key) ? map.get(key) : fallback),
    setValue: (key, value) => {
      if (F.quota) throw new Error('gm-quota-probe');
      map.set(key, value);
    },
    deleteValue: (key) => { map.delete(key); },
  };
}

function snapshotMaps(kv, gm) {
  const kvOut = {};
  for (const [k, v] of [...kv.entries()].sort()) kvOut[k] = v;
  const gmOut = {};
  for (const [k, v] of [...gm.entries()].sort()) gmOut[k] = v;
  return { kv: kvOut, gm: gmOut };
}

function installRuntimeGlobals(kvMap, gmMap, kvFaults, gmFaults) {
  const saved = {
    ls: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage') ? globalThis.localStorage : undefined,
    get: Object.prototype.hasOwnProperty.call(globalThis, 'GM_getValue') ? globalThis.GM_getValue : undefined,
    set: Object.prototype.hasOwnProperty.call(globalThis, 'GM_setValue') ? globalThis.GM_setValue : undefined,
    del: Object.prototype.hasOwnProperty.call(globalThis, 'GM_deleteValue') ? globalThis.GM_deleteValue : undefined,
    now: Date.now,
    err: console.error,
    warn: console.warn,
  };
  globalThis.localStorage = kvFacade(kvMap, kvFaults);
  globalThis.GM_getValue = (key, fallback) => gmFacade(gmMap, gmFaults).getValue(key, fallback);
  globalThis.GM_setValue = (key, value) => { gmFacade(gmMap, gmFaults).setValue(key, value); };
  globalThis.GM_deleteValue = (key) => { gmFacade(gmMap, gmFaults).deleteValue(key); };
  Date.now = () => FROZEN_NOW;
  const logged = [];
  console.error = (...args) => { logged.push(['error', ...args]); };
  console.warn = (...args) => { logged.push(['warn', ...args]); };
  return {
    logged,
    restore() {
      if (saved.ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.ls;
      if (saved.get === undefined) delete globalThis.GM_getValue; else globalThis.GM_getValue = saved.get;
      if (saved.set === undefined) delete globalThis.GM_setValue; else globalThis.GM_setValue = saved.set;
      if (saved.del === undefined) delete globalThis.GM_deleteValue; else globalThis.GM_deleteValue = saved.del;
      Date.now = saved.now;
      console.error = saved.err;
      console.warn = saved.warn;
    },
  };
}

function configureModuleSide(kvMap, gmMap, kvFaults, gmFaults, extra) {
  const logged = [];
  const err = console.error;
  const warn = console.warn;
  console.error = (...args) => { logged.push(['error', ...args]); };
  console.warn = (...args) => { logged.push(['warn', ...args]); };
  Date.now = () => FROZEN_NOW;
  impl.configureStorageAdapters(Object.assign({
    keyValue: kvFacade(kvMap, kvFaults),
    gm: gmFacade(gmMap, gmFaults),
    queueEventFactory: runtime.createMonitorQueueEvent,
  }, extra || {}));
  return {
    logged,
    restore() {
      console.error = err;
      console.warn = warn;
      impl.resetStorageAdapters();
    },
  };
}

// Date.now was frozen by helpers; restore the real clock after each case.
const REAL_NOW = Date.now;

function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (item instanceof Error) return { __error__: item.message };
    if (item instanceof Map) return { __map__: [...item.entries()] };
    if (item instanceof Set) return { __set__: [...item.values()].sort() };
    return item;
  }));
}

function assertSameBehavior(label, runtimeResult, moduleResult) {
  assert.deepEqual(normalize(moduleResult), normalize(runtimeResult), `${label}: return value drift`);
}

function seedMappings() {
  return {
    [WORLD.toLowerCase()]: { 1001: ['123456789012345678'], 1002: ['123456789012345679', '123456789012345680'] },
    [OTHER_WORLD.toLowerCase()]: { 9001: ['123456789012345681'] },
  };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('storage keys are frozen byte-for-byte', () => {
  assert.deepEqual({ ...impl.STORAGE_KEYS }, FROZEN_KEYS);
  for (const [name, value] of Object.entries(FROZEN_KEYS)) {
    if (runtime[name] !== undefined) assert.equal(runtime[name], value, `${name} drifted in runtime`);
  }
  assert.equal(runtime.WEBHOOK_STORAGE_KEY, FROZEN_KEYS.WEBHOOK_STORAGE_KEY);
  assert.equal(runtime.DIAGNOSTICS_STORAGE_KEY, FROZEN_KEYS.DIAGNOSTICS_STORAGE_KEY);
});

test('storage.js exposes exactly the 60-symbol contract without runtime-api', () => {
  assert.deepEqual(Object.keys(storage).sort(), [...STORAGE_CONTRACT].sort());
  for (const symbol of STORAGE_CONTRACT) {
    assert.equal(typeof storage[symbol], 'function', `${symbol} is not a function`);
    assert.equal(typeof runtime[symbol], 'function', `runtime lost ${symbol}`);
  }
  const source = fs.readFileSync(path.join(SRC, 'storage.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/runtime-api/.test(source), 'storage.js must not re-export through runtime-api.js');
  assert.deepEqual(Object.keys(storage).length, 60);
});

test('mappings roundtrip matches the authority', () => {
  const seed = { [FROZEN_KEYS.MAPPING_STORAGE_KEY]: JSON.stringify(seedMappings()) };
  const kvA = makeKvMap(seed); const gmA = new Map();
  const kvB = makeKvMap(seed); const gmB = new Map();
  const envR = installRuntimeGlobals(kvA, gmA);
  const rLoaded = runtime.loadMappings();
  const rAdded = runtime.addMapping(rLoaded, WORLD, '1003', '123456789012345682, not-an-id');
  runtime.saveMappings(rAdded.mappings);
  const rRemoved = runtime.removeMapping(rAdded.mappings, WORLD, '1001', '123456789012345678');
  const rListed = runtime.listMappings(rRemoved, WORLD);
  const rKey = runtime.buildMappingKey(WORLD, '1003');
  envR.restore();
  const envM = configureModuleSide(kvB, gmB);
  const mLoaded = mappings.loadMappings();
  const mAdded = mappings.addMapping(mLoaded, WORLD, '1003', '123456789012345682, not-an-id');
  mappings.saveMappings(mAdded.mappings);
  const mRemoved = mappings.removeMapping(mAdded.mappings, WORLD, '1001', '123456789012345678');
  const mListed = mappings.listMappings(mRemoved, WORLD);
  const mKey = impl.buildMappingKey(WORLD, '1003');
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadMappings', rLoaded, mLoaded);
  assertSameBehavior('addMapping', rAdded, mAdded);
  assertSameBehavior('removeMapping', rRemoved, mRemoved);
  assertSameBehavior('listMappings', rListed, mListed);
  assert.equal(mKey, rKey);
  assert.deepEqual(snapshotMaps(kvB, gmB), snapshotMaps(kvA, gmA), 'stored mapping bytes drifted');
  assert.equal(envM.logged.length, envR.logged.length, 'diagnostic output count drifted');
});

test('discord config and role ids roundtrip matches the authority', () => {
  const seed = { [FROZEN_KEYS.DISCORD_CONFIG_STORAGE_KEY]: JSON.stringify({ roleId: '123456789012345678', leaveRoleId: null }) };
  const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
  const envR = installRuntimeGlobals(kvA, new Map());
  const rLoaded = runtime.loadDiscordConfig();
  const rSaved = runtime.saveDiscordConfig({ roleId: '123456789012345679', leaveRoleId: '' });
  const rSet = runtime.setAlertRoleId(rLoaded, '123456789012345680');
  const rCleared = runtime.clearAlertRoleId(rSet);
  const rSetLeave = runtime.setLeaveRoleId(rCleared, 'bad-id');
  const rClearedLeave = runtime.clearLeaveRoleId(rSetLeave);
  const rInvalid = runtime.saveDiscordConfig({ roleId: 'bad', leaveRoleId: null });
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mLoaded = mappings.loadDiscordConfig();
  const mSaved = mappings.saveDiscordConfig({ roleId: '123456789012345679', leaveRoleId: '' });
  const mSet = mappings.setAlertRoleId(mLoaded, '123456789012345680');
  const mCleared = mappings.clearAlertRoleId(mSet);
  const mSetLeave = mappings.setLeaveRoleId(mCleared, 'bad-id');
  const mClearedLeave = mappings.clearLeaveRoleId(mSetLeave);
  const mInvalid = mappings.saveDiscordConfig({ roleId: 'bad', leaveRoleId: null });
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadDiscordConfig', rLoaded, mLoaded);
  assertSameBehavior('saveDiscordConfig', rSaved, mSaved);
  assertSameBehavior('setAlertRoleId', rSet, mSet);
  assertSameBehavior('clearAlertRoleId', rCleared, mCleared);
  assertSameBehavior('setLeaveRoleId invalid', rSetLeave, mSetLeave);
  assertSameBehavior('clearLeaveRoleId', rClearedLeave, mClearedLeave);
  assertSameBehavior('saveDiscordConfig invalid', rInvalid, mInvalid);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored discord bytes drifted');
});

test('muted players roundtrip matches the authority', () => {
  const seed = { [FROZEN_KEYS.MUTED_PLAYERS_STORAGE_KEY]: JSON.stringify({ [WORLD.toLowerCase()]: { p1: true } }) };
  const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
  const envR = installRuntimeGlobals(kvA, new Map());
  const rLoaded = runtime.loadMutedPlayers();
  const rAdded = runtime.addMutedPlayer(rLoaded, WORLD, 'p2');
  runtime.saveMutedPlayers(rAdded);
  const rMuted = runtime.isPlayerMuted(rAdded, WORLD, 'p2');
  const rListed = runtime.listMutedPlayers(rAdded, WORLD);
  const rRemoved = runtime.removeMutedPlayer(rAdded, WORLD, 'p1');
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mLoaded = players.loadMutedPlayers();
  const mAdded = players.addMutedPlayer(mLoaded, WORLD, 'p2');
  players.saveMutedPlayers(mAdded);
  const mMuted = players.isPlayerMuted(mAdded, WORLD, 'p2');
  const mListed = players.listMutedPlayers(mAdded, WORLD);
  const mRemoved = players.removeMutedPlayer(mAdded, WORLD, 'p1');
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadMutedPlayers', rLoaded, mLoaded);
  assertSameBehavior('addMutedPlayer', rAdded, mAdded);
  assert.equal(mMuted, rMuted);
  assertSameBehavior('listMutedPlayers', rListed, mListed);
  assertSameBehavior('removeMutedPlayer', rRemoved, mRemoved);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored mute bytes drifted');
});

test('player names, not-found TTL, and roster roundtrip match the authority', () => {
  const seed = {
    [FROZEN_KEYS.PLAYER_NAMES_STORAGE_KEY]: JSON.stringify({ [WORLD.toLowerCase()]: { 7: 'Seven' } }),
    [FROZEN_KEYS.PLAYER_NAMES_NOT_FOUND_KEY]: JSON.stringify({ [WORLD.toLowerCase()]: { 8: FROZEN_NOW - 1000, 9: 1 } }),
    [FROZEN_KEYS.ROSTER_STORAGE_KEY]: JSON.stringify({ [WORLD.toLowerCase()]: { 7: { name: 'Seven', url: 'https://x/profile/7' } } }),
  };
  const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
  const envR = installRuntimeGlobals(kvA, new Map());
  const rNames = runtime.loadPlayerNames();
  const rBatched = runtime.addPlayerNamesBatch(rNames, WORLD, [{ id: '8', name: '  Eight  ' }, { id: '', name: 'x' }, null]);
  runtime.savePlayerNames(rBatched);
  const rIdMap = runtime.buildIdToName(rBatched, WORLD);
  const rNotFound = runtime.loadPlayerNamesNotFound();
  const rMarked = runtime.markPlayerNamesNotFound(rNotFound, WORLD, ['10'], FROZEN_NOW);
  runtime.savePlayerNamesNotFound(rMarked);
  const rNotFoundSet = runtime.buildNotFoundIdSet(rMarked, WORLD, FROZEN_NOW);
  const rRoster = runtime.loadRoster();
  runtime.saveRoster(rRoster);
  const rRosterMap = runtime.buildRosterMap([{ id: '11', name: 'Eleven', url: 'https://x/profile/11' }, { id: '', name: 'x' }]);
  const rDiff = runtime.diffRoster({ 7: { name: 'Seven', url: 'u' } }, { 7: { name: 'Seven', url: 'u' }, 11: { name: 'Eleven', url: 'u' } });
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mNames = players.loadPlayerNames();
  const mBatched = players.addPlayerNamesBatch(mNames, WORLD, [{ id: '8', name: '  Eight  ' }, { id: '', name: 'x' }, null]);
  players.savePlayerNames(mBatched);
  const mIdMap = players.buildIdToName(mBatched, WORLD);
  const mNotFound = players.loadPlayerNamesNotFound();
  const mMarked = players.markPlayerNamesNotFound(mNotFound, WORLD, ['10'], FROZEN_NOW);
  players.savePlayerNamesNotFound(mMarked);
  const mNotFoundSet = players.buildNotFoundIdSet(mMarked, WORLD, FROZEN_NOW);
  const mRoster = players.loadRoster();
  players.saveRoster(mRoster);
  const mRosterMap = players.buildRosterMap([{ id: '11', name: 'Eleven', url: 'https://x/profile/11' }, { id: '', name: 'x' }]);
  const mDiff = players.diffRoster({ 7: { name: 'Seven', url: 'u' } }, { 7: { name: 'Seven', url: 'u' }, 11: { name: 'Eleven', url: 'u' } });
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadPlayerNames', rNames, mNames);
  assertSameBehavior('addPlayerNamesBatch', rBatched, mBatched);
  assertSameBehavior('buildIdToName', rIdMap, mIdMap);
  assertSameBehavior('loadPlayerNamesNotFound', rNotFound, mNotFound);
  assertSameBehavior('markPlayerNamesNotFound', rMarked, mMarked);
  assertSameBehavior('buildNotFoundIdSet', rNotFoundSet, mNotFoundSet);
  assertSameBehavior('loadRoster', rRoster, mRoster);
  assertSameBehavior('buildRosterMap', rRosterMap, mRosterMap);
  assertSameBehavior('diffRoster', rDiff, mDiff);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored name/roster bytes drifted');
});

test('settings roundtrip matches the authority including malformed fallback', () => {
  const seed = { [FROZEN_KEYS.SETTINGS_STORAGE_KEY]: JSON.stringify({ [WORLD.toLowerCase()]: { attackThreshold: 3, raidThreshold: 2, normalMax: 2, highMax: 9 } }) };
  const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
  const envR = installRuntimeGlobals(kvA, new Map());
  const rDefaults = runtime.getDefaultSettings();
  const rValidated = runtime.validateSettings({ attackThreshold: 5000, raidThreshold: 0, normalMax: 9, highMax: 9 });
  const rLoaded = runtime.loadSettings(WORLD);
  runtime.saveSettings({ attackThreshold: 4, raidThreshold: 4, normalMax: 1, highMax: 3 }, WORLD);
  const rReloaded = runtime.loadSettings(WORLD);
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mDefaults = settings.getDefaultSettings();
  const mValidated = settings.validateSettings({ attackThreshold: 5000, raidThreshold: 0, normalMax: 9, highMax: 9 });
  const mLoaded = settings.loadSettings(WORLD);
  settings.saveSettings({ attackThreshold: 4, raidThreshold: 4, normalMax: 1, highMax: 3 }, WORLD);
  const mReloaded = settings.loadSettings(WORLD);
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('getDefaultSettings', rDefaults, mDefaults);
  assertSameBehavior('validateSettings clamp', rValidated, mValidated);
  assertSameBehavior('loadSettings', rLoaded, mLoaded);
  assertSameBehavior('loadSettings after save', rReloaded, mReloaded);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored settings bytes drifted');
  // Malformed payload falls back to defaults on both sides.
  const badA = makeKvMap({ [FROZEN_KEYS.SETTINGS_STORAGE_KEY]: '{broken' });
  const badB = makeKvMap({ [FROZEN_KEYS.SETTINGS_STORAGE_KEY]: '{broken' });
  const envR2 = installRuntimeGlobals(badA, new Map());
  const rBad = runtime.loadSettings(WORLD);
  envR2.restore();
  const envM2 = configureModuleSide(badB, new Map());
  const mBad = settings.loadSettings(WORLD);
  const mLogged = envM2.logged.length;
  envM2.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadSettings malformed', rBad, mBad);
  assert.deepEqual(mBad, mDefaults);
  assert.ok(mLogged > 0 && envR2.logged.length > 0, 'malformed settings must emit diagnostics on both sides');
});

test('history roundtrip matches the authority including the 500-event cap', () => {
  const kvA = makeKvMap({}); const kvB = makeKvMap({});
  const event = { name: 'Hit', url: 'https://ts1.travian.com/profile/42', attackCount: 2, raidCount: 0, addedAttackCount: 2, addedRaidCount: 0, eventType: 'attack', priority: 'high', thresholdPass: true };
  const envR = installRuntimeGlobals(kvA, new Map());
  const rRecord = runtime.buildHistoryRecord(event, WORLD, FROZEN_NOW, {});
  let rHistory = runtime.recordHistory({}, WORLD, rRecord);
  for (let i = 0; i < 505; i += 1) rHistory = runtime.recordHistory(rHistory, WORLD, rRecord);
  runtime.saveHistory(rHistory, WORLD);
  const rLoaded = runtime.loadHistory();
  const rAgg = runtime.aggregateHistory(rLoaded[WORLD.toLowerCase()].events, FROZEN_NOW);
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mRecord = settings.buildHistoryRecord(event, WORLD, FROZEN_NOW, {});
  let mHistory = settings.recordHistory({}, WORLD, mRecord);
  for (let i = 0; i < 505; i += 1) mHistory = settings.recordHistory(mHistory, WORLD, mRecord);
  settings.saveHistory(mHistory, WORLD);
  const mLoaded = settings.loadHistory();
  const mAgg = settings.aggregateHistory(mLoaded[WORLD.toLowerCase()].events, FROZEN_NOW);
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('buildHistoryRecord', rRecord, mRecord);
  assertSameBehavior('recordHistory capped', rHistory, mHistory);
  assert.equal(mHistory[WORLD.toLowerCase()].events.length, 500);
  assertSameBehavior('loadHistory', rLoaded, mLoaded);
  assertSameBehavior('aggregateHistory', rAgg, mAgg);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored history bytes drifted');
});

test('pending queue roundtrip matches the authority including the queue cap', () => {
  const kvA = makeKvMap({}); const kvB = makeKvMap({});
  const mkEvents = (n) => Array.from({ length: n }, (_, i) => ({ name: `E${i}`, url: `https://x/profile/${i}`, eventType: 'attack' }));
  const envR = installRuntimeGlobals(kvA, new Map());
  let rBatch = runtime.enqueueEvents({}, WORLD, mkEvents(55));
  runtime.savePendingBatch(rBatch, WORLD);
  const rLoaded = runtime.loadPendingBatch();
  const rSnap = runtime.snapshotBatch(rLoaded, WORLD);
  const rChunks = runtime.chunkEvents(rSnap.events, 20);
  const rCleared = runtime.clearBatchEvents(rLoaded, WORLD);
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  let mBatch = queue.enqueueEvents({}, WORLD, mkEvents(55));
  queue.savePendingBatch(mBatch, WORLD);
  const mLoaded = queue.loadPendingBatch();
  const mSnap = queue.snapshotBatch(mLoaded, WORLD);
  const mChunks = queue.chunkEvents(mSnap.events, 20);
  const mCleared = queue.clearBatchEvents(mLoaded, WORLD);
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('enqueueEvents capped', rBatch, mBatch);
  assert.equal(mBatch[WORLD.toLowerCase()].events.length, 50);
  assertSameBehavior('loadPendingBatch', rLoaded, mLoaded);
  assertSameBehavior('snapshotBatch', rSnap, mSnap);
  assertSameBehavior('chunkEvents', rChunks, mChunks);
  assertSameBehavior('clearBatchEvents', rCleared, mCleared);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored pending bytes drifted');
});

test('failed queue roundtrip and requeue match the authority', () => {
  const kvA = makeKvMap({}); const kvB = makeKvMap({});
  const events = [{ name: 'F0', url: 'https://x/profile/1', eventType: 'raid' }, { name: 'F1', url: 'https://x/profile/2', eventType: 'attack' }];
  const envR = installRuntimeGlobals(kvA, new Map());
  const rFailed = runtime.enqueueFailedEvents({}, WORLD, events, FROZEN_NOW, 'HTTP 500');
  runtime.saveFailedBatch(rFailed, WORLD);
  const rLoaded = runtime.loadFailedBatch();
  const rGot = runtime.getFailedEvents(rLoaded, WORLD);
  const rCount = runtime.countFailedEvents(rLoaded, WORLD);
  const rRequeued = runtime.requeueFailedEvents(WORLD);
  const rCleared = runtime.clearFailedEvents(runtime.loadFailedBatch(), WORLD);
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mFailed = queue.enqueueFailedEvents({}, WORLD, events, FROZEN_NOW, 'HTTP 500');
  queue.saveFailedBatch(mFailed, WORLD);
  const mLoaded = queue.loadFailedBatch();
  const mGot = queue.getFailedEvents(mLoaded, WORLD);
  const mCount = queue.countFailedEvents(mLoaded, WORLD);
  const mRequeued = queue.requeueFailedEvents(WORLD);
  const mCleared = queue.clearFailedEvents(queue.loadFailedBatch(), WORLD);
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('enqueueFailedEvents', rFailed, mFailed);
  assertSameBehavior('loadFailedBatch', rLoaded, mLoaded);
  assertSameBehavior('getFailedEvents', rGot, mGot);
  assert.equal(mCount, rCount);
  assertSameBehavior('requeueFailedEvents', rRequeued, mRequeued);
  assert.equal(mRequeued.saved, true);
  assertSameBehavior('clearFailedEvents', rCleared, mCleared);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored failed+pending bytes drifted');
});

test('webhook secret opt-in matches the authority with no secret in output', () => {
  const gmA = new Map(); const gmB = new Map();
  const envR = installRuntimeGlobals(new Map(), gmA);
  const rAbsent = runtime.loadWebhookUrl();
  const rSavedBad = runtime.saveWebhookUrl('http://evil.example/hook');
  const rSaved = runtime.saveWebhookUrl(VALID_HOOK);
  const rLoaded = runtime.loadWebhookUrl();
  const rCleared = runtime.clearWebhookUrl();
  const rAfterClear = runtime.loadWebhookUrl();
  envR.restore();
  const envM = configureModuleSide(new Map(), gmB);
  const mAbsent = impl.loadWebhookUrl();
  const mSavedBad = impl.saveWebhookUrl('http://evil.example/hook');
  const mSaved = impl.saveWebhookUrl(VALID_HOOK);
  const mLoaded = impl.loadWebhookUrl();
  const mCleared = impl.clearWebhookUrl();
  const mAfterClear = impl.loadWebhookUrl();
  const mLoggedText = JSON.stringify(envM.logged);
  envM.restore(); Date.now = REAL_NOW;
  assert.equal(mAbsent, rAbsent);
  assert.equal(mSavedBad, rSavedBad);
  assert.equal(mSaved, rSaved);
  assert.equal(mSaved, true);
  assert.equal(mLoaded, rLoaded);
  assert.equal(mLoaded, VALID_HOOK);
  assert.equal(mCleared, rCleared);
  assert.equal(mAfterClear, rAfterClear);
  assert.deepEqual(snapshotMaps(new Map(), gmB), snapshotMaps(new Map(), gmA), 'stored webhook bytes drifted');
  assert.ok(!mLoggedText.includes(VALID_HOOK), 'webhook secret must never reach diagnostic output');
  assert.ok(!JSON.stringify(snapshotMaps(new Map(), gmB)).includes('other'), 'gm snapshot sanity');
  // GM capability absent: both sides refuse without throwing.
  const envR2 = installRuntimeGlobals(new Map(), new Map());
  delete globalThis.GM_getValue; delete globalThis.GM_setValue; delete globalThis.GM_deleteValue;
  const rNoGm = [runtime.loadWebhookUrl(), runtime.saveWebhookUrl(VALID_HOOK), runtime.clearWebhookUrl()];
  envR2.restore();
  impl.resetStorageAdapters();
  impl.configureStorageAdapters({ keyValue: kvFacade(new Map()), gm: null });
  const mNoGm = [impl.loadWebhookUrl(), impl.saveWebhookUrl(VALID_HOOK), impl.clearWebhookUrl()];
  impl.resetStorageAdapters(); Date.now = REAL_NOW;
  assert.deepEqual(mNoGm, rNoGm);
  assert.deepEqual(mNoGm, [null, false, false]);
});

test('malformed payloads fall back without throwing', () => {
  const keys = [
    FROZEN_KEYS.MAPPING_STORAGE_KEY, FROZEN_KEYS.DISCORD_CONFIG_STORAGE_KEY,
    FROZEN_KEYS.MUTED_PLAYERS_STORAGE_KEY, FROZEN_KEYS.PLAYER_NAMES_STORAGE_KEY,
    FROZEN_KEYS.PLAYER_NAMES_NOT_FOUND_KEY, FROZEN_KEYS.ROSTER_STORAGE_KEY,
    FROZEN_KEYS.HISTORY_STORAGE_KEY, FROZEN_KEYS.PENDING_BATCH_STORAGE_KEY,
    FROZEN_KEYS.FAILED_BATCH_STORAGE_KEY, FROZEN_KEYS.DIAGNOSTICS_STORAGE_KEY,
  ];
  const seed = {};
  for (const key of keys) seed[key] = '{broken';
  seed[FROZEN_KEYS.MAPPING_STORAGE_KEY] = '[1,2,3]';
  const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
  const envR = installRuntimeGlobals(kvA, new Map());
  const rResults = [
    runtime.loadMappings(), runtime.loadDiscordConfig(), runtime.loadMutedPlayers(),
    runtime.loadPlayerNames(), runtime.loadPlayerNamesNotFound(), runtime.loadRoster(),
    runtime.loadHistory(), runtime.loadPendingBatch(), runtime.loadFailedBatch(),
    runtime.loadDiagnostics(), runtime.loadDiagnosticsV2(), runtime.loadSettings(WORLD),
  ];
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mResults = [
    mappings.loadMappings(), mappings.loadDiscordConfig(), players.loadMutedPlayers(),
    players.loadPlayerNames(), players.loadPlayerNamesNotFound(), players.loadRoster(),
    settings.loadHistory(), queue.loadPendingBatch(), queue.loadFailedBatch(),
    diagnostics.loadDiagnostics(), diagnostics.loadDiagnosticsV2(), settings.loadSettings(WORLD),
  ];
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('malformed fallbacks', rResults, mResults);
  for (const item of mResults) assert.ok(item && typeof item === 'object', 'fallback must stay shaped');
  assert.deepEqual(mResults[mResults.length - 1], settings.getDefaultSettings());
});

test('write verification pins quota, readback, and malformed-contract behavior', () => {
  const kvA = makeKvMap({}); const kvB = makeKvMap({});
  const envR = installRuntimeGlobals(kvA, new Map());
  const rWritten = runtime.writeVerifiedJson(globalThis.localStorage, 'k', { b: 1, a: 2 });
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const { keyValueStore } = impl;
  const mWritten = impl.writeVerifiedJson(keyValueStore(), 'k', { b: 1, a: 2 });
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('writeVerifiedJson written', rWritten, mWritten);
  assert.equal(mWritten.ok, true);
  // Quota: write throws on both sides.
  const quotaA = makeKvMap({}); const quotaB = makeKvMap({});
  const envR2 = installRuntimeGlobals(quotaA, new Map(), { quota: true });
  const rQuota = runtime.writeVerifiedJson(globalThis.localStorage, 'k', { a: 1 });
  envR2.restore();
  const envM2 = configureModuleSide(quotaB, new Map(), { quota: true });
  const mQuota = impl.writeVerifiedJson(impl.keyValueStore(), 'k', { a: 1 });
  envM2.restore(); Date.now = REAL_NOW;
  assert.equal(mQuota.ok, false);
  assert.equal(mQuota.kind, rQuota.kind);
  // Readback mismatch: a store that silently drops writes.
  const lying = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const mLying = impl.writeVerifiedJson(lying, 'k', { a: 1 });
  assert.deepEqual({ ok: mLying.ok, kind: mLying.kind }, { ok: false, kind: 'readback-mismatch' });
  // Unavailable store: unavailable contract.
  const mMissing = impl.writeVerifiedJson(null, 'k', { a: 1 });
  assert.equal(mMissing.ok, false);
});

test('diagnostics stores roundtrip matches the authority', () => {
  const kvA = makeKvMap({}); const kvB = makeKvMap({});
  const envR = installRuntimeGlobals(kvA, new Map());
  const rEmpty = runtime.loadDiagnostics();
  runtime.saveDiagnostics({ note: 'probe' }, WORLD);
  const rAfter = runtime.loadDiagnostics();
  const rV2Saved = runtime.saveDiagnosticsV2('world-hash', null);
  const rV2 = runtime.loadDiagnosticsV2();
  envR.restore();
  const envM = configureModuleSide(kvB, new Map());
  const mEmpty = diagnostics.loadDiagnostics();
  diagnostics.saveDiagnostics({ note: 'probe' }, WORLD);
  const mAfter = diagnostics.loadDiagnostics();
  const mV2Saved = diagnostics.saveDiagnosticsV2('world-hash', null);
  const mV2 = diagnostics.loadDiagnosticsV2();
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('loadDiagnostics empty', rEmpty, mEmpty);
  assertSameBehavior('loadDiagnostics after save', rAfter, mAfter);
  assert.equal(mV2Saved, rV2Saved);
  assertSameBehavior('loadDiagnosticsV2', rV2, mV2);
  assert.deepEqual(snapshotMaps(kvB, new Map()), snapshotMaps(kvA, new Map()), 'stored diagnostics bytes drifted');
  // Oversized world refuses on both sides.
  const bigWorld = { schemaVersion: 2, sequence: 1, records: [{ stage: 'route', status: 'ok', reason: 'x'.repeat(4000) }], diagnosticIds: [], diagnosticIdOverflow: 0, worldHash: 'h' };
  const envR2 = installRuntimeGlobals(makeKvMap({}), new Map());
  const rBig = runtime.saveDiagnosticsV2('w'.repeat(300000), bigWorld);
  envR2.restore();
  const envM2 = configureModuleSide(makeKvMap({}), new Map());
  const mBig = diagnostics.saveDiagnosticsV2('w'.repeat(300000), bigWorld);
  envM2.restore(); Date.now = REAL_NOW;
  assert.equal(mBig, rBig);
});

test('provenance model matches the authority in every shape', () => {
  const shapes = {
    absent: {},
    malformed: { [FROZEN_KEYS.MAPPING_STORAGE_KEY]: '{broken', [FROZEN_KEYS.DISCORD_CONFIG_STORAGE_KEY]: '[1]' },
    otherHost: { [FROZEN_KEYS.MAPPING_STORAGE_KEY]: JSON.stringify({ [OTHER_WORLD.toLowerCase()]: { 5: ['1'] } }) },
    current: { [FROZEN_KEYS.MAPPING_STORAGE_KEY]: JSON.stringify(seedMappings()), [FROZEN_KEYS.DISCORD_CONFIG_STORAGE_KEY]: JSON.stringify({ roleId: '123456789012345678' }) },
    empty: { [FROZEN_KEYS.MAPPING_STORAGE_KEY]: JSON.stringify({}), [FROZEN_KEYS.DISCORD_CONFIG_STORAGE_KEY]: JSON.stringify({}) },
  };
  for (const [shape, seed] of Object.entries(shapes)) {
    const kvA = makeKvMap(seed); const kvB = makeKvMap(seed);
    const envR = installRuntimeGlobals(kvA, new Map());
    const rModel = runtime.buildStorageProvenanceModel(WORLD);
    const rText = runtime.storageProvenanceText(rModel);
    envR.restore();
    const envM = configureModuleSide(kvB, new Map());
    const mModel = mappings.buildStorageProvenanceModel(WORLD);
    const mText = mappings.storageProvenanceText(mModel);
    envM.restore(); Date.now = REAL_NOW;
    assertSameBehavior(`provenance model ${shape}`, rModel, mModel);
    assertSameBehavior(`provenance text ${shape}`, rText, mText);
  }
});

test('queue contract factory seam delegates and fails closed', () => {
  const event = { name: 'C', url: 'https://x/profile/3', eventType: 'raid' };
  const envR = installRuntimeGlobals(makeKvMap({}), new Map());
  const rContract = runtime.enqueueEvents({}, WORLD, [event], { enforceQueueContract: true });
  envR.restore();
  const envM = configureModuleSide(makeKvMap({}), new Map());
  const mContract = queue.enqueueEvents({}, WORLD, [event], { enforceQueueContract: true });
  envM.restore(); Date.now = REAL_NOW;
  assertSameBehavior('enqueueEvents contract path', rContract, mContract);
  assert.ok(mContract[WORLD.toLowerCase()].events[0].eventId, 'contract path must carry an envelope event id');
  // Missing factory: fail-closed with a clear error.
  impl.resetStorageAdapters();
  impl.configureStorageAdapters({ keyValue: kvFacade(makeKvMap({})), gm: gmFacade(new Map()), queueEventFactory: null });
  Date.now = () => FROZEN_NOW;
  assert.throws(() => queue.enqueueEvents({}, WORLD, [event], { enforceQueueContract: true }), /queue event factory/);
  impl.resetStorageAdapters(); Date.now = REAL_NOW;
});

test('missing adapters mirror the no-host fallback without throwing', () => {
  impl.resetStorageAdapters();
  assert.deepEqual(mappings.loadMappings(), {});
  assert.deepEqual(mappings.loadDiscordConfig(), { roleId: null, leaveRoleId: null });
  assert.deepEqual(players.loadMutedPlayers(), {});
  assert.deepEqual(players.loadPlayerNames(), {});
  assert.deepEqual(settings.loadSettings(WORLD), settings.getDefaultSettings());
  assert.deepEqual(settings.loadHistory(), {});
  assert.deepEqual(queue.loadPendingBatch(), {});
  assert.deepEqual(queue.loadFailedBatch(), {});
  assert.deepEqual(diagnostics.loadDiagnostics(), {});
  assert.deepEqual(diagnostics.loadDiagnosticsV2(), {});
  assert.deepEqual(queue.savePendingBatch({}, WORLD), false);
  assert.deepEqual(queue.saveFailedBatch({}, WORLD), false);
  assert.deepEqual(impl.loadWebhookUrl(), null);
  assert.deepEqual(impl.saveWebhookUrl(VALID_HOOK), false);
  assert.deepEqual(impl.clearWebhookUrl(), false);
  assert.deepEqual(diagnostics.saveDiagnosticsV2('h', null), false);
});
