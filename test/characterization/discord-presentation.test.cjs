'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const constants = require(path.join(ROOT, 'src', 'constants.js'));
const discord = require(path.join(ROOT, 'src', 'discord.js'));
const runtime = require(path.join(ROOT, 'src', 'runtime.js'));
const canonical = require(path.join(ROOT, 'test', 'fixtures', 'discord', 'canonical.cjs'));

const CONTRACT = [
  'filterMutedEvents', 'buildMentionContent', 'buildAllowedMentions',
  'buildCompactDiscordTitle', 'buildCompactDiscordPlayerLine',
  'buildCompactDiscordSummaryFields', 'buildCompactDiscordTiming',
  'buildCompactDiscordPresentation', 'isValidDiscordTime',
  'measureDiscordEmbedText', 'partitionCompactDiscordEntries',
  'selectMentions', 'buildEventDescriptionLine', 'buildDiscordPayloads',
  'buildProfileLink', 'chunkEventsForDiscord',
];
const SETTINGS = { attackThreshold: 1, raidThreshold: 1, normalMax: 2, highMax: 5 };
const CONTEXT = { origin: 'https://s1.example.test', fallbackHref: 'https://s1.example.test/alliance/profile/members' };
const EVENTS = [
  { id: '1', name: 'Alpha 😀', url: '/profile/1', eventType: 'attack', attackCount: 4, raidCount: 1, addedAttackCount: 3, addedRaidCount: 0 },
  { id: '2', name: 'Beta', url: '/profile/2', eventType: 'raid', attackCount: 0, raidCount: 2, addedAttackCount: 0, addedRaidCount: 2 },
];

test('discord exposes the frozen 16-symbol contract and dispatch states stay frozen', () => {
  assert.deepEqual(Object.keys(discord).sort(), [...CONTRACT].sort());
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'discord.js'), 'utf8'), /runtime-api/u);
  assert.deepEqual(Array.from(constants.DISPATCH_CHUNK_STATES), ['prepared', 'sending', 'acknowledged', 'retryable', 'failed', 'uncertain']);
  assert.equal(Object.isFrozen(constants.DISPATCH_CHUNK_STATES), true);
});

test('all canonical Discord presentations preserve byte-for-byte runtime payloads', () => {
  for (const name of canonical.previewCaseNames) {
    const fixture = canonical.previewCases[name]();
    assert.deepEqual(discord.buildDiscordPayloads(fixture.events, fixture.options), runtime.buildDiscordPayloads(fixture.events, fixture.options), name);
  }
});

test('mention selection preserves validation, deduplication, and allowed mention shape', () => {
  const roles = ['123456789012345678', '123456789012345678', 'bad'];
  const users = ['223456789012345678', '223456789012345678', 'bad'];
  assert.deepEqual(discord.selectMentions(roles, users), { roleIds: ['123456789012345678'], userIds: ['223456789012345678'] });
  assert.equal(discord.buildMentionContent(roles, users), '<@&123456789012345678> <@223456789012345678>');
  assert.deepEqual(discord.buildAllowedMentions(roles, users), { roles: ['123456789012345678'], users: ['223456789012345678'] });
});

test('compact presentation preserves title, lines, summary, timing, partition, and text measurement', () => {
  const title = discord.buildCompactDiscordTitle(EVENTS, SETTINGS);
  assert.deepEqual(title, { text: '🚨 Alliance attack · 2 players', eventClass: 'attack', playerCount: 2, color: 15844367 });
  assert.match(discord.buildCompactDiscordPlayerLine(EVENTS[0], CONTEXT, SETTINGS), /^\[Alpha 😀\]\(https:\/\/s1\.example\.test\/profile\/1\)/u);
  assert.deepEqual(discord.buildCompactDiscordSummaryFields(EVENTS, SETTINGS), [
    { name: 'New', value: '**+3 attacks** · **+2 raids**', inline: true },
    { name: 'Active now', value: '4 attacks / 3 raids', inline: true },
    { name: 'Priority', value: 'High', inline: true },
  ]);
  assert.deepEqual(discord.buildCompactDiscordTiming(1700000000000, 1700000002500), { footer: { text: 'Observed 2s before dispatch' }, timestamp: '2023-11-14T22:13:22.500Z' });
  const presentation = discord.buildCompactDiscordPresentation(EVENTS, {
    allianceUrl: '/alliance/profile/members', context: CONTEXT, worldHostname: 'S1.Example.Test',
    settings: SETTINGS, observedAtMs: 1700000000000, dispatchedAtMs: 1700000002500,
  });
  assert.equal(presentation.footer.text, 's1.example.test · Observed 2s before dispatch');
  const plans = discord.partitionCompactDiscordEntries(presentation);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].embedPlans[0].lineEntries.length, 2);
  assert.ok(discord.measureDiscordEmbedText([plans[0].embedPlans[0].embed]) > 0);
});

test('payload building preserves deterministic sorting, mention placement, links, and limits', () => {
  const payloads = discord.buildDiscordPayloads(EVENTS, {
    allianceUrl: '/alliance/profile/members', context: CONTEXT, worldHostname: 's1.example.test',
    settings: SETTINGS, observedAtMs: 1700000000000, dispatchedAtMs: 1700000002500,
    roleId: '123456789012345678', userIds: ['223456789012345678'],
  });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].content, '<@&123456789012345678> <@223456789012345678>');
  assert.deepEqual(payloads[0].allowed_mentions, { roles: ['123456789012345678'], users: ['223456789012345678'] });
  assert.equal(discord.buildProfileLink(EVENTS[0], CONTEXT), '[Alpha 😀](https://s1.example.test/profile/1)');
  assert.equal(discord.buildEventDescriptionLine(EVENTS[0]), 'Alpha 😀 — +3 attacks · +0 raids (4 attacks / 1 raid active)');
});

test('chunking and mute filtering preserve order and roster events', () => {
  assert.deepEqual(discord.chunkEventsForDiscord(EVENTS, 1), [[EVENTS[0]], [EVENTS[1]]]);
  const join = { eventType: 'join', url: '/profile/1' };
  assert.deepEqual(discord.filterMutedEvents(EVENTS.concat(join), 's1.example.test', { 's1.example.test': { 1: true } }), [EVENTS[1], join]);
  assert.equal(discord.isValidDiscordTime(1700000000000), true);
  assert.equal(discord.isValidDiscordTime(Infinity), false);
});
