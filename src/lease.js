'use strict';

const impl = require('./lease-impl.js');

const CONTRACT = [
  'parseLease', 'classifyLease', 'isLeaseActive', 'createTabOwnerId',
  'getOrCreateTabOwnerId', 'createLeaseToken', 'loadLease',
  'loadLeaseRecord', 'saveLease', 'acquireLease', 'renewLease',
  'releaseLease', 'isLeaseFenceValid', 'checkLifecycleFence',
  'isLifecycleFenceValid', 'lockNameForHostname', 'hasExclusiveWebLocks',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
