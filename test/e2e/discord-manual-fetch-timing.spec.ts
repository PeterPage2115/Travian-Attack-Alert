import { test, expect } from '@playwright/test';
import path from 'node:path';
import { installArtifactRuntime, WEBHOOK, writeEvidencePhase as writeEvidencePhaseShared } from './runtime-bootstrap';

test('manual-fetch round-trip timing is 900-1300ms (NOT artifact dispatch; real dispatch proof is Todo 10 scope)', async ({ page }, testInfo) => {
  const ns = testInfo.workerIndex;
  const nsQuery = `?ns=${ns}`;
  await installArtifactRuntime(page, { webhook: true, ns });
  await page.evaluate((url) => window.GM_setValue('travianAllianceWebhookUrl_v1', url), WEBHOOK);
  await page.evaluate((q) => new Promise<void>(resolve => {
    const payload = { content: '', allowed_mentions: { users: [] } };
    const send = (status: number) => fetch(`/discord-webhook${q}`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } }).then(() => { if (status === 200) resolve(); });
    send(429);
    window.setTimeout(() => send(200), 1_000);
  }), nsQuery);
  await expect.poll(async () => (await page.evaluate(async (q: string) => await (await fetch(`/e2e-log${q}`)).json(), nsQuery)).discordRequests?.length ?? 0, { timeout: 8_000 }).toBe(2);
  const log = await page.evaluate(async (q: string) => await (await fetch(`/e2e-log${q}`)).json(), nsQuery);
  expect(log.discordRequests).toHaveLength(2);
  expect(log.discordRequests[1].body.content).toBe('');
  expect(log.discordRequests[1].body.allowed_mentions).toEqual({ users: [] });
  expect(log.discordRequests[1].endedAt - log.discordRequests[0].startedAt).toBeGreaterThanOrEqual(900);
  expect(log.discordRequests[1].endedAt - log.discordRequests[0].startedAt).toBeLessThanOrEqual(1300);
  expect(await page.evaluate(() => window.__TAA_REQUESTS__?.every(url => url.startsWith(location.origin)))).toBeTruthy();
  const evidencePath = path.join('test-results', 'release-1.0.0', 'e2e-evidence-discord-manual-fetch-timing.json');
  writeEvidencePhaseShared(evidencePath, 'manual-fetch-timing', {
    fixtureRequestLog: log.discordRequests,
    cleanup: { openRequests: log.openRequests, serverManagedByPlaywright: true },
  }, ns);
});
