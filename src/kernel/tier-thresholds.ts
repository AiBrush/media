export interface RouteCost {
  /** Whole input size when known. */
  inputBytes?: number;
  /** Decoded source video area when known. */
  inputPixels?: number;
  /** Output or coded video area when known. */
  outputPixels?: number;
  /** Estimated number of video frames touched by the filter stage. */
  videoFrames?: number;
  /** Total source-read plus destination-write pixels across the estimated video frames. */
  videoPixelWork?: number;
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
  tinyVideoPixelWork: number;
}

export const TINY_INPUT_BYTES = 64 * 1024;
export const TINY_VIDEO_PIXELS = 64 * 64;
export const TINY_MEDIA_SECONDS = 1;
export const TINY_AUDIO_FRAMES = 48_000;
/** Reference cadence used to preserve the original one-second tiny-video boundary. */
export const TINY_VIDEO_FRAMES = 30;
/** Source read + destination write for an identity 64×64, 30-frame video operation. */
export const TINY_VIDEO_PIXEL_WORK = (TINY_VIDEO_PIXELS + TINY_VIDEO_PIXELS) * TINY_VIDEO_FRAMES;

export const TELEMETRY_SEEDED_TIER_THRESHOLDS: TierThresholds = {
  tinyInputBytes: TINY_INPUT_BYTES,
  tinyVideoPixels: TINY_VIDEO_PIXELS,
  tinyMediaSeconds: TINY_MEDIA_SECONDS,
  tinyAudioFrames: TINY_AUDIO_FRAMES,
  tinyVideoPixelWork: TINY_VIDEO_PIXEL_WORK,
};
