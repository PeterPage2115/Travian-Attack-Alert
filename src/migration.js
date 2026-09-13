'use strict';

const { select } = require('./legacy-bridge.js');

/** Legacy identity and backward-compatible monitor migration contracts. */
module.exports = select([
    'LEGACY_CANONICAL_EVENT_FIELDS', 'canonicalLegacyEventFields',
    'canonicalizeLegacyActiveEvent', 'canonicalizeLegacyHistoryRecord',
    'decodeLegacyIdentity', 'planMonitorLegacyMigration',
    'migrateLegacyMonitorStateV1', 'loadOrMigrateMonitorEnvelopeV1',
    'encodeSourceTuple', 'sourceEventIdFromTuple', 'sourceEventTuple',
    'decodeSourceEventId'
]);
