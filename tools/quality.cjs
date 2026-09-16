'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const LIMIT = 250;
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(directory, item.name)) : [path.join(directory, item.name)]); }
function pureLines(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() && !/^\s*\/\//.test(line)).length; }
function dependencyGraph(sourceFiles) {
    const graph = new Map();
    for (const file of sourceFiles) {
        const source = fs.readFileSync(file, 'utf8');
        const deps = [...source.matchAll(/(?:require\s*\(\s*['"](\.\.?\/[^'"]+)['"]|from\s*['"](\.\.?\/[^'"]+)['"])/g)].map(match => path.resolve(path.dirname(file), `${match[1] || match[2]}.js`));
        graph.set(file, deps.filter(dep => graph.has(dep) || sourceFiles.includes(dep)));
    }
    return graph;
}
function hasCycle(graph) {
    const active = new Set(); const visited = new Set();
    function visit(file) { if (active.has(file)) return true; if (visited.has(file)) return false; active.add(file); for (const dep of graph.get(file) || []) if (visit(dep)) return true; active.delete(file); visited.add(file); return false; }
    return [...graph.keys()].some(visit);
}
function check(gate) {
    const manifestPath = path.join(ROOT, 'module-manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('quality check failed: module-manifest.json is missing; run npm run build');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exceptions = manifest.temporaryExceptions || [];
    const failures = [];
    if (manifest.schemaVersion !== 1 || manifest.maxPureLines !== LIMIT) failures.push('module manifest schema drift');
    if (gate === 'todo14-final' && exceptions.length) failures.push('temporary exception survives todo14-final gate');
    const sourceFiles = files(path.join(ROOT, 'src')).filter(item => /\.js$/.test(item));
    const declaredModules = new Set((manifest.modules || []).map(item => item.path));
    for (const file of sourceFiles) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        const lineCount = pureLines(file);
        if (lineCount > LIMIT) failures.push(`${relative}: ${lineCount} pure lines`);
        if (/\b(?:window|document|localStorage|navigator|location|fetch)\b/.test(fs.readFileSync(file, 'utf8')) && relative !== 'src/legacy-monolith.js') failures.push(`${relative}: forbidden browser global`);
    }
    for (const file of sourceFiles) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        if (relative !== 'src/legacy-monolith.js' && !declaredModules.has(relative)) failures.push(`${relative}: missing module manifest entry`);
    }
    if (hasCycle(dependencyGraph(sourceFiles))) failures.push('module dependency cycle');
    if (failures.length) throw new Error(`quality gate failed: ${failures.join('; ')}`);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, gate: gate || 'todo11', maxPureLines: LIMIT, exceptions: exceptions.length, verdict: 'PASS' }) + '\n');
}
if (require.main === module) check(process.argv.includes('--gate') ? process.argv[process.argv.indexOf('--gate') + 1] : undefined);
module.exports = { check, pureLines };
