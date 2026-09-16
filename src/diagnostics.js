'use strict';

const impl = require('./diagnostics-impl.js');
const legacy = require('./runtime.js');

const IMPL_CONTRACT = [
    'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
    'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
    'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
    'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
    'serializeDiagnosticExportV2',
];

const CONTRACT = [
    'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
    'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
    'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
    'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
    'serializeDiagnosticExportV2', 'boundedDiagnosticRecords',
    'monotonicDurationMs', 'recordDuration', 'createVisibilityDriftTracker',
    'updateVisibilityDriftTracker', 'buildScanSummaryLog', 'recordFailure',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [
    name,
    IMPL_CONTRACT.includes(name) ? impl[name] : legacy[name],
]));
