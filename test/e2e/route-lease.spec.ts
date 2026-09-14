import { test, expect } from '@playwright/test';
import { installArtifactRuntime } from './runtime-bootstrap';

test.describe('route and lease authority', () => {
  test.beforeEach(async ({ page }) => { await installArtifactRuntime(page); });

  test('canonical authority starts the real artifact lifecycle', async ({ page }) => {
    await expect(page.locator('table.allianceMembers')).toHaveCount(1);
    expect(await page.evaluate(() => typeof window.GM_xmlhttpRequest === 'function')).toBeTruthy();
  });

  test('query and noncanonical routes remain inert', async ({ page }) => {
    await page.goto('/alliance/profile/members?page=2', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: await page.evaluate(async () => await (await fetch('/dist/travian-attack-alert.user.js')).text()) });
    expect(await page.evaluate(() => window.__TAA_REQUESTS__?.length ?? 0)).toBe(0);
    await page.goto('/alliance/profile/members/extra', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: await page.evaluate(async () => await (await fetch('/dist/travian-attack-alert.user.js')).text()) });
    // Standby indicator is #taa-standby-status (created by
    // setStandbyVisibility) with body[data-taa-lease-state="standby"];
    // [data-taa-standby-banner] is only ever queried, never created.
    expect(await page.locator('#taa-standby-status').count()).toBeGreaterThan(0);
  });

  test('standby lease cannot write', async ({ page }) => {
    await installArtifactRuntime(page, { leader: false, path: '/alliance/profile/members' });
    expect(await page.evaluate(() => ({ leader: window.__TAA_E2E_SCENARIO__?.leader, requests: window.__TAA_REQUESTS__?.length ?? 0 }))).toEqual({ leader: false, requests: 0 });
  });
});
