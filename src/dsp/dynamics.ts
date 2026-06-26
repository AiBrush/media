/**
 * Dynamics — peak/RMS normalize and a peak limiter (doc 09 §audio-dsp). Pure TS over the canonical
 * planar Float64 buffer, deterministic, in the style of {@link gain}/{@link fadeIn}: returns new audio,
 * leaves the input untouched, never produces `NaN`. All targets/ceilings are in **dBFS** (0 dBFS = full
 * scale = amplitude 1.0), converted via {@link dbToLinear} (reused from gain — no duplicate dB math).
 *
 *   - `normalizePeak` scales by `target/peak` so the new global peak is **exactly** the target. The peak
 *     is taken across *all* channels (linked) so the inter-channel balance / stereo image is preserved.
 *   - `normalizeRms` scales by `target/rms` so the new global RMS equals the target — the simple
 *     loudness-ish proxy (true loudness is K-weighted LUFS; RMS is the standard cheap stand-in). RMS
 *     normalize **can push peaks past ±1**, so it is meant to be followed by {@link limit}.
 *   - `limit` guarantees every output sample satisfies `|x| ≤ ceiling`. `hard` clips at the ceiling;
 *     `soft` leaves a below-knee linear region bit-exact and smoothly compresses peaks above the knee
 *     onto `(knee·ceiling, ceiling]` with a slope-matched (C¹) saturator that never reaches/exceeds the
 *     ceiling. Both modes preserve below-ceiling samples bit-exact and add no clipping on encode.
 *
 * "No inter-sample clip" here means **no sample exceeds the ceiling** (the encoded PCM never overflows).
 * True-peak / inter-sample-peak (ISP) limiting — catching reconstruction peaks *between* samples — needs
 * oversampling and is a heavier op left to a follow-up (it would reuse the resampler for the 4× analysis).
 *
 * Silence is a fixed point: a zero-peak / zero-RMS signal can't be scaled to a non-zero target, so the
 * normalizers return it unchanged (guarding the divide), and limiting silence yields silence.
 */

import { InputError } from '../contracts/errors.ts';
import { dbToLinear } from './gain.ts';
import type { PcmAudio } from './pcm.ts';
import type { StatefulAudioStage } from './stream.ts';

/** Peak-limiter response: `hard` clips at the ceiling; `soft` rounds the knee with a bounded saturator. */
export type LimitMode = 'hard' | 'soft';

/** Validate a dBFS argument is a finite number — `±Infinity`/`NaN` would yield non-finite gain/output. */
function checkDb(db: number, what: string): void {
  if (!Number.isFinite(db)) {
    throw new InputError('unsupported-input', `${what} must be a finite number (dBFS); got ${db}`);
  }
}

/** The largest `|sample|` across every channel (the linked peak used for peak-normalize). */
function globalPeak(audio: PcmAudio): number {
  let peak = 0;
  for (const ch of audio.planar) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Root-mean-square over every sample of every channel (the linked RMS used for RMS-normalize). */
function globalRms(audio: PcmAudio): number {
  let sumSq = 0;
  let count = 0;
  for (const ch of audio.planar) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] ?? 0;
      sumSq += v * v;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

/** Map every sample through `f`, returning new audio (input untouched), preserving rate/channels/frames. */
function mapSamples(audio: PcmAudio, f: (x: number) => number): PcmAudio {
  const planar = audio.planar.map((ch) => {
    const out = new Float64Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = f(ch[i] ?? 0);
    return out;
  });
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planar };
}

function clonePlanar(audio: PcmAudio): PcmAudio {
  return mapSamples(audio, (x) => x);
}

/**
 * Scale `audio` so its global peak becomes exactly `targetDbfs` dBFS (peak across all channels is
 * linked, preserving balance). Digital silence (peak 0) is returned unchanged — there is no factor that
 * maps 0 to a non-zero target. Input untouched.
 *
 * @throws InputError if `targetDbfs` is NaN.
 */
export function normalizePeak(audio: PcmAudio, targetDbfs = 0): PcmAudio {
  checkDb(targetDbfs, 'normalize target');
  const peak = globalPeak(audio);
  if (peak === 0) return clonePlanar(audio);
  const factor = dbToLinear(targetDbfs) / peak;
  return mapSamples(audio, (x) => x * factor);
}

/**
 * Scale `audio` so its global RMS becomes exactly `targetDbfs` dBFS (the loudness-ish normalize). The
 * result **may exceed ±1** for peaky material — follow with {@link limit} to brick-wall it. Digital
 * silence (RMS 0) is returned unchanged. Input untouched.
 *
 * @throws InputError if `targetDbfs` is NaN.
 */
export function normalizeRms(audio: PcmAudio, targetDbfs: number): PcmAudio {
  checkDb(targetDbfs, 'normalize target');
  const rms = globalRms(audio);
  if (rms === 0) return clonePlanar(audio);
  const factor = dbToLinear(targetDbfs) / rms;
  return mapSamples(audio, (x) => x * factor);
}

/** One sample through the soft-knee limiter: linear below `knee·ceiling`, bounded saturation above. */
function softLimitSample(x: number, ceiling: number, knee: number): number {
  const k = knee * ceiling; // the threshold where compression begins
  const mag = Math.abs(x);
  if (mag <= k) return x; // linear region — bit-exact pass-through
  // `knee === 1` ⇒ the knee IS the ceiling: there is no compression band, so above-ceiling samples are
  // brick-walled at the ceiling (no division by a zero range → no NaN).
  const range = ceiling - k;
  if (range === 0) return x < 0 ? -ceiling : ceiling;
  // Map the excess onto (k, ceiling] with f(d)=d/(d+1): f(0)=0 (continuous at the knee), f'(0)=1
  // (slope-matched → C¹), f→1 as d→∞ (output → ceiling, never reaching/exceeding it).
  const d = (mag - k) / range; // 0 at the knee, →∞ for large input
  const compressed = k + range * (d / (d + 1));
  return x < 0 ? -compressed : compressed;
}

/**
 * Peak-limit `audio` so every sample satisfies `|x| ≤ ceilingDbfs` dBFS. `hard` clips at the ceiling;
 * `soft` keeps a below-knee linear region bit-exact and smoothly compresses larger peaks toward (but
 * never past) the ceiling. Samples already below the ceiling are preserved bit-exact in both modes.
 * Input untouched.
 *
 * @param knee — for `soft`, the fraction of the ceiling (in `(0, 1]`) below which the signal is linear.
 * @throws InputError if `ceilingDbfs` is NaN, or `knee` is outside `(0, 1]`.
 */
export function limit(
  audio: PcmAudio,
  ceilingDbfs = 0,
  mode: LimitMode = 'hard',
  knee = 0.9,
): PcmAudio {
  checkDb(ceilingDbfs, 'limiter ceiling');
  const ceiling = dbToLinear(ceilingDbfs);
  if (mode === 'hard') {
    return mapSamples(audio, (x) => (x > ceiling ? ceiling : x < -ceiling ? -ceiling : x));
  }
  if (!(knee > 0 && knee <= 1)) {
    throw new InputError('unsupported-input', `limiter knee must be in (0, 1]; got ${knee}`);
  }
  return mapSamples(audio, (x) => softLimitSample(x, ceiling, knee));
}

// ============ streaming dynamics stage (codec seam) ============

/** A resolved normalize stage (mode + dBFS target), mirroring the public `PcmDynamicsNormalize`. */
export interface NormalizeSpec {
  readonly mode: 'peak' | 'rms';
  readonly targetDbfs: number;
}

/** A resolved limiter stage (dBFS ceiling + mode + optional knee), mirroring `PcmDynamicsLimit`. */
export interface LimitSpec {
  readonly ceilingDbfs: number;
  readonly mode: LimitMode;
  readonly knee?: number;
}

/** A resolved dynamics chain for the streaming stage: optional normalize, then optional limit. */
export interface DynamicsSpec {
  readonly normalize?: NormalizeSpec;
  readonly limit?: LimitSpec;
}

/** Apply the resolved normalize→limit chain to a whole buffer (the exact whole-signal reference order). */
function applyDynamicsChain(audio: PcmAudio, spec: DynamicsSpec): PcmAudio {
  let result = audio;
  if (spec.normalize !== undefined) {
    result =
      spec.normalize.mode === 'peak'
        ? normalizePeak(result, spec.normalize.targetDbfs)
        : normalizeRms(result, spec.normalize.targetDbfs);
  }
  if (spec.limit !== undefined) {
    const { ceilingDbfs, mode, knee } = spec.limit;
    result =
      knee === undefined
        ? limit(result, ceilingDbfs, mode)
        : limit(result, ceilingDbfs, mode, knee);
  }
  return result;
}

/** Concatenate same-layout chunks into one buffer (layout taken from the first chunk; [] ⇒ empty). */
function concatChunks(chunks: readonly PcmAudio[]): PcmAudio {
  const first = chunks[0];
  if (first === undefined) return { sampleRate: 0, channels: 0, frames: 0, planar: [] };
  const { sampleRate, channels } = first;
  const frames = chunks.reduce((s, c) => s + c.frames, 0);
  const planar = Array.from({ length: channels }, () => new Float64Array(frames));
  let pos = 0;
  for (const c of chunks) {
    for (let ch = 0; ch < channels; ch++)
      planar[ch]?.set(c.planar[ch] ?? new Float64Array(c.frames), pos);
    pos += c.frames;
  }
  return { sampleRate, channels, frames, planar };
}

/** Re-split `whole` back into chunks of `sizes` frames each (preserving the original framing/timestamps). */
function splitLike(whole: PcmAudio, sizes: readonly number[]): PcmAudio[] {
  const out: PcmAudio[] = [];
  let pos = 0;
  for (const n of sizes) {
    out.push({
      sampleRate: whole.sampleRate,
      channels: whole.channels,
      frames: n,
      planar: whole.planar.map((ch) => ch.slice(pos, pos + n)),
    });
    pos += n;
  }
  return out;
}

/**
 * A {@link StatefulAudioStage} applying a dynamics chain across a stream of {@link PcmAudio} chunks,
 * bit-exactly equal to the whole-signal reference (`normalize` then `limit`, the `transformPcm` order).
 *
 *   - **`limit`-only is causal** — the limiter is purely per-sample, so each chunk is limited on `push`
 *     and emitted 1:1 (no buffering, O(1) latency); `flush` holds nothing. Per-chunk `limit` equals
 *     whole-signal `limit` because no sample depends on another.
 *   - **`normalize` is non-causal** — peak/RMS normalize scales by a factor derived from the **global**
 *     peak/RMS, which is unknown until the last sample, so the stage buffers the decoded chunks, then on
 *     `flush` concatenates them, runs the exact whole-signal kernels (so it cannot drift from the
 *     reference), and re-splits to the original framing/timestamps (gapless). This whole-signal buffer is
 *     inherent: no causal streaming normalize is bit-exact (loudness normalization is a two-pass / non-
 *     causal operation), so this is the correct cost, paid only when `normalize` is requested.
 *
 * Buffers are copied on `push` (the caller may reuse input arrays). An empty stream emits nothing.
 */
export function dynamicsStage(spec: DynamicsSpec): StatefulAudioStage {
  if (spec.normalize === undefined) {
    // Causal: the limiter (or a no-op) is per-sample; emit one limited chunk per input chunk.
    return {
      push(chunk: PcmAudio): readonly PcmAudio[] {
        return [applyDynamicsChain(chunk, spec)];
      },
      flush(): readonly PcmAudio[] {
        return [];
      },
    };
  }
  // Non-causal: hold the decoded chunks; normalize (global stat) + limit on flush, framing preserved.
  const held: PcmAudio[] = [];
  return {
    push(chunk: PcmAudio): readonly PcmAudio[] {
      held.push({
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        frames: chunk.frames,
        planar: chunk.planar.map((ch) => ch.slice()),
      });
      return [];
    },
    flush(): readonly PcmAudio[] {
      if (held.length === 0) return [];
      const sizes = held.map((c) => c.frames);
      const processed = applyDynamicsChain(concatChunks(held), spec);
      held.length = 0;
      return splitLike(processed, sizes);
    },
  };
}
