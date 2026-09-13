// Todo 10 — artifact dispatch + transport recovery through the FINAL bytes.
//
// Proves, against dist/travian-attack-alert.user.js (NOT script.txt, NOT a
// manual fetch), that real artifact dispatch to the loopback sink:
//   T1 (matrix a / QA happy): 429 with retry_after:1 then 200+ID gives exactly
//      2 wire attempts ~1000 ms apart and one acknowledged ledger entry.
//   T2 (matrix f): a queued batch survives a page restart with an identical
//      record, then delivers once and acknowledges.
//   T3 (matrix j): a player nicknamed "@everyone" never pings — the WIRE body
//      carries an explicit user allowlist, no `parse` key, and ping-free
//      content.
//
// What this spec does NOT prove (owned by test/artifact/delivery-matrix):
// 5xx/timeout/abort/network bounded retry, 404/410 failed retention,
// malformed-200 uncertain single-request, duplicate-ID single-send identity,
// 60-event forced-split mentions-once, storage-failure baseline safety.
// Those run as node:test against the same dist bytes (fast, deterministic).
//
// Harness (reused from Todo 9, no second harness, no harness changes):
// - installArtifactRuntime(page, { artifactPath: DIST }) + per-navigation
//   installLoopbackTransport(page) over the fixture's inline fake-ack stub.
// - Ephemeral-TLS origin https://127.0.0.1:8898 (safeAllianceUrl trusts https
//   page origins only); loopback-only, synthetic playerId 101, FAKE token.
// - GM persistence across reloads emulated spec-locally (snapshot/restore),
//   mirroring real Tampermonkey; no harness change.
// - NO warmupTransport here: the sink's first-attempt 429 IS the stimulus
//   under test (the product must retry it, unlike clean-install which burns
//   it to isolate delivery shape).
// - Per-spec evidence test-results/release-1.0.0/e2e-evidence-discord-delivery.json.
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { installArtifactRuntime, installLoopbackTransport } from './runtime-bootstrap';

const DIST = '/dist/travian-attack-alert.user.js';
const HTTPS_ORIGIN = 'https://127.0.0.1:8898';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/FAKE-delivery-token-0123456789abcdef';
const MONITOR_KEY = 'travianAllianceMonitor_v1:127.0.0.1';
const MAPPINGS_KEY = 'travianAlliancePlayerMappings_v1';
const MAPPED_USER = '123456789012345678';
const EVIDENCE_PATH = path.join('test-results', 'release-1.0.0', 'e2e-evidence-discord-delivery.json');

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

function writeEvidencePhase(phase: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  const existing = fs.existsSync(EVIDENCE_PATH) ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8')) : {};
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ ...existing, [phase]: value }, null, 2)}\n`);
}

type WireRequest = { attempt: number; startedAt: number; endedAt: number; body: Record<string, unknown> };

async function wireRequests(page: Page): Promise<WireRequest[]> {
  const log = await page.evaluate(async () => await (await fetch('/e2e-log')).json());
  return (log.discordRequests ?? []) as WireRequest[];
}

async function wireCount(page: Page): Promise<number> {
  return (await wireRequests(page)).length;
}

async function waitSnapshot(page: Page, timeout = 10_000): Promise<void> {
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((e) => (e as { kind?: string }).kind === 'snapshot').length ?? 0), { timeout }).toBeGreaterThan(0);
}

type PrepConfig = { rename101?: boolean; displayName?: string; attackIcon?: boolean };

async function installPrepHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        const raw = localStorage.getItem('__taa_delivery_prep');
        if (!raw) return;
        localStorage.removeItem('__taa_delivery_prep');
        const cfg = JSON.parse(raw) as { rename101?: boolean; displayName?: string; attackIcon?: boolean };
        if (cfg.rename101) {
          const link = document.querySelector('a[href="/profile/900001"]');
          if (link) { link.setAttribute('href', '/profile/101'); link.textContent = cfg.displayName || 'Synthetic 101'; }
        }
        if (cfg.attackIcon) {
          const row = document.querySelector('a[href="/profile/101"]')?.closest('tr');
          if (!row) throw new Error('icon target row missing');
          const img = document.createElement('img');
          img.className = 'attack';
          img.setAttribute('title', '1 attack');
          img.width = 16; img.height = 16;
          row.appendChild(img);
        }
      } catch { /* test scaffolding only; never masks product behavior */ }
    });
  });
}

async function stagePrep(page: Page, cfg: PrepConfig): Promise<void> {
  await page.evaluate((config: PrepConfig) => localStorage.setItem('__taa_delivery_prep', JSON.stringify(config)), cfg);
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

async function useLoopbackTransport(page: Page): Promise<void> {
  await installLoopbackTransport(page);
}

async function injectDist(page: Page): Promise<void> {
  await page.addScriptTag({ content: await page.evaluate(async (artifactPath: string) => await (await fetch(artifactPath)).text(), DIST) });
}

function monitorEnvelope(page: Page): Promise<{
  pending: Array<Record<string, unknown>>;
  inFlight: Array<Record<string, unknown>>;
  failed: unknown[]; uncertain: unknown[];
  terminal: Array<{ terminalStatus?: string }>;
}> {
  return page.evaluate((key: string) => {
    const raw = (window.__TAA_GM_VALUES__?.[key] as string) || '{}';
    const envelope = JSON.parse(raw) as {
      pending?: Array<Record<string, unknown>>; inFlight?: Array<Record<string, unknown>>;
      failed?: unknown[]; uncertain?: unknown[];
      metrics?: { deliveryAccounting?: { terminal?: Array<{ terminalStatus?: string }> } };
    };
    return {
      pending: envelope.pending ?? [],
      inFlight: envelope.inFlight ?? [],
      failed: envelope.failed ?? [],
      uncertain: envelope.uncertain ?? [],
      terminal: envelope.metrics?.deliveryAccounting?.terminal ?? [],
    };
  }, MONITOR_KEY);
}

function lineageOf(record: Record<string, unknown>): Record<string, unknown> {
  // Identity + source lineage only. Wall-clock bookkeeping (queuedAtMs,
  // dispatchedAtMs, attemptCount) legitimately advances when the startup
  // flush touches the record after a restart — it is not lineage loss.
  return {
    eventId: record.eventId ?? null,
    playerId: record.playerId ?? null,
    eventType: record.eventType ?? null,
    addedAttackCount: record.addedAttackCount ?? null,
    addedRaidCount: record.addedRaidCount ?? null,
    sourceEventIds: record.sourceEventIds ?? [],
  };
}

test.describe('artifact dispatch — durable delivery and recovery', () => {
  test('429 retry_after:1 then 200+ID: 2 attempts ~1000 ms apart, acknowledged once', async ({ browser }) => {
    test.setTimeout(120_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      // Cycle 1: clean baseline for 101 at zero attacks (no webhook yet, no traffic).
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST });
      await useLoopbackTransport(page);
      await waitSnapshot(page);
      expect(await wireCount(page)).toBe(0);

      // Cycle 2: the +1 delta queues (startup flush already ran before the scan).
      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      expect(await wireCount(page)).toBe(0);

      // Cycle 3: the startup flush delivers against the sink whose FIRST
      // attempt is 429 + retry_after:1. The artifact must retry once (~1000 ms)
      // and acknowledge on the 200+ID second attempt.
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(() => wireCount(page), { timeout: 30_000 }).toBe(2);
      const requests = await wireRequests(page);
      const gapMs = requests[1].startedAt - requests[0].startedAt;
      expect(gapMs).toBeGreaterThanOrEqual(900);
      expect(gapMs).toBeLessThanOrEqual(20_000);
      for (const req of requests) {
        expect(JSON.stringify(req.body)).toContain('/profile/101');
        expect(req.body.allowed_mentions).toEqual({ users: [] });
        expect('parse' in (req.body.allowed_mentions as Record<string, unknown>)).toBe(false);
      }
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);
      const settled = await monitorEnvelope(page);
      expect(settled.failed).toEqual([]);
      expect(settled.uncertain).toEqual([]);

      writeEvidencePhase('retry-then-acknowledged', {
        wireAttempts: 2, gapMs, acknowledgedTerminal: 1,
        firstBody: requests[0].body, secondBody: requests[1].body,
      });
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('queued batch survives restart with identical record, then delivers once', async ({ browser }) => {
    test.setTimeout(120_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await stagePrep(page, { rename101: true });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST });
      await useLoopbackTransport(page);
      await waitSnapshot(page);

      // Queue the delta (webhook configured, but the startup flush for this
      // cycle already ran before the scan committed the record).
      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      const lineageBefore = lineageOf((await monitorEnvelope(page)).pending[0]);

      // Restart: kill the page (new document, restored GM = persistent
      // Tampermonkey). The startup flush may already have moved the record
      // pending→inFlight by the time we read, so lineage is asserted over
      // pending ∪ inFlight — the recoverable set — not over one slot.
      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      const afterRestart = await monitorEnvelope(page);
      const recoverable = [...afterRestart.pending, ...afterRestart.inFlight];
      expect(recoverable.length).toBe(1);
      expect(lineageOf(recoverable[0])).toEqual(lineageBefore);

      // The same startup flush then delivers (429 + 200) and acknowledges once.
      await expect.poll(() => wireCount(page), { timeout: 30_000 }).toBe(2);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);

      writeEvidencePhase('restart-preserves-then-acks', {
        lineageIdentical: true, wireAttempts: 2, acknowledgedTerminal: 1,
      });
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('player nicknamed @everyone never pings on the wire', async ({ browser }) => {
    test.setTimeout(120_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      await installPrepHook(page);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      // Nickname the row "@everyone" from the very first scan and map 101 to
      // an explicit Discord user: any ping would have to come from content.
      await stagePrep(page, { rename101: true, displayName: '@everyone' });
      await installArtifactRuntime(page, { path: '/alliance/profile/members', artifactPath: DIST });
      await useLoopbackTransport(page);
      await page.evaluate(([key, uid]: [string, string]) => localStorage.setItem(
        key, JSON.stringify({ '127.0.0.1': { 101: [uid] } })
      ), [MAPPINGS_KEY, MAPPED_USER] as unknown as [string, string]);
      await waitSnapshot(page);
      expect(await wireCount(page)).toBe(0);

      let gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, displayName: '@everyone', attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);

      gm = await snapshotGM(page);
      await stagePrep(page, { rename101: true, displayName: '@everyone', attackIcon: true });
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitSnapshot(page);
      await expect.poll(() => wireCount(page), { timeout: 30_000 }).toBe(2);
      const requests = await wireRequests(page);
      for (const req of requests) {
        const body = req.body as { content?: string; allowed_mentions?: Record<string, unknown>; embeds?: unknown[] };
        expect(body.allowed_mentions).toEqual({ users: [MAPPED_USER] });
        expect('parse' in (body.allowed_mentions as Record<string, unknown>)).toBe(false);
        expect(String(body.content)).not.toContain('@everyone');
        expect(String(body.content)).not.toContain('@here');
        expect(JSON.stringify(body)).not.toContain('"parse"');
        expect(JSON.stringify(body.embeds)).not.toContain('<@');
      }
      await expect.poll(async () => (await monitorEnvelope(page)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);

      writeEvidencePhase('everyone-nickname-no-ping', {
        wireAttempts: 2, allowlist: requests[1].body.allowed_mentions,
        content: (requests[1].body as { content?: string }).content,
      });
    } finally {
      await closeHttpsPage(target);
    }
  });
});
