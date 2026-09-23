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

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
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
