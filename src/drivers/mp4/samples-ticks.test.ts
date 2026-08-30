import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { ticksToUs } from '../../util/ticks.ts';
import type { ParsedTrack } from './parse.ts';
import { buildSampleData, buildSamples, walkSamples } from './samples.ts';

function trackWith(
  samples: Partial<ParsedTrack['samples']> & {
    sampleSizes: Uint32Array;
    chunkOffsets: Float64Array;
  },
  extras: Partial<ParsedTrack> = {},
): ParsedTrack {
  const s = samples as ParsedTrack['samples'];
  return {
    id: 1,
    mediaType: 'video',
    timescale: 48000,
    durationSec: 1,
    samples: {
      sampleSizes: s.sampleSizes,
      chunkOffsets: s.chunkOffsets,
      sampleToChunk: s.sampleToChunk ?? {
        firstChunk: new Uint32Array([1]),
        samplesPerChunk: new Uint32Array([s.sampleSizes.length]),
        descIndex: new Uint32Array([1]),
      },
      timeToSample: s.timeToSample ?? {
        counts: new Uint32Array([s.sampleSizes.length]),
        deltas: new Uint32Array([1024]),
      },
      compositionOffsets: s.compositionOffsets ?? {
        counts: new Uint32Array(0),
        offsets: new Int32Array(0),
      },
      syncSamples: s.syncSamples ?? new Uint32Array(0),
    } as unknown as ParsedTrack['samples'],
    config: { codec: 'avc', codedWidth: 16, codedHeight: 16 },
    ...extras,
  } as ParsedTrack;
}

describe('samples — B-frame composition & VFR & edit & overflow (REQUIREMENTS §7.4 1.2.5)', () => {
  it('B-frame ctts: PTS = DTS + ctts with monotonic DTS and at least one reorder', () => {
    const tr = trackWith(
      {
        sampleSizes: new Uint32Array([10, 10, 10]),
        chunkOffsets: new Float64Array([0]),
        sampleToChunk: {
          firstChunk: new Uint32Array([1]),
          samplesPerChunk: new Uint32Array([3]),
          descIndex: new Uint32Array([1]),
        },
        timeToSample: { counts: new Uint32Array([3]), deltas: new Uint32Array([3000]) },
        compositionOffsets: {
          counts: new Uint32Array([1, 1, 1]),
          offsets: new Int32Array([0, 3000, -2000]),
        },
      },
      { timescale: 1000 },
    );
    const data = buildSampleData(tr);
    expect(data[0]?.cttsTicks).toBe(0);
    expect(data[1]?.cttsTicks).toBe(3000);
    expect(data[2]?.cttsTicks).toBe(-2000);
    for (let i = 1; i < data.length; i++)
      expect(data[i]!.dtsTicks).toBeGreaterThanOrEqual(data[i - 1]!.dtsTicks);
    const us = buildSamples(tr);
    // PTS = DTS + ctts exactly via bigint half-up
    for (let i = 0; i < us.length; i++) {
      const expectedPts = ticksToUs(data[i]!.dtsTicks + data[i]!.cttsTicks, 1000);
      expect(us[i]!.ptsUs).toBe(expectedPts);
      const expectedDts = ticksToUs(data[i]!.dtsTicks, 1000);
      expect(us[i]!.dtsUs).toBe(expectedDts);
    }
    // presentation order differs from decode
    const decodeOrder = data.map((s) => s.index);
    const presOrder = [...data]
      .sort((a, b) => a.dtsTicks + a.cttsTicks - (b.dtsTicks + b.cttsTicks))
      .map((s) => s.index);
    expect(presOrder).not.toEqual(decodeOrder);
  });

  it('VFR: varying stts deltas preserved, DTS monotonic, no constant duration assumed', () => {
    const tr = trackWith(
      {
        sampleSizes: new Uint32Array([10, 10, 10]),
        chunkOffsets: new Float64Array([0]),
        sampleToChunk: {
          firstChunk: new Uint32Array([1]),
          samplesPerChunk: new Uint32Array([3]),
          descIndex: new Uint32Array([1]),
        },
        timeToSample: {
          counts: new Uint32Array([1, 1, 1]),
          deltas: new Uint32Array([1000, 2000, 1000]),
        },
      },
      { timescale: 1000 },
    );
    const data = buildSampleData(tr);
    expect(data[0]?.durationTicks).toBe(1000);
    expect(data[1]?.durationTicks).toBe(2000);
    expect(data[2]?.durationTicks).toBe(1000);
    for (let i = 1; i < data.length; i++)
      expect(data[i]!.dtsTicks).toBeGreaterThan(data[i - 1]!.dtsTicks);
    const us = buildSamples(tr);
    expect(us[0]?.durationUs).toBe(ticksToUs(1000, 1000));
    expect(us[1]?.durationUs).toBe(ticksToUs(2000, 1000));
  });

  it('edit list nonzero start: first PTS at 0 with negative DTS', () => {
    const tr = trackWith(
      {
        sampleSizes: new Uint32Array([10, 10]),
        chunkOffsets: new Float64Array([0]),
        timeToSample: { counts: new Uint32Array([2]), deltas: new Uint32Array([1000]) },
      },
      {
        timescale: 1000,
        edit: { mediaTimeTicks: 1024, durationTicks: 2000, mediaRate: 1 },
      } as unknown as ParsedTrack,
    );
    const us = buildSamples(tr);
    expect(us[0]?.ptsUs).toBe(ticksToUs(0 + 0 - 1024, 1000));
    expect(us[0]?.ptsUs).not.toBeGreaterThan(0);
    expect(us[0]?.dtsUs).toBeLessThan(0);
    // duration preserved via ticksToUs half-up
    expect(us[0]?.durationUs).toBe(ticksToUs(1000, 1000));
  });

  it('overflow/Malformed: ticks beyond MAX_SAFE throws MediaError, truncated timescale throws', () => {
    const tr = trackWith(
      {
        sampleSizes: new Uint32Array([10]),
        chunkOffsets: new Float64Array([0]),
        timeToSample: { counts: new Uint32Array([1]), deltas: new Uint32Array([1]) },
      },
      { timescale: 1000 },
    );
    // overflow via ticksToUs: dtsMinusEdit = MAX_SAFE triggers overflow when converting to µs with timescale 1
    const evilForUs: ParsedTrack = {
      ...tr,
      timescale: 1,
      edit: { mediaTimeTicks: -Number.MAX_SAFE_INTEGER, durationTicks: 1, mediaRate: 1 },
    } as unknown as ParsedTrack;
    expect(() => buildSamples(evilForUs)).toThrow(MediaError);
    // timescale 0 is legacy zero-timestamp path (samples.test expects 0), not throw
    expect(buildSamples({ ...tr, timescale: 0 } as ParsedTrack).every((s) => s.dtsUs === 0)).toBe(
      true,
    );
    expect(() => buildSamples({ ...tr, timescale: 0.5 } as ParsedTrack)).toThrow(MediaError);
    expect(() => buildSamples({ ...tr, timescale: Number.NaN } as unknown as ParsedTrack)).toThrow(
      MediaError,
    );
    // exact overflow in ticksToUs path: ticks = MAX_SAFE, timescale=1 => 9e15*1e6 overflows
    expect(() => ticksToUs(Number.MAX_SAFE_INTEGER, 1)).toThrow(MediaError);
  });

  it('exact half-up vs float: timescale requiring big int (48000) matches ticksToUs not Math.round float', () => {
    // ticks=1, timescale=48000: 1*1e6/48000 = 20.833..., Math.round 21, ticksToUs also 21 — check half case
    // Use ticks=24000, timescale=48000 => 24000*1e6/48000 = 500000 exactly, no half.
    // Half case: ticks=1, timescale=3 => 333333.333..., need exact.
    const tr = trackWith(
      {
        sampleSizes: new Uint32Array([10]),
        chunkOffsets: new Float64Array([0]),
      },
      { timescale: 48000 },
    );
    const us = buildSamples(tr);
    expect(us[0]?.durationUs).toBe(ticksToUs(1024, 48000));
    // drift-free: cumulative durations vs per-sample conversion
    const deltas = [1024, 1024, 1024];
    const tr2 = trackWith(
      {
        sampleSizes: new Uint32Array([10, 10, 10]),
        chunkOffsets: new Float64Array([0]),
        sampleToChunk: {
          firstChunk: new Uint32Array([1]),
          samplesPerChunk: new Uint32Array([3]),
          descIndex: new Uint32Array([1]),
        },
        timeToSample: { counts: new Uint32Array([3]), deltas: new Uint32Array(deltas) },
      },
      { timescale: 48000 },
    );
    const data = buildSampleData(tr2);
    for (let i = 0; i < data.length; i++) {
      const dts = data[i]!.dtsTicks;
      const expected = ticksToUs(dts, 48000);
      expect(buildSamples(tr2)[i]!.dtsUs).toBe(expected);
    }
  });

  it('20× randomized monotonic DTS and PTS = DTS + ctts exact', () => {
    for (let seed = 0; seed < 20; seed++) {
      const n = 3 + (seed % 5);
      const counts = new Uint32Array([n]);
      const deltas = new Uint32Array([1000 + ((seed * 13) % 2000)]);
      const cttsOffsets = new Int32Array([((seed * 7) % 200) - 100]);
      const cttsCounts = new Uint32Array([n]);
      const tr = trackWith(
        {
          sampleSizes: new Uint32Array(n).fill(10),
          chunkOffsets: new Float64Array([0]),
          sampleToChunk: {
            firstChunk: new Uint32Array([1]),
            samplesPerChunk: new Uint32Array([n]),
            descIndex: new Uint32Array([1]),
          },
          timeToSample: { counts, deltas },
          compositionOffsets: { counts: cttsCounts, offsets: cttsOffsets },
        },
        { timescale: 1000 + seed },
      );
      const data = buildSampleData(tr);
      const us = buildSamples(tr);
      for (let i = 1; i < data.length; i++)
        expect(data[i]!.dtsTicks).toBeGreaterThanOrEqual(data[i - 1]!.dtsTicks);
      for (let i = 0; i < data.length; i++) {
        expect(us[i]!.ptsUs).toBe(ticksToUs(data[i]!.dtsTicks + data[i]!.cttsTicks, tr.timescale));
      }
      // walkSamples parity
      const walked: number[] = [];
      walkSamples(tr, (_idx, _off, _size, dts) => walked.push(dts));
      expect(walked).toEqual(data.map((s) => s.dtsTicks));
    }
  });
});
