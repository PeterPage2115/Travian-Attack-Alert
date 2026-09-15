'use strict';

const runtime = require('./runtime.js');

const contracts = {
    storage: [
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
    ],
    lease: [
        'parseLease', 'classifyLease', 'isLeaseActive', 'createTabOwnerId',
        'getOrCreateTabOwnerId', 'createLeaseToken', 'loadLease',
        'loadLeaseRecord', 'saveLease', 'acquireLease', 'renewLease',
        'releaseLease', 'isLeaseFenceValid', 'checkLifecycleFence',
        'isLifecycleFenceValid', 'lockNameForHostname', 'hasExclusiveWebLocks'
    ],
    parser: [
        'isAttackIcon', 'parseAttackCount', 'parseRaidCount', 'classifyEvent',
        'selectMemberTable', 'selectAuthoritativeMemberTable',
        'isAlliancePageReady', 'isReadinessReady', 'checkTooltipSourceAgreement',
        'parseNormalizedMemberIcon', 'parseNormalizedMemberRow',
        'buildStableTableSignature', 'extractMembersFromTable',
        'extractAllianceSnapshotFromRows', 'extractAllianceSnapshotFromDocument',
        'parseMemberSnapshot', 'buildAllianceSnapshot'
    ],
    snapshot: [
        'getStoredCount', 'getStoredAttackCount', 'getStoredRaidCount',
        'shouldRebaseline', 'diffAttackStates', 'filterMutedEvents',
        'applyEventThresholds', 'classifyPriority', 'resolveEventPriority',
        'highestBatchPriority', 'batchPriorityColor', 'priorityLabel',
        'toPendingEvent', 'diffAllianceSnapshots', 'migrationFriendlyCountRecords'
    ],
    envelope: [
        'canonicalSerializeMonitorValue', 'checksumMonitorCanonicalValue',
        'createMonitorEnvelopeV1', 'serializeMonitorEnvelopeV1',
        'parseMonitorEnvelopeV1', 'compareMonitorGenerations',
        'isMonitorGenerationFenced', 'monitorActiveStorageKey',
        'monitorBackupStorageKey', 'monitorQuarantineStorageKey',
        'quarantineMonitorRawV1', 'loadMonitorEnvelopeV1',
        'coalesceMonitorPendingEvents', 'planAcceptedScanTransition',
        'commitMonitorEnvelope', 'commitMonitorEnvelopeV1',
        'applyMonitorQueueTransitionV1', 'commitMonitorQueueTransitionV1',
        'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
        'resumeTerminalCompactionV1', 'createMonitorQueueEvent',
        'computeQueueAge', 'addInFlightChunk', 'getInFlightChunks',
        'dropInFlightHead', 'replaceInFlightHeadAttempt'
    ],
    migration: [
        'LEGACY_CANONICAL_EVENT_FIELDS', 'canonicalLegacyEventFields',
        'canonicalizeLegacyActiveEvent', 'canonicalizeLegacyHistoryRecord',
        'decodeLegacyIdentity', 'planMonitorLegacyMigration',
        'migrateLegacyMonitorStateV1', 'loadOrMigrateMonitorEnvelopeV1',
        'encodeSourceTuple', 'sourceEventIdFromTuple', 'sourceEventTuple',
        'decodeSourceEventId'
    ],
    discord: [
        'filterMutedEvents', 'buildMentionContent', 'buildAllowedMentions',
        'buildCompactDiscordTitle', 'buildCompactDiscordPlayerLine',
        'buildCompactDiscordSummaryFields', 'buildCompactDiscordTiming',
        'buildCompactDiscordPresentation', 'isValidDiscordTime',
        'measureDiscordEmbedText', 'partitionCompactDiscordEntries',
        'selectMentions', 'buildEventDescriptionLine', 'buildDiscordPayloads',
        'buildProfileLink', 'chunkEventsForDiscord'
    ],
    transport: [
        'isRetryableOutcome', 'parseRetryAfterMs', 'sanitizeRetryDelay',
        'buildDiscordRequestUrl', 'classifyDiscordResponse',
        'sendDiscordPayload', 'sendDiscordPayloadWithRetry'
    ],
    dispatch: [
        'buildDispatchPlanV1', 'buildDispatchRequestV1',
        'ackHashForDiscordMessageId', 'applyDispatchPlanTransitionV1',
        'createDispatchPlanInAccountingV1', 'commitDispatchPlanTransitionV1'
    ],
    conservation: [
        'sourceEventIdFromTuple', 'sourceEventTuple',
        'createMonitorQueueEvent', 'coalesceMonitorPendingEvents',
        'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
        'resumeTerminalCompactionV1'
    ],
    diagnostics: [
        'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
        'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
        'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
        'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
        'serializeDiagnosticExportV2', 'boundedDiagnosticRecords',
        'monotonicDurationMs', 'recordDuration', 'createVisibilityDriftTracker',
        'updateVisibilityDriftTracker', 'buildScanSummaryLog', 'recordFailure'
    ],
    panel: [
        'computeUnmappedPlayers', 'buildPlayerWorkspaceModel',
        'paginatePlayerWorkspaceRows', 'collectUnknownIds', 'buildHistoryPanelRows',
        'buildStatsPanelModel', 'buildDiagnosticsPanelModel',
        'buildStatusPanelModel', 'createAdminDraftState', 'isAdminDraftEmpty',
        'supportsInputSelection', 'readSessionStorageSafely', 'persistAdminDraft',
        'restoreAdminDraft', 'gateAdminDraftReload', 'resolvePanelExit',
        'createNameBackfillPlan', 'isPanelAsyncResultCurrent',
        'patchPlayerNameNodes', 'applyPanelLeaseState',
        'buildCountReconciliationPanelModel', 'buildIncidentBundle'
    ],
    acquisition: [
        'getStartupAcquisitionJitterMs', 'createDocumentScanState',
        'shouldAttemptDocumentScan', 'markDocumentScanAttempted',
        'resetDocumentScanState', 'runAttackLifecycleForDocument',
        'monitorStorageAdapter', 'shouldKeepWaitingForDrain'
    ]
};

function select(moduleName, names) {
    return Object.fromEntries(names.map(symbol => {
        if (!Object.prototype.hasOwnProperty.call(runtime, symbol)) {
            throw new Error(`Runtime contract violation: ${moduleName}.${symbol} is missing from src/runtime.js`);
        }
        return [symbol, runtime[symbol]];
    }));
}

module.exports = Object.fromEntries(
    Object.entries(contracts).map(([moduleName, names]) => [moduleName, select(moduleName, names)])
);
module.exports.select = select;
