import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import {
  createRangeProgressReporter,
  estimateMediaTimeUs,
  fetchRangeWithProgress,
  mediaTimeFromStats,
} from './range-progress.ts';
import type { RangeProgress } from './range-progress.ts';
import type { Source } from './source.ts';
import { fromBytes } from './source.ts';

function bytesSource(size: number, opts?: { chunkMax?: number; failAt?: number }): Source {
  const base = new Uint8Array(size);
  for (let i = 0; i < size; i++) base[i] = i & 0xff;
  return {
    __media: 'source' as const,
    kind: 'bytes' as const,
    size,
    stream: () =>
      new ReadableStream({
        start(c) {
          c.enqueue(base);
          c.close();
        },
      }),
    range: async (start, end, signal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const lo = Math.max(0, Math.trunc(start));
      let hi = Math.max(lo, Math.trunc(end));
      hi = Math.min(hi, size);
      if (hi <= lo) return new Uint8Array(0);
      if (opts?.failAt !== undefined && lo >= opts.failAt)
        throw new DOMException('aborted', 'AbortError');
      const avail = hi - lo;
      const max = opts?.chunkMax ?? avail;
      const take = Math.min(avail, max);
      return base.subarray(lo, lo + take);
    },
  };
}

describe('range-progress', () => {
  it('bytes progress emits monotonic done + bytesDone/total without full indexing', async () => {
    const src = bytesSource(1000);
    const seen: RangeProgress[] = [];
    const out = await fetchRangeWithProgress(src, 0, 1000, undefined, (p) => seen.push(p), {
      chunkSize: 100,
      stage: 'demux:bytes',
    });
    expect(out.byteLength).toBe(1000);
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++)
      expect((seen[i] as RangeProgress).done).toBeGreaterThanOrEqual(
        (seen[i - 1] as RangeProgress).done,
      );
    const last = seen[seen.length - 1] as RangeProgress;
    expect(last.bytesDone).toBe(1000);
    expect(last.bytesTotal).toBe(1000);
    expect(last.done).toBe(1);
    // byte-exact vs direct range
    const direct = await src.range!(0, 1000);
    expect(out).toEqual(direct);
  });

  it('media time progress without indexing via PacketMetadataStats', async () => {
    const src = bytesSource(2000);
    const stats = {
      packetCount: 10,
      totalSizeBytes: 2000,
      presentationStartUs: 0,
      presentationEndUs: 2_000_000,
    };
    const seen: RangeProgress[] = [];
    const out = await fetchRangeWithProgress(src, 0, 2000, undefined, (p) => seen.push(p), {
      chunkSize: 500,
      stats,
      stage: 'remux:mediaTime',
    });
    expect(out.byteLength).toBe(2000);
    const last = seen[seen.length - 1] as RangeProgress;
    expect(last.mediaTimeUsTotal).toBe(2_000_000);
    expect(last.mediaTimeUsDone).toBe(2_000_000);
    // halfway bytes ~ halfway media time
    expect(mediaTimeFromStats(stats)).toBe(2_000_000);
    expect(estimateMediaTimeUs(1000, 2000, 2_000_000)).toBe(1_000_000);
  });

  it('resumable range: abort mid-window reports resumeOffset and retry concatenates bit-exact', async () => {
    const total = 1000;
    const base = fromBytes(new Uint8Array(total).map((_, i) => i & 0xff));
    // Simulate abort after 300 bytes by using abort signal mid-fetch with chunkSize 100
    const c = new AbortController();
    const seen: RangeProgress[] = [];
    const onProgress = (p: RangeProgress) => {
      seen.push(p);
      if ((p.bytesDone ?? 0) >= 300 && !c.signal.aborted)
        c.abort(new DOMException('aborted', 'AbortError'));
    };
    await expect(
      fetchRangeWithProgress(base, 0, total, c.signal, onProgress, { chunkSize: 100 }),
    ).rejects.toThrow();
    const resumeOffset =
      seen[seen.length - 1]?.resumeOffset ?? seen[seen.length - 1]?.bytesDone ?? 0;
    expect(resumeOffset).toBeGreaterThanOrEqual(300);
    expect(resumeOffset).toBeLessThan(total);
    // Resume from offset and concatenate: fetch remainder
    const remainder = await fetchRangeWithProgress(
      base,
      resumeOffset,
      total,
      undefined,
      undefined,
      { chunkSize: 100 },
    );
    const firstPart = await base.range!(0, resumeOffset);
    const reassembled = new Uint8Array(total);
    reassembled.set(firstPart, 0);
    reassembled.set(remainder, resumeOffset);
    const direct = await base.range!(0, total);
    expect(reassembled).toEqual(direct);
  });

  it('boundary: empty range emits zero and completes without allocation', async () => {
    const src = bytesSource(100);
    const seen: RangeProgress[] = [];
    const out = await fetchRangeWithProgress(src, 10, 10, undefined, (p) =>
      seen.push(p as RangeProgress),
    );
    expect(out.byteLength).toBe(0);
    expect(seen[seen.length - 1]?.done).toBe(1);
  });

  it('malformed range throws InputError with context', async () => {
    const src = bytesSource(100);
    await expect(
      fetchRangeWithProgress(src, Number.NaN as unknown as number, 10, undefined, undefined),
    ).rejects.toBeInstanceOf(InputError);
    await expect(fetchRangeWithProgress(src, 10, 5, undefined, undefined)).rejects.toBeInstanceOf(
      InputError,
    );
    expect(() => estimateMediaTimeUs(Number.NaN, 100, 1000)).toThrow();
    expect(() => createRangeProgressReporter(undefined, '', 100).report(Number.NaN)).toThrow();
  });

  it('20× randomized valid windows remain byte-exact and monotonic', async () => {
    const total = 5000;
    const src = bytesSource(total);
    const rnd = seededRandom(0x1a11_600d);
    for (let t = 0; t < 20; t++) {
      const a = Math.floor(rnd() * total);
      const b = Math.floor(rnd() * total);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const seen: number[] = [];
      const out = await fetchRangeWithProgress(src, lo, hi, undefined, (p) => seen.push(p.done), {
        chunkSize: 1 + Math.floor(rnd() * 200),
      });
      const direct = await src.range!(lo, hi);
      expect(out).toEqual(direct);
      for (let i = 1; i < seen.length; i++)
        expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
    }
  });
});

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
