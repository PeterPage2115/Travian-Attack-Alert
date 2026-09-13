'use strict';

const { select } = require('./legacy-bridge.js');

/** Browser-independent acquisition lifecycle seams; boot stays in the legacy entry. */
module.exports = select([
    'getStartupAcquisitionJitterMs', 'createDocumentScanState',
    'shouldAttemptDocumentScan', 'markDocumentScanAttempted',
    'resetDocumentScanState', 'runAttackLifecycleForDocument',
    'monitorStorageAdapter', 'shouldKeepWaitingForDrain'
]);
