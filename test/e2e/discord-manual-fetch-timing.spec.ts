import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { installArtifactRuntime, WEBHOOK } from './runtime-bootstrap';

test('manual-fetch round-trip timing is 900-1300ms (NOT artifact dispatch; real dispatch proof is Todo 10 scope)', async ({ page }) => {
  await installArtifactRuntime(page, { webhook: true });
  await page.evaluate((url) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
  await page.evaluate(() => new Promise<void>(resolve => {
    const payload = { content: '', allowed_mentions: { users: [] } };
    const send = (status: number) => fetch('/discord-webhook', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }).then(() => { if (status === 200) resolve(); });
    send(429);
    window.setTimeout(() => send(200), 1_000);
  }));
  await expect.poll(async () => (await page.evaluate(async () => await (await fetch('/e2e-log')).json())).discordRequests?.length ?? 0, { timeout: 8_000 }).toBe(2);
  const log = await page.evaluate(async () => await (await fetch('/e2e-log')).json());
  expect(log.discordRequests).toHaveLength(2);
  expect(log.discordRequests[1].body.content).toBe('');
  expect(log.discordRequests[1].body.allowed_mentions).toEqual({ users: [] });
  expect(log.discordRequests[1].endedAt - log.discordRequests[0].startedAt).toBeGreaterThanOrEqual(900);
  expect(log.discordRequests[1].endedAt - log.discordRequests[0].startedAt).toBeLessThanOrEqual(1300);
  expect(await page.evaluate(() => window.__TAA_REQUESTS__?.every(url => url.startsWith(location.origin)))).toBeTruthy();
  fs.mkdirSync(path.join('test-results', 'release-1.0.0'), { recursive: true });
  const evidencePath = path.join('test-results', 'release-1.0.0', 'e2e-evidence-discord-manual-fetch-timing.json');
  const existing = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : {};
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ...existing, fixtureRequestLog: log.discordRequests, cleanup: { openRequests: log.openRequests, serverManagedByPlaywright: true } }, null, 2)}\n`);
});
