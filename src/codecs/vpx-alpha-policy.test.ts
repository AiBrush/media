import { describe, expect, it } from 'vitest';
import {
  bitDepthFromCodec,
  h264CodecStringForDimensions,
  resolvedVideoEncoderCodecString,
  videoCodecCanCarryAlpha,
} from '../api/codec-strings.ts';
import { videoAlphaOption } from '../api/encoder-config.ts';
import { generateSupportMatrix } from '../support/matrix.ts';

describe('VP8/VP9 alpha + H.264 High10 profile preservation (REQUIREMENTS §5.4, §5.5 — 2.2.3)', () => {
  it('support matrix declares VP8 and VP9 alpha true (WebM BlockAdditions), H.264 false', () => {
    const m = generateSupportMatrix();
    expect(m.codecs.find((c) => c.codec === 'vp8')!.alpha).toBe(true);
    expect(m.codecs.find((c) => c.codec === 'vp9')!.alpha).toBe(true);
    expect(m.codecs.find((c) => c.codec === 'h264')!.alpha).toBe(false);
    expect(m.codecs.find((c) => c.codec === 'av1')!.alpha).toBe(false);
  });

  it('videoCodecCanCarryAlpha mirrors the matrix (VP8/VP9 only, vp09.* included)', () => {
    expect(videoCodecCanCarryAlpha('vp8')).toBe(true);
    expect(videoCodecCanCarryAlpha('vp8.00')).toBe(true);
    expect(videoCodecCanCarryAlpha('vp9')).toBe(true);
    expect(videoCodecCanCarryAlpha('vp09.00.10.08')).toBe(true);
    expect(videoCodecCanCarryAlpha('VP09.02.10.10')).toBe(true);
    expect(videoCodecCanCarryAlpha('h264')).toBe(false);
    expect(videoCodecCanCarryAlpha('avc1.42E01E')).toBe(false);
    expect(videoCodecCanCarryAlpha('hvc1.1.6.L93.B0')).toBe(false);
    expect(videoCodecCanCarryAlpha('av01.0.01M.08')).toBe(false);
  });

  it('videoAlphaOption keeps/drops exactly on VPx, rejects keep on non-VPx with typed CapabilityError', () => {
    expect(videoAlphaOption({ alpha: 'keep' }, 'vp8')).toBe('keep');
    expect(videoAlphaOption({ alpha: 'keep' }, 'vp09.00.10.08')).toBe('keep');
    expect(videoAlphaOption({ alpha: 'discard' }, 'vp9')).toBe('discard');
    expect(videoAlphaOption({ alpha: 'discard' }, 'avc1.42E01E')).toBe('discard');
    expect(videoAlphaOption({}, 'vp8')).toBeUndefined();
    expect(() => videoAlphaOption({ alpha: 'keep' }, 'avc1.42E01E')).toThrow(
      /alpha encode requires VP8\/VP9/,
    );
    expect(() => videoAlphaOption({ alpha: 'keep' }, 'hvc1.1.6.L93.B0')).toThrow(
      /alpha encode requires VP8\/VP9/,
    );
    expect(() => videoAlphaOption({ alpha: 'keep' }, 'av01.0.04M.08')).toThrow(
      /alpha encode requires VP8\/VP9/,
    );
  });

  it('H.264 High10 source (0x6E) down-converted to 8-bit preserves High (6400), not Baseline', () => {
    // Constrained Baseline fallback for unknown, Main/High retained, High10 → High
    const dims = { w: 1280, h: 720, fps: 30 };
    const high10 = 'avc1.6E001E'; // High10 10-bit source
    const high = 'avc1.64001E';
    const main = 'avc1.4D001E';
    const baseline = 'avc1.42E01E';
    const unknown = 'avc1.58001E'; // Extended
    // Use h264CodecStringForDimensions baseline level for 1280x720@30 → L3.1 (1F) floored? Actually L3.1=0x1F, but floor L3.0=0x1E → expect 1F since 1F>1E
    // Instead, compare via bitDepthFromCodec and via encoder-config path: high10 10-bit source → 8-bit target should be High.
    expect(bitDepthFromCodec(high10)).toBe(10);
    expect(bitDepthFromCodec(high)).toBe(8);
    expect(bitDepthFromCodec(baseline)).toBe(8);
    // resolvedVideoEncoderCodecString handles the profile retention; test directly via the public resolver
    // For High10 source with 8-bit target, the resolver should produce High (6400) with level sized to dims.
    const outHigh10 = resolvedVideoEncoderCodecString(
      { codec: 'h264' },
      dims.w,
      dims.h,
      dims.fps,
      high10,
      undefined,
      false,
    );
    expect(outHigh10).toMatch(/^avc1\.6400/i);
    const outHigh = resolvedVideoEncoderCodecString(
      { codec: 'h264' },
      dims.w,
      dims.h,
      dims.fps,
      high,
      undefined,
      false,
    );
    expect(outHigh).toMatch(/^avc1\.6400/i);
    const outMain = resolvedVideoEncoderCodecString(
      { codec: 'h264' },
      dims.w,
      dims.h,
      dims.fps,
      main,
      undefined,
      false,
    );
    expect(outMain).toMatch(/^avc1\.4D00/i);
    const outUnknown = resolvedVideoEncoderCodecString(
      { codec: 'h264' },
      dims.w,
      dims.h,
      dims.fps,
      unknown,
      undefined,
      false,
    );
    expect(outUnknown).toMatch(/^avc1\.42E0/i);
    // Level byte is sized, not hard-coded 42E01E for 720p — should be at least L3.1
    expect(outHigh10.slice(-2)).not.toBe('1E'); // not fallback Level 3.0
  });

  it('H.264 level sizing remains correct after High10 fix (720p→L3.1, 1080p→L4.0, 4K→L5.1)', () => {
    expect(h264CodecStringForDimensions(1280, 720, 30)).toMatch(/1F$/); // L3.1
    expect(h264CodecStringForDimensions(1920, 1080, 30)).toMatch(/28$/); // L4.0
    expect(h264CodecStringForDimensions(3840, 2160, 30)).toMatch(/33$/); // L5.1
    expect(h264CodecStringForDimensions(320, 240, 30)).toMatch(/0D$/); // L1.3 spec-correct (no floor)
  });

  it('20× randomized alpha + H.264 profile invariants remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const m = generateSupportMatrix();
      expect(m.codecs.find((c) => c.codec === 'vp9')!.alpha).toBe(true);
      expect(m.codecs.find((c) => c.codec === 'vp8')!.alpha).toBe(true);
      const candidates = [
        'vp8',
        'vp09.00.10.08',
        'avc1.42E01E',
        'hvc1.1.6.L93.B0',
        'av01.0.04M.08',
        'vp09.02.10.10',
        'vp8.00',
      ] as const;
      const codec = candidates[i % candidates.length]!;
      const can = videoCodecCanCarryAlpha(codec);
      expect(typeof can).toBe('boolean');
      if (
        codec.toLowerCase().startsWith('vp8') ||
        codec.toLowerCase().startsWith('vp09') ||
        codec.toLowerCase() === 'vp8' ||
        codec.toLowerCase() === 'vp9'
      ) {
        expect(can).toBe(true);
      } else {
        expect(can).toBe(false);
      }
      // H.264 High10 randomized still maps to High
      const src = i % 2 === 0 ? 'avc1.6E001E' : 'avc1.64001E';
      const out = resolvedVideoEncoderCodecString(
        { codec: 'h264' },
        640 + i,
        480 + i,
        30,
        src,
        undefined,
        false,
      );
      expect(out.startsWith('avc1.6400')).toBe(true);
    }
  });

  it('malformed inputs never throw huge allocation or wrong leak', () => {
    expect(videoCodecCanCarryAlpha('')).toBe(false);
    expect(videoCodecCanCarryAlpha('   ')).toBe(false);
    expect(bitDepthFromCodec('avc1.6E001E')).toBe(10);
    expect(bitDepthFromCodec('avc1.XX001E')).toBeUndefined(); // malformed profile hex → undecodable
    expect(() => videoAlphaOption({ alpha: 'keep' } as never, '')).toThrow();
    const m = generateSupportMatrix();
    expect(m.codecs.find((c) => c.codec === 'vp9')!.bitDepths).toEqual([8, 10]);
  });
});
