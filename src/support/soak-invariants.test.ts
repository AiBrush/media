import { describe, expect, it } from 'vitest';
import {
  GROWTH_SLOPE_THRESHOLD,
  MAX_SOAK_MEMORY_MB,
  assertSoakInvariants,
  assertSoakMemoryBounded,
  assertSoakNoCrashDeadlock,
  assertSoakNoUnboundedGrowth,
  isValidSoakReport,
  soakInvariantsPass,
} from './soak-invariants.ts';
import type { SoakReport } from './soak-invariants.ts';

function report(
  n: number,
  mem: number | ((i: number) => number),
  crashAt: number | null = null,
): SoakReport {
  const iterations = Array.from({ length: n }, (_, i) => ({
    iteration: i,
    memoryMB: typeof mem === 'function' ? (mem as (i: number) => number)(i) : mem,
    durationMs: 100,
    ...(crashAt === i ? { crashed: true } : {}),
  }));
  return { iterations, totalDurationMs: n * 100 };
}

describe('24h soak invariants — 4.3 no crash/deadlock/leak/unbounded growth', () => {
  it('stable mixed workload passes all invariants', () => {
    const r = report(90, 64);
    expect(isValidSoakReport(r)).toBe(true);
    expect(() => assertSoakNoCrashDeadlock(r)).not.toThrow();
    expect(() => assertSoakMemoryBounded(r)).not.toThrow();
    expect(() => assertSoakNoUnboundedGrowth(r)).not.toThrow();
    expect(() => assertSoakInvariants(r)).not.toThrow();
    expect(soakInvariantsPass(r)).toBe(true);
    expect(MAX_SOAK_MEMORY_MB).toBe(128);
    expect(GROWTH_SLOPE_THRESHOLD).toBe(0.05);
  });

  it('crash or deadlock fails', () => {
    expect(() => assertSoakNoCrashDeadlock(report(10, 64, 5))).toThrow(RangeError);
    const deadlocked: SoakReport = {
      iterations: [{ iteration: 0, memoryMB: 64, durationMs: 100, deadlocked: true }],
      totalDurationMs: 100,
    };
    expect(() => assertSoakNoCrashDeadlock(deadlocked)).toThrow(RangeError);
    expect(soakInvariantsPass(report(10, 64, 5))).toBe(false);
  });

  it('memory bounded: over budget fails', () => {
    expect(() => assertSoakMemoryBounded(report(10, 64))).not.toThrow();
    expect(() => assertSoakMemoryBounded(report(10, 200))).toThrow(RangeError);
    expect(() => assertSoakMemoryBounded(report(10, 64), 64)).not.toThrow();
    expect(() => assertSoakMemoryBounded(report(5, 64), 0 as never)).toThrow(RangeError);
  });

  it('unbounded growth: monotonic increase fails, stable passes', () => {
    // first third ~60, last third ~90 => 50% growth >5% => fail
    const growing = report(90, (i) => 60 + (i / 90) * 30);
    expect(() => assertSoakNoUnboundedGrowth(growing)).toThrow(RangeError);
    expect(soakInvariantsPass(growing)).toBe(false);
    // stable with jitter but no median growth passes
    const stable = report(90, (i) => 64 + (i % 3) - 1);
    expect(() => assertSoakNoUnboundedGrowth(stable)).not.toThrow();
    expect(isValidSoakReport(stable)).toBe(true);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const base = 60 + (i % 5);
      const r = report(30, (k) => base + (k % 2));
      expect(isValidSoakReport(r)).toBe(true);
      expect(soakInvariantsPass(r)).toBe(true);
      const growing = report(30, (k) => base + k * 0.2);
      expect(typeof soakInvariantsPass(growing)).toBe('boolean');
    }
  });

  it('boundary: exactly 6 iterations, exactly budget, empty', () => {
    expect(() => assertSoakNoUnboundedGrowth(report(6, 64))).not.toThrow();
    expect(() => assertSoakNoUnboundedGrowth(report(5, 64))).not.toThrow(); // <6 early return
    expect(() => assertSoakMemoryBounded(report(1, 128))).not.toThrow();
    expect(() => assertSoakMemoryBounded(report(1, 128.0001))).toThrow(RangeError);
    expect(isValidSoakReport({ iterations: [], totalDurationMs: 0 })).toBe(true);
    expect(() =>
      assertSoakInvariants({ iterations: [], totalDurationMs: 0 } as never),
    ).not.toThrow();
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(isValidSoakReport(null)).toBe(false);
    expect(() => assertSoakNoCrashDeadlock(null as never)).toThrow(RangeError);
    expect(() => assertSoakMemoryBounded(null as never)).toThrow(RangeError);
    expect(() => assertSoakNoUnboundedGrowth(null as never)).toThrow(RangeError);
    expect(() => assertSoakMemoryBounded(report(2, 64), Number.NaN as never)).toThrow(RangeError);
    expect(() =>
      assertSoakNoUnboundedGrowth(report(90, 64), Number.POSITIVE_INFINITY as never),
    ).toThrow(RangeError);
    expect(
      isValidSoakReport({
        iterations: Array.from({ length: 10001 }, () => ({
          iteration: 0,
          memoryMB: 64,
          durationMs: 100,
        })),
        totalDurationMs: 0,
      } as never),
    ).toBe(false);
  });
});
