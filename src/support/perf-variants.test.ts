import { describe, expect, it } from 'vitest';
import type { TimingSample } from './perf-evidence.ts';
import {
  assertBothVariantsReported,
  assertColdWarmSeparate,
  hardwareSoftwareColdWarm,
  hardwareSoftwareTiming,
  isHardwareSoftwareVariant,
} from './perf-variants.ts';

function samples(n: number, baseMs: number): TimingSample[] {
  return Array.from({ length: n }, (_, i) => ({
    durationMs: baseMs + (i % 5),
    bytesIn: 1000,
    bytesOut: 800,
  }));
}

describe('cold vs warm + hardware vs software reported separately (REQUIREMENTS §8.2 — 3.8)', () => {
  it('hardware and software each have cold/warm separated', () => {
    const hw = hardwareSoftwareColdWarm(samples(31, 100), samples(31, 10));
    expect(hw.hardware.cold.medianMs).toBe(100);
    expect(hw.hardware.warm.medianMs).toBeGreaterThanOrEqual(10);
    expect(hw.software.cold.medianMs).toBe(10);
    expect(hw.software.warm.medianMs).toBeGreaterThanOrEqual(10);
    expect(() => assertBothVariantsReported(hw)).not.toThrow();
    expect(() => assertColdWarmSeparate(hw.hardware)).not.toThrow();
    expect(() => assertColdWarmSeparate(hw.software)).not.toThrow();
    expect(isHardwareSoftwareVariant('hardware')).toBe(true);
    expect(isHardwareSoftwareVariant('software')).toBe(true);
  });

  it('hardware/software timing without cold split (30 each)', () => {
    const both = hardwareSoftwareTiming(samples(30, 20), samples(30, 30));
    expect(both.hardware.medianMs).toBeLessThan(both.software.medianMs);
    expect(() => assertBothVariantsReported(both)).not.toThrow();
  });

  it('asserts when variant or cold/warm missing', () => {
    const hw = hardwareSoftwareColdWarm(samples(31, 100), samples(31, 10));
    expect(() => assertBothVariantsReported({ hardware: hw.hardware } as never)).toThrow(
      RangeError,
    );
    expect(() => assertBothVariantsReported(null as never)).toThrow(RangeError);
    expect(() => assertColdWarmSeparate({ cold: hw.hardware.cold } as never)).toThrow(RangeError);
    expect(() => assertColdWarmSeparate(null as never)).toThrow(RangeError);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const hw = samples(31, 50 + (i % 7));
      const sw = samples(31, 30 + (i % 5));
      const report = hardwareSoftwareColdWarm(hw, sw);
      expect(report.hardware.cold.count).toBe(1);
      expect(report.hardware.warm.count).toBe(30);
      expect(report.software.cold.count).toBe(1);
      expect(report.software.warm.count).toBe(30);
      expect(() => assertBothVariantsReported(report)).not.toThrow();
      expect(isHardwareSoftwareVariant(i % 2 === 0 ? 'hardware' : 'software')).toBe(true);
    }
  });

  it('boundary: exactly 31 samples per variant (1 cold +30 warm)', () => {
    const hw = samples(31, 100);
    const sw = samples(31, 10);
    const r = hardwareSoftwareColdWarm(hw, sw);
    expect(r.hardware.cold.count).toBe(1);
    expect(r.hardware.warm.count).toBe(30);
    expect(() => hardwareSoftwareColdWarm(samples(30, 10) as never, sw)).toThrow(RangeError); // <31
    expect(isHardwareSoftwareVariant('')).toBe(false);
    expect(isHardwareSoftwareVariant('unknown')).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isHardwareSoftwareVariant(null as never)).toThrow(RangeError);
    expect(() => isHardwareSoftwareVariant('x'.repeat(30) as never)).toThrow(RangeError);
    expect(() => hardwareSoftwareColdWarm(null as never, samples(31, 10) as never)).toThrow(
      RangeError,
    );
    expect(() => hardwareSoftwareColdWarm(samples(31, 10) as never, null as never)).toThrow(
      RangeError,
    );
    expect(() =>
      hardwareSoftwareColdWarm(
        Array.from({ length: 10001 }, () => ({ durationMs: 10 })) as never,
        samples(31, 10) as never,
      ),
    ).toThrow(RangeError);
    expect(() => hardwareSoftwareTiming(null as never, samples(30, 10) as never)).toThrow(
      RangeError,
    );
    expect(() => assertBothVariantsReported({} as never)).toThrow(RangeError);
    expect(() => assertColdWarmSeparate({} as never)).toThrow(RangeError);
  });
});
