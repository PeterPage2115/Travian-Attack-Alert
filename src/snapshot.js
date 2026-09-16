'use strict';

const impl = require('./snapshot-impl.js');

const CONTRACT = [
  'getStoredCount', 'getStoredAttackCount', 'getStoredRaidCount',
  'shouldRebaseline', 'diffAttackStates', 'filterMutedEvents',
  'applyEventThresholds', 'classifyPriority', 'resolveEventPriority',
  'highestBatchPriority', 'batchPriorityColor', 'priorityLabel',
  'toPendingEvent', 'diffAllianceSnapshots', 'migrationFriendlyCountRecords',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
