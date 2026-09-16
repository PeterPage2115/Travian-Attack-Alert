'use strict';

const impl = require('./acquisition-impl.js');

const CONTRACT = [
  'getStartupAcquisitionJitterMs', 'createDocumentScanState',
  'shouldAttemptDocumentScan', 'markDocumentScanAttempted',
  'resetDocumentScanState', 'runAttackLifecycleForDocument',
  'monitorStorageAdapter', 'shouldKeepWaitingForDrain',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
