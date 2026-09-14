'use strict';

const assert = require('node:assert/strict');
const script = require('../../../src/runtime.js');

const events = Array.from({ length: 25 }, (_, index) => ({
    sourceEventIds: [`s1:evidence-${String(index + 1).padStart(2, '0')}`],
    addedAttackCount: index % 2,
    addedRaidCount: (index + 1) % 2
}));
const plan = script.buildDispatchPlanV1(events, { chunkSize: 7 });
const ids = plan.chunks.flatMap(chunk => chunk.sourceEventIds);
assert.equal(new Set(ids).size, 25);
assert.equal(ids.length, 25);
assert.ok(plan.chunks.every(chunk => chunk.sourceCount === chunk.sourceEventIds.length));
const sending = script.applyDispatchPlanTransitionV1(plan, { type: 'claim', ownerId: 'evidence-owner', term: 9, generation: 0, payload: { embeds: [] } });
assert.equal(sending.chunks[0].state, 'sending');
assert.equal(sending.chunks[0].lastRequest.sourceCount, sending.chunks[0].sourceEventIds.length);
const acked = script.applyDispatchPlanTransitionV1(sending, { type: 'response', chunkId: sending.chunks[0].chunkId, ownerId: 'evidence-owner', term: 9, generation: sending.generation, status: 200, messageId: 'fixture-message-id' });
assert.equal(acked.chunks[0].state, 'acknowledged');
assert.ok(acked.chunks[0].ackHash.startsWith('a1:'));
assert.equal(acked.chunks[0].ackHash.includes('fixture-message-id'), false);
process.stdout.write(`${JSON.stringify({ batchId: plan.batchId, chunkCount: plan.chunks.length, sourceCount: ids.length, chunkIds: plan.chunks.map(chunk => ({ chunkId: chunk.chunkId, sourceCount: chunk.sourceCount })) , verdict: 'PASS' })}\n`);
