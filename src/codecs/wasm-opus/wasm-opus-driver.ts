/**
 * The **WASM Opus** codec driver — the Phase-2 "miss-only" fallback for Opus decode/encode when the
 * browser's WebCodecs has no Opus `AudioDecoder`/`AudioEncoder` (docs/architecture/04 wasm tier, 05
 * §CodecDriver, ADR-026). `tier:'wasm'`, so the router ranks it **last** (hardware/gpu/native first) and
 * only builds it on a real WebCodecs Opus miss.
 *
 * **Shape mirrors {@link import('../webcodecs-audio.ts')}:** each coder is a `TransformStream` — the
 * stream *is* the lifecycle (configure on `start`, process on `transform`, drain on `flush`, release on
 * `cancel`/abort). The seam types are WebCodecs-native (`EncodedAudioChunk` ↔ `AudioData`) so the codec
 * substrate (here libopus-in-wasm) can change without touching its container/filter neighbours.
 *
 * **Self-hosted wasm, lazy, miss-only (BUILD §7, ADR-004):** the libopus core is vendored *into this
 * directory* and loaded through `new URL('./opus_wasm_bg.wasm', import.meta.url)` — same-origin, no CDN,
 * no COOP/COEP — and only when a coder is actually built. `supports()` answers honestly: if the vendored
 * core is absent (not yet built — see `BUILD.md`) it returns `false`, so the router falls through to a
 * typed {@link CapabilityError} instead of pretending Opus works. The pure framing/format math lives in
 * {@link import('./opus.ts')} and is validated in Node; the lossy CELT/SILK decode is the wasm core's.
 *
 * **`AudioData` close-exactly-once (docs/architecture/06 §3):** decoder *output* `AudioData` is enqueued
 * to the readable and owned by the consumer (the driver never closes an emitted frame); encoder *input*
 * `AudioData` is `close()`d by the driver in a `finally` right after its planes are copied — so an input
 * frame is released even if encode throws or the stream aborts mid-`transform`.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DecoderConfig,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  RawFrame,
  Registry,
  StageOptions,
  WasmRuntimeProfile,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { resolveWasmRuntimeProfile, wasmInitForProfile } from '../../kernel/wasm-runtime.ts';
import {
  FrameAccumulator,
  OPUS_RATE,
  type OpusDecoderInit,
  type OpusEncoderInit,
  type OpusWasmCore,
  type OpusWasmDecoder,
  type OpusWasmEncoder,
  deinterleaveF32,
  interleaveF32,
  normalizeOpusDecoderConfig,
  normalizeOpusEncoderConfig,
  packetDurationSamples,
} from './opus.ts';

// ============ pure, Node-testable helpers ============

/** The Opus codec id WebCodecs uses (RFC 6381 / WebCodecs codec registry). */
export const OPUS_CODEC = 'opus' as const;

/** True when a {@link CodecQuery} targets Opus audio — the only thing this driver can serve. */
export function isOpusQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.config.codec === OPUS_CODEC;
}

/**
 * The honest {@link CodecSupport} for a query this driver cannot serve — non-Opus, or the vendored wasm
 * core being absent. `supports()` must answer `false` (never throw) so the router can probe the ladder
 * cheaply (docs/architecture/05 §4); a miss then surfaces as a typed {@link CapabilityError} upstream.
 */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

/**
 * Per-channel output sample count for an Opus packet at a target decode rate: the packet's intrinsic
 * 48 kHz duration ({@link packetDurationSamples}) rescaled to `outRate`. libopus resamples internally; we
 * size the decode buffer to match. Integer for every (rate ∈ {8,12,16,24,48} kHz, Opus frame) pair.
 */
export function decodedSamplesAtRate(packet: Uint8Array, outRate: number): number {
  return (packetDurationSamples(packet) * outRate) / OPUS_RATE;
}

// ============ lazy, self-hosted wasm core ============

/**
 * The vendored glue module `wasm-pack build --target web` emits (see `BUILD.md`). Its `default` export is
 * an init function that fetches the sibling `*_bg.wasm` (we pass the `import.meta.url`-resolved URL so the
 * bundler emits it same-origin), and it exposes the {@link OpusWasmCore} factory. Typed structurally so
 * the driver compiles before the artifact exists (its shape is declared in `opus-core.d.ts`); the
 * dynamic specifier is a string literal so bundlers code-split it into its own lazy chunk.
 */

/** Memoized core load (one wasm instantiation per session); `null` once we've learned it is unavailable. */
let corePromise: Promise<OpusWasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasOpusCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./opus-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored libopus-in-wasm core, lazily and at most once. Resolves to the {@link OpusWasmCore},
 * or `null` if the artifact is not vendored yet (the import throws) — that `null` is what makes the
 * driver *honest* about wasm absence rather than fabricating support. The wasm bytes are addressed via
 * `new URL('./opus_wasm_bg.wasm', import.meta.url)` so they ship same-origin alongside this chunk.
 */
export async function loadOpusCore(runtime?: WasmRuntimeProfile): Promise<OpusWasmCore | null> {
  corePromise ??= (async (): Promise<OpusWasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      // String-literal specifier → its own code-split chunk; absent until `BUILD.md` is run.
      const mod = await import('./opus-core.js');
      await mod.default(
        wasmInitForProfile(new URL('./opus_wasm_bg.wasm', import.meta.url), profile),
      );
      return mod.createOpusCore();
    } catch {
      // Not vendored (or failed to instantiate): report absence; the router yields a CapabilityError.
      return null;
    }
  })();
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetOpusCoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored Opus wasm core is unavailable. */
function coreMissing(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-opus core is not available (not vendored)', {
    op,
    tried: ['wasm-opus'],
    suggestion: 'build + vendor the Opus wasm core per src/codecs/wasm-opus/BUILD.md',
  });
}

// ============ supports() ============

/**
 * Honest capability probe: Opus audio query **and** the vendored wasm core actually loads. Non-Opus or
 * core-absent → `{ supported:false }` with a reason; never throws (docs/architecture/05 §4). Being
 * `tier:'wasm'`, the router only calls this after WebCodecs Opus has already missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-opus handles audio only');
  if (q.config.codec !== OPUS_CODEC) {
    return unsupported(`wasm-opus handles Opus only, not '${q.config.codec}'`);
  }
  if (!(await hasOpusCoreGlue())) {
    return unsupported('wasm-opus core glue is not vendored (see BUILD.md)');
  }
  if (typeof EncodedAudioChunk === 'undefined' || typeof AudioData === 'undefined') {
    return unsupported('wasm-opus requires WebCodecs AudioData/EncodedAudioChunk');
  }
  return { supported: true, hardwareAccelerated: false };
}

// ============ seam narrowing (browser-only types) ============

/* v8 ignore start -- every branch below requires WebCodecs (absent in Node); validated in-browser. */

/** Narrow the encoded-unit seam to the audio arm; a video chunk here is a router/seam bug. */
function asAudioChunk(chunk: EncodedChunk): EncodedAudioChunk {
  if (chunk instanceof EncodedAudioChunk) return chunk;
  throw new MediaError(
    'decode-error',
    'wasm-opus received a non-audio chunk (router/seam mismatch)',
  );
}

/** Narrow the raw-frame seam to the `AudioData` arm; a `VideoFrame` here is a router/seam bug. */
function asAudioData(frame: RawFrame): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError('encode-error', 'wasm-opus received a VideoFrame (router/seam mismatch)');
}

/** Copy an Opus packet's bytes out of an `EncodedAudioChunk` (the wasm decoder takes a `Uint8Array`). */
function chunkBytes(chunk: EncodedAudioChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
}

/** Read an `AudioData`'s channels as interleaved f32 (the wasm encoder's input layout). */
function audioDataToInterleaved(data: AudioData): Float32Array {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const planes: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames);
    data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    planes.push(plane);
  }
  return interleaveF32(planes, frames);
}

/**
 * Build an `f32-planar` `AudioData` from the interleaved PCM the wasm decoder returned. `timestamp` is in
 * microseconds (WebCodecs convention); the readable consumer owns and `close()`s it exactly once.
 */
function buildAudioData(
  interleaved: Float32Array,
  channels: number,
  frames: number,
  sampleRate: number,
  timestampUs: number,
): AudioData {
  const planar = deinterleaveF32(interleaved, channels, frames);
  const buf = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) buf.set(planar[c] ?? new Float32Array(frames), c * frames);
  return new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfFrames: frames,
    numberOfChannels: channels,
    timestamp: timestampUs,
    data: buf,
  });
}

/** Microseconds for a sample offset at a sample rate (WebCodecs timestamps are µs). */
function samplesToMicros(samples: number, sampleRate: number): number {
  return Math.round((samples / sampleRate) * 1e6);
}

/* v8 ignore stop */

// ============ createDecoder() ============

/**
 * Build the Opus **decode** stream: `EncodedAudioChunk` (Opus packets) → `AudioData` (f32-planar). The
 * wasm core loads lazily on `start`; each packet decodes synchronously through libopus (Opus has no
 * inter-packet reorder, unlike video), and the resulting `AudioData` is enqueued for the consumer to own.
 */
function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  // Validate the config eagerly (fail-fast, Node-testable) before any wasm work.
  const init: OpusDecoderInit = normalizeOpusDecoderConfig(config as AudioDecoderConfig);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let decoder: OpusWasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  let emittedSamples = 0; // running PTS in output-rate samples (Opus packets are contiguous)

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    decoder?.free(); // idempotent; releases the native decoder
    decoder = undefined;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadOpusCore(o?.wasmRuntime);
      if (core === null) {
        controller.error(coreMissing('decode'));
        return;
      }
      decoder = core.createDecoder(init);
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(chunk, controller): void {
      const dec = decoder;
      if (!dec) throw new MediaError('decode-error', 'wasm-opus decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const packet = chunkBytes(asAudioChunk(chunk));
      const frames = decodedSamplesAtRate(packet, init.sampleRate);
      const interleaved = dec.decode(packet, frames);
      const data = buildAudioData(
        interleaved,
        init.channels,
        frames,
        init.sampleRate,
        samplesToMicros(emittedSamples, init.sampleRate),
      );
      emittedSamples += frames;
      controller.enqueue(data); // consumer owns + closes it
    },
    flush(): void {
      // Opus is packet-synchronous: every decoded sample was emitted in `transform`. Nothing to drain.
      teardown();
    },
  });
  /* v8 ignore stop */
}

// ============ createEncoder() ============

/**
 * Build the Opus **encode** stream: `AudioData` → `EncodedAudioChunk` (Opus packets). WebCodecs hands
 * arbitrary-length `AudioData`; Opus encodes fixed frames (default 20 ms), so input is re-chunked through
 * a {@link FrameAccumulator} and each full frame is encoded into one packet. The partial tail is flushed
 * zero-padded on writable close. Each input `AudioData` is `close()`d in a `finally` (close-exactly-once).
 */
function createEncoder(
  config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  const init: OpusEncoderInit = normalizeOpusEncoderConfig(config as AudioEncoderConfig);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let encoder: OpusWasmEncoder | undefined;
  let onAbort: (() => void) | undefined;
  const acc = new FrameAccumulator(init.channels, init.frameSamples);
  let encodedFrames = 0; // running PTS in input-rate samples

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    encoder?.free();
    encoder = undefined;
  };

  const drainTo = (controller: TransformStreamDefaultController<EncodedChunk>): void => {
    const enc = encoder;
    if (!enc) return;
    for (let frame = acc.pull(); frame !== undefined; frame = acc.pull()) {
      const bytes = enc.encode(frame);
      controller.enqueue(
        new EncodedAudioChunk({
          type: 'key', // every Opus packet is independently decodable
          timestamp: samplesToMicros(encodedFrames, init.sampleRate),
          duration: samplesToMicros(init.frameSamples, init.sampleRate),
          data: bytes,
        }),
      );
      encodedFrames += init.frameSamples;
    }
  };

  return new TransformStream<RawFrame, EncodedChunk>({
    async start(controller): Promise<void> {
      const core = await loadOpusCore(o?.wasmRuntime);
      if (core === null) {
        controller.error(coreMissing('encode'));
        return;
      }
      encoder = core.createEncoder(init);
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(frame, controller): void {
      const data = asAudioData(frame);
      try {
        if (!encoder) throw new MediaError('encode-error', 'wasm-opus encoder not configured');
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        acc.push(audioDataToInterleaved(data));
        drainTo(controller);
      } finally {
        data.close(); // close-exactly-once: the encoder owns each input AudioData
      }
    },
    flush(controller): void {
      const enc = encoder;
      if (enc) {
        drainTo(controller); // any whole frames still buffered
        const tail = acc.drainFinal(); // zero-padded final frame, if a partial remains
        if (tail) {
          const bytes = enc.encode(tail.frame);
          controller.enqueue(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: samplesToMicros(encodedFrames, init.sampleRate),
              duration: samplesToMicros(init.frameSamples - tail.padSamples, init.sampleRate),
              data: bytes,
            }),
          );
        }
      }
      teardown();
    },
  });
  /* v8 ignore stop */
}

// ============ driver + module ============

/** The WASM Opus codec driver — `tier:'wasm'`, Opus only, vendored core loaded miss-only (ADR-026). */
export const WasmOpusDriver: CodecDriver = {
  id: 'wasm-opus',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmOpusModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmOpusDriver);
  },
};

export default WasmOpusModule;
