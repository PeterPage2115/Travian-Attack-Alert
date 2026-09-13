// Todo 12 — controlled 6.x -> public 1.0.0 owner transfer (plan
// external-alliance-public-1-0-0, procedure docs/MIGRATION-6X.md).
//
// Proves, against the FINAL distributed bytes
// (/dist/travian-attack-alert.user.js), the file-based transfer path:
//
//   T1 import-flow: a seeded fictional 6.x profile (localStorage keys +
//      old-identity GM webhook + legacy monitor queue) exports via the Todo 8
//      default SECRET-OMITTING backup; the 1.0.0 identity (separate GM store,
//      webhook manually re-entered) imports it -> webhook preserved from
//      manual re-entry, mappings/settings/roles/mutes/names/roster merged,
//      unrelated site data (pending queue) untouched, zero network requests.
//   T2 no-historical-flood: the migrated queue keeps ls1: in-flight as
//      recoverable (never acked) and lh1: history as unknown-legacy (never
//      acked); a baseline-identical post-migration scan plans zero
//      detections, a genuine +1 attack plans exactly that delta.
//   T3 no-double-sender guard: a harness-level preflight check encoding the
//      doc checklist FAILS LOUDLY when both identities report enabled, and
//      passes once the old sender is disabled. Runtime stays single-sender
//      by lease design (Todo 11); no cross-installation protection is
//      claimed — two contexts/profiles WILL double-send.
//
// Harness notes (all observed, not assumed):
// - The artifact is loaded with a `window.module` shim so the IIFE's
//   `typeof module !== "undefined" && module.exports` branch publishes its
//   pure export surface WITHOUT booting the monitor (isNodeEnvironment is
//   true under the shim, so the `if (!isNodeEnvironment)` boot block is
//   skipped: no lease, no scan, no timers, no panel). Every assertion below
//   still executes the real shipped bytes in a real browser with real
//   localStorage.
// - The two script identities NEVER share GM storage: the spec keeps two
//   separate in-page stores (`__TAA_GM_6X__`, `__TAA_GM_100__`) and passes
//   them explicitly via the `gm` option. The only carrier between them is
//   the backup FILE object (or a manually re-typed webhook).
// - Synthetic data only: playerIds 201/202/203, FAKE webhook tokens,
//   loopback 127.0.0.1. No real hosts, webhooks, or network.
// - Evidence goes to
//   test-results/release-1.0.0/e2e-evidence-migration-6x.json (per-spec file;
//   never the shared test-results/e2e-runtime.json).
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const DIST_PATH = '/dist/travian-attack-alert.user.js';
const WORLD = 's6.example.travian.com';
const OLD_WEBHOOK = 'https://discord.com/api/webhooks/100000000000000002/FAKE_TOKEN_MIGRATION_6X_browser_aaaabbbb';
const NEW_WEBHOOK = 'https://discord.com/api/webhooks/100000000000000003/FAKE_TOKEN_MIGRATION_6X_browser_ccccdddd';
const EVIDENCE_PATH = path.join('test-results', 'release-1.0.0', 'e2e-evidence-migration-6x.json');

const MAPPINGS_KEY = 'travianAlliancePlayerMappings_v1';
const DISCORD_CONFIG_KEY = 'travianAllianceDiscordConfig_v1';
const SETTINGS_KEY = 'travianAllianceSettings_v1';
const MUTED_KEY = 'travianAllianceMutedPlayers_v1';
const NAMES_KEY = 'travianAlliancePlayerNames_v1';
const ROSTER_KEY = 'travianAllianceRoster_v1';
const PENDING_KEY = 'travianAlliancePendingBatch_v1';

// Procedure checklist, encoded at harness level (docs/MIGRATION-6X.md).
// This is NOT product behavior: the runtime stays single-sender by Web-Lock
// lease design (Todo 11) and offers no cross-installation protection.
function migrationTransferPreflight(input: {
  oldSenderEnabled: boolean;
  newSenderEnabled: boolean;
  siteDataPreserved: boolean;
  singleInstallation: boolean;
  carrierIsFileOrManual: boolean;
}): { ok: boolean; reason: string; message: string } {
  if (input.oldSenderEnabled && input.newSenderEnabled) {
    return {
      ok: false,
      reason: 'double-sender-enabled',
      message: 'BLOCKED: both the 6.x sender and the 1.0.0 sender report enabled. ' +
        'Disable the 6.x script and verify zero sends for a full cycle before continuing. ' +
        'Two active senders WILL double-send; the lease cannot prevent it.',
    };
  }
  if (!input.siteDataPreserved) {
    return {
      ok: false,
      reason: 'site-data-cleared',
      message: 'BLOCKED: site data was cleared or the profile was copied. The transfer ' +
        'preserves site data in place; start over from the 6.x export.',
    };
  }
  if (!input.singleInstallation) {
    return {
      ok: false,
      reason: 'multiple-installations',
      message: 'BLOCKED: more than one active monitoring installation exists for this ' +
        'world/alliance. Exactly one script, one profile, one computer.',
    };
  }
  if (!input.carrierIsFileOrManual) {
    return {
      ok: false,
      reason: 'untrusted-carrier',
      message: 'BLOCKED: the transfer carrier must be the backup FILE (or a manually ' +
        're-typed webhook). GM storage is never shared between the two identities.',
    };
  }
  return { ok: true, reason: 'ready', message: 'Preflight passed: single disabled-old sender, site data preserved.' };
}

function writeEvidencePhase(phase: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  const existing = fs.existsSync(EVIDENCE_PATH) ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8')) : {};
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ ...existing, [phase]: value }, null, 2)}\n`);
}

async function serverRequestCount(page: Page): Promise<number> {
  return await page.evaluate(async () => (await (await fetch('/e2e-log')).json()).discordRequests?.length ?? 0);
}

// Loads the REAL shipped bytes with a module shim: publishes the export
// surface without booting the monitor (no lease/scan/timers/panel).
async function loadTransferRuntime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { module: { exports: Record<string, unknown> } }).module = { exports: {} };
  });
  await page.goto('/alliance', { waitUntil: 'domcontentloaded' });
  const artifact = await page.evaluate(
    async (artifactPath: string) => await (await fetch(artifactPath)).text(),
    DIST_PATH,
  );
  // Identity: the exact 1.0.0 bytes (header + release marker), not a paraphrase.
  expect(artifact).toContain('// @version      1.0.0');
  expect(artifact).toContain('const RELEASE_ID = "taa-1.0.0"');
  await page.addScriptTag({ content: artifact });
  const hasSurface = await page.evaluate(
    () => {
      const exports = (window as unknown as { module: { exports: Record<string, unknown> } }).module.exports;
      return typeof exports.buildSettingsBackup === 'function' &&
        typeof exports.applySettingsBackup === 'function' &&
        typeof exports.planMonitorLegacyMigration === 'function' &&
        typeof exports.planAcceptedScanTransition === 'function';
    },
  );
  expect(hasSurface).toBe(true);
  // Request trap: any product dispatch would go through GM_xmlhttpRequest or
  // fetch. Nothing under test may touch the network; lock it at zero.
  await page.evaluate(() => {
    (window as unknown as { __TAA_MIGRATION_FETCH_CALLS__: string[] }).__TAA_MIGRATION_FETCH_CALLS__ = [];
    const calls = (window as unknown as { __TAA_MIGRATION_FETCH_CALLS__: string[] }).__TAA_MIGRATION_FETCH_CALLS__;
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/discord-webhook') || url.includes('discord.com/api/webhooks')) calls.push(url);
      return originalFetch(input, init);
    }) as typeof window.fetch;
  });
}

async function fetchTrapCount(page: Page): Promise<number> {
  return await page.evaluate(
    () => (window as unknown as { __TAA_MIGRATION_FETCH_CALLS__: string[] }).__TAA_MIGRATION_FETCH_CALLS__.length,
  );
}

test.describe('migration 6.x -> 1.0.0 owner transfer', () => {
  let browser: Browser;
  test.beforeAll(async ({ playwright }) => {
    browser = await playwright.chromium.launch();
  });
  test.afterAll(async () => {
    await browser.close();
  });

  test('T1 import-flow: secret-omitting file + manual re-entry preserves webhook and merges fields', async () => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8899' });
    const page = await context.newPage();
    try {
      await loadTransferRuntime(page);
      const before = await serverRequestCount(page);
      const outcome = await page.evaluate(
        ({ world, oldWebhook, newWebhook, keys }) => {
          const rt = (window as unknown as { module: { exports: Record<string, (...args: never[]) => unknown> } }).module.exports as unknown as {
            buildSettingsBackup: (input: Record<string, unknown>) => Record<string, unknown>;
            applySettingsBackup: (raw: unknown, options: Record<string, unknown>) => Record<string, unknown>;
          };
          // Seed the fictional 6.x profile: site keys + legacy monitor queue.
          localStorage.setItem(keys.mappings, JSON.stringify({ [world]: { 201: ['100000000000000011'] } }));
          localStorage.setItem(keys.config, JSON.stringify({ roleId: '200000000000000011', leaveRoleId: null }));
          localStorage.setItem(keys.settings, JSON.stringify({ [world]: { attackThreshold: 2 } }));
          localStorage.setItem(keys.muted, JSON.stringify({ [world]: { 202: true } }));
          localStorage.setItem(keys.names, JSON.stringify({ [world]: { 201: 'Fictional Alpha' } }));
          localStorage.setItem(keys.roster, JSON.stringify({ [world]: { 201: { name: 'Fictional Alpha', url: '/profile/201' } } }));
          const legacyQueue = {
            [world]: {
              events: [{
                playerId: '201', name: 'Fictional Alpha', url: `https://${world}/profile/201`,
                attackCount: 1, raidCount: 0, oldAttackCount: 0, oldRaidCount: 0,
                addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack',
                observedAtMs: 1700000000000, queuedAtMs: 1700000000000, attemptCount: 0, responseClass: null,
              }],
              createdAt: 1700000000000,
            },
          };
          localStorage.setItem(keys.pending, JSON.stringify(legacyQueue));
          // Old 6.x identity GM store (separate object; never shared).
          const gmOld = { present: true as boolean, raw: oldWebhook as string | undefined };
          // Step 1 (owner, 6.x side): default export. Secret must be omitted.
          const file = rt.buildSettingsBackup({ hostname: world, storage: localStorage, webhook: gmOld.raw, nowMs: 1700000000000 }) as {
            data: Record<string, unknown>;
          };
          const carriesSecret =
            Object.prototype.hasOwnProperty.call(file.data, 'travianAllianceWebhookUrl_v1') ||
            JSON.stringify(file).includes('discord.com/api/webhooks');
          // Step 2: old sender disabled (flag only; site data untouched).
          gmOld.present = false;
          const siteDataPreserved = localStorage.getItem(keys.pending) !== null &&
            localStorage.getItem(keys.mappings) !== null;
          // Step 4: fresh 1.0.0 identity GM store + manual webhook re-entry.
          let gmNewRaw: string | undefined;
          let gmNewPresent = false;
          const gmNew = {
            get: () => (gmNewPresent ? gmNewRaw : undefined),
            set: (v: string) => { gmNewPresent = true; gmNewRaw = v; },
            remove: () => { gmNewPresent = false; gmNewRaw = undefined; },
          };
          gmNew.set(newWebhook);
          const result = rt.applySettingsBackup(file, { hostname: world, storage: localStorage, gm: gmNew }) as {
            ok: boolean; kind: string;
          };
          return {
            carriesSecret,
            importOk: result.ok,
            importKind: result.kind,
            webhookPreserved: gmNewRaw === newWebhook,
            mappings: localStorage.getItem(keys.mappings),
            settings: localStorage.getItem(keys.settings),
            config: localStorage.getItem(keys.config),
            muted: localStorage.getItem(keys.muted),
            names: localStorage.getItem(keys.names),
            roster: localStorage.getItem(keys.roster),
            pendingUntouched: localStorage.getItem(keys.pending) === JSON.stringify(legacyQueue),
            siteDataPreserved,
          };
        },
        {
          world: WORLD,
          oldWebhook: OLD_WEBHOOK,
          newWebhook: NEW_WEBHOOK,
          keys: {
            mappings: MAPPINGS_KEY, config: DISCORD_CONFIG_KEY, settings: SETTINGS_KEY,
            muted: MUTED_KEY, names: NAMES_KEY, roster: ROSTER_KEY, pending: PENDING_KEY,
          },
        },
      );
      expect(outcome.carriesSecret).toBe(false);
      expect(outcome.importOk).toBe(true);
      expect(outcome.importKind).toBe('imported');
      expect(outcome.webhookPreserved).toBe(true);
      expect(JSON.parse(outcome.mappings as string)).toEqual({ [WORLD]: { 201: ['100000000000000011'] } });
      expect(JSON.parse(outcome.settings as string)[WORLD].attackThreshold).toBe(2);
      expect(JSON.parse(outcome.config as string)).toEqual({ roleId: '200000000000000011', leaveRoleId: null });
      expect(JSON.parse(outcome.muted as string)).toEqual({ [WORLD]: { 202: true } });
      expect(JSON.parse(outcome.names as string)).toEqual({ [WORLD]: { 201: 'Fictional Alpha' } });
      expect(JSON.parse(outcome.roster as string)[WORLD]['201'].name).toBe('Fictional Alpha');
      expect(outcome.pendingUntouched).toBe(true);
      expect(outcome.siteDataPreserved).toBe(true);
      // No historical flood: zero Discord traffic across the whole flow.
      expect(await serverRequestCount(page)).toBe(before);
      expect(await fetchTrapCount(page)).toBe(0);
      writeEvidencePhase('t1-import-flow', {
        importKind: outcome.importKind, webhookPreserved: outcome.webhookPreserved,
        pendingUntouched: outcome.pendingUntouched, discordRequests: 0,
      });
    } finally {
      await context.close();
    }
  });

  test('T2 no-historical-flood: migrated queue recovers ls1:, parks lh1:, plans only new deltas', async () => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8899' });
    const page = await context.newPage();
    try {
      await loadTransferRuntime(page);
      const before = await serverRequestCount(page);
      const outcome = await page.evaluate(({ world }) => {
        const rt = (window as unknown as { module: { exports: Record<string, (...args: never[]) => unknown> } }).module.exports as unknown as {
          planMonitorLegacyMigration: (legacy: unknown, snapshot: unknown, w: string) => {
            pending: Array<Record<string, unknown>>;
            inFlight: Array<Record<string, unknown>>;
            history: Array<Record<string, unknown>>;
            uncertain: Array<Record<string, unknown>>;
            baselineByPlayerId: Record<string, Record<string, unknown>>;
          };
          planAcceptedScanTransition: (...args: unknown[]) => { outcome: string; detections: unknown[]; eligibleEvents: unknown[] };
        };
        const queueEvent = (playerId: string, name: string) => ({
          playerId, name, url: `https://${world}/profile/${playerId}`,
          attackCount: 1, raidCount: 0, oldAttackCount: 0, oldRaidCount: 0,
          addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack',
          observedAtMs: 1700000000000, queuedAtMs: 1700000000000, attemptCount: 0, responseClass: null,
        });
        const members = {
          201: { name: 'Fictional Alpha', url: '/profile/201', attackCount: 4, raidCount: 1 },
          202: { name: 'Fictional Beta', url: '/profile/202', attackCount: 0, raidCount: 0 },
        };
        const snap = (membersById: unknown) => ({
          status: 'authoritative', observedAtMs: 1700000000000,
          tableSignature: 'alliance-members-v1:migration-6x-e2e', membersById,
          anomalies: { missingId: false, duplicateId: false, conflictingTooltip: false, malformedCount: false, paginationOrFilter: false },
        });
        const plan = rt.planMonitorLegacyMigration({
          attackState: { 'Fictional Alpha': { id: '201', attackCount: 4, raidCount: 1 } },
          pending: { [world]: { events: [queueEvent('201', 'Fictional Alpha')], createdAt: 1700000000000 } },
          inFlight: { [world]: { events: [queueEvent('202', 'Fictional Beta')], createdAt: 1700000000000 } },
          history: [queueEvent('201', 'Fictional Alpha')],
          removed: { [world]: { events: [queueEvent('202', 'Fictional Beta')], createdAt: 1700000000000 } },
        }, snap(members), world);
        const steady = rt.planAcceptedScanTransition(
          snap({
            201: { name: 'Fictional Alpha', url: '/profile/201', attackCount: 4, raidCount: 1 },
            202: { name: 'Fictional Beta', url: '/profile/202', attackCount: 0, raidCount: 0 },
          }),
          plan.baselineByPlayerId, new Set(), 1, 1, { ownerId: 'owner-100', term: 1 }, { world },
        );
        const delta = rt.planAcceptedScanTransition(
          snap({
            201: { name: 'Fictional Alpha', url: '/profile/201', attackCount: 5, raidCount: 1 },
            202: { name: 'Fictional Beta', url: '/profile/202', attackCount: 0, raidCount: 0 },
          }),
          plan.baselineByPlayerId, new Set(), 1, 1, { ownerId: 'owner-100', term: 1 }, { world },
        );
        return {
          pendingCount: plan.pending.length,
          inFlightCount: plan.inFlight.length,
          historyCount: plan.history.length,
          uncertainCount: plan.uncertain.length,
          pendingIds: plan.pending.map((e) => String(e.eventId)),
          inFlightIds: plan.inFlight.map((e) => String(e.eventId)),
          historyIds: plan.history.map((e) => String(e.recordIdentity)),
          historyStates: plan.history.map((e) => String(e.deliveryState)),
          uncertainStates: plan.uncertain.map((e) => String(e.deliveryState)),
          ackedAnywhere: [...plan.pending, ...plan.inFlight, ...plan.uncertain]
            .some((e) => e.deliveryState === 'acknowledged'),
          steadyDetections: steady.detections.length,
          deltaDetections: delta.detections.length,
        };
      }, { world: WORLD });
      expect(outcome.pendingCount).toBe(1);
      expect(outcome.inFlightCount).toBe(1);
      expect(outcome.historyCount).toBe(1);
      expect(outcome.uncertainCount).toBe(1);
      for (const id of [...outcome.pendingIds, ...outcome.inFlightIds]) expect(id.startsWith('ls1:')).toBe(true);
      for (const id of outcome.historyIds) expect(id.startsWith('lh1:')).toBe(true);
      expect(outcome.historyStates).toEqual(['unknown-legacy']);
      expect(outcome.uncertainStates).toEqual(['uncertain-legacy-settlement']);
      expect(outcome.ackedAnywhere).toBe(false);
      expect(outcome.steadyDetections).toBe(0);
      expect(outcome.deltaDetections).toBe(1);
      expect(await serverRequestCount(page)).toBe(before);
      expect(await fetchTrapCount(page)).toBe(0);
      writeEvidencePhase('t2-no-flood', {
        pending: outcome.pendingCount, inFlight: outcome.inFlightCount, history: outcome.historyCount,
        steadyDetections: outcome.steadyDetections, deltaDetections: outcome.deltaDetections, discordRequests: 0,
      });
    } finally {
      await context.close();
    }
  });

  test('T3 no-double-sender guard: both identities enabled fails the preflight loudly', async () => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8899' });
    const page = await context.newPage();
    try {
      await loadTransferRuntime(page);
      // Both identities' GM stores report an enabled sender (the forbidden state).
      const flags = await page.evaluate(() => {
        const gm6x = { webhookPresent: true, monitoringEnabled: true };
        const gm100 = { webhookPresent: true, monitoringEnabled: true };
        return {
          oldSenderEnabled: gm6x.webhookPresent && gm6x.monitoringEnabled,
          newSenderEnabled: gm100.webhookPresent && gm100.monitoringEnabled,
        };
      });
      const blocked = migrationTransferPreflight({
        ...flags,
        siteDataPreserved: true,
        singleInstallation: false,
        carrierIsFileOrManual: true,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.reason).toBe('double-sender-enabled');
      expect(blocked.message.length).toBeGreaterThan(0);
      // Owner resolves it: 6.x disabled, single installation. Then it passes.
      const released = migrationTransferPreflight({
        oldSenderEnabled: false,
        newSenderEnabled: true,
        siteDataPreserved: true,
        singleInstallation: true,
        carrierIsFileOrManual: true,
      });
      expect(released.ok).toBe(true);
      expect(released.reason).toBe('ready');
      writeEvidencePhase('t3-no-double-sender', {
        blockedReason: blocked.reason, releasedReason: released.reason,
      });
    } finally {
      await context.close();
    }
  });
});
