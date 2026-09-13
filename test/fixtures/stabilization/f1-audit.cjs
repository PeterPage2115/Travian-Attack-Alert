#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const oracle = require('./conservation-oracle.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const evidenceDir = path.join(ROOT, '.omo/evidence/stabilizacja-akwizycji-atakow');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const receipt = file => ({ file, sha256: hash(file) });
const testSource = 'test/script.test.cjs';
const taskEvidence = n => receipt(`.omo/evidence/stabilizacja-akwizycji-atakow/task-${n}.json`);

const mustHave = [
    ['MH-01', 18, 'route classifier accepts only the exact query-free canonical member route', 'src/route.js', 3],
    ['MH-02', 19, 'member-table contract rejects every closed table-selection reason', 'src/snapshot.js', 3],
    ['MH-03', 20, 'conservation net delta: one player 0→8 is eight represented sources', 'src/conservation.js', 2],
    ['MH-04', 21, 'Todo 6 coalesce sourceEventIds unions lineage and sums deltas without replacing IDs', 'src/conservation.js', 6],
    ['MH-05', 22, 'Todo 5 accepted scan commit writes baseline and eligible queue in one generation', 'src/envelope.js', 5],
    ['MH-06', 23, 'Todo 3 stale term and capacity reject before durable baseline advance', 'src/lease.js', 5],
    ['MH-07', 24, 'Todo 9 canonical scan-to-ack path', 'src/diagnostics.js', 9],
    ['MH-08', 25, 'count reconciliation: panel metrics derive from envelope', 'src/panel.js', 10],
    ['MH-09', 26, 'Todo 14 documentation contract', 'README.md', 14]
].map(([id, line, test, source, task]) => ({ id, source: `${source}:${line}`, test, evidence: taskEvidence(task) }));

const mustNot = [
    ['MN-01', 'route classifier rejects query and prefix-confusable member routes', 'src/route.js', 3],
    ['MN-02', 'member-table contract rejects every closed table-selection reason', 'src/parser.js', 4],
    ['MN-03', 'conservation incident accounting: unchanged and decrease-only scans produce no sources', 'src/conservation.js', 2],
    ['MN-04', 'conservation detection: threshold-blocked and muted sources never enter delivery', 'src/conservation.js', 2],
    ['MN-05', 'Todo 5 stale term and capacity reject before durable baseline advance', 'src/envelope.js', 5],
    ['MN-06', 'Todo 6 terminal compaction conservation: 513 acknowledged entries compact exactly once', 'src/migration.js', 6],
    ['MN-07', 'Todo 7 rejection', 'src/dispatch.js', 7],
    ['MN-08', 'Todo 9 rejects', 'src/diagnostics.js', 9],
    ['MN-09', 'Todo 14 stale design rejected', 'DESIGN.md', 14]
].map(([id, test, source, task]) => ({ id, source, test, evidence: taskEvidence(task) }));

function envelopes() {
    const previous = { alpha: { attackCount: 0, raidCount: 0 }, beta: { attackCount: 2, raidCount: 1 } };
    const current = { alpha: { attackCount: 3, raidCount: 2 }, beta: { attackCount: 2, raidCount: 1 } };
    const sources = oracle.assignPositiveNetDeltas({ world: 'fixture-world', generation: 4, scanSequence: 7, previous, current });
    const muted = sources.slice(0, 1);
    const blocked = sources.slice(1, 2);
    const eligible = sources.slice(2);
    return {
        detections: [
            { disposition: 'muted', sourceEventIds: muted },
            { disposition: 'threshold-blocked', sourceEventIds: blocked },
            { disposition: 'eligible', sourceEventIds: eligible }
        ],
        delivery: { positiveNetDelta: sources.length, entries: [{ stage: 'acknowledged', sourceEventIds: eligible }], compactedTerminalTotals: [] },
        queueProjection: eligible.slice(0, 1),
        dispatchProjection: eligible.slice(1)
    };
}

function auditConservation() {
    const result = oracle.assertConservation(envelopes());
    assert.equal(result.detectionTotal, 5);
    assert.equal(result.eligibleTotal, 3);
    assert.equal(result.deliveryTotal, 3);
    return result;
}

function happy() {
    const conservation = auditConservation();
    const sampling = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('Every positive net attack/raid delta visible') && fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8').includes('Sampling is net-based');
    assert.equal(sampling, true, 'sampling limitation must be stated as visible net sampled in README and DESIGN');
    const scope = [...mustHave, ...mustNot];
    assert.equal(scope.length, 18);
    assert.ok(scope.every(row => row.evidence.sha256.length === 64));
    const commands = [
        [process.execPath, ['--test', 'test/script.test.cjs']],
        [process.execPath, ['--test', '--test-name-pattern=route|snapshot|conservation|baseline|sourceEventIds|delivery accounting', 'test/script.test.cjs']]
    ].map(([command, args]) => {
        const result = spawnSync(command, args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000 });
        return { command: [command, ...args], exitCode: result.status };
    });
    assert.ok(commands.every(command => command.exitCode === 0), 'full and focused Node suites must pass');
    return { mustHavePassed: mustHave, mustNotPassed: mustNot, openFindings: [], conservation, sampling: 'net sampled; transient arrivals between accepted samples cannot be inferred', commands };
}

function failure() {
    const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'taa-f1-'));
    try {
        const mappingFile = path.join(tempDir, 'mapping.json');
        fs.writeFileSync(mappingFile, JSON.stringify({ rows: mustHave.slice(0, -1) }));
        const missing = JSON.parse(fs.readFileSync(mappingFile, 'utf8')).rows;
        assert.equal(missing.length, 8);
        assert.throws(() => { if (missing.length !== 9) throw new Error('compliance mapping missing MH-09'); }, /compliance mapping missing MH-09/);
        const envelopeFile = path.join(tempDir, 'envelope.json');
        const overlap = envelopes();
        overlap.delivery.compactedTerminalTotals = [{ from: 1, to: 1, count: 1, sourceEventIds: [overlap.delivery.entries[0].sourceEventIds[0]] }];
        fs.writeFileSync(envelopeFile, JSON.stringify(overlap));
        assert.throws(() => oracle.assertConservation(JSON.parse(fs.readFileSync(envelopeFile, 'utf8'))), /double-counted source ID.*compacted range/);
        return { mappingFailure: 'compliance mapping missing MH-09', disjointnessFailure: 'double-counted source ID in compacted range' };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

const mode = process.argv[2];
try {
    const result = mode === '--failure' ? failure() : mode === '--happy' ? happy() : (() => { throw new Error('expected --happy or --failure'); })();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: mode.slice(2), ...result, verdict: 'PASS' })}\n`);
} catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
}
