import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import type { VideoQualityConstraint, VideoTarget } from '../index.ts';
import { validateVideoTarget } from './job-schema-targets.ts';

const QUALITY: VideoQualityConstraint = {
  metric: 'ssim-luma-v1',
  minimumMean: 0.93,
  samples: 8,
};

describe('quality-constrained video target schema', () => {
  it('accepts and snapshots an explicit preferred-rate, ceiling, and quality contract', () => {
    const quality = { ...QUALITY };
    const target: VideoTarget = {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      quality,
    };

    const result = validateVideoTarget(target, 'video');

    expect(result).toEqual(target);
    expect(result).not.toBe(target);
    expect(result.quality).not.toBe(quality);
  });

  it.each([0, 1])('accepts the inclusive minimumMean endpoint %s', (minimumMean) => {
    expect(
      validateVideoTarget(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { ...QUALITY, minimumMean },
        },
        'video',
      ).quality?.minimumMean,
    ).toBe(minimumMean);
  });

  it.each([1, 256])('accepts the bounded sample-count endpoint %s', (samples) => {
    expect(
      validateVideoTarget(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { ...QUALITY, samples },
        },
        'video',
      ).quality?.samples,
    ).toBe(samples);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxAverageBitrate %s',
    (maxAverageBitrate) => {
      expect(() => validateVideoTarget({ bitrate: 1, maxAverageBitrate }, 'video')).toThrow(
        InputError,
      );
    },
  );

  it('requires a preferred bitrate when maxAverageBitrate is present', () => {
    expect(() => validateVideoTarget({ maxAverageBitrate: 2_600_000 }, 'video')).toThrow(
      /maxAverageBitrate requires bitrate/,
    );
  });

  it('requires maxAverageBitrate to be at least the preferred bitrate', () => {
    expect(() =>
      validateVideoTarget({ bitrate: 2_000_000, maxAverageBitrate: 1_999_999 }, 'video'),
    ).toThrow(/maxAverageBitrate must be greater than or equal to bitrate/);
  });

  it('accepts maxAverageBitrate equal to the preferred bitrate', () => {
    expect(
      validateVideoTarget(
        { bitrate: 2_000_000, maxAverageBitrate: 2_000_000, quality: QUALITY },
        'video',
      ).maxAverageBitrate,
    ).toBe(2_000_000);
  });

  it('requires quality when maxAverageBitrate is present', () => {
    expect(() =>
      validateVideoTarget({ bitrate: 2_000_000, maxAverageBitrate: 2_600_000 }, 'video'),
    ).toThrow(/maxAverageBitrate requires quality/);
  });

  it.each([{ quality: QUALITY }, { bitrate: 2_000_000, quality: QUALITY }])(
    'requires both rate fields when quality is present',
    (target) => {
      expect(() => validateVideoTarget(target, 'video')).toThrow(InputError);
    },
  );

  it.each([
    { quality: null },
    { quality: [] },
    { quality: { minimumMean: 0.93 } },
    { quality: { ...QUALITY, metric: 'ssim' } },
    { quality: { metric: 'ssim-luma-v1' } },
    { quality: { ...QUALITY, minimumMean: -Number.EPSILON } },
    { quality: { ...QUALITY, minimumMean: 1 + Number.EPSILON } },
    { quality: { ...QUALITY, minimumMean: Number.NaN } },
    { quality: { ...QUALITY, samples: 0 } },
    { quality: { ...QUALITY, samples: -1 } },
    { quality: { ...QUALITY, samples: 1.5 } },
    { quality: { ...QUALITY, samples: 257 } },
    { quality: { ...QUALITY, samples: Number.MAX_SAFE_INTEGER + 1 } },
    { quality: { ...QUALITY, percentile: 0.2 } },
  ])('rejects malformed quality shape %#', ({ quality }) => {
    expect(() =>
      validateVideoTarget({ bitrate: 2_000_000, maxAverageBitrate: 2_600_000, quality }, 'video'),
    ).toThrow(InputError);
  });

  it.each([
    ['crf', 20],
    ['crf', undefined],
    ['bitrateMode', 'variable'],
    ['bitrateMode', undefined],
    ['twoPass', true],
    ['twoPass', false],
    ['twoPass', undefined],
  ] as const)('rejects quality combined with explicit %s', (field, value) => {
    expect(() =>
      validateVideoTarget(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: QUALITY,
          [field]: value,
        },
        'video',
      ),
    ).toThrow(new RegExp(`quality cannot combine with ${field}`));
  });
});
