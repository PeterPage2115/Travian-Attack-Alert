'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const evidence = require('./plan-evidence-audit.cjs');
const inventory = require('./test-inventory.cjs');
const { verifyReceipt } = require('./task-receipt.cjs');

const ROUTES = [
  'https://world.example/alliance/profile/members',
  'https://world.example/alliance/profile/members/',
  'https://world.example/alliance/profile/members?page=2',
  'https://world.example/alliance',
  'https://world.example/village',
  'not a URL',
];
const BOOT_TOKENS = [
  ['classify-initial-route', 'const initialRoute = classifyAllianceRoute(location.href);'],
  ['gate-canonical-web-lock-authority', 'initialRoute.role === ROUTE_ROLES.CANONICAL_MEMBER && hasExclusiveWebLocks()'],
  ['standby-read-only-panel', 'setStandbyVisibility(true);'],
  ['visibility-drift-tracking', 'document.addEventListener("visibilitychange"'],
  ['jittered-lock-acquisition', 'getStartupAcquisitionJitterMs(Math.random())'],
  ['host-scoped-exclusive-lock', 'navigator.locks.request('],
  ['persistent-tab-lease', 'const leaseResult = acquireLease('],
  ['follower-watchdog', 'startFollowerWatchdog(worldHostname, tabOwnerId, false);'],
  ['leader-lease-renewal', 'startLeaseRenewal(worldHostname, tabOwnerId);'],
  ['leader-menu-registration', 'GM_registerMenuCommand('],
  ['admin-panel-initialization', 'initAdminPanel();'],
  ['pending-batch-flush', 'flushPendingBatch();'],
  ['readiness-observer', 'installReadinessObserver();'],
  ['random-reload-schedule', 'scheduleRandomReload();'],
  ['batch-flush-schedule', 'scheduleBatchFlush();'],
  ['web-lock-held-until-release', 'releaseWebLock = resolve;'],
  ['web-lock-failure-standby', 'Web Lock authority unavailable.'],
];

function loadModule(file) {
  const resolved = require.resolve(file); delete require.cache[resolved]; return require(resolved);
}

function extractStorageKeys(text) {
  return Object.fromEntries([...text.matchAll(/(?:const|let|var)\s+([A-Z0-9_]*(?:STORAGE_KEY|STORAGE_KEY_PREFIX))\s*=\s*["']([^"']+)["']/gu)]
    .map(([, name, value]) => [name, value]).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function extractMenus(text) {
  return [...text.matchAll(/GM_registerMenuCommand\(\s*["']([^"']+)["']/gu)].map(match => match[1]);
}

function extractSingletons(text) {
  const start = text.indexOf('let previousState =');
  const endMarker = 'let visibilityDriftState = null;';
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('mutable singleton declaration block is missing');
  const block = text.slice(start, end + endMarker.length);
  return [...block.matchAll(/\blet\s+([A-Za-z_$][\w$]*)\s*=/gu)].map(match => match[1]);
}

function deriveSnapshot(file) {
  const absolute = path.resolve(file);
  const text = fs.readFileSync(absolute, 'utf8');
  const runtime = loadModule(absolute);
  const release = text.match(/(?:const|var) RELEASE_ID = ["']([^"']+)["'];/u)?.[1];
  if (!release) throw new Error(`release ID missing in ${file}`);
  const bootEffects = BOOT_TOKENS.map(([name, token]) => {
    if (!text.includes(token)) throw new Error(`boot effect missing in ${file}: ${name}`);
    return name;
  });
  const timingConstants = Object.fromEntries(Object.entries(runtime)
    .filter(([name, value]) => /(?:_MS|_DELAY_MS)$/u.test(name) && (typeof value === 'number' || Array.isArray(value)))
    .sort(([left], [right]) => left.localeCompare(right, 'en')));
  return {
    exports: Object.keys(runtime).sort(),
    storageKeys: extractStorageKeys(text),
    menuCommands: extractMenus(text),
    routeFixtures: ROUTES.map(url => ({ url, role: runtime.classifyAllianceRoute(url).role })),
    bootEffects,
    releaseId: release,
    timingConstants,
    mutableSingletonNames: extractSingletons(text),
  };
}

function deriveContract(source, dist) {
  const sourceSnapshot = deriveSnapshot(source);
  const distSnapshot = deriveSnapshot(dist);
  if (evidence.canonical(sourceSnapshot) !== evidence.canonical(distSnapshot)) throw new Error('source/dist runtime contract mismatch');
  if (sourceSnapshot.exports.length !== 325) throw new Error(`expected 325 exports, got ${sourceSnapshot.exports.length}`);
  return {
    schemaVersion: 1,
    contract: sourceSnapshot,
    derivation: {
      sourceSha256: evidence.sha256File(source), distSha256: evidence.sha256File(dist),
      sourceContractSha256: evidence.sha256(evidence.canonical(sourceSnapshot)),
      distContractSha256: evidence.sha256(evidence.canonical(distSnapshot)), independentlyEqual: true,
    },
  };
}

function verifyHashMap(root, map, label) {
  for (const [relative, digest] of Object.entries(map || {})) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes root: ${relative}`);
    if (evidence.sha256File(absolute) !== digest) throw new Error(`${label} hash mismatch: ${relative}`);
  }
}

function verifyGitInputs(root, head, map) {
  for (const [relative, digest] of Object.entries(map || {})) {
    const result = spawnSync('git', ['show', `${head}:${relative}`], { cwd: root, encoding: null, env: { ...process.env, GIT_MASTER: '1' }, maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`pre-refactor input is not readable: ${relative}`);
    if (evidence.sha256(result.stdout) !== digest) throw new Error(`pre-refactor input hash mismatch: ${relative}`);
  }
}

function verifyReview(review, launch, attemptRoot, oracleSha256) {
  if (review?.verdict !== 'APPROVE' || review.independent !== true) throw new Error('independent review is not approved');
  if (!launch?.launchId || !launch.sessionId || launch.launchId !== review.reviewer?.launchId || launch.sessionId !== review.reviewer?.sessionId) throw new Error('reviewer launch/session identity mismatch');
  const receiptPath = evidence.resolveInside(attemptRoot, review.taskReceiptPath);
  const receipt = evidence.readJsonNoFollow(receiptPath);
  verifyReceipt(receipt);
  const receiptDigest = evidence.sha256File(receiptPath);
  if (receiptDigest !== review.taskReceiptFileSha256 || receiptDigest !== launch.taskReceiptFileSha256) throw new Error('Task-1 receipt digest mismatch');
  if (review.behaviorOracleSha256 !== oracleSha256 || launch.behaviorOracleSha256 !== oracleSha256) throw new Error('review behavior oracle mismatch');
  const required = ['commitEnvironmentInputs', 'sourceDistDerivation', 'suiteInventories', 'frozenTools', 'taskReceiptDigest'];
  for (const key of required) if (review.verification?.[key] !== true) throw new Error(`review verification missing: ${key}`);
}

function verifyProvenance(options) {
  const root = path.resolve(options.root || process.cwd());
  const provenance = evidence.readJsonNoFollow(path.resolve(options.provenance));
  const oraclePath = path.resolve(root, provenance.oracle.path);
  const oracle = evidence.readJsonNoFollow(oraclePath);
  const oracleSha256 = evidence.sha256File(oraclePath);
  if (oracleSha256 !== provenance.oracle.behaviorOracleSha256 || oracleSha256 !== provenance.oracle.sha256) throw new Error('behaviorOracleSha256 mismatch');
  const derived = deriveContract(path.resolve(options.source), path.resolve(options.dist));
  if (evidence.canonical(derived.contract) !== evidence.canonical(oracle.contract)) throw new Error('runtime oracle content mismatch');
  verifyGitInputs(root, provenance.preRefactor.head, provenance.inputs);
  if (derived.derivation.sourceSha256 === provenance.inputs['src/runtime.js']) verifyHashMap(root, provenance.rebuiltOutputs, 'rebuilt output');
  verifyHashMap(root, provenance.frozenFiles, 'frozen file');
  const baseline = evidence.readJsonNoFollow(path.resolve(options.baseline));
  const manifest = evidence.readJsonNoFollow(path.resolve(options.manifest));
  const inventoryResult = inventory.verifyInventory({ baseline, manifest, oracleSha256, verifierHashes: provenance.verifierHashes });
  const identityPath = path.resolve(options.planIdentity);
  const identity = evidence.readJsonNoFollow(identityPath);
  evidence.verifyPlanIdentity(identity, { attemptId: provenance.attemptId, canonicalRoot: root, cleanStartingHead: provenance.preRefactor.head });
  if (identity.plan.sha256 !== provenance.plan.sha256 || identity.plan.byteCount !== provenance.plan.byteCount) throw new Error('plan identity/provenance mismatch');
  const attemptRoot = path.dirname(identityPath);
  verifyReview(evidence.readJsonNoFollow(path.resolve(options.review)), evidence.readJsonNoFollow(path.resolve(options.launch)), attemptRoot, oracleSha256);
  return { verdict: 'PASS', exports: oracle.contract.exports.length, suites: inventoryResult.suites, expectedExecutions: inventoryResult.expectedExecutions, behaviorOracleSha256: oracleSha256 };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].slice(2)] = argv[index + 1];
  return result;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args['verify-provenance']) throw new Error('--verify-provenance is required');
    const result = verifyProvenance({ provenance: args['verify-provenance'], source: args.source, dist: args.dist, baseline: args.baseline, manifest: args.manifest, planIdentity: args['plan-identity'], review: args['require-independent-receipt'], launch: args['require-launch-seal'] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { deriveSnapshot, deriveContract, verifyProvenance, extractSingletons };
