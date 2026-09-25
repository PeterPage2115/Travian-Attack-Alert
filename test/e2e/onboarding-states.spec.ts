// Todo 13 — first-start clarity without a wizard (plan external-alliance-public-1.0.0).
//
// Extends (never duplicates) test/e2e/attack-panel.spec.ts: that spec owns the
// four-tab/a11y/reflow matrix. This spec owns the Todo 13 operational states:
//   - Overview shows runtime / route / session / lease / scan / baseline /
//     delivery as separate truthful lines (ids taa-operational-*-value).
//   - Alerts guides setup in canonical order and carries an explicit TEST
//     synthetic send that never mutates the baseline/envelope.
//   - Distinct messages: missing-webhook, wrong-page (noncanonical inert),
//     parser-rejected with exact reason code, delivery-issue with menu pointer.
//   - Standby stays read-only; incident bundle is the FIRST recovery step and
//     stays redacted/bounded.
//   - Independence: Discord TEST success + rejected monitor scan are shown as
//     two separate facts, never merged into one "monitor works" claim.
//
// Part A runs on the :8899 panel fixture (plain http, fake-ack GM stub).
// Part B runs on the :8898 ephemeral-TLS harness (real artifact dispatch to
// the loopback /discord-webhook sink) because the product payload builder
// only trusts https origins. Synthetic data only, loopback only.
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { installLoopbackTransport } from './runtime-bootstrap';

const HTTPS_ORIGIN = 'https://127.0.0.1:8898';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/FAKE-onboarding-token-0123456789abcdef';
const MONITOR_KEY = 'travianAllianceMonitor_v1:127.0.0.1';
const OPERATIONAL_IDS = [
  'taa-operational-runtime-value',
  'taa-operational-route-value',
  'taa-operational-session-value',
  'taa-operational-lease-value',
  'taa-operational-scan-value',
  'taa-operational-scan-detail-value',
  'taa-operational-baseline-value',
  'taa-operational-delivery-value',
] as const;

function trackConsoleErrors(page: Page): void {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  (page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
}

function consoleErrors(page: Page): string[] {
  return (page as unknown as { __consoleErrors: string[] }).__consoleErrors ?? [];
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
  await expect(page.locator('#taa-panel-overlay')).toBeVisible({ timeout: 5000 });
}

// The spec itself must never merge the two facts either: fail on any merged
// "works/operational" claim in this file's asserted UI text.
const MERGED_CLAIM = /\bmonitor works\b|fully operational|all systems operational|detector works/i;

test.describe('onboarding — operational states without a wizard (http fixture)', () => {
  test.beforeEach(async ({ page }) => { trackConsoleErrors(page); });

  test('overview shows runtime/route/session/lease/scan/baseline/delivery separately', async ({ page }) => {
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    const overlay = page.locator('#taa-panel-overlay');
    await expect(overlay.locator('#taa-operational-state')).toBeVisible();

    for (const id of OPERATIONAL_IDS) {
      await expect(overlay.locator(`#${id}`)).toBeVisible();
    }
    // Standby/noncanonical context: read-only runtime, inert route, no lease,
    // nothing recorded yet, baseline absent, webhook missing.
    expect(await overlay.locator('#taa-operational-runtime-value').innerText()).toBe('standby (read-only)');
    expect(await overlay.locator('#taa-operational-route-value').innerText()).toBe('alliance-noncanonical');
    expect(await overlay.locator('#taa-operational-lease-value').innerText()).toBe('no lease held (standby)');
    expect(await overlay.locator('#taa-operational-scan-value').innerText()).toBe('not recorded');
    expect(await overlay.locator('#taa-operational-baseline-value').innerText()).toContain('not established');
    expect(await overlay.locator('#taa-operational-delivery-value').innerText()).toBe('webhook missing — configuration required; queue preserved');

    const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
    expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    expect(consoleErrors(page)).toEqual([]);
  });

  test('wrong page shows inert noncanonical guidance and mutates nothing', async ({ page }) => {
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    const gmBefore = await page.evaluate(() => JSON.stringify(window.__TAA_GM_VALUES__ ?? {}));
    const stateKeysBefore = await page.evaluate(() => JSON.stringify({
      monitor: Object.keys(window.__TAA_GM_VALUES__ ?? {}),
      roster: localStorage.getItem('travianAllianceRoster_v1'),
      mappings: localStorage.getItem('travianAllianceMappings_v1'),
    }));
    await openPanel(page);
    const overlay = page.locator('#taa-panel-overlay');
    await expect(overlay.getByText('Noncanonical page')).toBeVisible();
    await expect(overlay.getByText(/inert guidance only.*never scans, writes, sends, or reloads/i)).toBeVisible();
    await expect(overlay.getByText(/log in first.*never scans a login page/i)).toBeVisible();
    // Standby banner, read-only: opening and reading created no monitor
    // envelope, roster, or mappings. (Route-stage diagnostic traces may
    // append — that is intended product behavior, not state.)
    await expect(page.locator('[data-taa-standby-banner]')).toHaveCount(1);
    expect(await page.evaluate(() => JSON.stringify(window.__TAA_GM_VALUES__ ?? {}))).toBe(gmBefore);
    expect(await page.evaluate(() => JSON.stringify({
      monitor: Object.keys(window.__TAA_GM_VALUES__ ?? {}),
      roster: localStorage.getItem('travianAllianceRoster_v1'),
      mappings: localStorage.getItem('travianAllianceMappings_v1'),
    }))).toBe(stateKeysBefore);
    expect(consoleErrors(page)).toEqual([]);
  });

  test('alerts guides setup order and marks the synthetic send TEST', async ({ page }) => {
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
    const overlay = page.locator('#taa-panel-overlay');
    await expect(overlay.getByText('Setup order')).toBeVisible();
    const order = await overlay.getByText(/1\..*canonical.*2\..*webhook.*3\..*TEST.*4\..*accepted scan/i).innerText();
    expect(order.indexOf('1.')).toBeLessThan(order.indexOf('2.'));
    expect(order.indexOf('2.')).toBeLessThan(order.indexOf('3.'));
    expect(order.indexOf('3.')).toBeLessThan(order.indexOf('4.'));
    await expect(page.getByRole('button', { name: 'Send TEST alert to Discord' })).toBeVisible();
    await expect(overlay.getByText(/Synthetic TEST.*never modifies the attack baseline and never proves the detector works/i)).toBeVisible();
    // Standby disables every non-export control (product behavior): the TEST
    // button stays disabled and read-only. The missing-webhook message is
    // proven in leader context below instead.
    await expect(page.getByRole('button', { name: 'Send TEST alert to Discord' })).toBeDisabled();
    expect(consoleErrors(page)).toEqual([]);
  });

  test('diagnostics presents the incident bundle FIRST and stays redacted/bounded', async ({ page }) => {
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    const view = page.locator('#taa-diagnostics-view');
    await expect(view).toBeVisible();
    // Recovery banner is the first banner in the view, ahead of provenance.
    const firstBanner = view.locator('.taa-banner-heading').first();
    await expect(firstBanner).toContainText('Recovery starts here');
    await expect(view.getByText(/Export the incident bundle FIRST, before touching anything/i)).toBeVisible();
    const provenance = await view.getByText('Storage provenance').count();
    expect(provenance).toBe(1);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export incident bundle' }).click();
    const file = await download;
    const raw = await file.createReadStream().then(async (stream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    });
    const json = JSON.parse(raw) as Record<string, unknown>;
    expect(json.kind).toBe('taa-incident-bundle');
    expect(json.bounded).toBeUndefined();
    expect(raw).not.toMatch(/discord\.com\/api\/webhooks|token|secret|cookie|payload|profile\/|playerName|<div|<table|responseText/i);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(512 * 1024);
    expect(consoleErrors(page)).toEqual([]);
  });
});

// --- Part B: leader context over TLS ----------------------------------------
// Single query-free canonical document per test. The artifact is booted
// manually (goto, loopback transport, menu capture, inject) instead of
// runtime-bootstrap: a query string would make the route noncanonical by
// design (no lease, no scan), and the fixture inline script noops menu
// registration, so the capture must precede the boot. One page per context
// owns the real Web Lock without contention.
type HttpsPage = { context: import('@playwright/test').BrowserContext; page: Page };

async function newHttpsPage(browser: Browser): Promise<HttpsPage> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: HTTPS_ORIGIN });
  const page = await context.newPage();
  trackConsoleErrors(page);
  return { context, page };
}

async function closeHttpsPage(target: HttpsPage): Promise<void> {
  await target.context.close();
}

async function useLoopbackTransport(page: Page, ns: string | number = ''): Promise<void> {
  await installLoopbackTransport(page, ns);
}

async function useMenuCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__TAA_MENU__ = {};
    window.GM_registerMenuCommand = (name: string, callback: () => void) => {
      (window.__TAA_MENU__ as unknown as Record<string, () => void>)[name] = callback;
    };
  });
}

async function injectDist(page: Page): Promise<void> {
  await page.addScriptTag({ content: await page.evaluate(async () => await (await fetch('/dist/travian-attack-alert.user.js')).text()) });
}

async function waitDiagSnapshot(page: Page, status: string, timeout = 25_000): Promise<void> {
  await expect.poll(async () => await page.evaluate((want: string) => {
    const stored = localStorage.getItem('travianAllianceDiagnostics_v2') || '{}';
    const diagnostics = JSON.parse(stored) as Record<string, { records?: Array<{ stage?: string; status?: string }> }>;
    return Object.values(diagnostics).flatMap((world) => world.records || []).filter((record) => record.stage === 'snapshot' && record.status === want).length;
  }, status), { timeout }).toBeGreaterThan(0);
}

async function rejectedScanCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const stored = localStorage.getItem('travianAllianceDiagnostics_v2') || '{}';
    const diagnostics = JSON.parse(stored) as Record<string, { records?: Array<{ reason?: string; stage?: string; status?: string }> }>;
    return Object.values(diagnostics).flatMap((world) => world.records || []).filter((record) => record.stage === 'snapshot' && record.status === 'rejected').length;
  });
}

async function baselineJson(page: Page): Promise<string> {
  return await page.evaluate((key: string) => JSON.stringify(JSON.parse((window.__TAA_GM_VALUES__?.[key] as string) || '{}').baselineByPlayerId ?? null), MONITOR_KEY);
}

async function bootLeader(page: Page, ns: string | number = ''): Promise<void> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  await page.request.post(`/e2e-log${nsQuery}`);
  await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
  await useLoopbackTransport(page, ns);
  await useMenuCapture(page);
  await injectDist(page);
  await waitDiagSnapshot(page, 'ok');
}

// A malformed icon passes table selection and fails extraction, which is
// the parser-rejected scan path (a paginated table would die at readiness).
async function installMalformedFlagHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      try {
        if (localStorage.getItem('__taa_onboarding_malformed') !== '1') return;
        localStorage.removeItem('__taa_onboarding_malformed');
        const row = document.querySelector('a[href="/profile/900001"]')?.closest('tr');
        if (!row) throw new Error('icon target row missing');
        const img = document.createElement('img');
        img.className = 'attack';
        img.setAttribute('title', 'attack');
        img.width = 16; img.height = 16;
        row.appendChild(img);
      } catch { /* test scaffolding only; never masks product behavior */ }
    });
  });
}

async function restoreGM(page: Page, snap: string): Promise<void> {
  await page.evaluate((raw: string) => {
    const values = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) window.GM_setValue(key, value);
  }, snap);
}

async function snapshotGM(page: Page): Promise<string> {
  return await page.evaluate(() => JSON.stringify(window.__TAA_GM_VALUES__ ?? {}));
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

// Burns the sink's first-attempt 429 (Node-side warm-up, flagged, never
// counted as product traffic) so the measured window shows product traffic.
async function warmupTransport(page: Page, ns: string | number = ''): Promise<void> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  await page.request.post(`/discord-webhook${nsQuery}`, { data: { content: 'warmup', allowed_mentions: { users: [] } }, headers: { 'Content-Type': 'application/json' } });
  await expect.poll(() => serverRequestCount(page, ns), { timeout: 5_000 }).toBe(1);
}

function envelopeBytes(page: Page): Promise<string> {
  return page.evaluate((key: string) => JSON.stringify((window.__TAA_GM_VALUES__ ?? {})[key] ?? null), MONITOR_KEY);
}

test.describe('onboarding — synthetic TEST states in leader context (TLS loopback)', () => {
  test('missing webhook blocks the TEST with queue preserved; success never touches baseline', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(90_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      // Clean baseline, no webhook anywhere.
      await bootLeader(page, ns);
      expect(await serverRequestCount(page, ns)).toBe(0);

      // Missing webhook: the TEST send is refused before any transport, the
      // pending queue is preserved (still empty here), and the baseline bytes
      // are untouched.
      await openPanel(page);
      await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
      const before = await envelopeBytes(page);
      expect(before).not.toBe('null');
      await page.getByRole('button', { name: 'Send TEST alert to Discord' }).click({ force: true });
      await expect(page.locator('#taa-feedback')).toContainText('Discord TEST not sent — webhook is not configured.');
      await expect(page.locator('#taa-feedback')).toContainText('Pending queue preserved.');
      expect(await envelopeBytes(page)).toBe(before);
      expect(await serverRequestCount(page, ns)).toBe(0);

      // Configure the webhook, burn the sink's first-attempt 429, then the
      // synthetic TEST must succeed with a TEST-marked delivered message and
      // byte-identical baseline/envelope.
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await warmupTransport(page, ns);
      const preSend = await envelopeBytes(page);
      await page.getByRole('button', { name: 'Send TEST alert to Discord' }).click({ force: true });
      await expect(page.locator('#taa-feedback')).toContainText('Discord TEST succeeded — transport works.');
      await expect(page.locator('#taa-feedback')).toContainText('This does not mean the monitor scan works.');
      expect(await envelopeBytes(page)).toBe(preSend);
      await expect.poll(() => serverRequestCount(page, ns), { timeout: 20_000 }).toBe(2);
      // The product markdown-escapes the name, so the JSON shows \[TEST\];
      // Discord renders it as [TEST] Panel test. Assert the marker survives.
      const productBody = JSON.stringify((await serverRequests(page, ns)).slice(1)[0].body);
      expect(productBody).toContain('TEST');
      expect(productBody).toContain('Panel test');
      expect(consoleErrors(page)).toEqual([]);
    } finally {
      await closeHttpsPage(target);
    }
  });

  test('rejected scan and TEST success stay independent, never merged', async ({ browser }, testInfo) => {
    const ns = testInfo.workerIndex;
    test.setTimeout(120_000);
    const target = await newHttpsPage(browser);
    const { page } = target;
    try {
      // Cycle 1: canonical baseline with webhook configured.
      await installMalformedFlagHook(page);
      await page.request.post(`/e2e-log?ns=${ns}`);
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await useMenuCapture(page);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await waitDiagSnapshot(page, 'ok');
      expect(await serverRequestCount(page, ns)).toBe(0);
      const baselineBefore = await baselineJson(page);
      expect(baselineBefore).not.toBe('null');
      await warmupTransport(page, ns);
      const gm = await snapshotGM(page);

      // Cycle 2: same world (GM restored, like persistent Tampermonkey GM;
      // the tab owner in sessionStorage survives too, so the lease renews),
      // but the member icon is malformed before boot, so the boot scan is
      // parser-rejected. Baseline and queue survive untouched.
      await page.evaluate(() => localStorage.setItem('__taa_onboarding_malformed', '1'));
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await useLoopbackTransport(page, ns);
      await useMenuCapture(page);
      await restoreGM(page, gm);
      await page.evaluate((url: string) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
      await injectDist(page);
      await expect.poll(() => rejectedScanCount(page), { timeout: 25_000 }).toBeGreaterThan(0);
      expect(await baselineJson(page)).toBe(baselineBefore);

      // The panel shows the rejection with its exact reason code…
      await openPanel(page);
      const overlay = page.locator('#taa-panel-overlay');
      expect(await overlay.locator('#taa-operational-scan-value').innerText()).toBe('parser-rejected/malformed-count');
      expect(await overlay.locator('#taa-operational-scan-detail-value').innerText()).toBe('reason malformed-count · outcome rejected');

      // …and the synthetic TEST succeeds alongside it as a separate fact.
      await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
      await page.getByRole('button', { name: 'Send TEST alert to Discord' }).click({ force: true });
      await expect(page.locator('#taa-feedback')).toContainText('Discord TEST succeeded — transport works.');
      await page.getByRole('tab', { name: 'Overview' }).click({ force: true });
      const overlayText = await overlay.innerText();
      expect(overlayText).toContain('Discord TEST succeeded');
      expect(overlayText).toContain('parser-rejected/malformed-count');
      expect(overlayText).not.toMatch(MERGED_CLAIM);
      expect(consoleErrors(page)).toEqual([]);
    } finally {
      await closeHttpsPage(target);
    }
  });
});
