'use strict';

// Read-only artifact checker. It rebuilds expected bytes in memory and never
// writes, renames, copies, deletes, or otherwise mutates any file.

const fs = require('node:fs');
const path = require('node:path');
const { digest, generateArtifact } = require('./build.cjs');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const distPath = process.env.TAA_DIST ? path.resolve(process.env.TAA_DIST) : path.join(ROOT, 'dist', DIST_BASENAME);
const sidecarPath = process.env.TAA_SIDECAR ? path.resolve(process.env.TAA_SIDECAR) : `${distPath}.sha256`;

function countMarker(text, marker) { return (text.match(new RegExp(`^${marker}$`, 'gm')) || []).length; }
function hasModuleSyntax(text) { return /\brequire\s*\(|^\s*(?:import|export)(?:\s|\()/m.test(text); }

function check() {
    const generated = [distPath, sidecarPath, path.join(ROOT, 'metadata.json'), path.join(ROOT, 'module-manifest.json')];
    const missing = generated.find(file => !fs.existsSync(file));
    if (missing) throw new Error(`artifact check failed: ${path.relative(ROOT, missing)} is missing; run npm run build`);
    const expectedBytes = generateArtifact().bytes;
    const distBytes = fs.readFileSync(distPath);
    const expectedHash = digest(expectedBytes);
    const distHash = digest(distBytes);
    const distText = distBytes.toString('utf8');
    const sidecar = fs.readFileSync(sidecarPath, 'utf8');
    const sidecarMatch = /^([0-9a-f]{64})  (.+)\n$/.exec(sidecar);
    const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'metadata.json'), 'utf8'));
    const expectedName = process.env.TAA_DIST ? `dist/${DIST_BASENAME}` : path.relative(ROOT, distPath).split(path.sep).join('/');
    const checks = [
        ['source and dist are synchronized', expectedHash === distHash && expectedBytes.equals(distBytes)],
        ['sidecar format', sidecarMatch !== null],
        ['sidecar hash matches dist', sidecarMatch !== null && sidecarMatch[1] === distHash],
        ['sidecar filename', sidecarMatch !== null && sidecarMatch[2] === expectedName],
        ['metadata artifact hash', metadata.artifact.sha256 === distHash],
        ['metadata dist hash', metadata.artifact.dist?.sha256 === distHash],
        ['one userscript opening marker', countMarker(distText, '// ==UserScript==') === 1],
        ['one userscript closing marker', countMarker(distText, '// ==/UserScript==') === 1],
        ['no unresolved module syntax', !hasModuleSyntax(distText)],
        ['no source map', !/sourceMappingURL/.test(distText)]
    ];
    for (const [name, pass] of checks) if (!pass) throw new Error(`artifact check failed: ${name}`);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifact: distHash, dist: distHash, verdict: 'PASS' })}\n`);
}

if (require.main === module) check();
module.exports = { check };
