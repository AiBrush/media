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

export { audioDataToPcm, pcmRangeToPlanarInit, pcmToPlanarInit } from '../dsp/audio-data.ts';

/** The audio `FilterSpec` variants this driver handles (resample / remix / gain). */
export type AudioDspSpec = Extract<FilterSpec, { mediaType: 'audio' }>;

/** True for the three audio filter specs (`resample`/`remix`/`gain`) served here. */
export function isAudioDspSpec(f: FilterSpec): f is AudioDspSpec {
  return f.mediaType === 'audio';
}

// ============ pure transform dispatch ============

/**
 * Apply one audio {@link AudioDspSpec} to canonical planar audio via the `src/dsp` kernels. Pure and
 * exhaustive over the three audio specs; `remix`/`resample` raise their own typed `CapabilityError` on
 * an unsupported channel pair or rate, which propagates through the stream.
 */
export function applyAudioFilter(audio: PcmAudio, spec: AudioDspSpec): PcmAudio {
  switch (spec.type) {
    case 'resample':
      return resample(audio, spec.sampleRate);
    case 'remix':
      return remix(audio, spec.channels);
    case 'gain':
      return gain(audio, spec.db);
    /* v8 ignore next 2 -- unreachable: the audio spec union is exhaustively handled above. */
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

/**
 * Build the `TransformStream<AudioData, AudioData>` for an audio spec. There is no device to acquire, so
 * `start`/`flush` are trivial; cancellation rides the `signal` abort listener (the `Transformer` type has
 * no `cancel` hook). Per chunk: copy samples out, transform via the dsp kernels, emit a new `AudioData`
 * carrying the source `timestamp`, and close the input exactly once in a `finally`.
 */
function createAudioFilterStream(
  spec: AudioDspSpec,
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
        const transformed = applyAudioFilter(audioDataToPcm(data), spec);
        const { init } = pcmToPlanarInit(transformed, data.timestamp);
        controller.enqueue(new AudioData(init));
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
