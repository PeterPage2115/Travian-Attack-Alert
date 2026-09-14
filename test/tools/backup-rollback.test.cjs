'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const TOOL_FILES = ['backup.cjs', 'rollback.cjs', 'build.cjs', 'check-artifact.cjs'];
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const RELEASE_ID = `taa-${VERSION}`;
// Backup/rollback contract (Task 10): the editable source authority plus
// config plus metadata. The generated dist tree is never backed up.
const LIVE_FILES = ['src/runtime.js', 'config/userscript.json', 'metadata.json', 'module-manifest.json'];

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function run(project, tool, args = [], extra = {}) {
    return require('node:child_process').spawnSync(process.execPath, [path.join(project, 'tools', tool), ...args], {
        cwd: project, env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules'), TAA_ROOT: project, ...extra }, encoding: 'utf8'
    });
}
function fixture() {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-backup-'));
    fs.mkdirSync(path.join(project, 'tools'));
    for (const file of TOOL_FILES) fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(project, 'tools', file));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(project, 'package.json'));
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'runtime.js'), "'use strict';\nmodule.exports = { fixture: true };\n");
    const runtimeHash = hash(path.join(project, 'src', 'runtime.js'));
    fs.mkdirSync(path.join(project, 'config'), { recursive: true });
    fs.writeFileSync(path.join(project, 'config', 'userscript.json'), JSON.stringify({ name: 'Fixture', namespace: 'fixture', description: 'fixture', match: ['https://*.example.test/*'] }) + '\n');
    fs.writeFileSync(path.join(project, 'metadata.json'), JSON.stringify({ schemaVersion: 1, release: { version: VERSION, releaseId: RELEASE_ID }, artifact: { path: 'dist/travian-attack-alert.user.js', sha256: runtimeHash, source: { path: 'src/userscript-entry.js', sha256: runtimeHash }, dist: { path: 'dist/travian-attack-alert.user.js', sha256: runtimeHash } } }) + '\n');
    fs.writeFileSync(path.join(project, 'module-manifest.json'), JSON.stringify({ schemaVersion: 1, release: { version: VERSION, releaseId: RELEASE_ID }, modules: [] }) + '\n');
    // The fixture mirrors an installed project: the generated dist tree exists
    // on disk but is deliberately NOT part of the backup set.
    fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(project, 'src', 'runtime.js'), path.join(project, 'dist', 'travian-attack-alert.user.js'));
    fs.writeFileSync(path.join(project, 'dist', 'travian-attack-alert.user.js.sha256'), `${runtimeHash}  dist/travian-attack-alert.user.js\n`);
    return project;
}
function liveHashes(project) { return LIVE_FILES.map((file) => hash(path.join(project, file))); }
function backupSelector(project) {
    const result = run(project, 'backup.cjs');
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function selectorInfo(project) { const digest = backupSelector(project); return { digest, selector: `${VERSION}-${digest.slice(0, 8)}`, dir: path.join(project, 'backups') }; }
function payloadName(kind, selector) { return `${kind === 'moduleManifest' ? 'module-manifest' : kind}-${selector}.${kind === 'runtime' ? 'js' : 'json'}`; }
function unchangedFailure(project, args, extra = {}) { const before = liveHashes(project); const result = run(project, 'rollback.cjs', args, extra); assert.notEqual(result.status, 0, result.stdout); assert.deepEqual(liveHashes(project), before); }

test('Given a fixture, When backup runs, Then it publishes matching payloads, sidecars, and manifest', () => {
    const project = fixture();
    try {
        const digest = backupSelector(project);
        const selector = `${VERSION}-${digest.slice(0, 8)}`;
        const backupDir = path.join(project, 'backups');
        const names = [`runtime-${selector}.js`, `config-${selector}.json`, `metadata-${selector}.json`, `module-manifest-${selector}.json`, `runtime-${selector}.js.sha256`, `config-${selector}.json.sha256`, `metadata-${selector}.json.sha256`, `module-manifest-${selector}.json.sha256`, `backup-${selector}.manifest.json`];
        for (const name of names) assert.ok(fs.existsSync(path.join(backupDir, name)), name);
        const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, `backup-${selector}.manifest.json`), 'utf8'));
        assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'version', 'releaseId', 'selector', 'files', 'runtimeSha256']);
        assert.equal(manifest.releaseId, RELEASE_ID);
        assert.equal(manifest.files.runtime.sha256, digest);
        for (const kind of ['runtime', 'config', 'metadata', 'moduleManifest']) assert.equal(manifest.files[kind].path, `${kind === 'moduleManifest' ? 'module-manifest' : kind}-${VERSION}-${digest.slice(0, 8)}.${kind === 'runtime' ? 'js' : 'json'}`);
        for (const kind of ['runtime', 'config', 'metadata', 'moduleManifest']) {
            const payload = names[['runtime', 'config', 'metadata', 'moduleManifest'].indexOf(kind)];
            assert.equal(fs.readFileSync(path.join(backupDir, `${payload}.sha256`), 'utf8'), `${hash(path.join(backupDir, payload))}  ${payload}\n`);
        }
        assert.equal(fs.readFileSync(path.join(backupDir, `backup-${selector}.manifest.json`), 'utf8'), `${JSON.stringify(manifest)}\n`);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a valid backup, When rollback selects version-hash, Then it restores the matching source set without changing package version', () => {
    const project = fixture();
    try {
        const expected = LIVE_FILES.map((file) => fs.readFileSync(path.join(project, file)));
        const digest = backupSelector(project);
        fs.writeFileSync(path.join(project, 'src', 'runtime.js'), 'new live runtime\n');
        const result = run(project, 'rollback.cjs', [`${VERSION}-${digest.slice(0, 8)}`]);
        assert.equal(result.status, 0, result.stderr);
        for (const [index, file] of LIVE_FILES.entries()) assert.deepEqual(fs.readFileSync(path.join(project, file)), expected[index]);
        assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version, VERSION);
        // Post-rollback proof for the new contract: a fresh backup of the
        // restored source set reproduces the original digest, so rollback is
        // byte-exact and the restored files are backup-consistent.
        const again = run(project, 'backup.cjs');
        assert.equal(again.status, 0, again.stderr);
        assert.equal(again.stdout.trim(), digest);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a tampered backup, When rollback runs, Then it fails before changing live files', () => {
    const project = fixture();
    try {
        const digest = backupSelector(project); const selector = `${VERSION}-${digest.slice(0, 8)}`;
        const before = liveHashes(project);
        fs.appendFileSync(path.join(project, 'backups', `runtime-${selector}.js`), 'tamper');
        const result = run(project, 'rollback.cjs', [selector]);
        assert.notEqual(result.status, 0); assert.deepEqual(liveHashes(project), before);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

for (const kind of ['runtime', 'config', 'metadata', 'moduleManifest']) {
    for (const operation of ['append', 'truncate']) test(`Given a ${kind} payload with ${operation} corruption, When rollback runs, Then live files remain unchanged`, () => {
        const project = fixture();
        try { const { selector, dir } = selectorInfo(project); const payload = path.join(dir, payloadName(kind, selector)); if (operation === 'append') fs.appendFileSync(payload, 'x'); else fs.writeFileSync(payload, fs.readFileSync(payload).subarray(0, Math.floor(fs.statSync(payload).size / 2))); unchangedFailure(project, [selector]); }
        finally { fs.rmSync(project, { recursive: true, force: true }); }
    });
    test(`Given a ${kind} sidecar with bad hex, When rollback runs, Then live files remain unchanged`, () => {
        const project = fixture();
        try { const { selector, dir } = selectorInfo(project); fs.writeFileSync(path.join(dir, `${payloadName(kind, selector)}.sha256`), `not-a-digest  ${payloadName(kind, selector)}\n`); unchangedFailure(project, [selector]); }
        finally { fs.rmSync(project, { recursive: true, force: true }); }
    });
    test(`Given a ${kind} sidecar with a wrong filename, When rollback runs, Then live files remain unchanged`, () => {
        const project = fixture();
        try { const { selector, dir } = selectorInfo(project); const sidecar = path.join(dir, `${payloadName(kind, selector)}.sha256`); fs.writeFileSync(sidecar, fs.readFileSync(sidecar, 'utf8').replace(payloadName(kind, selector), 'wrong-name')); unchangedFailure(project, [selector]); }
        finally { fs.rmSync(project, { recursive: true, force: true }); }
    });
}

test('Given a missing named sidecar, When rollback runs, Then live files remain unchanged', () => {
    const project = fixture();
    try { const { selector, dir } = selectorInfo(project); fs.rmSync(path.join(dir, `${payloadName('metadata', selector)}.sha256`)); unchangedFailure(project, [selector]); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
});

for (const mutation of ['schemaVersion', 'version', 'releaseId', 'selector', 'path', 'digest', 'runtimeSha256']) test(`Given a manifest with corrupt ${mutation}, When rollback runs, Then live files remain unchanged`, () => {
    const project = fixture();
    try {
        const { selector, dir } = selectorInfo(project); const manifestPath = path.join(dir, `backup-${selector}.manifest.json`); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (mutation === 'schemaVersion') manifest.schemaVersion = 2; else if (mutation === 'version') manifest.version = '6.1.1'; else if (mutation === 'releaseId') manifest.releaseId = 'taa-6.1.1'; else if (mutation === 'selector') manifest.selector = '6.1.1-deadbeef'; else if (mutation === 'path') manifest.files.runtime.path = '../runtime.js'; else if (mutation === 'digest') manifest.files.metadata.sha256 = '0'.repeat(64); else manifest.runtimeSha256 = '0'.repeat(64);
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`); unchangedFailure(project, [selector]);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

for (const kind of ['runtime', 'config', 'metadata', 'moduleManifest']) test(`Given backup copy failure for ${kind}, When backup runs, Then no selector files are published`, () => {
    const project = fixture();
    try { const result = run(project, 'backup.cjs', [], { TAA_FAIL_COPY: kind }); assert.notEqual(result.status, 0); const files = fs.existsSync(path.join(project, 'backups')) ? fs.readdirSync(path.join(project, 'backups')) : []; assert.equal(files.length, 0); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
});

for (const kind of ['runtime', 'config', 'metadata', 'moduleManifest']) {
    test(`Given backup staged-readback failure for ${kind}, When backup runs, Then no selector files are published`, () => {
        const project = fixture();
        try { const result = run(project, 'backup.cjs', [], { TAA_FAIL_STAGED_READBACK: kind }); assert.notEqual(result.status, 0); assert.equal(fs.readdirSync(path.join(project, 'backups')).length, 0); }
        finally { fs.rmSync(project, { recursive: true, force: true }); }
    });
    test(`Given rollback staged-readback failure for ${kind}, When rollback runs, Then live files remain unchanged`, () => {
        const project = fixture();
        try { const { selector } = selectorInfo(project); unchangedFailure(project, [selector], { TAA_FAIL_STAGED_READBACK: kind }); }
        finally { fs.rmSync(project, { recursive: true, force: true }); }
    });
}

for (const missing of ['metadata.json', 'src/runtime.js']) test(`Given missing live ${missing}, When rollback runs, Then validated backup restores the complete source set`, () => {
    const project = fixture();
    try { const { selector, digest, dir } = selectorInfo(project); fs.rmSync(path.join(project, missing)); const result = run(project, 'rollback.cjs', [selector]); assert.equal(result.status, 0, result.stderr); assert.deepEqual(liveHashes(project), [digest, hash(path.join(dir, payloadName('config', selector))), hash(path.join(dir, payloadName('metadata', selector))), hash(path.join(dir, payloadName('moduleManifest', selector)))]); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
});

for (const failure of [
    ...['runtime', 'config', 'metadata', 'moduleManifest'].map((kind) => ({ name: `swap-${kind}`, env: { TAA_FAIL_SWAP: kind } })),
    { name: 'phase-prepared', env: { TAA_FAIL_PHASE: 'prepared' } }, { name: 'phase-old-moved', env: { TAA_FAIL_PHASE: 'old-moved' } }, { name: 'phase-target-moved', env: { TAA_FAIL_PHASE: 'target-moved' } }
]) test(`Given ${failure.name}, When rollback fails, Then startup recovery restores the original source set`, () => {
    const project = fixture();
    try { const { selector } = selectorInfo(project); const before = liveHashes(project); const failed = run(project, 'rollback.cjs', [selector], failure.env); assert.notEqual(failed.status, 0); const recovered = run(project, 'rollback.cjs', ['bad']); assert.notEqual(recovered.status, 0); assert.deepEqual(liveHashes(project), before); assert.equal(fs.readdirSync(path.join(project, 'backups')).filter((name) => /^\.rollback-journal-/.test(name)).length, 0); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a current-version backup, When rollback receives bare hash8, Then it selects the current package version', () => {
    const project = fixture();
    try { const { digest } = selectorInfo(project); fs.writeFileSync(path.join(project, 'src', 'runtime.js'), 'changed'); const result = run(project, 'rollback.cjs', [digest.slice(0, 8)]); assert.equal(result.status, 0, result.stderr); assert.equal(hash(path.join(project, 'src', 'runtime.js')), digest); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a swap failure, When rollback starts again, Then startup recovery restores the original matching source set', () => {
    const project = fixture();
    try {
        const digest = backupSelector(project); const before = liveHashes(project);
        const failed = run(project, 'rollback.cjs', [`${VERSION}-${digest.slice(0, 8)}`], { TAA_FAIL_PHASE: 'target-moved' });
        assert.notEqual(failed.status, 0);
        const recovered = run(project, 'rollback.cjs', ['bad']);
        assert.notEqual(recovered.status, 0); assert.deepEqual(liveHashes(project), before);
        assert.equal(fs.readdirSync(path.join(project, 'backups')).filter((name) => name.includes('rollback-journal')).length, 0);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a crash after one old move, When rollback starts again, Then recovery restores the original source set', () => {
    const project = fixture();
    try {
        const { selector } = selectorInfo(project); const before = liveHashes(project);
        const crashed = run(project, 'rollback.cjs', [selector], { TAA_CRASH_AFTER_OLD_MOVED: '1' }); assert.notEqual(crashed.status, 0);
        const recovered = run(project, 'rollback.cjs', ['bad']); assert.notEqual(recovered.status, 0); assert.deepEqual(liveHashes(project), before); assert.equal(fs.readdirSync(path.join(project, 'backups')).filter((name) => /^\.rollback-journal-/.test(name)).length, 0);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a crash after one target swap, When rollback starts again, Then recovery restores the original source set', () => {
    const project = fixture();
    try {
        const { selector, digest, dir } = selectorInfo(project); const before = liveHashes(project);
        const crashed = run(project, 'rollback.cjs', [selector], { TAA_CRASH_AFTER_SWAP: '1' }); assert.notEqual(crashed.status, 0);
        const recovered = run(project, 'rollback.cjs', [selector]); assert.equal(recovered.status, 0, recovered.stderr);
        assert.deepEqual(liveHashes(project), [digest, hash(path.join(dir, payloadName('config', selector))), hash(path.join(dir, payloadName('metadata', selector))), hash(path.join(dir, payloadName('moduleManifest', selector)))]); assert.equal(fs.readdirSync(dir).filter((name) => /^\.rollback-journal-/.test(name)).length, 0);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Given a missing live metadata file and a crash after one old move, When rollback restarts, Then recovery and retry restore the validated backup source set', () => {
    const project = fixture();
    try {
        const { selector, digest, dir } = selectorInfo(project); fs.rmSync(path.join(project, 'metadata.json'));
        const crashed = run(project, 'rollback.cjs', [selector], { TAA_CRASH_AFTER_OLD_MOVED: '1' }); assert.notEqual(crashed.status, 0);
        const recovered = run(project, 'rollback.cjs', [selector]); assert.equal(recovered.status, 0, recovered.stderr);
        assert.deepEqual(liveHashes(project), [digest, hash(path.join(dir, payloadName('config', selector))), hash(path.join(dir, payloadName('metadata', selector))), hash(path.join(dir, payloadName('moduleManifest', selector)))]); assert.equal(fs.readdirSync(dir).filter((name) => /^\.rollback-journal-/.test(name)).length, 0);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
