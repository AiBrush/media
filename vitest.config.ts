import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // This suite is CPU-bound on real corpus bytes — pure-TS and wasm decode/encode, frame walks,
    // digests — with no network and no polling, so wall time is a direct function of how much CPU the
    // process actually gets. Under contention (the parallel pool, or a browser matrix run on the same
    // machine) the same work takes several times longer: flac.test.ts 10.8 s idle vs 43 s saturated,
    // hls-source.test.ts 19–47 s, s16-resample-stream.test.ts 35 s contended. Vitest's 5 s default then
    // reports a *timeout* for work that was progressing normally — a false failure that says nothing
    // about the code under test, and the most expensive kind of noise because it looks like a real one.
    //
    // 60 s is therefore a backstop against a genuine hang, not a performance assertion. Nothing here
    // measures speed through its deadline: the one CPU-throughput guard (src/dsp/resample.test.ts)
    // asserts on `process.cpuUsage()`, and the one suite that deliberately tests for eternal hangs
    // (src/drivers/lazy-filter-stream.test.ts) races its own `withinMs` watchdog, so both keep their
    // real, fast signal regardless of what this number is. Throughput regressions belong to the
    // benchmark goldens. Raise a single test above this only when it is a measured outlier.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The resampler file contains a CPU-throughput regression guard. Give it its own process so
    // process.cpuUsage() measures that kernel rather than every concurrently running worker thread.
    poolMatchGlobs: [['**/src/dsp/resample.test.ts', 'forks']],
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
