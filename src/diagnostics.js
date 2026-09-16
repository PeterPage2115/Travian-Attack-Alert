'use strict';

// Diagnostics facade (plan Todo 14).
//
// Preserves the exact 16-symbol runtime-api.diagnostics contract. The bounded
// schema/ring/serializer/persistence kernel lives in src/diagnostics-impl.js
// behind the Todo 7 adapter seam; the drift/redaction/failure tail stays on
// the frozen runtime authority until Todos 15-17 extract it. Every symbol is
// re-exported by reference, never copied.
const impl = require('./diagnostics-impl.js');
const legacy = require('./runtime-api.js').diagnostics;

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
