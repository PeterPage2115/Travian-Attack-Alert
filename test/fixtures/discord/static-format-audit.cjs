'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const canonical = require('./canonical.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const IDS = ['broad-mention-parse', 'missing-footer-accounting', 'duplicate-payload-builder', 'duplicate-partition-seam', 'duplicate-cost-seam', 'multiple-live-payload-call-sites'];

function bodyOfFunction(source, name) {
    const start = source.indexOf(`function ${name}`);
    if (start < 0) return '';
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    return source.slice(open);
}

function hasMentionParse(source) {
    const objects = source.match(/\{[^{}]*\}/g) || [];
    if (objects.some(object => {
        const parse = object.search(/\bparse\s*[:=]/);
        if (parse < 0) return false;
        if (/\bparse\s*[:=]\s*\[\s*\]/.test(object)) return false;
        return ['users', 'roles', 'content'].some(key => {
            const mention = object.search(new RegExp(`\\b${key}\\b`));
            return mention >= 0 && Math.abs(mention - parse) <= 200;
        });
    })) return true;
    return /allowed_mentions\s*:\s*\{[^{}]{0,200}['"]parse['"]\s*[:=]/.test(source);
}

function hasContentAndEmbeds(source) {
    return /\{[^{}]*\bcontent\b[^{}]*\bembeds\b[^{}]*\}/.test(source) || /\{[^{}]*\bembeds\b[^{}]*\bcontent\b[^{}]*\}/.test(source);
}

function readmeMarkerBytes(readmePath) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const startMarker = '<!-- discord-alert-example:start -->';
    const endMarker = '<!-- discord-alert-example:end -->';
    if (readme.split(startMarker).length !== 2 || readme.split(endMarker).length !== 2) {
        return { ok: false, reason: 'README markers must occur exactly once' };
    }
    const start = readme.indexOf(startMarker) + startMarker.length;
    const end = readme.indexOf(endMarker);
    if (readme[start] !== '\n' || readme[end - 1] !== '\n') {
        return { ok: false, reason: 'README marker block must have one boundary newline' };
    }
    return { ok: true, value: readme.slice(start + 1, end - 1) };
}

function checkReadme(readmePath) {
    try {
        const actual = readmeMarkerBytes(readmePath);
        const expected = canonical.serializePayloadsForDocumentation(
            canonical.payloadsForCase('raid-two')
        );
        return {
            pass: actual.ok && actual.value === expected,
            expected,
            actual: actual.ok ? actual.value : null,
            reason: actual.ok && actual.value === expected
                ? 'README marker bytes equal canonical raid-two payload serialization'
                : actual.reason || 'README marker bytes differ from canonical payload serialization'
        };
    } catch (error) {
        return { pass: false, expected: null, actual: null, reason: error.message };
    }
}

function audit(file, runTests, readmePath = null) {
    const source = fs.readFileSync(file, 'utf8');
    const findings = [];
    const definitions = name => (source.match(new RegExp(`function\\s+${name}\\s*\\(`, 'g')) || []).length;
    if (definitions('buildDiscordPayloads') !== 1) findings.push({ id: 'duplicate-payload-builder', reason: 'expected exactly one definition' });
    if (definitions('partitionCompactDiscordEntries') !== 1) findings.push({ id: 'duplicate-partition-seam', reason: 'expected exactly one definition' });
    if (definitions('measureDiscordEmbedText') !== 1) findings.push({ id: 'duplicate-cost-seam', reason: 'expected exactly one definition' });
    const send = bodyOfFunction(source, 'sendDiscordBatch');
    if ((send.match(/buildDiscordPayloads\s*\(/g) || []).length > 1 || hasContentAndEmbeds(send)) findings.push({ id: 'multiple-live-payload-call-sites', reason: 'sendDiscordBatch has multiple payload construction paths' });
    const legacyLabel = /Legacy\s/.test(source) && !/name\s*:\s*['"]Legacy\s/.test(source);
    if (legacyLabel || hasMentionParse(source)) findings.push({ id: 'broad-mention-parse', reason: 'legacy or broad mention mode remains' });
    const measure = bodyOfFunction(source, 'measureDiscordEmbedText');
    if (!/title/.test(measure) || !/description/.test(measure) || !/field/.test(measure) || !/footer/.test(measure)) findings.push({ id: 'missing-footer-accounting', reason: 'text accounting is incomplete' });
    const readme = readmePath ? checkReadme(readmePath) : null;
    if (readme && !readme.pass) findings.push({ id: 'readme-canonical-bytes', reason: readme.reason });
    const commands = [];
    const syntax = spawnSync(process.execPath, ['-e', `new Function(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    commands.push({ command: ['node', '-e', 'new Function(read file)'], exitCode: syntax.status === null ? 1 : syntax.status });
    if (runTests) {
        const tests = spawnSync(process.execPath, ['--test', 'test/script.test.cjs'], { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
        commands.push({ command: ['node', '--test', 'test/script.test.cjs'], exitCode: tests.status === null ? 1 : tests.status });
    }
    const verdict = findings.length === 0 && commands.every(command => command.exitCode === 0) ? 'PASS' : 'FAIL';
    return { verdict, findings, commands, ...(readme ? { readme } : {}) };
}

function selfTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-audit-'));
    try {
        const file = path.join(dir, 'synthetic.js');
        fs.writeFileSync(file, `function buildDiscordPayloads(){return {}} function buildDiscordPayloads(){return {}} function partitionCompactDiscordEntries(){} function partitionCompactDiscordEntries(){} function measureDiscordEmbedText(){return 'title description field'} function measureDiscordEmbedText(){return 'title description field'} function sendDiscordBatch(){buildDiscordPayloads(); buildDiscordPayloads(); const payload={content:'x',embeds:[]};} const wrapper={allowed_mentions: {'parse':'users',users:[]}}; const Legacy = true;`);
        const result = audit(file, false);
        const ids = result.findings.map(f => f.id).sort((a, b) => IDS.indexOf(a) - IDS.indexOf(b));
        if (ids.join(',') !== IDS.join(',')) throw new Error(`unexpected self-test IDs: ${ids.join(',')}`);
        process.stdout.write(`${JSON.stringify({ verdict: 'PASS', findings: result.findings })}\n`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    try {
        const args = process.argv.slice(2);
        if (args.includes('--self-test')) selfTest();
        else {
            const index = args.indexOf('--file');
            if (index < 0 || !args[index + 1]) throw new Error('--file is required');
            const readmeIndex = args.indexOf('--readme');
            const readmePath = readmeIndex >= 0 && args[readmeIndex + 1]
                ? path.resolve(ROOT, args[readmeIndex + 1])
                : null;
            const result = audit(path.resolve(ROOT, args[index + 1]), args.includes('--run-tests'), readmePath);
            process.stdout.write(`${JSON.stringify(result)}\n`);
            if (result.verdict !== 'PASS') process.exitCode = 1;
        }
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
