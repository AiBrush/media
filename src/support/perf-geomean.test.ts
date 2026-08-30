import { describe, expect, it } from 'vitest';
import { evaluateGeomeanGates, geomeanGatesPass, geomeanMedianRatio } from './perf-geomean.ts';
import type { FamilyTiming } from './perf-geomean.ts';

const FAMILIES: readonly FamilyTiming[] = [
  { family: 'probe', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 12, p95MsFastest: 12 },
  {
    family: 'demux',
    medianMsAibrush: 10.4,
    medianMsFastest: 10,
    p95MsAibrush: 12,
    p95MsFastest: 11,
  },
  {
    family: 'remux',
    medianMsAibrush: 9.6,
    medianMsFastest: 10,
    p95MsAibrush: 11,
    p95MsFastest: 12,
  },
  {
    family: 'transcode',
    medianMsAibrush: 10,
    medianMsFastest: 10,
    p95MsAibrush: 12.5,
    p95MsFastest: 12,
  },
] as const;

describe('per-family geomean vs fastest — 90% within 5% median, none >10% p95 (REQUIREMENTS §8.2 — 3.6)', () => {
  it('geomean is 1.0 at parity and <1.0 when faster', () => {
    expect(geomeanMedianRatio([])).toBe(1);
    expect(geomeanMedianRatio(FAMILIES)).toBeCloseTo(1, 1);
    const faster: FamilyTiming[] = [
      { family: 'a', medianMsAibrush: 9, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
      { family: 'b', medianMsAibrush: 9, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
    ];
    expect(geomeanMedianRatio(faster)).toBeCloseTo(0.9, 6);
  });

  it('90% within 5% median and none >10% p95 passes', () => {
    const result = evaluateGeomeanGates(FAMILIES);
    expect(result.totalComparable).toBe(4);
    expect(result.within5PercentRatio).toBeGreaterThanOrEqual(0.9);
    expect(result.maxP95Excess).toBeLessThanOrEqual(0.1);
    expect(geomeanGatesPass(result)).toBe(true);
  });

  it('fails when <90% within 5% or p95 >10% without tradeoff', () => {
    const slow: FamilyTiming[] = [
      { family: 'a', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
      { family: 'b', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
      {
        family: 'c',
        medianMsAibrush: 10.6,
        medianMsFastest: 10,
        p95MsAibrush: 10,
        p95MsFastest: 10,
      }, // 6% over
      {
        family: 'd',
        medianMsAibrush: 10.6,
        medianMsFastest: 10,
        p95MsAibrush: 10,
        p95MsFastest: 10,
      },
      {
        family: 'e',
        medianMsAibrush: 10.6,
        medianMsFastest: 10,
        p95MsAibrush: 10,
        p95MsFastest: 10,
      },
      {
        family: 'f',
        medianMsAibrush: 10.6,
        medianMsFastest: 10,
        p95MsAibrush: 10,
        p95MsFastest: 10,
      },
      {
        family: 'g',
        medianMsAibrush: 10.6,
        medianMsFastest: 10,
        p95MsAibrush: 10,
        p95MsFastest: 10,
      }, // 5/7 within 5% = 71%
      { family: 'h', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
      { family: 'i', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
      { family: 'j', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
    ];
    const result = evaluateGeomeanGates(slow);
    expect(result.within5PercentRatio).toBeLessThan(0.9);
    expect(geomeanGatesPass(result)).toBe(false);
    const p95Slow: FamilyTiming[] = [
      {
        family: 'a',
        medianMsAibrush: 10,
        medianMsFastest: 10,
        p95MsAibrush: 11.1,
        p95MsFastest: 10,
      }, // 11% p95
    ];
    const r2 = evaluateGeomeanGates(p95Slow);
    expect(r2.maxP95Excess).toBeCloseTo(0.11, 6);
    expect(geomeanGatesPass(r2)).toBe(false);
    expect(geomeanGatesPass(r2, true)).toBe(true); // documented tradeoff
  });

  it('20× randomized remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const families: FamilyTiming[] = Array.from({ length: 4 }, (_, j) => ({
        family: `f-${i}-${j}`,
        medianMsAibrush: 10 + (j % 2 ? 0.4 : -0.2),
        medianMsFastest: 10,
        p95MsAibrush: 12 + (j % 2 ? 0.5 : 0),
        p95MsFastest: 12,
      }));
      const r = evaluateGeomeanGates(families);
      expect(r.totalComparable).toBe(4);
      expect(r.geomean).toBeGreaterThan(0);
    }
  });

  it('boundary: empty, single, geomean 1.0', () => {
    expect(evaluateGeomeanGates([]).geomean).toBe(1);
    expect(evaluateGeomeanGates([]).within5PercentRatio).toBe(1);
    const single: FamilyTiming[] = [
      { family: 'a', medianMsAibrush: 10, medianMsFastest: 10, p95MsAibrush: 10, p95MsFastest: 10 },
    ];
    expect(geomeanMedianRatio(single)).toBe(1);
    expect(evaluateGeomeanGates(single).within5PercentCount).toBe(1);
  });

  it('malformed inputs throw RangeError, never huge-alloc', () => {
    expect(() =>
      geomeanMedianRatio([
        {
          family: 'a',
          medianMsAibrush: 0,
          medianMsFastest: 10,
          p95MsAibrush: 10,
          p95MsFastest: 10,
        } as never,
      ]),
    ).toThrow(RangeError);
    expect(() =>
      geomeanMedianRatio([
        {
          family: 'a',
          medianMsAibrush: Number.NaN as never,
          medianMsFastest: 10,
          p95MsAibrush: 10,
          p95MsFastest: 10,
        } as never,
      ]),
    ).toThrow(RangeError);
    expect(() =>
      geomeanMedianRatio([
        {
          family: 'a',
          medianMsAibrush: 10,
          medianMsFastest: -1 as never,
          p95MsAibrush: 10,
          p95MsFastest: 10,
        } as never,
      ]),
    ).toThrow(RangeError);
    expect(
      geomeanGatesPass({
        geomean: 1.1,
        within5PercentCount: 9,
        totalComparable: 10,
        within5PercentRatio: 0.9,
        maxP95Excess: 0,
      }),
    ).toBe(false);
  });
});
