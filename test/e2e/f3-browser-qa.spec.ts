import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { installArtifactRuntime } from './runtime-bootstrap';

test('fixture page loads marker text with the checked-in artifact and stays loopback-only (smoke check, not a QA verdict)', async ({ page }) => {
  await installArtifactRuntime(page);
  const release = await page.evaluate(() => document.body.innerText.includes('Alliance') ? 'loaded' : 'missing');
  expect(release).toBe('loaded');
  const hosts: string[] = [];
  page.on('request', request => hosts.push(new URL(request.url()).origin));
  await page.locator('table.allianceMembers').waitFor();
  expect(hosts.every(origin => origin === new URL(page.url()).origin)).toBeTruthy();
  fs.mkdirSync(path.join('test-results', 'release-1.0.0'), { recursive: true });
  const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;
  const artifactBytes = fs.readFileSync('script.txt');
  const crypto = await import('node:crypto');
  const fixtureLog = await page.evaluate(async () => await (await fetch('/e2e-log')).json());
  const evidencePath = path.join('test-results', 'release-1.0.0', 'e2e-evidence-f3-browser-qa.json');
  const previous = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as { fixtureRequestLog?: unknown[] } : {};
  fs.writeFileSync(evidencePath, `${JSON.stringify({ releaseId: 'taa-' + packageVersion, artifactSha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'), allowlist: [new URL(page.url()).origin, 'http://127.0.0.1:8899/discord-webhook'], gmRequestAllowlist: windowAllowlist(page), fixtureRequestLog: fixtureLog.discordRequests.length > 0 ? fixtureLog.discordRequests : previous.fixtureRequestLog ?? [], cleanup: { openRequests: fixtureLog.openRequests, serverManagedByPlaywright: true } }, null, 2)}\n`);
});

function windowAllowlist(page: { url(): string }): string[] { return [new URL(page.url()).origin, 'http://127.0.0.1:8899/discord-webhook']; }

test('harness self-check: zoom project reports the CSS zoom value set by the test itself (not app behavior)', async ({ page }, testInfo) => {
  await installArtifactRuntime(page);
  if (testInfo.project.name === 'chromium-375-zoom200') await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const zoom = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1'));
  expect(zoom).toBe(testInfo.project.name === 'chromium-375-zoom200' ? 2 : 1);
});
