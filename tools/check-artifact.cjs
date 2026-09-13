'use strict';

// Read-only artifact checker: verifies the deterministic dist packaging
// produced by tools/build.cjs. This module MUST NOT write, rename, copy,
// delete, or otherwise mutate any file — every failure path throws without
// touching the filesystem (no fs.write/mkdir/rename/copy/rm calls exist here).

const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./build.cjs');

const root = path.resolve(__dirname, '..');
// TAA_SOURCE / TAA_DIST overrides exist ONLY so the negative control can run
// the same checker logic against a mutated TEMP copy; defaults verify the
// real committed files. Overrides never cause any write.
const sourcePath = process.env.TAA_SOURCE ? path.resolve(process.env.TAA_SOURCE) : path.join(root, 'script.txt');
const distPath = process.env.TAA_DIST ? path.resolve(process.env.TAA_DIST) : path.join(root, 'dist', 'travian-attack-alert.user.js');
const sidecarPath = `${distPath}.sha256`;
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));

function countHeaders(text) { return (text.match(/^\/\/ ==UserScript==$/gm) || []).length; }
function hasModuleSyntax(text) { return /^\s*(?:require\s*\(|import\s+)/m.test(text); }

function check() {
    if (!fs.existsSync(distPath)) throw new Error('artifact check failed: dist file is missing');
    if (!fs.existsSync(sidecarPath)) throw new Error('artifact check failed: dist sidecar is missing');
    const sourceBytes = fs.readFileSync(sourcePath);
    const distBytes = fs.readFileSync(distPath);
    const sourceHash = digest(sourceBytes);
    const distHash = digest(distBytes);
    const sourceText = sourceBytes.toString('utf8');
    const distText = distBytes.toString('utf8');
    const sidecar = fs.readFileSync(sidecarPath, 'utf8');
    const sidecarMatch = /^([0-9a-f]{64})  (.+)\n$/.exec(sidecar);
    const expectedName = path.relative(root, distPath).split(path.sep).join('/');
    const checks = [
        ['deterministic output', sourceHash === digest(sourceBytes)],
        ['source equals dist', sourceHash === distHash],
        ['sidecar format', sidecarMatch !== null],
        ['sidecar hash matches dist', sidecarMatch !== null && sidecarMatch[1] === distHash],
        ['sidecar filename', sidecarMatch !== null && sidecarMatch[2] === expectedName],
        ['metadata hash', metadata.artifact.sha256 === sourceHash],
        ['metadata source hash', metadata.artifact.source?.sha256 === sourceHash],
        ['metadata dist hash', metadata.artifact.dist?.sha256 === distHash],
        ['one userscript header in source', countHeaders(sourceText) === 1],
        ['one userscript header in dist', countHeaders(distText) === 1],
        ['no unresolved module syntax in source', !hasModuleSyntax(sourceText)],
        ['no unresolved module syntax in dist', !hasModuleSyntax(distText)]
    ];
    for (const [name, pass] of checks) if (!pass) throw new Error(`artifact check failed: ${name}`);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, artifact: sourceHash, dist: distHash, verdict: 'PASS' }) + '\n');
}

if (require.main === module) check();

module.exports = { check };
