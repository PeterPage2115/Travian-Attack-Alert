'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const FALLBACK_VERSION = '6.2.1';
let RELEASE_VERSION = FALLBACK_VERSION;
try { RELEASE_VERSION = require(path.join(ROOT, 'package.json')).version || FALLBACK_VERSION; } catch {}

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fsyncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fsyncDir() { const fd = fs.openSync(BACKUPS, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file, value) { const temporary = `${file}.tmp`; fs.writeFileSync(temporary, value); fsyncFile(temporary); fs.renameSync(temporary, file); fsyncDir(); }
function recoverRollbackJournal() { return require('./rollback.cjs').recoverRollbackJournal(); }
function backup() {
    recoverRollbackJournal();
    const sources = { script: path.join(ROOT, 'script.txt'), metadata: path.join(ROOT, 'metadata.json'), moduleManifest: path.join(ROOT, 'module-manifest.json') };
    const hashes = Object.fromEntries(Object.entries(sources).map(([kind, file]) => [kind, digest(file)]));
    const metadata = JSON.parse(fs.readFileSync(sources.metadata, 'utf8')); const moduleManifest = JSON.parse(fs.readFileSync(sources.moduleManifest, 'utf8'));
    if (metadata.release?.version !== RELEASE_VERSION || metadata.release.releaseId !== `taa-${RELEASE_VERSION}` || metadata.artifact?.path !== 'script.txt' || metadata.artifact.sha256 !== hashes.script) throw new Error('backup source metadata does not match artifact/release');
    if (moduleManifest.release?.version !== RELEASE_VERSION || moduleManifest.release.releaseId !== `taa-${RELEASE_VERSION}`) throw new Error('backup source module manifest does not match release');
    const hash8 = hashes.script.slice(0, 8); const selector = `${RELEASE_VERSION}-${hash8}`;
    const names = { script: `script-${selector}.txt`, metadata: `metadata-${selector}.json`, moduleManifest: `module-manifest-${selector}.json` };
    fs.mkdirSync(BACKUPS, { recursive: true });
    const temporary = {};
    try {
        for (const [kind, source] of Object.entries(sources)) { if (process.env.TAA_FAIL_COPY === kind) throw new Error(`injected failure: copy-${kind}`); temporary[kind] = path.join(BACKUPS, `.backup-${selector}-${kind}.tmp`); fs.copyFileSync(source, temporary[kind]); if (process.env.TAA_FAIL_STAGED_READBACK === kind || digest(temporary[kind]) !== hashes[kind]) throw new Error(`backup readback mismatch: ${kind}`); }
        const manifest = { schemaVersion: 1, version: RELEASE_VERSION, releaseId: `taa-${RELEASE_VERSION}`, selector, files: {}, artifactSha256: hashes.script };
        for (const kind of Object.keys(names)) { manifest.files[kind] = { path: names[kind], sha256: hashes[kind] }; }
        const sidecars = {};
        for (const [kind, name] of Object.entries(names)) { const target = path.join(BACKUPS, name); fs.renameSync(temporary[kind], target); fsyncFile(target); sidecars[kind] = `${target}.sha256`; atomicWrite(sidecars[kind], `${hashes[kind]}  ${name}\n`); }
        const manifestPath = path.join(BACKUPS, `backup-${selector}.manifest.json`); const manifestBytes = `${JSON.stringify(manifest)}\n`; atomicWrite(manifestPath, manifestBytes); if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) throw new Error(`backup integrity readback mismatch: ${manifestPath}`);
        for (const file of Object.values(sidecars)) { const expected = `${hashes[Object.keys(sidecars).find((kind) => sidecars[kind] === file)]}  ${path.basename(file, '.sha256')}\n`; if (fs.readFileSync(file, 'utf8') !== expected) throw new Error(`backup integrity readback mismatch: ${file}`); }
        fsyncDir(); process.stdout.write(`${hashes.script}\n`);
    } finally { for (const file of Object.values(temporary)) fs.rmSync(file, { force: true }); }
}

if (require.main === module) backup();

module.exports = { backup, digest, recoverRollbackJournal };
