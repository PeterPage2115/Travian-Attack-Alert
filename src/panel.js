'use strict';

// Panel facade (plan Todo 15).
//
// Preserves the exact 22-symbol runtime-api.panel contract. The session-draft
// kernel lives in src/panel-impl.js behind the Todo 7 adapter seam; the
// model-builder tail stays on the frozen runtime authority until Todos 16-17
// (the full domain exceeds the frozen 250-line new-module gate). Every symbol
// is re-exported by reference, never copied.
const impl = require('./panel-impl.js');
const legacy = require('./runtime-api.js').panel;

const IMPL_CONTRACT = [
  'createAdminDraftState', 'isAdminDraftEmpty',
  'supportsInputSelection', 'readSessionStorageSafely', 'persistAdminDraft',
  'restoreAdminDraft', 'gateAdminDraftReload', 'resolvePanelExit',
  'createNameBackfillPlan', 'isPanelAsyncResultCurrent',
  'patchPlayerNameNodes', 'applyPanelLeaseState',
];

const CONTRACT = [
  'computeUnmappedPlayers', 'buildPlayerWorkspaceModel',
  'paginatePlayerWorkspaceRows', 'collectUnknownIds', 'buildHistoryPanelRows',
  'buildStatsPanelModel', 'buildDiagnosticsPanelModel',
  'buildStatusPanelModel', 'createAdminDraftState', 'isAdminDraftEmpty',
  'supportsInputSelection', 'readSessionStorageSafely', 'persistAdminDraft',
  'restoreAdminDraft', 'gateAdminDraftReload', 'resolvePanelExit',
  'createNameBackfillPlan', 'isPanelAsyncResultCurrent',
  'patchPlayerNameNodes', 'applyPanelLeaseState',
  'buildCountReconciliationPanelModel', 'buildIncidentBundle',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [
  name,
  IMPL_CONTRACT.includes(name) ? impl[name] : legacy[name],
]));
