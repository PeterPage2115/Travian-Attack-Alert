'use strict';

const { select } = require('./legacy-bridge.js');

/** Pure Discord limits, presentation, partitioning, and mention contracts. */
module.exports = select([
    'filterMutedEvents', 'buildMentionContent', 'buildAllowedMentions',
    'buildCompactDiscordTitle', 'buildCompactDiscordPlayerLine',
    'buildCompactDiscordSummaryFields', 'buildCompactDiscordTiming',
    'buildCompactDiscordPresentation', 'isValidDiscordTime',
    'measureDiscordEmbedText', 'partitionCompactDiscordEntries',
    'selectMentions', 'buildEventDescriptionLine', 'buildDiscordPayloads',
    'buildProfileLink', 'chunkEventsForDiscord'
]);
