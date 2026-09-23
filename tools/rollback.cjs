'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const FALLBACK_VERSION = '1.0.0';
let RELEASE_VERSION = FALLBACK_VERSION;
try { RELEASE_VERSION = require(path.join(ROOT, 'package.json')).version || FALLBACK_VERSION; } catch {}

// Additive source/config schema (Todo 5): exact roots restored from the
// schemaVersion-2 manifest; anything else fails closed.
const SOURCE_CONFIG_ROOTS = ['src/', 'config/'];
const SOURCE_CONFIG_SCHEMA_VERSION = 2;

// Shared regular-file contract (Task 7) imported lazily from backup.cjs so
// backup and rollback can never drift; lstat-based and fail-closed.
function lstatRegularFile(target, rel, kind) {
    return require('./backup.cjs').lstatRegularFile(target, rel, kind);
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function fsync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDir() { const fd = fs.openSync(BACKUPS, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function journalWrite(file, journal) { const temp = `${file}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(journal)}\n`); fsync(temp); fs.renameSync(temp, file); syncDir(); }
function toPosix(p) { return p.split(path.sep).join('/'); }
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
/**
 * An interrupted source/config restore must fail closed: unlike the legacy
 * four-file journal (which self-heals on next startup), a half-restored
 * src//config/ tree is never auto-repaired — the operator inspects the
 * journal file, then removes it to retry after triage.
 */
function failOnStaleSourceConfigJournal() {
    if (!fs.existsSync(BACKUPS)) return;
    const stale = fs.readdirSync(BACKUPS).filter((entry) => /^\.rollback-source-config-[A-Za-z0-9_-]+\.json$/.test(entry));
    if (stale.length > 0) {
        throw new Error(`interrupted source/config restore pending inspection: ${stale[0]} (remove after triage to retry)`);
    }
}
function parseSelector(input) {
    const match = /^(\d+\.\d+\.\d+)-([0-9a-f]{8})$/.exec(input || '');
    if (match) return { version: match[1], hash8: match[2] };
    if (/^[0-9a-f]{8}$/.test(input || '')) return { version: RELEASE_VERSION, hash8: input };
    throw new Error('usage: node tools/rollback.cjs <version-hash8> (or <hash8>)');
}
/**
 * A bare hash8 resolves against the current package version only. If other
 * versions publish the same hash8 the selector is ambiguous and fails
 * closed — the caller must qualify with <version-hash8>.
 */
function rejectAmbiguousSelector(target) {
    if (!fs.existsSync(BACKUPS)) return;
    const names = fs.readdirSync(BACKUPS);
    const conflicts = names.filter((name) => {
        let m = new RegExp(`^(\\d+\\.\\d+\\.\\d+)-${target.hash8}\\.manifest\\.json$`).exec(name);
        if (m) return m[1] !== target.version;
        m = new RegExp(`^(\\d+\\.\\d+\\.\\d+)-${target.hash8}\\.source-config\\.manifest\\.json$`).exec(name);
        if (m) return m[1] !== target.version;
        return false;
    });
    if (conflicts.length > 0) {
        throw new Error(`ambiguous selector: hash8 ${target.hash8} matches multiple versions (${conflicts.join(', ')})`);
    }
}
function readSidecar(file, payload) {
    const line = fs.readFileSync(file, 'utf8'); const match = /^([0-9a-f]{64})  ([^\n]+)\n$/.exec(line);
    if (!match || match[2] !== path.basename(payload) || match[1] !== digest(payload)) throw new Error(`integrity mismatch: ${path.basename(payload)}`);
    return match[1];
}
function rollback(input) {
    recoverRollbackJournal();
    failOnStaleSourceConfigJournal();
    if (typeof input !== 'string' || input.includes('/') || input.includes('\\') || /[*?[\]{}!]/.test(input)) {
        throw new Error('usage: node tools/rollback.cjs <version-hash8> (or <hash8>)');
    }
    const target = parseSelector(input);
    rejectAmbiguousSelector(target);
    const selector = `${target.version}-${target.hash8}`; const dir = BACKUPS;
    const sourceConfigManifest = path.join(dir, `backup-${selector}.source-config.manifest.json`);
    if (fs.existsSync(sourceConfigManifest)) {
        rollbackSourceConfig(target, selector);
        return;
    }
    rollbackLegacy(target, selector, dir);
}
function rollbackLegacy(target, selector, dir) {
    const names = { runtime: `runtime-${selector}.js`, config: `config-${selector}.json`, metadata: `metadata-${selector}.json`, moduleManifest: `module-manifest-${selector}.json` };
    const manifestFile = path.join(dir, `backup-${selector}.manifest.json`); if (!fs.existsSync(manifestFile)) throw new Error(`backup manifest not found: ${manifestFile}`);
    if (lstatRegularFile(manifestFile, `backup-${selector}.manifest.json`, 'backup manifest') === null) throw new Error(`backup manifest not found: ${manifestFile}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); if (manifest.schemaVersion !== 1 || manifest.selector !== selector || manifest.version !== target.version || manifest.releaseId !== `taa-${target.version}`) throw new Error('backup manifest release mismatch');
    const files = {};
    for (const kind of Object.keys(names)) { const descriptor = manifest.files?.[kind]; if (!descriptor || descriptor.path !== names[kind] || path.basename(descriptor.path) !== descriptor.path || descriptor.path.includes('..')) throw new Error(`invalid manifest path: ${kind}`); const payload = path.join(dir, descriptor.path); const sidecar = `${payload}.sha256`; if (!fs.existsSync(payload) || !fs.existsSync(sidecar)) throw new Error(`backup payload missing: ${kind}`); if (lstatRegularFile(payload, descriptor.path) === null) throw new Error(`backup payload missing: ${kind}`); if (lstatRegularFile(sidecar, `${descriptor.path}.sha256`, 'backup sidecar') === null) throw new Error(`backup sidecar missing: ${kind}`); const sideHash = readSidecar(sidecar, payload); if (sideHash !== descriptor.sha256) throw new Error(`manifest digest mismatch: ${kind}`); files[kind] = payload; }
    if (manifest.runtimeSha256 !== digest(files.runtime)) throw new Error('manifest runtime digest mismatch');
    const metadata = JSON.parse(fs.readFileSync(files.metadata, 'utf8')); const moduleManifest = JSON.parse(fs.readFileSync(files.moduleManifest, 'utf8')); const config = JSON.parse(fs.readFileSync(files.config, 'utf8'));
    if (metadata.release?.version !== target.version || metadata.release.releaseId !== `taa-${target.version}` || metadata.artifact?.path !== 'dist/travian-attack-alert.user.js' || metadata.artifact?.source?.path !== 'src/userscript-entry.js') throw new Error('metadata release or artifact mismatch');
    if (moduleManifest.release?.version !== target.version || moduleManifest.release.releaseId !== `taa-${target.version}`) throw new Error('module manifest release mismatch');
    if (typeof config.name !== 'string' || !Array.isArray(config.match) || config.version !== undefined) throw new Error('config release mismatch');
    const nonce = `${Date.now().toString(36)}-${process.pid}`; const journalFile = path.join(dir, `.rollback-journal-${nonce}.json`); const liveNames = { runtime: path.join('src', 'runtime.js'), config: path.join('config', 'userscript.json'), metadata: 'metadata.json', moduleManifest: 'module-manifest.json' }; const kinds = Object.keys(liveNames);
    const extensions = { runtime: 'js', config: 'json', metadata: 'json', moduleManifest: 'json' };
    const entries = kinds.map((kind) => { const livePath = path.join(ROOT, liveNames[kind]); const liveExisted = fs.existsSync(livePath); return { livePath, tempPath: path.join(dir, `.rollback-stage-${nonce}-${kind}.${extensions[kind]}`), previousPath: path.join(dir, `.rollback-previous-${nonce}-${kind}`), liveExisted, originalSha256: liveExisted ? digest(livePath) : null, targetSha256: digest(files[kind]), oldMoved: false, targetMoved: false }; });
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
function isValidSourceConfigPath(rel) {
    if (typeof rel !== 'string' || rel.length === 0) return false;
    if (path.posix.isAbsolute(rel) || rel.includes('\\')) return false;
    const parts = rel.split('/');
    if (parts.includes('') || parts.includes('.') || parts.includes('..')) return false;
    return rel.startsWith('src/') || rel.startsWith('config/');
}
function resolveInside(rootAbs, rel) {
    const resolved = path.resolve(rootAbs, rel);
    if (resolved !== rootAbs && !resolved.startsWith(`${rootAbs}${path.sep}`)) {
        throw new Error(`path escapes root: ${rel}`);
    }
    return resolved;
}
function walkLiveSourceConfig() {
    // lstat walk: never follows symlinks; any symlink fails closed.
    const found = [];
    for (const rootEntry of SOURCE_CONFIG_ROOTS) {
        const name = rootEntry.slice(0, -1);
        const abs = path.join(ROOT, name);
        let st = null;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) throw new Error(`rollback live symlink at root: ${rootEntry}`);
        if (!st.isDirectory()) throw new Error(`rollback live root is not a directory: ${rootEntry}`);
        const visit = (dirAbs) => {
            const dirents = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const ent of dirents) {
                const childAbs = path.join(dirAbs, ent.name);
                if (ent.isSymbolicLink()) {
                    throw new Error(`rollback live symlink not allowed: ${toPosix(path.relative(ROOT, childAbs))}`);
                }
                if (ent.isDirectory()) visit(childAbs);
                else if (ent.isFile()) found.push(toPosix(path.relative(ROOT, childAbs)));
                else throw new Error(`rollback live unsupported entry: ${toPosix(path.relative(ROOT, childAbs))}`);
            }
        };
        visit(abs);
    }
    return found.sort();
}
function rollbackSourceConfig(target, selector) {
    const dir = BACKUPS;
    const manifestFile = path.join(dir, `backup-${selector}.source-config.manifest.json`);
    if (lstatRegularFile(manifestFile, path.basename(manifestFile), 'backup manifest') === null) throw new Error(`backup manifest not found: ${manifestFile}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.schemaVersion !== SOURCE_CONFIG_SCHEMA_VERSION
        || manifest.selector !== selector
        || manifest.version !== target.version
        || manifest.releaseId !== `taa-${target.version}`) {
        throw new Error('backup manifest release mismatch');
    }
    if (JSON.stringify(manifest.roots) !== JSON.stringify(SOURCE_CONFIG_ROOTS)) {
        throw new Error('backup manifest roots mismatch');
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('backup manifest has no files');
    if (typeof manifest.payloadDir !== 'string' || manifest.payloadDir.length === 0) throw new Error('backup manifest payload dir mismatch');
    const payloadRoot = resolveInside(dir, manifest.payloadDir);
    let payloadRootStat = null;
    try { payloadRootStat = fs.lstatSync(payloadRoot); } catch { throw new Error('backup payload dir missing'); }
    if (!payloadRootStat.isDirectory() || payloadRootStat.isSymbolicLink()) throw new Error('backup payload dir is not a directory');
    const seen = new Set();
    let previous = null;
    for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
            throw new Error('backup manifest entry is malformed');
        }
        if (!isValidSourceConfigPath(entry.path)) throw new Error(`invalid manifest path: ${entry.path}`);
        if (seen.has(entry.path)) throw new Error(`duplicate manifest entry: ${entry.path}`);
        seen.add(entry.path);
        if (previous !== null && previous >= entry.path) throw new Error('backup manifest files are not sorted unique');
        previous = entry.path;
    }
    // Verify every payload (content + sidecar) before touching live files.
    const payloads = manifest.files.map((entry) => {
        const payload = resolveInside(payloadRoot, entry.path);
        if (lstatRegularFile(payload, entry.path) === null) throw new Error(`backup payload missing: ${entry.path}`);
        const sidecar = `${payload}.sha256`;
        if (lstatRegularFile(sidecar, `${entry.path}.sha256`, 'backup sidecar') === null) throw new Error(`backup sidecar missing: ${entry.path}`);
        let line = null;
        try { line = fs.readFileSync(sidecar, 'utf8'); } catch { throw new Error(`backup sidecar missing: ${entry.path}`); }
        const match = /^([0-9a-f]{64})  ([^\n]+)\n$/.exec(line);
        if (!match || match[2] !== entry.path || match[1] !== entry.sha256) {
            throw new Error(`backup sidecar mismatch: ${entry.path}`);
        }
        if (digest(payload) !== entry.sha256) throw new Error(`manifest digest mismatch: ${entry.path}`);
        return { rel: entry.path, payload, sha256: entry.sha256 };
    });
    // Live tree must be symlink-free before restore.
    walkLiveSourceConfig();
    const nonce = `${Date.now().toString(36)}-${process.pid}`;
    const journalFile = path.join(dir, `.rollback-source-config-${nonce}.json`);
    const journal = { schemaVersion: SOURCE_CONFIG_SCHEMA_VERSION, nonce, phase: 'prepared', target, selector, files: manifest.files.map((f) => f.path), createdAt: new Date().toISOString() };
    journalWrite(journalFile, journal);
    const crashAfter = Number(process.env.TAA_CRASH_AFTER_SOURCE_CONFIG_WRITES);
    try {
        let written = 0;
        for (const item of payloads) {
            const livePath = resolveInside(ROOT, item.rel);
            if (!livePath.startsWith(`${path.join(ROOT, 'src')}${path.sep}`) && !livePath.startsWith(`${path.join(ROOT, 'config')}${path.sep}`)) {
                throw new Error(`restore target outside source/config: ${item.rel}`);
            }
            fs.mkdirSync(path.dirname(livePath), { recursive: true });
            fs.copyFileSync(item.payload, livePath);
            fsync(livePath);
            if (digest(livePath) !== item.sha256) throw new Error(`staged readback mismatch: ${item.rel}`);
            written += 1;
            journal.phase = 'target-moved';
            journalWrite(journalFile, journal);
            if (Number.isFinite(crashAfter) && crashAfter > 0 && written >= crashAfter) {
                throw new Error(`injected crash: source-config-writes-${written}`);
            }
        }
        // Remove only files under src//config/ that the snapshot does not
        // carry. Resolution is re-checked per file: anything escaping the
        // two roots fails closed instead of deleting out-of-root.
        const wanted = new Set(payloads.map((p) => p.rel));
        for (const rel of walkLiveSourceConfig()) {
            if (wanted.has(rel)) continue;
            const candidate = resolveInside(ROOT, rel);
            const srcRoot = `${path.join(ROOT, 'src')}${path.sep}`;
            const configRoot = `${path.join(ROOT, 'config')}${path.sep}`;
            if (!candidate.startsWith(srcRoot) && !candidate.startsWith(configRoot)) {
                throw new Error(`refusing out-of-root delete: ${rel}`);
            }
            fs.rmSync(candidate, { force: true });
        }
        // Post-restore hash equality over the exact source/config set.
        const { inventorySourceConfig, sourceConfigDigest } = require('./backup.cjs');
        const actual = sourceConfigDigest(inventorySourceConfig(ROOT));
        if (actual !== manifest.sourceConfigSha256) {
            throw new Error('post-restore source/config hash mismatch');
        }
        // Regenerate metadata/manifest/dist from the restored authority.
        require('./build.cjs').build();
        journal.phase = 'verified';
        journalWrite(journalFile, journal);
        fs.rmSync(journalFile);
        syncDir();
    } catch (error) {
        // Journal stays on disk: the next rollback fails closed until the
        // interrupted restore is triaged (failOnStaleSourceConfigJournal).
        throw error;
    }
}

if (require.main === module) rollback(process.argv[2]);

module.exports = { rollback, recoverRollbackJournal };
