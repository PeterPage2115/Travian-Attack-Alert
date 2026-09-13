'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const FALLBACK_VERSION = '1.0.0';
let RELEASE_VERSION = FALLBACK_VERSION;
try { RELEASE_VERSION = require(path.join(ROOT, 'package.json')).version || FALLBACK_VERSION; } catch {}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fsync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDir() { const fd = fs.openSync(BACKUPS, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function journalWrite(file, journal) { const temp = `${file}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(journal)}\n`); fsync(temp); fs.renameSync(temp, file); syncDir(); }
function recoverRollbackJournal() {
    if (!fs.existsSync(BACKUPS)) return;
    for (const name of fs.readdirSync(BACKUPS).filter((entry) => /^\.rollback-journal-[A-Za-z0-9_-]+\.json$/.test(entry))) {
        const file = path.join(BACKUPS, name); const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (journal.phase !== 'verified') {
            for (const entry of journal.entries) {
                if (entry.targetMoved) fs.rmSync(entry.livePath, { force: true });
                if (entry.oldMoved && fs.existsSync(entry.previousPath)) fs.renameSync(entry.previousPath, entry.livePath);
                fs.rmSync(entry.tempPath, { force: true });
            }
        }
        fs.rmSync(file, { force: true }); syncDir();
    }
}
function parseSelector(input) {
    const match = /^(\d+\.\d+\.\d+)-([0-9a-f]{8})$/.exec(input || '');
    if (match) return { version: match[1], hash8: match[2] };
    if (/^[0-9a-f]{8}$/.test(input || '')) return { version: RELEASE_VERSION, hash8: input };
    throw new Error('usage: node tools/rollback.cjs <version-hash8> (or <hash8>)');
}
function readSidecar(file, payload) {
    const line = fs.readFileSync(file, 'utf8'); const match = /^([0-9a-f]{64})  ([^\n]+)\n$/.exec(line);
    if (!match || match[2] !== path.basename(payload) || match[1] !== digest(payload)) throw new Error(`integrity mismatch: ${path.basename(payload)}`);
    return match[1];
}
function rollback(input) {
    recoverRollbackJournal();
    const target = parseSelector(input); const selector = `${target.version}-${target.hash8}`; const dir = BACKUPS;
    const names = { script: `script-${selector}.txt`, metadata: `metadata-${selector}.json`, moduleManifest: `module-manifest-${selector}.json` };
    const manifestFile = path.join(dir, `backup-${selector}.manifest.json`); if (!fs.existsSync(manifestFile)) throw new Error(`backup manifest not found: ${manifestFile}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (manifest.schemaVersion !== 1 || manifest.selector !== selector || manifest.version !== target.version || manifest.releaseId !== `taa-${target.version}`) throw new Error('backup manifest release mismatch');
    const files = {};
    for (const kind of Object.keys(names)) { const descriptor = manifest.files?.[kind]; if (!descriptor || descriptor.path !== names[kind] || path.basename(descriptor.path) !== descriptor.path || descriptor.path.includes('..')) throw new Error(`invalid manifest path: ${kind}`); const payload = path.join(dir, descriptor.path); const sidecar = `${payload}.sha256`; if (!fs.existsSync(payload) || !fs.existsSync(sidecar)) throw new Error(`backup payload missing: ${kind}`); const sideHash = readSidecar(sidecar, payload); if (sideHash !== descriptor.sha256) throw new Error(`manifest digest mismatch: ${kind}`); files[kind] = payload; }
    if (manifest.artifactSha256 !== digest(files.script)) throw new Error('manifest artifact digest mismatch');
    const metadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8')); const moduleManifest = JSON.parse(fs.readFileSync(files.moduleManifest, 'utf8'));
    if (metadata.release?.version !== target.version || metadata.release.releaseId !== `taa-${target.version}` || metadata.artifact?.path !== 'script.txt' || metadata.artifact.sha256 !== digest(files.script)) throw new Error('metadata release or artifact mismatch');
    if (moduleManifest.release?.version !== target.version || moduleManifest.release.releaseId !== `taa-${target.version}`) throw new Error('module manifest release mismatch');
    const nonce = `${Date.now().toString(36)}-${process.pid}`; const journalFile = path.join(dir, `.rollback-journal-${nonce}.json`); const liveNames = { script: 'script.txt', metadata: 'metadata.json', moduleManifest: 'module-manifest.json' }; const kinds = Object.keys(liveNames);
    const entries = kinds.map((kind) => { const livePath = path.join(ROOT, liveNames[kind]); const liveExisted = fs.existsSync(livePath); return { livePath, tempPath: path.join(dir, `.rollback-stage-${nonce}-${kind}.${kind === 'script' ? 'txt' : 'json'}`), previousPath: path.join(dir, `.rollback-previous-${nonce}-${kind}`), liveExisted, originalSha256: liveExisted ? digest(livePath) : null, targetSha256: digest(files[kind]), oldMoved: false, targetMoved: false }; });
    const journal = { schemaVersion: 1, nonce, phase: 'prepared', target, entries, createdAt: new Date().toISOString() }; try { for (const [index, kind] of kinds.entries()) { const entry = entries[index]; fs.copyFileSync(files[kind], entry.tempPath); fsync(entry.tempPath); if (process.env.TAA_FAIL_STAGED_READBACK === kind || digest(entry.tempPath) !== entry.targetSha256) throw new Error(`staged readback mismatch: ${kind}`); } } catch (error) { for (const entry of entries) fs.rmSync(entry.tempPath, { force: true }); throw error; } journalWrite(journalFile, journal);
    try {
        if (process.env.TAA_FAIL_PHASE === 'prepared') throw new Error('injected failure: prepared');
        let movedOld = 0;
        for (const entry of entries) {
            if (entry.liveExisted) { fs.renameSync(entry.livePath, entry.previousPath); entry.oldMoved = true; movedOld += 1; }
            journal.phase = 'old-moved'; journalWrite(journalFile, journal);
            if (Number(process.env.TAA_CRASH_AFTER_OLD_MOVED) === movedOld && movedOld > 0) throw new Error(`injected crash: old-moved-${movedOld}`);
        }
        if (process.env.TAA_FAIL_PHASE === 'old-moved') throw new Error('injected failure: old-moved');
        let movedTarget = 0;
        for (const [index, entry] of entries.entries()) {
            if (process.env.TAA_FAIL_SWAP === kinds[index]) throw new Error(`injected failure: swap-${kinds[index]}`);
            fs.renameSync(entry.tempPath, entry.livePath); entry.targetMoved = true; movedTarget += 1;
            journal.phase = 'target-moved'; journalWrite(journalFile, journal);
            if (Number(process.env.TAA_CRASH_AFTER_SWAP) === movedTarget) throw new Error(`injected crash: swap-${movedTarget}`);
        }
        if (process.env.TAA_FAIL_PHASE === 'target-moved') throw new Error('injected failure: target-moved');
        for (const entry of entries) if (digest(entry.livePath) !== entry.targetSha256) throw new Error(`target readback mismatch: ${entry.livePath}`);
        journal.phase = 'verified'; journalWrite(journalFile, journal); for (const entry of entries) fs.rmSync(entry.previousPath, { force: true }); fs.rmSync(journalFile); syncDir();
    } catch (error) { throw error; }
}

if (require.main === module) rollback(process.argv[2]);

module.exports = { rollback, recoverRollbackJournal };
