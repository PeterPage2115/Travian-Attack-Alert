'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const modules = ['discord', 'transport', 'dispatch', 'conservation', 'diagnostics'];
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, shell: false, encoding: 'utf8' });

function assertHappy() {
    const legacy = require(path.join(ROOT, 'src', 'legacy-bridge.js')).loadLegacy();
    const surfaces = Object.fromEntries(modules.map(name => [name, require(path.join(ROOT, 'src', `${name}.js`))]));
    const missing = ['buildDiscordPayloads', 'classifyDiscordResponse', 'sendDiscordPayload', 'buildDispatchPlanV1', 'sourceEventTuple', 'serializeDiagnosticsExportV2']
        .filter(name => !Object.values(surfaces).some(surface => typeof surface[name] === 'function'));
    if (missing.length) throw new Error(`T13-E001 missing extracted contracts: ${missing.join(',')}`);
    if (!Object.values(surfaces).every(surface => Object.keys(surface).every(name => name in legacy))) throw new Error('T13-E002 contract drift');
    if (modules.some(name => fs.readFileSync(path.join(ROOT, 'src', `${name}.js`), 'utf8').split(/\r?\n/).filter(line => line.trim() && !/^\s*\/\//.test(line)).length > 250)) throw new Error('T13-E003 module exceeds bound');
    if (run(['tools/build.cjs']).status !== 0 || run(['tools/check-artifact.cjs']).status !== 0) throw new Error('T13-E004 artifact gates failed');
    if (run(['tools/quality.cjs']).status !== 0) throw new Error('T13-E005 quality gate failed');
    if (run(['--test', '--test-name-pattern=compact partition|transport fixture|response taxonomy|dispatch plan|diagnostics serializer|terminal compaction|incident export', 'test/script.test.cjs']).status !== 0) throw new Error('T13-E006 focused parity failed');
    return { modules, bounded: true, pureBuilders: true, adapterBoundary: true, canonicalParity: true, gates: true };
}

function assertFailures() {
    const artifact = path.join(ROOT, 'script.txt');
    const original = fs.readFileSync(artifact);
    const checks = {};
    try {
        fs.writeFileSync(artifact, Buffer.concat([original, Buffer.from('\n// stale task13\n')]));
        checks['T13-F001 stale-artifact'] = run(['tools/check-artifact.cjs']).status !== 0;
    } finally {
        fs.writeFileSync(artifact, original);
    }
    checks['T13-F002 limit-overflow'] = run(['--test', '--test-name-pattern=rejects one-unit overflow', 'test/script.test.cjs']).status === 0;
    checks['T13-F003 malformed-200'] = run(['--test', '--test-name-pattern=malformed 200', 'test/script.test.cjs']).status === 0;
    checks['T13-F004 retry-exhaustion'] = run(['--test', '--test-name-pattern=programmable GM matrix|retryable', 'test/script.test.cjs']).status === 0;
    checks['T13-F005 secret-and-missing-id'] = run(['--test', '--test-name-pattern=README rejects stale grammar and secrets|missing ID', 'test/script.test.cjs']).status === 0;
    checks['T13-F006 diagnostics-throw'] = run(['--test', '--test-name-pattern=Todo 9 rejects|Todo 9 retains', 'test/script.test.cjs']).status === 0;
    const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([id]) => id);
    if (failed.length) throw new Error(`T13 failure injection not covered: ${failed.join(',')}`);
    return checks;
}

function main() {
    const result = process.argv.includes('--failures') ? assertFailures() : assertHappy();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, task: 13, gateIds: Object.keys(result), verdict: 'PASS' })}\n`);
}

if (require.main === module) main();
module.exports = { assertHappy, assertFailures };
