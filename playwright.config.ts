import { defineConfig } from '@playwright/test';

// Real-browser smoke tests for the two things jsdom + fake-indexeddb structurally cannot
// represent: real network-offline state (page.context().setOffline()) and real multi-tab
// behavior (two independent Page instances sharing one origin's IndexedDB). See e2e/README.md.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    // Serves the repo root so both /dist/*.js (must be built first — see e2e/README.md) and
    // /e2e/fixtures/*.html are reachable from the same origin.
    command: 'pnpm exec serve . -l 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
