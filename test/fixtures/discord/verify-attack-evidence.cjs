#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const canonical = require('./canonical.cjs');
const script = require('../../../src/runtime.js');

function sourceIdsFromPlans(events, options) {
    const presentation = script.buildCompactDiscordPresentation(events, options);
    return script.partitionCompactDiscordEntries(presentation).flatMap(plan => plan.embedPlans.flatMap(embed => embed.lineEntries.map(entry => entry.event.testId)));
}
function verifyCase(name) {
    const fixture = canonical.previewCases[name](); const before = canonical.payloadsForCase(name); const after = script.buildDiscordPayloads(fixture.events, fixture.options);
    const sourceIds = fixture.events.map(event => event.testId); const afterIds = sourceIdsFromPlans(fixture.events, fixture.options);
    assert.equal(new Set(sourceIds).size, sourceIds.length, `${name}: source IDs must be unique`); assert.deepEqual([...afterIds].sort(), [...sourceIds].sort(), `${name}: source IDs must be lossless`); assert.ok(after.length <= before.length + 1, `${name}: fanout exceeds baseline + 1`);
    for (const payload of after) for (const embed of payload.embeds) { assert.ok((embed.title || '').length <= 256 && (embed.description || '').length <= 4096); assert.ok((embed.fields || []).every(field => field.name.length <= 256 && field.value.length <= 1024)); }
    return { beforeRequests: before.length, afterRequests: after.length, sourceIds, lossless: true, withinBound: true };
}
function run() { const attackCases = ['attack-mixed-six', 'players-60', 'forced-split', 'unicode']; const cases = Object.fromEntries(attackCases.map(name => [name, verifyCase(name)])); const result = { schemaVersion: 1, fixture: 'canonical-attack-evidence', cases, totalSourceIds: Object.values(cases).reduce((n, value) => n + value.sourceIds.length, 0), verdict: 'PASS' }; process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result; }
if (require.main === module) { try { run(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; } }
module.exports = { run, verifyCase, sourceIdsFromPlans };
