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
    const artifact = read(ARTIFACT);
    fs.writeFileSync(ARTIFACT, artifact);
    const artifactHash = digest(artifact);
    const manifest = JSON.parse(read(MANIFEST));
    delete manifest.source;
    manifest.release = RELEASE;
    manifest.modules = modules;
    manifest.temporaryExceptions = [];
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(METADATA, `${JSON.stringify({ schemaVersion: 1, release: RELEASE, artifact: { path: 'script.txt', sha256: artifactHash }, toolchain: { esbuild: '0.25.9', typescript: '5.9.2', node: '22.19.0' } }, null, 2)}\n`);
    process.stdout.write(`${artifactHash}\n`);
}
if (require.main === module) build();
module.exports = { build, digest, transform };
