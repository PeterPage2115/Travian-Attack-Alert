'use strict';

const { select } = require('./legacy-bridge.js');

/** Count and lineage projections used to audit delivery conservation. */
module.exports = select([
    'sourceEventIdFromTuple', 'sourceEventTuple',
    'createMonitorQueueEvent', 'coalesceMonitorPendingEvents',
    'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
    'resumeTerminalCompactionV1'
]);
