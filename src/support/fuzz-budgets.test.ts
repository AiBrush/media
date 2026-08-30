import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUZZ_BUDGET,
  ERROR_CLASS_CODES,
  assertFuzzBudget,
  assertFuzzWithinBudgets,
  errorClassForCode,
  fuzzWithinBudgets,
  isErrorClass,
  isValidFuzzBudget,
} from './fuzz-budgets.ts';

describe('fuzz budgets + stable error taxonomy — 4.4', () => {
  it('default budgets and 6 error classes distinct', () => {
    expect(DEFAULT_FUZZ_BUDGET.maxBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_FUZZ_BUDGET.maxAllocBytes).toBe(64 * 1024 * 1024);
    expect(DEFAULT_FUZZ_BUDGET.maxRecursion).toBe(100);
    expect(DEFAULT_FUZZ_BUDGET.maxTimeMs).toBe(5000);
    expect(Object.keys(ERROR_CLASS_CODES).length).toBe(6);
    expect(isErrorClass('malformed')).toBe(true);
    expect(isErrorClass('resource-exhaustion')).toBe(true);
    expect(isErrorClass('unknown')).toBe(false);
    expect(errorClassForCode('demux-error: budget exceeded')).toBe('malformed');
    expect(errorClassForCode('resource-exhaustion')).toBe('resource-exhaustion');
    expect(errorClassForCode('capability-miss')).toBe('capability-miss');
    expect(() => assertFuzzBudget(DEFAULT_FUZZ_BUDGET)).not.toThrow();
    expect(isValidFuzzBudget(DEFAULT_FUZZ_BUDGET)).toBe(true);
  });

  it('fuzz within budgets passes, over budget fails', () => {
    expect(fuzzWithinBudgets({ bytes: 1024, allocBytes: 1024, recursion: 10, timeMs: 100 })).toBe(
      true,
    );
    expect(() =>
      assertFuzzWithinBudgets({ bytes: 1024, allocBytes: 1024, recursion: 10, timeMs: 100 }),
    ).not.toThrow();
    expect(
      fuzzWithinBudgets({ bytes: 20 * 1024 * 1024, allocBytes: 1024, recursion: 10, timeMs: 100 }),
    ).toBe(false);
    expect(() =>
      assertFuzzWithinBudgets({
        bytes: 20 * 1024 * 1024,
        allocBytes: 1024,
        recursion: 10,
        timeMs: 100,
      }),
    ).toThrow(RangeError);
    expect(fuzzWithinBudgets({ bytes: 1024, allocBytes: 1024, recursion: 200, timeMs: 100 })).toBe(
      false,
    );
    expect(fuzzWithinBudgets({ bytes: 1024, allocBytes: 1024, recursion: 10, timeMs: 10000 })).toBe(
      false,
    );
  });

  it('error taxonomy stable: 6 classes distinct, no overlap in sample codes', () => {
    const allCodes = Object.values(ERROR_CLASS_CODES).flat();
    expect(new Set(allCodes).size).toBe(allCodes.length);
    expect(errorClassForCode('InputError: invalid request')).toBe('invalid-request');
    expect(errorClassForCode('internal-error')).toBe('internal');
    expect(errorClassForCode('browser-error')).toBe('browser-failure');
    expect(errorClassForCode('unknown-code-xyz')).toBeUndefined();
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const used = {
        bytes: (i * 1000) % (5 * 1024 * 1024),
        allocBytes: (i * 2000) % (30 * 1024 * 1024),
        recursion: (i % 50) + 1,
        timeMs: (i * 100) % 4000,
      };
      expect(typeof fuzzWithinBudgets(used)).toBe('boolean');
      expect(isErrorClass(Object.keys(ERROR_CLASS_CODES)[i % 6]!)).toBe(true);
      expect(typeof errorClassForCode('demux-error')).toBe('string');
    }
  });

  it('boundary: exactly at budget passes, +1 fails', () => {
    expect(
      fuzzWithinBudgets({
        bytes: DEFAULT_FUZZ_BUDGET.maxBytes,
        allocBytes: DEFAULT_FUZZ_BUDGET.maxAllocBytes,
        recursion: DEFAULT_FUZZ_BUDGET.maxRecursion,
        timeMs: DEFAULT_FUZZ_BUDGET.maxTimeMs,
      }),
    ).toBe(true);
    expect(
      fuzzWithinBudgets({
        bytes: DEFAULT_FUZZ_BUDGET.maxBytes + 1,
        allocBytes: 1024,
        recursion: 10,
        timeMs: 100,
      }),
    ).toBe(false);
    expect(
      isValidFuzzBudget({
        maxBytes: 0,
        maxAllocBytes: 64 * 1024 * 1024,
        maxRecursion: 100,
        maxTimeMs: 5000,
      } as never),
    ).toBe(false);
    expect(isValidFuzzBudget(DEFAULT_FUZZ_BUDGET)).toBe(true);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isErrorClass(null as never)).toThrow(RangeError);
    expect(() => isErrorClass('x'.repeat(50) as never)).toThrow(RangeError);
    expect(() => errorClassForCode(null as never)).toThrow(RangeError);
    expect(() => errorClassForCode('x'.repeat(100) as never)).toThrow(RangeError);
    expect(() => assertFuzzBudget(null as never)).toThrow(RangeError);
    expect(() => assertFuzzBudget({} as never)).toThrow(RangeError);
    expect(() => fuzzWithinBudgets(null as never)).toThrow(RangeError);
    expect(() =>
      fuzzWithinBudgets({
        bytes: Number.NaN as never,
        allocBytes: 0 as never,
        recursion: 0 as never,
        timeMs: 0 as never,
      }),
    ).toThrow(RangeError);
    expect(() =>
      assertFuzzWithinBudgets(
        { bytes: 1024, allocBytes: 1024, recursion: 10, timeMs: 100 },
        null as never,
      ),
    ).toThrow(RangeError);
  });
});
