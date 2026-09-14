'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SLUG = 'redesign-discord-alert-format';
const IDS = ['MH-grammar', 'MH-links', 'MH-fields', 'MH-rows', 'MH-time', 'MH-mentions', 'MH-limits', 'MH-packing', 'MH-docs', 'MH-preview', 'MN-scope', 'MN-security', 'MN-no-deps', 'MN-dead-cleanup'];
const taskChecks = { 1: ['MH-grammar', 'MH-links', 'MH-fields', 'MH-rows', 'MH-time'], 2: ['MH-limits', 'MH-packing', 'MH-rows'], 3: ['MH-mentions', 'MH-limits'], 4: ['MH-preview'], 5: ['MH-docs'] };
const cases = ['raid-two', 'attack-mixed-six', 'roster', 'players-60', 'forced-split', 'unicode-overflow'];
const widths = [360, 550];

function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function exists(file) { return fs.existsSync(file); }
function names(root) {
    const p = prefix => path.join(root, `${prefix}-${SLUG}`);
    const label = file => root === path.resolve(ROOT, '.omo/evidence')
        ? path.posix.join('.omo/evidence', path.basename(file))
        : path.resolve(file);
    return {
        baseline: [path.join(root, `baseline-${SLUG}.json`), path.join(root, `baseline-${SLUG}.tap`)],
        tasks: {
            1: { json: path.join(root, `task-1-${SLUG}.json`), artifacts: [] },
            2: { json: path.join(root, `task-2-${SLUG}.json`), artifacts: [] },
            3: { json: path.join(root, `task-3-${SLUG}.json`), artifacts: [label(path.join(root, `task-3-${SLUG}-regression.tap`))] },
            4: { json: path.join(root, `task-4-${SLUG}.json`), artifacts: [label(path.join(root, `task-4-${SLUG}-server.log`)), label(path.join(root, `task-4-${SLUG}-server-start.json`)), label(path.join(root, `task-4-${SLUG}-server-stop.json`)), label(path.join(root, `task-4-${SLUG}-server-terminal.json`)), label(path.join(root, `task-4-${SLUG}-visual-qa.json`)), ...cases.flatMap(c => widths.map(w => label(path.join(root, `task-4-${SLUG}-case-${c}-${w}.png`))))] },
            5: { json: path.join(root, `task-5-${SLUG}.json`), artifacts: [label(path.join(root, `task-5-${SLUG}-regression.tap`))] }
        },
        prefix: p
    };
}

function run(command, args) { const r = spawnSync(process.execPath, args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 }); return r.status === 0; }
function securityFilesWithContent() {
    const files = [];
    const visit = (file, depth) => {
        if (depth > 20 || !fs.existsSync(file)) return;
        const stat = fs.statSync(file);
        if (stat.isFile()) {
            files.push(file);
            return;
        }
        if (stat.isDirectory() && path.basename(file) !== 'node_modules') for (const child of fs.readdirSync(file)) visit(path.join(file, child), depth + 1);
    };
    for (const item of ['README.md', 'src/runtime.js', 'test', '.omo/evidence']) visit(path.join(ROOT, item), 0);
    return files;
}
function classifyWebhookMatch(match) {
    const parts = match.split('/');
    const id = parts[parts.length - 2];
    const token = parts[parts.length - 1].toLowerCase();
    const obviousToken = new Set(['abc', 'token', 't']).has(token) || token.startsWith('abc') || token.includes('fake') || token.includes('test_only');
    const repeated = /^(\d)\1+$/.test(id) && /^(.)\1+$/.test(token);
    return obviousToken || repeated ? 'FAKE' : 'REAL-looking';
}
function check(root, skipSpawns = false) {
    const manifest = names(root); const missing = [...manifest.baseline];
    for (const task of Object.values(manifest.tasks)) { missing.push(task.json, ...task.artifacts); }
    const absent = missing.filter(file => !exists(file));
    const rows = [];
    for (const id of IDS) rows.push({ id, status: 'FAIL', reason: 'predicate not satisfied' });
    const set = (id, ok, reason) => { const row = rows.find(item => item.id === id); row.status = ok ? 'PASS' : 'FAIL'; row.reason = reason; };
    for (let task = 1; task <= 5; task += 1) {
        const entry = manifest.tasks[task]; const value = json(entry.json);
        const artifactNames = entry.artifacts;
        const valid = value && value.schemaVersion === 1 && value.task === task && value.verdict === 'PASS' && value.happy?.pass === true && value.failure?.pass === true && JSON.stringify(value.artifacts) === JSON.stringify(artifactNames) && taskChecks[task].every(id => value.checks && value.checks[id] === true);
        for (const id of taskChecks[task]) set(id, valid, valid ? `task ${task} JSON and checks PASS` : `task ${task} JSON predicate failed`);
    }
    const baseline = json(manifest.baseline[0]);
    const packagePath = path.join(ROOT, 'package.json');
    const packageEntry = baseline?.files?.find(file => file.path === 'package.json');
    const packageText = fs.existsSync(packagePath) ? fs.readFileSync(packagePath, 'utf8') : '';
    set('MN-no-deps', Boolean(packageEntry && crypto.createHash('sha256').update(packageText).digest('hex') === packageEntry.sha256 && !json(packagePath)?.dependencies && !json(packagePath)?.devDependencies), 'package hash and dependency keys');
    const secret = /discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+/g;
    const violations = [];
    for (const file of securityFilesWithContent()) {
        const matches = fs.readFileSync(file, 'utf8').match(secret) || [];
        if (matches.some(match => classifyWebhookMatch(match) === 'REAL-looking')) violations.push(path.resolve(file));
    }
    set('MN-security', violations.length === 0, violations.length > 0 ? `real-looking webhook literal found in: ${violations.join(', ')}` : 'no real-looking webhook literal found');
    const commands = [
        { command: 'node -e "new Function(require(\'fs\').readFileSync(\'src/runtime.js\',\'utf8\'))"', args: ['-e', "new Function(require('fs').readFileSync('src/runtime.js','utf8'))"] },
        { command: 'node --test test/script.test.cjs', args: ['--test', 'test/script.test.cjs'] },
        { command: 'npm test', args: ['npm', 'test'] }
    ];
    if (!skipSpawns) {
        const temp = path.join(os.tmpdir(), `taa-scope-${process.pid}-${Date.now()}.json`); let scope = false;
        try {
            const snapshot = spawnSync(process.execPath, ['.omo/evidence/workspace-manifest-redesign-discord-alert-format.cjs', '--snapshot'], { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
            if (snapshot.status === 0) { fs.writeFileSync(temp, snapshot.stdout); scope = run('manifest', ['.omo/evidence/workspace-manifest-redesign-discord-alert-format.cjs', '--verify', manifest.baseline[0], temp]); }
        } catch (_) { scope = false; } finally { if (exists(temp)) fs.rmSync(temp, { force: true }); }
        set('MN-scope', scope, scope ? 'fresh manifest verification PASS' : 'fresh manifest verification failed');
        const audit = spawnSync(process.execPath, ['test/fixtures/discord/static-format-audit.cjs', '--file', 'src/runtime.js'], { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
        let auditPass = false; try { auditPass = audit.status === 0 && JSON.parse(audit.stdout).verdict === 'PASS' && JSON.parse(audit.stdout).findings.length === 0; } catch (_) {}
        set('MN-dead-cleanup', auditPass, auditPass ? 'static audit PASS' : 'static audit failed');
        for (const item of commands) {
            let spawned = spawnSync(item.args[0] === 'npm' ? item.args[0] : process.execPath, item.args[0] === 'npm' ? item.args.slice(1) : item.args, { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
            if (item.args[0] === 'npm' && spawned.error?.code === 'ENOENT') spawned = spawnSync('npm', item.args.slice(1), { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
            item.exitCode = spawned.status === null ? 1 : spawned.status;
        }
    } else {
        set('MN-scope', true, 'self-test spawn skipped'); set('MN-dead-cleanup', true, 'self-test spawn skipped');
        for (const item of commands) item.exitCode = 0;
    }
    const result = { schemaVersion: 1, slug: SLUG, rows, missing: absent.map(file => path.resolve(file)), commands: commands.map(({ command, exitCode }) => ({ command, exitCode })), verdict: absent.length === 0 && rows.every(row => row.status === 'PASS') && commands.every(command => command.exitCode === 0) ? 'PASS' : 'FAIL' };
    return result;
}

function selfTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-evidence-'));
    try {
        const fakeMatches = [
            ['https://discord', '.com/api/webhooks/', '123', '/token'].join(''),
            ['https://discord', '.com/api/webhooks/', '123456789', '/abcDEF-token'].join(''),
            ['https://discord', '.com/api/webhooks/', '987', '/fake_token_test_only'].join(''),
            ['https://discord', '.com/api/webhooks/', '111111111111111111', '/aaaa'].join('')
        ];
        const realistic = ['https://discord', '.com/api/webhooks/', '987654321012345678', '/', 'xK9mP2qR7wL4vN8z'].join('');
        if (fakeMatches.some(match => classifyWebhookMatch(match) !== 'FAKE') || classifyWebhookMatch(realistic) !== 'REAL-looking') throw new Error('MN-security classifier self-test failed');
        const manifest = names(dir); fs.writeFileSync(manifest.baseline[0], JSON.stringify({ schemaVersion: 1, files: [{ path: 'package.json', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package.json'))).digest('hex') }] })); fs.writeFileSync(manifest.baseline[1], 'TAP version 13\n1..0\n');
        for (let task = 1; task <= 5; task += 1) { if (task === 3) continue; const entry = manifest.tasks[task]; for (const file of entry.artifacts) fs.writeFileSync(file, file.endsWith('.png') ? Buffer.from([137, 80, 78, 71]) : 'artifact\n'); fs.writeFileSync(entry.json, JSON.stringify({ schemaVersion: 1, task, verdict: 'PASS', happy: { pass: true }, failure: { pass: true }, artifacts: entry.artifacts.slice().sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), checks: Object.fromEntries(taskChecks[task].map(id => [id, true])) })); }
        const result = check(dir, true); const expected = path.resolve(dir, `task-3-${SLUG}.json`); if (result.verdict !== 'FAIL' || !result.missing.includes(expected)) throw new Error('missing task-3 contract self-test failed'); process.stdout.write(`${JSON.stringify({ verdict: 'PASS', nested: result })}\n`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    try { const args = process.argv.slice(2); if (args.includes('--self-test')) selfTest(); else { const i = args.indexOf('--check'); if (i < 0 || !args[i + 1]) throw new Error('--check requires a directory'); const result = check(path.resolve(ROOT, args[i + 1])); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.verdict === 'PASS' ? 0 : 1; } } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
