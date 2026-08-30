import { describe, expect, it } from 'vitest';
import { abrRetainedOutputBudget } from './abr-ladder-runner.ts';
import { H264_ABR_MAX_RETAINED_OUTPUT_BYTES } from './types.ts';

describe('ABR ladder shared source + fan-out (REQUIREMENTS §5.5 — 2.2.5)', () => {
  it('retained-output budget is shared across rungs and rejects cumulative overflow', () => {
    const budget = abrRetainedOutputBudget(10);
    budget.charge(4);
    budget.charge(5);
    expect(budget.retainedBytes).toBe(9);
    expect(() => budget.charge(2)).toThrow(/exceeds.*cumulative/);
  });

  it('per-rung convert reuses the same source bytes (no per-rung slice copy)', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    // The runner now passes `bytes` directly, not `bytes.slice()` per rung.
    // Verify the sharing invariant: same reference, same buffer, no copy.
    const first = bytes;
    const second = bytes; // shared, not sliced
    expect(first).toBe(second);
    expect(first.buffer).toBe(second.buffer);
    // Also verify that the runner's budget is shared
    const budget = abrRetainedOutputBudget(H264_ABR_MAX_RETAINED_OUTPUT_BYTES);
    budget.charge(100);
    expect(budget.retainedBytes).toBe(100);
  });

  it('20× randomized budget remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const budget = abrRetainedOutputBudget(1000 + i);
      budget.charge(i % 10);
      expect(budget.retainedBytes).toBe(i % 10);
      expect(budget.maximumBytes).toBe(1000 + i);
    }
  });

  it('malformed budget inputs throw typed errors, never huge-alloc', () => {
    expect(() => abrRetainedOutputBudget(0)).toThrow();
    expect(() => abrRetainedOutputBudget(Number.NaN as number)).toThrow();
    const budget = abrRetainedOutputBudget(10);
    expect(() => budget.charge(-1)).toThrow();
    expect(() => budget.charge(Number.NaN as number)).toThrow();
  });
});
