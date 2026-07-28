import { describe, expect, it } from 'vitest';
import type { ParsedTrack, SampleTable } from './parse.ts';
import {
  buildSampleData,
  buildSamples,
  walkSampleClassificationRanges,
  walkSampleRanges,
} from './samples.ts';

function track(
  partial: Partial<SampleTable>,
  timescale = 1000,
  edit: ParsedTrack['edit'] = undefined,
): ParsedTrack {
  const samples: SampleTable = {
    timeToSample: partial.timeToSample ?? [],
    compositionOffsets: partial.compositionOffsets ?? [],
    sampleSizes: partial.sampleSizes ?? [],
    sampleToChunk: partial.sampleToChunk ?? [],
    chunkOffsets: partial.chunkOffsets ?? [],
    syncSamples: partial.syncSamples ?? [],
    sampleDependencies: partial.sampleDependencies ?? [],
  };
  const parsed: ParsedTrack = {
    id: 1,
    mediaType: 'video',
    timescale,
    durationSec: 1,
    codec: 'avc1',
    sampleEntryType: 'avc1',
    config: { codec: 'avc1' },
    samples,
  };
  return edit === undefined ? parsed : { ...parsed, edit };
}

const oneChunk = {
  chunkOffsets: [100],
  sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
  sampleSizes: [10, 20],
  timeToSample: [{ count: 2, delta: 500 }],
};

describe('buildSamples', () => {
  it('walks the exact normalized sample ranges without materializing timing or sync state', () => {
    const parsed = track({
      chunkOffsets: [100, 200, 400],
      sampleToChunk: [
        { firstChunk: 1, samplesPerChunk: 2, descIndex: 1 },
        { firstChunk: 3, samplesPerChunk: 1, descIndex: 1 },
      ],
      sampleSizes: [10, 20, 30, 40, 0],
      timeToSample: [{ count: 5, delta: 100 }],
      compositionOffsets: [{ count: 5, offset: -25 }],
      syncSamples: [4, 1],
    });
    const ranges: Array<readonly [number, number, number]> = [];

    const visited = walkSampleRanges(parsed, (index, offset, size) =>
      ranges.push([index, offset, size]),
    );

    expect(visited).toBe(5);
    expect(ranges).toEqual(
      buildSampleData(parsed).map((sample): readonly [number, number, number] => [
        sample.index,
        sample.offset,
        sample.size,
      ]),
    );
    expect(ranges).toEqual([
      [0, 100, 10],
      [1, 110, 20],
      [2, 200, 30],
      [3, 230, 40],
      [4, 400, 0],
    ]);
  });

  it('preserves large normalized co64 offsets and early chunk exhaustion', () => {
    const parsed = track({
      chunkOffsets: [2 ** 32 + 64],
      sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 2, descIndex: 1 }],
      sampleSizes: [7, 11, 13],
      timeToSample: [{ count: 3, delta: 1 }],
    });
    const ranges: Array<readonly [number, number, number]> = [];

    const visited = walkSampleRanges(parsed, (index, offset, size) =>
      ranges.push([index, offset, size]),
    );

    expect(visited).toBe(2);
    expect(ranges).toEqual([
      [0, 2 ** 32 + 64, 7],
      [1, 2 ** 32 + 71, 11],
    ]);
  });

  it('walks classification ranges with exact sorted and unsorted stss truth', () => {
    const sorted = track({
      chunkOffsets: [100, 200],
      sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 3, descIndex: 1 }],
      sampleSizes: [10, 20, 30, 40, 50],
      syncSamples: [1, 4],
    });
    const sortedRows: Array<readonly [number, number, number, boolean]> = [];

    expect(
      walkSampleClassificationRanges(sorted, (index, offset, size, declaredSync) =>
        sortedRows.push([index, offset, size, declaredSync]),
      ),
    ).toBe(5);
    expect(sortedRows).toEqual([
      [0, 100, 10, true],
      [1, 110, 20, false],
      [2, 130, 30, false],
      [3, 200, 40, true],
      [4, 240, 50, false],
    ]);

    const unsortedRows: boolean[] = [];
    const unsorted = track({ ...oneChunk, syncSamples: [2, 1] });
    expect(
      walkSampleClassificationRanges(unsorted, (_index, _offset, _size, declaredSync) =>
        unsortedRows.push(declaredSync),
      ),
    ).toBe(2);
    expect(unsortedRows).toEqual([true, true]);
  });

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

  it('honors a negative composition offset — PTS earlier than DTS (real .mov version-0 ctts)', () => {
    // ffmpeg-authored .mov B-frame reorder carries genuinely-negative ctts offsets (read signed by
    // parse); buildSamples must let PTS fall below DTS rather than clamp or overflow.
    const s = buildSamples(
      track({
        ...oneChunk,
        compositionOffsets: [
          { count: 1, offset: 0 },
          { count: 1, offset: -250 },
        ],
      }),
    );
    expect(s[0]?.ptsUs).toBe(0);
    expect(s[1]?.dtsUs).toBe(500_000);
    expect(s[1]?.ptsUs).toBe(250_000); // 500 − 250 ticks → composition time precedes decode time
  });

  it('applies an edit-list media_time offset to packet PTS/DTS', () => {
    const s = buildSamples(
      track({ ...oneChunk, compositionOffsets: [{ count: 2, offset: 250 }] }, 1000, {
        mediaTimeTicks: 250,
        durationSec: 1,
        durationMovieTicks: 1_000,
        movieTimescale: 1_000,
      }),
    );
    expect(s[0]?.ptsUs).toBe(0);
    expect(s[0]?.dtsUs).toBe(-250_000);
    expect(s[1]?.ptsUs).toBe(500_000);
    expect(s[1]?.dtsUs).toBe(250_000);
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

  it('walks stsc, stts, ctts, and stss run changes in one decode-order pass', () => {
    const parsed = track({
      chunkOffsets: [100, 200, 300],
      sampleToChunk: [
        { firstChunk: 1, samplesPerChunk: 2, descIndex: 1 },
        { firstChunk: 3, samplesPerChunk: 1, descIndex: 1 },
      ],
      sampleSizes: [10, 20, 30, 40, 50],
      timeToSample: [
        { count: 2, delta: 100 },
        { count: 2, delta: 200 },
        { count: 1, delta: 300 },
      ],
      compositionOffsets: [
        { count: 3, offset: 0 },
        { count: 1, offset: 50 },
      ],
      syncSamples: [1, 4],
    });

    const ticks = buildSampleData(parsed);
    expect(ticks.map((s) => s.offset)).toEqual([100, 110, 200, 230, 300]);
    expect(ticks.map((s) => s.dtsTicks)).toEqual([0, 100, 200, 400, 600]);
    expect(ticks.map((s) => s.durationTicks)).toEqual([100, 100, 200, 200, 300]);
    expect(ticks.map((s) => s.cttsTicks)).toEqual([0, 0, 0, 50, 50]);
    expect(ticks.map((s) => s.keyframe)).toEqual([true, false, false, true, false]);

    const us = buildSamples(parsed);
    expect(us.map((s) => s.dtsUs)).toEqual([0, 100_000, 200_000, 400_000, 600_000]);
    expect(us.map((s) => s.ptsUs)).toEqual([0, 100_000, 200_000, 450_000, 650_000]);
  });

  it('keeps sync-sample flags for malformed unsorted stss tables', () => {
    const s = buildSamples(track({ ...oneChunk, syncSamples: [2, 1] }));
    expect(s.map((sample) => sample.keyframe)).toEqual([true, true]);
  });
});
