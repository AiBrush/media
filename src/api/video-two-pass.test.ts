import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import {
  implicitRateControlWarmupFrames,
  installH264TwoPassQuantizer,
  sourceGeometryOf,
} from './video-two-pass-runner.ts';
import {
  type H264FirstPassSample,
  H264_FIRST_PASS_QUANTIZER,
  planH264TwoPass,
} from './video-two-pass.ts';

function sample(
  timestampUs: number,
  byteLength: number,
  durationUs = 40_000,
  keyFrame = false,
): H264FirstPassSample {
  return { timestampUs, durationUs, byteLength, keyFrame };
}

describe('planH264TwoPass', () => {
  it('warms only implicit H.264/AV1 bitrate control without changing explicit contracts', () => {
    expect(implicitRateControlWarmupFrames({}, 'avc1.64001F', 30)).toBe(3);
    expect(implicitRateControlWarmupFrames({}, 'av01.0.12M.08', 60)).toBe(8);
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.0000003)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.5)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.500001)).toBe(8);
    expect(implicitRateControlWarmupFrames({}, 'AVC3.64001F', undefined)).toBe(3);
    expect(implicitRateControlWarmupFrames({}, 'vp09.00.31.08', 60)).toBeUndefined();
    expect(
      implicitRateControlWarmupFrames({ bitrate: 2_000_000 }, 'avc1.64001F', 30),
    ).toBeUndefined();
    expect(
      implicitRateControlWarmupFrames({ bitrateMode: 'constant' }, 'avc1.64001F', 30),
    ).toBeUndefined();
    expect(implicitRateControlWarmupFrames({ crf: 22 }, 'av01.0.12M.08', 60)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({ twoPass: true }, 'avc1.64001F', 30)).toBeUndefined();
  });

  it('maps known and unknown source geometry without inventing dimensions', () => {
    const known: TrackInfo = {
      id: 0,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'avc1.42E01E', codedWidth: 320, codedHeight: 240 },
      fps: 25,
      durationSec: 1,
    };
    expect(sourceGeometryOf(known)).toEqual({
      width: 320,
      height: 240,
      fps: 25,
      durationSec: 1,
    });
    expect(sourceGeometryOf({ id: 1, mediaType: 'video', codec: 'h264', durationSec: 0 })).toEqual({
      width: undefined,
      height: undefined,
    });
  });

  it('turns fixed-QP evidence into a bounded complexity-weighted target schedule', () => {
    const samples = [sample(0, 1_000, 40_000, true), sample(40_000, 4_000)];
    const bitrate = (5000 * 8) / 0.08;
    const plan = planH264TwoPass(samples, bitrate, 0.08);

    expect(H264_FIRST_PASS_QUANTIZER).toBe(28);
    expect(plan.sampleCount).toBe(2);
    expect(plan.firstPassBytes).toBe(5_000);
    expect(plan.targetBytes).toBe(5_000);
    expect(plan.evidenceBytes).toBe(18);
    expect(Math.abs(plan.predictedBytes - plan.targetBytes) / plan.targetBytes).toBeLessThan(0.15);
    expect(plan.quantizerForTimestamp(0)).toBeGreaterThanOrEqual(0);
    expect(plan.quantizerForTimestamp(40_000)).toBeLessThanOrEqual(51);
    expect(plan.quantizerForTimestamp(0)).not.toBe(plan.quantizerForTimestamp(40_000));
  });

  it('keys B-frame evidence by PTS rather than callback order', () => {
    const plan = planH264TwoPass(
      [sample(80_000, 900), sample(0, 1_800, 40_000, true), sample(40_000, 600)],
      240_000,
      0.12,
    );
    expect(Array.from(plan.timestampsUs)).toEqual([0, 40_000, 80_000]);
    expect(plan.quantizerForTimestamp(80_000)).toBeTypeOf('number');
    expect(plan.quantizerForTimestamp(0)).toBeTypeOf('number');
  });

  it('uses VFR durations and a declared tail without assuming constant frame rate', () => {
    const plan = planH264TwoPass(
      [
        sample(0, 800, 20_000, true),
        sample(20_000, 1_200, 80_000),
        { timestampUs: 100_000, byteLength: 600, keyFrame: false },
      ],
      400_000,
      0.15,
    );
    expect(plan.durationUs).toBe(150_000);
    expect(plan.targetBytes).toBe(7_500);
  });

  it('anchors a declared duration to a non-zero first PTS', () => {
    const plan = planH264TwoPass(
      [
        { timestampUs: 1_000_000, byteLength: 900, keyFrame: true },
        { timestampUs: 1_040_000, byteLength: 700, keyFrame: false },
      ],
      200_000,
      0.08,
    );
    expect(plan.durationUs).toBe(80_000);
    expect(plan.targetBytes).toBe(2_000);
  });

  it('rejects duplicate/missing timestamps and invalid budgets instead of degrading to one pass', () => {
    expect(() => planH264TwoPass([sample(0, 100), sample(0, 200)], 100_000, 0.08)).toThrow(
      InputError,
    );
    const plan = planH264TwoPass([sample(0, 100)], 100_000, 0.04);
    expect(() => plan.quantizerForTimestamp(40_000)).toThrow(InputError);
    expect(() => planH264TwoPass([sample(0, 100)], 0, 0.04)).toThrow(InputError);
    expect(() => planH264TwoPass([], 100_000, 0.04)).toThrow(InputError);
  });

  it('rejects non-integral timeline facts and empty pictures before allocation', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: -1, byteLength: 100, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0.5, byteLength: 100, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 0, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass(
        [{ timestampUs: 0, byteLength: 100, keyFrame: true, durationUs: 0 }],
        100_000,
        1,
      ),
    ).toThrow(InputError);
  });

  it('derives the final VFR duration from the previous presentation timestamp', () => {
    const plan = planH264TwoPass(
      [
        { timestampUs: 0, durationUs: 40_000, byteLength: 100, keyFrame: true },
        { timestampUs: 40_000, byteLength: 200, keyFrame: false },
      ],
      200_000,
    );
    expect(plan.durationUs).toBe(80_000);
  });

  it('rejects a one-picture pass without a declared or measured duration', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, keyFrame: true }], 100_000),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, keyFrame: true }], 100_000, 0),
    ).toThrow(InputError);
  });

  it('rejects a target budget that rounds to zero for an ultra-short timeline', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, durationUs: 1, keyFrame: true }], 1),
    ).toThrow(InputError);
  });

  it('rejects an aggregate first-pass size that exceeds safe integer accounting', () => {
    const picture = {
      byteLength: Number.MAX_SAFE_INTEGER,
      durationUs: 40_000,
      keyFrame: false,
    } as const;
    expect(() =>
      planH264TwoPass(
        [
          { timestampUs: 0, ...picture },
          { timestampUs: 40_000, ...picture },
        ],
        1_000_000,
      ),
    ).toThrow(InputError);
  });

  it('installs a timestamp-checked replay quantizer and detects lifecycle mismatches', () => {
    const plan = planH264TwoPass(
      [sample(0, 1_000, 40_000, true), sample(40_000, 1_200)],
      220_000,
      0.08,
    );
    const installation = installH264TwoPassQuantizer({}, plan);
    const selector = installation.stage.quantizerAt;
    expect(selector).toBeDefined();
    if (selector === undefined) throw new Error('quantizer selector was not installed');

    const frame = (timestampUs: number) => ({
      index: timestampUs / 40_000,
      timestampUs,
      durationUs: 40_000,
      keyFrame: timestampUs === 0,
    });
    expect(selector(frame(0))).toBeTypeOf('number');
    expect(selector(frame(40_000))).toBeTypeOf('number');
    expect(() => selector(frame(40_000))).toThrow(InputError);
    expect(() => installation.assertComplete()).not.toThrow();

    const incomplete = installH264TwoPassQuantizer({}, plan);
    const incompleteSelector = incomplete.stage.quantizerAt;
    expect(incompleteSelector).toBeDefined();
    if (incompleteSelector === undefined) throw new Error('quantizer selector was not installed');
    incompleteSelector(frame(0));
    expect(() => incomplete.assertComplete()).toThrow(InputError);
  });
});
