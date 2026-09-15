import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Todo-6 production-like journey: live vs cached vs absent configuration states.
// Exact user-facing strings are quoted from the src runtime (buildPlayerWorkspaceReadModel,
// storageProvenanceText) — never paraphrased. Surrogate IDs only (900001+
// Travian IDs; 100000000000000001/20000000000000000N Discord snowflakes).

const MAPPING_KEY = 'travianAlliancePlayerMappings_v1';
const DISCORD_CONFIG_KEY = 'travianAllianceDiscordConfig_v1';
const ROSTER_KEY = 'travianAllianceRoster_v1';
const NAMES_KEY = 'travianAlliancePlayerNames_v1';
const HOST = '127.0.0.1';

const SURROGATE_DISCORD_ID = '100000000000000001';
const SURROGATE_ROLE_ID = '200000000000000001';
const SURROGATE_LEAVE_ROLE_ID = '200000000000000002';

const LIVE_CACHED_BANNER =
  'Live roster unavailable — showing last accepted roster (2 players). Reason: pagination-or-filter';
const ABSENT_CACHED_BANNER =
  'Live roster unavailable — no accepted roster is stored. Reason: no-member-table';
const MAPPING_ABSENT = 'mapping data not found (storage key is absent).';
const ROLE_ABSENT = 'role configuration not found (storage key is absent).';
const MAPPING_STORED = 'mapping data stored for this world (1 entries).';
const ROLE_STORED = 'role configuration stored (2 valid value(s)).';
const MAPPING_MALFORMED = 'mapping data is malformed; no records were used.';
const ROLE_MALFORMED = 'role configuration is malformed; no values were used.';
const MAPPING_OTHER_HOST =
  'mapping data found as other-world data (1 entries in 1 other hostname bucket(s)); nothing was copied.';
const ROLE_EMPTY = 'role configuration is empty (no values stored).';

function cachedRoster(entries: Array<[number, string]>): string {
  const world: Record<string, { name: string; url: string }> = {};
  for (const [id, name] of entries) world[String(id)] = { name, url: `/profile/${id}` };
  return JSON.stringify({ [HOST]: world });
}

const SEEDS: Record<string, Record<string, string>> = {
  liveValid: {
    [MAPPING_KEY]: JSON.stringify({ [HOST]: { 900001: [SURROGATE_DISCORD_ID] } }),
    [DISCORD_CONFIG_KEY]: JSON.stringify({ roleId: SURROGATE_ROLE_ID, leaveRoleId: SURROGATE_LEAVE_ROLE_ID }),
    [ROSTER_KEY]: cachedRoster([[900101, 'Cached Player A'], [900102, 'Cached Player B']]),
    // Known names suppress the panel's loopback /profile/<id> name backfill,
    // keeping the journey free of fetches and console errors.
    [NAMES_KEY]: JSON.stringify({ [HOST]: { 900001: 'Fixture Player 001', 900002: 'Fixture Player 002', 900003: 'Fixture Player 003', 900101: 'Cached Player A', 900102: 'Cached Player B' } }),
  },
  cachedAbsent: {
    [ROSTER_KEY]: cachedRoster([[900001, 'Cached Alpha'], [900002, 'Cached Beta']]),
    [NAMES_KEY]: JSON.stringify({ [HOST]: { 900001: 'Cached Alpha', 900002: 'Cached Beta' } }),
  },
  otherHost: {
    [MAPPING_KEY]: JSON.stringify({ 'other.world.example': { 900001: [SURROGATE_DISCORD_ID] } }),
    [DISCORD_CONFIG_KEY]: JSON.stringify({}),
  },
  malformed: {
    [MAPPING_KEY]: '{broken',
    [DISCORD_CONFIG_KEY]: '{broken',
    [ROSTER_KEY]: cachedRoster([[900001, 'Cached Alpha'], [900002, 'Cached Beta']]),
    [NAMES_KEY]: JSON.stringify({ [HOST]: { 900001: 'Cached Alpha', 900002: 'Cached Beta' } }),
  },
};

function seedScript(seed: Record<string, string>): string {
  const lines = ['try { localStorage.clear(); } catch {}'];
  for (const [key, value] of Object.entries(seed)) {
    lines.push(`try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); } catch {}`);
  }
  return lines.join('\n');
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Alert monitor|Open monitor/i }).click({ force: true });
  await expect(page.locator('#taa-panel-overlay')).toBeVisible({ timeout: 5000 });
}

test.describe('live member scan mappings — live/cached/absent journeys', () => {
  test.beforeEach(async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    (page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors;
  });

  test('live canonical DOM wins over stale cache with valid current values', async ({ page }) => {
    const requestHosts: string[] = [];
    page.on('request', (request) => {
      try { requestHosts.push(new URL(request.url()).hostname); } catch { /* ignore */ }
    });
    await page.addInitScript(seedScript(SEEDS.liveValid));
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });

    const players = page.locator('#taa-players');
    await expect(players).toBeVisible();
    // Live roster is authoritative: no cached/unavailable banner.
    await expect(players.getByText(/Cached roster/)).toHaveCount(0);
    await expect(players.getByText(/Roster unavailable/)).toHaveCount(0);
    // Live surrogate members render; the stale cache never masquerades as live:
    // cached-only IDs surface explicitly labelled as Orphaned, never as live rows.
    await expect(players.locator('span[data-player-id="900001"]', { hasText: 'Fixture Player 001' })).toBeVisible();
    await expect(players.getByText('profile/900101 · Orphaned')).toBeVisible();
    await expect(players.getByText('profile/900102 · Orphaned')).toBeVisible();
    // Provenance distinguishes valid current values.
    await expect(players.getByText(MAPPING_STORED)).toBeVisible();
    await expect(players.getByText(ROLE_STORED)).toBeVisible();
    // Existing mapping controls keep functioning (presence).
    for (const id of ['#taa-mapping-profile', '#taa-mapping-discord', '#taa-mapping-add', '#taa-player-search', '#taa-player-list']) {
      await expect(page.locator(id)).toBeVisible();
    }
    // Provenance text carries counts, never Discord IDs.
    const provenance = await players.first().innerText();
    expect(provenance).not.toContain(SURROGATE_DISCORD_ID);
    expect(provenance).not.toContain(SURROGATE_ROLE_ID);

    for (const host of requestHosts) {
      expect(host === '127.0.0.1' || host === 'localhost').toBeTruthy();
    }
    const axeResults = await new AxeBuilder({ page }).include('#taa-panel-overlay').analyze();
    expect(axeResults.violations, JSON.stringify(axeResults.violations)).toEqual([]);
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('rejected live DOM falls back to labelled cached roster, absent config stays explicit', async ({ page }) => {
    const requestHosts: string[] = [];
    page.on('request', (request) => {
      try { requestHosts.push(new URL(request.url()).hostname); } catch { /* ignore */ }
    });
    await page.addInitScript(seedScript(SEEDS.cachedAbsent));
    await page.goto('/alliance?panelState=overview&memberTable=rejected-pagination', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });

    const players = page.locator('#taa-players');
    await expect(players.getByText(LIVE_CACHED_BANNER)).toBeVisible();
    await expect(players.locator('span[data-player-id="900001"]', { hasText: 'Cached Alpha' })).toBeVisible();
    await expect(players.getByText(MAPPING_ABSENT)).toBeVisible();
    await expect(players.getByText(ROLE_ABSENT)).toBeVisible();
    // Cached count strip still renders the accepted roster.
    await expect(page.locator('#taa-player-count-strip')).toBeVisible();

    for (const host of requestHosts) {
      expect(host === '127.0.0.1' || host === 'localhost').toBeTruthy();
    }
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('absent table with no cache is explicit, never a zero-player live state', async ({ page }) => {
    await page.addInitScript('try { localStorage.clear(); } catch {}');
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });

    const players = page.locator('#taa-players');
    await expect(players.getByText(ABSENT_CACHED_BANNER)).toBeVisible();
    await expect(players.getByText(MAPPING_ABSENT)).toBeVisible();
    await expect(players.getByText(ROLE_ABSENT)).toBeVisible();
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('other-host mapping bucket is reported, never copied', async ({ page }) => {
    await page.addInitScript(seedScript(SEEDS.otherHost));
    await page.goto('/alliance?panelState=overview', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });

    const players = page.locator('#taa-players');
    await expect(players.getByText(MAPPING_OTHER_HOST)).toBeVisible();
    await expect(players.getByText(ROLE_EMPTY)).toBeVisible();
    // Nothing was copied into the current world: no mapped rows, no IDs in provenance.
    const provenance = await players.first().innerText();
    expect(provenance).not.toContain(SURROGATE_DISCORD_ID);
    const after = await page.evaluate((key: string) => localStorage.getItem(key), MAPPING_KEY);
    expect(after).not.toContain(HOST);
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('failure twin: rejected DOM plus malformed storage degrades safely without writes', async ({ page }) => {
    await page.addInitScript(seedScript(SEEDS.malformed));
    await page.goto('/alliance?panelState=overview&memberTable=rejected-pagination', { waitUntil: 'domcontentloaded' });
    // Seeded configuration keys must survive the failure path untouched. Route-stage
    // diagnostics traces may append (product behavior); mapping/role/roster/names
    // keys must show byte identity.
    const SEEDED_KEYS = [MAPPING_KEY, DISCORD_CONFIG_KEY, ROSTER_KEY, NAMES_KEY];
    const before = await page.evaluate((keys: string[]) => {
      const out: Record<string, string | null> = {};
      for (const key of keys) out[key] = localStorage.getItem(key);
      return out;
    }, SEEDED_KEYS);
    await openPanel(page);
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });

    const players = page.locator('#taa-players');
    await expect(players.getByText(LIVE_CACHED_BANNER)).toBeVisible();
    await expect(players.getByText(MAPPING_MALFORMED)).toBeVisible();
    await expect(players.getByText(ROLE_MALFORMED)).toBeVisible();
    // Cached roster still renders from the intact roster key.
    await expect(players.locator('span[data-player-id="900001"]', { hasText: 'Cached Alpha' })).toBeVisible();

    const after = await page.evaluate((keys: string[]) => {
      const out: Record<string, string | null> = {};
      for (const key of keys) out[key] = localStorage.getItem(key);
      return out;
    }, SEEDED_KEYS);
    expect(after).toEqual(before);
    // Malformed storage read errors are product-console noise; they must stay redacted.
    for (const text of (page as unknown as { __consoleErrors: string[] }).__consoleErrors) {
      expect(text).not.toContain(SURROGATE_DISCORD_ID);
    }
  });

  test('roles and mapping controls remain present with valid values', async ({ page }) => {
    await page.addInitScript(seedScript(SEEDS.liveValid));
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Alerts' }).click({ force: true });
    for (const id of ['#taa-alert-role', '#taa-alert-role-save', '#taa-leave-role-input', '#taa-leave-role-set', '#taa-leave-role-clear']) {
      await expect(page.locator(id)).toBeVisible();
    }
    await expect(page.locator('.taa-leave-role-current')).toBeVisible();
    await page.getByRole('tab', { name: 'Players' }).click({ force: true });
    for (const id of ['#taa-mapping-profile', '#taa-mapping-discord', '#taa-mapping-add']) {
      await expect(page.locator(id)).toBeVisible();
    }
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('incident bundle exports without Discord IDs or data values', async ({ page }) => {
    await page.addInitScript(seedScript(SEEDS.liveValid));
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export incident bundle' }).click();
    const file = await download;
    const json = JSON.parse(
      await file.createReadStream().then(async (stream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
      }),
    );
    expect(json.kind).toBe('taa-incident-bundle');
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(SURROGATE_DISCORD_ID);
    expect(serialized).not.toContain(SURROGATE_ROLE_ID);
    expect(serialized).not.toContain(SURROGATE_LEAVE_ROLE_ID);
    expect(serialized).not.toContain('900001');
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512 * 1024);
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });

  test('standby keeps settings export enabled but import disabled and masked', async ({ page }) => {
    await page.goto('/alliance?panelState=standby', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    const settings = page.locator('#taa-settings-details');
    await settings.locator('summary').click();
    const exportButton = page.locator('#taa-settings-export');
    const importButton = page.locator('#taa-settings-import');
    await expect(exportButton).toBeEnabled();
    await expect(importButton).toBeDisabled();
    await expect(page.locator('#taa-settings-import-textarea')).toBeDisabled();
    const preview = page.locator('#taa-settings-backup-preview');
    const download = page.waitForEvent('download');
    await exportButton.click();
    await download;
    const domText = await settings.innerText();
    expect(domText).not.toContain('fake-fixture-token');
    expect(await preview.inputValue()).not.toContain('fake-fixture-token');
  });

  // task-3 panel clarity additions (delimited): explicit textual Players/Diagnostics/Overview states.
  test('task-3 explicit filter, pagination, trace, and freshness text', async ({ page }) => {
    await page.addInitScript(seedScript(SEEDS.liveValid));
    await page.goto('/alliance?panelState=overview&memberTable=canonical', { waitUntil: 'domcontentloaded' });
    await openPanel(page);

    await expect(page.locator('#taa-freshness-value')).toBeVisible();
    await expect(page.locator('#taa-freshness-value')).toContainText(/Fresh|Stale|Not recorded/);

    await page.getByRole('tab', { name: 'Players' }).click({ force: true });
    await expect(page.locator('#taa-player-pagination-status')).toContainText(/Showing \d+–\d+ of \d+ players · Page \d+ of \d+/);
    await expect(page.locator('#taa-player-filter-status')).toContainText(/No filters|Filters:/);
    await expect(page.locator('#taa-player-filter-status')).toContainText(/players? match/);

    await page.getByRole('tab', { name: 'Diagnostics' }).click({ force: true });
    await expect(page.locator('#taa-trace-count')).toContainText(/Showing \d+ of \d+ traces/);

    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    expect((page as unknown as { __consoleErrors: string[] }).__consoleErrors).toEqual([]);
  });
});
