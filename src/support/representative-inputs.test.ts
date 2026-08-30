import { describe, expect, it } from 'vitest';
import {
  REPRESENTATIVE_INPUTS,
  assertAllCategoriesCovered,
  e2eTakesPrecedenceOverMicro,
  isRepresentativeCategory,
  isValidRepresentativeInput,
  representativeInputForCategory,
} from './representative-inputs.ts';

describe('representative inputs — tiny/short/long/4K/HFR/multitrack/high-latency-range (REQUIREMENTS §8.2 — 3.7)', () => {
  it('all 7 categories present and distinct', () => {
    expect(REPRESENTATIVE_INPUTS.length).toBe(7);
    const cats = REPRESENTATIVE_INPUTS.map((r) => r.category);
    expect(new Set(cats).size).toBe(7);
    expect(cats).toEqual([
      'tiny',
      'short',
      'long',
      '4K',
      'HFR',
      'multitrack',
      'high-latency-range',
    ]);
    for (const r of REPRESENTATIVE_INPUTS) {
      expect(isRepresentativeCategory(r.category)).toBe(true);
      expect(isValidRepresentativeInput(r)).toBe(true);
    }
    // spot checks
    expect(representativeInputForCategory('tiny').width).toBe(640);
    expect(representativeInputForCategory('4K').width).toBe(3840);
    expect(representativeInputForCategory('HFR').fps).toBe(60);
    expect(representativeInputForCategory('multitrack').trackCount).toBe(3);
    expect(representativeInputForCategory('high-latency-range').rangeBacked).toBe(true);
    expect(representativeInputForCategory('high-latency-range').latencyMs).toBe(250);
    expect(representativeInputForCategory('long').durationSec).toBe(600);
  });

  it('coverage assert passes when all 7 covered, fails when missing', () => {
    expect(() => assertAllCategoriesCovered([...REPRESENTATIVE_INPUTS])).not.toThrow();
    const missing = REPRESENTATIVE_INPUTS.filter((r) => r.category !== '4K');
    expect(() => assertAllCategoriesCovered(missing)).toThrow(RangeError);
    expect(() => assertAllCategoriesCovered([])).toThrow(RangeError);
  });

  it('micro vs E2E precedence: micro win must not override E2E regression', () => {
    // micro faster 0.9 but E2E slower 1.10 -> micro must not win
    expect(e2eTakesPrecedenceOverMicro(0.9, 1.1)).toBe(false);
    // micro faster but E2E within 5% -> ok
    expect(e2eTakesPrecedenceOverMicro(0.9, 1.03)).toBe(true);
    // both at parity -> ok
    expect(e2eTakesPrecedenceOverMicro(1, 1)).toBe(true);
    // E2E faster -> ok regardless of micro
    expect(e2eTakesPrecedenceOverMicro(1.05, 0.95)).toBe(true);
    // E2E slower beyond 5% even without micro win -> fails
    expect(e2eTakesPrecedenceOverMicro(1, 1.06)).toBe(false);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const cat = REPRESENTATIVE_INPUTS[i % REPRESENTATIVE_INPUTS.length]!.category;
      const rep = representativeInputForCategory(cat);
      expect(isValidRepresentativeInput(rep)).toBe(true);
      expect(isRepresentativeCategory(cat)).toBe(true);
      const micro = 0.9 + (i % 5) * 0.05; // 0.9..1.1
      const e2e = 0.95 + (i % 4) * 0.05;
      expect(typeof e2eTakesPrecedenceOverMicro(micro, e2e)).toBe('boolean');
      // coverage with shuffled order still passes
      const shuffled = [...REPRESENTATIVE_INPUTS].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(() => assertAllCategoriesCovered(shuffled)).not.toThrow();
    }
  });

  it('boundary: tiny vs 4K vs HFR vs multitrack vs high-latency', () => {
    expect(representativeInputForCategory('tiny').height).toBe(360);
    expect(representativeInputForCategory('long').height).toBe(1080);
    expect(representativeInputForCategory('high-latency-range').latencyMs).toBeGreaterThan(200);
    expect(isRepresentativeCategory('4K')).toBe(true);
    expect(isRepresentativeCategory('unknown')).toBe(false);
    expect(
      isValidRepresentativeInput({
        category: 'tiny',
        width: 0,
        height: 360,
        durationSec: 2,
        fps: 30,
        trackCount: 1,
        latencyMs: 10,
        rangeBacked: false,
      }),
    ).toBe(false);
    expect(
      isValidRepresentativeInput({
        category: 'tiny',
        width: 640,
        height: 360,
        durationSec: 2,
        fps: 30,
        trackCount: 1,
        latencyMs: 10,
        rangeBacked: false,
      }),
    ).toBe(true);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isRepresentativeCategory(null as never)).toThrow(RangeError);
    expect(() => isRepresentativeCategory('x'.repeat(100) as never)).toThrow(RangeError);
    expect(() => representativeInputForCategory('unknown' as never)).toThrow(RangeError);
    expect(() => representativeInputForCategory(null as never)).toThrow(RangeError);
    expect(() => assertAllCategoriesCovered(null as never)).toThrow(RangeError);
    expect(() => assertAllCategoriesCovered([null as never])).toThrow(RangeError);
    expect(() =>
      assertAllCategoriesCovered([
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
        ...REPRESENTATIVE_INPUTS,
      ] as never),
    ).toThrow(RangeError);
    expect(() => e2eTakesPrecedenceOverMicro(Number.NaN as never, 1 as never)).toThrow(RangeError);
    expect(() =>
      e2eTakesPrecedenceOverMicro(1 as never, Number.POSITIVE_INFINITY as never),
    ).toThrow(RangeError);
    expect(() => e2eTakesPrecedenceOverMicro(-1 as never, 1 as never)).toThrow(RangeError);
    expect(isValidRepresentativeInput(null)).toBe(false);
    expect(isValidRepresentativeInput({})).toBe(false);
  });
});
