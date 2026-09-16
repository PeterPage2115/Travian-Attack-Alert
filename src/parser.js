'use strict';

const impl = require('./parser-impl.js');

const CONTRACT = [
  'isAttackIcon', 'parseAttackCount', 'parseRaidCount', 'classifyEvent',
  'selectMemberTable', 'selectAuthoritativeMemberTable',
  'isAlliancePageReady', 'isReadinessReady', 'checkTooltipSourceAgreement',
  'parseNormalizedMemberIcon', 'parseNormalizedMemberRow',
  'buildStableTableSignature', 'extractMembersFromTable',
  'extractAllianceSnapshotFromRows', 'extractAllianceSnapshotFromDocument',
  'parseMemberSnapshot', 'buildAllianceSnapshot',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
