// Todo 9 — clean-install baseline safety (plan external-alliance-public-1.0.0).
//
// Proves, against the FINAL distributed bytes (dist/travian-attack-alert.user.js,
// the generated installable), that a first scan from EMPTY localStorage + EMPTY GM storage:
//   - commits baseline + roster, and
//   - sends ZERO Discord requests (no historical flood for pre-existing counts).
// A synthetic +1 attack for playerId 101 then delivers EXACTLY ONE loopback
// request, and a reload with identical state duplicates nothing.
//
// Harness notes (all observed, not assumed):
// - Built on runtime-bootstrap.ts shims (GM/locks/fetch/Date); no second harness.
// - The product's Discord payload builder (safeAllianceUrl) only trusts https
//   page origins, so delivery is proven over the fixture's ephemeral TLS listener
//   (127.0.0.1:8898, self-signed cert generated at server startup into os.tmpdir,
//   never committed). Tests use a dedicated context with ignoreHTTPSErrors;
//   the loopback-only rule still holds (every target stays same-origin).
// - GM storage is an in-memory stub per document. Real Tampermonkey persists GM
//   across reloads, so this spec snapshots GM JSON before each reload and restores
//   it after — faithful emulation of persistent GM, spec-local, no harness change.
// - The product dispatches on a 30s periodic flush (BATCH_FLUSH_MS) and on the
//   startup flush. This spec exercises the startup-flush recovery path (reload
//   with a carried pending batch) instead of idling 30s; retry/backoff semantics
//   stay owned by Todo 10.
// - The fixture /discord-webhook sink answers 429 to the FIRST attempt per reset
//   (Todo 10 transport behavior). Each delivery-measuring test burns that attempt
//   with one Node-side page.request warm-up (flagged in evidence, never counted
//   as product traffic) so the measured window shows the product's own requests.
// - Synthetic data only: playerId 101, FAKE webhook token, loopback 127.0.0.1.
// - Evidence goes to test-results/release-1.0.0/e2e-evidence-clean-install.json
//   (per-spec file; never the shared test-results/e2e-runtime.json).
//
// UI-state mapping asserted here (literal product strings, never paraphrased):
// - script-running:       "Leader — this tab owns monitoring and transport."
// - baseline-established: roster persisted + "Fresh — observed" + dated
//                          "Last authoritative observation" + Monitor generation ≥ 1
// - scan-accepted:        "Scan result: accepted/authoritative",
//                         "Scan reason: authoritative", "Scan outcome: ok"
// - webhook-missing:      "Last sent: Not recorded" + "Failed / uncertain: 0 / 0"
//                         + delivery totals "0 / 0 / 0 / 0 / 0", never a
//                         "Batch alert sent" delivery-success claim.
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { installArtifactRuntime, installLoopbackTransport, warmupLoopbackTransport, writeEvidencePhase as writeEvidencePhaseShared } from './runtime-bootstrap';

const DIST = '/dist/travian-attack-alert.user.js';
const HTTPS_ORIGIN = 'https://127.0.0.1:8898';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/FAKE-clean-install-token-0123456789abcdef';
const MONITOR_KEY = 'travianAllianceMonitor_v1:127.0.0.1';
const ROSTER_KEY = 'travianAllianceRoster_v1';
const EVIDENCE_PATH = path.join('test-results', 'release-1.0.0', 'e2e-evidence-clean-install.json');

type SnapshotEvent = { kind: string; status?: string; reason?: string };
type HttpsPage = { context: import('@playwright/test').BrowserContext; page: Page };

async function newHttpsPage(browser: Browser): Promise<HttpsPage> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: HTTPS_ORIGIN });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  (page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
  return { context, page };
}

async function closeHttpsPage(target: HttpsPage): Promise<void> {
  await target.context.close();
}

function consoleErrors(page: Page): string[] {
  return (page as unknown as { __consoleErrors: string[] }).__consoleErrors ?? [];
}

function writeEvidencePhase(phase: string, value: Record<string, unknown>, workerIndex: number): void {
  writeEvidencePhaseShared(EVIDENCE_PATH, phase, value, workerIndex);
}

async function serverRequestCount(page: Page, ns: string | number = ''): Promise<number> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  return await page.evaluate(async (q: string) => (await (await fetch(`/e2e-log${q}`)).json()).discordRequests?.length ?? 0, nsQuery);
}

async function serverRequests(page: Page, ns: string | number = ''): Promise<Array<{ body: unknown }>> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  const log = await page.evaluate(async (q: string) => await (await fetch(`/e2e-log${q}`)).json(), nsQuery);
  return (log.discordRequests ?? []) as Array<{ body: unknown }>;
}

// Fixture-transport warm-up (Node-side, no page console noise): burns the sink's
// first-attempt 429 so the measured window shows product traffic only. The entry
// stays in the server log flagged as warmup; phases after it assert deltas.
// A stale idle keep-alive socket can throw ECONNRESET before the fixture logs
// the POST; the shared helper retries only while the server log is still empty,
// so the warm-up always adds EXACTLY one entry (never two).
async function warmupTransport(page: Page, ns: string | number = ''): Promise<void> {
  await warmupLoopbackTransport(page, (p) => serverRequestCount(p, ns), ns);
}

async function waitSnapshot(page: Page, timeout = 10_000): Promise<SnapshotEvent[]> {
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((e) => (e as SnapshotEvent).kind === 'snapshot').length ?? 0), { timeout }).toBeGreaterThan(0);
  return await page.evaluate(() => (window.__TAA_E2E_EVENTS__ ?? []) as SnapshotEvent[]);
}

// Canonical 3-row-style member fixture prep. All DOM prep runs from a
// document_start init hook at DOMContentLoaded — strictly before any artifact
// boot/readiness window — so no prep can ever lose a race with extraction.
// Per-cycle config travels via localStorage (written pre-navigation, consumed
// and removed by the hook): deterministic on every viewport/project.
type PrepConfig = { rename101?: boolean; attackIcon?: boolean; malformedIcon?: boolean; removeTable?: boolean; iconRow?: string };

async function installPrepHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        const raw = localStorage.getItem('__taa_clean_prep');
        if (!raw) return;
        localStorage.removeItem('__taa_clean_prep');
        const cfg = JSON.parse(raw) as { rename101?: boolean; attackIcon?: boolean; malformedIcon?: boolean; removeTable?: boolean };
        if (cfg.removeTable) document.querySelector('table.allianceMembers')?.remove();
        if (cfg.rename101) {
          const link = document.querySelector('a[href="/profile/900001"]');
          if (link) { link.setAttribute('href', '/profile/101'); link.textContent = 'Synthetic 101'; }
        }
        const addIcon = (title: string) => {
          const row = document.querySelector(`a[href="${cfg.iconRow || '/profile/101'}"]`)?.closest('tr');
          if (!row) throw new Error('icon target row missing');
          const img = document.createElement('img');
          img.className = 'attack';
          img.setAttribute('title', title);
          img.width = 16; img.height = 16;
          row.appendChild(img);
        };
        if (cfg.attackIcon) addIcon('1 attack');
        if (cfg.malformedIcon) addIcon('attack');
      } catch { /* test scaffolding only; never masks product behavior */ }
    });
  });
}

async function stagePrep(page: Page, cfg: PrepConfig): Promise<void> {
  await page.evaluate((config: PrepConfig) => localStorage.setItem('__taa_clean_prep', JSON.stringify(config)), cfg);
}

async function snapshotGM(page: Page): Promise<string> {
  return await page.evaluate(() => JSON.stringify(window.__TAA_GM_VALUES__ ?? {}));
}

async function restoreGM(page: Page, snap: string): Promise<void> {
  await page.evaluate((raw: string) => {
    const values = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) window.GM_setValue(key, value);
  }, snap);
}

// Re-installs the loopback transport after a navigation (the fixture page's
// inline fake-ack stub would otherwise short-circuit artifact dispatch).
async function useLoopbackTransport(page: Page, ns: string | number = ''): Promise<void> {
  await installLoopbackTransport(page, ns);
}

async function injectDist(page: Page): Promise<void> {
  await page.addScriptTag({ content: await page.evaluate(async (artifactPath: string) => await (await fetch(artifactPath)).text(), DIST) });
}

function monitorEnvelope(page: Page): Promise<{ pending: unknown[]; failed: unknown[]; uncertain: unknown[]; inFlight: unknown[]; generation: unknown; terminal: Array<{ terminalStatus?: string; playerId?: string }>; baseline101: unknown }> {
  return page.evaluate((key: string) => {
    const raw = (window.__TAA_GM_VALUES__?.[key] as string) || '{}';
    const envelope = JSON.parse(raw) as { pending?: unknown[]; failed?: unknown[]; uncertain?: unknown[]; inFlight?: unknown[]; generation?: unknown; baselineByPlayerId?: Record<string, unknown>; metrics?: { deliveryAccounting?: { terminal?: Array<{ terminalStatus?: string; playerId?: string }> } } };
    return {
      pending: envelope.pending ?? [],
      failed: envelope.failed ?? [],
      uncertain: envelope.uncertain ?? [],
      inFlight: envelope.inFlight ?? [],
      generation: envelope.generation ?? null,
      terminal: envelope.metrics?.deliveryAccounting?.terminal ?? [],
      baseline101: (envelope.baselineByPlayerId ?? {})['101'] ?? null,
    };
  }, MONITOR_KEY);
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
  await expect(page.locator('#taa-panel-overlay')).toBeVisible({ timeout: 5000 });
}

async function overlayMetric(page: Page, tab: string, metricId: string): Promise<string> {
  await page.getByRole('tab', { name: tab }).click({ force: true });
  return (await page.locator(`#${metricId}`).innerText()).trim();
}

async function transportTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
}

test.describe('clean install — first scan commits baseline, sends nothing', () => {
  test('empty start: first accepted scan persists baseline/roster, zero Discord requests', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      await installPrepHook(page);
      // Fresh browser context => empty localStorage and empty GM value store.
      // (A bare navigation runs no artifact: the script only executes on injection.)
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      expect(await page.evaluate(() => Object.keys(window.__TAA_GM_VALUES__ ?? {}))).toEqual([]);

      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      // No post-install storage assertion here: install injects the artifact
      // immediately, so any read already races its first legitimate writes.
      // Empty-start is proven by the pre-install reads above.
      await useLoopbackTransport(page, ns);
      const events = await waitSnapshot(page);
      expect(events.filter((e) => e.kind === 'snapshot' && e.status === 'authoritative')).toHaveLength(1);

      // Baseline + roster persisted (roster carries identity only, never a zero baseline).
      const roster = await page.evaluate((key: string) => localStorage.getItem(key), ROSTER_KEY);
      expect(roster).not.toBeNull();
      expect(JSON.parse(roster as string)['127.0.0.1']['101'].name).toBe('Synthetic 101');
      const envelope = await monitorEnvelope(page);
      expect(envelope.baseline101).toMatchObject({ attackCount: 0, raidCount: 0 });
      expect(envelope.pending).toEqual([]);
      expect(envelope.failed).toEqual([]);
      expect(envelope.uncertain).toEqual([]);

      // Zero Discord traffic: neither the in-page transport log nor the loopback sink saw anything.
      expect(await transportTargets(page)).toEqual([]);
      expect(await serverRequestCount(page, ns)).toBe(0);

      // UI distinguishes script-running / baseline-established / scan-accepted / webhook-missing.
      await openPanel(page);
      const overlay = await page.locator('#taa-panel-overlay').innerText();
      expect(overlay).toContain('Leader — this tab owns monitoring and transport.');
      expect(await overlayMetric(page, 'Overview', 'taa-overview-scan-result-value')).toBe('accepted/authoritative');
      expect(await overlayMetric(page, 'Overview', 'taa-freshness-value')).toMatch(/^Fresh — observed/);
      expect(await overlayMetric(page, 'Overview', 'taa-queue-count-value')).toBe('0 / 0');
      expect(await overlayMetric(page, 'Overview', 'taa-failure-count-value')).toBe('0 / 0');
      expect(await overlayMetric(page, 'Overview', 'taa-last-sent-value')).toBe('Not recorded');
      expect(await overlayMetric(page, 'Diagnostics', 'taa-route-role-value')).toBe('canonical-member');
      expect(await overlayMetric(page, 'Diagnostics', 'taa-scan-reason-value')).toBe('authoritative');
      expect(await overlayMetric(page, 'Diagnostics', 'taa-scan-outcome-value')).toBe('ok');
      expect(await overlayMetric(page, 'Diagnostics', 'taa-delivery-totals-value')).toBe('0 / 0 / 0 / 0 / 0');

      // Loopback-only: every transport target stays same-origin https loopback.
      const origin = await page.evaluate(() => location.origin);
      expect(origin).toBe(HTTPS_ORIGIN);
      expect((await transportTargets(page)).every((url) => url.startsWith(origin))).toBe(true);
      expect(consoleErrors(page)).toEqual([]);

      writeEvidencePhase('first-accepted-scan', {
        artifact: 'dist/travian-attack-alert.user.js',
        origin: HTTPS_ORIGIN,
        emptyStart: { localStorageKeysBeforeInstall: 0, gmStoreKeysBeforeInstall: [] },
        snapshot: events,
        baseline101: envelope.baseline101,
        rosterHosts: Object.keys(JSON.parse(roster as string)),
        discordRequestsAfterFirstScan: 0,
        overview: { scanResult: 'accepted/authoritative', queue: '0 / 0', lastSent: 'Not recorded' },
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('synthetic +1 attack for 101 delivers exactly one loopback request, then acknowledges', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(90_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    const transportLog: string[] = [];
    page.on('console', (msg) => { if (msg.text().includes('[Alliance Discord]')) transportLog.push(msg.text()); });
    try {
      // Cycle 1: clean baseline with 101 at zero attacks, no webhook.
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      await useLoopbackTransport(page, ns);
      await waitSnapshot(page);
      expect(await serverRequestCount(page, ns)).toBe(0);
      await warmupTransport(page, ns);

      // Cycle 2: reload (GM restored = persistent Tampermonkey GM), same rename plus
      // the synthetic attack icon, webhook configured. The scan must QUEUE the delta
      // without sending yet (startup flush already ran before the scan).
      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      const cycle2events = await waitSnapshot(page);
      expect(cycle2events.filter((e) => e.kind === 'snapshot' && e.status === 'authoritative')).toHaveLength(1);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      expect(await serverRequestCount(page, ns)).toBe(1); // warmup only — product queued, did not send
      const queued = await monitorEnvelope(page);
      expect((queued.pending[0] as { playerId?: string; addedAttackCount?: number }).playerId).toBe('101');
      expect((queued.pending[0] as { playerId?: string; addedAttackCount?: number }).addedAttackCount).toBe(1);

      // Cycle 3: reload carries the pending batch; the startup flush delivers it.
      // Exactly ONE new loopback request must appear (attempt #2 = 200 after warmup).
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(() => serverRequestCount(page, ns), { timeout: 20_000 }).toBe(2);
      const requests = await serverRequests(page, ns);
      const productRequests = requests.slice(1);
      expect(productRequests).toHaveLength(1);
      const serialized = JSON.stringify(productRequests[0].body);
      expect(serialized).toContain('/profile/101');
      expect(serialized).not.toContain('"parse"');
      const taaTargets = await transportTargets(page);
      expect(taaTargets).toHaveLength(1);
      const origin = await page.evaluate(() => location.origin);
      expect(taaTargets.every((url) => url.startsWith(origin))).toBe(true);

      // Acknowledged exactly once: pending drained, terminal holds one acknowledged
      // record for 101, failed/uncertain stay empty.
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);
      const settled = await monitorEnvelope(page);
      expect(settled.failed).toEqual([]);
      expect(settled.uncertain).toEqual([]);
      expect(transportLog.some((line) => line.includes('Batch alert sent'))).toBe(true);
      expect(consoleErrors(page)).toEqual([]);

      await openPanel(page);
      expect(await overlayMetric(page, 'Overview', 'taa-queue-count-value')).toBe('0 / 0');
      expect(await overlayMetric(page, 'Overview', 'taa-last-sent-value')).not.toBe('Not recorded');
      // The Diagnostics acknowledged counter counts represented sourceEventIds;
      // runtime-contract events carry none, so it stays 0 here while the ledger
      // above proves the acknowledgement. Panel-count ownership: Todos 10/13.

      writeEvidencePhase('delta-single-delivery', {
        queuedPlayerId: '101',
        serverRequestsTotal: 2,
        warmupEntries: 1,
        productRequests: 1,
        productRequestBody: productRequests[0].body,
        terminalAcknowledged: 1,
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('reload with identical state duplicates nothing; queue and ledger intact', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(120_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      // Full journey in one document series: baseline -> queue -> deliver.
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      await useLoopbackTransport(page, ns);
      await waitSnapshot(page);
      await warmupTransport(page, ns);
      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(() => serverRequestCount(page, ns), { timeout: 20_000 }).toBe(2);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);
      const before = await monitorEnvelope(page);
      const baselineBefore = JSON.stringify(before.baseline101);

      // Identical state again: same rename, same icon, same webhook. Startup flush
      // finds nothing to deliver, the scan finds no delta.
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      const reloadEvents = await waitSnapshot(page);
      expect(reloadEvents.filter((e) => e.kind === 'snapshot' && e.status === 'authoritative')).toHaveLength(1);
      await page.waitForTimeout(8000); // settle past startup flush + scan commit
      expect(await serverRequestCount(page, ns)).toBe(2);
      expect(await transportTargets(page)).toHaveLength(0);
      const after = await monitorEnvelope(page);
      expect(after.pending).toEqual([]);
      expect(after.failed).toEqual([]);
      expect(after.uncertain).toEqual([]);
      expect(after.terminal.filter((t) => t.terminalStatus === 'acknowledged')).toHaveLength(1);
      expect(JSON.stringify(after.baseline101)).toBe(baselineBefore);
      expect(consoleErrors(page)).toEqual([]);

      writeEvidencePhase('reload-no-duplication', {
        serverRequestsBeforeReload: 2,
        serverRequestsAfterReload: 2,
        acknowledgedTerminal: 1,
        baseline101Unchanged: true,
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('malformed DOM is rejected (malformed-count) and creates no baseline record', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { malformedIcon: true, iconRow: '/profile/900001' });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      await useLoopbackTransport(page, ns);
      const events = await waitSnapshot(page);
      expect(events.filter((e) => e.kind === 'snapshot' && e.status === 'rejected' && e.reason === 'malformed-count')).toHaveLength(1);

      // Storage stays absent: GM holds no monitor envelope (never a zero baseline),
      // localStorage holds no roster. Only route/lease/diagnostics traces may exist.
      expect(await page.evaluate(() => Object.keys(window.__TAA_GM_VALUES__ ?? {}))).toEqual([]);
      expect(await page.evaluate((key: string) => localStorage.getItem(key), ROSTER_KEY)).toBeNull();
      expect(await serverRequestCount(page, ns)).toBe(0);
      expect(consoleErrors(page)).toEqual([]);

      writeEvidencePhase('malformed-rejected-no-baseline', {
        reason: 'malformed-count',
        gmKeys: [],
        roster: null,
        discordRequests: 0,
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('missing member table is rejected (readiness-timeout) and never becomes a zero baseline', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(60_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { removeTable: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      await useLoopbackTransport(page, ns);
      await expect.poll(async () => await page.evaluate(() => {
        const stored = localStorage.getItem('travianAllianceDiagnostics_v2') || '{}';
        const diagnostics = JSON.parse(stored) as Record<string, { records?: Array<{ reason?: string; stage?: string; status?: string }> }>;
        return Object.values(diagnostics).flatMap((world) => world.records || []).filter((record) => record.stage === 'snapshot' && record.status === 'rejected').length;
      }), { timeout: 25_000 }).toBeGreaterThan(0);
      const reasons = await page.evaluate(() => {
        const stored = localStorage.getItem('travianAllianceDiagnostics_v2') || '{}';
        const diagnostics = JSON.parse(stored) as Record<string, { records?: Array<{ reason?: string; stage?: string; status?: string }> }>;
        return Object.values(diagnostics).flatMap((world) => world.records || []).filter((record) => record.stage === 'snapshot' && record.status === 'rejected').map((record) => record.reason);
      });
      expect(reasons).toContain('readiness-timeout');
      expect(await page.evaluate(() => Object.keys(window.__TAA_GM_VALUES__ ?? {}))).toEqual([]);
      expect(await page.evaluate((key: string) => localStorage.getItem(key), ROSTER_KEY)).toBeNull();
      expect(await serverRequestCount(page, ns)).toBe(0);
      expect(consoleErrors(page)).toEqual([]);

      writeEvidencePhase('missing-table-rejected-no-baseline', {
        reasons,
        gmKeys: [],
        roster: null,
        discordRequests: 0,
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('missing webhook keeps a recoverable pending queue with no false delivery-success', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(90_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    const transportLog: string[] = [];
    page.on('console', (msg) => { if (msg.text().includes('[Alliance Discord]')) transportLog.push(msg.text()); });
    try {
      // Cycle 1: baseline, no webhook anywhere.
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST, ns });
      await useLoopbackTransport(page, ns);
      await waitSnapshot(page);
      expect(await serverRequestCount(page, ns)).toBe(0);

      // Cycle 2: the +1 delta is detected but the webhook is still missing.
      // The record stays pending (recoverable, never acknowledged) and nothing is sent.
      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      await page.waitForTimeout(5000); // settle: no flush vector fires without a webhook
      expect(await serverRequestCount(page, ns)).toBe(0);
      const queued = await monitorEnvelope(page);
      expect((queued.pending[0] as { playerId?: string }).playerId).toBe('101');
      expect(queued.failed).toEqual([]);
      expect(queued.uncertain).toEqual([]);
      expect(queued.terminal).toEqual([]);
      expect(transportLog.some((line) => line.includes('Batch alert sent'))).toBe(false);

      await openPanel(page);
      expect(await overlayMetric(page, 'Overview', 'taa-queue-count-value')).toBe('1 / 0');
      expect(await overlayMetric(page, 'Overview', 'taa-last-sent-value')).toBe('Not recorded');
      expect(await overlayMetric(page, 'Diagnostics', 'taa-delivery-totals-value')).toBe('1 / 0 / 0 / 0 / 0');

      // Recoverable: configuring the webhook later delivers the SAME record once.
      await warmupTransport(page, ns);
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(() => serverRequestCount(page, ns), { timeout: 20_000 }).toBe(2);
      const productRequests = (await serverRequests(page, ns)).slice(1);
      expect(productRequests).toHaveLength(1);
      expect(JSON.stringify(productRequests[0].body)).toContain('/profile/101');
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);
      const settled = await monitorEnvelope(page);
      expect(settled.terminal.filter((t) => t.terminalStatus === 'acknowledged')).toHaveLength(1);

      writeEvidencePhase('missing-webhook-recoverable-queue', {
        queuedWhileMissing: 1,
        deliveredAfterWebhookConfigured: 1,
        falseDeliverySuccess: false,
      }, ns);
    } finally {
      await closeHttpsPage(target);
    }
  });
});
