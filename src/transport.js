'use strict';

const impl = require('./transport-impl.js');

const CONTRACT = [
  'isRetryableOutcome', 'parseRetryAfterMs', 'sanitizeRetryDelay',
  'buildDiscordRequestUrl', 'classifyDiscordResponse',
  'sendDiscordPayload', 'sendDiscordPayloadWithRetry',
];

module.exports = Object.fromEntries(CONTRACT.map((name) => [name, impl[name]]));
