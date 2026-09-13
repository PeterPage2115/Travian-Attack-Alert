#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE = path.join(ROOT, '.omo/evidence/stabilizacja-akwizycji-atakow');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args) => spawnSync(command, args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });

function filesUnder(root) {
    const result = [];
    const visit = file => {
        if (!fs.existsSync(file)) return;
        const stat = fs.lstatSync(file);
        if (stat.isFile()) { result.push(file); return; }
        if (stat.isDirectory() && !['node_modules', '.codegraph', '.playwright-mcp'].includes(path.basename(file))) {
            for (const child of fs.readdirSync(file)) visit(path.join(file, child));
        }
    };
    visit(root);
    return result;
}

function historicalHashes() {
    return new Map(filesUnder(EVIDENCE).filter(file => !file.endsWith('f4-scope-rollback.json')).map(file => [file, digest(file)]));
}

function scopeAudit() {
    const sourceFiles = ['script.txt', ...filesUnder(path.join(ROOT, 'src')).filter(file => file.endsWith('.js'))];
    const forbidden = [
        ['alliance fetch', /\bfetch\s*\(\s*["'`][^"'`]*\/alliance/i],
        ['background monitor', /serviceWorker|background\.js|chrome\.alarms/i],
        ['sidebar', /villageList|sidebar|own-village/i],
        ['report parser', /alliance\/reports|report-detail|report parser/i],
        ['MV3', /manifest_version\s*:\s*3|chrome\.scripting/i],
        ['TypeScript conversion', /\.tsx?\b|typescript|interface\s+\w+\s*\{/i],
        ['stealth', /stealth|captcha|WAF\s*bypass/i],
        ['action automation', /page-action|revoke.*permission|auto.*action/i],
        ['map.sql', /\/map\.sql/i]
    ];
    const findings = [];
    for (const file of sourceFiles) {
        if (file.endsWith('f4-audit.cjs')) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const [label, pattern] of forbidden) if (pattern.test(text)) findings.push({ label, file: path.relative(ROOT, file) });
        if (/reload(?:Min|Max)Seconds\s*:\s*(?:[0-5]?\d)\b/i.test(text)) findings.push({ label: 'polling interval below 60 seconds', file: path.relative(ROOT, file) });
    }
    const fixtureFiles = filesUnder(path.join(ROOT, 'test/fixtures')).filter(file => file.includes('stabilization'));
    const evidenceFiles = filesUnder(EVIDENCE);
    const rawCapture = [...fixtureFiles, ...evidenceFiles].filter(file => path.extname(file) === '.dane' || /\.dane(?:\b|\/)/i.test(path.relative(ROOT, file)));
    const distributables = filesUnder(ROOT).filter(file => /(?:\.user\.js|userscript\.js)$/i.test(file) || path.basename(file) === 'script.txt');
    if (distributables.length !== 1 || path.basename(distributables[0]) !== 'script.txt') findings.push({ label: 'distributable count', files: distributables.map(file => path.relative(ROOT, file)) });
    return { findings, rawCapture: rawCapture.map(file => path.relative(ROOT, file)), distributables: distributables.map(file => path.relative(ROOT, file)) };
}

function documentationContract() {
    const runtime = require(path.join(ROOT, 'script.txt'));
    const readme = read('README.md');
    const design = read('DESIGN.md');
    const roles = Object.values(runtime.ROUTE_ROLES);
    const reasons = runtime.MEMBER_TABLE_REASON_CODES;
    for (const value of roles.concat(reasons)) {
        assert.ok(readme.includes(value) && design.includes(value), `documentation missing runtime enum: ${value}`);
    }
    assert.match(readme, /query-free `\/alliance\/profile\/members`/);
    assert.match(readme, /exactly one\s+structural `table\.allianceMembers`/i);
    assert.doesNotMatch(`${readme}\n${design}`, /largest profile-link table is authoritative|largest table .*authoritative/i);
    assert.doesNotMatch(`${readme}\n${design}`, /broad `\/alliance`.*authority|`\/alliance` route may acquire authority/i);
    return { roles, reasons, lifecycleStages: ['route', 'lease', 'snapshot', 'diff', 'filter', 'queue', 'dispatch', 'reload'] };
}

function commandAudit() {
    const commands = [
        [process.execPath, ['-e', "new Function(require('fs').readFileSync('script.txt','utf8'))"], 'syntax'],
        [process.execPath, ['--test', 'test/script.test.cjs'], 'node-test'],
        ['npm', ['test'], 'npm-test'],
        ['npm', ['run', 'build'], 'build-1'],
        ['npm', ['run', 'build'], 'build-2'],
        ['npm', ['run', 'check:artifact'], 'artifact'],
        ['npm', ['run', 'check:types'], 'types'],
        ['npm', ['run', 'quality', '--', '--gate', 'todo14-final'], 'quality'],
        ['node', ['test/fixtures/discord/static-format-audit.cjs', '--file', 'script.txt', '--readme', 'README.md'], 'static-audit']
    ];
    const outcomes = commands.map(([command, args, name]) => ({ name, command: [command, ...args], exitCode: run(command, args).status }));
    assert.ok(outcomes.every(item => item.exitCode === 0), JSON.stringify(outcomes));
    assert.equal(digest(path.join(ROOT, 'script.txt')), JSON.parse(read('metadata.json')).artifact.sha256, 'artifact metadata drift');
    return outcomes;
}

function compatibilityAudit() {
    const outcomes = [
        ['node', ['test/fixtures/stabilization/task-8.cjs'], 'frozen-old-round-trip'],
        ['node', ['test/fixtures/stabilization/task-8.cjs', '--failures'], 'legacy-rejection'],
        ['npm', ['test', '--', '--test-name-pattern=legacy|old envelope|migration'], 'old-script-compatibility']
    ].map(([command, args, name]) => ({ name, command: [command, ...args], exitCode: run(command, args).status }));
    assert.ok(outcomes.every(item => item.exitCode === 0), JSON.stringify(outcomes));
    return outcomes;
}

function staleArtifactNegative() {
    const file = path.join(ROOT, 'script.txt');
    const original = fs.readFileSync(file);
    try {
        fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n// stale artifact sentinel\n')]));
        assert.notEqual(run('npm', ['run', 'check:artifact']).status, 0, 'stale artifact accepted');
    } finally { fs.writeFileSync(file, original); }
    return { rejected: true };
}

function happy() {
    const before = historicalHashes();
    const scope = scopeAudit();
    assert.deepEqual(scope.findings, []);
    assert.deepEqual(scope.rawCapture, []);
    const docs = documentationContract();
    const commands = commandAudit();
    const compatibility = compatibilityAudit();
    const stale = staleArtifactNegative();
    const after = historicalHashes();
    assert.deepEqual([...before], [...after], 'historical evidence changed');
    return { scope, docs, commands, compatibility, staleArtifact: stale, historicalEvidenceUntouched: true, firstDivergentStage: 'trace stages route→lease→snapshot→diff→filter→queue→dispatch→reload' };
}

function failures() {
    const injected = [];
    const tempSource = path.join(ROOT, 'src', 'f4-forbidden-sentinel.js');
    try {
        fs.writeFileSync(tempSource, 'fetch("/alliance/profile/members");\n');
        assert.ok(scopeAudit().findings.length > 0, 'forbidden scope accepted');
        injected.push('forbidden-fetch');
    } finally { fs.rmSync(tempSource, { force: true }); }
    const design = path.join(ROOT, 'DESIGN.md');
    const original = fs.readFileSync(design, 'utf8');
    try {
        fs.writeFileSync(design, `${original}\nThe largest profile-link table is authoritative for /alliance.\n`);
        assert.throws(documentationContract, /largest profile-link table is authoritative/);
        injected.push('stale-design-lifecycle');
    } finally { fs.writeFileSync(design, original); }
    return { injected, allRejected: injected.length === 2 };
}

try {
    const result = process.argv.includes('--failure') ? failures() : happy();
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, final: 'F4', ...result, verdict: 'PASS' })}\n`);
} catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
}
