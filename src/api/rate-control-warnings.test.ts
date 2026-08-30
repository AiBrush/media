import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import {
  h264ProfileFallbackWarning,
  h264QualityOvershootWarning,
  h264WarmupWarning,
  shouldWarnQualityOvershoot,
} from './rate-control-warnings.ts';
import { routeVideoEncoderWithImplicitH264Fallback } from './video-two-pass-runner.ts';

describe('rate-control structured warnings — H.264 fallback, warmup, quality overshoot (REQUIREMENTS §5.5 — 2.2.2)', () => {
  it('profile fallback warning is warn level with code and codecs', () => {
    const w = h264ProfileFallbackWarning('avc1.64001E', 'avc1.42E01E', 'avc1.64001E');
    expect(w.level).toBe('warn');
    expect((w.detail as { code: string }).code).toBe('h264-profile-fallback');
    expect(w.message).toContain('avc1.64001E');
    expect(w.message).toContain('avc1.42E01E');
    expect((w.detail as { originalCodec: string }).originalCodec).toBe('avc1.64001E');
    expect((w.detail as { fallbackCodec: string }).fallbackCodec).toBe('avc1.42E01E');
  });

  it('profile fallback handles High10 source (6E) → Constrained Baseline', () => {
    const w = h264ProfileFallbackWarning('avc1.6E001E', 'avc1.42E01E', 'avc1.6E001E');
    expect((w.detail as { code: string }).code).toBe('h264-profile-fallback');
    expect((w.detail as { sourceCodec: string }).sourceCodec).toBe('avc1.6E001E');
  });

  it('warmup warning carries frames and codec', () => {
    const w = h264WarmupWarning('avc1.42E01E', 3, 30);
    expect(w.level).toBe('warn');
    expect((w.detail as { code: string }).code).toBe('h264-warmup-injected');
    expect((w.detail as { warmupFrames: number }).warmupFrames).toBe(3);
    expect(w.message).toContain('3');
  });

  it('quality overshoot warning fires only when average > preferred', () => {
    expect(shouldWarnQualityOvershoot(2_000_000, 2_500_000)).toBe(true);
    expect(shouldWarnQualityOvershoot(2_000_000, 2_000_000)).toBe(false);
    expect(shouldWarnQualityOvershoot(2_000_000, 1_900_000)).toBe(false);
    const w = h264QualityOvershootWarning(2_000_000, 2_500_000, 2_600_000);
    expect(w.level).toBe('warn');
    expect((w.detail as { code: string }).code).toBe('h264-quality-rate-overshoot');
    expect((w.detail as { averageBitrate: number }).averageBitrate).toBe(2_500_000);
    expect(w.message).toContain('2500000');
  });

  it('routeVideoEncoderWithImplicitH264Fallback returns warning on profile downgrade', async () => {
    const config: VideoEncoderConfig = {
      codec: 'avc1.64001E',
      width: 1280,
      height: 720,
      bitrate: 2_000_000,
      framerate: 30,
      latencyMode: 'quality',
    };
    let call = 0;
    const routeCodec = async () => {
      call++;
      if (call === 1)
        throw new CapabilityError('not supported', {
          op: { kind: 'route', id: 'encode' },
          tried: ['webcodecs-video'],
        });
      return { id: 'mock' } as unknown as import('../contracts/driver.ts').CodecDriver;
    };
    const result = await routeVideoEncoderWithImplicitH264Fallback(
      config,
      {},
      'avc1.64001E',
      {},
      routeCodec as never,
    );
    expect(result.warning).toBeDefined();
    expect(result.warning!.level).toBe('warn');
    expect((result.warning!.detail as { code: string }).code).toBe('h264-profile-fallback');
    expect(result.config.codec).toBe('avc1.42E01F'); // fallback to Baseline 720p → L3.1 (sized)
  });

  it('no fallback when source is not Main/High/High10 or explicit codec', async () => {
    const config: VideoEncoderConfig = {
      codec: 'avc1.42E01E',
      width: 640,
      height: 480,
      bitrate: 1_000_000,
      framerate: 30,
      latencyMode: 'quality',
    };
    const routeCodec = async () => {
      throw new CapabilityError('not supported', {
        op: { kind: 'route', id: 'encode' },
        tried: ['webcodecs-video'],
      });
    };
    await expect(
      routeVideoEncoderWithImplicitH264Fallback(config, {}, 'avc1.42E01E', {}, routeCodec as never),
    ).rejects.toThrow();
    // explicit codec target prevents fallback
    await expect(
      routeVideoEncoderWithImplicitH264Fallback(
        config,
        { codec: 'h264' },
        'avc1.64001E',
        {},
        routeCodec as never,
      ),
    ).rejects.toThrow();
  });

  it('20× randomized warnings remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const w1 = h264ProfileFallbackWarning(
        `avc1.${(0x42 + (i % 3)).toString(16)}001E`,
        'avc1.42E01E',
        'avc1.64001E',
      );
      expect(w1.level).toBe('warn');
      const w2 = h264QualityOvershootWarning(2_000_000 + i * 1000, 2_500_000 + i * 1000, 2_600_000);
      expect(w2.level).toBe('warn');
      expect(shouldWarnQualityOvershoot(1_000_000 + i, 1_000_000 + i + 1)).toBe(true);
    }
  });

  it('malformed inputs never throw huge allocation', () => {
    const w = h264ProfileFallbackWarning('', '', undefined);
    expect(w.level).toBe('warn');
    expect(shouldWarnQualityOvershoot(0, 0)).toBe(false);
    expect(shouldWarnQualityOvershoot(Number.NaN, 1)).toBe(false);
    const w2 = h264WarmupWarning('', 0, undefined);
    expect(w2.level).toBe('warn');
  });
});
