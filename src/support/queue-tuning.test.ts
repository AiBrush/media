import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_TUNING, assertQueueTuning, tunedQueueDepth } from './queue-tuning.ts';

describe('queue depth / chunk size tuning — bounded memory (REQUIREMENTS §8.4 — 3.3)', () => {
  it('default tuning is within 64 MiB budget', () => {
    expect(DEFAULT_QUEUE_TUNING.maxQueuedWindows).toBe(8);
    expect(DEFAULT_QUEUE_TUNING.chunkSizeBytes).toBe(64 * 1024);
    expect(() => assertQueueTuning(DEFAULT_QUEUE_TUNING)).not.toThrow();
    expect(
      DEFAULT_QUEUE_TUNING.maxQueuedWindows * DEFAULT_QUEUE_TUNING.chunkSizeBytes,
    ).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('tuned depth grows with input size but stays bounded', () => {
    expect(tunedQueueDepth(undefined)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(tunedQueueDepth(5 * 1024 * 1024)).toEqual(DEFAULT_QUEUE_TUNING);
    const mid = tunedQueueDepth(50 * 1024 * 1024);
    expect(mid.maxQueuedWindows).toBe(12);
    expect(mid.chunkSizeBytes).toBe(128 * 1024);
    expect(() => assertQueueTuning(mid)).not.toThrow();
    const large = tunedQueueDepth(200 * 1024 * 1024);
    expect(large.maxQueuedWindows).toBe(16);
    expect(large.chunkSizeBytes).toBe(256 * 1024);
    expect(() => assertQueueTuning(large)).not.toThrow();
  });

  it('20× randomized remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const bytes = (i * 10_000_000) % (200 * 1024 * 1024);
      const tuning = tunedQueueDepth(bytes);
      expect(() => assertQueueTuning(tuning)).not.toThrow();
      expect(tuning.maxQueuedWindows).toBeGreaterThanOrEqual(8);
      expect(tuning.maxQueuedWindows).toBeLessThanOrEqual(16);
    }
  });

  it('boundary: 0, 10 MiB, 100 MiB, MAX_SAFE_INTEGER', () => {
    expect(tunedQueueDepth(0)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(tunedQueueDepth(10 * 1024 * 1024 - 1)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(tunedQueueDepth(10 * 1024 * 1024).maxQueuedWindows).toBe(12);
    expect(tunedQueueDepth(Number.MAX_SAFE_INTEGER).maxQueuedWindows).toBe(16);
  });

  it('malformed inputs return default and assert throws RangeError', () => {
    expect(tunedQueueDepth(Number.NaN as never)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(tunedQueueDepth(-1 as never)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(tunedQueueDepth(Number.POSITIVE_INFINITY as never)).toEqual(DEFAULT_QUEUE_TUNING);
    expect(() =>
      assertQueueTuning({ ...DEFAULT_QUEUE_TUNING, maxQueuedWindows: 0 } as never),
    ).toThrow(RangeError);
    expect(() =>
      assertQueueTuning({ ...DEFAULT_QUEUE_TUNING, chunkSizeBytes: 0 } as never),
    ).toThrow(RangeError);
    expect(() =>
      assertQueueTuning({ ...DEFAULT_QUEUE_TUNING, maxQueuedWindows: 100 } as never),
    ).toThrow(RangeError);
  });
});
