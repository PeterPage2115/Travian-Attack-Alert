'use strict';

const { select } = require('./legacy-bridge.js');

/** Storage adapter/config/history contracts; persistence remains injected by legacy seams. */
module.exports = select([
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
    'loadDiagnosticsV2', 'saveDiagnosticsV2'
]);
