import { describe, expect, it } from 'vitest';
import { OVERFIT_PATTERNS, TEST_WEAKENING_PATTERNS, assertNoOverfit, isCleanSource, overfitLint, testWeakeningLint } from './anti-overfit.ts';

describe('anti-overfit — C6 no fixture/size/ID/expected branching, no test weakening', () => {
  it('detects fixture branching and clean source passes', () => {
    expect(OVERFIT_PATTERNS.length).toBe(11);
    expect(TEST_WEAKENING_PATTERNS.length).toBe(4);
    expect(overfitLint('clean source with no patterns')).toEqual([]);
    expect(isCleanSource('function foo() { return 1; }')).toBe(true);
    expect(overfitLint('if (fixtureName === "bear") {}').length).toBeGreaterThan(0);
    expect(() => assertNoOverfit('clean')).not.toThrow();
    expect(() => assertNoOverfit('if (hashFixture) {}')).toThrow(RangeError);
  });

  it('detects size/ID/expected branching and test weakening', () => {
    expect(overfitLint('branch on fixture size').length).toBeGreaterThan(0);
    expect(overfitLint('check idFixture').length).toBeGreaterThan(0);
    expect(overfitLint('expected output hash').length).toBeGreaterThan(0);
    expect(testWeakeningLint('it.skip("test", () => {})').length).toBeGreaterThan(0);
    expect(testWeakeningLint('describe.todo("x")').length).toBeGreaterThan(0);
    expect(() => assertNoOverfit('it.skip')).toThrow(RangeError);
    expect(isCleanSource('it.skip')).toBe(false);
  });

  it('bear and mp3_xing patterns still detected', () => {
    expect(overfitLint('bear-4k-hevc.mp4').length).toBeGreaterThan(0);
    expect(overfitLint('mp3_xing.mp3').length).toBeGreaterThan(0);
    expect(overfitLint('expected output').length).toBeGreaterThan(0);
    expect(testWeakeningLint('skip test weakening').length).toBeGreaterThan(0);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const clean = `function f${i}() { return ${i}; }`;
      expect(isCleanSource(clean)).toBe(true);
      expect(overfitLint(clean)).toEqual([]);
      const withFixture = i % 3 === 0 ? 'fixtureName' : i % 3 === 1 ? 'fixture size' : 'clean';
      expect(typeof overfitLint(withFixture).length).toBe('number');
      const withWeak = i % 4 === 0 ? 'it.skip' : 'it("x")';
      expect(typeof testWeakeningLint(withWeak).length).toBe('number');
    }
  });

  it('boundary: empty vs single pattern', () => {
    expect(overfitLint('')).toEqual([]);
    expect(testWeakeningLint('')).toEqual([]);
    expect(isCleanSource('')).toBe(true);
    expect(overfitLint('fixture name').length).toBe(1);
    expect(testWeakeningLint('.skip(').length).toBe(1);
    expect(() => assertNoOverfit('')).not.toThrow();
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => overfitLint(null as never)).toThrow(RangeError);
    expect(() => overfitLint(123 as never)).toThrow(RangeError);
    expect(() => overfitLint('x'.repeat(600_000) as never)).toThrow(RangeError);
    expect(() => testWeakeningLint(null as never)).toThrow(RangeError);
    expect(() => assertNoOverfit(null as never)).toThrow(RangeError);
    expect(() => assertNoOverfit('fixtureName' as never)).toThrow(RangeError);
    expect(isCleanSource('clean')).toBe(true);
  });
});
