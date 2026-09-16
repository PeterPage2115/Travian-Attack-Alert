'use strict';

const impl = require('./discord-impl.js');

const CONTRACT = [
  'filterMutedEvents', 'buildMentionContent', 'buildAllowedMentions',
  'buildCompactDiscordTitle', 'buildCompactDiscordPlayerLine',
  'buildCompactDiscordSummaryFields', 'buildCompactDiscordTiming',
  'buildCompactDiscordPresentation', 'isValidDiscordTime',
  'measureDiscordEmbedText', 'partitionCompactDiscordEntries',
  'selectMentions', 'buildEventDescriptionLine', 'buildDiscordPayloads',
  'buildProfileLink', 'chunkEventsForDiscord',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
