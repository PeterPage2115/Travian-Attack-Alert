import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installArtifactRuntime } from './runtime-bootstrap';
import type { ArtifactRuntime } from './runtime-bootstrap';

type ScanRecord = { readonly stage?: string; readonly status?: string; readonly reason?: string };
type E2eEvent = { readonly kind?: string; readonly status?: string; readonly reason?: string; readonly atMs?: number };

const DIAGNOSTICS_KEY = 'travianAllianceDiagnostics_v2';
const MONITOR_KEY_PREFIX = 'travianAllianceMonitor_v1:';
const MONITOR_KEY = `${MONITOR_KEY_PREFIX}127.0.0.1`;
// The fixture roster size (test/fixtures/acquisition/members-59-incident.html).
// It is NOT a product threshold: the parser contract must keep accepting any
// stable, fully hydrated roster, smaller included.
const FIXTURE_ROSTER_SIZE = 59;
const EVIDENCE_TAG = 'TAA_TASK3_EVIDENCE';

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

// Any scan terminal, including the parser/scan-error outcomes the strict helper
// above deliberately ignores (an empty shell on v1.0.2 commits `scan-error`).
function firstTerminalRecord(records: readonly ScanRecord[]): ScanRecord | null {
  return records.find((record) => record.stage === 'snapshot' || record.stage === 'lease') ?? null;
}

async function waitForAnyTerminal(page: Page, timeout: number): Promise<ScanRecord | null> {
  let found: ScanRecord | null = null;
  await expect.poll(async () => {
    found = firstTerminalRecord(await readScanRecords(page));
    return found !== null;
  }, { timeout }).toBe(true);
  return found;
}

type MonitorSnapshot = { readonly keyCount: number; readonly memberCount: number; readonly generation: unknown; readonly raw: string | null };

async function readMonitor(page: Page): Promise<MonitorSnapshot> {
  return await page.evaluate((prefix: string) => {
    const keys = Object.keys(window.__TAA_GM_VALUES__ ?? {}).filter((key) => key.startsWith(prefix));
    const raw = (window.__TAA_GM_VALUES__?.[`${prefix}127.0.0.1`] as string | undefined) ?? null;
    let memberCount = 0;
    let generation: unknown = null;
    if (raw) {
      try {
        const envelope = JSON.parse(raw) as { baselineByPlayerId?: Record<string, unknown>; generation?: unknown };
        memberCount = Object.keys(envelope.baselineByPlayerId ?? {}).length;
        generation = envelope.generation ?? null;
      } catch {
        memberCount = 0;
      }
    }
    return { keyCount: keys.length, memberCount, generation, raw };
  }, MONITOR_KEY_PREFIX);
}

async function readEvents(page: Page): Promise<E2eEvent[]> {
  return await page.evaluate(() => (window.__TAA_E2E_EVENTS__ ?? []) as E2eEvent[]);
}

// The prior authoritative envelope is produced by the artifact itself: a first
// page load scans the 59-row fixture roster and commits it. The harness GM
// store dies with the document, so the spec captures the raw value and restores
// it through `seedGMValues` — the same snapshot/restore technique
// clean-install.spec.ts uses after a reload, never a fabricated envelope.
async function seedAuthoritativeEnvelope(page: Page, ns: string | number): Promise<MonitorSnapshot> {
  await installArtifactRuntime(page, { path: '/alliance/profile/members', memberTable: 'members59', ns });
  const terminal = await waitForAnyTerminal(page, 20_000);
  if (terminal?.status !== 'ok' || terminal.reason !== 'authoritative') {
    throw new Error(`seed scan did not reach authoritative: ${JSON.stringify(terminal)}`);
  }
  const seeded = await readMonitor(page);
  if (seeded.memberCount !== FIXTURE_ROSTER_SIZE) {
    throw new Error(`seed scan committed ${seeded.memberCount} baseline members, expected ${FIXTURE_ROSTER_SIZE}`);
  }
  // Phase B must observe only its own diagnostics records.
  await page.evaluate((key: string) => localStorage.removeItem(key), DIAGNOSTICS_KEY);
  return seeded;
}

async function collectCase(
  page: Page,
  runtime: ArtifactRuntime,
  testName: string,
  caseId: string,
  seed: MonitorSnapshot | null,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> & { readonly acceptedSnapshots: number; readonly extractionEvents: number; readonly duplicateRequestCount: number; readonly snapshotEvents: number; readonly baselineMemberCount: number }> {
  const events = await readEvents(page);
  const requests = await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
  const probe = await runtime.readProbe();
  const monitor = await readMonitor(page);
  const records = await readScanRecords(page);
  const hydratedAt = probe.hydratedAt;
  const snapshotsBeforeHydration = hydratedAt === null
    ? 0
    : events.filter((event) => event.kind === 'snapshot' && typeof event.atMs === 'number' && event.atMs < hydratedAt).length;
  const acceptedBeforeHydration = hydratedAt === null
    ? 0
    : events.filter((event) => event.kind === 'snapshot' && event.status === 'authoritative' && typeof event.atMs === 'number' && event.atMs < hydratedAt).length;
  const acceptedSnapshots = events.filter((event) => event.kind === 'snapshot' && event.status === 'authoritative').length;
  return {
    test: testName,
    case: caseId,
    terminal: firstTerminalRecord(records),
    acceptedSnapshots,
    extractionEvents: events.filter((event) => event.kind === 'extraction').length,
    readinessEvents: events.filter((event) => event.kind === 'readiness').length,
    snapshotEvents: events.filter((event) => event.kind === 'snapshot').length,
    snapshotsBeforeHydration,
    acceptedBeforeHydration,
    duplicateRequestCount: requests.length,
    mutations: probe.mutations,
    readyStates: probe.readyStates,
    readinessListenerAt: probe.readinessListenerAt,
    hydratedAt,
    monitorKeys: monitor.keyCount,
    baselineMemberCount: monitor.memberCount,
    baselineGeneration: monitor.generation,
    seedMemberCount: seed?.memberCount ?? null,
    seedGeneration: seed?.generation ?? null,
    ...extra,
  };
}

function logCase(report: Record<string, unknown>): void {
  console.log(`${EVIDENCE_TAG} ${JSON.stringify(report)}`);
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

// Case (b): the mutation storm now lands on MEMBER-TABLE rows (the harness
// re-adds the table, then toggles a row in and out every 25ms). The canonical
// content never stabilizes, so this must stay fail-closed after the task-5
// readiness fix: readiness-timeout, zero extractions, zero baseline advance.
test('continuously mutating canonical DOM has one timeout and never extracts', async ({ page }, testInfo) => {
  const runtime = await installArtifactRuntime(page, { path: '/alliance/profile/members', continuousMutation: true, webhook: true, ns: testInfo.workerIndex });
  await expect.poll(async () => await page.evaluate(() => {
    const stored = localStorage.getItem('travianAllianceDiagnostics_v2');
    if (!stored) return false;
    const diagnostics: Record<string, { readonly records?: Array<{ readonly reason?: string }> }> = JSON.parse(stored);
    return Object.values(diagnostics).some((world) => world.records?.some((record) => record.reason === 'readiness-timeout') ?? false);
  }), { timeout: 20_000 }).toBe(true);
  const monitor = await readMonitor(page);
  const report = await collectCase(page, runtime, 'continuously mutating canonical DOM has one timeout and never extracts', 'b-member-table-row-storm', null);
  logCase(report);
  expect(report.terminal).toMatchObject({ stage: 'snapshot', status: 'rejected', reason: 'readiness-timeout' });
  expect(report.acceptedSnapshots).toBe(0);
  expect(report.extractionEvents).toBe(0);
  expect(monitor.keyCount).toBe(0);
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
// as readiness-timeout with the monitor baseline untouched. Task 6 bounds the
// recovery: after the first timeout the runtime re-arms a second same-document
// attempt (2s, then 5s) instead of committing or spinning.
test('a document held interactive past the scan deadline is rejected without a baseline advance', async ({ page }, testInfo) => {
  const runtime = await installArtifactRuntime(page, { path: '/alliance/profile/members', holdInteractive: true, ns: testInfo.workerIndex });
  const armedAtMs = Date.now();
  const beforeInstall = await runtime.readProbe();
  expect(beforeInstall.readyState).toBe('interactive');
  const terminal = await waitForTerminalRecord(page, 20_000);
  await expect.poll(async () => (await readEvents(page)).filter((event) => event.kind === 'readiness-retry').length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  const atTerminal = await runtime.readProbe();
  const observedAtMs = Date.now();
  const events = await page.evaluate(() => window.__TAA_E2E_EVENTS__ ?? []);
  const requests = await page.evaluate(() => window.__TAA_REQUESTS__ ?? []);
  const monitorKeys = await page.evaluate((prefix: string) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), MONITOR_KEY_PREFIX);
  const readinessRetries = events.filter((event) => event.kind === 'readiness-retry');
  const report = {
    test: 'a document held interactive past the scan deadline is rejected without a baseline advance',
    readyStates: atTerminal.readyStates,
    readyStateAtInstall: beforeInstall.readyState,
    mutationsInstallToTerminal: atTerminal.mutations - beforeInstall.mutations,
    readinessEvents: events.filter((event) => event.kind === 'readiness').length,
    snapshots: events.filter((event) => event.kind === 'snapshot').length,
    extractionEvents: events.filter((event) => event.kind === 'extraction').length,
    readinessRetries,
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
  expect(readinessRetries[0]).toMatchObject({ attempt: 1, nextDelayMs: 2000 });
  await runtime.releaseHeldLoad();
});

// Case (a): the member table arrives complete (the 59-row fixture roster) while
// a NON-table body attribute is toggled every 25ms. Unrelated DOM churn must
// not reset the readiness quiet window: after the fix exactly one authoritative
// scan is accepted with zero duplicate requests. On untouched v1.0.2 the
// whole-document observer starves and the run ends in readiness-timeout.
test('unrelated body-attribute churn does not starve a complete stable member table', async ({ page }, testInfo) => {
  const runtime = await installArtifactRuntime(page, {
    path: '/alliance/profile/members',
    memberTable: 'absent',
    bodyChurn: true,
    hydrateMemberTableAfterMs: 300,
    ns: testInfo.workerIndex,
  });
  const terminal = await waitForAnyTerminal(page, 20_000);
  const report = await collectCase(
    page,
    runtime,
    'unrelated body-attribute churn does not starve a complete stable member table',
    'a-unrelated-body-churn',
    null,
  );
  logCase(report);
  expect(terminal).toMatchObject({ stage: 'snapshot', status: 'ok', reason: 'authoritative' });
  expect(report.acceptedSnapshots).toBe(1);
  expect(report.extractionEvents).toBe(1);
  expect(report.baselineMemberCount).toBe(FIXTURE_ROSTER_SIZE);
  expect(report.duplicateRequestCount).toBe(0);
});

// Case (c): an accepted but EMPTY member-table shell is present while the
// document is already `complete`; the 59 fixture rows are appended 1200ms after
// the artifact boots (well past the 500ms quiet window). The empty shell must
// never be extracted or committed, and once the hydrated roster is stable it
// must be accepted exactly once. The seed phase commits the same 59 members
// first, so a premature replacement would be visible as a baseline change.
// On untouched v1.0.2 the shell is extracted immediately and burns the
// document's single attempt on a `scan-error` terminal.
test('an empty member-table shell hydrated late is never scanned and commits once', async ({ page }, testInfo) => {
  const ns = testInfo.workerIndex;
  const seed = await seedAuthoritativeEnvelope(page, ns);
  const runtime = await installArtifactRuntime(page, {
    path: '/alliance/profile/members',
    memberTable: 'empty-shell',
    hydrateMemberTableAfterMs: 1200,
    ns,
    seedGMValues: { [MONITOR_KEY]: seed.raw ?? '' },
  });
  await expect.poll(async () => (await runtime.readProbe()).hydratedAt, { timeout: 10_000 }).not.toBeNull();
  const terminal = await waitForAnyTerminal(page, 20_000);
  const report = await collectCase(page, runtime, 'an empty member-table shell hydrated late is never scanned and commits once', 'c-empty-shell-late-hydration', seed);
  logCase(report);
  expect(report.hydratedAt).not.toBeNull();
  expect(report.snapshotsBeforeHydration).toBe(0);
  expect(report.acceptedBeforeHydration).toBe(0);
  expect(terminal).toMatchObject({ stage: 'snapshot', status: 'ok', reason: 'authoritative' });
  expect(report.acceptedSnapshots).toBe(1);
  expect(report.baselineMemberCount).toBe(FIXTURE_ROSTER_SIZE);
  expect(report.duplicateRequestCount).toBe(0);
});

// Case (d): only 12 of the 59 fixture rows are present and the document is held
// `interactive` behind a parkable subresource; the remaining 47 rows are
// appended 1200ms after boot, still before the release. The partial roster must
// never be committed (seeded member count and generation must survive intact)
// and after the release to `complete` the full stable roster must be accepted
// exactly once. On untouched v1.0.2 the complete transition is invisible, so
// the run ends in readiness-timeout with zero scans.
test('partial member rows that complete late never commit the partial roster', async ({ page }, testInfo) => {
  const ns = testInfo.workerIndex;
  const seed = await seedAuthoritativeEnvelope(page, ns);
  const runtime = await installArtifactRuntime(page, {
    path: '/alliance/profile/members',
    memberTable: 'partial-12',
    holdInteractive: true,
    hydrateMemberTableAfterMs: 1200,
    hydrateKeepRows: 12,
    ns,
    seedGMValues: { [MONITOR_KEY]: seed.raw ?? '' },
  });
  await expect.poll(async () => (await runtime.readProbe()).hydratedAt, { timeout: 10_000 }).not.toBeNull();
  const whilePartial = await collectCase(page, runtime, 'partial member rows that complete late never commit the partial roster', 'd-partial-rows-complete-late', seed);
  expect(whilePartial.snapshotEvents).toBe(0);
  expect(whilePartial.acceptedSnapshots).toBe(0);
  expect(whilePartial.baselineMemberCount).toBe(FIXTURE_ROSTER_SIZE);
  expect(whilePartial.baselineGeneration).toEqual(seed.generation);
  await runtime.releaseHeldLoad();
  const terminal = await waitForAnyTerminal(page, 20_000);
  const report = await collectCase(page, runtime, 'partial member rows that complete late never commit the partial roster', 'd-partial-rows-complete-late', seed, {
    whilePartialSnapshotEvents: whilePartial.snapshotEvents,
    whilePartialBaselineMemberCount: whilePartial.baselineMemberCount,
    whilePartialBaselineGeneration: whilePartial.baselineGeneration,
  });
  logCase(report);
  expect(terminal).toMatchObject({ stage: 'snapshot', status: 'ok', reason: 'authoritative' });
  expect(report.acceptedSnapshots).toBe(1);
  expect(report.snapshotsBeforeHydration).toBe(0);
  expect(report.baselineMemberCount).toBe(FIXTURE_ROSTER_SIZE);
  expect(report.duplicateRequestCount).toBe(0);
});
