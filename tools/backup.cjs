'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const BACKUPS = path.join(ROOT, 'backups');
const FALLBACK_VERSION = '1.0.2';
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

/** Legacy selector artifact names (schemaVersion-1 four-file snapshot). */
function selectorNames(selector) {
    return { runtime: `runtime-${selector}.js`, config: `config-${selector}.json`, metadata: `metadata-${selector}.json`, moduleManifest: `module-manifest-${selector}.json` };
}

function lstatOrNull(target) {
    try { return fs.lstatSync(target); } catch { return null; }
}

/**
 * Shared regular-file contract (Task 7) for backup and rollback: lstat never
 * follows symlinks, so symlinks, FIFOs, sockets, devices and directories all
 * fail closed. Returns null when the path is absent; callers own the missing
 * case so the message stays actionable.
 */
function lstatRegularFile(target, rel, kind = 'backup payload') {
    const stat = lstatOrNull(target);
    if (stat === null) return null;
    if (!stat.isFile()) throw new Error(`${kind} is not a regular file: ${rel}`);
    return stat;
}

function readRegularJson(file, rel, kind) {
    if (lstatRegularFile(file, rel, kind) === null) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function legacyManifestsEquivalent(published, proposed) {
    if (!published || published.schemaVersion !== proposed.schemaVersion || published.version !== proposed.version
        || published.releaseId !== proposed.releaseId || published.selector !== proposed.selector
        || published.runtimeSha256 !== proposed.runtimeSha256 || !published.files) return false;
    const kinds = Object.keys(proposed.files);
    return Object.keys(published.files).length === kinds.length
        && kinds.every((kind) => published.files[kind] && published.files[kind].path === proposed.files[kind].path && published.files[kind].sha256 === proposed.files[kind].sha256);
}

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

function walkRegularPayloadTree(dirAbs, relPrefix, expectedDirs, out) {
    for (const name of fs.readdirSync(dirAbs).sort()) {
        const abs = path.join(dirAbs, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const stat = fs.lstatSync(abs);
        if (stat.isDirectory()) {
            if (!expectedDirs.has(rel)) throw new Error(`backup selector payload entry unexpected: ${rel}`);
            out.push(rel);
            walkRegularPayloadTree(abs, rel, expectedDirs, out);
            continue;
        }
        if (!stat.isFile()) throw new Error(`backup payload is not a regular file: ${rel}`);
        out.push(rel);
    }
}

/**
 * A published legacy snapshot is compatible only when it is the byte-exact
 * proposed snapshot: manifest fields, every payload digest, every sidecar and
 * the complete artifact set. Anything else fails closed and is never touched.
 */
function validatePublishedLegacySelector(selector, names, manifest) {
    const manifestName = `backup-${selector}.manifest.json`;
    const published = readRegularJson(path.join(BACKUPS, manifestName), manifestName, 'backup manifest');
    if (published === null) throw new Error(`backup selector manifest missing: ${manifestName}`);
    if (published === undefined) throw new Error(`backup selector manifest is malformed: ${manifestName}`);
    if (!legacyManifestsEquivalent(published, manifest)) throw new Error(`backup selector already published: ${selector}`);
    for (const kind of Object.keys(names)) {
        const name = names[kind];
        const payload = path.join(BACKUPS, name);
        if (lstatRegularFile(payload, name) === null) throw new Error(`backup selector payload missing: ${name}`);
        if (digest(payload) !== manifest.files[kind].sha256) throw new Error(`backup selector payload mismatch: ${name}`);
        const sidecarName = `${name}.sha256`;
        const sidecar = path.join(BACKUPS, sidecarName);
        if (lstatRegularFile(sidecar, sidecarName, 'backup sidecar') === null) throw new Error(`backup selector sidecar missing: ${sidecarName}`);
        if (fs.readFileSync(sidecar, 'utf8') !== `${manifest.files[kind].sha256}  ${name}\n`) throw new Error(`backup selector sidecar mismatch: ${name}`);
    }
}

/**
 * A published source/config snapshot is compatible only when the manifest is
 * the byte-exact proposed one (ignoring createdAt), the payload directory is a
 * real directory holding exactly the expected regular files/sidecars, and
 * every payload digest and sidecar matches the manifest.
 */
function validatePublishedSourceConfigSelector(selector, manifest) {
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    const published = readRegularJson(path.join(BACKUPS, manifestName), manifestName, 'backup manifest');
    if (published === null) throw new Error(`backup selector manifest missing: ${manifestName}`);
    if (published === undefined) throw new Error(`backup selector manifest is malformed: ${manifestName}`);
    if (!manifestsEquivalentIgnoringTimestamp(published, manifest)) throw new Error(`backup selector already published: ${selector}`);
    const payloadRoot = path.join(BACKUPS, payloadDirName);
    const rootStat = lstatOrNull(payloadRoot);
    if (rootStat === null) throw new Error(`backup payload dir missing: ${payloadDirName}`);
    if (!rootStat.isDirectory()) throw new Error(`backup payload dir is not a directory: ${payloadDirName}`);
    const expected = new Set();
    const expectedDirs = new Set();
    for (const entry of manifest.files) {
        expected.add(entry.path);
        expected.add(`${entry.path}.sha256`);
        const parts = entry.path.split('/');
        parts.pop();
        let dir = '';
        for (const part of parts) { dir = dir ? `${dir}/${part}` : part; expected.add(dir); expectedDirs.add(dir); }
    }
    // Every manifest payload path must itself be a regular file before the tree
    // shape is compared, so a directory/symlink/FIFO swap is rejected as such.
    for (const entry of manifest.files) {
        if (lstatRegularFile(path.join(payloadRoot, entry.path), entry.path) === null) throw new Error(`backup selector payload entry missing: ${entry.path}`);
    }
    const actual = [];
    walkRegularPayloadTree(payloadRoot, '', expectedDirs, actual);
    const actualSet = new Set(actual);
    for (const rel of expected) if (!actualSet.has(rel)) throw new Error(`backup selector payload entry missing: ${rel}`);
    for (const rel of actual) if (!expected.has(rel)) throw new Error(`backup selector payload entry unexpected: ${rel}`);
    for (const entry of manifest.files) {
        const payload = path.join(payloadRoot, entry.path);
        if (digest(payload) !== entry.sha256) throw new Error(`backup selector payload mismatch: ${entry.path}`);
        const sidecar = `${payload}.sha256`;
        if (fs.readFileSync(sidecar, 'utf8') !== `${entry.sha256}  ${entry.path}\n`) throw new Error(`backup selector sidecar mismatch: ${entry.path}`);
    }
}

/**
 * Complete-selector preflight (Task 7). Classifies the whole selector as
 * absent, legacy-only (extendable additively), or a byte-exact published copy
 * of the proposed snapshot — and throws on any partial, non-regular or
 * colliding state. Runs before a single path is created, replaced, published
 * or deleted, and uses lstat only so a symlink is never followed.
 */
function preflightSelector(selector, names, legacyManifest, sourceConfigManifest) {
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    const legacyArtifacts = [...Object.keys(names).flatMap((kind) => [names[kind], `${names[kind]}.sha256`]), `backup-${selector}.manifest.json`];
    const legacyPresent = legacyArtifacts.filter((name) => lstatOrNull(path.join(BACKUPS, name)) !== null);
    const sourceConfigPresent = [manifestName, payloadDirName].filter((name) => lstatOrNull(path.join(BACKUPS, name)) !== null);
    if (legacyPresent.length === 0 && sourceConfigPresent.length === 0) return { state: 'absent' };
    if (legacyPresent.length !== legacyArtifacts.length || sourceConfigPresent.length === 1) {
        throw new Error(`backup selector is partially published: ${selector}`);
    }
    validatePublishedLegacySelector(selector, names, legacyManifest);
    if (sourceConfigPresent.length === 0) return { state: 'legacy-only' };
    validatePublishedSourceConfigSelector(selector, sourceConfigManifest);
    return { state: 'complete' };
}

function publishSourceConfigPayloads(selector, stageDir, entries, manifest) {
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    const payloadDir = path.join(BACKUPS, payloadDirName);
    const manifestPath = path.join(BACKUPS, manifestName);
    let published = false;
    try {
        fs.renameSync(stageDir, payloadDir);
        published = true;
        for (const entry of entries) fsyncFile(path.join(payloadDir, entry.rel));
        const manifestBytes = `${JSON.stringify(manifest)}\n`;
        atomicWrite(manifestPath, manifestBytes);
        if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) {
            throw new Error(`backup integrity readback mismatch: ${manifestName}`);
        }
        fsyncDir();
    } catch (error) {
        if (published) {
            fs.rmSync(payloadDir, { recursive: true, force: true });
            fs.rmSync(manifestPath, { force: true });
            fs.rmSync(`${manifestPath}.tmp`, { force: true });
        }
        throw error;
    }
    return { manifestPath, payloadDir };
}

function removeSourceConfigSelector(selector) {
    const { manifestName, payloadDirName } = sourceConfigNames(selector);
    fs.rmSync(path.join(BACKUPS, payloadDirName), { recursive: true, force: true });
    fs.rmSync(path.join(BACKUPS, manifestName), { force: true });
}

/**
 * Removes every artifact of a selector that this run proved absent before
 * publication. Never called on a validation/collision failure, so a
 * pre-existing published selector is never deleted.
 */
function removeSelectorArtifacts(selector) {
    const names = selectorNames(selector);
    for (const name of Object.values(names)) {
        fs.rmSync(path.join(BACKUPS, name), { force: true });
        fs.rmSync(path.join(BACKUPS, `${name}.sha256`), { force: true });
    }
    fs.rmSync(path.join(BACKUPS, `backup-${selector}.manifest.json`), { force: true });
    removeSourceConfigSelector(selector);
}

function reportBackup(result, runtimeSha256) {
    if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
        process.stdout.write(`${runtimeSha256}\n`);
    }
    return result;
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
    const names = selectorNames(selector);
    // The proposed selector content is built entirely in memory: nothing is
    // created, replaced, published or deleted until the preflight passes.
    const manifest = { schemaVersion: 1, version: RELEASE_VERSION, releaseId: `taa-${RELEASE_VERSION}`, selector, files: {}, runtimeSha256: hashes.runtime };
    for (const kind of Object.keys(names)) { manifest.files[kind] = { path: names[kind], sha256: hashes[kind] }; }
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
    const result = { selector, manifestPath: toPosix(path.relative(ROOT, path.join(BACKUPS, sourceConfigNames(selector).manifestName))), sourceConfigSha256, files: sourceConfigEntries.map((e) => e.rel) };
    // Complete-selector preflight: a byte-exact published copy is an idempotent
    // no-op; any partial/non-regular/colliding state fails closed with the
    // pre-existing selector untouched.
    const preflight = preflightSelector(selector, names, manifest, sourceConfigManifest);
    if (preflight.state === 'complete') return reportBackup(result, hashes.runtime);
    fs.mkdirSync(BACKUPS, { recursive: true });
    const temporary = {};
    let stageDir = null;
    try {
        // Stage the additive source/config payloads before any legacy file is
        // published, so a staging failure leaves the backups tree untouched.
        stageDir = stageSourceConfigPayloads(selector, sourceConfigEntries);
        if (preflight.state === 'absent') {
            for (const [kind, source] of Object.entries(sources)) { if (process.env.TAA_FAIL_COPY === kind) throw new Error(`injected failure: copy-${kind}`); temporary[kind] = path.join(BACKUPS, `.backup-${selector}-${kind}.tmp`); fs.copyFileSync(source, temporary[kind]); if (process.env.TAA_FAIL_STAGED_READBACK === kind || digest(temporary[kind]) !== hashes[kind]) throw new Error(`backup readback mismatch: ${kind}`); }
            const sidecars = {};
            for (const [kind, name] of Object.entries(names)) { const target = path.join(BACKUPS, name); fs.renameSync(temporary[kind], target); fsyncFile(target); sidecars[kind] = `${target}.sha256`; atomicWrite(sidecars[kind], `${hashes[kind]}  ${name}\n`); }
            const manifestPath = path.join(BACKUPS, `backup-${selector}.manifest.json`); const manifestBytes = `${JSON.stringify(manifest)}\n`; atomicWrite(manifestPath, manifestBytes); if (fs.readFileSync(manifestPath, 'utf8') !== manifestBytes) throw new Error(`backup integrity readback mismatch: ${manifestPath}`);
            for (const file of Object.values(sidecars)) { const expected = `${hashes[Object.keys(sidecars).find((kind) => sidecars[kind] === file)]}  ${path.basename(file, '.sha256')}\n`; if (fs.readFileSync(file, 'utf8') !== expected) throw new Error(`backup integrity readback mismatch: ${file}`); }
        }
        publishSourceConfigPayloads(selector, stageDir, sourceConfigEntries, sourceConfigManifest);
        stageDir = null;
        fsyncDir();
        return reportBackup(result, hashes.runtime);
    } catch (error) {
        if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
        // Publication failed. Only artifacts this run created may be removed:
        // 'absent' proved nothing pre-existed; 'legacy-only' proved the
        // published legacy snapshot must stay untouched.
        if (preflight.state === 'absent') removeSelectorArtifacts(selector);
        else removeSourceConfigSelector(selector);
        throw error;
    } finally { for (const file of Object.values(temporary)) fs.rmSync(file, { force: true }); }
}

if (require.main === module) backup();

module.exports = { backup, digest, recoverRollbackJournal, inventorySourceConfig, sourceConfigDigest, sourceConfigNames, lstatRegularFile, SOURCE_CONFIG_ROOTS, SOURCE_CONFIG_SCHEMA_VERSION };
