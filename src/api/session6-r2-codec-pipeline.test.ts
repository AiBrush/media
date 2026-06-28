import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { buildVideoEncoderConfig, videoAlphaOption } from './codec-pipeline.ts';
import { trimEncodeTrack } from './trim-streams.ts';

describe('Session 6 R2 codec edge planning', () => {
  it('keeps ordinary VP9 encode configs alpha-neutral unless the caller asks', () => {
    const config = buildVideoEncoderConfig({ codec: 'vp9' }, { width: 64, height: 64 }, undefined);

    expect(config).toMatchObject({
      codec: 'vp09.00.10.08',
      width: 64,
      height: 64,
    });
    expect(config.alpha).toBeUndefined();
    expect(videoAlphaOption({}, 'vp09.00.10.08')).toBeUndefined();
  });

  it('preserves VP9 alpha only when explicit alpha keep is requested', () => {
    const config = buildVideoEncoderConfig(
      { codec: 'vp9', alpha: 'keep' },
      { width: 64, height: 64 },
      undefined,
    );

    expect(config.alpha).toBe('keep');
    expect(videoAlphaOption({ alpha: 'keep' }, 'vp09.00.10.08')).toBe('keep');
  });

  it('lets callers explicitly discard VP9 alpha when the target asks for it', () => {
    expect(videoAlphaOption({ alpha: 'discard' }, 'vp09.00.10.08')).toBe('discard');
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9', alpha: 'discard' },
        { width: 64, height: 64 },
        undefined,
      ).alpha,
    ).toBe('discard');
  });

  it('rejects explicit alpha preservation on codecs that cannot carry it', () => {
    expect(() => videoAlphaOption({ alpha: 'keep' }, 'avc1.64001f')).toThrow(CapabilityError);
  });

  it('keeps HEVC Main8 reachable through accurate-trim encode planning', () => {
    const sourceTrack: TrackInfo = {
      id: 7,
      mediaType: 'video',
      codec: 'hvc1.1.6.L150.90',
      durationSec: 2,
      config: { codec: 'hvc1.1.6.L150.90', codedWidth: 3840, codedHeight: 2160 },
    };

    const trimmedTrack = trimEncodeTrack(sourceTrack);
    const config = buildVideoEncoderConfig({}, { width: 3840, height: 2160 }, trimmedTrack.codec);

    expect(trimmedTrack.durationSec).toBeUndefined();
    expect(config.codec).toBe('hvc1.1.6.L150.90');
    expect(config.width).toBe(3840);
    expect(config.height).toBe(2160);
  });
});
