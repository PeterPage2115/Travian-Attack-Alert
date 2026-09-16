'use strict';

// Storage contract source (plan Todo 8).
//
// Selects the exact runtime-api.storage contract (60 symbols) from the
// extracted adapter-backed siblings instead of re-exporting through
// runtime-api.js. Each symbol must resolve or this module throws at load,
// mirroring the runtime-api.select fail-closed rule. Ownership:
//   kernel   src/storage-impl.js        seam + keys + verified writes + validators
//   identity src/storage-identity.js    player/mapping identity helpers
//   webhook  src/storage-webhook.js     secret persistence behind the host-value seam
//   mappings src/storage-mappings.js    mappings + discord config
//   provenance src/storage-provenance.js inspectors + provenance text
//   mutes    src/storage-mutes.js       mutes + player names
//   roster   src/storage-roster.js      not-found marks + roster
//   settings src/storage-settings.js    settings
//   history  src/storage-history.js     history
//   queue    src/storage-queue.js       pending queue (+ internal queue-event shaping)
//   failed   src/storage-failed.js      failed queue + requeue
//   diagnostics src/storage-diagnostics.js diagnostics stores
// The legacy authority in src/runtime.js is untouched in this task; parity is
// pinned by test/characterization/storage-roundtrip.test.cjs.

const impl = require('./storage-impl.js');
const identity = require('./storage-identity.js');
const webhook = require('./storage-webhook.js');
const mappings = require('./storage-mappings.js');
const provenance = require('./storage-provenance.js');
const mutes = require('./storage-mutes.js');
const roster = require('./storage-roster.js');
const settings = require('./storage-settings.js');
const history = require('./storage-history.js');
const queue = require('./storage-queue.js');
const failed = require('./storage-failed.js');
const diagnostics = require('./storage-diagnostics.js');

const SOURCES = { impl, identity, webhook, mappings, provenance, mutes, roster, settings, history, queue, failed, diagnostics };

const CONTRACT = [
  ['impl', 'writeVerifiedJson'],
  ['identity', 'buildMappingKey'],
  ['mappings', 'loadMappings'], ['mappings', 'saveMappings'],
  ['mappings', 'addMapping'], ['mappings', 'removeMapping'], ['mappings', 'listMappings'],
  ['mappings', 'loadDiscordConfig'], ['mappings', 'saveDiscordConfig'],
  ['mappings', 'setAlertRoleId'], ['mappings', 'clearAlertRoleId'],
  ['mappings', 'setLeaveRoleId'], ['mappings', 'clearLeaveRoleId'],
  ['mutes', 'loadMutedPlayers'], ['mutes', 'saveMutedPlayers'],
  ['mutes', 'addMutedPlayer'], ['mutes', 'removeMutedPlayer'],
  ['mutes', 'isPlayerMuted'], ['mutes', 'listMutedPlayers'],
  ['mutes', 'loadPlayerNames'], ['mutes', 'savePlayerNames'],
  ['mutes', 'addPlayerNamesBatch'], ['mutes', 'buildIdToName'],
  ['roster', 'loadPlayerNamesNotFound'], ['roster', 'savePlayerNamesNotFound'],
  ['roster', 'markPlayerNamesNotFound'], ['roster', 'buildNotFoundIdSet'],
  ['roster', 'loadRoster'], ['roster', 'saveRoster'],
  ['roster', 'buildRosterMap'], ['roster', 'diffRoster'],
  ['history', 'buildHistoryRecord'], ['history', 'recordHistory'],
  ['history', 'loadHistory'], ['history', 'saveHistory'], ['history', 'aggregateHistory'],
  ['settings', 'getDefaultSettings'], ['settings', 'validateSettings'],
  ['settings', 'loadSettings'], ['settings', 'saveSettings'],
  ['queue', 'loadPendingBatch'], ['queue', 'savePendingBatch'],
  ['queue', 'enqueueEvents'], ['queue', 'snapshotBatch'], ['queue', 'chunkEvents'],
  ['queue', 'clearBatchEvents'],
  ['failed', 'loadFailedBatch'], ['failed', 'saveFailedBatch'],
  ['failed', 'enqueueFailedEvents'], ['failed', 'getFailedEvents'],
  ['failed', 'countFailedEvents'], ['failed', 'clearFailedEvents'],
  ['failed', 'requeueFailedEvents'],
  ['webhook', 'loadWebhookUrl'], ['webhook', 'saveWebhookUrl'], ['webhook', 'clearWebhookUrl'],
  ['diagnostics', 'loadDiagnostics'], ['diagnostics', 'saveDiagnostics'],
  ['diagnostics', 'loadDiagnosticsV2'], ['diagnostics', 'saveDiagnosticsV2'],
];

function select(sourceName, symbol) {
  const source = SOURCES[sourceName];
  if (!source || typeof source[symbol] !== 'function') {
    throw new Error(`Storage contract violation: ${sourceName}.${symbol} is missing from the extracted storage modules`);
  }
  return source[symbol];
}

module.exports = Object.fromEntries(
  CONTRACT.map(([sourceName, symbol]) => [symbol, select(sourceName, symbol)]),
);
