import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup/indexeddb.ts', './test/setup/canvas.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // Each test file gets its own jsdom environment (isolate defaults to true, and rightly so —
    // this package leans on module-level singletons like the shared ConnectionMonitor, so sharing
    // an environment across files would leak state between them). With 45+ files that adds up in
    // memory-constrained CI/sandboxes; capping worker threads trades some wall-clock time for a
    // much lower peak memory footprint instead of risking an OOM mid-run.
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
