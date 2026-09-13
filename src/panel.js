'use strict';

const { select } = require('./legacy-bridge.js');

module.exports = select([
    'computeUnmappedPlayers', 'buildPlayerWorkspaceModel',
    'paginatePlayerWorkspaceRows', 'collectUnknownIds', 'buildHistoryPanelRows',
    'buildStatsPanelModel', 'buildDiagnosticsPanelModel',
    'buildStatusPanelModel', 'createAdminDraftState', 'isAdminDraftEmpty',
    'supportsInputSelection', 'readSessionStorageSafely', 'persistAdminDraft',
    'restoreAdminDraft', 'gateAdminDraftReload', 'resolvePanelExit',
    'createNameBackfillPlan', 'isPanelAsyncResultCurrent',
    'patchPlayerNameNodes', 'applyPanelLeaseState',
    'buildCountReconciliationPanelModel', 'buildIncidentBundle'
]);
