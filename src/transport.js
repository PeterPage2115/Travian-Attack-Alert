'use strict';

/**
 * Discord transport boundary. Classification and retry policy are pure; the
 * request operation is kept here so GM access cannot leak into other domains.
 */
module.exports = require('./runtime-api.js').transport;
