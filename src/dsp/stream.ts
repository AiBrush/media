/**
 * Stream-stateful audio-dsp stages (doc 09 §audio-dsp; ADR — lossy-seam audio filter) — the streaming
 * twin of the whole-signal kernels ({@link fadeIn}/{@link fadeOut}, {@link biquad}, {@link normalizePeak}/
 * {@link normalizeRms}/{@link limit}). The whole-signal kernels take a complete {@link PcmAudio}; on the
 * **codec seam** (decode → filter → encode), audio arrives as a *stream of {@link PcmAudio} chunks*
 * (`AudioData` frames the engine decodes), so each filter must carry its state across chunk boundaries and
 * still produce output **bit-exactly equal to the whole-signal result** (the same oracle `transformPcm`
 * gates on).
 *
 * A {@link StatefulAudioStage} is that carry: `push(chunk)` consumes one input chunk and returns zero or
 * more output chunks; `flush()` drains any held tail at end-of-stream. The contract is exact:
 *
 *   - **framing is preserved 1:1 where the op is causal** — a stage that does not delay emits exactly one
 *     output chunk per input chunk, carrying that chunk's frame count and `timestamp` (gapless); only the
 *     sample *values* change. Non-causal ops ({@link fadeOut}'s tail, normalize's global scale) hold chunks
 *     and emit them on `flush` with their original framing/timestamps intact (the held chunks are simply
 *     released later, never re-split).
 *   - **bounded where the math allows it** — `fadeIn`/`limit`/`biquad` are O(channels) state and O(1)
 *     latency; `fadeOut` buffers only the fade tail (`outFrames`); `normalize` is inherently whole-signal
 *     (a non-causal global stat) and buffers the decoded audio — the SOTA truth that no causal streaming
 *     normalize is bit-exact (loudness normalization is a two-pass / non-causal operation).
 *
 * Pure and Node-testable: a stage is fed `PcmAudio` chunks directly (no `AudioData`), so the same arbitrary
 * chunk splits the browser seam produces are validated deterministically against the whole-signal kernels.
 * The `AudioData` `TransformStream` in `audio-dsp.ts` is a thin wrapper that reads each frame into a chunk,
 * drives the stage, and re-frames the outputs — that wrapper is browser-only and validated in the harness.
 */

import type { PcmAudio } from './pcm.ts';

export { biquadStage } from './biquad.ts';
export {
  type DynamicsSpec,
  type LimitSpec,
  type NormalizeSpec,
  dynamicsStage,
} from './dynamics.ts';
export { type FadeSpec, fadeStage } from './fade.ts';

/**
 * One stateful audio-dsp stage over a stream of canonical {@link PcmAudio} chunks. `push` returns the
 * output chunks ready after consuming `chunk` (possibly none, if the stage is buffering); `flush` returns
 * whatever remains at end-of-stream. Concatenating every emitted chunk (push…push, flush) yields the same
 * planar samples as the stage's whole-signal kernel applied to the concatenated input — bit-exactly.
 *
 * Every chunk shares the stage's channel count and sample rate (the engine routes remix/resample as their
 * own stages, so by the time a stateful stage runs the layout is fixed). Implementations never retain a
 * reference to an input chunk's `planar` arrays beyond what they copy (the caller may reuse buffers).
 */
export interface StatefulAudioStage {
  /** Consume one input chunk; return the output chunks now ready (0…n, same framing where causal). */
  push(chunk: PcmAudio): readonly PcmAudio[];
  /** Drain any held tail at end-of-stream; return the final output chunks (may be empty). */
  flush(): readonly PcmAudio[];
}

/** A {@link PcmAudio} chunk tagged with the presentation timestamp (µs) of its first frame. */
export interface TimedPcm {
  readonly audio: PcmAudio;
  readonly timestamp: number;
}
