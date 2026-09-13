'use strict';

const { select } = require('./legacy-bridge.js');

/** Lease parsing, fencing, and owner-token contracts. */
module.exports = select([
    'parseLease', 'classifyLease', 'isLeaseActive', 'createTabOwnerId',
    'getOrCreateTabOwnerId', 'createLeaseToken', 'loadLease',
    'loadLeaseRecord', 'saveLease', 'acquireLease', 'renewLease',
    'releaseLease', 'isLeaseFenceValid', 'checkLifecycleFence',
    'isLifecycleFenceValid', 'lockNameForHostname', 'hasExclusiveWebLocks'
]);
