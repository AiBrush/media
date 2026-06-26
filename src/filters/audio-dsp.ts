/**
 * Audio filter driver (doc 09 §audio-dsp, ADR-022) — the `AudioData` filter seam over the pure-TS
 * audio-dsp kernels (`src/dsp`). It serves the three **audio** `FilterSpec` variants the video filter
 * driver does not: `resample{sampleRate}` (band-limited windowed-sinc, {@link resample}),
 * `remix{channels}` (BS.775 up/down-mix, {@link remix}), and `gain{db}` ({@link gain}). Each is a
 * `TransformStream<AudioData, AudioData>` per the {@link FilterDriver} contract.
 *
 * **Substrate.** This kernel is pure TS on the CPU, so it declares `substrate:'native'`. The router ranks
 * native below WebGPU/WebGL/Canvas2D, keeping GPU pixel filters first, and above the WASM tail reserved for
 * future compiled filter cores. No WASM runs here.
 *
 * **Frame lifetime (doc 06 §3).** Each input `AudioData` is `close()`d **exactly once** — synchronously
 * in a `finally` right after its samples are copied out (the `copyTo` reads fully consume it before the
 * output is built, so nothing is buffered across an `await`). The emitted output `AudioData` is owned by
 * the readable consumer, which closes it; this driver never closes a frame it has emitted. Audio has no
 * B-frames, so there is no reorder buffer — output goes straight to the readable (as in `webcodecs-audio`).
 *
 * The pure core — `AudioData ⇄ PcmAudio` framing ({@link audioDataToPcm}/{@link pcmToPlanarInit}) and the
 * transform dispatch ({@link applyAudioFilter}) — is Node-unit-tested on real, can-fail oracles. Only the
 * `new AudioData(...)` construction and the pumped stream require a browser (`AudioData` is absent in
 * Node); those branches are feature-guarded and `/* v8 ignore *​/`-marked and validated in the browser
 * harness. `createFilter` fails fast with a typed {@link CapabilityError} when `AudioData` is unavailable.
 */

import {
  DRIVER_API_VERSION,
  type DriverModule,
  type FilterDriver,
  type FilterSpec,
  type Registry,
  type StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { audioDataToPcm, pcmToPlanarInit } from '../dsp/audio-data.ts';
import { gain } from '../dsp/gain.ts';
import { remix } from '../dsp/mix.ts';
import type { PcmAudio } from '../dsp/pcm.ts';
import { resample } from '../dsp/resample.ts';
import { type StatefulAudioStage, biquadStage, dynamicsStage, fadeStage } from '../dsp/stream.ts';

export { audioDataToPcm, pcmRangeToPlanarInit, pcmToPlanarInit } from '../dsp/audio-data.ts';

/** Every audio `FilterSpec` variant this driver handles (the six `mediaType:'audio'` specs). */
export type AudioDspSpec = Extract<FilterSpec, { mediaType: 'audio' }>;

/**
 * The **stateless** audio specs — pure per-chunk transforms with no cross-chunk state: `resample`,
 * `remix`, `gain`. Each maps one input `AudioData` to one output `AudioData` independently.
 */
export type StatelessAudioSpec = Extract<AudioDspSpec, { type: 'resample' | 'remix' | 'gain' }>;

/**
 * The **stateful** audio specs — whole-signal effects made to cross the codec seam by carrying state across
 * chunks: `fade` (tail look-ahead), `biquad` (persisted DF2T registers), `dynamics` (a whole-signal
 * normalize buffer / per-sample limiter). Each is driven through a {@link StatefulAudioStage}.
 */
export type StatefulAudioSpec = Extract<AudioDspSpec, { type: 'fade' | 'biquad' | 'dynamics' }>;

/** True for every audio filter spec served here (the stateless and stateful variants). */
export function isAudioDspSpec(f: FilterSpec): f is AudioDspSpec {
  return f.mediaType === 'audio';
}

/** True for a stateful audio spec (`fade`/`biquad`/`dynamics`) — driven via a {@link StatefulAudioStage}. */
export function isStatefulAudioSpec(f: AudioDspSpec): f is StatefulAudioSpec {
  return f.type === 'fade' || f.type === 'biquad' || f.type === 'dynamics';
}

// ============ pure transform dispatch ============

/**
 * Apply one **stateless** audio spec to canonical planar audio via the `src/dsp` kernels. Pure and
 * exhaustive over `resample`/`remix`/`gain`; `remix`/`resample` raise their own typed `CapabilityError` on
 * an unsupported channel pair or rate, which propagates through the stream. The stateful specs
 * (`fade`/`biquad`/`dynamics`) do not flow through here — they run via {@link createStatefulStage}.
 */
export function applyAudioFilter(audio: PcmAudio, spec: StatelessAudioSpec): PcmAudio {
  switch (spec.type) {
    case 'resample':
      return resample(audio, spec.sampleRate);
    case 'remix':
      return remix(audio, spec.channels);
    case 'gain':
      return gain(audio, spec.db);
    /* v8 ignore next 2 -- unreachable: the stateless spec union is exhaustively handled above. */
    default:
      return exhaustive(spec);
  }
}

/**
 * Build the {@link StatefulAudioStage} for a stateful audio spec at the live stream's `sampleRate`. Pure
 * (no `AudioData`): the stage operates on canonical {@link PcmAudio} chunks, so it is Node-tested directly
 * (`stream.test.ts`) in arbitrary chunk splits against the whole-signal kernels. `biquad` designs its
 * coefficients at `sampleRate`; `fade`/`dynamics` are rate-agnostic (their frame counts/targets are already
 * resolved in the spec). Exhaustive over the three stateful specs.
 */
export function createStatefulStage(
  spec: StatefulAudioSpec,
  sampleRate: number,
): StatefulAudioStage {
  switch (spec.type) {
    case 'fade':
      return fadeStage({ curve: spec.curve, inFrames: spec.inFrames, outFrames: spec.outFrames });
    case 'biquad':
      return biquadStage(spec.spec, sampleRate);
    case 'dynamics':
      return dynamicsStage(spec.dynamics);
    /* v8 ignore next 2 -- unreachable: the stateful spec union is exhaustively handled above. */
    default:
      return exhaustive(spec);
  }
}

// ============ AudioData ⇄ PcmAudio framing (pure over the read/build surface) ============

// ============ stream wiring (browser-only seam) ============

/* v8 ignore start -- requires the WebCodecs `AudioData` constructor (absent in Node); the framing and
   transform this delegates to are Node-tested above. Validated end-to-end in the browser harness. */

/** Narrow the raw-frame seam to `AudioData`; a `VideoFrame` on an audio filter stream is a routing bug. */
function asAudioData(frame: AudioData): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError(
    'encode-error',
    'audio-dsp filter received a non-AudioData frame (seam mismatch)',
  );
}

/** Build an output `AudioData` from a transformed PCM chunk carrying `timestamp` (µs). */
function emitPcm(
  controller: TransformStreamDefaultController<AudioData>,
  audio: PcmAudio,
  timestamp: number,
): void {
  const { init } = pcmToPlanarInit(audio, timestamp);
  controller.enqueue(new AudioData(init));
}

/**
 * Build the `TransformStream<AudioData, AudioData>` for a **stateless** audio spec (`resample`/`remix`/
 * `gain`). No device to acquire, so `start` is trivial; cancellation rides the `signal` abort listener (the
 * `Transformer` type has no `cancel` hook). Per chunk: copy samples out, transform via the dsp kernels, emit
 * a new `AudioData` carrying the source `timestamp`, and close the input exactly once in a `finally`.
 */
function createStatelessFilterStream(
  spec: StatelessAudioSpec,
  opts: StageOptions | undefined,
): TransformStream<AudioData, AudioData> {
  const signal = opts?.signal;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

  return new TransformStream<AudioData, AudioData>({
    start(): void {
      if (signal?.aborted === true)
        throw new MediaError('aborted', 'audio filter cancelled before start');
    },
    transform(frame: AudioData, controller): void {
      const data = asAudioData(frame);
      try {
        if (aborted || signal?.aborted === true)
          throw new MediaError('aborted', 'audio filter cancelled');
        emitPcm(controller, applyAudioFilter(audioDataToPcm(data), spec), data.timestamp);
      } finally {
        // The samples were copied out synchronously above; release the input exactly once.
        data.close();
      }
    },
    flush(): void {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    },
  });
}

/**
 * Build the `TransformStream<AudioData, AudioData>` for a **stateful** audio spec (`fade`/`biquad`/
 * `dynamics`), driving a {@link StatefulAudioStage} across chunks. The stage is built lazily from the first
 * frame's `sampleRate` (the live, post-resample rate). Each input frame's samples are copied into canonical
 * PCM and the input is closed exactly once; the stage may return zero output chunks (it is buffering a fade
 * tail or the whole-signal normalize) and emit them later, including at `flush`.
 *
 * Timestamps: the stage preserves framing 1:1 (one output chunk per input chunk, in order, possibly
 * delayed), so a parallel FIFO of input timestamps aligns exactly — each emitted chunk dequeues the next
 * pending timestamp. The FIFO must never under/over-run; a mismatch would be a stage-contract bug and is
 * asserted as a typed `MediaError` rather than silently emitting a wrong timestamp.
 */
function createStatefulFilterStream(
  spec: StatefulAudioSpec,
  opts: StageOptions | undefined,
): TransformStream<AudioData, AudioData> {
  const signal = opts?.signal;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

  let stage: StatefulAudioStage | undefined;
  const pendingTimestamps: number[] = []; // input-chunk timestamps awaiting their output chunk (FIFO)

  const drain = (
    controller: TransformStreamDefaultController<AudioData>,
    chunks: readonly PcmAudio[],
  ): void => {
    for (const chunk of chunks) {
      const timestamp = pendingTimestamps.shift();
      if (timestamp === undefined) {
        throw new MediaError(
          'encode-error',
          'audio-dsp stateful stage emitted more chunks than it consumed (framing contract violated)',
        );
      }
      emitPcm(controller, chunk, timestamp);
    }
  };

  return new TransformStream<AudioData, AudioData>({
    start(): void {
      if (signal?.aborted === true)
        throw new MediaError('aborted', 'audio filter cancelled before start');
    },
    transform(frame: AudioData, controller): void {
      const data = asAudioData(frame);
      let pcm: PcmAudio;
      try {
        if (aborted || signal?.aborted === true)
          throw new MediaError('aborted', 'audio filter cancelled');
        pcm = audioDataToPcm(data);
        pendingTimestamps.push(data.timestamp);
      } finally {
        // Samples are copied out synchronously above; release the input exactly once.
        data.close();
      }
      stage ??= createStatefulStage(spec, pcm.sampleRate);
      drain(controller, stage.push(pcm));
    },
    flush(controller): void {
      if (signal?.aborted === true) throw new MediaError('aborted', 'audio filter cancelled');
      // An empty stream never built the stage; nothing to drain.
      if (stage !== undefined) drain(controller, stage.flush());
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    },
  });
}

/** Dispatch to the stateless per-chunk stream or the stateful staged stream by spec kind. */
function createAudioFilterStream(
  spec: AudioDspSpec,
  opts: StageOptions | undefined,
): TransformStream<AudioData, AudioData> {
  return isStatefulAudioSpec(spec)
    ? createStatefulFilterStream(spec, opts)
    : createStatelessFilterStream(spec, opts);
}

/* v8 ignore stop */

// ============ driver + module ============

/** `AudioData` (the filter seam) exists only in a browser/worker — false in Node, so `supports()` is honest. */
function audioDataAvailable(): boolean {
  return typeof AudioData !== 'undefined';
}

/**
 * The audio-dsp filter driver (`substrate:'native'` — the pure-TS CPU tier; see the file header).
 * `supports()` is honest: true only for an audio spec **and** when the `AudioData` seam exists (so it
 * returns `false` in Node and the router never builds a stream there). `createFilter` fails fast with a typed
 * `CapabilityError` for a non-audio spec or an absent `AudioData`, never deferring the miss into the stream.
 */
export const audioDspFilterDriver: FilterDriver = {
  id: 'audio-dsp-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: 'native',
  supports(f: FilterSpec): boolean {
    return isAudioDspSpec(f) && audioDataAvailable();
  },
  createFilter(f: FilterSpec, o?: StageOptions): TransformStream<AudioData, AudioData> {
    if (!isAudioDspSpec(f)) {
      throw new CapabilityError('capability-miss', `audio-dsp filter does not handle ${f.type}`, {
        op: 'filter',
        tried: [audioDspFilterDriver.id],
      });
    }
    if (!audioDataAvailable()) {
      throw new CapabilityError('capability-miss', 'WebCodecs AudioData is unavailable', {
        op: 'filter',
        tried: [audioDspFilterDriver.id],
        suggestion: 'run the audio filter in a browser/worker where AudioData exists',
      });
    }
    /* v8 ignore next -- browser-only stream construction (guarded above; validated in the browser harness). */
    return createAudioFilterStream(f, o);
  },
};

/* v8 ignore start -- unreachable exhaustiveness guard (a `never` parameter). */
/** Exhaustiveness guard — unreachable if the {@link AudioDspSpec} union is fully handled. */
function exhaustive(value: never): never {
  throw new MediaError('encode-error', `unhandled audio filter spec: ${String(value)}`);
}
/* v8 ignore stop */

/**
 * Driver module registering the audio-dsp filter. The router ranks it by `substrate` (`'native'`, the
 * pure-TS CPU tier) and selects it for the audio `FilterSpec` variants the GPU video filters do not serve.
 */
export const AudioDspFilterModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addFilter(audioDspFilterDriver);
  },
};

export default AudioDspFilterModule;
