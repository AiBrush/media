import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { qualityConstrainedEncoderRateConfig } from './video-quality-rate-config.ts';

const QUALITY = { metric: 'ssim-luma-v1' as const, minimumMean: 0.95, samples: 4 };

describe('objective-quality encoder rate configuration', () => {
  it('leaves ordinary rate control untouched and selects quantizer mode for a valid H.264 tuple', () => {
    expect(qualityConstrainedEncoderRateConfig({}, 'h264')).toBeUndefined();
    expect(
      qualityConstrainedEncoderRateConfig(
        { bitrate: 1_000_000, maxAverageBitrate: 1_200_000, quality: QUALITY },
        'h264',
      ),
    ).toEqual({ bitrateMode: 'quantizer' });
  });

  it.each([
    [{ maxAverageBitrate: 1_200_000, quality: QUALITY }, 'quality-constrained bitrate'],
    [
      { bitrate: 1_000_000, maxAverageBitrate: Number.MAX_SAFE_INTEGER + 1, quality: QUALITY },
      'maxAverageBitrate',
    ],
    [{ bitrate: 1_000_000, maxAverageBitrate: 0, quality: QUALITY }, 'maxAverageBitrate'],
    [{ bitrate: 1_000_000, maxAverageBitrate: 1_200_000 }, 'objective quality constraint'],
    [{ bitrate: 1_200_000, maxAverageBitrate: 1_000_000, quality: QUALITY }, 'at least bitrate'],
  ] as const)('rejects an invalid quality/rate tuple (%s)', (target, message) => {
    expect(() => qualityConstrainedEncoderRateConfig(target, 'h264')).toThrowError(InputError);
    expect(() => qualityConstrainedEncoderRateConfig(target, 'h264')).toThrowError(message);
  });

  it.each([{ crf: 20 }, { bitrateMode: 'variable' as const }, { twoPass: true }])(
    'rejects the conflicting $s rate-control mode',
    (conflict) => {
      expect(() =>
        qualityConstrainedEncoderRateConfig(
          { bitrate: 1_000_000, maxAverageBitrate: 1_200_000, quality: QUALITY, ...conflict },
          'h264',
        ),
      ).toThrowError(/conflicts/);
    },
  );

  it('reports non-H.264 objective-quality routing as a typed capability miss', () => {
    expect(() =>
      qualityConstrainedEncoderRateConfig(
        { bitrate: 1_000_000, maxAverageBitrate: 1_200_000, quality: QUALITY },
        'vp9',
      ),
    ).toThrowError(CapabilityError);
  });
});
