import { describe, expect, it } from 'vitest';
import { HOLISTIC_REQUIRED, assertHolisticPasses, currentHolisticStatus, holisticPasses, isHolisticGates, minimalHolisticPass } from './holistic-sota.ts';

describe('holistic SOTA gate — final eligibility', () => {
  it('requires 12 gates all true', () => {
    expect(HOLISTIC_REQUIRED.length).toBe(12);
    const gates = minimalHolisticPass();
    expect(isHolisticGates(gates)).toBe(true);
    expect(holisticPasses(gates)).toBe(true);
    expect(() => assertHolisticPasses(gates)).not.toThrow();
  });

  it('fails when fullCorpus or cleanCheckout false', () => {
    expect(holisticPasses(currentHolisticStatus({ fullCorpusZeroFailError: false }))).toBe(false);
    expect(holisticPasses(currentHolisticStatus({ cleanCheckout: false }))).toBe(false);
    expect(() => assertHolisticPasses(currentHolisticStatus({ fullCorpusZeroFailError: false }))).toThrow(RangeError);
    expect(() => assertHolisticPasses(currentHolisticStatus({ cleanCheckout: false }))).toThrow(RangeError);
  });

  it('each gate individually gates holistic', () => {
    const base = minimalHolisticPass();
    for (const k of HOLISTIC_REQUIRED) {
      const oneFail = { ...base, [k]: false } as never;
      expect(holisticPasses(oneFail)).toBe(false);
      expect(() => assertHolisticPasses(oneFail)).toThrow(RangeError);
    }
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const gates = minimalHolisticPass();
      expect(holisticPasses(gates)).toBe(true);
      const withFail = currentHolisticStatus({ correctnessZeroFailError: i % 7 === 0 ? false : true });
      expect(typeof holisticPasses(withFail)).toBe('boolean');
    }
  });

  it('boundary: all true passes, one false fails, all false fails', () => {
    expect(holisticPasses(minimalHolisticPass())).toBe(true);
    expect(holisticPasses(currentHolisticStatus({ bundlePass: false }))).toBe(false);
    const allFalse = Object.fromEntries(HOLISTIC_REQUIRED.map((k) => [k, false])) as unknown as never;
    expect(holisticPasses(allFalse as never)).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(isHolisticGates(null)).toBe(false);
    expect(() => holisticPasses(null as never)).toThrow(RangeError);
    expect(() => assertHolisticPasses(null as never)).toThrow(RangeError);
    expect(() => holisticPasses({} as never)).toThrow(RangeError);
    expect(() => holisticPasses({ ...minimalHolisticPass(), bundlePass: 'true' as never } as never)).toThrow(RangeError);
  });
});
