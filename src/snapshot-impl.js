'use strict';

const { PRIORITY_COLORS } = require('./constants.js');
const { extractPlayerId } = require('./text.js');
const { isPlayerMuted } = require('./storage-mutes.js');
const { validateSettings } = require('./storage-settings.js');

let queueEventFactory = null;
function configureSnapshotAdapters(seam = {}) {
  if (Object.prototype.hasOwnProperty.call(seam, 'queueEventFactory')) {
    if (seam.queueEventFactory !== null && typeof seam.queueEventFactory !== 'function') throw new TypeError('snapshot queueEventFactory must be a function');
    queueEventFactory = seam.queueEventFactory;
  }
}
function resetSnapshotAdapters() { queueEventFactory = null; }

function getStoredAttackCount(state, key) {
  if (key === 'filterVersion') return 0;
  const saved = state ? state[key] : undefined;
  if (saved && typeof saved === 'object') return typeof saved.attackCount === 'number' ? saved.attackCount : Number(saved.count) || 0;
  return Number(saved) || 0;
}
function getStoredRaidCount(state, key) {
  if (key === 'filterVersion') return 0;
  const saved = state ? state[key] : undefined;
  return saved && typeof saved === 'object' ? Number(saved.raidCount) || 0 : 0;
}
function getStoredCount(state, key) { return getStoredAttackCount(state, key); }

function shouldRebaseline(previous) {
  const hasStoredPlayers = Boolean(previous && Object.keys(previous).some((key) => key !== 'filterVersion'));
  return hasStoredPlayers && previous.filterVersion !== 4;
}

function diffAttackStates(previousState, currentState) {
  const newEvents = []; const previous = previousState || {};
  for (const [key, attack] of Object.entries(currentState || {})) {
    if (key === 'filterVersion') continue;
    const attackCount = Number.isFinite(attack.attackCount) ? attack.attackCount : Number.isFinite(attack.count) ? attack.count : 0;
    const raidCount = Number.isFinite(attack.raidCount) ? attack.raidCount : 0;
    const oldAttackCount = getStoredAttackCount(previous, key); const oldRaidCount = getStoredRaidCount(previous, key);
    const addedAttackCount = attackCount > oldAttackCount ? Math.max(1, attackCount - oldAttackCount) : 0;
    const addedRaidCount = raidCount > oldRaidCount ? Math.max(1, raidCount - oldRaidCount) : 0;
    if (addedAttackCount === 0 && addedRaidCount === 0) continue;
    const eventType = addedAttackCount > 0 && addedRaidCount === 0 ? 'attack' : addedRaidCount > 0 && addedAttackCount === 0 ? 'raid' : 'mixed';
    newEvents.push({ name: attack.name, url: attack.url, attackCount, raidCount, oldAttackCount, oldRaidCount, addedAttackCount, addedRaidCount, eventType });
  }
  return { newEvents, shouldSave: Object.keys(currentState || {}).length > 0 };
}

function filterMutedEvents(events, hostname, mutedPlayers) {
  if (!Array.isArray(events)) return [];
  const mutes = mutedPlayers && typeof mutedPlayers === 'object' ? mutedPlayers : {};
  return events.filter((event) => {
    if (!event || typeof event !== 'object' || event.eventType === 'join' || event.eventType === 'leave') return true;
    const playerId = extractPlayerId(event.url);
    return playerId === null || !isPlayerMuted(mutes, hostname, playerId);
  });
}

function applyEventThresholds(events, settings) {
  if (!Array.isArray(events)) return [];
  const validated = validateSettings(settings);
  return events.filter((event) => {
    if (!event || typeof event !== 'object') return false;
    if (event.eventType === 'join' || event.eventType === 'leave') return true;
    const attacks = Number.isFinite(event.addedAttackCount) ? event.addedAttackCount : 0;
    const raids = Number.isFinite(event.addedRaidCount) ? event.addedRaidCount : 0;
    if (event.eventType === 'attack') return attacks >= validated.attackThreshold;
    if (event.eventType === 'raid') return raids >= validated.raidThreshold;
    return attacks >= validated.attackThreshold || raids >= validated.raidThreshold;
  });
}

function classifyPriority(event, settings) {
  const validated = validateSettings(settings);
  const attacks = event && Number.isFinite(event.addedAttackCount) ? event.addedAttackCount : 0;
  const raids = event && Number.isFinite(event.addedRaidCount) ? event.addedRaidCount : 0;
  const peak = Math.max(attacks, raids);
  return peak <= validated.normalMax ? 'normal' : peak <= validated.highMax ? 'high' : 'critical';
}
function resolveEventPriority(event, settings) {
  const explicit = event && typeof event.priority === 'string' && ['normal', 'high', 'critical'].includes(event.priority) ? event.priority : null;
  return explicit || classifyPriority(event, settings);
}
function highestBatchPriority(events, settings) {
  const rank = { normal: 0, high: 1, critical: 2 }; let top = 'normal';
  for (const event of Array.isArray(events) ? events : []) { const current = resolveEventPriority(event, settings); if (rank[current] > rank[top]) top = current; }
  return top;
}
function batchPriorityColor(events, settings) { return PRIORITY_COLORS[highestBatchPriority(events, settings)]; }
function priorityLabel(priority) { return priority === 'high' ? 'High' : priority === 'critical' ? 'Critical' : 'Normal'; }

function toPendingEvent(event, options = {}) {
  const pending = { name: event.name, url: event.url, attackCount: event.attackCount, raidCount: event.raidCount, oldAttackCount: event.oldAttackCount, oldRaidCount: event.oldRaidCount, addedAttackCount: event.addedAttackCount, addedRaidCount: event.addedRaidCount, eventType: event.eventType };
  const playerId = event.playerId !== undefined ? event.playerId : event.id;
  if (playerId !== undefined && playerId !== null) pending.playerId = String(playerId);
  if (event.approximateObserved === true) pending.approximateObserved = true;
  if (event.observedAtApproximate === true) pending.observedAtApproximate = true;
  if (options.enforceQueueContract !== true) { if (Number.isFinite(event.observedAtMs)) pending.observedAtMs = event.observedAtMs; return pending; }
  if (typeof queueEventFactory !== 'function') throw new Error('snapshot queue contract requires a queue event factory');
  return queueEventFactory(pending, Object.assign({}, options, {
    playerId: options.playerId !== undefined ? options.playerId : event.playerId || event.id || extractPlayerId(event.url),
    observedAtMs: Number.isFinite(options.observedAtMs) ? options.observedAtMs : event.observedAtMs,
    queuedAtMs: Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : event.queuedAtMs,
  }));
}

function diffAllianceSnapshots(previous, current) {
  if (!current || current.status !== 'authoritative') return { commit: false, events: [], current: current && current.membersById ? current.membersById : {}, observedAtMs: current && current.observedAtMs };
  const previousMembers = previous && previous.status === 'authoritative' ? previous.membersById || {} : {}; const events = [];
  for (const [id, member] of Object.entries(current.membersById)) {
    const old = previousMembers[id] || {}; const oldAttackCount = Number.isFinite(old.attackCount) ? old.attackCount : 0; const oldRaidCount = Number.isFinite(old.raidCount) ? old.raidCount : 0;
    const addedAttackCount = Math.max(0, member.attackCount - oldAttackCount); const addedRaidCount = Math.max(0, member.raidCount - oldRaidCount);
    if (addedAttackCount === 0 && addedRaidCount === 0) continue;
    events.push({ id, name: member.name, url: member.url, attackCount: member.attackCount, raidCount: member.raidCount, oldAttackCount, oldRaidCount, addedAttackCount, addedRaidCount, eventType: addedAttackCount > 0 && addedRaidCount > 0 ? 'mixed' : addedAttackCount > 0 ? 'attack' : 'raid' });
  }
  return { commit: true, events, current: current.membersById, observedAtMs: current.observedAtMs };
}

function migrationFriendlyCountRecords(snapshot) {
  if (!snapshot || snapshot.status !== 'authoritative' || !snapshot.membersById) return [];
  return Object.entries(snapshot.membersById).sort(([left], [right]) => left.localeCompare(right)).map(([id, member]) => ({ id, name: member.name, url: member.url, attackCount: member.attackCount, raidCount: member.raidCount }));
}

module.exports = {
  configureSnapshotAdapters, resetSnapshotAdapters,
  getStoredCount, getStoredAttackCount, getStoredRaidCount, shouldRebaseline,
  diffAttackStates, filterMutedEvents, applyEventThresholds, classifyPriority,
  resolveEventPriority, highestBatchPriority, batchPriorityColor, priorityLabel,
  toPendingEvent, diffAllianceSnapshots, migrationFriendlyCountRecords,
};
