'use strict';

// Deterministic synthetic legacy monitor envelope used by the 1.0.4 scan
// latency evidence. It reproduces the v1.0.3 growth defect: a fully
// acknowledged 10,000-record terminal ledger that a no-delta authoritative
// scan re-serializes and read-backs. Built from the source envelope kernel so
// the canonical source lineage and integrity checksum are byte-identical to
// what the shipped artifact parses. Pure data: sequential synthetic ids, no
// secrets, no network, no player-identifying content.

const path = require('node:path');

const envelopeImpl = require(path.join(__dirname, '..', '..', '..', 'src', 'envelope-impl.js'));
const migrationImpl = require(path.join(__dirname, '..', '..', '..', 'src', 'migration-impl.js'));

function canonicalTerminalId(world, sequence) {
  const raid = sequence % 3 === 0;
  return migrationImpl.sourceEventIdFromTuple({
    world,
    playerId: String((sequence % 977) + 1),
    eventType: raid ? 'raid' : 'attack',
    acceptedGeneration: 1,
    scanSequence: sequence,
    attackDelta: raid ? 0 : 1,
    raidDelta: raid ? 1 : 0,
  });
}

function terminalRecords(world, count) {
  const terminal = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const raid = sequence % 3 === 0;
    terminal.push({
      eventId: `terminal-${sequence}`,
      terminalSequence: sequence,
      stage: 'acknowledged',
      terminalStatus: 'acknowledged',
      addedAttackCount: raid ? 0 : 1,
      addedRaidCount: raid ? 1 : 0,
      sourceEventIds: [canonicalTerminalId(world, sequence)],
    });
  }
  return terminal;
}

function buildLegacyTerminalEnvelope(world, count = 10000) {
  const envelope = envelopeImpl.createMonitorEnvelopeV1(world, { nowMs: 1000 });
  envelope.metrics.deliveryAccounting = Object.assign(
    {},
    envelope.metrics.deliveryAccounting,
    { terminal: terminalRecords(world, count) },
  );
  const raw = envelopeImpl.serializeMonitorEnvelopeV1(envelope);
  const parsed = envelopeImpl.parseMonitorEnvelopeV1(raw, world);
  if (!parsed.ok) {
    throw new Error(`synthetic legacy envelope must parse: ${JSON.stringify(parsed)}`);
  }
  return raw;
}

// Zero-count baseline for the members-59 fixture roster, so the next scan sees
// a real attack delta instead of establishing a fresh baseline (a first-ever
// scan never alerts by design).
function buildBaselineEnvelope(world, memberCount = 59) {
  const envelope = envelopeImpl.createMonitorEnvelopeV1(world, { nowMs: 1000 });
  const baseline = {};
  for (let index = 1; index <= memberCount; index += 1) {
    const id = String(900000 + index);
    baseline[id] = {
      name: `Fixture Player ${String(index).padStart(3, '0')}`,
      url: `/profile/${id}`,
      attackCount: 0,
      raidCount: 0,
    };
  }
  envelope.baselineByPlayerId = baseline;
  const raw = envelopeImpl.serializeMonitorEnvelopeV1(envelope);
  const parsed = envelopeImpl.parseMonitorEnvelopeV1(raw, world);
  if (!parsed.ok) {
    throw new Error(`synthetic baseline envelope must parse: ${JSON.stringify(parsed)}`);
  }
  return raw;
}

module.exports = { buildLegacyTerminalEnvelope, buildBaselineEnvelope, terminalRecords, canonicalTerminalId };
