/**
 * Gain — scale every sample by a decibel amount (doc 09 §audio-dsp). Pure TS, deterministic: a linear
 * factor `10^(dB/20)` multiplied across each channel. `0 dB` is bit-exact identity (×1.0); clipping is
 * deferred to {@link encodePcm} (the float domain is unbounded, so a +gain that overshoots `±1` only
 * clamps when it hits an integer wire format).
 */

import type { PcmAudio } from './pcm.ts';

/** Decibels → linear amplitude factor. `0 → 1`, `-6.0206 → ~0.5`, `-Infinity → 0`. */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Apply a gain of `db` decibels to all channels, returning new audio (input untouched). */
export function gain(audio: PcmAudio, db: number): PcmAudio {
  const factor = dbToLinear(db);
  const planar = audio.planar.map((ch) => {
    const out = new Float64Array(ch.length);
    let i = 0;
    for (const s of ch) {
      out[i] = s * factor;
      i++;
    }
    return out;
  });
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planar };
}
