// Todo 20 (split out for runtime) — same-document lease reacquisition around
// the first scan. A leader that loses the lease before its first authoritative
// scan gets a `lease-lost-before-scan` terminal; the renewal failure at the
// 30 s cadence starts the follower watchdog, which reacquires authority in this
// SAME document. The accepted-scan terminal must never block that resume.
//
// Why this is a SEPARATE spec file (Task 19/20 runtime contract):
// both tests wait on the product's real ~30 s lease-renewal cadence (≈70-150 s
// per project), so running them on all six Chromium projects pushed the
// dual-tab-lease spec over `tools/run-e2e.cjs`'s hard 480 s per-spec ceiling.
// They are restricted to ONE representative desktop project (chromium-1280)
// through the QA config's per-project `testIgnore` — a project filter, not a
// `test.skip`: release mode rejects any skipped execution, so a filter keeps
// the proof real while the other five projects still run the rest of
// dual-tab-lease.spec.ts. The behavioral assertions are byte-identical to the
// Task 20 originals (moved, never weakened).
//
// Honest scaffolding (identical to dual-tab-lease.spec.ts): realLocks:true
// harness option skips the navigator.locks stub so contention is real;
// localStorage is shared by same-context pages; GM storage is per-document but
// shared in production. Synthetic data only (playerId 101, loopback
// 127.0.0.1 over the ephemeral-TLS :8898 origin). Evidence goes to
// test-results/release-1.0.0/e2e-evidence-dual-tab-lease-reacquisition.json
// (per-spec file; never the shared test-results/e2e-runtime.json).
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { installArtifactRuntime, installLoopbackTransport, writeEvidencePhase as writeEvidencePhaseShared } from './runtime-bootstrap';

const DIST = '/dist/travian-attack-alert.user.js';
const HTTPS_ORIGIN = 'https://127.0.0.1:8898';
const MEMBERS = '/alliance/profile/members';
const MONITOR_KEY = 'travianAllianceMonitor_v1:127.0.0.1';
const LEASE_KEY = 'travianAllianceTabLease_v1';
const EVIDENCE_PATH = path.join('test-results', 'release-1.0.0', 'e2e-evidence-dual-tab-lease-reacquisition.json');

type PrepConfig = { rename101?: boolean; attackIcon101?: boolean; rename102?: boolean; raidIcon102?: boolean; hideTable?: boolean };
type SnapshotEvent = { kind: string; status?: string; reason?: string };
type LeaseRecord = { ownerId?: string; token?: string; generation?: number; term?: number; expiresAtMs?: number } | null;
type Envelope = {
  pending: Array<{ playerId?: string; eventId?: string; sourceEventIds?: string[] }>;
  failed: unknown[];
  uncertain: unknown[];
  inFlight: Array<{ playerId?: string; eventId?: string; sourceEventIds?: string[] }>;
  generation: unknown;
  terminal: Array<{ terminalStatus?: string; playerId?: string }>;
};

function attachConsole(page: Page): void {
  const consoleErrors: string[] = [];
  const consoleTexts: string[] = [];
  page.on('console', (msg) => {
    consoleTexts.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  (page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
  (page as unknown as { __consoleTexts: string[] }).__consoleTexts = consoleTexts;
}

async function newHttpsContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: HTTPS_ORIGIN });
  const page = await context.newPage();
  attachConsole(page);
  return { context, page };
}

function consoleErrors(page: Page): string[] {
  return (page as unknown as { __consoleErrors: string[] }).__consoleErrors ?? [];
}

function writeEvidencePhase(phase: string, value: Record<string, unknown>, workerIndex: number): void {
  writeEvidencePhaseShared(EVIDENCE_PATH, phase, value, workerIndex);
}

// Canonical member-table prep, staged via shared localStorage and consumed by a
// document_start DCL hook strictly before the artifact boot/readiness window
// (same race-free pattern as the Todo 9 specs). Staged per navigation because
// the hook removes the key on consumption.
async function installPrepHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        const raw = localStorage.getItem('__taa_dual_prep');
        if (!raw) return;
        localStorage.removeItem('__taa_dual_prep');
        const cfg = JSON.parse(raw) as { rename101?: boolean; attackIcon101?: boolean; rename102?: boolean; raidIcon102?: boolean; hideTable?: boolean };
        const rename = (from: string, to: string, name: string) => {
          const link = document.querySelector(`a[href="${from}"]`);
          if (link) { link.setAttribute('href', to); link.textContent = name; }
        };
        if (cfg.rename101) rename('/profile/900001', '/profile/101', 'Synthetic 101');
        if (cfg.rename102) rename('/profile/900002', '/profile/102', 'Synthetic 102');
        const addIcon = (href: string, title: string) => {
          const row = document.querySelector(`a[href="${href}"]`)?.closest('tr');
          if (!row) throw new Error('icon target row missing');
          const img = document.createElement('img');
          img.className = 'attack';
          img.setAttribute('title', title);
          img.width = 16; img.height = 16;
          row.appendChild(img);
        };
        if (cfg.attackIcon101) addIcon('/profile/101', '1 attack');
        if (cfg.raidIcon102) addIcon('/profile/102', '1 raid');
        // Pre-scan lease-loss scenario: keep the member table OUT of the DOM
        // for the whole boot readiness window, stashed for a later reveal.
        if (cfg.hideTable) {
          const table = document.querySelector('table.allianceMembers');
          if (table) {
            (window as unknown as { __taaHiddenTable?: Element }).__taaHiddenTable = table;
            table.remove();
          }
        }
      } catch { /* test scaffolding only; never masks product behavior */ }
    });
  });
}

async function stagePrep(page: Page, cfg: PrepConfig): Promise<void> {
  await page.evaluate((config: PrepConfig) => localStorage.setItem('__taa_dual_prep', JSON.stringify(config)), cfg);
}

async function revealTable(page: Page): Promise<void> {
  await page.evaluate(() => {
    const table = (window as unknown as { __taaHiddenTable?: Element }).__taaHiddenTable;
    if (table && !table.isConnected) document.body.appendChild(table);
  });
}

async function diagnosticsText(page: Page): Promise<string> {
  return await page.evaluate(() => localStorage.getItem('travianAllianceDiagnostics_v2') ?? '');
}

async function eventKinds(page: Page, kind: string, status?: string): Promise<SnapshotEvent[]> {
  const events = await snapshotEvents(page);
  return events.filter((event) => event.kind === kind && (status === undefined || event.status === status));
}

async function reacquiredWithNewToken(page: Page, previousToken: string | undefined): Promise<boolean> {
  const record = await leaseRecord(page);
  return Boolean(record && record.token && record.token !== previousToken);
}

// First boot of a page under REAL locks. The bare goto establishes the origin
// (fresh pages are origin-less and deny localStorage); staging then happens on
// the second navigation inside installArtifactRuntime, whose DCL hook consumes
// it strictly before artifact boot.
async function bootRealPage(page: Page, prep: PrepConfig, webhook = false, ns: string | number = ''): Promise<void> {
  await page.goto(MEMBERS, { waitUntil: 'domcontentloaded' });
  await stagePrep(page, prep);
  await installArtifactRuntime(page, { path: MEMBERS, artifactPath: DIST, realLocks: true, webhook, ns });
  await useLoopbackTransport(page, ns);
}

async function useLoopbackTransport(page: Page, ns: string | number = ''): Promise<void> {
  await installLoopbackTransport(page, ns);
}

async function waitAuthoritativeSnapshot(page: Page, timeout = 15_000): Promise<void> {
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((e) => (e as SnapshotEvent).kind === 'snapshot' && (e as SnapshotEvent).status === 'authoritative').length ?? 0), { timeout }).toBe(1);
}

async function leaseState(page: Page): Promise<string> {
  return await page.evaluate(() => document.body?.dataset?.taaLeaseState ?? '');
}

async function leaseRecord(page: Page): Promise<LeaseRecord> {
  return await page.evaluate((key: string) => {
    try {
      const map = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, LeaseRecord>;
      return (map['127.0.0.1'] as LeaseRecord) ?? null;
    } catch { return null; }
  }, LEASE_KEY);
}

async function transportTargets(page: Page): Promise<string[]> {
  return await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
}

async function snapshotEvents(page: Page): Promise<SnapshotEvent[]> {
  return await page.evaluate(() => (window.__TAA_E2E_EVENTS__ ?? []) as SnapshotEvent[]);
}

async function monitorEnvelope(page: Page): Promise<Envelope> {
  return page.evaluate((key: string) => {
    const raw = (window.__TAA_GM_VALUES__?.[key] as string) || '{}';
    const envelope = JSON.parse(raw) as { pending?: Envelope['pending']; failed?: unknown[]; uncertain?: unknown[]; inFlight?: Envelope['inFlight']; generation?: unknown; metrics?: { deliveryAccounting?: { terminal?: Envelope['terminal'] } } };
    return {
      pending: envelope.pending ?? [],
      failed: envelope.failed ?? [],
      uncertain: envelope.uncertain ?? [],
      inFlight: envelope.inFlight ?? [],
      generation: envelope.generation ?? null,
      terminal: envelope.metrics?.deliveryAccounting?.terminal ?? [],
    };
  }, MONITOR_KEY);
}

test.describe('dual-tab lease reacquisition — same-document resume around the first scan', () => {
  test('pre-scan lease loss then same-document reacquisition performs exactly one accepted scan', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(150_000);
    const { context, page } = await newHttpsContext(browser);
    try {
      await installPrepHook(page);
      await bootRealPage(page, { rename101: true, hideTable: true }, false, ns);
      await page.waitForTimeout(1500); // past boot jitter + readiness window
      expect(await leaseState(page)).toBe('leader');
      expect(await eventKinds(page, 'snapshot', 'authoritative')).toEqual([]);
      expect(await eventKinds(page, 'extraction')).toEqual([]);
      const bootRecord = await leaseRecord(page);
      expect(bootRecord).not.toBeNull();

      // Lease loss BEFORE the first scan, then the member table appears: the
      // readiness check finds no lease owner and records the pre-scan terminal.
      // The reveal + nudge repeats because the product reschedules readiness
      // from a quiet-window remainder, so one tick can land the check early.
      await page.evaluate((key: string) => localStorage.removeItem(key), LEASE_KEY);
      await expect.poll(async () => {
        await revealTable(page);
        await page.evaluate(() => document.body.toggleAttribute('data-taa-readiness-nudge'));
        return await diagnosticsText(page);
      }, { timeout: 10_000 }).toContain('lease-lost-before-scan');
      expect(await eventKinds(page, 'extraction')).toEqual([]);

      // 30 s renewal fails -> standby -> watchdog reacquires in THIS document
      // (new token, same page, no navigation).
      await expect.poll(async () => await reacquiredWithNewToken(page, bootRecord?.token), { timeout: 45_000 }).toBe(true);
      expect(await leaseState(page)).toBe('leader');

      // Exactly one accepted scan, one extraction, no transport, no queue.
      await waitAuthoritativeSnapshot(page, 15_000);
      expect(await eventKinds(page, 'extraction')).toHaveLength(1);
      expect(await eventKinds(page, 'snapshot', 'authoritative')).toHaveLength(1);
      expect(await transportTargets(page)).toEqual([]);
      expect((await monitorEnvelope(page)).pending).toEqual([]);
      expect(await consoleErrors(page)).toEqual([]);

      writeEvidencePhase('t5-prescan-reacquisition', {
        leaseLostBeforeFirstScan: true,
        preScanTerminal: 'lease-lost-before-scan',
        reacquiredSameDocument: true,
        preReacquireExtractions: 0,
        acceptedScans: 1,
        extractions: 1,
        transportRequests: 0,
      }, ns);
    } finally {
      await context.close();
    }
  });

  test('reacquisition after an accepted scan performs no second scan and no duplicate event', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(150_000);
    const { context, page } = await newHttpsContext(browser);
    try {
      await installPrepHook(page);
      await bootRealPage(page, { rename101: true }, false, ns);
      await waitAuthoritativeSnapshot(page);
      expect(await eventKinds(page, 'extraction')).toHaveLength(1);
      const firstRecord = await leaseRecord(page);
      expect(firstRecord).not.toBeNull();

      await page.evaluate((key: string) => localStorage.removeItem(key), LEASE_KEY);
      await expect.poll(async () => await reacquiredWithNewToken(page, firstRecord?.token), { timeout: 45_000 }).toBe(true);
      expect(await leaseState(page)).toBe('leader');
      await page.waitForTimeout(6000); // any wrong post-reacquisition scan would fire here

      expect(await eventKinds(page, 'snapshot', 'authoritative')).toHaveLength(1);
      expect(await eventKinds(page, 'extraction')).toHaveLength(1);
      expect(await transportTargets(page)).toEqual([]);
      expect((await monitorEnvelope(page)).pending).toEqual([]);
      expect(await consoleErrors(page)).toEqual([]);

      writeEvidencePhase('t6-postscan-reacquisition', {
        acceptedScansBeforeLoss: 1,
        reacquiredSameDocument: true,
        acceptedScansAfterReacquire: 1,
        extractionsAfterReacquire: 1,
        duplicateEvents: 0,
      }, ns);
    } finally {
      await context.close();
    }
  });
});
