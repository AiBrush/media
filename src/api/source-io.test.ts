import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_CACHE_KEY, type Source } from '../sources/source.ts';
import { cacheFiniteBlobProbeRanges, isFiniteBlobUrlSource } from './blob-probe-handoff.ts';
import {
  type SourcePrefixHandoff,
  cacheProbeRanges,
  clearSourcePrefixHandoffs,
} from './source-io.ts';

const ONE_MIB = 1024 * 1024;

function cacheReusableProbeRanges(
  source: Source,
  handoff: Map<string, SourcePrefixHandoff>,
  _mode: 'reuse',
  options: { readonly maxBytes?: number; readonly ttlMs?: number } = {},
): Source {
  return cacheFiniteBlobProbeRanges(source, handoff, options);
}

function finiteBlobSource(
  cacheKey: string,
  bytes: Uint8Array,
  onRange: () => void = () => {},
): Source {
  return {
    __media: 'source',
    kind: 'url',
    size: bytes.byteLength,
    [SOURCE_CACHE_KEY]: cacheKey,
    range: (start, end) => {
      onRange();
      return Promise.resolve(bytes.subarray(start, end));
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('seekable source must not stream');
    },
  };
}

describe('source prefix handoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('only recognizes blob URLs with a finite known byte length', () => {
    const bytes = new Uint8Array(1);
    expect(isFiniteBlobUrlSource(finiteBlobSource('blob:https://example.test/one', bytes))).toBe(
      true,
    );
    expect(isFiniteBlobUrlSource(finiteBlobSource('https://example.test/one', bytes))).toBe(false);
    const { size: _size, ...unknownSize } = finiteBlobSource(
      'blob:https://example.test/unknown',
      bytes,
    );
    expect(isFiniteBlobUrlSource(unknownSize)).toBe(false);
  });

  it('reuses only a matching blob URL and known size', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const original = new Uint8Array([1, 2, 3, 4]);
    let firstReads = 0;
    const first = cacheReusableProbeRanges(
      finiteBlobSource('blob:https://example.test/stable', original, () => firstReads++),
      handoff,
      'reuse',
    );
    expect(await first.range?.(0, original.byteLength)).toEqual(original);

    let matchingReads = 0;
    const matching = cacheReusableProbeRanges(
      finiteBlobSource(
        'blob:https://example.test/stable',
        new Uint8Array(original.byteLength),
        () => matchingReads++,
      ),
      handoff,
      'reuse',
    );
    expect(await matching.range?.(0, original.byteLength)).toEqual(original);
    expect({ firstReads, matchingReads }).toEqual({ firstReads: 1, matchingReads: 0 });

    let mismatchedReads = 0;
    const mismatchedBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const mismatched = cacheReusableProbeRanges(
      finiteBlobSource(
        'blob:https://example.test/stable',
        mismatchedBytes,
        () => mismatchedReads++,
      ),
      handoff,
      'reuse',
    );
    expect(await mismatched.range?.(0, mismatchedBytes.byteLength)).toEqual(mismatchedBytes);
    expect(mismatchedReads).toBe(1);
  });

  it('forwards cancellation to a miss and never retains a read that aborts in flight', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveRead!: (bytes: Uint8Array) => void;
    const transportRead = new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    });
    const source: Source = {
      ...finiteBlobSource('blob:https://example.test/cancelled', new Uint8Array(4)),
      range: (_start, _end, signal) => {
        observedSignal = signal;
        return transportRead;
      },
    };
    const wrapped = cacheReusableProbeRanges(source, handoff, 'reuse');
    const read = wrapped.range?.(0, 4, controller.signal);

    controller.abort(new Error('stop prefix read'));
    await expect(read).rejects.toMatchObject({ code: 'aborted' });
    expect(observedSignal).toBe(controller.signal);
    expect(handoff.size).toBe(0);

    resolveRead(new Uint8Array([1, 2, 3, 4]));
    await Promise.resolve();
    expect(handoff.size).toBe(0);
  });

  it('rejects a pre-aborted reusable hit without touching its backing transport', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const key = 'blob:https://example.test/pre-aborted';
    await cacheReusableProbeRanges(
      finiteBlobSource(key, new Uint8Array([1, 2, 3, 4])),
      handoff,
      'reuse',
    ).range?.(0, 4);

    let reads = 0;
    const hit = cacheReusableProbeRanges(
      finiteBlobSource(key, new Uint8Array(4), () => reads++),
      handoff,
      'reuse',
    );
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));

    await expect(hit.range?.(0, 4, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(reads).toBe(0);
  });

  it('never lets a stale concurrent wrapper replace a longer reusable prefix', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const handoff = new Map<string, SourcePrefixHandoff>();
    const key = 'blob:https://example.test/concurrent';
    const bytes = new Uint8Array(8);
    const growing = cacheReusableProbeRanges(finiteBlobSource(key, bytes), handoff, 'reuse');
    await growing.range?.(0, 2);
    const stale = cacheReusableProbeRanges(finiteBlobSource(key, bytes), handoff, 'reuse');

    await growing.range?.(0, 8);
    expect(handoff.get(key)?.bytes.byteLength).toBe(8);
    await stale.range?.(0, 4);

    expect(handoff.get(key)?.bytes.byteLength).toBe(8);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('retains at most eight MiB across eight prefixes and evicts the least recently used', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    for (let index = 0; index < 8; index++) {
      const source = finiteBlobSource(
        `blob:https://example.test/${index}`,
        new Uint8Array(ONE_MIB),
      );
      await cacheReusableProbeRanges(source, handoff, 'reuse').range?.(0, ONE_MIB);
    }

    let rereads = 0;
    const recentlyUsed = finiteBlobSource(
      'blob:https://example.test/0',
      new Uint8Array(ONE_MIB),
      () => rereads++,
    );
    await cacheReusableProbeRanges(recentlyUsed, handoff, 'reuse').range?.(0, 1);
    expect(rereads).toBe(0);

    const ninth = finiteBlobSource('blob:https://example.test/8', new Uint8Array(ONE_MIB));
    await cacheReusableProbeRanges(ninth, handoff, 'reuse').range?.(0, ONE_MIB);

    expect(handoff.size).toBe(8);
    expect(handoff.has('blob:https://example.test/0')).toBe(true);
    expect(handoff.has('blob:https://example.test/1')).toBe(false);
    expect([...handoff.values()].reduce((total, entry) => total + entry.bytes.byteLength, 0)).toBe(
      8 * ONE_MIB,
    );
  });

  it('owns reusable bytes without adding a copy to the ordinary probe-to-decode handoff', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const reusableHandoff = new Map<string, SourcePrefixHandoff>();
    const reusableResult = await cacheReusableProbeRanges(
      finiteBlobSource('blob:https://example.test/owned', bytes),
      reusableHandoff,
      'reuse',
    ).range?.(0, bytes.byteLength);
    expect(reusableHandoff.get('blob:https://example.test/owned')?.bytes).not.toBe(reusableResult);

    const ordinaryHandoff = new Map<string, SourcePrefixHandoff>();
    const ordinaryResult = await cacheProbeRanges(
      {
        ...finiteBlobSource('https://example.test/ordinary', bytes),
        [SOURCE_CACHE_KEY]: 'https://example.test/ordinary',
      },
      ordinaryHandoff,
      'store',
    ).range?.(0, bytes.byteLength);
    expect(ordinaryHandoff.get('https://example.test/ordinary')?.bytes).toBe(ordinaryResult);
  });

  it('isolates reusable cross-Source hits from consumer mutation', async () => {
    const key = 'blob:https://example.test/mutation-isolation';
    const original = new Uint8Array([1, 2, 3, 4]);
    const handoff = new Map<string, SourcePrefixHandoff>();
    await cacheReusableProbeRanges(finiteBlobSource(key, original), handoff, 'reuse').range?.(
      0,
      original.byteLength,
    );

    let secondReads = 0;
    const second = await cacheReusableProbeRanges(
      finiteBlobSource(key, new Uint8Array(original.byteLength), () => secondReads++),
      handoff,
      'reuse',
    ).range?.(0, original.byteLength);
    expect(second).toEqual(original);
    expect(secondReads).toBe(0);
    if (second !== undefined) second[0] = 0xff;

    let thirdReads = 0;
    const third = await cacheReusableProbeRanges(
      finiteBlobSource(key, new Uint8Array(original.byteLength), () => thirdReads++),
      handoff,
      'reuse',
    ).range?.(0, original.byteLength);
    expect(third).toEqual(original);
    expect(thirdReads).toBe(0);
  });

  it('never hands off a prefix larger than one MiB', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const bytes = new Uint8Array(ONE_MIB + 1);
    const source = finiteBlobSource('blob:https://example.test/large', bytes);

    expect(
      await cacheReusableProbeRanges(source, handoff, 'reuse').range?.(0, bytes.byteLength),
    ).toEqual(bytes);
    expect(handoff.size).toBe(0);
  });

  it('expires an idle reusable prefix after the short TTL', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const source = finiteBlobSource('blob:https://example.test/expiring', new Uint8Array([1]));
    await cacheReusableProbeRanges(source, handoff, 'reuse').range?.(0, 1);
    expect(handoff.size).toBe(1);

    vi.advanceTimersByTime(249);
    expect(handoff.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(handoff.size).toBe(0);
  });

  it('uses one absolute expiry and never creates or refreshes a timer on a cache hit', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const handoff = new Map<string, SourcePrefixHandoff>();
    const key = 'blob:https://example.test/absolute-expiry';
    const source = finiteBlobSource(key, new Uint8Array([1]));
    await cacheReusableProbeRanges(source, handoff, 'reuse').range?.(0, 1);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    await cacheReusableProbeRanges(source, handoff, 'reuse').range?.(0, 1);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(49);
    expect(handoff.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(handoff.size).toBe(0);
  });

  it('makes pending reusable-prefix expiry callbacks harmless after an engine clear', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    await cacheReusableProbeRanges(
      finiteBlobSource('blob:https://example.test/dispose-a', new Uint8Array([1])),
      handoff,
      'reuse',
    ).range?.(0, 1);
    await cacheReusableProbeRanges(
      finiteBlobSource('blob:https://example.test/dispose-b', new Uint8Array([2])),
      handoff,
      'reuse',
    ).range?.(0, 1);
    expect(vi.getTimerCount()).toBe(2);

    clearSourcePrefixHandoffs(handoff);

    expect(handoff.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(250);
    expect(handoff.size).toBe(0);
  });

  it('cancels an ordinary source-prefix expiry timer on clear', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const key = 'https://example.test/ordinary';
    await cacheProbeRanges(
      {
        ...finiteBlobSource(key, new Uint8Array([1])),
        [SOURCE_CACHE_KEY]: key,
      },
      handoff,
      'store',
    ).range?.(0, 1);
    expect(vi.getTimerCount()).toBe(1);

    clearSourcePrefixHandoffs(handoff);

    expect(handoff.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a non-finite TTL as an immediate, non-reusable expiry', async () => {
    const handoff = new Map<string, SourcePrefixHandoff>();
    const key = 'blob:https://example.test/non-finite-ttl';
    let reads = 0;
    const source = (): Source =>
      finiteBlobSource(key, new Uint8Array([1]), () => {
        reads++;
      });

    await cacheReusableProbeRanges(source(), handoff, 'reuse', {
      ttlMs: Number.NaN,
    }).range?.(0, 1);
    await cacheReusableProbeRanges(source(), handoff, 'reuse', {
      ttlMs: Number.NaN,
    }).range?.(0, 1);

    expect(reads).toBe(2);
  });
});
