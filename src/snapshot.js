'use strict';

const { select } = require('./legacy-bridge.js');

/** Snapshot, delta, filtering, and priority contracts. */
module.exports = select([
    'getStoredCount', 'getStoredAttackCount', 'getStoredRaidCount',
    'shouldRebaseline', 'diffAttackStates', 'filterMutedEvents',
    'applyEventThresholds', 'classifyPriority', 'resolveEventPriority',
    'highestBatchPriority', 'batchPriorityColor', 'priorityLabel',
    'toPendingEvent', 'diffAllianceSnapshots', 'migrationFriendlyCountRecords'
]);
