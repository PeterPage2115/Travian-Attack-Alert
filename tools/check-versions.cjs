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
    const pkg = json('package.json'); const lock = json('package-lock.json'); const version = pkg.version; const releaseId = `taa-${version}`;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) errors.push(`package.json version: invalid semver ${version ?? '<missing>'}`); claim('package-lock.json version', lock.version, version); claim('package-lock root version', lock.packages?.['']?.version, version);
    const script = text('script.txt'); claim('script.txt @version', versionFrom(script, /^\/\/ @version\s+([^\s]+)$/m, 'script.txt @version'), version); claim('script RELEASE_VERSION', versionFrom(script, /const RELEASE_VERSION = ["']([^"']+)["']/m, 'script RELEASE_VERSION'), version); claim('script RELEASE_ID', versionFrom(script, /const RELEASE_ID = ["']([^"']+)["']/m, 'script RELEASE_ID'), releaseId);
    for (const file of ['metadata.json', 'module-manifest.json']) { const release = json(file).release; claim(`${file} release.version`, release?.version, version); claim(`${file} release.releaseId`, release?.releaseId, releaseId); }
    for (const file of ['tools/build.cjs', 'tools/backup.cjs', 'tools/rollback.cjs']) claim(`${file} FALLBACK_VERSION`, versionFrom(text(file), /const FALLBACK_VERSION = ["']([^"']+)["']/m, `${file} FALLBACK_VERSION`), version);
    const tests = text('test/script.test.cjs'); claim('test/script.test.cjs version assertion', versionFrom(tests, /const version = ["']([^"']+)["']/m, 'test version'), version); claim('test/script.test.cjs release assertion', versionFrom(tests, /const releaseId = ["']([^"']+)["']/m, 'test release ID'), releaseId); for (const [lineNumber, line] of tests.split('\n').entries()) if (!/historical/i.test(line)) for (const match of line.matchAll(/taa-(\d+\.\d+\.\d+)/g)) claim(`test/script.test.cjs release literal line ${lineNumber + 1}`, match[0], releaseId);
    const agents = text('AGENTS.md'); claim('AGENTS current version', versionFrom(agents, /aktualnie\s+([0-9]+\.[0-9]+\.[0-9]+)/i, 'AGENTS current version'), version); claim('AGENTS runtime release ID', versionFrom(agents, /release ID `([^`]+)`/, 'AGENTS release ID'), releaseId);
    const readme = text('README.md'); claim('README current version', versionFrom(readme, /Tampermonkey \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/, 'README current version'), version); claim('README runtime release ID', versionFrom(readme, /identified by release ID `([^`]+)`/, 'README release ID'), releaseId);
    const design = text('DESIGN.md'); const designClaims = [...design.matchAll(/release ID [`*]?(taa-[0-9]+\.[0-9]+\.[0-9]+)[`*]?/gi)]; for (const match of designClaims) claim('DESIGN release ID claim', match[1], releaseId);
    return errors;
}
try {
    const failures = check();
    if (failures.length > 0) { for (const failure of failures) process.stderr.write(`VERSION CHECK FAIL: ${failure}\n`); process.exitCode = 1; } else process.stdout.write(`VERSION CHECK PASS: ${require(path.join(ROOT, 'package.json')).version} (${`taa-${require(path.join(ROOT, 'package.json')).version}`})\n`);
} catch (error) { process.stderr.write(`VERSION CHECK FAIL: ${error.message}\n`); process.exitCode = 2; }

module.exports = { check };
