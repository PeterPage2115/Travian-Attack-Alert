import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installArtifactRuntime } from './runtime-bootstrap';

type ScanRecord = { readonly stage?: string; readonly status?: string; readonly reason?: string };

const DIAGNOSTICS_KEY = 'travianAllianceDiagnostics_v2';
const MONITOR_KEY_PREFIX = 'travianAllianceMonitor_v1:';

async function readScanRecords(page: Page): Promise<ScanRecord[]> {
  return await page.evaluate((key: string) => {
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    const diagnostics = JSON.parse(stored) as Record<string, { readonly records?: ScanRecord[] }>;
    return Object.values(diagnostics).flatMap((world) => world.records ?? []);
  }, DIAGNOSTICS_KEY);
}

function terminalRecord(records: readonly ScanRecord[]): ScanRecord | null {
  return records.find((record) => record.stage === 'snapshot'
    && ((record.status === 'ok' && record.reason === 'authoritative')
      || (record.status === 'rejected' && record.reason === 'readiness-timeout'))) ?? null;
}

async function waitForTerminalRecord(page: Page, timeout: number): Promise<ScanRecord | null> {
  let found: ScanRecord | null = null;
  await expect.poll(async () => {
    found = terminalRecord(await readScanRecords(page));
    return found !== null;
  }, { timeout }).toBe(true);
  return found;
}

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

// Scenario: given a document held at `interactive` by a parked subresource
// after DOMContentLoaded has fired, when the artifact runs and `complete`
// arrives later with no DOM mutation, then readiness must still be observed
// exactly once. The runtime's only load-state listener is a one-shot
// DOMContentLoaded registration, so this transition is invisible unless a
// mutation accompanies it; the fixture must avoid every post-install mutation
// for the reproducer to remain honest.
test('a mutation-free interactive to complete transition is scanned exactly once', async ({ page }, testInfo) => {
  const runtime = await installArtifactRuntime(page, { path: '/alliance/profile/members', holdInteractive: true, ns: testInfo.workerIndex });
  const armedAtMs = Date.now();
  const beforeInstall = await runtime.readProbe();
  expect(beforeInstall.readyState).toBe('interactive');
  expect(await runtime.holdPending()).toBe(true);
  const beforeRelease = await runtime.readProbe();
  await runtime.releaseHeldLoad();
  await expect.poll(async () => (await runtime.readProbe()).readyState, { timeout: 5_000 }).toBe('complete');
  const atComplete = await runtime.readProbe();
  const terminal = await waitForTerminalRecord(page, 20_000);
  const atTerminal = await runtime.readProbe();
  const observedAtMs = Date.now();
  const events = await page.evaluate(() => window.__TAA_E2E_EVENTS__ ?? []);
  const requests = await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
  const report = {
    test: 'a mutation-free interactive to complete transition is scanned exactly once',
    readyStates: atComplete.readyStates,
    readyStateAtInstall: beforeInstall.readyState,
    readyStateAtRelease: beforeRelease.readyState,
    mutationsInstallToComplete: atComplete.mutations - beforeInstall.mutations,
    mutationsReleaseToComplete: atComplete.mutations - beforeRelease.mutations,
    mutationsInstallToTerminal: atTerminal.mutations - beforeInstall.mutations,
    readinessEvents: events.filter((event) => event.kind === 'readiness'),
    extractionEvents: events.filter((event) => event.kind === 'extraction').length,
    authoritativeSnapshots: events.filter((event) => event.kind === 'snapshot' && event.status === 'authoritative').length,
    terminal: terminal ?? null,
    elapsedArmedToTerminalMs: observedAtMs - armedAtMs,
    duplicateRequestCount: requests.length,
  };
  console.log(`TAA_TASK2_EVIDENCE ${JSON.stringify(report)}`);
  expect(atComplete.readyStates).toEqual(expect.arrayContaining(['interactive', 'complete']));
  expect(report.mutationsReleaseToComplete).toBe(0);
  expect(terminal?.reason).toBe('authoritative');
  expect(terminal?.status).toBe('ok');
  expect(report.extractionEvents).toBe(1);
  expect(report.authoritativeSnapshots).toBe(1);
  expect(requests).toHaveLength(0);
});

// Bounded failure path: the subresource stays parked past the 15s scan-cycle
// deadline, so no scan may be accepted and the rejection must be classified
// as readiness-timeout with the monitor baseline untouched.
test('a document held interactive past the scan deadline is rejected without a baseline advance', async ({ page }, testInfo) => {
  const runtime = await installArtifactRuntime(page, { path: '/alliance/profile/members', holdInteractive: true, ns: testInfo.workerIndex });
  const armedAtMs = Date.now();
  const beforeInstall = await runtime.readProbe();
  expect(beforeInstall.readyState).toBe('interactive');
  const terminal = await waitForTerminalRecord(page, 20_000);
  const atTerminal = await runtime.readProbe();
  const observedAtMs = Date.now();
  const events = await page.evaluate(() => window.__TAA_E2E_EVENTS__ ?? []);
  const requests = await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
  const monitorKeys = await page.evaluate((prefix: string) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), MONITOR_KEY_PREFIX);
  const report = {
    test: 'a document held interactive past the scan deadline is rejected without a baseline advance',
    readyStates: atTerminal.readyStates,
    readyStateAtInstall: beforeInstall.readyState,
    mutationsInstallToTerminal: atTerminal.mutations - beforeInstall.mutations,
    readinessEvents: events.filter((event) => event.kind === 'readiness').length,
    snapshots: events.filter((event) => event.kind === 'snapshot').length,
    extractionEvents: events.filter((event) => event.kind === 'extraction').length,
    terminal: terminal ?? null,
    elapsedArmedToTerminalMs: observedAtMs - armedAtMs,
    monitorKeys,
    duplicateRequestCount: requests.length,
  };
  console.log(`TAA_TASK2_EVIDENCE ${JSON.stringify(report)}`);
  expect(terminal?.reason).toBe('readiness-timeout');
  expect(terminal?.status).toBe('rejected');
  expect(report.snapshots).toBe(0);
  expect(report.extractionEvents).toBe(0);
  expect(monitorKeys).toHaveLength(0);
  expect(requests).toHaveLength(0);
  await runtime.releaseHeldLoad();
});
