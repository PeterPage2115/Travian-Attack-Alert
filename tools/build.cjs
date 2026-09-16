'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'userscript-entry.js');
const CONFIG = path.join(ROOT, 'config', 'userscript.json');
const PACKAGE = path.join(ROOT, 'package.json');
const METADATA = path.join(ROOT, 'metadata.json');
const MANIFEST = path.join(ROOT, 'module-manifest.json');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const DIST_FILE = path.join(DIST_DIR, DIST_BASENAME);
const DIST_SIDECAR = `${DIST_FILE}.sha256`;
const FALLBACK_VERSION = '1.0.0';

// Sole generated-output owner: dist runtime, sidecar, metadata.json, and the
// generated-and-ignored root module-manifest.json are written only here.
// This is the canonical metadata order. Version is build-owned and is always
// inserted after namespace; array values retain their order from the config.
const METADATA_FIELDS = [
    'name', 'namespace', 'version', 'description', 'match', 'grant', 'connect',
    'run-at', 'noframes', 'license', 'homepageURL', 'supportURL', 'updateURL',
    'downloadURL'
];

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function readJson(file) { return JSON.parse(read(file)); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function portable(file) { return path.relative(ROOT, file).split(path.sep).join('/'); }
function fsyncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fsyncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return false;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fsyncFile(temporary);
        fs.renameSync(temporary, file);
        fsyncDir(path.dirname(file));
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    return true;
}

function supportedNodeMajor(packageJson) {
    const engine = packageJson.engines?.node;
    const match = /^>=\s*(\d+)$/.exec(engine || '');
    if (!match) throw new Error(`unsupported package.json engines.node contract: ${engine ?? '<missing>'}`);
    return Number(match[1]);
}

function metadataBlock(config, version) {
    const values = { ...config, version };
    const lines = ['// ==UserScript=='];
    for (const field of METADATA_FIELDS) {
        const value = values[field];
        if (field === 'noframes') {
            if (value === true) lines.push('// @noframes');
            continue;
        }
        for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item !== 'string' || item.length === 0) throw new Error(`invalid userscript metadata: ${field}`);
            lines.push(`// @${field.padEnd(13)}${item}`);
        }
    }
    lines.push('// ==/UserScript==', '');
    return `${lines.join('\n')}\n`;
}

function generateArtifact() {
    const packageJson = readJson(PACKAGE);
    const esbuildPin = packageJson.devDependencies?.esbuild;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(esbuildPin || '')) throw new Error('esbuild must be exactly pinned in package.json');
    if (esbuild.version !== esbuildPin) throw new Error(`installed esbuild ${esbuild.version} does not match package.json pin ${esbuildPin}`);
    const version = packageJson.version || FALLBACK_VERSION;
    const result = esbuild.buildSync({
        absWorkingDir: ROOT,
        entryPoints: [ENTRY],
        bundle: true,
        platform: 'browser',
        // CJS dual-mode: in Node, require(dist) executes this file as a
        // CommonJS module so the entry's `module.exports = runtime` guard
        // exposes the runtime contract to artifact tests; in a browser the
        // same file loads as a classic userscript where `module` is
        // undefined, so the export guard short-circuits and only the
        // document/location-guarded browser start runs.
        format: 'cjs',
        target: 'es2022',
        write: false,
        metafile: true,
        sourcemap: false,
        legalComments: 'inline',
        charset: 'utf8',
        minify: false,
        treeShaking: true,
        logLevel: 'silent'
    });
    if (result.outputFiles.length !== 1) throw new Error(`expected one bundled output, got ${result.outputFiles.length}`);
    const outputImports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
    if (outputImports.length !== 0) throw new Error(`bundled output contains external imports: ${outputImports.map(item => item.path).join(', ')}`);
    for (const input of Object.keys(result.metafile.inputs)) {
        if (!input.startsWith('src/')) throw new Error(`build input is outside src: ${input}`);
    }
    const body = result.outputFiles[0].text;
    if (/^\/\/ ==\/?UserScript==$/m.test(body)) throw new Error('source bundle contains a userscript metadata block');
    if (!body.includes(`taa-${version}`)) throw new Error(`runtime release ID is not taa-${version}`);
    return { bytes: Buffer.from(metadataBlock(readJson(CONFIG), version) + body, 'utf8'), packageJson, version };
}

function sourceModules() {
    return fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(ROOT, 'src', entry.name))
        .sort();
}

function build() {
    const generated = generateArtifact();
    const release = { version: generated.version, releaseId: `taa-${generated.version}` };
    const artifactHash = digest(generated.bytes);
    const modules = sourceModules().map(file => ({ path: portable(file), sha256: digest(fs.readFileSync(file)) }));
    const manifest = { schemaVersion: 1, release, maxPureLines: 250, temporaryExceptions: [], modules };
    const metadata = {
        schemaVersion: 1,
        release,
        artifact: {
            path: `dist/${DIST_BASENAME}`,
            sha256: artifactHash,
            source: { path: portable(ENTRY), sha256: digest(fs.readFileSync(ENTRY)) },
            dist: { path: `dist/${DIST_BASENAME}`, sha256: artifactHash }
        },
        toolchain: {
            esbuild: generated.packageJson.devDependencies.esbuild,
            typescript: generated.packageJson.devDependencies.typescript,
            nodeMajor: supportedNodeMajor(generated.packageJson)
        }
    };

    fs.mkdirSync(DIST_DIR, { recursive: true });
    atomicWrite(DIST_FILE, generated.bytes);
    atomicWrite(DIST_SIDECAR, `${artifactHash}  dist/${DIST_BASENAME}\n`);
    atomicWrite(METADATA, json(metadata));
    atomicWrite(MANIFEST, json(manifest));
    process.stdout.write(`${artifactHash}\n`);
}

if (require.main === module) build();
module.exports = { build, digest, generateArtifact, supportedNodeMajor };
