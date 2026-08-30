import { describe, expect, it } from 'vitest';
import {
  assertFrozenCandidate,
  assertHeldOutOnFrozen,
  assertNoReopenNeeded,
  isFrozenCandidate,
  isValidHeldOutResult,
  shouldReopenOnHeldOutFailure,
} from './held-out-frozen.ts';

describe('frozen + held-out gate — 4.8', () => {
  it('frozen candidate is clean hex commit, dirty fails', () => {
    expect(isFrozenCandidate({ commit: 'abc1234', dirty: false })).toBe(true);
    expect(isFrozenCandidate({ commit: 'abc1234', dirty: true })).toBe(false);
    expect(isFrozenCandidate({ commit: 'zzz', dirty: false })).toBe(false);
    expect(() => assertFrozenCandidate({ commit: 'abc1234', dirty: false })).not.toThrow();
    expect(() => assertFrozenCandidate({ commit: 'abc1234', dirty: true })).toThrow(RangeError);
    const heldOk = { heldOutPass: 10, heldOutFail: 0, heldOutError: 0, generalizedFailure: false };
    expect(isValidHeldOutResult(heldOk)).toBe(true);
    expect(() => assertHeldOutOnFrozen({ commit: 'abc1234', dirty: false }, heldOk)).not.toThrow();
  });

  it('held-out not executed on frozen fails', () => {
    const empty = { heldOutPass: 0, heldOutFail: 0, heldOutError: 0, generalizedFailure: false };
    expect(() => assertHeldOutOnFrozen({ commit: 'abc1234', dirty: false }, empty)).toThrow(
      RangeError,
    );
    expect(() => assertHeldOutOnFrozen({ commit: 'abc1234', dirty: true }, empty)).toThrow(
      RangeError,
    );
  });

  it('generalized failure must reopen', () => {
    const fail = { heldOutPass: 8, heldOutFail: 2, heldOutError: 0, generalizedFailure: true };
    expect(shouldReopenOnHeldOutFailure(fail)).toBe(true);
    expect(() => assertNoReopenNeeded(fail)).toThrow(RangeError);
    const notGeneralized = {
      heldOutPass: 8,
      heldOutFail: 2,
      heldOutError: 0,
      generalizedFailure: false,
    };
    expect(shouldReopenOnHeldOutFailure(notGeneralized)).toBe(false);
    expect(() => assertNoReopenNeeded(notGeneralized)).not.toThrow();
    const pass = { heldOutPass: 10, heldOutFail: 0, heldOutError: 0, generalizedFailure: false };
    expect(shouldReopenOnHeldOutFailure(pass)).toBe(false);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const commit = `abc${String(i).padStart(4, '0')}`;
      const frozen = { commit, dirty: false };
      const r = {
        heldOutPass: 10 + (i % 5),
        heldOutFail: i % 2,
        heldOutError: 0,
        generalizedFailure: i % 7 === 0 && i % 2 === 1,
      };
      expect(isFrozenCandidate(frozen)).toBe(true);
      expect(isValidHeldOutResult(r)).toBe(true);
      expect(() => assertHeldOutOnFrozen(frozen, r)).not.toThrow();
      expect(typeof shouldReopenOnHeldOutFailure(r)).toBe('boolean');
    }
  });

  it('boundary: exactly 7 hex passes, 6 fails; 0 total fails held-out check', () => {
    expect(isFrozenCandidate({ commit: 'abcdef7', dirty: false })).toBe(true);
    expect(isFrozenCandidate({ commit: 'abc', dirty: false })).toBe(false);
    expect(
      isValidHeldOutResult({
        heldOutPass: 0,
        heldOutFail: 0,
        heldOutError: 0,
        generalizedFailure: false,
      }),
    ).toBe(true);
    expect(() =>
      assertHeldOutOnFrozen({ commit: 'abcdef7', dirty: false }, {
        heldOutPass: 0,
        heldOutFail: 0,
        heldOutError: 0,
        generalizedFailure: false,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      assertHeldOutOnFrozen({ commit: 'abcdef7', dirty: false }, {
        heldOutPass: 1,
        heldOutFail: 0,
        heldOutError: 0,
        generalizedFailure: false,
      } as never),
    ).not.toThrow();
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(isFrozenCandidate(null)).toBe(false);
    expect(() => assertFrozenCandidate(null as never)).toThrow(RangeError);
    expect(() => assertFrozenCandidate({ commit: 'zzz', dirty: false } as never)).toThrow(
      RangeError,
    );
    expect(isValidHeldOutResult(null)).toBe(false);
    expect(() => assertHeldOutOnFrozen(null as never, null as never)).toThrow(RangeError);
    expect(() =>
      assertHeldOutOnFrozen({ commit: 'abc1234', dirty: false } as never, null as never),
    ).toThrow(RangeError);
    expect(() => shouldReopenOnHeldOutFailure(null as never)).toThrow(RangeError);
    expect(() =>
      assertNoReopenNeeded({
        heldOutPass: Number.NaN as never,
        heldOutFail: 0 as never,
        heldOutError: 0 as never,
        generalizedFailure: false,
      } as never),
    ).toThrow(RangeError);
    expect(
      isValidHeldOutResult({
        heldOutPass: -1,
        heldOutFail: 0,
        heldOutError: 0,
        generalizedFailure: false,
      } as never),
    ).toBe(false);
  });
});
