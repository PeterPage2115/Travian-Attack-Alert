'use strict';

// Characterization: runtime aggregator cutover (plan Todo 17).
//
// Pins the 325-export public surface and proves that:
// 1. src/runtime-api.js exposes the 13 domains without select() indirection
//    and without depending on src/runtime.js.
// 2. runtime-api re-exports are reference-equal to the domain facades.
// 3. src/runtime.js retains the pinned literals, boot effects, storage keys,
//    menu commands, release identity, timing constants, and mutable singletons
//    that the frozen contract tool reads from source text.
//
// TDD: the runtime-api-structure assertions fail while runtime-api.js
// still uses select() and depends on runtime.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const oracle = require(path.join(ROOT, 'test', 'fixtures', 'contracts', 'runtime-contract.json'));

const DOMAIN_FACADES = [
  'storage.js', 'lease.js', 'parser.js', 'snapshot.js',
  'envelope.js', 'migration.js', 'discord.js', 'transport.js',
  'dispatch.js', 'conservation.js', 'diagnostics.js', 'panel.js',
  'acquisition.js',
];

test('cutover pins the frozen 325-export surface', () => {
  assert.equal(oracle.contract.exports.length, 325);
  assert.deepEqual(Object.keys(runtime).sort(), oracle.contract.exports.slice().sort());
});

test('runtime-api exposes the 13 domains with no select() indirection', () => {
  const source = fs.readFileSync(path.join(SRC, 'runtime-api.js'), 'utf8');
  assert.doesNotMatch(source, /function select\(/, 'select() indirection must be removed');
  assert.ok(!source.includes("require('./runtime.js')") && !source.includes('require("./runtime.js")'), 'runtime-api must not depend on the monolith');
  const api = require(path.join(SRC, 'runtime-api.js'));
  assert.deepEqual(Object.keys(api).sort(), [
    'storage', 'lease', 'parser', 'snapshot', 'envelope', 'migration',
    'discord', 'transport', 'dispatch', 'conservation', 'diagnostics',
    'panel', 'acquisition',
  ].sort());
  for (const file of DOMAIN_FACADES) {
    const domain = file.slice(0, -3);
    const facade = require(path.join(SRC, file));
    assert.equal(api[domain], facade, `runtime-api.${domain} must be the ${file} facade itself`);
  }
});

test('every domain facade is a reference-equal copy (not a subset)', () => {
  const api = require(path.join(SRC, 'runtime-api.js'));
  for (const file of DOMAIN_FACADES) {
    const domain = file.slice(0, -3);
    const facade = require(path.join(SRC, file));
    assert.equal(api[domain], facade, `runtime-api.${domain} must be identical to ${file}`);
    assert.deepEqual(Object.keys(api[domain]).sort(), Object.keys(facade).sort(), `runtime-api.${domain} must expose all ${file} exports`);
  }
});

test('runtime-api.select is removed', () => {
  const api = require(path.join(SRC, 'runtime-api.js'));
  assert.equal(typeof api.select, 'undefined', 'select function must be removed');
});

test('runtime.js retains all 325 exports and pinned literals', () => {
  assert.equal(Object.keys(runtime).length, 325);
  const source = fs.readFileSync(path.join(SRC, 'runtime.js'), 'utf8');
  assert.ok(source.includes('const RELEASE_ID = "taa-1.0.2";'), 'release ID literal stays in the authority text');
  assert.ok(source.includes('let previousState'), 'mutable singleton declarations stay');
  assert.ok(source.includes('function startBrowserRuntime'), 'boot function stays');
  assert.equal(runtime.WEBHOOK_STORAGE_KEY, 'travianAllianceWebhookUrl_v1');
  assert.equal(runtime.TAB_LEASE_TTL_MS, 120000);
  assert.equal(runtime.QUEUE_MAX_EVENTS, 50);
  assert.deepEqual(runtime.classifyAllianceRoute('https://world.example/alliance/profile/members'), { role: 'canonical-member', pathname: '/alliance/profile/members', query: '' });
  assert.equal(typeof runtime.startBrowserRuntime, 'function');
});
