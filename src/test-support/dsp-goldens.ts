/**
 * Shared definition of the audio-dsp **baked goldens** (doc 11) — the single source of truth for both
 * `scripts/bake-goldens.ts` (writer) and `src/dsp/golden.test.ts` (asserter), so they can never drift.
 *
 * Only **pow-free, exact-arithmetic** transforms are pinned by sha256: decode→encode identity, format
 * conversion, and channel copy/average are correctly-rounded IEEE-754 (deterministic across engines).
 * `gain` deliberately stays off this list — `10**x` is not spec-required to be correctly-rounded, so its
 * bytes can differ by an ULP between engines; it is validated by computed invariants instead.
 */

import { readWavPcm } from '../drivers/wav/pcm.ts';
import { remix } from '../dsp/index.ts';
import { encodePcm } from '../dsp/pcm.ts';
import { sha256Hex } from '../util/digest.ts';

export interface DspGolden {
  format: string;
  sampleRate: number;
  channels: number;
  frames: number;
  sha256: Record<string, string>;
}

/** Compute the committed-golden digests for one WAV fixture's PCM. */
export async function dspGoldenDigests(wav: Uint8Array): Promise<DspGolden> {
  const a = readWavPcm(wav);
  const base: Record<string, string> = {
    [`identity_${a.format}`]: await sha256Hex(encodePcm(a, a.format)),
    to_f32: await sha256Hex(encodePcm(a, 'f32')),
    to_s24: await sha256Hex(encodePcm(a, 's24')),
  };
  // Mono fixtures additionally pin the (exact) mono→stereo upmix. Built immutably so neither tsc's
  // index-signature access rule nor Biome's literal-key rule fights a post-hoc mutation.
  const sha256: Record<string, string> =
    a.channels === 1
      ? { ...base, remix_stereo_s16: await sha256Hex(encodePcm(remix(a, 2), 's16')) }
      : base;
  return {
    format: a.format,
    sampleRate: a.sampleRate,
    channels: a.channels,
    frames: a.frames,
    sha256,
  };
}
