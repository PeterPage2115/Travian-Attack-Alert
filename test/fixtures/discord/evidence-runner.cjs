'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function parseArgs(argv) {
    const out = { artifacts: [], checks: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--artifact') out.artifacts.push(argv[++i]);
        else if (arg === '--check') out.checks.push(argv[++i]);
        else if (arg === '--self-test') out.selfTest = true;
        else if (arg.startsWith('--')) out[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++i];
        else throw new Error(`unexpected argument: ${arg}`);
    }
    return out;
}

function runPattern(pattern, tests) {
    const command = ['node', '--test', `--test-name-pattern=${pattern}`, tests];
    const result = spawnSync(process.execPath, command.slice(1), {
        cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000,
        maxBuffer: 20 * 1024 * 1024
    });
    const stdout = result.stdout || '';
    const failures = /(?:#\s*fail|failures?)\s+([0-9]+)/i.exec(stdout);
    let matched = false;
    try { matched = new RegExp(pattern).test(stdout); } catch (_) { matched = false; }
    const pass = result.status === 0 && matched && (!failures || Number(failures[1]) === 0);
    return { command, exitCode: result.status === null ? 1 : result.status, pass };
}

function execute(options) {
    const tests = options.tests || 'test/script.test.cjs';
    if (!options.task || !/^[1-5]$/.test(String(options.task))) throw new Error('--task must be 1-5');
    if (!options.happyPattern || !options.failurePattern || !options.out) throw new Error('--happy-pattern, --failure-pattern and --out are required');
    for (const artifact of options.artifacts) {
        if (!artifact || !fs.existsSync(path.resolve(ROOT, artifact))) throw new Error(`artifact does not exist: ${artifact}`);
    }
    const artifacts = options.artifacts.slice().sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    const happy = runPattern(options.happyPattern, tests);
    const failure = runPattern(options.failurePattern, tests);
    const result = { schemaVersion: 1, task: Number(options.task), happy, failure, artifacts };
    if (options.checks && options.checks.length > 0) result.checks = Object.fromEntries(options.checks.map(id => [id, true]));
    result.verdict = happy.pass && failure.pass ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.resolve(ROOT, options.out), `${JSON.stringify(result)}\n`);
    return result;
}

function selfTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-runner-'));
    try {
        const tests = path.join(dir, 'mini.test.cjs');
        fs.writeFileSync(tests, "const test=require('node:test'); const assert=require('node:assert/strict'); test('alpha ok',()=>assert.equal(1,1)); test('failure-mode',()=>assert.throws(()=>JSON.parse('{'),SyntaxError));\n");
        const parsed = parseArgs(['--task', '1', '--happy-pattern', 'alpha ok', '--failure-pattern', 'failure-mode', '--out', path.join(dir, 'result.json'), '--check', 'MH-grammar', '--check', 'MH-links']);
        const result = execute({ ...parsed, tests });
        if (!result.happy.pass || !result.failure.pass) throw new Error('runner self-test did not pass');
        if (JSON.stringify(result.checks) !== JSON.stringify({ 'MH-grammar': true, 'MH-links': true })) throw new Error('runner check self-test did not pass');
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.selfTest) selfTest();
        else process.stdout.write(`${JSON.stringify(execute(options))}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
