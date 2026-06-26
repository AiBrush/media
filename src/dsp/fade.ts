/**
 * Fade & cross-fade (doc 09 §audio-dsp) — sample-accurate gain envelopes over the canonical planar
 * Float64 buffer. Pure TS, deterministic, like {@link gain}: returns new audio, leaves the input
 * untouched, and never clips in the float domain (a fade only attenuates; a cross-fade sums two
 * attenuated signals — saturation, if any, happens only at the integer encode boundary, {@link encodePcm}).
 *
 * Two envelope shapes drive every op:
 *
 *   - **`linear`** — fade-in `g(t)=t`, fade-out `g(t)=1−t`. Constant *amplitude*; the natural ramp for
 *     correlated material. On a cross-fade of *uncorrelated* signals it dips −6 dB at the midpoint.
 *   - **`equal-power`** — fade-in `g(t)=sin(t·π/2)`, fade-out `g(t)=cos(t·π/2)`. Since `sin²+cos²=1` the
 *     summed power is constant across a cross-fade, so it has **no midpoint hole** — the SOTA default for
 *     cross-fades (the same curve WebAudio/DAWs use). It is `crossfade`'s default; `fadeIn`/`fadeOut`
 *     default to `linear` (a plain ramp is what a single-ended fade usually wants).
 *
 * Endpoints are exact for both shapes: a fade-in starts at gain 0 and ends at 1; a fade-out starts at 1
 * and ends at 0 (`sin 0=0, sin π/2=1, cos 0=1, cos π/2=0`). Sample `i` of an `N`-frame fade uses the
 * normalized position `t=i/(N−1)` (so the last ramped sample lands exactly on the endpoint — no
 * off-by-one); a degenerate `N≤1` region uses `t=0`.
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';
import type { StatefulAudioStage } from './stream.ts';

/** Fade curve: amplitude-linear, or constant-power (`sin`/`cos`, the cross-fade default). */
export type FadeShape = 'linear' | 'equal-power';

/** The fade-in gain at normalized position `t ∈ [0,1]` for a shape (0 at `t=0`, 1 at `t=1`). */
function gainIn(t: number, shape: FadeShape): number {
  return shape === 'linear' ? t : Math.sin((t * Math.PI) / 2);
}

/** The fade-out gain at normalized position `t ∈ [0,1]` for a shape (1 at `t=0`, 0 at `t=1`). */
function gainOut(t: number, shape: FadeShape): number {
  return shape === 'linear' ? 1 - t : Math.cos((t * Math.PI) / 2);
}

/** Validate a frame-count argument: a non-negative integer (negatives are clamped to "no fade" upstream). */
function checkDuration(durationFrames: number, what: string): void {
  if (!Number.isInteger(durationFrames)) {
    throw new InputError('unsupported-input', `${what} must be an integer frame count`);
  }
}

function clonePlanar(audio: PcmAudio): PcmAudio {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    frames: audio.frames,
    planar: audio.planar.map((ch) => ch.slice()),
  };
}

/**
 * Ramp the first `durationFrames` samples from gain 0→1 (the rest pass through at unity), applied to
 * every channel. `durationFrames ≤ 0` is an identity copy; `≥ frames` fades the whole signal.
 *
 * @throws InputError if `durationFrames` is not an integer.
 */
export function fadeIn(
  audio: PcmAudio,
  durationFrames: number,
  shape: FadeShape = 'linear',
): PcmAudio {
  checkDuration(durationFrames, 'fade-in duration');
  if (durationFrames <= 0) return clonePlanar(audio);
  const n = Math.min(durationFrames, audio.frames);
  const denom = n > 1 ? n - 1 : 1; // N=1 ⇒ t=0 (single-sample fade is just the start gain)
  const planar = audio.planar.map((ch) => {
    const out = ch.slice();
    for (let i = 0; i < n; i++) out[i] = sampleAt(ch, i) * gainIn(i / denom, shape);
    return out;
  });
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planar };
}

/**
 * Ramp the **last** `durationFrames` samples from gain 1→0 (earlier samples pass through), applied to
 * every channel. `durationFrames ≤ 0` is an identity copy; `≥ frames` fades the whole signal.
 *
 * @throws InputError if `durationFrames` is not an integer.
 */
export function fadeOut(
  audio: PcmAudio,
  durationFrames: number,
  shape: FadeShape = 'linear',
): PcmAudio {
  checkDuration(durationFrames, 'fade-out duration');
  if (durationFrames <= 0) return clonePlanar(audio);
  const n = Math.min(durationFrames, audio.frames);
  const denom = n > 1 ? n - 1 : 1;
  const start = audio.frames - n;
  const planar = audio.planar.map((ch) => {
    const out = ch.slice();
    for (let i = 0; i < n; i++)
      out[start + i] = sampleAt(ch, start + i) * gainOut(i / denom, shape);
    return out;
  });
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planar };
}

/**
 * Cross-fade `a` into `b`: play `a`, overlap its tail with the head of `b` over `overlapFrames` summing
 * `a·gainOut + b·gainIn`, then continue with `b`. Result length is `a.frames + b.frames − overlap`. The
 * non-overlapped head of `a` and tail of `b` pass through unchanged. `equal-power` (the default) keeps
 * the summed power constant across the join (no midpoint hole). The overlap clamps to the shorter input.
 *
 * @throws CapabilityError if `a` and `b` differ in channel count or sample rate (incompatible to sum).
 * @throws InputError if `overlapFrames` is not an integer.
 */
export function crossfade(
  a: PcmAudio,
  b: PcmAudio,
  overlapFrames: number,
  shape: FadeShape = 'equal-power',
): PcmAudio {
  checkDuration(overlapFrames, 'cross-fade overlap');
  if (a.channels !== b.channels || a.sampleRate !== b.sampleRate) {
    throw new CapabilityError(
      'capability-miss',
      `cannot cross-fade incompatible audio (${a.channels}ch@${a.sampleRate} vs ${b.channels}ch@${b.sampleRate})`,
      { op: 'filter', tried: [] },
    );
  }
  const overlap = Math.max(0, Math.min(overlapFrames, a.frames, b.frames));
  const frames = a.frames + b.frames - overlap;
  const headLen = a.frames - overlap; // a's samples before the join
  const denom = overlap > 1 ? overlap - 1 : 1;
  const planar: Float64Array[] = [];
  for (let c = 0; c < a.channels; c++) {
    const ca = channelAt(a.planar, c);
    const cb = channelAt(b.planar, c);
    const out = new Float64Array(frames);
    // a's exclusive head.
    for (let i = 0; i < headLen; i++) out[i] = sampleAt(ca, i);
    // the overlap: a's tail (fading out) summed with b's head (fading in).
    for (let i = 0; i < overlap; i++) {
      const t = i / denom;
      out[headLen + i] =
        sampleAt(ca, headLen + i) * gainOut(t, shape) + sampleAt(cb, i) * gainIn(t, shape);
    }
    // b's exclusive tail.
    for (let i = overlap; i < b.frames; i++) out[headLen + i] = sampleAt(cb, i);
    planar.push(out);
  }
  return { sampleRate: a.sampleRate, channels: a.channels, frames, planar };
}

// ============ streaming fade stage (codec seam) ============

/** A resolved fade envelope for the streaming stage: source-rate frame counts + the curve. */
export interface FadeSpec {
  readonly curve: FadeShape;
  /** Fade-in length in frames (0 ⇒ no fade-in). */
  readonly inFrames: number;
  /** Fade-out length in frames (0 ⇒ no fade-out). */
  readonly outFrames: number;
}

/** A held chunk plus the absolute frame index of its first frame (for index-driven gain at emit time). */
interface HeldFade {
  readonly planar: readonly Float64Array[];
  readonly frames: number;
  readonly start: number;
  readonly sampleRate: number;
  readonly channels: number;
}

/** The fade-in gain at absolute frame index `i` for an `nIn`-frame fade-in (1 once `i ≥ nIn`). */
function fadeInGainAt(i: number, nIn: number, curve: FadeShape): number {
  if (nIn <= 0 || i >= nIn) return 1;
  const denom = nIn > 1 ? nIn - 1 : 1;
  return gainIn(i / denom, curve);
}

/** The fade-out gain at absolute frame index `i` for an `nOut`-frame fade-out ending at `total` (1 before). */
function fadeOutGainAt(i: number, nOut: number, total: number, curve: FadeShape): number {
  const start = total - nOut;
  if (nOut <= 0 || i < start) return 1;
  const denom = nOut > 1 ? nOut - 1 : 1;
  return gainOut((i - start) / denom, curve);
}

/**
 * Apply the (fade-in × fade-out) envelope to one held chunk by **absolute** frame index, returning a new
 * chunk (held buffers are never mutated). `nIn`/`nOut` are the clamped fade lengths; `total` (the final
 * frame count) is only needed for the fade-out tail position — pass `undefined` for an early-committed
 * chunk that is proven to be entirely outside the tail (fade-out gain is then 1).
 */
function applyFadeEnvelope(
  held: HeldFade,
  nIn: number,
  nOut: number,
  total: number | undefined,
  curve: FadeShape,
): PcmAudio {
  const planar = held.planar.map((ch) => {
    const out = new Float64Array(held.frames);
    for (let k = 0; k < held.frames; k++) {
      const abs = held.start + k;
      const gOut = total === undefined ? 1 : fadeOutGainAt(abs, nOut, total, curve);
      out[k] = (ch[k] ?? 0) * fadeInGainAt(abs, nIn, curve) * gOut;
    }
    return out;
  });
  return { sampleRate: held.sampleRate, channels: held.channels, frames: held.frames, planar };
}

/**
 * A {@link StatefulAudioStage} applying a duration-aware fade across a stream of {@link PcmAudio} chunks,
 * bit-exactly equal to `fadeOut(fadeIn(whole, inFrames), outFrames)` (the `transformPcm` reference) — for
 * **any** chunk split and **without trusting duration metadata**. A fade-out needs the absolute tail
 * position, so the stage holds back the last `H = max(inFrames, outFrames)` frames in a FIFO; a front chunk
 * is committed once `≥ H` frames follow it (proving it is outside both the tail and any fade-in clamp), and
 * the held remainder is faded at `flush` when the true total is known.
 *
 * Why `H = max(inFrames, outFrames)` and not just `outFrames`: it makes the clamp reasoning exact. The
 * whole-signal kernels clamp a fade longer than the signal to the signal length; a committed-early frame at
 * absolute index `i` provably has `> i + max(inFrames,outFrames)` total frames after it, so `total > inFrames`
 * (its fade-in uses the unclamped `denom`, matching the kernel) **and** `total > i + outFrames` (its fade-out
 * gain is 1). If instead `total ≤ inFrames` or `total ≤ outFrames` (a fade longer than the whole stream),
 * nothing is ever committed early — the entire signal sits in the FIFO at `flush`, where it is faded with the
 * correctly-clamped lengths. So no frame is ever scaled with the wrong clamp, in either regime.
 *
 * Framing is preserved 1:1 (each input chunk maps to one output chunk with the same frame count and the
 * caller's timestamp), so the stream stays gapless; only the sample values change. Memory is bounded by
 * `H + one chunk`. An empty stream emits nothing. Held buffers are copied on `push` so the caller may reuse
 * input arrays.
 */
export function fadeStage(spec: FadeSpec): StatefulAudioStage {
  const { curve } = spec;
  const nIn = Math.max(0, spec.inFrames);
  const nOut = Math.max(0, spec.outFrames);
  const holdback = Math.max(nIn, nOut);
  const queue: HeldFade[] = [];
  let queuedFrames = 0; // total frames currently held in `queue`
  let produced = 0; // total frames consumed from the input so far (absolute counter)

  const enqueue = (chunk: PcmAudio): void => {
    queue.push({
      planar: chunk.planar.map((ch) => ch.slice()),
      frames: chunk.frames,
      start: produced,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
    });
    queuedFrames += chunk.frames;
    produced += chunk.frames;
  };

  return {
    push(chunk: PcmAudio): readonly PcmAudio[] {
      enqueue(chunk);
      const out: PcmAudio[] = [];
      // Commit any front chunk that is provably outside the tail (≥ holdback frames follow it).
      while (queue.length > 0) {
        const front = queue[0] as HeldFade;
        if (queuedFrames - front.frames < holdback) break;
        queue.shift();
        queuedFrames -= front.frames;
        // Outside the tail and (since holdback ≥ nIn) past any fade-in clamp ⇒ fade-out gain is 1.
        out.push(applyFadeEnvelope(front, nIn, nOut, undefined, curve));
      }
      return out;
    },
    flush(): readonly PcmAudio[] {
      const total = produced;
      const effIn = Math.min(nIn, total);
      const effOut = Math.min(nOut, total);
      const out = queue.map((held) => applyFadeEnvelope(held, effIn, effOut, total, curve));
      queue.length = 0;
      queuedFrames = 0;
      return out;
    },
  };
}
