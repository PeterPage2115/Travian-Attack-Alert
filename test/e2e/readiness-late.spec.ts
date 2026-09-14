import { test, expect } from '@playwright/test';
import { installArtifactRuntime } from './runtime-bootstrap';

test('artifact waits for a late canonical member table before scanning', async ({ page }) => {
  await installArtifactRuntime(page, { path: '/alliance/profile/members', lateTable: true });
  await expect(page.locator('table.allianceMembers')).toHaveCount(1);
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((event) => event.kind === 'snapshot').length ?? 0), { timeout: 5_000 }).toBe(1);
  const events = await page.evaluate(() => window.__TAA_E2E_EVENTS__ ?? []);
  expect(events.filter((event) => event.kind === 'readiness')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'extraction')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'snapshot' && event.status === 'authoritative')).toHaveLength(1);
});

test('continuously mutating canonical DOM has one timeout and never extracts', async ({ page }) => {
  await installArtifactRuntime(page, { path: '/alliance/profile/members', continuousMutation: true, webhook: true });
  await expect.poll(async () => await page.evaluate(() => {
    const stored = localStorage.getItem('travianAllianceDiagnostics_v2');
    if (!stored) return false;
    const diagnostics: Record<string, { readonly records?: Array<{ readonly reason?: string }> }> = JSON.parse(stored);
    return Object.values(diagnostics).some((world) => world.records?.some((record) => record.reason === 'readiness-timeout') ?? false);
  }), { timeout: 20_000 }).toBe(true);
  await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
  await expect(page.locator('#taa-freshness-value')).toHaveText('Not recorded');
  await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
  await expect(page.locator('#taa-scan-reason-value')).toHaveText('readiness-timeout');
  await expect(page.locator('#taa-scan-outcome-value')).toHaveText('rejected');
  const result = await page.evaluate(() => ({
    events: window.__TAA_E2E_EVENTS__ ?? [],
    requests: window.__TAA_REQUESTS__ ?? [],
    timeoutCount: Object.values(JSON.parse(localStorage.getItem('travianAllianceDiagnostics_v2') || '{}') as Record<string, { records?: Array<{ reason?: string }> }>)
      .flatMap((world) => world.records || [])
      .filter((record) => record.reason === 'readiness-timeout').length,
  }));
  expect(result.timeoutCount).toBe(1);
  expect(result.events.filter((event) => event.kind === 'extraction')).toHaveLength(0);
  expect(result.requests).toHaveLength(0);
});

test('a later canonical cycle succeeds after a timed-out document', async ({ page }) => {
  await installArtifactRuntime(page, { path: '/alliance/profile/members', continuousMutation: true });
  await expect.poll(async () => await page.evaluate(() => {
    const stored = localStorage.getItem('travianAllianceDiagnostics_v2');
    if (!stored) return false;
    const diagnostics: Record<string, { readonly records?: Array<{ readonly reason?: string }> }> = JSON.parse(stored);
    return Object.values(diagnostics).some((world) => world.records?.some((record) => record.reason === 'readiness-timeout') ?? false);
  }), { timeout: 20_000 }).toBe(true);
  await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: await page.evaluate(async () => await (await fetch('/dist/travian-attack-alert.user.js')).text()) });
  await expect.poll(async () => await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((event) => event.kind === 'snapshot' && event.status === 'authoritative').length ?? 0)).toBe(1);
  expect(await page.evaluate(() => window.__TAA_E2E_EVENTS__?.filter((event) => event.kind === 'extraction').length ?? 0)).toBe(1);
});
