import {
  TINY_AUDIO_FRAMES,
  TINY_INPUT_BYTES,
  TINY_MEDIA_SECONDS,
  TINY_VIDEO_PIXELS,
  TINY_VIDEO_PIXEL_WORK,
} from './tier-thresholds.ts';

/** One committed fresh-benchmark baseline a threshold seed was distilled from. */
export interface ThresholdProvenance {
  path: string;
  generatedAt: string;
  runtime: string;
}

/** The ADR-020 threshold seeds together with the committed telemetry baselines that justify them. */
export interface TelemetrySeededTierThresholds {
  readonly tinyInputBytes: number;
  readonly tinyVideoPixels: number;
  readonly tinyMediaSeconds: number;
  readonly tinyAudioFrames: number;
  readonly tinyVideoPixelWork: number;
  readonly provenance: readonly ThresholdProvenance[];
}

/**
 * ADR-020 scalar seed thresholds, distilled from committed fresh telemetry baselines. ADR-199's compound
 * video-work ceiling preserves the scalar 64×64 / one-second boundary at the 30 fps planning cadence.
 * The router imports only the compact numeric consts from `tier-thresholds.ts`; this view exists so the
 * provenance stays out of the eager kernel while the numbers exist exactly once (they are imported, not
 * re-hardcoded). Consumed by `scripts/check-tier-thresholds.ts`, which fails on any drift between the
 * recorded provenance and the committed baselines under `fixtures/golden/bench/`.
 */
export const TELEMETRY_SEEDED_TIER_THRESHOLDS: TelemetrySeededTierThresholds = {
  tinyInputBytes: TINY_INPUT_BYTES,
  tinyVideoPixels: TINY_VIDEO_PIXELS,
  tinyMediaSeconds: TINY_MEDIA_SECONDS,
  tinyAudioFrames: TINY_AUDIO_FRAMES,
  tinyVideoPixelWork: TINY_VIDEO_PIXEL_WORK,
  provenance: [
    {
      path: 'fixtures/golden/bench/containers.json',
      generatedAt: '2026-06-30T13:57:37.559Z',
      runtime: 'bun 1.3.14',
    },
    {
      path: 'fixtures/golden/bench/audio-dsp.json',
      generatedAt: '2026-06-26T04:04:54.458Z',
      runtime: 'bun 1.3.14',
    },
    {
      path: 'fixtures/golden/bench/image.json',
      generatedAt: '2026-06-26T04:25:00.995Z',
      runtime: 'bun 1.3.14',
    },
  ],
};
