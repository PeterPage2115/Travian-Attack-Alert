'use strict';

// Quality ratchet: module-role rules with a strictly decreasing monolith
// budget. Replaces the old lexical 250-line-for-everything limit and the
// blanket browser-global regex (which carried a stale
// src/legacy-monolith.js exception and failed dishonestly on the real
// monolith src/runtime.js).
//
// Roles:
//   entry    — src/userscript-entry.js: the dual-mode adapter that starts
//              the browser runtime. May use the approved entry globals
//              (document, location, window) and nothing else browserish.
//   monolith — src/runtime.js: the legacy production monolith. May use the
//              approved lifecycle globals plus Tampermonkey host APIs, but
//              its pure-line count must never exceed the machine-readable
//              budget in test/fixtures/contracts/quality-baseline.json.
//              Any increase fails; decreases are the extraction workflow.
//   pure     — every other src/*.js module (constants, text, route, ...):
//              domain code. Must satisfy the new-module size limit, must
//              be cycle-free and manifested, and must not reference any
//              browser entry global or Tampermonkey host API.
//
// A missing or malformed budget baseline fails closed. Exit 0 IFF every
// rule holds; stdout is a machine-readable verdict.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');
const NEW_MODULE_LIMIT = 250;
const QUALITY_BASELINE_REL = path.join('test', 'fixtures', 'contracts', 'quality-baseline.json');

const ENTRY_PATHS = new Set(['src/userscript-entry.js']);
const ENTRY_GLOBALS = new Set(['document', 'location', 'window']);
const MONOLITH_PATH = 'src/runtime.js';
const MONOLITH_GLOBALS = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'navigator', 'location', 'fetch']);
const HOST_API_PATTERN = /GM_[A-Za-z]+|__TAA_TEST_HOOK__/;
const BROWSER_IDENT_PATTERN = /\b(?:document|window|localStorage|sessionStorage|navigator|location|fetch)\b/;

function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(directory, item.name)) : [path.join(directory, item.name)]); }
function pureLines(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() && !/^\s*\/\//.test(line)).length; }

function loadBudget() {
  const absolute = path.join(ROOT, QUALITY_BASELINE_REL);
  if (!fs.existsSync(absolute)) throw new Error(`quality gate failed: budget baseline is missing: ${QUALITY_BASELINE_REL}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`quality gate failed: budget baseline is malformed: ${QUALITY_BASELINE_REL}: ${error.message}`);
  }
  if (!parsed || parsed.schemaVersion !== 1 || !Number.isInteger(parsed.newModuleMaxPureLines) || parsed.newModuleMaxPureLines < 1) {
    throw new Error(`quality gate failed: budget baseline schema drift: ${QUALITY_BASELINE_REL}`);
  }
  if (!parsed.monolith || parsed.monolith.path !== MONOLITH_PATH || !Number.isInteger(parsed.monolith.maxPureLines) || parsed.monolith.maxPureLines < 1) {
    throw new Error(`quality gate failed: monolith budget is missing or malformed: ${QUALITY_BASELINE_REL}`);
  }
  return parsed;
}

function globalUses(source) {
  const uses = new Set();
  const browserMatch = source.match(new RegExp(BROWSER_IDENT_PATTERN.source, 'g'));
  if (browserMatch) for (const name of browserMatch) uses.add(name);
  const hostMatch = source.match(new RegExp(HOST_API_PATTERN.source, 'g'));
  if (hostMatch) for (const name of hostMatch) uses.add(/^GM_/.test(name) ? 'GM_* host API' : name);
  return [...uses].sort();
}

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
    const budget = loadBudget();
    const manifestPath = path.join(ROOT, 'module-manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('quality check failed: module-manifest.json is missing; run npm run build');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exceptions = manifest.temporaryExceptions || [];
    const failures = [];
    if (manifest.schemaVersion !== 1 || manifest.maxPureLines !== NEW_MODULE_LIMIT) failures.push('module manifest schema drift');
    if (gate === 'todo14-final' && exceptions.length) failures.push('temporary exception survives todo14-final gate');
    const sourceFiles = files(path.join(ROOT, 'src')).filter(item => /\.js$/.test(item));
    const declaredModules = new Set((manifest.modules || []).map(item => item.path));
    let monolithLines = null;
    for (const file of sourceFiles) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        const lineCount = pureLines(file);
        const source = fs.readFileSync(file, 'utf8');
        if (relative === MONOLITH_PATH) {
            monolithLines = lineCount;
            if (lineCount > budget.monolith.maxPureLines) failures.push(`${relative}: monolith budget exceeded: ${lineCount} pure lines > budget ${budget.monolith.maxPureLines}`);
        } else if (lineCount > budget.newModuleMaxPureLines) {
            failures.push(`${relative}: ${lineCount} pure lines exceeds new-module limit ${budget.newModuleMaxPureLines}`);
        }
        const uses = globalUses(source);
        if (ENTRY_PATHS.has(relative)) {
            for (const name of uses) if (!ENTRY_GLOBALS.has(name)) failures.push(`${relative}: forbidden browser global '${name}' in entry adapter`);
        } else if (relative === MONOLITH_PATH) {
            for (const name of uses) {
                if (name === 'GM_* host API' || name === '__TAA_TEST_HOOK__' || MONOLITH_GLOBALS.has(name)) continue;
                failures.push(`${relative}: forbidden browser global '${name}' outside monolith lifecycle surface`);
            }
        } else if (uses.length) {
            failures.push(`${relative}: forbidden browser global '${uses[0]}' in pure module`);
        }
    }
    if (monolithLines === null) failures.push(`${MONOLITH_PATH}: monolith module is missing`);
    for (const file of sourceFiles) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        if (!declaredModules.has(relative)) failures.push(`${relative}: missing module manifest entry`);
    }
    if (hasCycle(dependencyGraph(sourceFiles))) failures.push('module dependency cycle');
    if (failures.length) throw new Error(`quality gate failed: ${failures.join('; ')}`);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, gate: gate || 'todo11', newModuleMaxPureLines: budget.newModuleMaxPureLines, monolith: { path: budget.monolith.path, budget: budget.monolith.maxPureLines, actual: monolithLines }, exceptions: exceptions.length, verdict: 'PASS' }) + '\n');
}
if (require.main === module) check(process.argv.includes('--gate') ? process.argv[process.argv.indexOf('--gate') + 1] : undefined);
module.exports = { check, pureLines };
