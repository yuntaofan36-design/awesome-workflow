import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'federation-csp.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'line',
  timeout: 45_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/federation-csp-fixture.mjs',
      url: 'http://127.0.0.1:4391/__digest',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://127.0.0.1:4390/.well-known/awesome-workflow/federation-policy',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        BROWSER: 'none',
        VITE_TRUSTED_FEDERATION_ORIGINS: 'http://127.0.0.1:4391',
        VITE_WEB_PORT: '4390',
      },
    },
  ],
});
