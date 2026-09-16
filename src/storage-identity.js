'use strict';

// Extracted storage domain: identity helpers shared by sibling domains (Todo 8).
const kernel = require('./storage-impl.js');
const normalizeHostname = kernel.normalizeHostname;
  function extractPlayerId(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }
    if (url.includes("/alliance/")) {
      return null;
    }
    const patterns = [
      /\/profile\/(\d+)/i,
      /\/player\/(\d+)/i,
      /spieler\.php\?[^#]*uid=(\d+)/i,
      /uid=(\d+)/i
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  }
  function buildMappingKey(hostname, playerId) {
    if (typeof playerId !== "string" || playerId.length === 0) {
      return "";
    }
    return `${String(hostname).toLowerCase()}:${String(playerId)}`;
  }
module.exports = { extractPlayerId, buildMappingKey };
