#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('./evidence-cases.cjs');

function resolveCase(selection) {
    if (selection.task !== undefined) {
        const value = registry.tasks[selection.task];
        if (!value) throw new Error(`unknown task: ${selection.task}`);
        return { id: selection.task, ...value };
    }
    const value = registry.finals[selection.final];
    if (!value) throw new Error(`unknown final: ${selection.final}`);
    return { id: selection.final, ...value };
}

function runCase(name, definition) {
    const result = spawnSync(definition.command, definition.args, { cwd: path.resolve(__dirname, '..', '..', '..'), shell: false, encoding: 'utf8' });
    const artifacts = definition.artifacts.map(file => ({ file, exists: fs.existsSync(path.resolve(__dirname, '..', '..', '..', file)) }));
    let evidence = null;
    try { evidence = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || ''); } catch {}
    return { name, pass: result.status === 0 && artifacts.every(item => item.exists), command: [definition.command, ...definition.args], exitCode: result.status, artifacts, evidence };
}

function parseArgs(args) {
    const selection = {};
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--task') selection.task = Number(args[++index]);
        if (args[index] === '--final') selection.final = args[++index];
        if (args[index] === '--out') selection.out = args[++index];
    }
    return selection;
}

function run(selection) {
    const definition = resolveCase(selection);
    const happy = runCase('happy', definition.happy);
    const failure = runCase('failure', definition.failure);
    const verdict = happy.pass && failure.pass ? 'PASS' : 'FAIL';
    const result = selection.final === 'F1'
        ? { schemaVersion: 1, reviewer: 'oracle', final: 'F1', mustHavePassed: happy.evidence?.mustHavePassed || [], mustNotPassed: happy.evidence?.mustNotPassed || [], openFindings: happy.evidence?.openFindings || [], happy, failure, verdict: verdict === 'PASS' ? 'APPROVE' : 'BLOCK' }
        : selection.final === 'F2'
            ? { schemaVersion: 1, reviewer: 'quality-security', final: 'F2', findings: happy.evidence?.privacy?.violations || [], happy, failure, verdict: verdict === 'PASS' ? 'APPROVE' : 'BLOCK' }
        : selection.final === 'F3'
            ? { schemaVersion: 1, reviewer: 'browser-qa', final: 'F3', happy, failure, verdict: verdict === 'PASS' ? 'APPROVE' : 'BLOCK' }
            : selection.final === 'F4'
                ? { schemaVersion: 1, reviewer: 'scope-rollback-operations', final: 'F4', findings: happy.evidence?.scope?.findings || [], rawCapture: happy.evidence?.scope?.rawCapture || [], historicalEvidenceUntouched: happy.evidence?.historicalEvidenceUntouched === true, distributables: happy.evidence?.scope?.distributables || [], happy, failure, verdict: verdict === 'PASS' ? 'APPROVE' : 'BLOCK' }
            : { schemaVersion: 1, task: selection.task, happy, failure, verdict };
    if (selection.out) {
        fs.mkdirSync(path.dirname(path.resolve(selection.out)), { recursive: true });
        fs.writeFileSync(selection.out, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
}

if (require.main === module) {
    try { process.stdout.write(`${JSON.stringify(run(parseArgs(process.argv.slice(2))), null, 2)}\n`); process.exitCode = 0; }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, resolveCase, run, runCase };
