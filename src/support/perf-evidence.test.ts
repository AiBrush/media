import { describe, expect, it } from 'vitest';
import { coldWarmEvidence, timingEvidence } from './perf-evidence.ts';

describe('perf evidence — cold/warm, p95, dispersion, throughput (REQUIREMENTS §8.2 — 0.2)', () => {
  it('computes median, p95, dispersion, and throughput for 30 samples', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      durationMs: 10 + i,
      bytesIn: 1000,
      bytesOut: 2000,
    }));
    const ev = timingEvidence(samples);
    expect(ev.count).toBe(30);
    expect(ev.medianMs).toBe(24); // sorted 10..39, median ceil(0.5*30)=15th → 10+14=24
    expect(ev.p95Ms).toBe(38); // ceil(0.95*30)=29th → 10+28=38
    expect(ev.dispersion).toBeCloseTo((38 - 24) / 24, 6);
    expect(ev.throughput?.inBytesPerSec).toBeCloseTo(30_000 / (735 / 1000), 0);
    expect(ev.minMs).toBe(10);
    expect(ev.maxMs).toBe(39);
  });

  it('cold is first sample, warm is rest (31 total)', () => {
    const samples = Array.from({ length: 31 }, (_, i) => ({ durationMs: i === 0 ? 100 : 10 }));
    const { cold, warm } = coldWarmEvidence(samples);
    expect(cold.count).toBe(1);
    expect(cold.medianMs).toBe(100);
    expect(warm.count).toBe(30);
    expect(warm.medianMs).toBe(10);
  });

  it('requires 30 samples by default, 1 when explicitly relaxed', () => {
    expect(() => timingEvidence([{ durationMs: 10 }])).toThrow(/at least 30 samples/);
    expect(timingEvidence([{ durationMs: 10 }], { require30: false }).count).toBe(1);
    expect(() => timingEvidence([] as never, { require30: false })).toThrow(/at least one sample/);
  });

  it('20× randomized remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const n = 30 + (i % 5);
      const samples = Array.from({ length: n }, () => ({ durationMs: 5 + Math.random() * 10 }));
      const ev = timingEvidence(samples);
      expect(ev.count).toBe(n);
      expect(ev.medianMs).toBeGreaterThanOrEqual(5);
      expect(ev.p95Ms).toBeGreaterThanOrEqual(ev.medianMs);
      expect(ev.dispersion).toBeGreaterThanOrEqual(0);
    }
  });

  it('boundary: constant durations → dispersion 0, zero median → dispersion 0', () => {
    const constant = timingEvidence(
      Array.from({ length: 30 }, () => ({ durationMs: 10 })),
      { require30: true },
    );
    expect(constant.dispersion).toBe(0);
    expect(constant.stdevMs).toBe(0);
    const zero = timingEvidence(
      Array.from({ length: 30 }, () => ({ durationMs: 0 })),
      { require30: true },
    );
    expect(zero.dispersion).toBe(0);
  });

  it('malformed inputs throw typed RangeError, never huge-alloc', () => {
    expect(() =>
      timingEvidence([{ durationMs: Number.NaN } as never], { require30: false }),
    ).toThrow(RangeError);
    expect(() => timingEvidence([{ durationMs: -1 } as never], { require30: false })).toThrow(
      RangeError,
    );
    expect(() =>
      timingEvidence([{ durationMs: Number.POSITIVE_INFINITY } as never], { require30: false }),
    ).toThrow(RangeError);
    expect(() => coldWarmEvidence(Array.from({ length: 30 }, () => ({ durationMs: 10 })))).toThrow(
      /at least 31 samples/,
    );
  });
});
