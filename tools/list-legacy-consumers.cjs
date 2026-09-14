'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Needles are assembled so this scanner never matches its own source.
const NEEDLES = Object.freeze(['legacy' + '-bridge', 'script' + '.txt']);

// Files whose only references are intentional and frozen: historical records
// or negative guards this migration must not rewrite. They are reported
// separately (never as actionable consumers).
const EXCLUSIONS = Object.freeze({
  'test/runtime-parity.test.cjs': 'frozen Todo-3 oracle guard comment; Task 10 must not modify this file',
  'test/tools/userscript-build-contract.test.cjs': 'negative deletion guards asserting the old authority is gone; Task 10 must not modify this file',
  'docs/AUDIT.md': 'frozen 1.0.0 behavior audit; colon cites are historical code pointers framed by the layout note',
});

function categoryFor(file) {
  if (file === 'AGENTS.md' || file === 'DESIGN.md') return 'governance';
  if (file === 'package.json') return 'package-scripts';
  if (file === 'metadata.json' || file === 'module-manifest.json' || file.endsWith('.sha256')) {
    return 'metadata-manifests';
  }
  if (file.startsWith('tools/')) return 'tools';
  if (file.startsWith('test/')) return 'tests-fixtures';
  if (file.startsWith('docs/') || /^(?:CHANGELOG|README)(?:\.[^/]+)?$/u.test(file)) return 'docs';
  if (file.startsWith('src/')) return 'source';
  return 'repository-metadata';
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_MASTER: '1' }
  }).split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'));
}

function readTrackedText(file) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.lstatSync(absolute);
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(absolute), 'utf8')
    : fs.readFileSync(absolute);
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function referencesIn(file, source) {
  const references = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const matches = NEEDLES.filter(needle => line.includes(needle));
    if (matches.length === 0) continue;
    references.push({ line: index + 1, matches });
  }
  return references;
}

function inventory() {
  const consumers = [];
  const exclusions = [];
  for (const file of trackedFiles()) {
    const source = readTrackedText(file);
    if (source === null) continue;
    const references = referencesIn(file, source);
    if (references.length === 0) continue;
    if (Object.hasOwn(EXCLUSIONS, file)) {
      exclusions.push({ path: file, reason: EXCLUSIONS[file], references });
      continue;
    }
    consumers.push({ category: categoryFor(file), path: file, references });
  }

  const categories = [...new Set(consumers.map(consumer => consumer.category))].sort();
  return {
    schemaVersion: 1,
    needles: [...NEEDLES],
    summary: {
      consumerCount: consumers.length,
      referenceCount: consumers.reduce((count, consumer) => count + consumer.references.length, 0),
      categories
    },
    consumers,
    exclusions
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(inventory(), null, 2)}\n`);

module.exports = { categoryFor, inventory, readTrackedText, referencesIn, trackedFiles };
