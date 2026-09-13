#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const SLUG = 'repair-launcher-panel-and-discord-alerts';
const TASK_ARTIFACTS = { 1: ['json', 'tap'], 2: ['json', 'png'], 3: ['json', 'png'], 4: ['json', 'tap'], 5: ['json', 'png'], 6: ['json', 'png'], 7: ['json', 'tap'], 8: ['json', 'tap', 'png'] };
const FINAL_ARTIFACTS = ['f1-plan-compliance-review.json', 'f2-code-quality-security-review.json', 'f3-real-manual-qa.json', 'f4-visual-accessibility-qa.json', 'f5-scope-evidence-review.json', 'visual-input-repair-launcher-panel-and-discord-alerts.json'];

function write(file, value) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function checked(plan, label) { const re = new RegExp(`^- \\[x\\]\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.|\\s)`, 'mi'); return re.test(plan); }
function command(command, cwd) { const result = cp.spawnSync(command, { cwd, shell: true, encoding: 'utf8' }); return { command, exitCode: typeof result.status === 'number' ? result.status : 1 }; }
function check(options) {
    const plan = fs.readFileSync(options.plan, 'utf8'); const repo = path.resolve(__dirname, '../../..'); const checks = []; const missing = []; const commands = [];
    const add = (id, pass) => checks.push({ id, pass: Boolean(pass) }); const need = (id, file) => { const pass = fs.existsSync(path.join(options.attempt, file)); add(id, pass); if (!pass) missing.push(id); };
    try { const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8')); add('manifest-readable', manifest.schemaVersion === 1 && manifest.slug === SLUG && Array.isArray(manifest.files)); } catch { add('manifest-readable', false); missing.push('manifest-readable'); }
    if (options.phase === 'tasks') {
        for (let n = 1; n <= 8; n += 1) { add(`todo-${n}-checked`, checked(plan, `${n}`)); for (const ext of TASK_ARTIFACTS[n]) need(`todo-${n}-artifact`, `task-${n}-${SLUG}.${ext}`); }
    } else {
        for (let n = 1; n <= 5; n += 1) add(`f${n}-checked`, checked(plan, `F${n}`));
        for (const file of FINAL_ARTIFACTS) need(file.replace('.json', ''), file);
        const visual = JSON.parse(fs.readFileSync(path.join(options.attempt, 'visual-input-repair-launcher-panel-and-discord-alerts.json'), 'utf8'));
        add('visual-input-shape', Array.isArray(visual.panel) && Array.isArray(visual.discord));
    }
    const parse = command('node -e "new Function(require(\'fs\').readFileSync(\'script.txt\',\'utf8\'))"', repo); const nodeTest = command('node --test test/script.test.cjs', repo); const npmTest = command('npm test', repo);
    for (const item of [parse, nodeTest, npmTest]) { commands.push(item); add(item.command.includes('new Function') ? 'cmd-parse' : item.command === 'npm test' ? 'cmd-npm-test' : 'cmd-node-test', item.exitCode === 0); }
    const recorded = []; for (let n = 1; n <= 8; n += 1) { const file = path.join(options.attempt, `task-${n}-${SLUG}.json`); if (!fs.existsSync(file)) continue; try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(value.commands)) for (const item of value.commands) if (typeof item.command === 'string' && typeof item.exitCode === 'number') recorded.push(item); } catch { add(`todo-${n}-json-valid`, false); } }
    for (const item of recorded) { const id = item.command.includes('npm test') ? 'cmd-npm-test' : item.command.includes('node --test') ? 'cmd-node-test' : item.command.includes('new Function') ? 'cmd-parse' : null; if (id && item.exitCode !== 0) add(id, false); }
    for (const n of [3, 5, 6, 8]) { const file = path.join(options.attempt, `task-${n}-${SLUG}.json`); if (!fs.existsSync(file)) continue; try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if ('portClosed' in value) add('preview-lifecycle-closed', value.portClosed === true); } catch {} }
    const scope = path.join(options.attempt, 'f5-scope-manifest.json'); if (fs.existsSync(scope)) { try { const value = JSON.parse(fs.readFileSync(scope, 'utf8')); add('f5-scope-clean', Array.isArray(value.unexpectedChanges) && value.unexpectedChanges.length === 0 && Array.isArray(value.protectedChanges) && value.protectedChanges.length === 0); } catch { add('f5-scope-clean', false); } }
    const uniqueMissing = [...new Set(missing)]; const verdict = checks.every((item) => item.pass) ? 'PASS' : 'FAIL'; return { schemaVersion: 1, slug: SLUG, phase: options.phase, checks, missing: uniqueMissing, commands, verdict };
}
function selfTest(out) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${SLUG}-verifier-`)); let result;
    try {
        const plan = path.join(temp, 'plan.md'); const lines = ['# Plan']; for (let n = 1; n <= 8; n += 1) lines.push(`- [x] ${n}. Todo ${n}`); for (let n = 1; n <= 5; n += 1) lines.push(`- [x] F${n}. Final ${n}`); fs.writeFileSync(plan, `${lines.join('\n')}\n`);
        const manifest = path.join(temp, 'baseline.json'); fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, slug: SLUG, files: [] }));
        for (let n = 1; n <= 8; n += 1) for (const ext of TASK_ARTIFACTS[n]) if (!(n === 2 && ext === 'png')) fs.writeFileSync(path.join(temp, `task-${n}-${SLUG}.${ext}`), ext === 'json' ? JSON.stringify({ commands: n === 1 ? [{ command: 'npm test', exitCode: 9 }] : [] }) : 'fixture');
        const failed = check({ attempt: temp, plan, manifest, phase: 'tasks' }); if (failed.verdict !== 'FAIL' || !failed.missing.includes('todo-2-artifact') || !failed.checks.some((x) => x.id === 'cmd-npm-test' && !x.pass)) throw new Error('verifier failure scenario was not detected');
        fs.writeFileSync(path.join(temp, `task-2-${SLUG}.png`), 'fixture'); fs.writeFileSync(path.join(temp, `task-1-${SLUG}.json`), JSON.stringify({ commands: [{ command: 'npm test', exitCode: 0 }] })); const passed = check({ attempt: temp, plan, manifest, phase: 'tasks' }); if (passed.verdict !== 'PASS') throw new Error(`verifier complete scenario failed: ${JSON.stringify(passed)}`);
        result = { schemaVersion: 1, verdict: 'PASS', detectedChecks: ['todo-2-artifact', 'cmd-npm-test'], scenarios: ['FAIL', 'PASS'], cleanup: 'complete' };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); if (result) write(out, result); }
}
function main() { const args = process.argv.slice(2); if (args.length === 0 || args.includes('--test')) return; const get = (f) => { const i = args.indexOf(f); if (i < 0 || !args[i + 1]) throw new Error(`missing ${f}`); return args[i + 1]; }; if (args[0] === '--self-test') selfTest(get('--out')); else if (args[0] === '--check') { const result = check({ attempt: get('--check'), plan: get('--plan'), manifest: get('--manifest'), phase: get('--phase') }); write(get('--out'), result); if (result.verdict !== 'PASS') process.exitCode = 1; } else throw new Error('usage: --check ... | --self-test --out JSON'); }
try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 2; }
