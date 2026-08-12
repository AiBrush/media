/**
 * Portable audio-target defaults resolved before browser-specific capability routing. Kept separate from
 * encoder config synthesis so filter planning and encoder configuration consume the same target shape.
 */

import { audioEncoderCodecString } from './encoder-config.ts';
import type { AudioTarget } from './types.ts';

/**
 * Opus packets and container timing present on a fixed 48 kHz clock, so an omitted target rate means
 * 48 kHz rather than "inherit an arbitrary source rate". Explicit rates remain caller intent; a runtime
 * may still apply a narrower encoder-specific override later.
 */
export function defaultOpusAudioEncodeTarget(
  target: AudioTarget,
  sourceCodecString: string | undefined,
): AudioTarget {
  const codec = audioEncoderCodecString(target.codec, sourceCodecString);
  if (codec !== 'opus' || target.sampleRate !== undefined) return target;
  return { ...target, sampleRate: 48_000 };
}
