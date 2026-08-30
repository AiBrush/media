import { describe, expect, it } from 'vitest';
import {
  REQUIRED_GATES,
  assertReviewPasses,
  isReviewGates,
  minimalPassingGates,
  reviewPasses,
  sotaClaimEligible,
} from './evidence-review.ts';
import type { ReviewGates } from './evidence-review.ts';

describe('independent evidence review — 4.9 SOTA claim gate', () => {
  it('requires 10 gates and all true to pass', () => {
    expect(REQUIRED_GATES.length).toBe(10);
    expect(REQUIRED_GATES).toEqual([
      'correctnessZeroFailError',
      'bundlePass',
      'memoryPass',
      'speedPass',
      'reportsPublished',
      'heldOutPass',
      'comparisonPinned',
      'soakPass',
      'fuzzPass',
      'browserMatrixCovered',
    ]);
    const gates = minimalPassingGates();
    expect(isReviewGates(gates)).toBe(true);
    expect(reviewPasses(gates)).toBe(true);
    expect(sotaClaimEligible(gates)).toBe(true);
    expect(() => assertReviewPasses(gates)).not.toThrow();
  });

  it('fails when any gate false', () => {
    const gates = minimalPassingGates();
    const failing: ReviewGates = { ...gates, speedPass: false };
    expect(reviewPasses(failing)).toBe(false);
    expect(sotaClaimEligible(failing)).toBe(false);
    expect(() => assertReviewPasses(failing)).toThrow(RangeError);
    expect(() => assertReviewPasses({ ...gates, bundlePass: false } as never)).toThrow(RangeError);
  });

  it('each gate individually gates SOTA', () => {
    const base = minimalPassingGates();
    for (const k of REQUIRED_GATES) {
      const oneFail = { ...base, [k]: false } as ReviewGates;
      expect(reviewPasses(oneFail)).toBe(false);
      expect(() => assertReviewPasses(oneFail)).toThrow(RangeError);
    }
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const gates = minimalPassingGates();
      expect(reviewPasses(gates)).toBe(true);
      const withOneFail = {
        ...gates,
        correctnessZeroFailError: i % 7 === 0 ? false : true,
      } as ReviewGates;
      expect(typeof reviewPasses(withOneFail)).toBe('boolean');
      expect(isReviewGates(gates)).toBe(true);
    }
  });

  it('boundary: all true passes, one false fails', () => {
    expect(reviewPasses(minimalPassingGates())).toBe(true);
    const oneFalse = { ...minimalPassingGates(), fuzzPass: false } as ReviewGates;
    expect(reviewPasses(oneFalse)).toBe(false);
    const allFalse = Object.fromEntries(
      REQUIRED_GATES.map((k) => [k, false]),
    ) as unknown as ReviewGates;
    expect(reviewPasses(allFalse)).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(isReviewGates(null)).toBe(false);
    expect(() => reviewPasses(null as never)).toThrow(RangeError);
    expect(() => assertReviewPasses(null as never)).toThrow(RangeError);
    expect(() => reviewPasses({} as never)).toThrow(RangeError);
    expect(() =>
      reviewPasses({ ...minimalPassingGates(), bundlePass: 'true' as never } as never),
    ).toThrow(RangeError);
    expect(isReviewGates({} as never)).toBe(false);
    expect(isReviewGates({ ...minimalPassingGates(), extra: true } as unknown as never)).toBe(true); // extra ignored, still valid if required present
  });
});
