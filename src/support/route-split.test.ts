import { describe, expect, it } from 'vitest';
import {
  EAGER_BUDGET_BYTES,
  HEAVY_FETCH_THRESHOLD_BYTES,
  TREE_SHAKEABLE_ENTRYPOINTS,
  TYPICAL_ROUTE_BUDGET_BYTES,
  assertEagerBudget,
  assertRouteBudget,
  dedupSavingPercent,
  heavyFetchExposed,
  isTreeShakeableEntrypoint,
} from './route-split.ts';

describe('route split / dedup + tree-shakable entrypoints (REQUIREMENTS §8.3 — 3.4)', () => {
  it('budgets are 50 KiB eager + 250 KiB typical + 1 MiB heavy threshold', () => {
    expect(EAGER_BUDGET_BYTES).toBe(50 * 1024);
    expect(TYPICAL_ROUTE_BUDGET_BYTES).toBe(250 * 1024);
    expect(HEAVY_FETCH_THRESHOLD_BYTES).toBe(1024 * 1024);
    expect(() => assertEagerBudget(49 * 1024)).not.toThrow();
    expect(() => assertRouteBudget(100 * 1024)).not.toThrow();
    expect(() => assertRouteBudget(100 * 1024, TYPICAL_ROUTE_BUDGET_BYTES)).not.toThrow();
  });

  it('tree-shakeable entrypoints: all declared + independent', () => {
    expect(TREE_SHAKEABLE_ENTRYPOINTS.length).toBe(17);
    for (const e of TREE_SHAKEABLE_ENTRYPOINTS) expect(isTreeShakeableEntrypoint(e)).toBe(true);
    expect(isTreeShakeableEntrypoint('index.js')).toBe(true);
    expect(isTreeShakeableEntrypoint('./drivers/mp4')).toBe(true);
    expect(isTreeShakeableEntrypoint('./drivers/mp4.js')).toBe(true);
    expect(isTreeShakeableEntrypoint('drivers/unknown')).toBe(false);
    expect(isTreeShakeableEntrypoint('src/index.ts')).toBe(false);
  });

  it('dedup saving: shared chunk is union not sum', () => {
    const a = ['index.js', 'chunk-A.js', 'chunk-shared.js'];
    const b = ['drivers/mp4.js', 'chunk-B.js', 'chunk-shared.js'];
    const saving = dedupSavingPercent([a, b]);
    // total 6, union 5 => saving 1 - 5/6 = 0.166...
    expect(saving).toBeCloseTo(1 - 5 / 6, 5);
    expect(dedupSavingPercent([a])).toBe(0);
    expect(dedupSavingPercent([])).toBe(0);
    expect(dedupSavingPercent([[], []])).toBe(0);
    // fully shared
    expect(dedupSavingPercent([['x.js'], ['x.js']])).toBeCloseTo(0.5, 5);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const n = (i % 5) + 1;
      const closures: string[][] = [];
      for (let j = 0; j < n; j++) {
        const files: string[] = [];
        for (let k = 0; k < 3; k++) files.push(`chunk-${(i * 7 + j * 3 + k) % 10}.js`);
        closures.push(files);
      }
      const saving = dedupSavingPercent(closures);
      expect(saving).toBeGreaterThanOrEqual(0);
      expect(saving).toBeLessThan(1);
      const bytes = 40 * 1024 + ((i * 1234) % (200 * 1024));
      expect(() => assertRouteBudget(bytes)).not.toThrow();
      expect(
        isTreeShakeableEntrypoint(
          TREE_SHAKEABLE_ENTRYPOINTS[i % TREE_SHAKEABLE_ENTRYPOINTS.length]!,
        ),
      ).toBe(true);
      expect(heavyFetchExposed(500 * 1024, false)).toBe(true);
      expect(heavyFetchExposed(2 * 1024 * 1024, i % 2 === 0)).toBe(i % 2 === 0);
    }
  });

  it('boundary: empty/ single / exact budget / over budget', () => {
    expect(dedupSavingPercent([])).toBe(0);
    expect(dedupSavingPercent([['a.js']])).toBe(0);
    expect(() => assertEagerBudget(EAGER_BUDGET_BYTES)).not.toThrow();
    expect(() => assertRouteBudget(TYPICAL_ROUTE_BUDGET_BYTES)).not.toThrow();
    expect(() => assertRouteBudget(TYPICAL_ROUTE_BUDGET_BYTES + 1)).toThrow(RangeError);
    expect(() => assertEagerBudget(EAGER_BUDGET_BYTES + 1)).toThrow(RangeError);
    expect(isTreeShakeableEntrypoint('')).toBe(false);
    expect(heavyFetchExposed(HEAVY_FETCH_THRESHOLD_BYTES, false)).toBe(true);
    expect(heavyFetchExposed(HEAVY_FETCH_THRESHOLD_BYTES + 1, false)).toBe(false);
    expect(heavyFetchExposed(HEAVY_FETCH_THRESHOLD_BYTES + 1, true)).toBe(true);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isTreeShakeableEntrypoint(null as never)).toThrow(RangeError);
    expect(() => isTreeShakeableEntrypoint(123 as never)).toThrow(RangeError);
    expect(() => isTreeShakeableEntrypoint('x'.repeat(300) as never)).toThrow(RangeError);
    expect(() => assertRouteBudget(Number.NaN as never)).toThrow(RangeError);
    expect(() => assertRouteBudget(-1 as never)).toThrow(RangeError);
    expect(() => assertRouteBudget(Number.POSITIVE_INFINITY as never)).toThrow(RangeError);
    expect(() => assertRouteBudget(10, 0 as never)).toThrow(RangeError);
    expect(() => dedupSavingPercent(null as never)).toThrow(RangeError);
    expect(() => dedupSavingPercent([null as never])).toThrow(RangeError);
    expect(() => dedupSavingPercent([['a'.repeat(501)]] as never)).toThrow(RangeError);
    expect(() => heavyFetchExposed(Number.NaN as never, true as never)).toThrow(RangeError);
    expect(() => heavyFetchExposed(100 as never, null as never)).toThrow(RangeError);
  });
});
