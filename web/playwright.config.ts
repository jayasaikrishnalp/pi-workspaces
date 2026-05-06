import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the cloudops-workspace web E2E suite.
 *
 * Architecture:
 *   - One backend instance per `npm run test:e2e` invocation (globalSetup
 *     spawns it on port 8766 with PI_WORKSPACE_ROOT pointing at a tmp dir;
 *     globalTeardown kills it). Each spec uses unique entity names so they
 *     don't collide on shared state.
 *   - Vite preview serves the production build at :5173 with /api proxied
 *     to localhost:8766 (matches dev config).
 */

const VITE_PORT = 5173

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './test/e2e/_global-setup.ts',
  globalTeardown: './test/e2e/_global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: `http://127.0.0.1:${VITE_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  outputDir: 'test-results',
})
