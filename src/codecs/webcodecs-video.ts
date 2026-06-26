/**
 * WebCodecs VIDEO codec driver (`tier:'hardware'`) — the codec-agnostic decode/encode backend for the
 * browser-native video codecs (H.264/HEVC/VP8/VP9/AV1, by config). It wraps `VideoDecoder`/`VideoEncoder`
 * as the contract's `TransformStream` seams (doc 05 §2; ADR-002: hardware WebCodecs is the fast path).
 *
 * Frame lifetime (doc 06 §3 — the rule that prevents leaks): every `VideoFrame` is `close()`d exactly
 * once. The **encoder consumes** each input frame — it `encode()`s then `close()`s it in a `finally`, so
 * the frame closes once even if `encode()` throws. The **decoder's output frames are owned by the
 * readable consumer** (the next stage / sink) which closes them; on cancel/error this driver closes any
 * frame still in its hands and the WebCodecs object. Backpressure: `transform()` awaits while the codec's
 * `*QueueSize` is at/above the high-water mark (driven by the `dequeue` event) so decoded frames never
 * pile up in GPU memory.
 *
 * B-frame ordering: **no reorder is performed.** WebCodecs guarantees `VideoDecoder` emits in
 * presentation order — W3C WebCodecs: "decoded video data outputs emitted … in presentation order",
 * with the dev note "the User Agent will have to reorder outputs into presentation order." Sorting here
 * would be redundant *and* break streaming (an unbounded buffer), so the live decoder enqueues frames in
 * arrival order. {@link reorderByTimestamp}/{@link isPresentationOrdered} are pure utilities for
 * tests/tools that must impose or assert ordering on a *captured* stream; they are not on the live path.
 *
 * Cancellation (doc 06 §7) threads through `StageOptions.signal`: aborting closes the WebCodecs object
 * and any in-flight frame and errors the readable with `aborted`. WebCodecs is absent in Node, so every
 * branch that touches it is guarded (→ {@link CapabilityError}) and marked `/* v8 ignore *​/`; the real
 * frame-flow is validated in the browser harness. The pure helpers below are Node-unit-tested.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DecoderConfig,
  Determinism,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  RawFrame,
  Registry,
  StageOptions,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';

// ── pure helpers (Node-unit-tested; real logic on the live path) ─────────────────────────────────

/**
 * Map the determinism modifier to the `hardwareAcceleration` hint used to **configure** a coder.
 * `force-software` pins `prefer-software` for cross-machine reproducibility (ADR-007); otherwise
 * `no-preference` — the UA accelerates when it can **and** falls back to a software coder when no hardware
 * exists. (We deliberately do **not** pin `prefer-hardware` here: a software-only codec — VP8/VP9/AV1, or
 * H.264/HEVC/AAC on some browsers — would then *fail to configure* even though it encodes/decodes fine in
 * software. `supports()` still reports `hardwareAccelerated` honestly from its `isConfigSupported` probe.)
 */
export function normalizeHardwareAcceleration(
  determinism: Determinism | undefined,
): HardwareAcceleration {
  return determinism === 'force-software' ? 'prefer-software' : 'no-preference';
}

/**
 * GOP decision for the encoder: should the frame at `index` be forced to a key frame? Frame 0 always is
 * (a stream must open on a key frame). For a positive `keyFrameInterval`, every Nth frame is keyed;
 * otherwise only frame 0 is forced and the encoder chooses the rest. `index` must be a non-negative
 * integer (a delta on a frame counter, not user input) — a violation is a programming error, surfaced.
 */
export function shouldKeyframe(index: number, keyFrameInterval: number | undefined): boolean {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`frame index must be a non-negative integer, got ${index}`);
  }
  if (index === 0) return true;
  if (keyFrameInterval === undefined || keyFrameInterval <= 0) return false;
  return index % keyFrameInterval === 0;
}

/**
 * Backpressure predicate: is the codec's pending-work queue at/above the high-water mark? When true,
 * `transform()` waits (on the `dequeue` event) before submitting more, keeping in-flight frames bounded.
 * `highWaterMark` must be positive — a zero/negative mark would stall the pipeline forever.
 */
export function queueIsBackpressured(queueSize: number, highWaterMark: number): boolean {
  if (!(highWaterMark > 0)) {
    throw new RangeError(`highWaterMark must be positive, got ${highWaterMark}`);
  }
  return queueSize >= highWaterMark;
}

/**
 * `Transformer` plus the standard `cancel(reason)` hook (fired when the readable is cancelled — e.g. a
 * consumer `reader.cancel()`). The bundled `lib.dom` `Transformer` predates `cancel`, so we add it with a
 * typed local extension rather than reach for `any`; the runtime invokes it as the spec defines.
 */
interface TransformerWithCancel<I, O> extends Transformer<I, O> {
  cancel?: (reason?: unknown) => void | PromiseLike<void>;
}

/** Minimal closable shape (a `VideoFrame`/`AudioData`) — lets the enqueue guard be Node-tested. */
export interface Closable {
  close(): void;
}

/** Minimal enqueue sink (a `TransformStreamDefaultController`) — lets the enqueue guard be Node-tested. */
export interface EnqueueSink<T> {
  enqueue(chunk: T): void;
}

/**
 * Hand a freshly-decoded frame to the readable, **or close it** if the readable is already closed or the
 * enqueue throws — so the WebCodecs `output` callback can never throw an unhandled error after the
 * consumer closed/cancelled the stream (e.g. a `seek` that found its target frame and `cancel()`ed the
 * reader while the decoder was still draining). This is the rule that keeps the harness page alive.
 *
 * Close-exactly-once: returns `true` when the frame was enqueued (the **consumer** now owns and will
 * close it — the caller must not close it); returns `false` when this function closed the frame (it never
 * reached a consumer). Pure (no WebCodecs) and Node-unit-tested.
 */
export function enqueueOrClose<T extends Closable>(
  controller: EnqueueSink<T>,
  frame: T,
  isClosed: () => boolean,
): boolean {
  if (isClosed()) {
    frame.close(); // readable already gone → this frame is never consumed; release it now
    return false;
  }
  try {
    controller.enqueue(frame); // ownership transfers to the readable consumer
    return true;
  } catch {
    // Lost the close→enqueue race (the readable closed between the check and here): close, don't rethrow.
    frame.close();
    return false;
  }
}

/**
 * The **encoder** analogue of {@link enqueueOrClose} for `EncodedChunk`s: enqueue the chunk to the
 * readable the muxer consumes, or **drop it** if the readable is closed / the enqueue throws — so the
 * WebCodecs encoder `output` callback can never throw an unhandled error after the muxer closed/cancelled
 * the stream (a mux error, an early-stop trim, or an abort). Encoded chunks are **not** ref-counted
 * (`EncodedVideoChunk`/`EncodedAudioChunk` hold a byte copy, no `close()`), so a dropped chunk is simply
 * garbage-collected — nothing to release, no leak. Returns `true` if enqueued, `false` if dropped. Pure;
 * Node-unit-tested.
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
 * Classify a WebCodecs **decoder** runtime error (its `error` callback's `DOMException`) as a typed
 * engine error. A `VideoDecoder`/`AudioDecoder` whose native decode fails — even on a config its own
 * `isConfigSupported` *approved* — is the substrate declaring it **cannot decode this in this browser**:
 * that is a capability miss (ADR-017), not an engine fault. Mapping it to a {@link CapabilityError}
 * (rather than a generic `decode-error`) lets the engine/harness degrade to a clean **capability-miss /
 * NA** instead of an unhandled DOMException crashing the run — the cross-browser gate (Safari/WebKit
 * notoriously throws `EncodingError: "Decoder failure"` for streams `isConfigSupported` claimed it
 * accepts, e.g. some sub-block / tiny-dimension / profile-specific H.264 bitstreams that Chromium
 * decodes). The original `DOMException` is preserved as `detail` (never swallowed). A robustness
 * graceful-failure oracle still passes on this throw (a clean rejection is the desired PASS). `coded`
 * names the codec for the diagnostic. Pure; Node-unit-tested.
 */
export function decoderErrorToCapabilityMiss(
  e: DOMException | Error,
  driverId: string,
  codec: string | undefined,
): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    `${driverId}: this browser's native decoder cannot decode ${codec ?? 'this stream'} ` +
      `(${e.name}: ${e.message}); routing to a capability miss`,
    { op: 'decode', tried: [driverId], suggestion: 'try another browser or a WASM decode tail' },
  );
}

// ── codec support: hardware-then-software probing (the transcode-coverage fix) ────────────────────

/**
 * The canonical RFC-6381 codec-string **prefixes** this driver can drive (the planner builds the full
 * level/profile string; the driver advertises the families it routes). A target whose codec string does
 * not start with one of these is not a WebCodecs video codec we own. Node-tested for completeness so the
 * transcode planner and this driver agree on the supported set.
 */
export const VIDEO_CODEC_PREFIXES = [
  'avc1',
  'avc3',
  'hvc1',
  'hev1',
  'vp8',
  'vp09',
  'av01',
] as const;

/** True when a codec string names a WebCodecs **video** codec this driver routes (by RFC-6381 prefix). */
export function isVideoCodecString(codec: string): boolean {
  return VIDEO_CODEC_PREFIXES.some((p) => codec === p || codec.startsWith(`${p}.`));
}

/**
 * The order to probe `hardwareAcceleration` when answering `supports()` — **hardware first, then a
 * software-permitting probe**. WebCodecs' software-only encoders (notably VP8/VP9/AV1 and, on some
 * browsers, H.264/HEVC/AAC) report `isConfigSupported({hardwareAcceleration:'prefer-hardware'}) =
 * supported:false` when no hardware encoder exists for that codec, even though the codec **is** encodable
 * in software. Probing `prefer-hardware`-only therefore wrongly NAs every software-encode target (a large
 * share of the transcode matrix). Falling back to `no-preference` (which lets the UA pick a software
 * coder) recovers them; the order preserves the `hardwareAccelerated` truth (hardware is reported only
 * when the hardware probe actually succeeds).
 */
export const ACCELERATION_PROBE_ORDER = ['prefer-hardware', 'no-preference'] as const;

/** One `isConfigSupported` probe outcome: did it report support, and (if so) was it the hardware path. */
export interface SupportProbe {
  supported: boolean;
  /** The accepted config's `hardwareAcceleration`, if the UA reported one (for honest `hardwareAccelerated`). */
  acceleration?: HardwareAcceleration;
}

/**
 * Combine the ordered probe outcomes (hardware-first, then software) into one {@link CodecSupport}. The
 * first probe that reports `supported` wins; `hardwareAccelerated` is reported only when the **winning**
 * probe pinned `prefer-hardware` (honest — a software-fallback win is reported as not accelerated).
 * When none support it, the result is `{supported:false}` with the optional `reason`. Pure; Node-tested.
 */
export function combineSupport(probes: readonly SupportProbe[], reason?: string): CodecSupport {
  for (const p of probes) {
    if (p.supported) {
      return { supported: true, hardwareAccelerated: p.acceleration === 'prefer-hardware' };
    }
  }
  return reason !== undefined ? { supported: false, reason } : { supported: false };
}

/** Minimal shape the ordering utilities need: a presentation timestamp (µs). */
interface Timestamped {
  readonly timestamp: number;
}

/**
 * Pure, stable sort of a captured frame/chunk sequence into ascending presentation order. Returns a new
 * array (does not mutate the input). **Not used on the live decode path** — see the module note — it
 * exists for tests/tools that must impose order on an already-collected stream.
 */
export function reorderByTimestamp<T extends Timestamped>(items: readonly T[]): T[] {
  // Index-keying makes stability explicit (independent of the engine's sort-stability guarantee), so
  // equal timestamps keep their input order deterministically.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.timestamp - b.item.timestamp || a.index - b.index)
    .map(({ item }) => item);
}

/** True iff timestamps are non-decreasing (i.e. already in presentation order). Pure; for assertions. */
export function isPresentationOrdered(items: readonly Timestamped[]): boolean {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    if (prev === undefined || cur === undefined) continue; // unreachable for i in [1,length); satisfies the checker
    if (cur.timestamp < prev.timestamp) return false;
  }
  return true;
}

// ── config narrowing (this is the VIDEO driver; audio configs are an honest miss) ────────────────

/** A video decode query carries a {@link VideoDecoderConfig} (`codedWidth`/`codedHeight`). */
function asVideoDecoderConfig(c: DecoderConfig): VideoDecoderConfig | undefined {
  return 'codedWidth' in c || 'codedHeight' in c ? (c as VideoDecoderConfig) : undefined;
}

/** A video encode query carries a {@link VideoEncoderConfig} (`width`/`height`). */
function asVideoEncoderConfig(c: EncoderConfig): VideoEncoderConfig | undefined {
  return 'width' in c && 'height' in c ? (c as VideoEncoderConfig) : undefined;
}

// ── driver-local encoder options (additive; the public method keeps the `StageOptions` signature) ─

/**
 * Optional encoder controls layered onto {@link StageOptions} (the contract parameter type is unchanged
 * — these are read off `o` when present, additive). `keyFrameInterval` forces a key frame every Nth
 * frame (GOP); `onDecoderConfig` hands the muxer the encoder-produced `VideoDecoderConfig` (codec string
 * + `description`, e.g. avcC/hvcC) that the contract's chunk-only stream cannot carry.
 */
export interface VideoEncoderStageOptions extends StageOptions {
  /** Force a key frame every Nth frame; omit/≤0 ⇒ only frame 0 is forced (encoder decides the rest). */
  keyFrameInterval?: number;
  /** Receives the decoder config (with `description`) emitted with the encoder's first chunk. */
  onDecoderConfig?: (config: VideoDecoderConfig) => void;
}

function readEncoderInterval(o: StageOptions | undefined): number | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.keyFrameInterval;
  return typeof v === 'number' ? v : undefined;
}

function readDecoderConfigSink(
  o: StageOptions | undefined,
): ((config: VideoDecoderConfig) => void) | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.onDecoderConfig;
  return typeof v === 'function' ? v : undefined;
}

// ── environment guards ───────────────────────────────────────────────────────────────────────────

const HIGH_WATER_MARK = 8 as const; // pending decode/encode requests tolerated before we await `dequeue`

function hasVideoDecoder(): boolean {
  return typeof VideoDecoder !== 'undefined';
}

function hasVideoEncoder(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

function absentWebCodecsError(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    `WebCodecs Video${op === 'decode' ? 'Decoder' : 'Encoder'} is unavailable in this environment`,
    { op, tried: [] },
  );
}

function unsupportedVideoCodecError(op: 'decode' | 'encode', codec: string): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    `webcodecs-video cannot ${op} unsupported video codec string '${codec}'`,
    { op, tried: ['webcodecs-video'] },
  );
}

// ── supports() — cheap, honest, never throws (wraps isConfigSupported) ────────────────────────────

async function supportsDecode(config: DecoderConfig): Promise<CodecSupport> {
  const videoConfig = asVideoDecoderConfig(config);
  if (!videoConfig) return { supported: false, reason: 'not a video decoder config' };
  if (!isVideoCodecString(videoConfig.codec)) {
    return {
      supported: false,
      reason: `unsupported video codec string '${videoConfig.codec}'`,
    };
  }
  if (!hasVideoDecoder()) {
    return {
      supported: false,
      reason: 'WebCodecs VideoDecoder is unavailable in this environment',
    };
  }
  /* v8 ignore start -- requires WebCodecs VideoDecoder; validated under browser-mode (Phase 1) */
  // Probe hardware first, then a software-permitting probe (ACCELERATION_PROBE_ORDER): a software-only
  // decoder reports `prefer-hardware` unsupported but `no-preference` supported, so probing hardware-only
  // would wrongly NA it. The router drops this whole tier under `force-software` (doc 04 §6).
  const probes: SupportProbe[] = [];
  let lastReason: string | undefined;
  for (const acceleration of ACCELERATION_PROBE_ORDER) {
    try {
      const { supported, config: accepted } = await VideoDecoder.isConfigSupported({
        ...videoConfig,
        hardwareAcceleration: acceleration,
      });
      const accel = accepted?.hardwareAcceleration;
      probes.push(
        accel !== undefined
          ? { supported: supported === true, acceleration: accel }
          : { supported: supported === true },
      );
      if (supported === true) break; // first win short-circuits (hardware preferred)
    } catch (e) {
      lastReason = describeError(e); // isConfigSupported rejects only on a malformed config
    }
  }
  return combineSupport(probes, lastReason ?? 'codec not supported by this browser');
  /* v8 ignore stop */
}

async function supportsEncode(config: EncoderConfig): Promise<CodecSupport> {
  const videoConfig = asVideoEncoderConfig(config);
  if (!videoConfig) return { supported: false, reason: 'not a video encoder config' };
  if (!isVideoCodecString(videoConfig.codec)) {
    return {
      supported: false,
      reason: `unsupported video codec string '${videoConfig.codec}'`,
    };
  }
  if (!hasVideoEncoder()) {
    return {
      supported: false,
      reason: 'WebCodecs VideoEncoder is unavailable in this environment',
    };
  }
  /* v8 ignore start -- requires WebCodecs VideoEncoder; validated under browser-mode (Phase 1) */
  // Hardware-first, then software: VP8/VP9/AV1 (and H.264/HEVC on some browsers) have software-only
  // encoders that report `prefer-hardware` unsupported — probing hardware-only NAs every such transcode
  // target. The software-permitting `no-preference` probe recovers them (ACCELERATION_PROBE_ORDER).
  const probes: SupportProbe[] = [];
  let lastReason: string | undefined;
  for (const acceleration of ACCELERATION_PROBE_ORDER) {
    try {
      const { supported, config: accepted } = await VideoEncoder.isConfigSupported({
        ...videoConfig,
        hardwareAcceleration: acceleration,
      });
      const accel = accepted?.hardwareAcceleration;
      probes.push(
        accel !== undefined
          ? { supported: supported === true, acceleration: accel }
          : { supported: supported === true },
      );
      if (supported === true) break;
    } catch (e) {
      lastReason = describeError(e);
    }
  }
  return combineSupport(probes, lastReason ?? 'codec not supported by this browser');
  /* v8 ignore stop */
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── shared backpressure / abort plumbing (live paths require WebCodecs) ───────────────────────────

/* v8 ignore start -- the live coder paths require WebCodecs; validated under browser-mode (Phase 1) */

/** Resolve on the next `dequeue` (queue drained) or reject on abort; cleans up its listeners either way. */
function awaitDequeueOrAbort(
  coder: VideoDecoder | VideoEncoder,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new MediaError('aborted', 'operation aborted'));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      coder.removeEventListener('dequeue', onDequeue);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDequeue = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new MediaError('aborted', 'operation aborted'));
    };
    coder.addEventListener('dequeue', onDequeue);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Await until the coder's pending-work queue falls below the high-water mark (or abort). */
async function drainBelowHighWater(
  coder: VideoDecoder | VideoEncoder,
  signal: AbortSignal | undefined,
): Promise<void> {
  const sizeOf = (): number =>
    coder instanceof VideoDecoder ? coder.decodeQueueSize : coder.encodeQueueSize;
  while (queueIsBackpressured(sizeOf(), HIGH_WATER_MARK)) {
    await awaitDequeueOrAbort(coder, signal);
  }
}

// ── decoder: EncodedChunk → VideoFrame ───────────────────────────────────────────────────────────

function createVideoDecoder(
  config: DecoderConfig,
  o: StageOptions | undefined,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;

  let decoder: VideoDecoder | undefined;
  // The readable is dead (closed/cancelled/aborted/errored): once set, the async `output` callback must
  // NOT enqueue — it closes its frame instead. This is what prevents the "enqueue into a closed readable"
  // throw when a consumer (e.g. `seek`) cancels the reader while the decoder is still draining.
  let closed = false;
  // Frames the output callback is mid-handover on (synchronous window only): an abort that interleaves
  // still closes them exactly once. Enqueued frames are removed (the consumer owns them thereafter).
  const pendingFrames = new Set<VideoFrame>();

  const dispose = (): void => {
    closed = true;
    for (const frame of pendingFrames) frame.close();
    pendingFrames.clear();
    if (decoder && decoder.state !== 'closed') decoder.close(); // stop WebCodecs emitting + drop its buffers
  };

  const transformer: TransformerWithCancel<EncodedChunk, RawFrame> = {
    start(controller): void {
      // An external abort that outruns the stream teardown still releases resources + ends the readable.
      signal?.addEventListener(
        'abort',
        () => {
          dispose();
          controller.error(new MediaError('aborted', 'operation aborted'));
        },
        { once: true },
      );
      decoder = new VideoDecoder({
        output: (frame: VideoFrame): void => {
          // Never throw out of this async callback: enqueue if the readable is alive, else close the
          // frame. `pendingFrames` guards the synchronous handover window against an interleaved abort.
          if (closed) {
            frame.close();
            return;
          }
          pendingFrames.add(frame);
          enqueueOrClose<RawFrame>(controller, frame, () => closed); // closes the frame iff not handed over
          pendingFrames.delete(frame);
        },
        error: (e: DOMException): void => {
          // A native-decoder runtime failure (even on an isConfigSupported-approved config) = the browser
          // cannot decode this → a capability miss the engine degrades to NA, not a crashing DOMException.
          dispose();
          controller.error(decoderErrorToCapabilityMiss(e, 'webcodecs-video', config.codec));
        },
      });
      decoder.configure({
        ...config,
        hardwareAcceleration: normalizeHardwareAcceleration(o?.determinism),
      });
    },
    async transform(chunk): Promise<void> {
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      if (!decoder) throw new MediaError('decode-error', 'decoder not configured');
      if (!(chunk instanceof EncodedVideoChunk)) {
        throw new MediaError('decode-error', 'webcodecs-video decoder expects EncodedVideoChunk');
      }
      await drainBelowHighWater(decoder, signal);
      decoder.decode(chunk);
    },
    async flush(controller): Promise<void> {
      // Drain all queued work so every (presentation-ordered) frame is emitted before the readable
      // closes; then release the decoder. A flush failure becomes a typed decode-error.
      try {
        if (decoder && decoder.state === 'configured') await decoder.flush();
      } catch (e) {
        dispose();
        controller.error(new MediaError('decode-error', describeError(e), e));
        return;
      }
      closed = true; // the readable is about to close; reject any late `output` (none expected post-flush)
      if (decoder && decoder.state !== 'closed') decoder.close();
    },
    // The consumer closed/cancelled the readable (e.g. `seek` got its frame and `cancel()`ed the reader)
    // while the decoder may still be draining: mark closed and dispose the decoder so it stops emitting
    // and its remaining in-flight frames are dropped — no late enqueue, no leak.
    cancel(): void {
      dispose();
    },
  };
  return new TransformStream<EncodedChunk, RawFrame>(
    transformer,
    { highWaterMark: 1 }, // writable: keep the transform's own buffer tiny; the codec queue is the budget
    { highWaterMark: 0 }, // readable: pull-driven; the consumer's demand paces output
  );
}

// ── encoder: VideoFrame → EncodedChunk ───────────────────────────────────────────────────────────

function createVideoEncoder(
  config: VideoEncoderConfig,
  o: StageOptions | undefined,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  const keyFrameInterval = readEncoderInterval(o);
  const onDecoderConfig = readDecoderConfigSink(o);

  let encoder: VideoEncoder | undefined;
  let frameIndex = 0;
  // The readable (consumed by the muxer) is dead: once set, the async `output` callback must NOT enqueue
  // — it drops the chunk instead. Prevents the "enqueue into a closed readable" throw when the muxer
  // closes/cancels early (mux error, early-stop trim, abort) while the encoder is still draining.
  let closed = false;

  const dispose = (): void => {
    closed = true;
    if (encoder && encoder.state !== 'closed') encoder.close(); // stop WebCodecs emitting
  };

  const transformer: TransformerWithCancel<RawFrame, EncodedChunk> = {
    start(controller): void {
      signal?.addEventListener(
        'abort',
        () => {
          dispose();
          controller.error(new MediaError('aborted', 'operation aborted'));
        },
        { once: true },
      );
      encoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void => {
          // The encoder emits the decoder config (codec string + `description`) with (typically) the
          // first chunk; hand it to the muxer out-of-band, since the chunk stream is bytes-only.
          const decoderConfig = metadata?.decoderConfig;
          if (decoderConfig && onDecoderConfig) onDecoderConfig(decoderConfig);
          // Never throw out of this async callback: enqueue if the readable is alive, else drop the chunk
          // (a plain byte buffer — nothing to close, GC frees it).
          enqueueOrDrop(controller, chunk, () => closed);
        },
        error: (e: DOMException): void => {
          dispose();
          controller.error(new MediaError('encode-error', e.message, e));
        },
      });
      // Default to the hardware hint (this is the hardware-tier driver) unless the caller pinned one;
      // `force-software` would have routed away from this tier (doc 04 §6), but honor it defensively.
      encoder.configure({
        ...config,
        hardwareAcceleration:
          config.hardwareAcceleration ?? normalizeHardwareAcceleration(o?.determinism),
      });
    },
    async transform(frame): Promise<void> {
      if (!(frame instanceof VideoFrame)) {
        frame.close(); // close what we can't encode so it never leaks, then fail typed
        throw new MediaError('encode-error', 'webcodecs-video encoder expects a VideoFrame');
      }
      // The encoder CONSUMES the input frame: encode then close exactly once, even if encode() throws
      // or we abort. encode() reads the frame's pixels synchronously, so closing here is safe.
      try {
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        if (!encoder) throw new MediaError('encode-error', 'encoder not configured');
        await drainBelowHighWater(encoder, signal);
        encoder.encode(frame, { keyFrame: shouldKeyframe(frameIndex, keyFrameInterval) });
        frameIndex++;
      } finally {
        frame.close();
      }
    },
    async flush(controller): Promise<void> {
      try {
        if (encoder && encoder.state === 'configured') await encoder.flush();
      } catch (e) {
        dispose();
        controller.error(new MediaError('encode-error', describeError(e), e));
        return;
      }
      closed = true; // the readable is about to close; reject any late `output` (none expected post-flush)
      if (encoder && encoder.state !== 'closed') encoder.close();
    },
    // The muxer closed/cancelled the readable while the encoder may still be draining: mark closed and
    // dispose the encoder so it stops emitting — no late enqueue. (Chunks are byte buffers; nothing leaks.)
    cancel(): void {
      dispose();
    },
  };
  return new TransformStream<RawFrame, EncodedChunk>(
    transformer,
    { highWaterMark: 1 },
    { highWaterMark: 0 },
  );
}

/* v8 ignore stop */

// ── the driver + module ──────────────────────────────────────────────────────────────────────────

/**
 * The WebCodecs video codec driver: codec-agnostic (H.264/HEVC/VP8/VP9/AV1 by config), `tier:'hardware'`.
 * `supports()` defers to the browser-native `isConfigSupported`; the coders are `TransformStream`s whose
 * frame lifetime and cancellation obey doc 06 §3/§7.
 */
export const WebcodecsVideoDriver: CodecDriver = {
  id: 'webcodecs-video',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'hardware',
  supports(q: CodecQuery): Promise<CodecSupport> {
    if (q.mediaType !== 'video') {
      return Promise.resolve({ supported: false, reason: 'webcodecs-video handles video only' });
    }
    return q.direction === 'decode'
      ? supportsDecode(q.config)
      : supportsEncode(q.config as EncoderConfig);
  },
  createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame> {
    const videoConfig = asVideoDecoderConfig(c);
    if (!videoConfig) {
      throw new CapabilityError('capability-miss', 'webcodecs-video decodes video, not audio', {
        op: 'decode',
        tried: ['webcodecs-video'],
      });
    }
    if (!isVideoCodecString(videoConfig.codec)) {
      throw unsupportedVideoCodecError('decode', videoConfig.codec);
    }
    if (!hasVideoDecoder()) throw absentWebCodecsError('decode');
    /* v8 ignore next -- requires WebCodecs; validated under browser-mode (Phase 1) */
    return createVideoDecoder(videoConfig, o);
  },
  createEncoder(c: EncoderConfig, o?: StageOptions): TransformStream<RawFrame, EncodedChunk> {
    const videoConfig = asVideoEncoderConfig(c);
    if (!videoConfig) {
      throw new CapabilityError('capability-miss', 'webcodecs-video encodes video, not audio', {
        op: 'encode',
        tried: ['webcodecs-video'],
      });
    }
    if (!isVideoCodecString(videoConfig.codec)) {
      throw unsupportedVideoCodecError('encode', videoConfig.codec);
    }
    if (!hasVideoEncoder()) throw absentWebCodecsError('encode');
    /* v8 ignore next -- requires WebCodecs; validated under browser-mode (Phase 1) */
    return createVideoEncoder(videoConfig, o);
  },
};

/** The WebCodecs video driver module (registered via `media.use(...)` or the first-party defaults). */
export const WebcodecsVideoModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WebcodecsVideoDriver);
  },
};

export default WebcodecsVideoModule;
