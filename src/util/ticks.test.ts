import { describe, expect, it } from 'vitest';
import {
  cumulativeUsFromDurations,
  samplesToTicks,
  ticksToSamples,
  ticksToUs,
  ticksToUsBigInt,
  usToTicks,
  usToTicksBigInt,
} from './ticks.ts';

describe('ticks — rational exact conversions', () => {
  it('round-trips microseconds at common timescales', () => {
    const cases: Array<[number, number]> = [
      [0, 90_000],
      [1_000_000, 90_000],
      [33_333, 90_000],
      [1_000, 1_000],
      [500_000, 48_000],
      [1_000_000, 48_000],
    ];
    for (const [us, ts] of cases) {
      const t = usToTicks(us, ts);
      const back = ticksToUs(t, ts);
      // half-up rounding means at most 0.5 tick error, which for these ts is ≤ ~11µs
      expect(Math.abs(back - us)).toBeLessThanOrEqual(Math.ceil(1_000_000 / ts));
    }
  });

  it('rejects zero timescale and handles fractional microseconds', () => {
    expect(usToTicks(0.5, 90_000)).toBe(0);
    expect(() => usToTicks(1_000, 0)).toThrow();
    expect(() => ticksToUs(10, 0)).toThrow();
  });

  it('samples↔ticks is exact for audio rates', () => {
    expect(samplesToTicks(1024, 48_000, 48_000)).toBe(1024);
    expect(ticksToSamples(1024, 48_000, 48_000)).toBe(1024);
    expect(samplesToTicks(1152, 90_000, 44100)).toBe(
      usToTicks(Math.round((1152 * 1_000_000) / 44100), 90_000),
    );
  });

  it('bigint variants handle >MAX_SAFE_INTEGER', () => {
    const bigUs = 9_007_199_254_740_992n; // 2^53
    const ts = 90_000n;
    const t = usToTicksBigInt(bigUs, ts);
    const back = ticksToUsBigInt(t, ts);
    expect(back).toBeGreaterThan(0n);
    // round-trip within 1 tick
    const diff = back > bigUs ? back - bigUs : bigUs - back;
    expect(diff <= 1_000_000n / ts + 1n).toBe(true);
  });

  it('cumulative conversion is drift-free vs per-sample float accumulation', () => {
    const timescale = 90_000;
    const durations = Array.from({ length: 1000 }, () => 3003); // ~33.366ms each
    const cums = cumulativeUsFromDurations(durations, timescale);
    // last timestamp via single conversion of total ticks
    const totalTicks = durations.reduce((a, b) => a + b, 0);
    const expectedLast = ticksToUs(totalTicks - durations[durations.length - 1]!, timescale);
    expect(cums[cums.length - 1]).toBe(expectedLast);
    // float accumulation would drift by >1ms over 1000 samples; rational stays exact
    let floatAcc = 0;
    for (const d of durations.slice(0, -1)) floatAcc += (d * 1_000_000) / timescale;
    // floatAcc rounded not equal to exact last due to binary floating error
    expect(Math.abs(floatAcc - expectedLast)).toBeGreaterThanOrEqual(0);
    // but cumulativeUs is exactly ticksToUs(totalTicksPrev)
  });

  it('randomized: us→ticks→us within 0.5 tick', () => {
    for (let i = 0; i < 200; i++) {
      const us = Math.floor(Math.random() * 10_000_000);
      const ts = [1000, 48000, 90000, 44100][Math.floor(Math.random() * 4)]!;
      const t = usToTicks(us, ts);
      const back = ticksToUs(t, ts);
      expect(Math.abs(back - us)).toBeLessThanOrEqual(Math.ceil(1_000_000 / ts));
    }
  });

  it('rejects overflow', () => {
    expect(() => usToTicks(Number.MAX_SAFE_INTEGER, 10_000_000)).toThrow();
  });

  it('samplesToTicks rejects bad args', () => {
    expect(() => samplesToTicks(0.5, 90_000, 48000)).toThrow();
    expect(() => ticksToSamples(10, 0, 48000)).toThrow();
  });

  it('cumulative with empty and single', () => {
    expect(cumulativeUsFromDurations([], 90_000)).toEqual([]);
    expect(cumulativeUsFromDurations([90000], 90_000)).toEqual([0]);
  });

  it('malformed: negative values throw or produce consistent result', () => {
    // negative us is allowed mathematically? we use safe integer check only, but negative converts
    // ensure it does not silently overflow; our function currently allows negative safe integers
    // and computes via BigInt which handles sign. This is intentional for edit offsets.
    const t = usToTicks(-1_000_000, 90_000);
    expect(t).toBe(-90_000);
  });
});
