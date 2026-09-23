'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const errors = [];
function claim(name, actual, expected) { if (actual !== expected) errors.push(`${name}: expected ${expected}, got ${actual ?? '<missing>'}`); }
function text(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function json(file) { return JSON.parse(text(file)); }
function versionFrom(source, expression, name) { const match = expression.exec(source); if (!match) errors.push(`${name}: claim is missing`); return match?.[1]; }
function check() {
    for (const file of ['dist/travian-attack-alert.user.js', 'dist/travian-attack-alert.user.js.sha256', 'metadata.json', 'module-manifest.json']) {
        if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`${file} is missing; run npm run build`);
    }
    const pkg = json('package.json'); const lock = json('package-lock.json'); const version = pkg.version; const releaseId = `taa-${version}`;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) errors.push(`package.json version: invalid semver ${version ?? '<missing>'}`); claim('package-lock.json version', lock.version, version); claim('package-lock root version', lock.packages?.['']?.version, version);
    const runtime = text('src/runtime.js'); claim('src/runtime.js RELEASE_VERSION', versionFrom(runtime, /const RELEASE_VERSION = ["']([^"']+)["']/m, 'runtime RELEASE_VERSION'), version); claim('src/runtime.js RELEASE_ID', versionFrom(runtime, /const RELEASE_ID = ["']([^"']+)["']/m, 'runtime RELEASE_ID'), releaseId);
    const dist = text('dist/travian-attack-alert.user.js'); claim('dist @version', versionFrom(dist, /^\/\/ @version\s+([^\s]+)$/m, 'dist @version'), version);
    for (const file of ['metadata.json', 'module-manifest.json']) { const release = json(file).release; claim(`${file} release.version`, release?.version, version); claim(`${file} release.releaseId`, release?.releaseId, releaseId); }
    const state = json('docs/release-state.json'); claim('docs/release-state.json version', state.version, version); claim('docs/release-state.json releaseId', state.releaseId, releaseId);
    for (const file of ['tools/build.cjs', 'tools/backup.cjs', 'tools/rollback.cjs']) claim(`${file} FALLBACK_VERSION`, versionFrom(text(file), /const FALLBACK_VERSION = ["']([^"']+)["']/m, `${file} FALLBACK_VERSION`), version);
    const testPath = fs.existsSync(path.join(ROOT, 'test/offline/script.test.cjs')) ? 'test/offline/script.test.cjs' : 'test/script.test.cjs';
    const tests = text(testPath); claim(`${testPath} version assertion`, versionFrom(tests, /const version = ["']([^"']+)["']/m, 'test version'), version); claim(`${testPath} release assertion`, versionFrom(tests, /const releaseId = ["']([^"']+)["']/m, 'test release ID'), releaseId); for (const [lineNumber, line] of tests.split('\n').entries()) if (!/historical/i.test(line)) for (const match of line.matchAll(/taa-(\d+\.\d+\.\d+)/g)) claim(`${testPath} release literal line ${lineNumber + 1}`, match[0], releaseId);
    const agents = text('AGENTS.md'); claim('AGENTS current version', versionFrom(agents, /aktualnie\s+([0-9]+\.[0-9]+\.[0-9]+)/i, 'AGENTS current version'), version); claim('AGENTS runtime release ID', versionFrom(agents, /release ID `([^`]+)`/, 'AGENTS release ID'), releaseId);
    const readme = text('README.md'); claim('README current version', versionFrom(readme, /Tampermonkey \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/, 'README current version'), version); claim('README runtime release ID', versionFrom(readme, /identified by release ID `([^`]+)`/, 'README release ID'), releaseId);
    // The migration install instruction must name the CURRENT artifact, so a
    // future bump cannot leave migrating users pointed at a superseded release.
    // Historical reinstall wording (old broken `/main/` copies) is deliberately
    // NOT asserted here: it is intentionally pinned to the old 1.0.0 identity.
    claim('README migration install instruction', versionFrom(readme, /then install ([0-9]+\.[0-9]+\.[0-9]+)\./, 'README migration install instruction'), version);
    const migration = text('docs/MIGRATION-6X.md'); claim('docs/MIGRATION-6X.md install instruction', versionFrom(migration, /\*\*Install the ([0-9]+\.[0-9]+\.[0-9]+) file\.\*\*/, 'docs/MIGRATION-6X.md install instruction'), version);
    const operations = text('docs/OPERATIONS.md'); claim('docs/OPERATIONS.md migration install instruction', versionFrom(operations, /install the ([0-9]+\.[0-9]+\.[0-9]+) file as a new script/, 'docs/OPERATIONS.md migration install instruction'), version);
    const operationsPl = text('docs/pl/OPERATIONS.md'); claim('docs/pl/OPERATIONS.md migration install instruction', versionFrom(operationsPl, /zainstaluj plik ([0-9]+\.[0-9]+\.[0-9]+) jako nowy skrypt/, 'docs/pl/OPERATIONS.md migration install instruction'), version);
    const design = text('docs/architecture.md'); const designClaims = [...design.matchAll(/release ID [`*]?(taa-[0-9]+\.[0-9]+\.[0-9]+)[`*]?/gi)]; for (const match of designClaims) claim('docs/architecture.md release ID claim', match[1], releaseId);
    return errors;
}
try {
    const failures = check();
    if (failures.length > 0) { for (const failure of failures) process.stderr.write(`VERSION CHECK FAIL: ${failure}\n`); process.exitCode = 1; } else process.stdout.write(`VERSION CHECK PASS: ${require(path.join(ROOT, 'package.json')).version} (${`taa-${require(path.join(ROOT, 'package.json')).version}`})\n`);
} catch (error) { process.stderr.write(`VERSION CHECK FAIL: ${error.message}\n`); process.exitCode = 2; }

module.exports = { check };
