#!/usr/bin/env node
'use strict';

/**
 * Per-spec Playwright runner (plan Todo 6).
 *
 * Runs each test/e2e/*.spec.ts in its own Playwright invocation with the
 * JSON reporter captured to a SEPARATE file:
 *   test-results/release-1.0.0/e2e-report-<spec>.spec.json
 *
 * Never writes the shared test-results/e2e-runtime.json (specs themselves
 * write namespaced e2e-evidence-*.json files under release-1.0.0/).
 *
 * Browser probe first: if no Chromium binary is installed, the run is
 * honestly reported as NOT EXECUTED (no speculative multi-hundred-MB
 * download) and exits 0 so offline environments stay usable. Any spec
 * failure exits nonzero.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-results', 'release-1.0.0');

function chromiumBinaryPresent() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    if (entries.some((e) => e.startsWith('chromium-') && !e.includes('headless_shell'))) return true;
  }
  return false;
}

function main() {
  const specs = fs.readdirSync(path.join(ROOT, 'test', 'e2e'))
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((f) => path.join('test', 'e2e', f));
  if (!chromiumBinaryPresent()) {
    console.log('e2e: NOT EXECUTED (no browser binary in Playwright cache; browsers were not downloaded)');
    process.exit(0);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = 0;
  for (const spec of specs) {
    const base = path.basename(spec, '.spec.ts');
    const report = path.join(OUT_DIR, `e2e-report-${base}.spec.json`);
    console.log(`e2e: running ${spec} -> ${path.relative(ROOT, report)}`);
    const result = spawnSync(
      'npx',
      ['playwright', 'test', spec, '--config', 'test/e2e/playwright.config.ts', '--reporter=json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    fs.writeFileSync(report, `${result.stdout || ''}`);
    if (result.stderr) process.stderr.write(result.stderr);
    console.log(`e2e: ${spec} exit ${result.status}`);
    if (result.status !== 0) failed = 1;
  }
  process.exit(failed);
}

main();
