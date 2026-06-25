/**
 * Probe of fragmented/CMAF MP4 and the fps-from-fragments path (the two real probe bugs fixed in
 * parse.ts `applyFragmentTiming`). Oracle: the per-file ffprobe ground truth (ffprobe 8.0), asserted on
 * real corpus fixtures with the task's tolerances — durationSec within ±0.05 s (and never 0), video fps
 * within ±0.5 (and never 0). Before the fix every fragmented file probed durationSec 0 / fps undefined,
 * and the non-square-pixel file (also fragmented) probed fps 0 — so each assertion below can fail.
 */

import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { MediaInfo } from '../../api/types.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { Mp4Module } from './mp4-driver.ts';
import { applyFragmentTiming, parseFragments, parseMovie } from './parse.ts';

/** ffprobe 8.0 ground truth (container duration + video stream avg_frame_rate). */
interface Truth {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}
const FRAGMENTED: Record<string, Truth> = {
  // Fragmented (mvex+moof); moov sample table empty ⇒ mvhd/mdhd duration 0 before the fix.
  'bear-av1-10bit.mp4': { durationSec: 2.735, fps: 16400 / 547, width: 320, height: 180 }, // per-sample trun durations (VFR)
  'bear-open-gop-frag.mp4': { durationSec: 2.0, fps: 24, width: 320, height: 240 }, // two fragments, no sidx
  'bear-av-frag.mp4': { durationSec: 2.8028, fps: 30000 / 1001, width: 1280, height: 720 }, // sidx present (presentation end ≠ Σ sample durations)
  // Fragmented too (sidx + one moof); mvhd duration was non-zero but the empty stts gave fps 0.
  'bear-non-square-pixel.mp4': { durationSec: 1.001, fps: 30000 / 1001, width: 470, height: 360 },
};

async function probe(id: string): Promise<MediaInfo> {
  return createMedia()
    .use(Mp4Module)
    .probe(await fixtureSource(id));
}

describe('fragmented/CMAF MP4 probe — duration + fps recovered from movie fragments (ffprobe truth)', () => {
  for (const [id, truth] of Object.entries(FRAGMENTED)) {
    it(`${id}: durationSec ≈ ${truth.durationSec.toFixed(3)}s (not 0) and fps ≈ ${truth.fps.toFixed(3)} (not 0)`, async () => {
      const info = await probe(id);
      expect(info.container).toBe('mp4');

      // Duration: within ±0.05 s of ffprobe, and crucially never the pre-fix 0.
      expect(info.durationSec).toBeGreaterThan(0);
      expect(Math.abs(info.durationSec - truth.durationSec)).toBeLessThanOrEqual(0.05);

      const video = info.tracks.find((t) => t.type === 'video');
      expect(video).toBeDefined();
      expect(video?.width).toBe(truth.width);
      expect(video?.height).toBe(truth.height);

      // fps: within ±0.5 of ffprobe avg_frame_rate, and never the pre-fix 0/undefined.
      expect(video?.fps).toBeDefined();
      expect(video?.fps ?? 0).toBeGreaterThan(0);
      expect(Math.abs((video?.fps ?? 0) - truth.fps)).toBeLessThanOrEqual(0.5);

      // The video track's own duration is set from its fragments too (not left at 0).
      expect(video?.durationSec ?? 0).toBeGreaterThan(0);
    });
  }

  it('a non-fragmented MP4 is untouched (no fragment patching, fps still avg from stts)', async () => {
    // movie_5.mp4 has a real moov sample table; applyFragmentTiming must early-return.
    const file = await loadFixture('movie_5.mp4');
    const movie = parseMovie('mp42', stripToMoov(file));
    const before = movie.tracks.map((t) => ({ d: t.durationSec, f: t.fps }));
    applyFragmentTiming(movie, file);
    const after = movie.tracks.map((t) => ({ d: t.durationSec, f: t.fps }));
    expect(after).toEqual(before);
  });
});

describe('parseFragments — pure moof/sidx accumulation on real fragmented files', () => {
  it('sums trun sample counts and durations per track', async () => {
    const timing = parseFragments(await loadFixture('bear-open-gop-frag.mp4'));
    const track = timing.get(1);
    expect(track).toBeDefined();
    // Two fragments: 23 + 25 = 48 samples; 12288 ticks/s → exactly 2.0 s of media.
    expect(track?.sampleCount).toBe(48);
    expect((track?.mediaTicks ?? 0) / 12288).toBeCloseTo(2.0, 3);
  });

  it('prefers the sidx presentation end for duration but the sample-duration sum for fps', async () => {
    // bear-av-frag.mp4 video: sidx end 84084/30000 = 2.8028 s (presentation), but the 82 frames span
    // only 82082/30000 = 2.7361 s of media → fps must be 82/2.7361 = 29.97, not 82/2.8028 = 29.26.
    const timing = parseFragments(await loadFixture('bear-av-frag.mp4'));
    const v = timing.get(1);
    expect(v?.sampleCount).toBe(82);
    expect((v?.durationTicks ?? 0) / 30000).toBeCloseTo(2.8028, 3); // sidx presentation end
    expect((v?.mediaTicks ?? 0) / 30000).toBeCloseTo(2.7361, 3); // Σ sample durations
    expect(v ? v.sampleCount / (v.mediaTicks / 30000) : 0).toBeCloseTo(30000 / 1001, 1);
  });

  it('returns an empty map for a non-fragmented file (no moof)', async () => {
    expect(parseFragments(await loadFixture('movie_5.mp4')).size).toBe(0);
  });
});

/** Extract just the `moov` box bytes from a file (parseMovie takes the moov payload). */
function stripToMoov(file: Uint8Array): Uint8Array {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let p = 0;
  while (p + 8 <= file.byteLength) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(
      file[p + 4] ?? 0,
      file[p + 5] ?? 0,
      file[p + 6] ?? 0,
      file[p + 7] ?? 0,
    );
    if (type === 'moov') return file.subarray(p + 8, p + size);
    if (size <= 0) break;
    p += size;
  }
  throw new Error('no moov');
}
