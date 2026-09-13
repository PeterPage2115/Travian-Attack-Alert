'use strict';

const STAGES = new Set(['pending', 'prepared', 'sending', 'retryable', 'failed', 'uncertain', 'acknowledged']);
const DISPOSITIONS = new Set(['muted', 'threshold-blocked', 'eligible']);

function stableSourceId({ world, playerId, eventType, generation, scanSequence, deltaType, ordinal }) {
    const tuple = ['world', world, 'playerId', playerId, 'eventType', eventType, 'generation', generation, 'scanSequence', scanSequence, 'deltaType', deltaType, 'ordinal', ordinal];
    return `s1:${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}`;
}

function count(state, playerId, type) {
    return state[playerId]?.[`${type}Count`] || 0;
}

function assignPositiveNetDeltas({ world, generation, scanSequence, previous, current }) {
    const ids = [];
    for (const playerId of Object.keys(current).sort()) {
        for (const type of ['attack', 'raid']) {
            const delta = count(current, playerId, type) - count(previous, playerId, type);
            for (let ordinal = 1; ordinal <= Math.max(0, delta); ordinal += 1) {
                ids.push(stableSourceId({ world, playerId, eventType: type, generation, scanSequence, deltaType: type, ordinal }));
            }
        }
    }
    return ids;
}

function coalesceSourceIds(records) {
    return records.flatMap(record => record.sourceEventIds);
}

function firstDuplicate(ids, stage) {
    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id)) throw new Error(`duplicate source ID ${id} at stage ${stage}`);
        seen.add(id);
    }
}

function assertUniqueSources(ids, label) {
    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id)) throw new Error(`duplicate source ID ${id} in ${label}`);
        seen.add(id);
    }
}

function assertConservation({ detections, delivery, queueProjection = [], dispatchProjection = [] }) {
    const dispositions = new Map();
    for (const detection of detections) {
        if (!DISPOSITIONS.has(detection.disposition)) throw new Error(`unknown detection disposition ${detection.disposition}`);
        assertUniqueSources(detection.sourceEventIds, `detection ${detection.disposition}`);
        for (const id of detection.sourceEventIds) {
            if (dispositions.has(id)) throw new Error(`duplicate source ID ${id} across detection dispositions`);
            dispositions.set(id, detection.disposition);
        }
    }
    const positiveNetDelta = delivery.positiveNetDelta ?? dispositions.size;
    const dispositionTotal = [...dispositions.values()].length;
    if (positiveNetDelta !== dispositionTotal) throw new Error(`detection equation wrong count: net delta ${positiveNetDelta}, represented ${dispositionTotal}`);
    const eligibleIds = new Set([...dispositions].filter(([, disposition]) => disposition === 'eligible').map(([id]) => id));
    const entries = delivery.entries || [];
    const represented = new Map();
    for (const entry of entries) {
        if (!STAGES.has(entry.stage)) throw new Error(`unknown delivery stage ${entry.stage}`);
        firstDuplicate(entry.sourceEventIds, entry.stage);
        for (const id of entry.sourceEventIds) {
            if (represented.has(id)) throw new Error(`duplicate source ID ${id} at stage ${entry.stage}; first stage ${represented.get(id)}`);
            represented.set(id, entry.stage);
        }
    }
    const compacted = delivery.compactedTerminalTotals || [];
    for (const range of compacted) {
        const rangeLabel = `compacted range ${range.from}-${range.to}`;
        firstDuplicate(range.sourceEventIds, rangeLabel);
        for (const id of range.sourceEventIds) {
            if (represented.has(id)) throw new Error(`double-counted source ID ${id} in ${rangeLabel}; first stage ${represented.get(id)}`);
            represented.set(id, rangeLabel);
        }
        if (range.count !== range.sourceEventIds.length) throw new Error(`wrong count in ${rangeLabel}: count ${range.count}, IDs ${range.sourceEventIds.length}`);
    }
    for (const [id, stage] of represented) {
        if (!eligibleIds.has(id)) throw new Error(`unexpected source ID ${id} at stage ${stage}`);
    }
    for (const id of eligibleIds) {
        if (!represented.has(id)) throw new Error(`missing source ID ${id} at stage ${entries[0]?.stage || 'delivery'}`);
    }
    const deliveryTotal = [...represented.keys()].length;
    if (eligibleIds.size !== deliveryTotal) throw new Error(`delivery equation wrong count: eligible ${eligibleIds.size}, represented ${deliveryTotal}`);
    const projection = [...queueProjection, ...dispatchProjection];
    assertUniqueSources(projection, 'queue/dispatch projection');
    const projectedIds = new Set(projection);
    for (const id of projectedIds) {
        if (!represented.has(id)) throw new Error(`projection source ID ${id} is not in delivery accounting`);
    }
    return { detectionTotal: positiveNetDelta, eligibleTotal: eligibleIds.size, deliveryTotal, stages: represented };
}

module.exports = { assignPositiveNetDeltas, assertConservation, coalesceSourceIds, stableSourceId };
