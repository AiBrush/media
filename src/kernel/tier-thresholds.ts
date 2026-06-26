export interface RouteCost {
  /** Whole input size when known. */
  inputBytes?: number;
  /** Output or coded video area when known. */
  outputPixels?: number;
  /** Media duration when known. */
  mediaSeconds?: number;
  /** Audio frame count when known. */
  audioFrames?: number;
}

export interface TierThresholds {
  tinyInputBytes: number;
  tinyVideoPixels: number;
  tinyMediaSeconds: number;
  tinyAudioFrames: number;
}

export const TINY_INPUT_BYTES = 64 * 1024;
export const TINY_VIDEO_PIXELS = 64 * 64;
export const TINY_MEDIA_SECONDS = 1;
export const TINY_AUDIO_FRAMES = 48_000;

export const TELEMETRY_SEEDED_TIER_THRESHOLDS: TierThresholds = {
  tinyInputBytes: TINY_INPUT_BYTES,
  tinyVideoPixels: TINY_VIDEO_PIXELS,
  tinyMediaSeconds: TINY_MEDIA_SECONDS,
  tinyAudioFrames: TINY_AUDIO_FRAMES,
};
