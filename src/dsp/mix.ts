/**
 * Channel up/down-mix (doc 09 §audio-dsp; ITU-R BS.775 downmix coefficients). Pure TS over the canonical
 * planar buffer. Supported, with the 5.1 channel order `L,R,C,LFE,Ls,Rs` (WAV/SMPTE):
 *
 *   1→2 duplicate · 2→1 average · 2→6 front-only upmix · 6→2 & 6→1 BS.775 downmix · N→N identity.
 *
 * BS.775: `Lo = L + (1/√2)·C + (1/√2)·Ls`, `Ro = R + (1/√2)·C + (1/√2)·Rs` (LFE dropped). Mixing can push
 * peaks past `±1`; that is intentional — clipping happens only at the integer encode boundary
 * ({@link encodePcm}), so a downmix→f32 path stays lossless. Unsupported layouts raise a typed
 * {@link CapabilityError} rather than guessing.
 */

import { CapabilityError } from '../contracts/errors.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';

const C = Math.SQRT1_2; // 1/√2 ≈ 0.7071 — the BS.775 center/surround coefficient

function build(audio: PcmAudio, channels: number, planar: Float64Array[]): PcmAudio {
  return { sampleRate: audio.sampleRate, channels, frames: audio.frames, planar };
}

function clonePlanar(audio: PcmAudio): PcmAudio {
  return build(
    audio,
    audio.channels,
    audio.planar.map((ch) => ch.slice()),
  );
}

function monoToStereo(a: PcmAudio): PcmAudio {
  const m = channelAt(a.planar, 0);
  return build(a, 2, [m.slice(), m.slice()]);
}

function stereoToMono(a: PcmAudio): PcmAudio {
  const L = channelAt(a.planar, 0);
  const R = channelAt(a.planar, 1);
  const m = new Float64Array(a.frames);
  for (let f = 0; f < a.frames; f++) m[f] = 0.5 * (sampleAt(L, f) + sampleAt(R, f));
  return build(a, 1, [m]);
}

function stereoToSurround(a: PcmAudio): PcmAudio {
  const L = channelAt(a.planar, 0);
  const R = channelAt(a.planar, 1);
  const zero = () => new Float64Array(a.frames);
  return build(a, 6, [L.slice(), R.slice(), zero(), zero(), zero(), zero()]);
}

/** BS.775 5.1→stereo, returning the two downmixed channels (shared by 6→2 and 6→1). */
function surroundDownmix(a: PcmAudio): [Float64Array, Float64Array] {
  const L = channelAt(a.planar, 0);
  const R = channelAt(a.planar, 1);
  const Cn = channelAt(a.planar, 2);
  const Ls = channelAt(a.planar, 4);
  const Rs = channelAt(a.planar, 5);
  const lo = new Float64Array(a.frames);
  const ro = new Float64Array(a.frames);
  for (let f = 0; f < a.frames; f++) {
    const center = C * sampleAt(Cn, f);
    lo[f] = sampleAt(L, f) + center + C * sampleAt(Ls, f);
    ro[f] = sampleAt(R, f) + center + C * sampleAt(Rs, f);
  }
  return [lo, ro];
}

function surroundToStereo(a: PcmAudio): PcmAudio {
  return build(a, 2, surroundDownmix(a));
}

function surroundToMono(a: PcmAudio): PcmAudio {
  const [lo, ro] = surroundDownmix(a);
  const m = new Float64Array(a.frames);
  for (let f = 0; f < a.frames; f++) m[f] = 0.5 * (sampleAt(lo, f) + sampleAt(ro, f));
  return build(a, 1, [m]);
}

/** Remix `audio` to `toChannels`. Identity for equal counts; typed `CapabilityError` for unsupported pairs. */
export function remix(audio: PcmAudio, toChannels: number): PcmAudio {
  const from = audio.channels;
  if (toChannels <= 0 || !Number.isInteger(toChannels)) {
    throw new CapabilityError('capability-miss', `invalid target channel count ${toChannels}`, {
      op: 'filter',
      tried: [],
    });
  }
  if (from === toChannels) return clonePlanar(audio);
  if (from === 1 && toChannels === 2) return monoToStereo(audio);
  if (from === 2 && toChannels === 1) return stereoToMono(audio);
  if (from === 2 && toChannels === 6) return stereoToSurround(audio);
  if (from === 6 && toChannels === 2) return surroundToStereo(audio);
  if (from === 6 && toChannels === 1) return surroundToMono(audio);
  throw new CapabilityError(
    'capability-miss',
    `unsupported channel remix ${from}→${toChannels} (supported: 1↔2, 2↔6, 6→1, N→N)`,
    { op: 'filter', tried: [] },
  );
}
