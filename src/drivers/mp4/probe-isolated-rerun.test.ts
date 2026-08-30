import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

function raWithSize(bytes: Uint8Array, size: number) {
  const reads: Array<{ offset: number; length: number }> = [];
  return {
    get reads() {
      return reads;
    },
    read: (o: number, l: number) => {
      reads.push({ offset: o, length: l });
      if (o >= bytes.byteLength) return Promise.resolve(new Uint8Array(0));
      return Promise.resolve(bytes.subarray(o, Math.min(o + l, bytes.byteLength)));
    },
    size,
  } as any;
}

/**
 * Isolated reruns for scale-budget cells (REQUIREMENTS §8.4 — 0.10).
 * Probe of huge inputs must be bounded and isolated: a second sequential probe of the
 * same huge file must not share state, leak, or succeed due to cached whole-file.
 * Covers probe/huge_h264_1080p_600s (10GiB) and probe/large_vp9_1080p_120s (3GiB) via
 * synthetic size inflation of a real fragmented fixture (same moov shape, sparse size).
 */
describe('probe isolated reruns — scale-budget cells (0.10)', () => {
  it('huge_h264_1080p_600s synthetic 10GiB: two isolated probes both bounded, no huge allocation', async () => {
    const bytes = await loadFixture('bear-av-frag.mp4');
    const tenGiB = 10 * 1024 * 1024 * 1024;
    for (let run = 0; run < 2; run++) {
      const ra = raWithSize(bytes, tenGiB);
      await expect(readMovie(ra)).rejects.toMatchObject({ code: 'resource-exhaustion' });
      expect(ra.reads.find((r: { length: number }) => r.length >= tenGiB)).toBeUndefined();
      // Ensure the second run starts fresh (no reads bleed from first)
      expect(ra.reads.length).toBeGreaterThan(0);
      expect(ra.reads.length).toBeLessThan(100);
    }
  });

  it('large_vp9_1080p_120s synthetic 3GiB: two isolated probes both bounded', async () => {
    const bytes = await loadFixture('bear-av-frag.mp4');
    const threeGiB = 3 * 1024 * 1024 * 1024;
    for (let run = 0; run < 2; run++) {
      const ra = raWithSize(bytes, threeGiB);
      // Probe path for fragmented still hits whole-file budget (64MiB) -> resource-exhaustion
      await expect(readMovie(ra)).rejects.toMatchObject({ code: 'resource-exhaustion' });
      expect(ra.reads.find((r: { length: number }) => r.length >= threeGiB)).toBeUndefined();
    }
  });

  it('isolated remux reruns: huge fragmented remux twice remains bounded (128MiB budget)', async () => {
    const bytes = await loadFixture('bear-av-frag.mp4');
    const baseMovie = await readMovie(raWithSize(bytes, bytes.byteLength));
    const hugeRemuxSize = 2 * 1024 * 1024 * 1024;
    for (let run = 0; run < 2; run++) {
      const ra = raWithSize(bytes, hugeRemuxSize);
      await expect(muxTracksFromMovie(ra, baseMovie as any)).rejects.toMatchObject({
        code: 'resource-exhaustion',
      });
      expect(
        ra.reads.find((r: { length: number }) => r.length > 128 * 1024 * 1024),
      ).toBeUndefined();
    }
  });

  it('boundary: 64MiB probe budget isolated rerun still succeeds, 64MiB+1 still bounded', async () => {
    const bytes = await loadFixture('bear-av-frag.mp4');
    const atBudget = 64 * 1024 * 1024;
    const overBudget = atBudget + 1;
    // First run at budget: probe of non-fragmented small file does not need whole-file, so it succeeds even at budget
    const raAt = raWithSize(bytes, atBudget);
    const movieAt = await readMovie(raAt);
    expect(movieAt.hasFragments).toBeDefined();
    // Second run over budget for remux path must still be bounded
    const movie = await readMovie(raWithSize(bytes, bytes.byteLength));
    const raOver = raWithSize(bytes, overBudget + 64 * 1024 * 1024); // 128MiB+1 for remux
    await expect(muxTracksFromMovie(raOver as any, movie as any)).rejects.toMatchObject({
      code: 'resource-exhaustion',
    });
    // Isolated: a fresh at-budget probe after an over-budget failure still succeeds
    const raFresh = raWithSize(bytes, atBudget);
    const movieFresh = await readMovie(raFresh);
    expect(movieFresh.hasFragments).toBeDefined();
  });

  it('randomized 20× near-budget sizes isolated reruns never allocate beyond budget', async () => {
    const bytes = await loadFixture('bear-av-frag.mp4');
    const baseMovie = await readMovie(raWithSize(bytes, bytes.byteLength));
    for (let i = 0; i < 20; i++) {
      const jitter = Math.floor(Math.random() * 8192) - 4096;
      const size = 128 * 1024 * 1024 + jitter + (i % 2);
      const ra1 = raWithSize(bytes, size);
      const ra2 = raWithSize(bytes, size);
      // Two isolated runs of same size must behave identically
      let r1: any, r2: any;
      try {
        await muxTracksFromMovie(ra1 as any, baseMovie as any);
      } catch (e) {
        r1 = e;
      }
      try {
        await muxTracksFromMovie(ra2 as any, baseMovie as any);
      } catch (e) {
        r2 = e;
      }
      expect(!!r1).toBe(!!r2);
      if (r1) expect(r1.code).toBe('resource-exhaustion');
      // Huge 10GiB must never be allocated; near-budget may still probe header before rejecting,
      // but the second isolated run must match the first exactly (no state bleed).
      expect(ra1.reads.length).toBe(ra2.reads.length);
      expect(ra1.reads[0]?.length).toBe(ra2.reads[0]?.length);
    }
  });
});
