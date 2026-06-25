/**
 * The WebCodecs **audio** codec driver — decode/encode one audio codec on the browser's native
 * `AudioDecoder`/`AudioEncoder` (docs/architecture/05 §2, 09 `decode`/`encode`, ADR-016). It is
 * codec-agnostic: AAC (`mp4a.40.*`), Opus, MP3, FLAC, and Vorbis are all driven by the
 * `AudioDecoderConfig`/`AudioEncoderConfig` the router hands it. `tier:'hardware'` because WebCodecs
 * is the fastest substrate and may be hardware-backed; the router ranks it first and falls back to a
 * WASM driver on a miss.
 *
 * **Why a `TransformStream` per coder (no bespoke init/close):** the stream *is* the lifecycle —
 * configure on `start`, process on `transform`, drain on `flush` (writable close), release on
 * `cancel`/abort. Backpressure (via `decodeQueueSize`/`encodeQueueSize`), cancellation (`signal`),
 * and error propagation come for free.
 *
 * **Audio has no B-frames**, so an `AudioDecoder` emits `AudioData` in presentation order (decode
 * order == presentation order). Unlike the video driver there is **no reorder buffer** — output is
 * forwarded straight to the readable as WebCodecs produces it.
 *
 * **`AudioData` close-exactly-once (the lifetime contract, docs/architecture/06 §3):**
 * - *Decoder output* `AudioData` is enqueued to the readable and **owned by the readable consumer**,
 *   which closes each exactly once; the driver never closes a frame it has emitted.
 * - *Encoder input* `AudioData` is closed by the driver immediately after `encoder.encode(data)`
 *   (WebCodecs copies the planes it needs during the synchronous `encode` call) — in a `finally`, so
 *   the frame is released even if `encode` throws. On abort/error, the only possible in-flight input
 *   is the one a `transform` is mid-way through, and streams serialize `transform` against
 *   `cancel`/`abort`, so no input frame leaks.
 *
 * **AAC `description` flow:** on *decode*, the `AudioDecoderConfig.description` (the AudioSpecificConfig
 * the MP4 demuxer read from `esds`) is preserved byte-for-byte into the configured decoder. On
 * *encode*, AAC's AudioSpecificConfig is produced **by** the encoder and surfaced to the
 * muxer through `EncodedAudioChunkMetadata.decoderConfig` ({@link decoderConfigFromEncoderMeta}); the
 * parent forwards it via the optional {@link AudioEncoderStageOptions.onConfig} callback.
 *
 * WebCodecs is browser-only: `AudioDecoder`/`AudioEncoder`/`AudioData` are absent in Node, so the
 * coder bodies are guarded (`typeof AudioDecoder === 'undefined'` → {@link CapabilityError}) and the
 * unguarded branches are validated under the browser harness, not Node coverage.
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
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';

// ============ pure, Node-testable helpers ============

/**
 * Above this many packets queued inside the WebCodecs coder we stop feeding and let it drain, so an
 * unbounded source can't balloon WebCodecs' internal buffer (and thus decoded-frame memory). WebCodecs
 * exposes `decodeQueueSize`/`encodeQueueSize` precisely so a producer can pace itself; this is the
 * pacing threshold ({@link shouldApplyBackpressure}). A small window keeps the pipeline full without
 * hoarding native memory.
 */
export const BACKPRESSURE_THRESHOLD = 8 as const;

/** True when the coder's queue is at/over {@link BACKPRESSURE_THRESHOLD} and the producer should wait. */
export function shouldApplyBackpressure(
  queueSize: number,
  threshold: number = BACKPRESSURE_THRESHOLD,
): boolean {
  return queueSize >= threshold;
}

/**
 * `Transformer` plus the standard `cancel(reason)` hook (fired when the readable is cancelled — e.g. a
 * consumer `reader.cancel()`). The bundled `lib.dom` `Transformer` predates `cancel`, so we add it with a
 * typed local extension rather than reach for `any`; the runtime invokes it as the spec defines.
 */
interface TransformerWithCancel<I, O> extends Transformer<I, O> {
  cancel?: (reason?: unknown) => void | PromiseLike<void>;
}

/** Minimal closable shape (an `AudioData`) — lets the enqueue guard be Node-tested without WebCodecs. */
export interface Closable {
  close(): void;
}

/** Minimal enqueue sink (a `TransformStreamDefaultController`) — lets the enqueue guard be Node-tested. */
export interface EnqueueSink<T> {
  enqueue(chunk: T): void;
}

/**
 * Hand a freshly-decoded `AudioData` to the readable, **or close it** if the readable is already closed
 * or the enqueue throws — so the WebCodecs `output` callback can never throw an unhandled error after the
 * consumer closed/cancelled the stream while the decoder was still draining (the seek/cancel race that
 * otherwise kills the page with "Cannot enqueue a chunk into a closed readable stream").
 *
 * Close-exactly-once: returns `true` when the frame was enqueued (the **consumer** now owns and will
 * close it — the caller must not); returns `false` when this function closed it (it never reached a
 * consumer). Pure (no WebCodecs) and Node-unit-tested.
 */
export function enqueueOrClose<T extends Closable>(
  controller: EnqueueSink<T>,
  frame: T,
  isClosed: () => boolean,
): boolean {
  if (isClosed()) {
    frame.close(); // readable already gone → never consumed; release it now
    return false;
  }
  try {
    controller.enqueue(frame); // ownership transfers to the readable consumer
    return true;
  } catch {
    // Lost the close→enqueue race (readable closed between the check and here): close, don't rethrow.
    frame.close();
    return false;
  }
}

/**
 * The **encoder** analogue of {@link enqueueOrClose} for `EncodedAudioChunk`s: enqueue the chunk to the
 * readable the muxer consumes, or **drop it** if the readable is closed / the enqueue throws — so the
 * WebCodecs encoder `output` callback can never throw an unhandled error after the muxer closed/cancelled
 * the stream (a mux error, an early-stop trim, or an abort). Encoded chunks are **not** ref-counted (no
 * `close()`; they hold a byte copy), so a dropped chunk is simply garbage-collected — no leak. Returns
 * `true` if enqueued, `false` if dropped. Pure; Node-unit-tested.
 */
export function enqueueOrDrop<T>(
  controller: EnqueueSink<T>,
  chunk: T,
  isClosed: () => boolean,
): boolean {
  if (isClosed()) return false; // readable gone → drop; the chunk is a plain byte buffer, GC frees it
  try {
    controller.enqueue(chunk);
    return true;
  } catch {
    return false; // lost the close→enqueue race: drop silently, never rethrow out of the output callback
  }
}

/**
 * Classify a WebCodecs **decoder** runtime error (its `error` callback's `DOMException`) as a typed engine
 * error. An `AudioDecoder` whose native decode fails — even on a config its own `isConfigSupported`
 * *approved* — is the substrate declaring it **cannot decode this in this browser**: a capability miss
 * (ADR-017), not an engine fault. Mapping it to a {@link CapabilityError} (rather than a generic
 * `decode-error`) lets the engine/harness degrade to a clean **capability-miss / NA** instead of an
 * unhandled DOMException crashing the run — the cross-browser gate (Safari/WebKit can throw on streams its
 * `isConfigSupported` accepted). The original `DOMException` is preserved as `detail` (never swallowed); a
 * robustness graceful-failure oracle still passes on this clean throw. Pure; Node-unit-tested.
 */
export function decoderErrorToCapabilityMiss(
  e: DOMException | Error,
  codec: string | undefined,
): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    `webcodecs-audio: this browser's native decoder cannot decode ${codec ?? 'this stream'} ` +
      `(${e.name}: ${e.message}); routing to a capability miss`,
    {
      op: 'decode',
      tried: ['webcodecs-audio'],
      suggestion: 'try another browser or a WASM decode tail',
    },
  );
}

/**
 * The canonical RFC-6381 codec-string **prefixes** this driver routes (the registry/audio-codec set the
 * `AudioDecoder`/`AudioEncoder` may serve): AAC (`mp4a`), Opus, MP3 (`mp3`/`mp4a.69`/`mp4a.6b`), FLAC,
 * Vorbis. Encode is browser-limited (typically AAC + Opus only); the driver advertises the **families**
 * and lets `isConfigSupported` answer per-direction. Node-tested for completeness vs the planner's set.
 */
export const AUDIO_CODEC_PREFIXES = ['mp4a', 'opus', 'mp3', 'flac', 'vorbis'] as const;

/** True when a codec string names a WebCodecs **audio** codec this driver routes (by RFC-6381 prefix). */
export function isAudioCodecString(codec: string): boolean {
  return AUDIO_CODEC_PREFIXES.some((p) => codec === p || codec.startsWith(`${p}.`));
}

/**
 * The WebCodecs audio config dictionaries carry an optional `hardwareAcceleration` hint (WebCodecs
 * spec §AudioDecoderConfig/§AudioEncoderConfig), but the bundled `lib.dom` `AudioDecoderConfig`/
 * `AudioEncoderConfig` omit it. We add it back with a typed local extension rather than reach for
 * `any`; `configure(...)` still accepts the superset structurally (the field is read at runtime).
 */
type AudioDecoderConfigEx = AudioDecoderConfig & { hardwareAcceleration?: HardwareAcceleration };
type AudioEncoderConfigEx = AudioEncoderConfig & { hardwareAcceleration?: HardwareAcceleration };

/**
 * The `hardwareAcceleration` preference for a determinism mode (ADR-007). `force-software` pins
 * `prefer-software` so a decode/encode is reproducible across machines (hardware coders differ
 * bit-for-bit); `auto` leaves `no-preference` so the platform picks the fastest path, which the
 * `tier:'hardware'` ranking already favours.
 */
export function hardwareAccelerationFor(
  determinism: StageOptions['determinism'],
): HardwareAcceleration {
  return determinism === 'force-software' ? 'prefer-software' : 'no-preference';
}

/**
 * Normalize an {@link AudioDecoderConfig} for configuration: carry every caller field through and set
 * `hardwareAcceleration` from `determinism`. The AAC `description` (AudioSpecificConfig from `esds`) is
 * preserved byte-for-byte — without it an `AudioDecoder` cannot configure AAC. `description` is
 * included only when present (so non-AAC codecs like Opus/MP3/FLAC/Vorbis stay description-less, as
 * required by `exactOptionalPropertyTypes`).
 */
export function normalizeAudioDecoderConfig(
  config: AudioDecoderConfig,
  determinism: StageOptions['determinism'],
): AudioDecoderConfigEx {
  return {
    ...config,
    hardwareAcceleration: hardwareAccelerationFor(determinism),
  };
}

/**
 * Normalize an {@link AudioEncoderConfig} for configuration: honor `codec`/`sampleRate`/
 * `numberOfChannels`/`bitrate` (and any other caller field) and set `hardwareAcceleration` from
 * `determinism`. For AAC the encoder *produces* the AudioSpecificConfig itself, so there is no input
 * `description` here — it comes back out via {@link decoderConfigFromEncoderMeta}.
 */
export function normalizeAudioEncoderConfig(
  config: AudioEncoderConfig,
  determinism: StageOptions['determinism'],
): AudioEncoderConfigEx {
  return {
    ...config,
    hardwareAcceleration: hardwareAccelerationFor(determinism),
  };
}

/**
 * Extract the {@link AudioDecoderConfig} (including AAC's `description`) an encoder publishes on its
 * `EncodedAudioChunkMetadata`, for the muxer. WebCodecs attaches `decoderConfig` to (at least) the
 * first emitted chunk; once seen it need not be read again. `EncodedAudioChunkMetadata` is a plain JS
 * dictionary (not a WebCodecs class), so this is fully unit-testable. Returns `undefined` when the
 * metadata carries no decoder config.
 */
export function decoderConfigFromEncoderMeta(
  meta: EncodedAudioChunkMetadata | undefined,
): AudioDecoderConfig | undefined {
  return meta?.decoderConfig;
}

/**
 * The honest {@link CodecSupport} when this driver cannot serve a query without consulting WebCodecs:
 * WebCodecs absent, or a non-audio query (this is the audio driver). `supports()` must answer `false`
 * rather than throw (docs/architecture/05 §4), so callers can probe cheaply.
 */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

// ============ encoder→muxer config channel ============

/**
 * `StageOptions` plus the optional sink the parent passes so the encoder can hand the muxer the
 * {@link AudioDecoderConfig} it produced (notably AAC's AudioSpecificConfig `description`). It is read
 * structurally off the options object — a purely additive, driver-local extension that does not change
 * the `CodecDriver` contract. Called at most once per encode, on the first chunk that carries a config.
 */
export interface AudioEncoderStageOptions extends StageOptions {
  onConfig?(config: AudioDecoderConfig): void;
}

/** Read the optional {@link AudioEncoderStageOptions.onConfig} sink off a `StageOptions` object. */
function configSink(
  o: StageOptions | undefined,
): ((config: AudioDecoderConfig) => void) | undefined {
  const sink = (o as AudioEncoderStageOptions | undefined)?.onConfig;
  return typeof sink === 'function' ? sink : undefined;
}

// ============ seam narrowing ============

/* v8 ignore start -- every branch below requires WebCodecs (absent in Node); validated in-browser. */

/** Narrow the encoded-unit seam to the audio arm this driver decodes; a video chunk here is a routing bug. */
function asAudioChunk(chunk: EncodedChunk): EncodedAudioChunk {
  if (chunk instanceof EncodedAudioChunk) return chunk;
  throw new MediaError(
    'decode-error',
    'webcodecs-audio received a non-audio encoded chunk (router/seam mismatch)',
  );
}

/** Narrow the raw-frame seam to the `AudioData` arm this driver encodes; a `VideoFrame` here is a routing bug. */
function asAudioData(frame: RawFrame): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError(
    'encode-error',
    'webcodecs-audio received a VideoFrame (router/seam mismatch)',
  );
}

/** Wrap a WebCodecs error-callback value as a typed stage error (never leak a bare `DOMException`). */
function codecError(code: 'decode-error' | 'encode-error', e: DOMException): MediaError {
  return new MediaError(code, `webcodecs-audio ${code}: ${e.message}`, e);
}

/** Spin until the coder's internal queue drains below the backpressure threshold (or `signal` aborts). */
async function awaitDrain(queueSize: () => number, signal: AbortSignal | undefined): Promise<void> {
  while (shouldApplyBackpressure(queueSize())) {
    if (signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* v8 ignore stop */

// ============ supports() ============

async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('webcodecs-audio handles audio codecs only');

  if (q.direction === 'decode') {
    if (typeof AudioDecoder === 'undefined') return unsupported('AudioDecoder is unavailable');
    /* v8 ignore start -- requires WebCodecs AudioDecoder; validated in-browser. */
    try {
      const support = await AudioDecoder.isConfigSupported(q.config as AudioDecoderConfig);
      return codecSupport(support.supported === true, support.config);
    } catch (e) {
      return unsupported(e instanceof Error ? e.message : 'isConfigSupported rejected');
    }
    /* v8 ignore stop */
  }

  if (typeof AudioEncoder === 'undefined') return unsupported('AudioEncoder is unavailable');
  /* v8 ignore start -- requires WebCodecs AudioEncoder; validated in-browser. */
  try {
    const support = await AudioEncoder.isConfigSupported(q.config as AudioEncoderConfig);
    return codecSupport(support.supported === true, support.config);
  } catch (e) {
    return unsupported(e instanceof Error ? e.message : 'isConfigSupported rejected');
  }
  /* v8 ignore stop */
}

/**
 * Build a {@link CodecSupport} from `isConfigSupported`'s answer, reporting `hardwareAccelerated` only
 * when the resolved config actually pins `prefer-hardware` (read through the {@link AudioDecoderConfigEx}
 * view, since `lib.dom`'s support-config type omits the field). Honest: an unknown preference is left off.
 */
/* v8 ignore start -- only reached with WebCodecs present; validated in-browser. */
function codecSupport(
  supported: boolean,
  config: AudioDecoderConfig | AudioEncoderConfig | undefined,
): CodecSupport {
  const accel = (config as AudioDecoderConfigEx | undefined)?.hardwareAcceleration;
  return {
    supported,
    ...(accel !== undefined ? { hardwareAccelerated: accel === 'prefer-hardware' } : {}),
  };
}
/* v8 ignore stop */

// ============ createDecoder() ============

function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  const determinism = o?.determinism;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  if (typeof AudioDecoder === 'undefined') {
    throw new CapabilityError('capability-miss', 'WebCodecs AudioDecoder is unavailable', {
      op: 'decode',
      tried: ['webcodecs-audio'],
    });
  }

  /* v8 ignore start -- requires WebCodecs AudioDecoder/AudioData; validated in-browser (Phase 1). */
  let decoder: AudioDecoder | undefined;
  let onAbort: (() => void) | undefined;
  // The readable is dead (closed/cancelled/aborted/errored): once set, the async `output` callback must
  // NOT enqueue — it closes its `AudioData` instead. Prevents the "enqueue into a closed readable" throw
  // when a consumer cancels the reader while the decoder is still draining.
  let closed = false;

  const teardown = (): void => {
    closed = true;
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    // Output AudioData already enqueued is owned by the readable consumer; closing the decoder drops
    // only frames still buffered *inside* WebCodecs. Guard so we never double-close.
    if (decoder && decoder.state !== 'closed') decoder.close();
  };

  const transformer: TransformerWithCancel<EncodedChunk, RawFrame> = {
    start(controller): void {
      const dec = new AudioDecoder({
        // Never throw out of this async callback: enqueue if the readable is alive, else close the
        // AudioData (close-exactly-once: enqueued → consumer closes; dropped-after-close → we close).
        output: (data) => {
          enqueueOrClose<RawFrame>(controller, data, () => closed);
        },
        error: (e) => {
          // A native-decoder runtime failure (even on an isConfigSupported-approved config) = the browser
          // cannot decode this → a capability miss the engine degrades to NA, not a crashing DOMException.
          teardown();
          controller.error(decoderErrorToCapabilityMiss(e, (config as AudioDecoderConfig).codec));
        },
      });
      dec.configure(normalizeAudioDecoderConfig(config as AudioDecoderConfig, determinism));
      decoder = dec;
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    async transform(chunk): Promise<void> {
      const dec = decoder;
      if (!dec) throw new MediaError('decode-error', 'decoder not configured');
      await awaitDrain(() => dec.decodeQueueSize, signal);
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      dec.decode(asAudioChunk(chunk));
    },
    async flush(): Promise<void> {
      const dec = decoder;
      if (!dec) return;
      await dec.flush(); // drains queued output through `output` → enqueueOrClose
      teardown();
    },
    // The consumer closed/cancelled the readable while the decoder may still be draining: mark closed and
    // dispose the decoder so it stops emitting and its in-flight AudioData is dropped — no late enqueue.
    cancel(): void {
      teardown();
    },
  };
  return new TransformStream<EncodedChunk, RawFrame>(transformer);
  /* v8 ignore stop */
}

// ============ createEncoder() ============

function createEncoder(
  config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  const determinism = o?.determinism;
  const onConfig = configSink(o);
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  if (typeof AudioEncoder === 'undefined') {
    throw new CapabilityError('capability-miss', 'WebCodecs AudioEncoder is unavailable', {
      op: 'encode',
      tried: ['webcodecs-audio'],
    });
  }

  /* v8 ignore start -- requires WebCodecs AudioEncoder/AudioData; validated in-browser (Phase 1). */
  let encoder: AudioEncoder | undefined;
  let onAbort: (() => void) | undefined;
  let configSent = false;
  // The readable (consumed by the muxer) is dead: once set, the async `output` callback must NOT enqueue
  // — it drops the chunk instead. Prevents the "enqueue into a closed readable" throw when the muxer
  // closes/cancels early (mux error, early-stop trim, abort) while the encoder is still draining.
  let closed = false;

  const teardown = (): void => {
    closed = true;
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    if (encoder && encoder.state !== 'closed') encoder.close();
  };

  const transformer: TransformerWithCancel<RawFrame, EncodedChunk> = {
    start(controller): void {
      const enc = new AudioEncoder({
        output: (chunk, meta) => {
          if (!configSent && onConfig) {
            const decoderConfig = decoderConfigFromEncoderMeta(meta);
            if (decoderConfig) {
              configSent = true;
              onConfig(decoderConfig); // hands the muxer AAC's AudioSpecificConfig (`description`)
            }
          }
          // Never throw out of this async callback: enqueue if the readable is alive, else drop the chunk
          // (a plain byte buffer — nothing to close, GC frees it).
          enqueueOrDrop(controller, chunk, () => closed);
        },
        error: (e) => {
          teardown();
          controller.error(codecError('encode-error', e));
        },
      });
      enc.configure(normalizeAudioEncoderConfig(config as AudioEncoderConfig, determinism));
      encoder = enc;
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    async transform(frame): Promise<void> {
      const enc = encoder;
      const data = asAudioData(frame);
      if (!enc) {
        data.close(); // never leak the input even on a misuse path
        throw new MediaError('encode-error', 'encoder not configured');
      }
      try {
        await awaitDrain(() => enc.encodeQueueSize, signal);
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        enc.encode(data); // copies the planes it needs synchronously
      } finally {
        data.close(); // close-exactly-once: the encoder owns each input AudioData
      }
    },
    async flush(): Promise<void> {
      const enc = encoder;
      if (!enc) return;
      await enc.flush();
      teardown();
    },
    // The muxer closed/cancelled the readable while the encoder may still be draining: mark closed and
    // dispose the encoder so it stops emitting — no late enqueue. (Chunks are byte buffers; nothing leaks.)
    cancel(): void {
      teardown();
    },
  };
  return new TransformStream<RawFrame, EncodedChunk>(transformer);
  /* v8 ignore stop */
}

// ============ driver + module ============

/** The WebCodecs audio codec driver — `tier:'hardware'`, codec-agnostic (AAC/Opus/MP3/FLAC/Vorbis). */
export const WebCodecsAudioDriver: CodecDriver = {
  id: 'webcodecs-audio',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'hardware',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via `media.use(...)` or the first-party defaults). */
export const WebCodecsAudioModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WebCodecsAudioDriver);
  },
};

export default WebCodecsAudioModule;
