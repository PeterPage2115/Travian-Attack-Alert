'use strict';

const impl = require('./envelope-impl.js');

const CONTRACT = [
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
  'dropInFlightHead', 'replaceInFlightHeadAttempt',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
