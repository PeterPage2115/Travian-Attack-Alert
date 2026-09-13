'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'browser-entry.js');
const ARTIFACT = path.join(ROOT, 'script.txt');
const METADATA = path.join(ROOT, 'metadata.json');
const MANIFEST = path.join(ROOT, 'module-manifest.json');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const DIST_FILE = path.join(DIST_DIR, DIST_BASENAME);
const DIST_SIDECAR = `${DIST_FILE}.sha256`;
const FALLBACK_VERSION = '1.0.0';
let version = FALLBACK_VERSION;
try { version = require(path.join(ROOT, 'package.json')).version || FALLBACK_VERSION; } catch {}
const RELEASE = { version, releaseId: `taa-${version}` };
const MODULES = [
    'constants', 'text', 'storage', 'lease', 'route', 'parser', 'snapshot',
    'envelope', 'migration', 'discord', 'transport', 'dispatch', 'conservation',
    'diagnostics', 'panel', 'acquisition',
    'legacy-bridge', 'boot', 'browser-entry'
].map(name => path.join(ROOT, 'src', `${name}.js`));

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function fsyncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fsyncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file, value) { const temporary = `${file}.tmp`; fs.writeFileSync(temporary, value); fsyncFile(temporary); fs.renameSync(temporary, file); fsyncDir(path.dirname(file)); }
function transform(source) {
    const headerEnd = source.indexOf('// ==/UserScript==');
    if (headerEnd < 0) throw new Error('userscript header is missing');
    const header = source.slice(0, source.indexOf('\n', headerEnd) + 1);
    const body = source.slice(source.indexOf('\n', headerEnd) + 1);
    const transformed = esbuild.transformSync(body, {
        loader: 'js', target: 'es2022', legalComments: 'inline', sourcemap: false,
        charset: 'utf8', minify: false, treeShaking: false
    }).code;
    return header + transformed;
}
function build() {
    if (!fs.existsSync(ENTRY)) throw new Error('browser entry is missing');
    const modules = MODULES.map(file => ({ path: path.relative(ROOT, file).split(path.sep).join('/'), sha256: digest(read(file)) }));
    const artifactBytes = fs.readFileSync(ARTIFACT);
    const artifactHash = digest(artifactBytes);
    const manifest = JSON.parse(read(MANIFEST));
    delete manifest.source;
    manifest.release = RELEASE;
    manifest.modules = modules;
    manifest.temporaryExceptions = [];
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.mkdirSync(DIST_DIR, { recursive: true });
    atomicWrite(DIST_FILE, artifactBytes);
    const distHash = digest(fs.readFileSync(DIST_FILE));
    if (distHash !== artifactHash) throw new Error('dist readback mismatch');
    const sidecarBytes = `${distHash}  dist/${DIST_BASENAME}\n`;
    atomicWrite(DIST_SIDECAR, sidecarBytes);
    if (fs.readFileSync(DIST_SIDECAR, 'utf8') !== sidecarBytes) throw new Error('dist sidecar readback mismatch');
    fs.writeFileSync(METADATA, `${JSON.stringify({ schemaVersion: 1, release: RELEASE, artifact: { path: 'script.txt', sha256: artifactHash, source: { path: 'script.txt', sha256: artifactHash }, dist: { path: 'dist/travian-attack-alert.user.js', sha256: distHash } }, toolchain: { esbuild: '0.25.9', typescript: '5.9.2', node: '22.19.0' } }, null, 2)}\n`);
    process.stdout.write(`${artifactHash}\n`);
}
if (require.main === module) build();
module.exports = { build, digest, transform };
