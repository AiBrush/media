import { describe, expect, it } from 'vitest';
import { TELEMETRY_SEEDED_TIER_THRESHOLDS } from './tier-thresholds-telemetry.ts';
import {
  TELEMETRY_SEEDED_TIER_THRESHOLDS as ROUTER_THRESHOLDS,
  TINY_AUDIO_FRAMES,
  TINY_INPUT_BYTES,
  TINY_MEDIA_SECONDS,
  TINY_VIDEO_PIXELS,
} from './tier-thresholds.ts';

describe('telemetry-seeded tier thresholds', () => {
  it('carry explicit committed benchmark provenance', () => {
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.provenance.length).toBeGreaterThanOrEqual(3);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.provenance.map((p) => p.path)).toContain(
      'fixtures/golden/bench/containers.json',
    );
  });

  it('pins the exact tiny-work thresholds used by the router', () => {
    expect(TINY_INPUT_BYTES).toBe(64 * 1024);
    expect(TINY_VIDEO_PIXELS).toBe(64 * 64);
    expect(TINY_MEDIA_SECONDS).toBe(1);
    expect(TINY_AUDIO_FRAMES).toBe(48_000);
    expect(ROUTER_THRESHOLDS).toEqual({
      tinyInputBytes: TINY_INPUT_BYTES,
      tinyVideoPixels: TINY_VIDEO_PIXELS,
      tinyMediaSeconds: TINY_MEDIA_SECONDS,
      tinyAudioFrames: TINY_AUDIO_FRAMES,
    });
  });
});
