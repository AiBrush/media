import { describe, expect, it, vi } from 'vitest';
import {
  type ProbeRangeCacheOptions,
  type ProbeRangeCacheState,
  cacheRepeatedProbeRanges,
  cacheRepeatedProbeRangesFor,
} from './probe-range-cache.ts';
import type { Source } from './source.ts';

const OPTIONS: ProbeRangeCacheOptions = {
  maxBytes: 1024,
  maxIntervals: 4,
  ttlMs: 60_000,
};

function rangeOf(src: Source, start: number, end: number): Promise<Uint8Array> {
  const range = src.range;
  if (range === undefined) throw new Error('expected a seekable source');
  return range.call(src, start, end);
}

function sourceWithCalls(bytes: Uint8Array): {
  readonly source: Source;
  readonly calls: Array<readonly [number, number]>;
} {
  const calls: Array<readonly [number, number]> = [];
  return {
    calls,
    source: {
      __media: 'source',
      kind: 'url',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    },
  };
}

describe('repeated probe interval cache', () => {
  it('returns a range-less source unchanged instead of inventing replayability', () => {
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };

    expect(cacheRepeatedProbeRanges(source, new WeakMap(), OPTIONS)).toBe(source);
  });

  it('shares only within one weakly-owned engine scope', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
    const { source, calls } = sourceWithCalls(bytes);
    const left = {};
    await rangeOf(cacheRepeatedProbeRangesFor(left, source), 0, 8);
    await rangeOf(cacheRepeatedProbeRangesFor(left, source), 0, 8);
    await rangeOf(cacheRepeatedProbeRangesFor({}, source), 0, 8);
    expect(calls).toEqual([
      [0, 8],
      [0, 8],
    ]);
  });

  it('reuses disjoint ranges and extends a contained header from only its missing suffix', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index);
    const { source, calls } = sourceWithCalls(bytes);
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const first = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    expect(await rangeOf(first, 0, 8)).toEqual(bytes.subarray(0, 8));
    expect(await rangeOf(first, 128, 144)).toEqual(bytes.subarray(128, 144));
    expect(await rangeOf(first, 128, 192)).toEqual(bytes.subarray(128, 192));

    const second = cacheRepeatedProbeRanges(source, cache, OPTIONS);
    expect(await rangeOf(second, 0, 8)).toEqual(bytes.subarray(0, 8));
    expect(await rangeOf(second, 128, 192)).toEqual(bytes.subarray(128, 192));
    expect(calls).toEqual([
      [0, 8],
      [128, 144],
      [144, 192],
    ]);
    expect(cache.get(source)?.totalBytes).toBe(72);
  });

  it('owns an extended prefix and isolates it from consumer mutation', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_value, index) => index);
    const { source, calls } = sourceWithCalls(bytes);
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    expect(await rangeOf(wrapped, 0, 8)).toEqual(bytes.subarray(0, 8));
    const extended = await rangeOf(wrapped, 0, 24);
    expect(extended).toEqual(bytes.subarray(0, 24));
    extended.fill(0);

    expect(await rangeOf(wrapped, 0, 24)).toEqual(bytes.subarray(0, 24));
    expect(calls).toEqual([
      [0, 8],
      [8, 24],
    ]);
    expect(cache.get(source)?.entries.map(({ start, end }) => [start, end])).toEqual([[0, 24]]);
    expect(cache.get(source)?.totalBytes).toBe(24);
  });

  it('preserves a short extension and learns the exact end of an unknown source', async () => {
    const bytes = Uint8Array.from({ length: 12 }, (_value, index) => index);
    const calls: Array<readonly [number, number]> = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    expect(await rangeOf(wrapped, 0, 8)).toEqual(bytes.subarray(0, 8));
    expect(await rangeOf(wrapped, 0, 32)).toEqual(bytes);
    expect(await rangeOf(wrapped, 0, 32)).toEqual(bytes);
    expect(calls).toEqual([
      [0, 8],
      [8, 32],
    ]);
    expect(cache.get(source)?.size).toBe(bytes.byteLength);
  });

  it('keeps the prior owned prefix when a suffix read fails', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
    const failure = new Error('suffix transport failed');
    let failSuffix = true;
    const calls: Array<readonly [number, number]> = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        if (start === 8 && failSuffix) return Promise.reject(failure);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    expect(await rangeOf(wrapped, 0, 8)).toEqual(bytes.subarray(0, 8));
    await expect(rangeOf(wrapped, 0, 16)).rejects.toBe(failure);
    expect(await rangeOf(wrapped, 0, 8)).toEqual(bytes.subarray(0, 8));
    failSuffix = false;
    expect(await rangeOf(wrapped, 0, 16)).toEqual(bytes.subarray(0, 16));
    expect(calls).toEqual([
      [0, 8],
      [8, 16],
      [8, 16],
    ]);
  });

  it('never shares retained bytes across source snapshots', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_value, index) => index);
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const left = sourceWithCalls(bytes);
    const right = sourceWithCalls(bytes);
    await rangeOf(cacheRepeatedProbeRanges(left.source, cache, OPTIONS), 8, 24);
    await rangeOf(cacheRepeatedProbeRanges(right.source, cache, OPTIONS), 8, 24);
    expect(left.calls).toEqual([[8, 24]]);
    expect(right.calls).toEqual([[8, 24]]);
  });

  it('hard-bounds retained bytes and expires lazily without a source-retaining timer', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const bytes = Uint8Array.from({ length: 64 }, (_value, index) => index);
      const { source, calls } = sourceWithCalls(bytes);
      const cache = new WeakMap<Source, ProbeRangeCacheState>();
      const options: ProbeRangeCacheOptions = { maxBytes: 16, maxIntervals: 2, ttlMs: 10 };
      await rangeOf(cacheRepeatedProbeRanges(source, cache, options), 0, 8);
      await rangeOf(cacheRepeatedProbeRanges(source, cache, options), 32, 44);
      await rangeOf(cacheRepeatedProbeRanges(source, cache, options), 32, 44);
      expect(calls).toEqual([
        [0, 8],
        [32, 44],
      ]);
      expect(cache.get(source)?.totalBytes).toBeLessThanOrEqual(options.maxBytes);

      now.mockReturnValue(1_011);
      await rangeOf(cacheRepeatedProbeRanges(source, cache, options), 0, 8);
      expect(calls.at(-1)).toEqual([0, 8]);
    } finally {
      now.mockRestore();
    }
  });

  it('owns exact-sized bytes and isolates cache hits from consumer mutation', async () => {
    const backing = Uint8Array.from({ length: 8 * 1024 * 1024 }, (_value, index) => index);
    let calls = 0;
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: backing.byteLength,
      range: (start, end) => {
        calls++;
        return Promise.resolve(backing.subarray(start, end));
      },
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);
    expect(await rangeOf(wrapped, 1024, 1028)).toEqual(backing.subarray(1024, 1028));
    const retained = cache.get(source)?.entries[0]?.bytes;
    expect(retained?.byteLength).toBe(4);
    expect(retained?.buffer.byteLength).toBe(4);

    const mutableHit = await rangeOf(wrapped, 1024, 1028);
    mutableHit.fill(0);
    expect(await rangeOf(wrapped, 1024, 1028)).toEqual(backing.subarray(1024, 1028));
    expect(calls).toBe(1);
  });

  it('canonicalizes overlapping reads regardless of completion order', async () => {
    const bytes = Uint8Array.from({ length: 128 }, (_value, index) => index);
    const pending = new Map<string, (value: Uint8Array) => void>();
    const source: Source = {
      __media: 'source',
      kind: 'url',
      size: bytes.byteLength,
      range: (start, end) =>
        new Promise((resolve) => {
          pending.set(`${start}:${end}`, resolve);
        }),
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);
    const small = rangeOf(wrapped, 20, 30);
    const large = rangeOf(wrapped, 0, 100);
    pending.get('0:100')?.(bytes.subarray(0, 100));
    await large;
    pending.get('20:30')?.(bytes.subarray(20, 30));
    await small;

    expect(cache.get(source)?.entries.map(({ start, end }) => [start, end])).toEqual([[0, 100]]);
    expect(cache.get(source)?.totalBytes).toBe(100);
  });

  it('extends from the longest overlapping owned interval and fetches only its suffix', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_value, index) => index);
    const { source, calls } = sourceWithCalls(bytes);
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    await rangeOf(wrapped, 0, 8);
    await rangeOf(wrapped, 4, 12);
    expect(await rangeOf(wrapped, 4, 20)).toEqual(bytes.subarray(4, 20));

    expect(calls).toEqual([
      [0, 8],
      [8, 12],
      [12, 20],
    ]);
    expect(cache.get(source)?.entries.map(({ start, end }) => [start, end])).toEqual([
      [0, 8],
      [4, 20],
    ]);
  });

  it('passes invalid and empty requests through without retaining their responses', async () => {
    const calls: Array<readonly [number, number]> = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(Uint8Array.of(1));
      },
      stream: () => new ReadableStream({ start: (controller) => controller.close() }),
    };
    const cache = new WeakMap<Source, ProbeRangeCacheState>();
    const wrapped = cacheRepeatedProbeRanges(source, cache, OPTIONS);

    await rangeOf(wrapped, -1, 4);
    await rangeOf(wrapped, -1, 4);
    await rangeOf(wrapped, 4, 4);
    await rangeOf(wrapped, 4, 4);

    expect(calls).toEqual([
      [-1, 4],
      [-1, 4],
      [4, 4],
      [4, 4],
    ]);
    expect(cache.get(source)).toMatchObject({ entries: [], totalBytes: 0 });
  });
});
