import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './e2e/env.js';

const baseURL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 45_000,
  use: { baseURL, locale: 'fr-FR', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Builds nothing: run `pnpm build` first (CI does).
    command: 'pnpm exec tsx e2e/serve.ts',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
