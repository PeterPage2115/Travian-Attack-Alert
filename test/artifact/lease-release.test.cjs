'use strict';

/*
 * Lease release red→green lock for public release 1.0.0 (plan Todo 11).
 *
 * Proves, against the BUILT ARTIFACT (dist/travian-attack-alert.user.js),
 * that the unload release path really deletes the lease record:
 * acquire → release with the ACQUIRED term must delete the record so a
 * follower can take over promptly; a wrong term or a foreign owner must
 * refuse and preserve the record (the term guard keeps its intent).
 *
 * Failure mode locked here: releaseLease read the lease via loadLease, which
 * strips term/token (parseLease keeps ownerId/expiresAtMs only), so the
 * `existing.term !== expectedTerm` guard compared against undefined and the
 * record was NEVER deleted — every closed owner left its lease to expire
 * (120 s monitoring gap for any follower) instead of releasing it.
 *
 * Synthetic fixtures only: hostname s1.example.travian.com, fixed nowMs,
 * in-memory localStorage shim. No DEV bytes, no real hosts, no network.
 *
 * Run: node --test test/artifact/lease-release.test.cjs
 * Gate: npm run check:release -- --offline (artifact-matrix gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const runtime = require(path.join(ROOT, 'dist', 'travian-attack-alert.user.js'));

const WORLD = 's1.example.travian.com';
const T0 = 1700000000000;

function installMemoryStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => { store.clear(); },
  };
}

test('release with the acquired term deletes the lease record', () => {
  installMemoryStorage();
  assert.equal(runtime.acquireLease(WORLD, 'owner-1', T0), true);
  const record = runtime.loadLeaseRecord(WORLD);
  assert.equal(record.ownerId, 'owner-1');
  assert.ok(Number.isInteger(record.term));
  assert.equal(runtime.releaseLease(WORLD, 'owner-1', T0 + 1000, record.term), true);
  assert.equal(runtime.loadLeaseRecord(WORLD), null);
});

test('release with a wrong term refuses and preserves the record', () => {
  installMemoryStorage();
  assert.equal(runtime.acquireLease(WORLD, 'owner-1', T0), true);
  assert.equal(runtime.releaseLease(WORLD, 'owner-1', T0 + 1000, 999), false);
  assert.equal(runtime.loadLeaseRecord(WORLD)?.ownerId, 'owner-1');
});

test('release by a foreign owner refuses and preserves the record', () => {
  installMemoryStorage();
  assert.equal(runtime.acquireLease(WORLD, 'owner-1', T0), true);
  assert.equal(runtime.releaseLease(WORLD, 'owner-2', T0 + 1000, 1), false);
  assert.equal(runtime.loadLeaseRecord(WORLD)?.ownerId, 'owner-1');
});
