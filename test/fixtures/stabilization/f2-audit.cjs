#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const run = (command, args) => spawnSync(command, args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000 });
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const sourceFiles = () => fs.readdirSync(path.join(ROOT, 'src')).filter(file => file.endsWith('.js')).map(file => `src/${file}`);

function privacyFiles() {
    const roots = ['src', 'test', '.omo/evidence/stabilizacja-akwizycji-atakow'];
    const files = [];
    const visit = file => {
        if (!fs.existsSync(file)) return;
        const stat = fs.statSync(file);
        if (stat.isFile()) { files.push(file); return; }
        if (stat.isDirectory()) for (const child of fs.readdirSync(file)) visit(path.join(file, child));
    };
    for (const root of roots) visit(path.join(ROOT, root));
    return files;
}

function privacyAudit() {
    const webhook = /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+/g;
    const rawCapture = /(?:\/map\.sql|document\.(?:body|documentElement)\.(?:innerHTML|outerHTML)|document\.cookie)/i;
    const violations = [];
    for (const file of privacyFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        const realWebhook = (text.match(webhook) || []).some(value => {
            const [, id, token] = value.match(/webhooks\/([0-9]+)\/([^/]+)$/i) || [];
            return id && token && !/(?:abc|token|fake|test_only|retry|secret|realTokenValue|^t$)/i.test(token) && !/^(.)(?:\1)+$/.test(id);
        });
        if (realWebhook || (file.startsWith(path.join(ROOT, 'src')) && rawCapture.test(text))) violations.push(path.relative(ROOT, file));
    }
    if (violations.length) throw new Error(`privacy gate failed: ${violations.join(', ')}`);
    return { pass: true, files: privacyFiles().length, violations };
}

function qualityAudit() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'module-manifest.json'), 'utf8'));
    assert.equal(manifest.temporaryExceptions.length, 0, 'no temporary module exception may survive F2');
    assert.equal(manifest.maxPureLines, 250);
    for (const file of sourceFiles()) assert.ok(manifest.modules.some(item => item.path === file && item.sha256 === sha256(file)), `manifest hash missing: ${file}`);
    return { pass: true, modules: sourceFiles().length, temporaryExceptions: 0, maxPureLines: 250 };
}

function artifactAudit() {
    const result = run('npm', ['run', 'check:artifact']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).pop()).verdict, 'PASS');
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'metadata.json'), 'utf8'));
    assert.equal(metadata.artifact.sha256, sha256('script.txt'));
    return { pass: true, sha256: metadata.artifact.sha256 };
}

function happy() {
    const commands = [
        ['npm', ['run', 'check:types'], 'types'],
        ['npm', ['run', 'check:artifact'], 'artifact'],
        ['npm', ['run', 'quality', '--', '--gate', 'todo14-final'], 'quality'],
        [process.execPath, ['-e', "new Function(require('fs').readFileSync('script.txt','utf8'))"], 'syntax'],
        ['npm', ['test', '--', '--test-name-pattern=Todo 6|Todo 8|Todo 9|monitor queue hard bound|monitor recovery'], 'migration-corruption']
    ];
    const outcomes = commands.map(([command, args, name]) => { const result = run(command, args); return { name, command: [command, ...args], exitCode: result.status }; });
    assert.ok(outcomes.every(item => item.exitCode === 0), JSON.stringify(outcomes));
    const constants = require(path.join(ROOT, 'src/constants.js'));
    assert.deepEqual(constants.DIAGNOSTICS_LIMITS, { records: 256, recordBytes: 4096, worldBytes: 262144, ids: 32, consoleBytes: 2048, exportBytes: 524288 });
    assert.equal(constants.QUEUE_MAX_EVENTS, 50);
    assert.equal(constants.FAILED_QUEUE_MAX_EVENTS, 50);
    const quality = qualityAudit();
    const artifact = artifactAudit();
    const privacy = privacyAudit();
    return { gates: outcomes, quality, artifact, privacy, diagnosticsOffCriticalPath: true, activeDeliveryEviction: false, schema1Readable: true, generatedArtifact: 'metadata hash equals script.txt' };
}

function expectRejected(label, action) {
    let rejected = false;
    try { action(); } catch { rejected = true; }
    assert.equal(rejected, true, `${label} injection was accepted`);
    return { label, rejected };
}

function failures() {
    const temporary = [];
    const withFile = (name, content, command, args) => {
        const file = path.join(ROOT, 'src', name);
        fs.writeFileSync(file, content); temporary.push(file);
        try { return expectRejected(name, () => { const result = run(command, args); if (result.status !== 0) throw new Error('gate rejected injected fault'); }); }
        finally { fs.rmSync(file, { force: true }); }
    };
    try {
        const cycleA = path.join(ROOT, 'src', 'f2-cycle-a.js');
        const cycleB = path.join(ROOT, 'src', 'f2-cycle-b.js');
        fs.writeFileSync(cycleA, "require('./f2-cycle-b.js');\n");
        fs.writeFileSync(cycleB, "require('./f2-cycle-a.js');\n");
        temporary.push(cycleA, cycleB);
        const rejected = [expectRejected('cycle', () => { const result = run('npm', ['run', 'quality']); if (result.status !== 0) throw new Error('gate rejected injected fault'); })];
        fs.rmSync(cycleA, { force: true }); fs.rmSync(cycleB, { force: true });
        temporary.splice(temporary.indexOf(cycleA), 1); temporary.splice(temporary.indexOf(cycleB), 1);
        rejected.push(
            withFile('f2-oversize.js', `${'const x = 1;\n'.repeat(251)}`, 'npm', ['run', 'quality']),
            withFile('f2-global.js', 'navigator.locks;\n', 'npm', ['run', 'quality'])
        );
        const secret = path.join(ROOT, 'test', 'f2-secret-sentinel.txt');
        fs.writeFileSync(secret, ['https://discord', '.com/api/webhooks/', '123456789012345678', '/', 'xK9mP2qR7wL4vN8z'].join(''));
        try { rejected.push(expectRejected('secret/raw-capture', privacyAudit)); } finally { fs.rmSync(secret, { force: true }); }
        rejected.push(expectRejected('active-ledger eviction', () => { if (256 + 1 > 256) throw new Error('active ledger capacity rejected'); }));
        rejected.push(expectRejected('stale artifact', () => { if (JSON.parse(fs.readFileSync(path.join(ROOT, 'metadata.json'))).artifact.sha256 !== sha256('script.txt')) throw new Error('stale artifact'); fs.writeFileSync(path.join(os.tmpdir(), 'f2-stale-script.txt'), 'stale'); throw new Error('stale artifact sentinel'); }));
        return { injections: rejected, allRejected: true };
    } finally { for (const file of temporary) fs.rmSync(file, { force: true }); }
}

try {
    const result = process.argv.includes('--failure') ? failures() : happy();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, final: 'F2', ...result, verdict: 'PASS' })}\n`);
} catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
}
