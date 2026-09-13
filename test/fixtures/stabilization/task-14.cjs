'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const changedFiles = [
    'src/panel.js', 'src/boot.js', 'src/browser-entry.js', 'src/legacy-bridge.js',
    'tools/build.cjs', 'tools/check-artifact.cjs', 'tools/quality.cjs',
    'tsconfig.json', 'README.md', 'DESIGN.md', 'script.txt', 'metadata.json',
    'module-manifest.json', 'test/fixtures/stabilization/evidence-cases.cjs',
    'test/fixtures/stabilization/task-14.cjs',
    '.omo/notepads/stabilizacja-akwizycji-atakow/learnings.md',
    '.omo/notepads/stabilizacja-akwizycji-atakow/decisions.md'
];

function contract() {
    const runtime = require(path.join(ROOT, 'script.txt'));
    const readme = read('README.md');
    const design = read('DESIGN.md');
    const roles = Object.values(runtime.ROUTE_ROLES);
    const reasons = runtime.MEMBER_TABLE_REASON_CODES;
    if (fs.existsSync(path.join(ROOT, 'src/legacy-monolith.js'))) throw new Error('legacy source remains');
    if ((JSON.parse(read('module-manifest.json')).temporaryExceptions || []).length) throw new Error('legacy exception remains');
    for (const value of roles.concat(reasons)) if (!readme.includes(value) || !design.includes(value)) throw new Error(`documentation contract missing ${value}`);
    if (!/query-free `\/alliance\/profile\/members`/.test(readme) || !/exactly one\s+structural `table\.allianceMembers`/i.test(readme)) throw new Error('canonical route contract missing');
    if (/largest profile-link table is authoritative|largest table .*authoritative/i.test(`${readme}\n${design}`)) throw new Error('forbidden largest-table authority');
    return { roles, reasons, legacyRemoved: true, exceptionRemoved: true, changedFiles: changedFiles.map(file => ({ file, sha256: crypto.createHash('sha256').update(read(file)).digest('hex') })) };
}

function assertHappy() {
    const result = contract();
    for (const command of [['npm', 'run', 'build'], ['npm', 'run', 'check:artifact'], ['npm', 'run', 'quality', '--', '--gate', 'todo14-final']]) {
        const outcome = spawnSync(command[0], command.slice(1), { cwd: ROOT, shell: false, encoding: 'utf8' });
        if (outcome.status !== 0) throw new Error(`release gate failed: ${command.join(' ')}`);
    }
    return result;
}

function assertFailures() {
    const file = path.join(ROOT, 'DESIGN.md');
    const original = fs.readFileSync(file, 'utf8');
    try {
        fs.writeFileSync(file, `${original}\nThe largest profile-link table is authoritative for /alliance.\n`);
        let rejected = false;
        try { contract(); } catch { rejected = true; }
        if (!rejected) throw new Error('stale lifecycle contract was accepted');
    } finally { fs.writeFileSync(file, original); }
    return { staleDesignRejected: true };
}

const result = process.argv.includes('--failures') ? assertFailures() : assertHappy();
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, task: 14, assertions: result, verdict: 'PASS' })}\n`);
