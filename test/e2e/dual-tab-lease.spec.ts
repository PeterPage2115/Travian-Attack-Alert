// Todo 11 — single-browser sender authority across two REAL pages.
//
// Proves, against the FINAL distributed bytes (dist/travian-attack-alert.user.js),
// with TWO REAL pages sharing ONE origin + REAL Web Locks (never the
// leader:false stub — that stub grants nothing and proves nothing about
// contention):
//   T1 (exclusivity): exactly ONE page becomes lease owner (named ownerId /
//      generation) and ONLY it scans/sends while the second page — really
//      queued on the owner's held Web Lock — claims no authority UI and sends
//      ZERO Discord requests (per-page counts, not just the server log). A
//      crafted foreign-valid lease then hands the queued page the genuine
//      leaseResult===false path, proving the visible standby is read-only.
//      (Production note, asserted: while the owner lives, the second tab is
//      pre-boot blank, not a standby panel — the lock callback cannot run.)
//   T2 (takeover): closing the owner releases the held lock, so the queued
//      page boots INTO leadership in its live document (no re-navigation);
//      the pending record is delivered EXACTLY ONCE and the
//      already-acknowledged record is never duplicated (one acked + one
//      pending seed to distinguish).
//   T3 (fence loss): revoking the lease between wire response and settle leaves
//      the record recoverable (pending/inFlight, never silently acknowledged,
//      never dropped) — the live settle() leader-lost path.
//   T4 (boundary): two browser CONTEXTS (separate storage/locks) each elect
//      their OWN owner — proving the local lock CANNOT fence a second profile
//      or computer. Operator rule for Todos 15-17 to quote: "one active
//      monitoring installation per alliance/world; a second computer or browser
//      profile WILL double-send; the local lock cannot prevent it."
//
// Honest scaffolding (all documented, none hidden):
// - realLocks:true harness option (runtime-bootstrap.ts) skips the
//   navigator.locks stub so contention is real. localStorage is shared by the
//   two same-context pages (like two real tabs); sessionStorage ownerIds stay
//   per-tab, so the winner and the standby are distinguishable.
// - GM storage is a per-document stub in the harness but shared Tampermonkey
//   storage in production. Cross-page queue lineage is emulated the Todo 9
//   way: snapshot GM JSON on one page, restore on the other — spec-local, the
//   same emulation the clean-install reload tests use for GM persistence.
// - T2 needs no navigation at all: the queued page's lock callback runs when
//   the owner closes, so it boots into leadership in its live document — the
//   genuine lock-handoff path. Its table state is staged at boot to match the
//   carried baseline exactly, so its first scan queues no phantom leave.
// - T3 holds the loopback response via the additive /e2e-delivery-hold gate
//   (default off; pre-existing specs untouched) and revokes the lease by
//   deleting the localStorage lease record — the same record the TTL-expiry
//   path reads, so settle() observes genuine lease loss.
// - Synthetic data only (playerIds 101/102, FAKE webhook token, loopback
//   127.0.0.1 over the ephemeral-TLS :8898 origin). Evidence goes to
//   test-results/release-1.0.0/e2e-evidence-dual-tab-lease.json (per-spec file;
//   never the shared test-results/e2e-runtime.json).
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { installArtifactRuntime, installLoopbackTransport } from './runtime-bootstrap';

const DIST = '/dist/travian-attack-alert.user.js';
const HTTPS_ORIGIN = 'https://127.0.0.1:8898';
const MEMBERS = '/alliance/profile/members';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/FAKE-dual-tab-token-0123456789abcdef';
const MONITOR_KEY = 'travianAllianceMonitor_v1:127.0.0.1';
const LEASE_KEY = 'travianAllianceTabLease_v1';
const OWNER_KEY = 'taa-tab-owner-id';
const EVIDENCE_PATH = path.join('test-results', 'release-1.0.0', 'e2e-evidence-dual-tab-lease.json');

// Operator rule, verbatim, for Todos 15-17 (docs) to quote: "one active
// monitoring installation per alliance/world; a second computer or browser
// profile WILL double-send; the local lock cannot prevent it."
const OPERATOR_RULE = 'one active monitoring installation per alliance/world; a second computer or browser profile WILL double-send; the local lock cannot prevent it.';

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

function writeEvidencePhase(phase: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  const existing = fs.existsSync(EVIDENCE_PATH) ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8')) : {};
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify({ ...existing, [phase]: value }, null, 2)}\n`);
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
async function bootRealPage(page: Page, prep: PrepConfig, webhook = false): Promise<void> {
  await page.goto(MEMBERS, { waitUntil: 'domcontentloaded' });
  await stagePrep(page, prep);
  await installArtifactRuntime(page, { path: MEMBERS, artifactPath: DIST, realLocks: true, webhook });
  await useLoopbackTransport(page);
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

async function setWebhook(page: Page): Promise<void> {
  await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
}

async function injectDist(page: Page): Promise<void> {
  await page.addScriptTag({ content: await page.evaluate(async (artifactPath: string) => await (await fetch(artifactPath)).text(), DIST) });
}

async function useLoopbackTransport(page: Page): Promise<void> {
  await installLoopbackTransport(page);
}

// The fixture page's inline script overwrites GM_registerMenuCommand with a
// noop AFTER the bootstrap init script ran, so menu commands would be lost.
// Re-install a capturing stub post-navigation (same reason the loopback
// transport is re-installed): the artifact registers its recovery commands
// into window.__TAA_MENU__ during boot.
async function useMenuCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__TAA_MENU__ = {};
    window.GM_registerMenuCommand = (name: string, callback: () => void) => {
      (window.__TAA_MENU__ as unknown as Record<string, () => void>)[name] = callback;
    };
  });
}

async function waitAuthoritativeSnapshot(page: Page, timeout = 15_000): Promise<void> {
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((e) => (e as SnapshotEvent).kind === 'snapshot' && (e as SnapshotEvent).status === 'authoritative').length ?? 0), { timeout }).toBe(1);
}

async function leaseState(page: Page): Promise<string> {
  return await page.evaluate(() => document.body?.dataset?.taaLeaseState ?? '');
}

async function ownerId(page: Page): Promise<string> {
  return await page.evaluate((key: string) => sessionStorage.getItem(key) ?? '', OWNER_KEY);
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

async function serverRequestCount(page: Page): Promise<number> {
  return await page.evaluate(async () => (await (await fetch('/e2e-log')).json()).discordRequests?.length ?? 0);
}

async function serverRequestBodies(page: Page): Promise<string[]> {
  const log = await page.evaluate(async () => await (await fetch('/e2e-log')).json()) as { discordRequests?: Array<{ body?: unknown }> };
  return (log.discordRequests ?? []).map((entry) => JSON.stringify(entry.body ?? {}));
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

function recoverable(envelope: Envelope): Array<{ playerId?: string; eventId?: string }> {
  return [...envelope.pending, ...envelope.inFlight];
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
  await expect(page.locator('#taa-panel-overlay')).toBeVisible({ timeout: 5000 });
}

// Manual reload cycle with GM carry (Todo 9 pattern): the startup flush runs
// before the scan, so a freshly queued delta is NOT sent in its own cycle.
async function reloadCycle(page: Page, prep: PrepConfig, gm: string, webhook: boolean): Promise<void> {
  await stagePrep(page, prep);
  await page.goto(MEMBERS, { waitUntil: 'domcontentloaded' });
  await useLoopbackTransport(page);
  await restoreGM(page, gm);
  if (webhook) await setWebhook(page);
  await useMenuCapture(page);
  await injectDist(page);
  await waitAuthoritativeSnapshot(page);
}

test.describe('dual-tab lease — single-browser sender authority', () => {
  test('exactly one real owner scans/sends; the standby is read-only with zero requests', async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page: owner } = await newHttpsContext(browser);
    const standby = await context.newPage();
    attachConsole(standby);
    try {
      await installPrepHook(owner);
      await installPrepHook(standby);

      // Owner boots first on the empty lease: commits the baseline, sends nothing.
      // No second page exists yet, so the owner keeps winning its own reloads.
      await bootRealPage(owner, { rename101: true });
      await waitAuthoritativeSnapshot(owner);
      expect(await serverRequestCount(owner)).toBe(0);

      // Burn the sink's first-attempt 429 (flagged, never product traffic),
      // then queue a synthetic +1 attack on the owner WITHOUT delivering it
      // (the startup flush already ran pre-scan).
      const seedGM = await snapshotGM(owner);
      await reloadCycle(owner, { rename101: true, attackIcon101: true }, seedGM, true);
      await expect.poll(async () => (await monitorEnvelope(owner)).pending.length, { timeout: 10_000 }).toBe(1);
      expect(await serverRequestCount(owner)).toBe(0); // queued, not sent

      // Standby boots while the owner HOLDS the exclusive lock: its lock
      // callback queues behind the owner and cannot run yet. The owner is
      // never navigated again while the standby is queued (a navigating owner
      // releases the lock and the queued follower would take over first).
      // NOTE: this boot resets the sink log AND re-arms its first-attempt
      // 429, so the warmup below must run AFTER it (well before the 30 s
      // flush below fires) for the measured delivery to be a single attempt.
      await bootRealPage(standby, { rename101: true });
      await setWebhook(standby); // standby CAN send (config present) — only fencing stops it
      await owner.request.post('/discord-webhook', { data: { content: 'warmup', allowed_mentions: { users: [] } }, headers: { 'Content-Type': 'application/json' } });
      await expect.poll(() => serverRequestCount(owner), { timeout: 5_000 }).toBe(1);
      await standby.waitForTimeout(3000); // past boot jitter: still queued, still silent

      // Exactly one owner, named by ownerId/generation, visible from BOTH pages
      // (shared localStorage lease record, like two real tabs).
      expect(await leaseState(owner)).toBe('leader');
      const ownerOwnerId = await ownerId(owner);
      const standbyOwnerId = await ownerId(standby);
      expect(ownerOwnerId).not.toBe('');
      expect(standbyOwnerId).not.toBe('');
      expect(standbyOwnerId).not.toBe(ownerOwnerId);
      const recordFromOwner = await leaseRecord(owner);
      const recordFromStandby = await leaseRecord(standby);
      expect(recordFromOwner).not.toBeNull();
      expect(recordFromStandby).toEqual(recordFromOwner);
      expect(recordFromOwner?.ownerId).toBe(ownerOwnerId);
      expect(recordFromOwner?.generation).toBeGreaterThanOrEqual(1);

      // The queued page claims NO authority: no lease state, no scan, no
      // transport, no panel — while the owner holds the lock.
      expect(await leaseState(standby)).toBe('');
      expect(await snapshotEvents(standby)).toEqual([]);
      expect(await transportTargets(standby)).toEqual([]);
      expect(await transportTargets(owner)).toEqual([]);
      expect(await serverRequestCount(owner)).toBe(1); // warmup only

      // Delivery on the product's own 30 s batch-flush cadence: no navigation,
      // so the lock never drops while the standby is queued. The owner sends
      // exactly once; the live, webhook-configured standby sends nothing.
      await expect.poll(() => serverRequestCount(owner), { timeout: 75_000 }).toBe(2);
      const bodies = await serverRequestBodies(owner);
      expect(bodies.slice(1)).toHaveLength(1);
      expect(bodies[1]).toContain('/profile/101');
      expect(await transportTargets(owner)).toHaveLength(1);
      await expect.poll(async () => (await monitorEnvelope(owner)).pending.length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await monitorEnvelope(owner)).terminal.filter((t) => t.terminalStatus === 'acknowledged').length, { timeout: 10_000 }).toBe(1);

      // The standby stayed silent through the whole delivery: EXACTLY zero.
      expect(await transportTargets(standby)).toEqual([]);
      expect(await snapshotEvents(standby)).toEqual([]);
      expect(await leaseState(standby)).toBe('');
      await openPanel(owner);
      expect(await owner.locator('#taa-panel-overlay').innerText()).toContain('Leader — this tab owns monitoring and transport.');
      expect(consoleErrors(owner)).toEqual([]);
      expect(consoleErrors(standby)).toEqual([]);

      // Visible-standby phase: publish a foreign-valid lease (emulating a live
      // foreign owner — the same record shape the TTL path reads), then REALLY
      // close the owner. The owner's pagehide cannot delete a foreign record,
      // the held lock is freed, and the queued page runs its genuine
      // leaseResult===false path: fenced standby with a read-only panel.
      await owner.evaluate(() => {
        const map = JSON.parse(localStorage.getItem('travianAllianceTabLease_v1') || '{}') as Record<string, unknown>;
        map['127.0.0.1'] = { ownerId: 'e2e-foreign-owner', expiresAtMs: Date.now() + 120000 };
        localStorage.setItem('travianAllianceTabLease_v1', JSON.stringify(map));
      });
      // runBeforeUnload:true — a bare close() skips unload handlers (proven by
      // probe: the lease survives it), while a real tab close runs them.
      await owner.close({ runBeforeUnload: true });
      await expect.poll(() => leaseState(standby), { timeout: 30_000 }).toBe('standby');
      expect((await leaseRecord(standby))?.ownerId).toBe('e2e-foreign-owner');
      await expect(standby.locator('#taa-standby-status')).toContainText('Alert monitoring standby');
      await openPanel(standby);
      expect(await standby.locator('#taa-panel-overlay').innerText()).toContain('Standby — this follower is read-only; configuration writes are disabled.');
      // Fenced with visible state (per the task's "disabled or fenced"
      // alternative): product-written standby banner, status line, and lease
      // dataset, plus zero scans and zero transport below. No mutation-button
      // click is asserted here: the click produced no product feedback either
      // way, so it cannot discriminate.
      expect(await snapshotEvents(standby)).toEqual([]);
      expect(await transportTargets(standby)).toEqual([]);
      expect(await serverRequestCount(standby)).toBe(2); // warmup + owner delivery only

      writeEvidencePhase('t1-exclusivity', {
        artifact: 'dist/travian-attack-alert.user.js',
        origin: HTTPS_ORIGIN,
        realLocks: true,
        ownerId: ownerOwnerId,
        ownerGeneration: recordFromOwner?.generation,
        ownerTerm: recordFromOwner?.term,
        standbyOwnerId,
        queuedWhileOwnerHeldLock: { leaseState: '', snapshotEvents: 0, transportRequests: 0 },
        ownerTransportRequests: 1,
        standbyTransportRequests: 0,
        serverProductRequests: 1,
        visibleStandbyAfterForeignLease: true,
        standbyReadOnly: true,
        operatorRule: OPERATOR_RULE,
      });
    } finally {
      await context.close();
    }
  });

  test('closing the owner transfers leadership with the queue preserved and no duplicate of acked work', async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page: owner } = await newHttpsContext(browser);
    const standby = await context.newPage();
    attachConsole(standby);
    try {
      await installPrepHook(owner);
      await installPrepHook(standby);

      // Seed everything BEFORE the second page exists: with the unload release
      // working, any owner navigation while a follower is queued would hand
      // leadership to the follower first. Stable 101+102 identities throughout
      // (the raid icon is a genuine delta, never a reappearance), ending with
      // one ACKED record (101 attack, delivered) plus one PENDING record
      // (102 raid, queued but not yet flushed).
      await bootRealPage(owner, { rename101: true, rename102: true });
      await waitAuthoritativeSnapshot(owner);

      let gm = await snapshotGM(owner);
      await reloadCycle(owner, { rename101: true, rename102: true, attackIcon101: true }, gm, true);
      await expect.poll(async () => (await monitorEnvelope(owner)).pending.length, { timeout: 10_000 }).toBe(1);
      gm = await snapshotGM(owner);
      await reloadCycle(owner, { rename101: true, rename102: true, attackIcon101: true }, gm, true);
      await expect.poll(() => serverRequestCount(owner), { timeout: 20_000 }).toBe(2);
      await expect.poll(async () => (await monitorEnvelope(owner)).terminal.filter((t) => t.terminalStatus === 'acknowledged' && t.playerId === '101').length, { timeout: 10_000 }).toBe(1);

      gm = await snapshotGM(owner);
      await reloadCycle(owner, { rename101: true, rename102: true, attackIcon101: true, raidIcon102: true }, gm, true);
      await expect.poll(async () => (await monitorEnvelope(owner)).pending.length, { timeout: 10_000 }).toBe(1);
      expect(await serverRequestCount(owner)).toBe(2); // 102 queued, not sent
      const queued = await monitorEnvelope(owner);
      expect(queued.pending[0]?.playerId).toBe('102');
      const firstOwnerId = await ownerId(owner);

      // NOW boot the second page with the full post-seed table state already
      // staged — inert while queued, exactly matching the carried baseline at
      // takeover, so its first scan finds no new delta and queues no leave.
      // The owner is never navigated again from here on.
      await bootRealPage(standby, { rename101: true, attackIcon101: true, rename102: true, raidIcon102: true });
      await setWebhook(standby); // standby CAN send (config present) — fencing is what stops it
      await standby.waitForTimeout(3000); // past boot jitter: still queued, still silent
      expect(await leaseState(owner)).toBe('leader');
      expect(await leaseState(standby)).toBe('');
      expect(await snapshotEvents(standby)).toEqual([]);
      // Warmup AFTER the standby boot (which resets the sink log and re-arms
      // its first-attempt 429), so the takeover delivery below meets a 200
      // first try and the post-takeover window holds exactly one product post.
      await standby.request.post('/discord-webhook', { data: { content: 'warmup', allowed_mentions: { users: [] } }, headers: { 'Content-Type': 'application/json' } });
      await expect.poll(() => serverRequestCount(standby), { timeout: 5_000 }).toBe(1);

      // Shared-GM emulation (production Tampermonkey shares GM across tabs):
      // carry the owner's full store — acked 101 + pending 102 — onto the
      // queued page, then REALLY close the owner. pagehide releases the own
      // lease AND frees the held lock, so the queued lock callback runs and
      // the page boots INTO leadership in its live document (no navigation):
      // startup flush first (delivers carried 102), then its first scan.
      const carriedGM = await snapshotGM(owner);
      await restoreGM(standby, carriedGM);
      await setWebhook(standby);
      // runBeforeUnload:true — a bare close() skips unload handlers (proven by
      // probe: the lease survives it), while a real tab close runs them.
      await owner.close({ runBeforeUnload: true });
      await expect.poll(() => leaseState(standby), { timeout: 30_000 }).toBe('leader');
      await expect.poll(() => serverRequestCount(standby), { timeout: 20_000 }).toBe(2);
      await waitAuthoritativeSnapshot(standby);

      // EXACTLY ONCE across the takeover window (warmup + one product post):
      // the carried 102 is delivered, and the acknowledged 101 is NOT re-sent
      // (zero /profile/101 posts after the standby boot reset the sink log).
      const bodies = await serverRequestBodies(standby);
      const product = bodies.slice(1);
      expect(product).toHaveLength(1);
      expect(product[0]).toContain('/profile/102');
      expect(product[0]).not.toContain('/profile/101');
      const settled = await monitorEnvelope(standby);
      expect(settled.pending).toEqual([]);
      expect(settled.failed).toEqual([]);
      expect(settled.uncertain).toEqual([]);
      expect(settled.terminal.filter((t) => t.terminalStatus === 'acknowledged' && t.playerId === '101')).toHaveLength(1);
      expect(settled.terminal.filter((t) => t.terminalStatus === 'acknowledged' && t.playerId === '102')).toHaveLength(1);

      // New owner, same queue lineage.
      const secondOwnerId = await ownerId(standby);
      expect(secondOwnerId).not.toBe('');
      expect(secondOwnerId).not.toBe(firstOwnerId);
      expect((await leaseRecord(standby))?.ownerId).toBe(secondOwnerId);
      expect(consoleErrors(standby)).toEqual([]);

      writeEvidencePhase('t2-takeover', {
        firstOwnerId,
        secondOwnerId,
        newGeneration: (await leaseRecord(standby))?.generation,
        postTakeoverWirePosts: 1,
        postTakeoverWirePostsFor101: 0,
        postTakeoverWirePostsFor102: 1,
        acknowledged101: 1,
        acknowledged102: 1,
        queueLineagePreserved: true,
      });
    } finally {
      await context.close();
    }
  });

  test('fence loss between wire response and settle leaves the record recoverable, never acked or dropped', async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await newHttpsContext(browser);
    page.on('dialog', (dialog) => { void dialog.dismiss(); });
    try {
      await installPrepHook(page);
      await bootRealPage(page, { rename101: true }, true);
      await waitAuthoritativeSnapshot(page);
      await page.request.post('/discord-webhook', { data: { content: 'warmup', allowed_mentions: { users: [] } }, headers: { 'Content-Type': 'application/json' } });
      await expect.poll(() => serverRequestCount(page), { timeout: 5_000 }).toBe(1);

      // Queue one synthetic record (startup flush already ran pre-scan).
      const gm = await snapshotGM(page);
      await reloadCycle(page, { rename101: true, attackIcon101: true }, gm, true);
      await expect.poll(async () => (await monitorEnvelope(page)).pending.length, { timeout: 10_000 }).toBe(1);
      expect(await serverRequestCount(page)).toBe(1);

      // Hold the loopback response, start the flush, wait until the request is
      // on the wire (logged), THEN revoke the lease mid-flight.
      await page.request.post('/e2e-delivery-hold', { data: { hold: true } });
      await page.evaluate(() => (window.__TAA_MENU__ as unknown as Record<string, () => void>)['Flush pending Discord batches']());
      await expect.poll(() => serverRequestCount(page), { timeout: 15_000 }).toBe(2);
      await page.evaluate(() => localStorage.removeItem('travianAllianceTabLease_v1'));
      await page.request.post('/e2e-delivery-hold', { data: { hold: false } });

      // Settle saw genuine lease loss: the 200+ID response must NOT become an
      // acknowledgement. The record stays recoverable (inFlight), retryable by
      // the operator, and the wire saw exactly one attempt (no retry storm).
      await expect.poll(async () => recoverable(await monitorEnvelope(page)).length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(3000); // settle: no background retry may fire
      const settled = await monitorEnvelope(page);
      expect(recoverable(settled)).toHaveLength(1);
      expect(settled.pending.length + settled.inFlight.length).toBe(1);
      expect(settled.terminal.filter((t) => t.terminalStatus === 'acknowledged')).toEqual([]);
      expect(settled.failed).toEqual([]);
      expect(settled.uncertain).toEqual([]);
      expect(await serverRequestCount(page)).toBe(2);
      expect(consoleErrors(page)).toEqual([]);

      writeEvidencePhase('t3-fence-loss', {
        wireAttemptsTotal: 2,
        productWireAttempts: 1,
        recoverableRecords: 1,
        acknowledgedRecords: 0,
        failedRecords: 0,
        uncertainRecords: 0,
        silentlyDropped: false,
      });
    } finally {
      await context.close();
    }
  });

  test('two browser contexts do NOT share locks — each elects its own owner', async ({ browser }) => {
    test.setTimeout(90_000);
    const first = await newHttpsContext(browser);
    const second = await newHttpsContext(browser);
    try {
      await installPrepHook(first.page);
      await installPrepHook(second.page);
      await bootRealPage(first.page, { rename101: true });
      await waitAuthoritativeSnapshot(first.page);
      await bootRealPage(second.page, { rename101: true });
      await waitAuthoritativeSnapshot(second.page);

      // Separate storage partitions => separate leases => TWO coexisting
      // owners. This is the boundary of the fencing contract, not a second
      // proof of it: the local lock cannot prevent a second profile/computer
      // from sending.
      expect(await leaseState(first.page)).toBe('leader');
      expect(await leaseState(second.page)).toBe('leader');
      const firstOwner = await ownerId(first.page);
      const secondOwner = await ownerId(second.page);
      expect(firstOwner).not.toBe('');
      expect(secondOwner).not.toBe('');
      expect(secondOwner).not.toBe(firstOwner);
      expect((await leaseRecord(first.page))?.ownerId).toBe(firstOwner);
      expect((await leaseRecord(second.page))?.ownerId).toBe(secondOwner);
      expect(await serverRequestCount(first.page)).toBe(0);

      writeEvidencePhase('t4-contexts-isolation', {
        realLocks: true,
        firstContextOwnerId: firstOwner,
        secondContextOwnerId: secondOwner,
        bothLeader: true,
        locksSharedAcrossContexts: false,
        operatorRule: OPERATOR_RULE,
      });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  // Task 20's same-document lease reacquisition tests moved, unweakened, to
  // dual-tab-lease-reacquisition.spec.ts: they wait on the real ~30 s renewal
  // cadence, and running them on all six projects pushed THIS file over the
  // runner's hard 480 s per-spec ceiling. They are now project-filtered to
  // chromium-1280 (see playwright.qa.config.ts), while T1-T4 here keep running
  // on every project.
});
