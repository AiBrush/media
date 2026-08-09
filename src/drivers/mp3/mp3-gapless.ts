import type { TrackInfo } from '../../contracts/driver.ts';

/**
 * Layer III synthesis/filterbank latency exposed by raw frame decoders. Xing/LAME stores only the
 * encoder delay; a decoded presentation window starts another 528+1 samples later. The same amount
 * is reallocated from the tag's end padding, so the declared program length does not change.
 */
export const MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES = 528 + 1;

export interface Mp3LameGaplessResult {
  /** Exact decoded presentation window, which may be shorter than a malformed tag's nominal span. */
  readonly gapless: NonNullable<TrackInfo['gapless']>;
  /** Duration declared by the raw Xing frame-count and LAME delay/padding fields. */
  readonly declaredTotalSamples: number;
}

/** Convert raw Xing/LAME fields into the decoded-sample presentation window used by TrackInfo. */
export function mp3PresentationGaplessFromLame(
  frameCount: number,
  samplesPerFrame: number,
  encoderDelay: number,
  encoderPadding: number,
): Mp3LameGaplessResult | undefined {
  if (
    !Number.isSafeInteger(frameCount) ||
    !Number.isSafeInteger(samplesPerFrame) ||
    !Number.isSafeInteger(encoderDelay) ||
    !Number.isSafeInteger(encoderPadding) ||
    frameCount <= 0 ||
    samplesPerFrame <= 0 ||
    encoderDelay < 0 ||
    encoderPadding < 0
  ) {
    return undefined;
  }
  const leadingSamples = encoderDelay + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES;
  const trailingSamples = Math.max(0, encoderPadding - MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES);
  const codedSamples = frameCount * samplesPerFrame;
  const declaredTotalSamples = codedSamples - encoderDelay - encoderPadding;
  const totalSamples = codedSamples - leadingSamples - trailingSamples;
  if (
    !Number.isSafeInteger(declaredTotalSamples) ||
    !Number.isSafeInteger(totalSamples) ||
    declaredTotalSamples <= 0 ||
    totalSamples <= 0
  ) {
    return undefined;
  }
  return {
    declaredTotalSamples,
    gapless: {
      basis: 'mp3-xing-lame',
      leadingSamples,
      trailingSamples,
      totalSamples,
      mp3Lame: {
        encoderDelaySamples: encoderDelay,
        encoderPaddingSamples: encoderPadding,
      },
    },
  };
}
