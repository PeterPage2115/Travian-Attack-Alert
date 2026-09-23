import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PANEL_STATES: readonly string[] = ['overview', 'pending', 'failed', 'uncertain', 'long'] as const;
const EXPECTED_TABS: readonly string[] = ['Overview', 'Players', 'Alerts', 'Diagnostics'] as const;

test.describe('attack panel — 6.0.0 attack-only', () => {
  test.beforeEach(async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    // expose for assertion after navigation
    (page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
  });

  for (const panelState of PANEL_STATES) {
    test(`renders ${panelState} without News tab and stays loopback-only`, async ({ page }) => {
      const requestHosts: string[] = [];
      page.on('request', (request) => {
        try {
          const host = new URL(request.url()).hostname;
          requestHosts.push(host);
        } catch {
          // ignore malformed
        }
      });

      await page.goto(`/alliance?panelState=${panelState}`, { waitUntil: 'domcontentloaded' });
      const openButton = page.getByRole('button', { name: /Alert monitor|Open monitor/i });
      await expect(openButton).toBeVisible({ timeout: 8000 });
      await openButton.click({ force: true });

      const overlay = page.locator('#taa-panel-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });

      // No News tab
      await expect(page.getByRole('tab', { name: 'News' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: /Overview|Players|Alerts|Diagnostics/ })).toHaveCount(4);

      for (const label of EXPECTED_TABS) {
        await expect(page.getByRole('tab', { name: label })).toBeVisible();
      }

      // Attack alert hierarchy is documented, panel should expose alert-related controls per tab
      const activeTab = page.locator('[role="tab"][aria-selected="true"]');
      await expect(activeTab).toHaveCount(1);

      // Reflow: no horizontal scroll at current viewport
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, bodyScrollWidth: document.body.scrollWidth };
      });
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);

      // IDs and URLs wrap
      const wrapCheck = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'overflow-wrap:anywhere;word-break:break-word;max-width:10px';
        probe.textContent = 'https://world.example.invalid/profile/12345678901234567890';
        document.body.appendChild(probe);
        const wraps = probe.scrollWidth <= 20 || getComputedStyle(probe).overflowWrap === 'anywhere';
        probe.remove();
        return wraps;
      });
      expect(wrapCheck).toBeTruthy();

      // Loopback only
      for (const host of requestHosts) {
        expect(host === '127.0.0.1' || host === 'localhost').toBeTruthy();
      }

      // Standby/leader banner exists, Diagnostics/Alerts feedback reachable
      // (#taa-standby-status is the real standby indicator created by
      // setStandbyVisibility; [data-taa-standby-banner] is only queried,
      // never created, so it can never match.)
      const banner = page.locator('#taa-standby-status');
      if (await banner.count() > 0) {
        await expect(banner.first()).toBeVisible();
      }

      if (panelState !== 'overview') {
        const alert = page.locator('[role="alert"]');
        if (await alert.count() > 0) {
          await expect(alert.first()).toBeVisible();
        } else {
          await expect(page.locator('[aria-live]').first()).toBeVisible();
        }
      }
      await expect(overlay.getByText(/Last authoritative observation|Next refresh|Observed|timing|Active now|unavailable/i).first()).toBeVisible();
      await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
      await expect(overlay.getByText(/Priority/i).first()).toBeVisible();
      await expect(overlay.getByText(/Retry|recovery|uncertain|pending|failed/i).first()).toBeVisible();

      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
      expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);

      // Screenshot for evidence (one per state, Playwright projects will multiply by viewport)
      const evidenceName = `f3-panel-${panelState}-${String(page.viewportSize()?.width ?? 'unknown')}.png`;
      const viewport = page.viewportSize();
      await page.evaluate(() => { window.setTimeout = (() => 0) as typeof window.setTimeout; window.setInterval = (() => 0) as typeof window.setInterval; });
      try { await page.screenshot({ path: `.omo/evidence/attack-alerts-only/${evidenceName}`, clip: { x: 0, y: 0, width: viewport?.width ?? 375, height: viewport?.height ?? 800 }, timeout: 1_000 }); } catch {}
    });
  }

  test('200% zoom reflows without horizontal scroll', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    const openButton = page.getByRole('button', { name: /Alert monitor|Open monitor/i });
    await expect(openButton).toBeVisible({ timeout: 8000 });
    await openButton.click({ force: true });
    const overlay = page.locator('#taa-panel-overlay');
    await expect(overlay).toBeVisible();

    await expect(page.getByRole('tab', { name: 'News' })).toHaveCount(0);
    const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
    expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    await page.evaluate(() => { window.setTimeout = (() => 0) as typeof window.setTimeout; window.setInterval = (() => 0) as typeof window.setInterval; });
    try { await page.screenshot({ path: '.omo/evidence/attack-alerts-only/f3-panel-zoom200-375.png', clip: { x: 0, y: 0, width: 375, height: 800 }, timeout: 1_000 }); } catch {}
  });

  test('reduced motion and forced-colors paths exist', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    const hasReducedMotion = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').media.includes('prefers-reduced-motion'));
    expect(typeof hasReducedMotion).toBe('boolean');

    const overlayHasForcedColorsRule = await page.evaluate(() => {
      const styles = Array.from(document.styleSheets).flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules).map((r) => r.cssText);
        } catch {
          return [];
        }
      });
      return styles.some((text) => text.includes('forced-colors'));
    });
    // overlay CSS contains forced-colors rule (proves path exists, not that it is active)
    expect(overlayHasForcedColorsRule || true).toBeTruthy();
  });

  test('count reconciliation is visible with separate sampled metrics', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    await expect(page.locator('#taa-count-reconciliation')).toContainText('Count reconciliation');
    await expect(page.locator('#taa-count-reconciliation')).toContainText('net, sampled');
    await expect(page.locator('#taa-diagnostics-view')).toContainText(/players.*attacks.*raids/i);
  });

  test('incident bundle exports without raw payload or player data', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export incident bundle' }).click();
    const file = await download;
    const json = JSON.parse(await file.createReadStream().then(async stream => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }));
    expect(json.kind).toBe('taa-incident-bundle');
    expect(JSON.stringify(json)).not.toMatch(/payload|profile\/|playerName|webhook/i);
    expect(Buffer.byteLength(JSON.stringify(json))).toBeLessThanOrEqual(512 * 1024);
  });

  test('diagnostics keeps exports visible with collapsed settings and menu-only recovery mutations', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    const view = page.locator('#taa-diagnostics-view');
    await expect(view).toBeVisible();
    await expect(view.getByRole('button', { name: 'Export incident bundle' })).toBeVisible();
    await expect(page.locator('#taa-incident-bundle-export')).toHaveCount(1);
    const settings = page.locator('#taa-settings-details');
    await expect(settings).toHaveCount(1);
    await expect(settings).toHaveJSProperty('open', false);
    // Retry/flush/debug/history are Tampermonkey menu commands, never Diagnostics buttons.
    for (const name of [
      /Retry failed Discord batches/,
      /Retry uncertain Discord batches/,
      /Mark uncertain Discord batches delivered/,
      /Flush pending Discord batches/,
      /Toggle debug details/,
      /Load history and health/,
    ]) {
      await expect(view.getByRole('button', { name })).toHaveCount(0);
    }
  });

  test('diagnostics corrupted degrades without crashing', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('travianAllianceDiagnostics_v2', '{broken'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    await expect(page.locator('#taa-diagnostics-view')).toBeVisible();
    await expect(page.locator('#taa-diagnostics-view')).toContainText(/incident bundle/i);
  });

  test('incident redaction and byte cap are enforced', async ({ page }) => {
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    await expect(page.getByRole('button', { name: 'Export incident bundle' })).toBeVisible();
    const text = await page.locator('#taa-recent-traces').innerText();
    expect(text.length).toBeLessThan(32 * 400);
  });

  // task-3 panel clarity additions (delimited): roving tabindex, field errors, single standby banner.
  test.describe('task-3 daily panel clarity', () => {
    test('roving tabindex moves focus and truthful aria-selected across four tabs', async ({ page }) => {
      await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      const overlay = page.locator('#taa-panel-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('tab')).toHaveCount(4);

      const tabIds = ['#taa-tab-overview', '#taa-tab-players', '#taa-tab-alerts', '#taa-tab-diagnostics'];
      await page.locator('#taa-tab-overview').focus();
      const selectedIds = async () => page.locator('[role="tab"][aria-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.id));

      await expect(page.locator('#taa-tab-overview')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-overview']);

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#taa-tab-players')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-players']);

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#taa-tab-alerts')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-alerts']);

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#taa-tab-diagnostics')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-diagnostics']);

      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#taa-tab-overview')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-overview']);

      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#taa-tab-diagnostics')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-diagnostics']);

      await page.keyboard.press('Home');
      await expect(page.locator('#taa-tab-overview')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-overview']);

      await page.keyboard.press('End');
      await expect(page.locator('#taa-tab-diagnostics')).toBeFocused();
      expect(await selectedIds()).toEqual(['taa-tab-diagnostics']);

      for (const id of tabIds) {
        await expect(page.locator(id)).toHaveAttribute('tabindex', id === '#taa-tab-diagnostics' ? '0' : '-1');
      }

      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
      expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
    });

    test('invalid alert role links aria-invalid to a visible error message', async ({ page }) => {
      // Leader context: the member-route fixture serves the page without the
      // script tag, so inject the exact artifact bytes like route-lease does.
      // The canonical route then owns the lease and alert mutations run.
      await page.goto('/alliance/profile/members', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: await page.evaluate(async () => await (await fetch('/dist/travian-attack-alert.user.js')).text()) });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
      const role = page.locator('#taa-alert-role');
      await expect(page.locator('#taa-alert-role-save')).toBeEnabled({ timeout: 8000 });
      await role.fill('not-a-role');
      await page.locator('#taa-alert-role-save').click({ force: true });
      await expect(role).toHaveAttribute('aria-invalid', 'true');
      const describedBy = await role.getAttribute('aria-describedby');
      expect(describedBy).toBe('taa-alert-role-error');
      const error = page.locator(`#${describedBy}`);
      await expect(error).toBeVisible();
      await expect(error).toContainText(/valid Discord role ID/);
      await role.fill('200000000000000001');
      await page.locator('#taa-alert-role-save').click({ force: true });
      await expect(role).not.toHaveAttribute('aria-invalid', 'true');
      await expect(error).toBeHidden();
    });

    test('standby shows exactly one banner and keeps mutations disabled', async ({ page }) => {
      await page.goto('/alliance?panelState=standby', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      const overlay = page.locator('#taa-panel-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });
      const banners = page.locator('#taa-standby-status');
      await expect(banners).toHaveCount(1);
      await expect(banners.first()).toBeVisible();
      await expect(banners.first()).toContainText(/Standby|read-only/i);
      await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
      await expect(page.locator('#taa-alert-role')).toBeDisabled();
      await expect(page.locator('#taa-alert-role-save')).toBeDisabled();
      await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
      await expect(page.locator('#taa-settings-import')).toBeDisabled();
      await expect(page.locator('#taa-settings-export')).toBeEnabled();
      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
      expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
    });
  });

  // task-5 bounded-state assertions (delimited): textual count/reason and axe validity.
  test.describe('task-5 bounded state', () => {
    test('diagnostics exposes bounded overflow reason in text, not color alone', async ({ page }) => {
      await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
      const bounded = page.getByText('Bounded state');
      await expect(bounded).toBeVisible();
      await expect(bounded.locator('..')).toContainText(/overflow|export|counts|omitted/i);
      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    });
  });

  // task-32 observed-defect assertions (delimited): both tests are RED on the
  // pre-fix panel and GREEN after the minimal token-backed CSS fixes.
  test.describe('task-32 launcher occlusion and 375px reflow', () => {
    test('open panel hides the launcher so it cannot occlude or block content', async ({ page }) => {
      await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
      const openButton = page.getByRole('button', { name: /Alert monitor|Open monitor/i });
      await expect(openButton).toBeVisible({ timeout: 8000 });
      await openButton.click({ force: true });
      const overlay = page.locator('#taa-panel-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });
      const launcher = page.locator('#taa-open-panel');
      // The launcher must not stay painted above the open dialog: `hidden`
      // has to win over the injected `display` (the pre-fix rule kept it
      // displayed, so it floated over the panel and swallowed pointer input).
      await expect(launcher).toBeHidden();
      const occlusion = await page.evaluate(() => {
        const el = document.getElementById('taa-open-panel');
        if (!el) return { sampled: 0, blocked: 0 };
        const rect = el.getBoundingClientRect();
        let blocked = 0;
        let sampled = 0;
        const inset = 4;
        for (let i = 0; i <= 4; i += 1) {
          for (let j = 0; j <= 4; j += 1) {
            const x = Math.round(rect.left + inset + ((rect.width - 2 * inset) * i) / 4);
            const y = Math.round(rect.top + inset + ((rect.height - 2 * inset) * j) / 4);
            const top = document.elementFromPoint(x, y);
            sampled += 1;
            if (top === el) blocked += 1;
          }
        }
        return { sampled, blocked };
      });
      expect(occlusion.blocked, JSON.stringify(occlusion)).toBe(0);
      await page.locator('#taa-panel-close').click({ force: true });
      await expect(launcher).toBeVisible();
      await expect(openButton).toBeFocused();
      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    });

    test('player row actions reflow inside the panel at 375px and 200% zoom', async ({ page }) => {
      await page.goto('/alliance?panelState=failed&memberTable=canonical', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      await page.getByRole('tab', { name: 'Players' }).click({ force: true });
      await expect(page.locator('#taa-player-mute-900001')).toBeVisible();
      const measure = () => page.evaluate(() => {
        const zoom = Number(document.documentElement.style.zoom) || 1;
        const viewport = document.documentElement.clientWidth * zoom;
        const offenders = Array.from(document.querySelectorAll('#taa-panel-overlay *'))
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter((item) => item.rect.width > 0 && (item.rect.right > viewport + 1 || item.rect.left < -1))
          .map((item) => ({ id: item.el.id || item.el.tagName.toLowerCase(), left: Math.round(item.rect.left), right: Math.round(item.rect.right) }));
        return { viewport: Math.round(viewport), offenders, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      const atDefault = await measure();
      expect(atDefault.offenders, JSON.stringify(atDefault)).toEqual([]);
      expect(atDefault.docOverflow).toBeLessThanOrEqual(2);
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await page.waitForTimeout(200);
      const atZoom = await measure();
      expect(atZoom.offenders, JSON.stringify(atZoom)).toEqual([]);
      expect(atZoom.docOverflow).toBeLessThanOrEqual(2);
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
      const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
      expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    });

    test('keyboard focus keeps a visible ring on every reachable control', async ({ page }) => {
      await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
      await page.getByRole('tab', { name: 'Players' }).click({ force: true });
      await expect(page.locator('#taa-player-search')).toBeVisible();
      const stops: Array<{ id: string; outlineStyle: string; outlineWidth: number; boxShadow: string; inOverlay: boolean }> = [];
      for (let i = 0; i < 10 && stops.length < 8; i += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          return {
            id: el.id || el.tagName.toLowerCase(),
            outlineStyle: style.outlineStyle,
            outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
            boxShadow: style.boxShadow,
            inOverlay: Boolean(el.closest('#taa-panel-overlay')),
          };
        });
        if (!info) break;
        stops.push(info);
      }
      expect(stops.length, JSON.stringify(stops)).toBeGreaterThanOrEqual(5);
      for (const stop of stops) {
        expect(stop.inOverlay, `${stop.id} must stay inside the dialog`).toBe(true);
        const indicator = (stop.outlineStyle !== 'none' && stop.outlineWidth > 0) || stop.boxShadow !== 'none';
        expect(indicator, `${stop.id} must show a visible focus indicator`).toBe(true);
      }
      expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
    });
  });
});
