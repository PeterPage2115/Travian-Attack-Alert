'use strict';

const impl = require('./dispatch-impl.js');

const CONTRACT = [
  'buildDispatchPlanV1', 'buildDispatchRequestV1',
  'ackHashForDiscordMessageId', 'applyDispatchPlanTransitionV1',
  'createDispatchPlanInAccountingV1', 'commitDispatchPlanTransitionV1',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
