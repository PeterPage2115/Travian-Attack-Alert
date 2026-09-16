'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const snapshot = require(path.join(ROOT, 'src', 'snapshot.js'));
const runtime = require(path.join(ROOT, 'src', 'runtime.js'));

const SETTINGS = { attackThreshold: 2, raidThreshold: 3, normalMax: 4, highMax: 8 };
const CONTRACT = [
  'getStoredCount', 'getStoredAttackCount', 'getStoredRaidCount',
  'shouldRebaseline', 'diffAttackStates', 'filterMutedEvents',
  'applyEventThresholds', 'classifyPriority', 'resolveEventPriority',
  'highestBatchPriority', 'batchPriorityColor', 'priorityLabel',
  'toPendingEvent', 'diffAllianceSnapshots', 'migrationFriendlyCountRecords',
];

test('snapshot exposes the frozen 15-symbol contract', () => {
  assert.deepEqual(Object.keys(snapshot).sort(), [...CONTRACT].sort());
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'snapshot.js'), 'utf8'), /runtime-api/u);
});

test('snapshot adapter preserves runtime outputs for the characterized contract', () => {
  for (const [name, args] of [
    ['getStoredCount', [{ alpha: { count: 3 } }, 'alpha']],
    ['getStoredAttackCount', [{ alpha: { attackCount: 4 } }, 'alpha']],
    ['getStoredRaidCount', [{ alpha: { raidCount: 2 } }, 'alpha']],
    ['shouldRebaseline', [{ filterVersion: 3, alpha: {} }]],
    ['classifyPriority', [{ addedAttackCount: 6 }, SETTINGS]],
    ['resolveEventPriority', [{ priority: 'high' }, SETTINGS]],
    ['highestBatchPriority', [[{ addedAttackCount: 1 }, { addedRaidCount: 9 }], SETTINGS]],
    ['batchPriorityColor', [[{ addedAttackCount: 5 }], SETTINGS]],
    ['priorityLabel', ['high']],
  ]) assert.deepEqual(snapshot[name](...args), runtime[name](...args), name);
});

test('legacy count differencing preserves mixed shapes, filter metadata, and rebaseline rules', () => {
  const previous = {
    filterVersion: 4,
    alpha: { count: 2, raidCount: 1 },
    beta: 3,
  };
  const current = {
    filterVersion: 4,
    alpha: { name: 'Alpha', url: '/profile/1', attackCount: 5, raidCount: 1 },
    beta: { name: 'Beta', url: '/profile/2', count: 3, raidCount: 4 },
  };
  assert.equal(snapshot.getStoredCount(previous, 'alpha'), 2);
  assert.equal(snapshot.getStoredAttackCount(previous, 'beta'), 3);
  assert.equal(snapshot.getStoredRaidCount(previous, 'filterVersion'), 0);
  assert.deepEqual(snapshot.diffAttackStates(previous, current), {
    newEvents: [
      { name: 'Alpha', url: '/profile/1', attackCount: 5, raidCount: 1, oldAttackCount: 2, oldRaidCount: 1, addedAttackCount: 3, addedRaidCount: 0, eventType: 'attack' },
      { name: 'Beta', url: '/profile/2', attackCount: 3, raidCount: 4, oldAttackCount: 3, oldRaidCount: 0, addedAttackCount: 0, addedRaidCount: 4, eventType: 'raid' },
    ],
    shouldSave: true,
  });
  assert.equal(snapshot.shouldRebaseline(previous), false);
  assert.equal(snapshot.shouldRebaseline({ alpha: previous.alpha }), true);
});

test('authoritative snapshot differencing preserves commit gates and migration order', () => {
  const previous = { status: 'authoritative', membersById: { '2': { name: 'Beta', url: '/profile/2', attackCount: 1, raidCount: 2 } } };
  const current = { status: 'authoritative', observedAtMs: 1700000000000, membersById: {
    '2': { name: 'Beta', url: '/profile/2', attackCount: 3, raidCount: 4 },
    '1': { name: 'Alpha', url: '/profile/1', attackCount: 0, raidCount: 0 },
  } };
  assert.deepEqual(snapshot.diffAllianceSnapshots(previous, current), {
    commit: true,
    events: [{ id: '2', name: 'Beta', url: '/profile/2', attackCount: 3, raidCount: 4, oldAttackCount: 1, oldRaidCount: 2, addedAttackCount: 2, addedRaidCount: 2, eventType: 'mixed' }],
    current: current.membersById,
    observedAtMs: 1700000000000,
  });
  assert.deepEqual(snapshot.diffAllianceSnapshots(previous, { status: 'partial', membersById: current.membersById }), {
    commit: false, events: [], current: current.membersById, observedAtMs: undefined,
  });
  assert.deepEqual(snapshot.migrationFriendlyCountRecords(current).map((entry) => entry.id), ['1', '2']);
});

test('muting, thresholds, and priority preserve roster exceptions and configured boundaries', () => {
  const events = [
    { name: 'Muted', url: '/profile/1', eventType: 'attack', addedAttackCount: 2, addedRaidCount: 0 },
    { name: 'Raid', url: '/profile/2', eventType: 'raid', addedAttackCount: 0, addedRaidCount: 3 },
    { name: 'Join', url: '/profile/1', eventType: 'join' },
  ];
  const mutes = { 's1.example': { 1: true } };
  assert.deepEqual(snapshot.filterMutedEvents(events, 'S1.Example', mutes), [events[1], events[2]]);
  assert.deepEqual(snapshot.applyEventThresholds(events, SETTINGS), events);
  assert.equal(snapshot.classifyPriority({ addedAttackCount: 4 }, SETTINGS), 'normal');
  assert.equal(snapshot.classifyPriority({ addedRaidCount: 5 }, SETTINGS), 'high');
  assert.equal(snapshot.resolveEventPriority({ priority: 'critical' }, SETTINGS), 'critical');
  assert.equal(snapshot.highestBatchPriority(events.concat({ addedAttackCount: 9 }), SETTINGS), 'critical');
  assert.equal(snapshot.batchPriorityColor([{ addedAttackCount: 5 }], SETTINGS), 15844367);
  assert.equal(snapshot.priorityLabel('critical'), 'Critical');
});

test('pending event shaping preserves optional identity and observation fields', () => {
  assert.deepEqual(snapshot.toPendingEvent({
    id: 7, name: 'Alpha', url: '/profile/7', attackCount: 4, raidCount: 2,
    oldAttackCount: 1, oldRaidCount: 1, addedAttackCount: 3, addedRaidCount: 1,
    eventType: 'mixed', observedAtMs: 1700000000000, approximateObserved: true,
  }), {
    playerId: '7', name: 'Alpha', url: '/profile/7', attackCount: 4, raidCount: 2,
    oldAttackCount: 1, oldRaidCount: 1, addedAttackCount: 3, addedRaidCount: 1,
    eventType: 'mixed', observedAtMs: 1700000000000, approximateObserved: true,
  });
});
