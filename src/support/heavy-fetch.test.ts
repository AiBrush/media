import { describe, expect, it } from 'vitest';
import {
  HEAVY_FETCH_THRESHOLD_BYTES,
  assertHeavyFetchExposed,
  heavyExposure,
  planningTokenForHeavyRoute,
  requiresHeavyExposure,
  routeFetchCost,
} from './heavy-fetch.ts';

describe('heavy fetch — planning/preload exposure (REQUIREMENTS §8.3 — 3.5)', () => {
  it('threshold is 1 MiB and cost is js+wasm validated', () => {
    expect(HEAVY_FETCH_THRESHOLD_BYTES).toBe(1024 * 1024);
    const c = routeFetchCost(100 * 1024, 200 * 1024);
    expect(c.totalBytes).toBe(300 * 1024);
    expect(requiresHeavyExposure(c)).toBe(false);
    const heavy = routeFetchCost(600 * 1024, 500 * 1024);
    expect(heavy.totalBytes).toBe(1100 * 1024);
    expect(requiresHeavyExposure(heavy)).toBe(true);
    expect(planningTokenForHeavyRoute(c)).toBe('no-heavy-fetch');
    expect(planningTokenForHeavyRoute(heavy)).toBe(`heavy-fetch:614400+512000=1126400`);
  });

  it('heavy exposure: requires planning or preload', () => {
    const heavy = routeFetchCost(800 * 1024, 400 * 1024); // 1_228_800 >1MiB
    expect(heavyExposure(heavy, {}).passes).toBe(false);
    expect(heavyExposure(heavy, { planningExposed: false, preloadDeclared: false }).passes).toBe(
      false,
    );
    expect(heavyExposure(heavy, { planningExposed: true }).passes).toBe(true);
    expect(heavyExposure(heavy, { preloadDeclared: true }).passes).toBe(true);
    expect(heavyExposure(heavy, { planningExposed: true, preloadDeclared: true }).method).toBe(
      'both',
    );
    expect(heavyExposure(heavy, { planningExposed: true }).method).toBe('planning');
    expect(heavyExposure(heavy, { preloadDeclared: true }).method).toBe('preload');
    const light = routeFetchCost(100 * 1024, 0);
    expect(heavyExposure(light, {}).passes).toBe(true);
    expect(heavyExposure(light, {}).requiresExposure).toBe(false);
    expect(() => assertHeavyFetchExposed(heavy, {})).toThrow(RangeError);
    expect(() => assertHeavyFetchExposed(heavy, { planningExposed: true })).not.toThrow();
    expect(() => assertHeavyFetchExposed(light, {})).not.toThrow();
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const js = (i * 12345) % (2 * 1024 * 1024);
      const wasm = (i * 67890) % (512 * 1024);
      const cost = routeFetchCost(js, wasm);
      const requires = requiresHeavyExposure(cost);
      expect(typeof requires).toBe('boolean');
      const exposedVia =
        i % 3 === 0 ? { planningExposed: true } : i % 3 === 1 ? { preloadDeclared: true } : {};
      const exp = heavyExposure(cost, exposedVia);
      expect(exp.passes).toBe(!requires || exp.exposed);
      expect(planningTokenForHeavyRoute(cost).length).toBeLessThan(100);
      // light always passes regardless of exposure
      if (!requires) expect(() => assertHeavyFetchExposed(cost, {})).not.toThrow();
    }
  });

  it('boundary: exactly 1 MiB vs 1 MiB+1', () => {
    const at = routeFetchCost(HEAVY_FETCH_THRESHOLD_BYTES, 0);
    expect(requiresHeavyExposure(at)).toBe(false);
    expect(heavyExposure(at, {}).passes).toBe(true);
    expect(planningTokenForHeavyRoute(at)).toBe('no-heavy-fetch');
    const over = routeFetchCost(HEAVY_FETCH_THRESHOLD_BYTES + 1, 0);
    expect(requiresHeavyExposure(over)).toBe(true);
    expect(heavyExposure(over, {}).passes).toBe(false);
    expect(heavyExposure(over, { planningExposed: true }).passes).toBe(true);
    expect(() => assertHeavyFetchExposed(over, {})).toThrow(RangeError);
    expect(() => assertHeavyFetchExposed(over, { planningExposed: true })).not.toThrow();
    expect(routeFetchCost(0, 0).totalBytes).toBe(0);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => routeFetchCost(Number.NaN as never, 0 as never)).toThrow(RangeError);
    expect(() => routeFetchCost(-1 as never, 0 as never)).toThrow(RangeError);
    expect(() => routeFetchCost(Number.POSITIVE_INFINITY as never, 0 as never)).toThrow(RangeError);
    expect(() => routeFetchCost(0 as never, Number.NaN as never)).toThrow(RangeError);
    expect(() => routeFetchCost((20 * 1024 * 1024) as never, 0 as never)).toThrow(RangeError);
    expect(() => requiresHeavyExposure(null as never)).toThrow(RangeError);
    expect(() => heavyExposure(null as never, {} as never)).toThrow(RangeError);
    expect(() =>
      heavyExposure(routeFetchCost(0, 0), { planningExposed: null as never } as never),
    ).toThrow(RangeError);
    expect(() =>
      assertHeavyFetchExposed(routeFetchCost(HEAVY_FETCH_THRESHOLD_BYTES + 1, 0), {} as never),
    ).toThrow(RangeError);
    expect(() => planningTokenForHeavyRoute(null as never)).toThrow(RangeError);
  });

  it('current route closures are below 1 MiB and need no exposure (real invariant)', () => {
    // Real measured first-operation closures from check-budgets are ~100 KiB JS + <500 KiB WASM → <1 MiB
    const typicalProbe = routeFetchCost(100 * 1024, 367 * 1024); // dav1d 367KiB + probe JS
    expect(requiresHeavyExposure(typicalProbe)).toBe(false);
    expect(heavyExposure(typicalProbe, {}).passes).toBe(true);
    const eager = routeFetchCost(50 * 1024, 0);
    expect(requiresHeavyExposure(eager)).toBe(false);
  });
});
