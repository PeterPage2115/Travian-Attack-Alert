'use strict';

const impl = require('./migration-impl.js');

const CONTRACT = [
  'LEGACY_CANONICAL_EVENT_FIELDS', 'canonicalLegacyEventFields',
  'canonicalizeLegacyActiveEvent', 'canonicalizeLegacyHistoryRecord',
  'decodeLegacyIdentity', 'planMonitorLegacyMigration',
  'migrateLegacyMonitorStateV1', 'loadOrMigrateMonitorEnvelopeV1',
  'encodeSourceTuple', 'sourceEventIdFromTuple', 'sourceEventTuple',
  'decodeSourceEventId',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
