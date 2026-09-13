'use strict';

const { select } = require('./legacy-bridge.js');

/** Bounded diagnostic schema, ring, serializer, and export contracts. */
module.exports = select([
    'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
    'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
    'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
    'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
    'serializeDiagnosticExportV2', 'boundedDiagnosticRecords',
    'monotonicDurationMs', 'recordDuration', 'createVisibilityDriftTracker',
    'updateVisibilityDriftTracker', 'buildScanSummaryLog', 'recordFailure'
]);
