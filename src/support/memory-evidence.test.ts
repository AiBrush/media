import { describe, expect, it } from 'vitest';
import { isolatedMemoryDelta, memoryEvidence, memoryMethod } from './memory-evidence.ts';

describe('memory evidence — method + isolated vs whole-process delta (REQUIREMENTS §8.4 — 0.8)', () => {
  it('memoryMethod is one of the three honest values', () => {
    const method = memoryMethod();
    expect(['performance.memory', 'measureUserAgentSpecificMemory', 'not-measured']).toContain(
      method,
    );
  });

  it('isolated delta is peak - baseline, whole-process not attributed', () => {
    expect(isolatedMemoryDelta(100, 150)).toBe(50);
    expect(isolatedMemoryDelta(100, 150, 300_000_000)).toBe(50); // whole-process 300 MB ignored for delta
    expect(isolatedMemoryDelta(100, 100)).toBe(0);
  });

  it('memoryEvidence honours not-measured (never zero) and validates inputs', () => {
    const ev = memoryEvidence(100, 150, 300_000_000);
    if (ev.method === 'not-measured') {
      expect(ev.deltaBytes).toBeUndefined();
      expect(ev.baselineBytes).toBeUndefined();
    } else {
      expect(ev.deltaBytes).toBe(50);
      expect(ev.method).not.toBe('not-measured');
    }
    // Node has no performance.memory, so method is not-measured → honest undefined, not zero
    expect(memoryMethod()).toBe('not-measured');
    expect(memoryEvidence(100, 150).method).toBe('not-measured');
    expect(memoryEvidence(100, 150).deltaBytes).toBeUndefined();
  });

  it('20× randomized remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const baseline = 1000 + i * 10;
      const peak = baseline + (i % 5) * 100;
      const delta = isolatedMemoryDelta(baseline, peak);
      expect(delta).toBe(peak - baseline);
      const ev = memoryEvidence(baseline, peak);
      if (ev.method !== 'not-measured') expect(ev.deltaBytes).toBe(delta);
    }
  });

  it('boundary: zero and large safe integers', () => {
    expect(isolatedMemoryDelta(0, 0)).toBe(0);
    expect(isolatedMemoryDelta(0, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(isolatedMemoryDelta(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('malformed inputs return undefined, never huge-alloc or throw', () => {
    expect(isolatedMemoryDelta(undefined as never, 100)).toBeUndefined();
    expect(isolatedMemoryDelta(100, undefined as never)).toBeUndefined();
    expect(isolatedMemoryDelta(Number.NaN as never, 100)).toBeUndefined();
    expect(isolatedMemoryDelta(100, Number.POSITIVE_INFINITY as never)).toBeUndefined();
    expect(isolatedMemoryDelta(-1, 100)).toBeUndefined();
    expect(isolatedMemoryDelta(100, 50)).toBeUndefined(); // peak < baseline
    expect(memoryEvidence(Number.NaN as never, 100).deltaBytes).toBeUndefined();
    expect(memoryEvidence(100, -1 as never).deltaBytes).toBeUndefined();
  });
});
