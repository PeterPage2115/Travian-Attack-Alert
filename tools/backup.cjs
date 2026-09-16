'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const FALLBACK_VERSION = '1.0.0';
let RELEASE_VERSION = FALLBACK_VERSION;
try { RELEASE_VERSION = require(path.join(ROOT, 'package.json')).version || FALLBACK_VERSION; } catch {}

// Additive source/config schema (Todo 5): exact roots under inventory.
const SOURCE_CONFIG_ROOTS = ['src/', 'config/'];
const SOURCE_CONFIG_SCHEMA_VERSION = 2;

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fsyncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fsyncDir() { const fd = fs.openSync(BACKUPS, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file, value) { const temporary = `${file}.tmp`; fs.writeFileSync(temporary, value); fsyncFile(temporary); fs.renameSync(temporary, file); fsyncDir(); }
function recoverRollbackJournal() { return require('./rollback.cjs').recoverRollbackJournal(); }

/**
 * Inventory every regular non-symlink file under the exact roots src/ and
 * config/. Any symlink (file, dir, or root itself) fails closed — a symlink
 * could escape the snapshot on restore, so it must never be backed up.
 * Returns sorted [{rel, sha256}] with posix relative paths.
 */
function inventorySourceConfig(root = ROOT) {
    const entries = [];
    for (const rootEntry of SOURCE_CONFIG_ROOTS) {
        const name = rootEntry.endsWith('/') ? rootEntry.slice(0, -1) : rootEntry;
        const abs = path.join(root, name);
        let st = null;
        try { st = fs.lstatSync(abs); } catch { throw new Error(`backup inventory missing root: ${rootEntry}`); }
        if (st.isSymbolicLink()) throw new Error(`backup inventory symlink at root: ${rootEntry}`);
        if (!st.isDirectory()) throw new Error(`backup inventory root is not a directory: ${rootEntry}`);
        const visit = (dirAbs) => {
            const dirents = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const ent of dirents) {
                const childAbs = path.join(dirAbs, ent.name);
                if (ent.isSymbolicLink()) {
                    throw new Error(`backup inventory symlink not allowed: ${toPosix(path.relative(root, childAbs))}`);
                }
                if (ent.isDirectory()) {
                    visit(childAbs);
                } else if (ent.isFile()) {
                    const rel = toPosix(path.relative(root, childAbs));
                    if (!rel.startsWith(`${name}/`)) throw new Error(`backup inventory escaped root: ${rel}`);
                    entries.push({ rel, sha256: digest(childAbs) });
                } else {
                    throw new Error(`backup inventory unsupported entry: ${toPosix(path.relative(root, childAbs))}`);
                }
            }
        };
        visit(abs);
    }
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const seen = new Set();
    for (const entry of entries) {
        if (seen.has(entry.rel)) throw new Error(`backup inventory duplicate entry: ${entry.rel}`);
        seen.add(entry.rel);
    }
    if (entries.length === 0) throw new Error('backup inventory is empty');
    return entries;
}

function toPosix(p) { return p.split(path.sep).join('/'); }

/** Canonical digest over the sorted inventory: `<path>:<sha256>\n` lines. */
function sourceConfigDigest(entries) {
    return crypto.createHash('sha256').update(entries.map((e) => `${e.rel}:${e.sha256}\n`).join('')).digest('hex');
}

function sourceConfigNames(selector) {
    return {
        manifestName: `backup-${selector}.source-config.manifest.json`,
        payloadDirName: `source-config-${selector}`,
    };
}

function stageSourceConfigPayloads(selector, entries) {
    const { payloadDirName } = sourceConfigNames(selector);
    const stageDir = path.join(BACKUPS, `.source-config-${selector}.tmp`);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    try {
        for (const entry of entries) {
            if (process.env.TAA_FAIL_COPY === 'source-config') throw new Error('injected failure: copy-source-config');
            const target = path.join(stageDir, entry.rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(ROOT, entry.rel), target);
            if (process.env.TAA_FAIL_STAGED_READBACK === 'source-config' || digest(target) !== entry.sha256) {
                throw new Error(`backup readback mismatch: ${entry.rel}`);
            }
            atomicWriteStageSidecar(stageDir, entry);
        }
    } catch (error) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        throw error;
    }
    return stageDir;
}

function atomicWriteStageSidecar(stageDir, entry) {
    const sidecar = path.join(stageDir, `${entry.rel}.sha256`);
    fs.writeFileSync(sidecar, `${entry.sha256}  ${entry.rel}\n`);
    fsyncFile(sidecar);
}

function manifestsEquivalentIgnoringTimestamp(a, b) {
    const strip = (m) => ({ ...m, createdAt: undefined });
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function commitSourceConfigPayloads(selector, stageDir, entries, manifest) {
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    const payloadDir = path.join(BACKUPS, payloadDirName);
    const manifestPath = path.join(BACKUPS, manifestName);
    if (fs.existsSync(payloadDir) || fs.existsSync(manifestPath)) {
        // Never rewrite an old backup payload: re-publishing the identical
        // source/config set (e.g. backup after a byte-exact rollback) is an
        // idempotent no-op; anything else fails closed.
        let identical = false;
        try {
            const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            identical = manifestsEquivalentIgnoringTimestamp(existing, manifest)
                && Array.isArray(existing.files)
                && existing.files.every((f) => {
                    const live = path.join(payloadDir, f.path);
                    return fs.statSync(live).isFile() && digest(live) === f.sha256;
                });
        } catch {
            identical = false;
        }
        fs.rmSync(stageDir, { recursive: true, force: true });
        if (!identical) throw new Error(`backup selector already published: ${selector}`);
        return { manifestPath, payloadDir };
    }
    fs.renameSync(stageDir, payloadDir);
    try {
        for (const entry of entries) fsyncFile(path.join(payloadDir, entry.rel));
        const manifestBytes = `${JSON.stringify(manifest)}\n`;
        atomicWrite(manifestPath, manifestBytes);
        if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) {
            throw new Error(`backup integrity readback mismatch: ${manifestName}`);
        }
        fsyncDir();
    } catch (error) {
        fs.rmSync(payloadDir, { recursive: true, force: true });
        fs.rmSync(manifestPath, { force: true });
        throw error;
    }
    return { manifestPath, payloadDir };
}

function removePublishedSelector(selector) {
    const legacy = [
        `runtime-${selector}.js`, `config-${selector}.json`, `metadata-${selector}.json`, `module-manifest-${selector}.json`,
        `runtime-${selector}.js.sha256`, `config-${selector}.json.sha256`, `metadata-${selector}.json.sha256`, `module-manifest-${selector}.json.sha256`,
        `backup-${selector}.manifest.json`,
    ];
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    for (const name of legacy) fs.rmSync(path.join(BACKUPS, name), { force: true });
    fs.rmSync(path.join(BACKUPS, payloadDirName), { recursive: true, force: true });
    fs.rmSync(path.join(BACKUPS, manifestName), { force: true });
}

function backup() {
    recoverRollbackJournal();
    // Inventory first: a symlink/traversal failure publishes nothing.
    const sourceConfigEntries = inventorySourceConfig(ROOT);
    const sourceConfigSha256 = sourceConfigDigest(sourceConfigEntries);
    const sources = { runtime: path.join(ROOT, 'src', 'runtime.js'), config: path.join(ROOT, 'config', 'userscript.json'), metadata: path.join(ROOT, 'metadata.json'), moduleManifest: path.join(ROOT, 'module-manifest.json') };
    const hashes = Object.fromEntries(Object.entries(sources).map(([kind, file]) => [kind, digest(file)]));
    const metadata = JSON.parse(fs.readFileSync(sources.metadata, 'utf8')); const moduleManifest = JSON.parse(fs.readFileSync(sources.moduleManifest, 'utf8')); const config = JSON.parse(fs.readFileSync(sources.config, 'utf8'));
    if (metadata.release?.version !== RELEASE_VERSION || metadata.release.releaseId !== `taa-${RELEASE_VERSION}` || metadata.artifact?.path !== 'dist/travian-attack-alert.user.js' || metadata.artifact?.source?.path !== 'src/userscript-entry.js') throw new Error('backup source metadata does not match artifact/release');
    if (moduleManifest.release?.version !== RELEASE_VERSION || moduleManifest.release.releaseId !== `taa-${RELEASE_VERSION}`) throw new Error('backup source module manifest does not match release');
    if (typeof config.name !== 'string' || !Array.isArray(config.match) || config.version !== undefined) throw new Error('backup source config does not match the version-owned contract');
    const hash8 = hashes.runtime.slice(0, 8); const selector = `${RELEASE_VERSION}-${hash8}`;
    const names = { runtime: `runtime-${selector}.js`, config: `config-${selector}.json`, metadata: `metadata-${selector}.json`, moduleManifest: `module-manifest-${selector}.json` };
    fs.mkdirSync(BACKUPS, { recursive: true });
    // Stage the additive source/config payloads before any legacy file is
    // published, so a staging failure leaves the backups tree untouched.
    const stageDir = stageSourceConfigPayloads(selector, sourceConfigEntries);
    const sourceConfigManifest = {
        schemaVersion: SOURCE_CONFIG_SCHEMA_VERSION,
        version: RELEASE_VERSION,
        releaseId: `taa-${RELEASE_VERSION}`,
        selector,
        roots: SOURCE_CONFIG_ROOTS.slice(),
        files: sourceConfigEntries.map((e) => ({ path: e.rel, sha256: e.sha256 })),
        sourceConfigSha256,
        payloadDir: sourceConfigNames(selector).payloadDirName,
        createdAt: new Date().toISOString(),
    };
    const temporary = {};
    try {
        for (const [kind, source] of Object.entries(sources)) { if (process.env.TAA_FAIL_COPY === kind) throw new Error(`injected failure: copy-${kind}`); temporary[kind] = path.join(BACKUPS, `.backup-${selector}-${kind}.tmp`); fs.copyFileSync(source, temporary[kind]); if (process.env.TAA_FAIL_STAGED_READBACK === kind || digest(temporary[kind]) !== hashes[kind]) throw new Error(`backup readback mismatch: ${kind}`); }
        const manifest = { schemaVersion: 1, version: RELEASE_VERSION, releaseId: `taa-${RELEASE_VERSION}`, selector, files: {}, runtimeSha256: hashes.runtime };
        for (const kind of Object.keys(names)) { manifest.files[kind] = { path: names[kind], sha256: hashes[kind] }; }
        const sidecars = {};
        for (const [kind, name] of Object.entries(names)) { const target = path.join(BACKUPS, name); fs.renameSync(temporary[kind], target); fsyncFile(target); sidecars[kind] = `${target}.sha256`; atomicWrite(sidecars[kind], `${hashes[kind]}  ${name}\n`); }
        const manifestPath = path.join(BACKUPS, `backup-${selector}.manifest.json`); const manifestBytes = `${JSON.stringify(manifest)}\n`; atomicWrite(manifestPath, manifestBytes); if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) throw new Error(`backup integrity readback mismatch: ${manifestPath}`);
        for (const file of Object.values(sidecars)) { const expected = `${hashes[Object.keys(sidecars).find((kind) => sidecars[kind] === file)]}  ${path.basename(file, '.sha256')}\n`; if (fs.readFileSync(file, 'utf8') !== expected) throw new Error(`backup integrity readback mismatch: ${file}`); }
        commitSourceConfigPayloads(selector, stageDir, sourceConfigEntries, sourceConfigManifest);
        fsyncDir();
        const manifestRel = toPosix(path.relative(ROOT, path.join(BACKUPS, sourceConfigNames(selector).manifestName)));
        if (process.argv.includes('--json')) {
            process.stdout.write(`${JSON.stringify({ selector, manifestPath: manifestRel, sourceConfigSha256, files: sourceConfigEntries.map((e) => e.rel) })}\n`);
        } else {
            process.stdout.write(`${hashes.runtime}\n`);
        }
        return { selector, manifestPath: manifestRel, sourceConfigSha256, files: sourceConfigEntries.map((e) => e.rel) };
    } catch (error) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        removePublishedSelector(selector);
        throw error;
    } finally { for (const file of Object.values(temporary)) fs.rmSync(file, { force: true }); }
}

if (require.main === module) backup();

module.exports = { backup, digest, recoverRollbackJournal, inventorySourceConfig, sourceConfigDigest, sourceConfigNames, SOURCE_CONFIG_ROOTS, SOURCE_CONFIG_SCHEMA_VERSION };
