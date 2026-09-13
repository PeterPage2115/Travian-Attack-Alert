'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function command(args) { const result = spawnSync(process.execPath, args, { cwd: ROOT, shell: false, encoding: 'utf8' }); return result.status === 0; }
function main() {
    const artifact = path.join(ROOT, 'script.txt'); const manifest = path.join(ROOT, 'module-manifest.json');
    const originalArtifact = fs.readFileSync(artifact); const originalManifest = fs.readFileSync(manifest); const failures = [];
    try {
        fs.writeFileSync(artifact, Buffer.concat([originalArtifact, Buffer.from('\n// stale sentinel\n')])); failures.push(!command(['tools/check-artifact.cjs'])); fs.writeFileSync(artifact, originalArtifact);
        const value = JSON.parse(originalManifest); value.temporaryExceptions.push({ path: 'src/other.js', sha256: '0'.repeat(64), temporaryException: true, removeBeforeGate: 'todo14-final' }); fs.writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`); failures.push(!command(['tools/quality.cjs'])); fs.writeFileSync(manifest, originalManifest);
        failures.push(!command(['tools/quality.cjs', '--gate', 'todo14-final']));
        if (failures.some(value => !value)) throw new Error('negative quality scenario was accepted');
    } finally { fs.writeFileSync(artifact, originalArtifact); fs.writeFileSync(manifest, originalManifest); }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, scenarios: ['stale-artifact', 'second-exception', 'todo14-final-expiry'], verdict: 'PASS' }) + '\n');
}
if (require.main === module) main();
