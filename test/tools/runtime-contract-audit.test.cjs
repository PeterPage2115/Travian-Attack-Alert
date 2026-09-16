'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { deriveContract, deriveSnapshot, extractSingletons } = require('./runtime-contract-audit.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

test('source and rebuilt dist independently derive the same 325-export contract', () => {
  const result = deriveContract(path.join(ROOT, 'src/runtime.js'), path.join(ROOT, 'dist/travian-attack-alert.user.js'));
  assert.equal(result.contract.exports.length, 325);
  assert.equal(result.derivation.independentlyEqual, true);
  assert.equal(result.contract.releaseId, 'taa-1.0.0');
  assert.equal(result.contract.routeFixtures.every(item => item.url === 'not a URL' || item.url.includes('world.example')), true);
});

test('contract includes storage, menu, boot, timing, and singleton inventories', () => {
  const result = deriveSnapshot(path.join(ROOT, 'src/runtime.js'));
  assert.equal(Object.keys(result.storageKeys).length, 17);
  assert.equal(result.menuCommands.length, 26);
  assert.ok(result.bootEffects.length >= 17);
  assert.ok(Object.keys(result.timingConstants).length >= 10);
  assert.deepEqual(result.mutableSingletonNames.slice(0, 3), ['previousState', 'lastScanAtMs', 'nextReloadAtMs']);
});

test('singleton extraction fails closed on malformed input', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-contract-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => extractSingletons('let previousState = null;'), /block is missing/u);
});
