#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, '.omo/evidence/stabilizacja-akwizycji-atakow/f3-browser-qa-run.json');
function run(grep) {
  const server = cp.spawn(process.execPath, ['test/fixtures/panel/server.cjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: '8899' } });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { require('node:child_process').execFileSync('curl', ['-fsS', 'http://127.0.0.1:8899/health'], { stdio: 'ignore' }); break; } catch { /* wait for loopback fixture */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    const result = cp.spawnSync('npx', ['playwright', 'test', '--config', 'test/e2e/playwright.config.ts', 'test/e2e/f3-browser-qa.spec.ts', '--grep', grep, '--reporter=json'], { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    server.kill('SIGTERM');
  }
}
function main() {
  const mode = process.argv[2];
  const result = mode === '--happy' ? run('F3 happy|canonical authority|serialized contenders|readiness|multi-chunk acknowledged|429 retry identity|attack panel|count reconciliation|incident bundle|reduced motion|200% zoom') : mode === '--failure' ? run('F3 failure|noncanonical inert|query rejected|crash windows|malformed 200|permanent 4xx|response lost|lease lost|diagnostics corrupted|incident redaction') : null;
  if (!result) throw new Error('usage: --happy | --failure');
  const runEvidence = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const screenshots = fs.readdirSync(path.dirname(OUT)).filter(file => /^f3-synthetic-.*\.png$/.test(file));
  const happy = mode === '--happy' ? { pass: result.exitCode === 0 && runEvidence.hooks === true && runEvidence.envelope === true && runEvidence.requests === true && runEvidence.export === true && runEvidence.axe === true && screenshots.length > 0, commandExitCode: result.exitCode, screenshots, fields: runEvidence } : undefined;
  const failure = mode === '--failure' ? { pass: result.exitCode === 0 && runEvidence.pass === true && runEvidence.falseSuccesses === 0, commandExitCode: result.exitCode, outcomes: runEvidence.outcomes || null } : undefined;
  process.stdout.write(`${JSON.stringify(mode === '--happy' ? { happy, scenarios: runEvidence.scenarios || [] } : { failure })}\n`);
  process.exitCode = (mode === '--happy' ? happy.pass : failure.pass) ? 0 : 1;
}
try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
