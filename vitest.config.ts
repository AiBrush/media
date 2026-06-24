import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        // Type-only modules (no runtime to cover).
        'src/api/types.ts',
        'src/kernel/planner.ts',
        // Test-only infrastructure (not shipped).
        'src/test-support/**',
        // Browser-only entrypoints exercised under Playwright/browser-mode, not node coverage.
        'src/**/worker.ts',
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
