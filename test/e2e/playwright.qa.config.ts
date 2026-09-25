import { defineConfig, devices } from '@playwright/test';

/**
 * Loopback QA config for the release orchestration (plan Todo 3).
 *
 * Same specs, same six Chromium projects (so executed counts match the
 * suite manifest), same deterministic loopback fixture server on
 * 127.0.0.1:8899 — no Travian/Discord/production network anywhere.
 * Only the evidence/output directories differ from playwright.config.ts,
 * so QA runs never clobber the default local report layout.
 */
// Task 20's same-document lease reacquisition tests wait on the product's real
// ~30 s lease-renewal cadence (≈70-150 s per project). Running them on all six
// projects pushed the dual-tab-lease spec over `tools/run-e2e.cjs`'s hard 480 s
// per-spec ceiling, so they live in their own spec file and run on ONE
// representative desktop project only. This is a project FILTER (the file is
// never collected for the other projects), not a `test.skip`: release mode
// rejects any skipped execution. The other five projects still run the rest of
// dual-tab-lease.spec.ts, and the moved assertions are unchanged.
const REACQUISITION_SPEC = '**/dual-tab-lease-reacquisition.spec.ts';

// `tools/run-e2e.cjs` still launches ONE spec file per Playwright invocation,
// sequentially; `workers` parallelizes tests WITHIN that spec across the six
// projects. TAA_E2E_WORKERS overrides the count (1 = serial baseline); unset
// means 4 on CI (4 vCPU runner) and 1 locally so a laptop is never
// oversubscribed. Invalid values fail loudly rather than silently defaulting.
function resolveWorkers(): number {
  const raw = process.env.TAA_E2E_WORKERS;
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`TAA_E2E_WORKERS must be a positive integer, got ${raw}`);
    }
    return value;
  }
  return process.env.CI ? 4 : 1;
}

export default defineConfig({
  testDir: '.',
  // CI reports must never embed the branch diff: it can carry forbidden
  // private-path context (and inflates the sealed evidence ~13x). Keep commit
  // identity metadata; drop the diff.
  captureGitInfo: { commit: true, diff: false },
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Safe because every test owns its context/page and localStorage, and the
  // loopback fixture state is namespaced per worker (runtime-bootstrap.ts +
  // test/fixtures/panel/server.cjs). No spec uses describe.serial.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: resolveWorkers(),
  outputDir: '../../test-results/qa-artifacts',
  reporter: [['list'], ['json', { outputFile: '../../test-results/qa-report.json' }], ['html', { outputFolder: '../../test-results/qa-playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8899',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium-375',
      testIgnore: REACQUISITION_SPEC,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 800 } },
    },
    {
      name: 'chromium-768',
      testIgnore: REACQUISITION_SPEC,
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 800 } },
    },
    {
      name: 'chromium-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'chromium-375-zoom200',
      testIgnore: REACQUISITION_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 800 },
        launchOptions: { args: ['--force-device-scale-factor=1'] },
      },
    },
    {
      name: 'chromium-1280-reduced-motion',
      testIgnore: REACQUISITION_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        contextOptions: { reducedMotion: 'reduce' },
      },
    },
    {
      name: 'chromium-1280-forced-colors',
      testIgnore: REACQUISITION_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        contextOptions: { forcedColors: 'active' },
      },
    },
  ],
  webServer: {
    command: 'node ../../test/fixtures/panel/server.cjs',
    url: 'http://127.0.0.1:8899/health',
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
