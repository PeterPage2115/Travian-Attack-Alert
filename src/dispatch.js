'use strict';

const { select } = require('./legacy-bridge.js');

/** Durable dispatch-plan construction, chunk settlement, and acknowledgement. */
module.exports = select([
    'buildDispatchPlanV1', 'buildDispatchRequestV1',
    'ackHashForDiscordMessageId', 'applyDispatchPlanTransitionV1',
    'createDispatchPlanInAccountingV1', 'commitDispatchPlanTransitionV1'
]);
