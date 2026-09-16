'use strict';

const impl = require('./conservation-impl.js');

const CONTRACT = [
  'sourceEventIdFromTuple', 'sourceEventTuple',
  'createMonitorQueueEvent', 'coalesceMonitorPendingEvents',
  'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
  'resumeTerminalCompactionV1',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
