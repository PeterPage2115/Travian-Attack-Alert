'use strict';

const { select } = require('./legacy-bridge.js');

/** Tooltip and member-row parsing contracts for the authoritative table. */
module.exports = select([
    'isAttackIcon', 'parseAttackCount', 'parseRaidCount', 'classifyEvent',
    'selectMemberTable', 'selectAuthoritativeMemberTable',
    'isAlliancePageReady', 'isReadinessReady', 'checkTooltipSourceAgreement',
    'parseNormalizedMemberIcon', 'parseNormalizedMemberRow',
    'buildStableTableSignature', 'extractMembersFromTable',
    'extractAllianceSnapshotFromRows', 'extractAllianceSnapshotFromDocument',
    'parseMemberSnapshot', 'buildAllianceSnapshot'
]);
