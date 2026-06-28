import { describe, expect, it } from 'vitest';
import { normalizeVideoDecoderConfig, videoCodecCanCarryAlpha } from './webcodecs-video.ts';

type DecoderConfigWithAlpha = VideoDecoderConfig & { alpha?: AlphaOption };

describe('WebCodecs video alpha normalization', () => {
  it('keeps alpha on VP8/VP9 decode configs, including RFC 6381 vp09 strings', () => {
    for (const codec of ['vp8', 'vp8.0', 'vp9', 'vp09.00.10.08']) {
      const config = normalizeVideoDecoderConfig(
        { codec, codedWidth: 32, codedHeight: 18 },
        'prefer-hardware',
      );
      expect(config.hardwareAcceleration).toBe('prefer-hardware');
      expect((config as DecoderConfigWithAlpha).alpha).toBe('keep');
      expect(videoCodecCanCarryAlpha(codec)).toBe(true);
    }
  });

  it('does not invent alpha semantics for non-VPx codecs', () => {
    const config = normalizeVideoDecoderConfig(
      { codec: 'avc1.64001f', codedWidth: 32, codedHeight: 18 },
      'prefer-software',
    );
    expect(config.hardwareAcceleration).toBe('prefer-software');
    expect((config as DecoderConfigWithAlpha).alpha).toBeUndefined();
    expect(videoCodecCanCarryAlpha('avc1.64001f')).toBe(false);
  });
});
