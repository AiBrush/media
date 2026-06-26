import { describe, expect, it } from 'vitest';
import type { ParsedTrack, SampleTable } from './parse.ts';
import { buildSamples } from './samples.ts';

function track(partial: Partial<SampleTable>, timescale = 1000): ParsedTrack {
  const samples: SampleTable = {
    timeToSample: partial.timeToSample ?? [],
    compositionOffsets: partial.compositionOffsets ?? [],
    sampleSizes: partial.sampleSizes ?? [],
    sampleToChunk: partial.sampleToChunk ?? [],
    chunkOffsets: partial.chunkOffsets ?? [],
    syncSamples: partial.syncSamples ?? [],
  };
  return {
    id: 1,
    mediaType: 'video',
    timescale,
    durationSec: 1,
    codec: 'avc1',
    sampleEntryType: 'avc1',
    config: { codec: 'avc1' },
    samples,
  };
}

const oneChunk = {
  chunkOffsets: [100],
  sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
  sampleSizes: [10, 20],
  timeToSample: [{ count: 2, delta: 500 }],
};

describe('buildSamples', () => {
  it('computes offsets, sizes, timestamps, and all-sync keyframes', () => {
    expect(buildSamples(track(oneChunk))).toEqual([
      { index: 0, offset: 100, size: 10, dtsUs: 0, ptsUs: 0, durationUs: 500_000, keyframe: true },
      {
        index: 1,
        offset: 110,
        size: 20,
        dtsUs: 500_000,
        ptsUs: 500_000,
        durationUs: 500_000,
        keyframe: true,
      },
    ]);
  });

  it('adds the ctts composition offset to PTS (B-frame reordering)', () => {
    const s = buildSamples(track({ ...oneChunk, compositionOffsets: [{ count: 2, offset: 250 }] }));
    expect(s[0]?.ptsUs).toBe(250_000);
    expect(s[0]?.dtsUs).toBe(0);
    expect(s.some((x) => x.ptsUs !== x.dtsUs)).toBe(true);
  });

  it('honors stss: only listed samples are keyframes', () => {
    const s = buildSamples(track({ ...oneChunk, syncSamples: [1] }));
    expect(s[0]?.keyframe).toBe(true);
    expect(s[1]?.keyframe).toBe(false);
  });

  it('walks multiple chunks', () => {
    const s = buildSamples(
      track({
        chunkOffsets: [100, 200],
        sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 1, descIndex: 1 }],
        sampleSizes: [10, 20],
        timeToSample: [{ count: 2, delta: 100 }],
      }),
    );
    expect(s.map((x) => x.offset)).toEqual([100, 200]);
  });

  it('pads when the stts run-length is shorter than the sample count', () => {
    const s = buildSamples(
      track({
        chunkOffsets: [0],
        sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
        sampleSizes: [10, 20],
        timeToSample: [{ count: 1, delta: 100 }],
      }),
    );
    expect(s[1]?.dtsUs).toBe(100_000); // second delta padded from the last value
  });

  it('uses zero durations when a malformed sample table omits stts entries', () => {
    const s = buildSamples(
      track({
        chunkOffsets: [0],
        sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
        sampleSizes: [10, 20],
        timeToSample: [],
      }),
    );
    expect(s.map((x) => x.durationUs)).toEqual([0, 0]);
    expect(s.map((x) => x.dtsUs)).toEqual([0, 0]);
  });

  it('returns zero timestamps when the timescale is zero', () => {
    const s = buildSamples(track(oneChunk, 0));
    expect(s.every((x) => x.dtsUs === 0 && x.ptsUs === 0 && x.durationUs === 0)).toBe(true);
  });

  it('stops when chunks run out before all samples are placed', () => {
    const s = buildSamples(
      track({
        chunkOffsets: [100], // only one chunk
        sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
        sampleSizes: [10, 20, 30], // but three samples declared
        timeToSample: [{ count: 3, delta: 100 }],
      }),
    );
    expect(s).toHaveLength(2);
  });
});
