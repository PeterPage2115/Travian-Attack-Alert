import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  outputDir: '../../test-results/artifacts',
  reporter: [['list'], ['html', { outputFolder: '../../test-results/playwright-report', open: 'never' }]],
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
    // task-3 panel clarity additions (delimited): reduced-motion and forced-colors
    // projects. Existing projects and the webServer command are untouched.
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
