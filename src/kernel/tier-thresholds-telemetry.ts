import type { TierThresholds } from './tier-thresholds.ts';

export interface ThresholdProvenance {
  path: string;
  generatedAt: string;
  runtime: string;
}

export interface TelemetrySeededTierThresholds extends TierThresholds {
  provenance: readonly ThresholdProvenance[];
}

/**
 * ADR-020 scalar seed thresholds, distilled from committed fresh telemetry baselines. ADR-199's compound
 * video-work ceiling preserves the scalar 64×64 / one-second boundary at the 30 fps planning cadence. The
 * router imports only the compact numeric thresholds from `tier-thresholds.ts`; this file keeps provenance
 * out of the eager default-entry closure.
 */
export const TELEMETRY_SEEDED_TIER_THRESHOLDS: TelemetrySeededTierThresholds = {
  tinyInputBytes: 64 * 1024,
  tinyVideoPixels: 64 * 64,
  tinyMediaSeconds: 1,
  tinyAudioFrames: 48_000,
  tinyVideoPixelWork: (64 * 64 + 64 * 64) * 30,
  provenance: [
    {
      path: 'fixtures/golden/bench/containers.json',
      generatedAt: '2026-06-26T04:37:40.792Z',
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
