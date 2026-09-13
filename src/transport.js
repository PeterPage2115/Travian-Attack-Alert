'use strict';

const { select } = require('./legacy-bridge.js');

/**
 * Discord transport boundary. Classification and retry policy are pure; the
 * request operation is kept here so GM access cannot leak into other domains.
 */
module.exports = select([
    'isRetryableOutcome', 'parseRetryAfterMs', 'sanitizeRetryDelay',
    'buildDiscordRequestUrl', 'classifyDiscordResponse',
    'sendDiscordPayload', 'sendDiscordPayloadWithRetry'
]);
