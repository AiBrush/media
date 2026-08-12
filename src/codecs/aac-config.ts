/**
 * Container-neutral MPEG-4 AAC configuration helpers.
 *
 * These constants and parsers are shared by muxers and codec implementations. Keeping them outside the
 * WASM AAC driver lets native copy/remux routes validate an `AudioSpecificConfig` without loading any
 * codec implementation or runtime.
 */

import { InputError, MediaError } from '../contracts/errors.ts';

/**
 * MPEG-4 sampling-frequency index → Hz (ISO/IEC 14496-3 Table 1.16). Index 15 is "explicit" (not in the
 * table); indices 13/14 are reserved. Shared by ADTS headers and the AudioSpecificConfig.
 */
export const MPEG4_SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Sample rate (Hz) for a 4-bit MPEG-4 sampling-frequency index, or `undefined` if reserved/explicit. */
export function sampleRateForIndex(index: number): number | undefined {
  return MPEG4_SAMPLE_RATES[index];
}

/** The minimal fields an AAC AudioSpecificConfig declares (ISO/IEC 14496-3 §1.6.2.1). */
export interface AscFields {
  objectType: number;
  sampleRate: number;
  channels: number;
}

/**
 * Parse the leading fields of an AudioSpecificConfig: 5-bit audioObjectType, 4-bit sampling-frequency
 * index (or a 24-bit explicit rate when the index is 15), 4-bit channelConfiguration.
 */
export function parseAsc(asc: Uint8Array): AscFields {
  if (asc.length < 2) throw new InputError('aac: AudioSpecificConfig too short');
  const b0 = asc[0] as number;
  const b1 = asc[1] as number;
  const objectType = b0 >> 3;
  const freqIndex = ((b0 & 0x07) << 1) | (b1 >> 7);
  if (freqIndex === 15) {
    if (asc.length < 5) throw new InputError('aac: explicit-rate ASC too short');
    // Explicit 24-bit rate spanning b1[6:0] | b2 | b3 | b4[7]; channelConfig is the next 4 bits (b4[6:3]).
    const b2 = asc[2] as number;
    const b3 = asc[3] as number;
    const b4 = asc[4] as number;
    const sampleRate = ((b1 & 0x7f) << 17) | (b2 << 9) | (b3 << 1) | (b4 >> 7);
    return { objectType, sampleRate, channels: (b4 >> 3) & 0x0f };
  }
  const sampleRate = sampleRateForIndex(freqIndex);
  if (sampleRate === undefined) {
    throw new MediaError('decode-error', `aac: reserved ASC sampling-frequency index ${freqIndex}`);
  }
  return { objectType, sampleRate, channels: (b1 >> 3) & 0x0f };
}
