'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const names = ['constants', 'text', 'storage', 'lease', 'route', 'parser', 'snapshot', 'envelope', 'migration', 'discord', 'diagnostics', 'panel', 'acquisition'];
const files = names.map(name => path.join(ROOT, 'src', `${name}.js`));
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, shell: false, encoding: 'utf8' });
const pureLines = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() && !/^\s*\/\//.test(line)).length;

function assertHappy() {
    const runtime = require(path.join(ROOT, 'src', 'runtime.js'));
    const legacy = Object.fromEntries(Object.entries(runtime).filter(([name]) => name !== 'startBrowserRuntime'));
    const surface = Object.assign({}, ...names.map(name => require(path.join(ROOT, 'src', `${name}.js`))));
    const missing = Object.keys(legacy).filter(name => !(name in surface));
    if (missing.length) throw new Error(`T12-E001 missing exports: ${missing.join(',')}`);
    if (files.some(file => pureLines(file) > 250)) throw new Error('T12-E002 handwritten module exceeds 250 LOC');
    if (run(['tools/quality.cjs']).status !== 0) throw new Error('T12-E003 quality gate failed');
    if (run(['tools/check-artifact.cjs']).status !== 0) throw new Error('T12-E004 artifact gate failed');
    if (run(['--test', '--test-name-pattern=route classifier|member-table contract|MonitorEnvelopeV1|legacy .*migration', 'test/script.test.cjs']).status !== 0) throw new Error('T12-E005 focused parity failed');
    return { exports: true, bounded: true, quality: true, artifact: true, focused: true };
}

function assertFailures() {
    const checks = {};
    const manifest = path.join(ROOT, 'module-manifest.json');
    const artifact = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');
    const route = path.join(ROOT, 'src', 'route.js');
    const original = new Map([[manifest, fs.readFileSync(manifest)], [artifact, fs.readFileSync(artifact)], [route, fs.readFileSync(route)]]);
    try {
        fs.writeFileSync(route, "'use strict';\nmodule.exports = {};\n");
        delete require.cache[require.resolve(route)];
        checks['T12-F001 missing-export'] = require(route).lockNameForHostname === undefined;
        fs.writeFileSync(route, original.get(route));
        fs.writeFileSync(route, `${original.get(route)}\nrequire('./route');\n`);
        checks['T12-F002 cycle'] = run(['tools/quality.cjs']).status !== 0;
        fs.writeFileSync(path.join(ROOT, 'src', '_task12-too-large.js'), `${'const x = 1;\n'.repeat(251)}`);
        checks['T12-F003 size'] = run(['tools/quality.cjs']).status !== 0;
        fs.writeFileSync(artifact, Buffer.concat([original.get(artifact), Buffer.from('\n// stale task12\n')]));
        checks['T12-F004 stale-artifact'] = run(['tools/check-artifact.cjs']).status !== 0;
        fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original.get(manifest)), schemaVersion: 99 }) + '\n');
        checks['T12-F005 schema-drift'] = run(['tools/quality.cjs']).status !== 0;
    } finally {
        for (const [file, bytes] of original) fs.writeFileSync(file, bytes);
        fs.rmSync(path.join(ROOT, 'src', '_task12-too-large.js'), { force: true });
    }
    const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([id]) => id);
    if (failed.length) throw new Error(`T12 failure injection not rejected: ${failed.join(',')}`);
    return checks;
}

function main() {
    const failures = process.argv.includes('--failures');
    const result = failures ? assertFailures() : assertHappy();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, task: 12, gateIds: Object.keys(result), verdict: 'PASS' })}\n`);
}

if (require.main === module) main();
module.exports = { assertHappy, assertFailures };
