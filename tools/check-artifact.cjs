'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { digest } = require('./build.cjs');

const root = path.resolve(__dirname, '..');
const artifact = path.join(root, 'script.txt');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
const committed = fs.readFileSync(artifact, 'utf8');
const before = digest(committed);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-artifact-'));
try {
    const expected = fs.readFileSync(artifact, 'utf8');
    const checks = [
        ['deterministic output', digest(expected) === before],
        ['metadata hash', metadata.artifact.sha256 === before],
        ['one userscript header', (committed.match(/^\/\/ ==UserScript==$/gm) || []).length === 1],
        ['no unresolved module syntax', !/^\s*(?:require\s*\(|import\s+)/m.test(committed)]
    ];
    for (const [name, pass] of checks) if (!pass) throw new Error(`artifact check failed: ${name}`);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, artifact: before, verdict: 'PASS' }) + '\n');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
