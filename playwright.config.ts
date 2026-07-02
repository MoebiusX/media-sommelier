import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Playwright E2E config for the Media Sommelier web app.
 *
 * Topology (mirrors `npm run dev`, but isolated):
 *   - API server (src/server2) on :4178, pointed at an EPHEMERAL seeded DB via SOMMELIER_DB — never the
 *     user's real data/sommelier.db. The `e2e:api` script seeds first (tsx e2e/seed.ts), then serves.
 *   - Vite dev server (web) on :5180, which proxies /api → :4178.
 *
 * Run: `npm run test:e2e`  (stop `npm run dev` first — the suite needs ports 4178 + 5180 free).
 *
 * The suite runs SERIALLY (workers:1) because there is one shared backend + SQLite catalog; tests that
 * mutate server state (playlists/profiles) clean up after themselves.
 */
const SOMMELIER_DB = resolve('e2e/.tmp/sommelier-e2e.db');
const API_PORT = '4178';
const WEB_URL = 'http://localhost:5180';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: WEB_URL,
    colorScheme: 'dark', // deterministic default theme (app default is dark)
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      // Let the player start audio without a synthetic gesture requirement in headless Chromium.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm run e2e:api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { SOMMELIER_DB, PORT: API_PORT, HOST: '127.0.0.1' },
    },
    {
      command: 'npm --prefix web run dev',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
