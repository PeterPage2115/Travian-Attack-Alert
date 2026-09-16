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
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 800 } },
    },
    {
      name: 'chromium-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 800 } },
    },
    {
      name: 'chromium-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'chromium-375-zoom200',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 800 },
        launchOptions: { args: ['--force-device-scale-factor=1'] },
      },
    },
    {
      name: 'chromium-1280-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        contextOptions: { reducedMotion: 'reduce' },
      },
    },
    {
      name: 'chromium-1280-forced-colors',
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
