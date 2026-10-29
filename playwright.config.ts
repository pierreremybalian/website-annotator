import { defineConfig, devices } from '@playwright/test';

// End-to-end: real widget (Vite dev server) against the real Worker (wrangler dev, TRELLO_MOCK=1, local D1/R2).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @annotate/worker db:migrate:local && pnpm --filter @annotate/worker dev --port 8787',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @annotate/widget dev --port 5173 --strictPort',
      url: 'http://localhost:5173/',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
