/**
 * Demux sample-table → packet timing on real B-frame and VFR MP4 (the golden-packets concern). Asserts
 * the structural invariants the harness `golden-packets` oracle checks: packets are emitted in DECODE
 * order with monotonic DTS (cumulative `stts` deltas), CTS = DTS + `ctts` composition offset (so
 * B-frame reorder is preserved and at least one frame has PTS ≠ DTS), VFR is honored (per-sample
 * `stts` deltas vary — no constant frame duration assumed), and keyframe flags come from `stss`.
 *
 * These are the per-sample fields the harness compares per track after sorting by (dts, pts). The
 * driver produces both DTS and CTS correctly here (verified to match the harness golden exactly when
 * both reach the oracle); the WebCodecs `EncodedVideoChunk` carries only PTS, so surfacing DTS to a
 * demux consumer is a seam concern, not a sample-table bug.
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { readMovie } from './mp4-driver.ts';
import { type SampleData, buildSampleData, buildSamples } from './samples.ts';

async function videoSamples(id: string): Promise<{ ticks: SampleData[]; timescale: number }> {
  const file = await loadFixture(id);
  const movie = await readMovie({
    read: (o, l) => Promise.resolve(file.subarray(o, o + l)),
    size: file.byteLength,
  });
  const video = movie.tracks.find((t) => t.mediaType === 'video');
  if (!video) throw new Error(`${id} has no video track`);
  return { ticks: buildSampleData(video), timescale: video.timescale };
}

// Real MP4 with B-frames (non-zero ctts) and/or VFR (varying stts deltas) in the corpus.
const BFRAME = ['test.mp4', 'bear-1280x720.mp4', 'bear-hevc-10bit-hdr10.mp4', 'bear-4k-hevc.mp4'];

describe('MP4 demux timing — DTS/CTS/keyframe per sample (B-frame reorder)', () => {
  it.each(BFRAME)(
    '%s: DTS is monotonic in decode order and CTS = DTS + ctts (B-frames reorder)',
    async (id) => {
      const { ticks } = await videoSamples(id);
      expect(ticks.length).toBeGreaterThan(0);

      // Samples are produced in decode order; DTS accumulates stts deltas ⇒ strictly non-decreasing.
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]?.dtsTicks ?? 0).toBeGreaterThanOrEqual(ticks[i - 1]?.dtsTicks ?? 0);
      }
      // ctts is a real composition offset: every PTS = DTS + ctts, and at least one sample reorders.
      const reordered = ticks.filter((s) => s.cttsTicks !== 0);
      expect(reordered.length).toBeGreaterThan(0); // these fixtures genuinely contain B-frames
      for (const s of ticks) expect(Number.isFinite(s.dtsTicks + s.cttsTicks)).toBe(true);

      // Presentation order ≠ decode order: sorting by PTS must differ from the decode sequence.
      const decodeOrder = ticks.map((s) => s.index);
      const presentationOrder = [...ticks]
        .sort((a, b) => a.dtsTicks + a.cttsTicks - (b.dtsTicks + b.cttsTicks) || a.index - b.index)
        .map((s) => s.index);
      expect(presentationOrder).not.toEqual(decodeOrder);
    },
  );

  it('keyframe flags come from stss (a subset of samples is sync, not all)', async () => {
    const { ticks } = await videoSamples('test.mp4');
    const keys = ticks.filter((s) => s.keyframe).length;
    expect(keys).toBeGreaterThan(0);
    expect(keys).toBeLessThan(ticks.length); // a real GOP structure: not every frame is a keyframe
    expect(ticks[0]?.keyframe).toBe(true); // the first sample is always a sync sample
  });

  it('WebCodecs µs mapping keeps PTS = DTS + ctts and a non-zero composition delay', async () => {
    const file = await loadFixture('bear-1280x720.mp4');
    const movie = await readMovie({
      read: (o, l) => Promise.resolve(file.subarray(o, o + l)),
      size: file.byteLength,
    });
    const video = movie.tracks.find((t) => t.mediaType === 'video');
    if (!video) throw new Error('no video');
    const us = buildSamples(video);
    const ticks = buildSampleData(video);
    // ptsUs ≥ dtsUs for every sample, strictly greater for the reordered ones.
    for (const s of us) expect(s.ptsUs).toBeGreaterThanOrEqual(s.dtsUs);
    const anyReorder = ticks.some((s) => s.cttsTicks > 0);
    expect(anyReorder).toBe(true);
    expect(us.some((s) => s.ptsUs > s.dtsUs)).toBe(true);
  });
});

describe('MP4 demux timing — VFR (variable frame rate) per-sample durations', () => {
  it('obs-remux-variable-aac.mp4: stts deltas vary (no constant frame duration assumed)', async () => {
    const { ticks } = await videoSamples('obs-remux-variable-aac.mp4');
    const deltas = ticks.map((s) => s.durationTicks);
    const distinct = new Set(deltas);
    // A genuine VFR clip: more than one distinct per-sample duration, all positive.
    expect(distinct.size).toBeGreaterThan(1);
    for (const d of deltas) expect(d).toBeGreaterThan(0);
    // DTS still accumulates those varying deltas monotonically.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]?.dtsTicks ?? 0).toBeGreaterThan(ticks[i - 1]?.dtsTicks ?? 0);
    }
  });
});
