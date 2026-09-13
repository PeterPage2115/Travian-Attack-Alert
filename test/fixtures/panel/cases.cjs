'use strict';

// Canonical programmatic storage seeds for the todo-6 panel journey.
// Surrogate IDs only: Travian player IDs 900001+, Discord snowflakes in the
// 100000000000000001/20000000000000000N documentation ranges. Never real
// `.dane` content. Hostname bucket is the loopback host used by the fixture
// server (127.0.0.1); storage keys are global JSON maps keyed by hostname.

const HOST = '127.0.0.1';
const MAPPING_KEY = 'travianAlliancePlayerMappings_v1';
const DISCORD_CONFIG_KEY = 'travianAllianceDiscordConfig_v1';
const ROSTER_KEY = 'travianAllianceRoster_v1';
const NAMES_KEY = 'travianAlliancePlayerNames_v1';

const SURROGATE_DISCORD_ID = '100000000000000001';
const SURROGATE_ROLE_ID = '200000000000000001';
const SURROGATE_LEAVE_ROLE_ID = '200000000000000002';

function cachedRosterMap(entries) {
  const world = {};
  for (const [id, name] of entries) {
    world[String(id)] = { name: String(name), url: `/profile/${id}` };
  }
  return { [HOST]: world };
}

function namesMap(entries) {
  const world = {};
  for (const [id, name] of entries) world[String(id)] = String(name);
  return { [HOST]: world };
}

const SEEDS = {
  liveValid: {
    [MAPPING_KEY]: JSON.stringify({ [HOST]: { 900001: [SURROGATE_DISCORD_ID] } }),
    [DISCORD_CONFIG_KEY]: JSON.stringify({ roleId: SURROGATE_ROLE_ID, leaveRoleId: SURROGATE_LEAVE_ROLE_ID }),
    [ROSTER_KEY]: JSON.stringify(cachedRosterMap([[900101, 'Cached Player A'], [900102, 'Cached Player B']])),
    // Known names suppress the panel's loopback /profile/<id> name backfill,
    // keeping the journey free of fetches and console errors.
    [NAMES_KEY]: JSON.stringify(namesMap([
      [900001, 'Fixture Player 001'],
      [900002, 'Fixture Player 002'],
      [900003, 'Fixture Player 003'],
      [900101, 'Cached Player A'],
      [900102, 'Cached Player B'],
    ])),
  },
  cachedAbsent: {
    [ROSTER_KEY]: JSON.stringify(cachedRosterMap([[900001, 'Cached Alpha'], [900002, 'Cached Beta']])),
    [NAMES_KEY]: JSON.stringify(namesMap([[900001, 'Cached Alpha'], [900002, 'Cached Beta']])),
  },
  otherHost: {
    [MAPPING_KEY]: JSON.stringify({ 'other.world.example': { 900001: [SURROGATE_DISCORD_ID] } }),
    [DISCORD_CONFIG_KEY]: JSON.stringify({}),
  },
  malformed: {
    [MAPPING_KEY]: '{broken',
    [DISCORD_CONFIG_KEY]: '{broken',
    [ROSTER_KEY]: JSON.stringify(cachedRosterMap([[900001, 'Cached Alpha'], [900002, 'Cached Beta']])),
    [NAMES_KEY]: JSON.stringify(namesMap([[900001, 'Cached Alpha'], [900002, 'Cached Beta']])),
  },
};

function seedScriptFor(seed) {
  const entries = Object.entries(seed || {});
  const lines = ['try { localStorage.clear(); } catch {}'];
  for (const [key, value] of entries) {
    lines.push(`try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); } catch {}`);
  }
  return lines.join('\n');
}

module.exports = {
  HOST,
  MAPPING_KEY,
  DISCORD_CONFIG_KEY,
  ROSTER_KEY,
  NAMES_KEY,
  SURROGATE_DISCORD_ID,
  SURROGATE_ROLE_ID,
  SURROGATE_LEAVE_ROLE_ID,
  SEEDS,
  seedScriptFor,
  cachedRosterMap,
  namesMap,
};
