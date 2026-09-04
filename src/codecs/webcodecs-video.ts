/**
 * WebCodecs VIDEO codec driver (`tier:'hardware'`) — the codec-agnostic decode/encode backend for the
 * browser-native video codecs (H.264/HEVC/VP8/VP9/AV1, by config). It wraps `VideoDecoder`/`VideoEncoder`
 * as the contract's `TransformStream` seams (doc 05 §2; ADR-002: hardware WebCodecs is the fast path).
 *
 * Frame lifetime (doc 06 §3 — the rule that prevents leaks): every `VideoFrame` is `close()`d exactly
 * once. The **encoder consumes** each input frame — it `encode()`s then `close()`s it in a `finally`, so
 * the frame closes once even if `encode()` throws. The **decoder** keeps decoded frames in an explicit
 * pull-driven queue until a readable consumer asks for them; the consumer closes handed-over frames, while
 * cancel/error closes every frame still in the driver queue plus the WebCodecs object. Backpressure:
 * decode submission awaits while the codec's `*QueueSize` or decoded-frame queue is at/above the
 * high-water mark, so decoded frames never pile up in GPU memory.
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
  CodecSupportOptions,
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
import { addH264AvcCVisibleRightCrop } from './h264-avcc-crop.ts';

// ── pure helpers (Node-unit-tested; real logic on the live path) ─────────────────────────────────

/**
 * Map the determinism modifier to the conservative coder fallback hint. `force-software` pins
 * `prefer-software` for cross-machine reproducibility (ADR-007); otherwise `no-preference` preserves
 * software-only encode coverage. Auto **decode** does not stop at this fallback: it configures the exact
 * hardware-first verdict accepted by `supports()`, with an exact no-preference capability fallback
 * ({@link resolveVideoDecoderAcceleration}, ADR-203).
 */
export function normalizeHardwareAcceleration(
  determinism: Determinism | undefined,
): HardwareAcceleration {
  return determinism === 'force-software' ? 'prefer-software' : 'no-preference';
}

/**
 * Whether an Apple WebCodecs H.264 encode needs a one-pixel horizontal phase pre-compensation.
 *
 * Apple H.264 encoders represent widths congruent to 2 (mod 4) with an odd 4:2:0 right-crop unit. In
 * current Chromium/WebKit this shifts the decoded visible picture one luma pixel right. Widths divisible
 * by four do not exhibit the phase error. Keep the workaround confined to Apple H.264 so standards-
 * conforming implementations and every other codec retain their original pixels and zero-copy path.
 */
export function needsAppleH264HorizontalPhaseCompensation(
  config: Pick<VideoEncoderConfig, 'codec' | 'width' | 'height'>,
  platform: string | undefined,
): boolean {
  const codec = config.codec.toLowerCase();
  const apple = platform !== undefined && /^(?:Mac|iP)/.test(platform);
  return (
    apple && (codec.startsWith('avc1.') || codec.startsWith('avc3.')) && config.width % 4 === 2
  );
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

interface CodecQuantizerOption {
  readonly quantizer: number;
}

interface VideoEncoderEncodeOptionsWithCodecQuantizer extends VideoEncoderEncodeOptions {
  readonly av1?: CodecQuantizerOption;
  readonly avc?: CodecQuantizerOption;
  readonly hevc?: CodecQuantizerOption;
  readonly vp9?: CodecQuantizerOption;
}

function assertValidEncodeQuantizer(quantizer: number): void {
  if (!Number.isFinite(quantizer) || quantizer < 0) {
    throw new RangeError(`quantizer must be a finite non-negative number, got ${quantizer}`);
  }
}

function quantizerEncodeOptions(
  codec: string,
  quantizer: number | undefined,
): Omit<VideoEncoderEncodeOptionsWithCodecQuantizer, 'keyFrame'> {
  if (quantizer === undefined) return {};
  assertValidEncodeQuantizer(quantizer);
  const lower = codec.toLowerCase();
  if (lower.startsWith('av01')) return { av1: { quantizer } };
  if (lower.startsWith('avc1') || lower.startsWith('avc3')) return { avc: { quantizer } };
  if (lower.startsWith('hev1') || lower.startsWith('hvc1')) return { hevc: { quantizer } };
  if (lower.startsWith('vp09')) return { vp9: { quantizer } };
  throw new CapabilityError(`codec '${codec}' has no WebCodecs quantizer option`, {
    op: { kind: 'route', id: 'encode' },
    tried: ['webcodecs-video'],
  });
}

export function videoEncodeOptions(
  index: number,
  keyFrameInterval: number | undefined,
  codec: string,
  quantizer: number | undefined,
): VideoEncoderEncodeOptionsWithCodecQuantizer {
  return {
    keyFrame: shouldKeyframe(index, keyFrameInterval),
    ...quantizerEncodeOptions(codec, quantizer),
  };
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
    `${driverId}: this browser's native decoder cannot decode ${codec ?? 'this stream'} ` +
      `(${e.name}: ${e.message}); routing to a capability miss`,
    {
      op: { kind: 'route', id: 'decode' },
      tried: [driverId],
      suggestion: 'try another browser or a WASM decode tail',
    },
    { cause: e },
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
 * `VideoDecoderConfig.alpha` exists in Chromium's WebCodecs implementation for alpha-capable VPx streams,
 * but the current TypeScript DOM lib only exposes `alpha` on `VideoEncoderConfig`. Keep the extension
 * local and structural so strict mode stays honest and future lib.dom additions do not change the public
 * driver contract.
 */
type VideoDecoderConfigWithAlpha = VideoDecoderConfig & { alpha?: AlphaOption };

/** True for video codec families whose WebCodecs path can carry an alpha plane. */
export function videoCodecCanCarryAlpha(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === 'vp8' || c.startsWith('vp8.') || c === 'vp9' || c.startsWith('vp09.');
}

/**
 * Normalize a decode config for WebCodecs configuration/probing. VP8/VP9 alpha streams are lossy if the
 * decoder silently discards the alpha plane, so alpha-capable VPx decode explicitly asks the browser to
 * keep it. Other codecs are left untouched; their alpha semantics are either nonexistent or container
 * specific and must not be guessed.
 */
export function normalizeVideoDecoderConfig(
  config: VideoDecoderConfig,
  hardwareAcceleration: HardwareAcceleration,
  alpha: AlphaOption | undefined = undefined,
): VideoDecoderConfigWithAlpha {
  return {
    ...config,
    hardwareAcceleration,
    ...(videoCodecCanCarryAlpha(config.codec)
      ? { alpha: alpha ?? (config as VideoDecoderConfigWithAlpha).alpha ?? ('keep' as const) }
      : {}),
  };
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
/** The live decoder's own order: the browser's choice first, then the software-permitting fallback. */
export const LIVE_DECODER_PROBE_ORDER = ['no-preference', 'prefer-software'] as const;

/** Exact acceleration probes for a routing mode; deterministic selection never probes a hardware hint. */
export function videoAccelerationProbeOrder(
  determinism: Determinism | undefined,
): readonly HardwareAcceleration[] {
  return determinism === 'force-software' ? ['prefer-software'] : ACCELERATION_PROBE_ORDER;
}

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

/** Result of one exact `VideoDecoder.isConfigSupported` acceleration probe. */
export interface VideoDecoderAccelerationProbeResult {
  readonly supported: boolean;
  /** The hint on the UA-returned accepted config; omitted means the requested hint was retained. */
  readonly acceptedAcceleration?: HardwareAcceleration;
}

/** Injectable seam for testing hardware-first resolution without mocking the browser's VideoDecoder. */
export type VideoDecoderAccelerationProbe = (
  acceleration: HardwareAcceleration,
) => Promise<VideoDecoderAccelerationProbeResult>;

/**
 * Resolve the no-I/O acceleration decision. `force-software` always wins over a cached auto verdict;
 * otherwise an exact cached verdict can configure synchronously. `undefined` means capability probing is
 * still required.
 */
export function immediateVideoDecoderAcceleration(
  determinism: Determinism | undefined,
  cached: HardwareAcceleration | undefined,
): HardwareAcceleration | undefined {
  return determinism === 'force-software' ? 'prefer-software' : cached;
}

/**
 * Resolve an exact decoder acceleration config hardware-first, then through the software-permitting
 * fallback. A rejected probe does not suppress the next rung. Returning `undefined` means neither exact
 * configuration was accepted and lets the caller raise a typed capability miss.
 */
export async function resolveVideoDecoderAcceleration(
  determinism: Determinism | undefined,
  cached: HardwareAcceleration | undefined,
  probe: VideoDecoderAccelerationProbe,
  shouldContinue: () => boolean = () => true,
  cancellation?: Promise<never>,
  order: readonly HardwareAcceleration[] = ACCELERATION_PROBE_ORDER,
): Promise<HardwareAcceleration | undefined> {
  const immediate = immediateVideoDecoderAcceleration(determinism, cached);
  if (immediate !== undefined) return immediate;
  for (const requested of order) {
    if (!shouldContinue()) return undefined;
    try {
      const pending = probe(requested);
      const result = await (cancellation === undefined
        ? pending
        : Promise.race([pending, cancellation]));
      if (result.supported) return result.acceptedAcceleration ?? requested;
    } catch {
      // A capability rejection for one hint is an honest miss for that rung, not for the fallback rung.
      if (!shouldContinue()) return undefined;
    }
  }
  return undefined;
}

/** Encode raw bytes exactly for a structural capability key (codec descriptions are normally tiny). */
function capabilityBytesKey(bytes: Uint8Array): string {
  let out = `${bytes.byteLength}:`;
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get;

/** Brand-check and view a direct ArrayBufferLike across realms; ordinary objects return undefined. */
function directArrayBufferBytes(value: object): Uint8Array | undefined {
  for (const getter of [ARRAY_BUFFER_BYTE_LENGTH_GETTER, SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER]) {
    if (getter === undefined) continue;
    try {
      const byteLength: unknown = Reflect.apply(getter, value, []);
      if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new TypeError('invalid ArrayBufferLike byte length');
      }
      return new Uint8Array(value as ArrayBufferLike, 0, byteLength);
    } catch {
      // Try the other branded buffer getter. Both getters reject ordinary and spoofed objects.
    }
  }
  return undefined;
}

/** Canonicalize the enumerable config shape WebCodecs receives; strict and cycle-safe. */
function capabilityValueKey(value: unknown, ancestors: Set<object>): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  switch (typeof value) {
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'number':
      if (Number.isNaN(value)) return 'dNaN';
      if (Object.is(value, -0)) return 'd-0';
      return `d${String(value)}`;
    case 'string':
      return `s${JSON.stringify(value)}`;
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new TypeError(`unsupported VideoDecoderConfig value type '${typeof value}'`);
    case 'object':
      break;
  }
  if (ArrayBuffer.isView(value)) {
    return `v${capabilityBytesKey(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    )}`;
  }
  const directBuffer = directArrayBufferBytes(value);
  if (directBuffer !== undefined) return `a${capabilityBytesKey(directBuffer)}`;
  if (ancestors.has(value)) {
    throw new TypeError('VideoDecoderConfig must not contain a cycle');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => capabilityValueKey(item, ancestors)).join(',')}]`;
    }
    if (Object.prototype.toString.call(value) !== '[object Object]') {
      throw new TypeError('unsupported object in VideoDecoderConfig');
    }
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${capabilityValueKey(Reflect.get(value, key), ancestors)}`,
      );
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Exact structural identity for the decoder config submitted to WebCodecs, excluding only the acceleration
 * rung being selected. Description bytes, geometry, colour, latency, and the effective VPx alpha option all
 * participate. The caller object and its description are never mutated or retained.
 */
export function videoDecoderCapabilityKey(
  config: VideoDecoderConfig,
  alpha: AlphaOption | undefined = undefined,
): string {
  const normalized = normalizeVideoDecoderConfig(config, 'no-preference', alpha);
  const { hardwareAcceleration: _hardwareAcceleration, ...capabilityConfig } = normalized;
  return capabilityValueKey(capabilityConfig, new Set<object>());
}

/** Bounded exact-config acceleration verdict cache (shared with the router's positive driver cache). */
export interface VideoDecoderAccelerationCache {
  get(config: VideoDecoderConfig, alpha: AlphaOption | undefined): HardwareAcceleration | undefined;
  set(
    config: VideoDecoderConfig,
    alpha: AlphaOption | undefined,
    acceleration: HardwareAcceleration,
  ): void;
  delete(config: VideoDecoderConfig, alpha: AlphaOption | undefined): void;
}

/** Create a bounded LRU whose keys compare decoder configs structurally, including description bytes. */
export function createVideoDecoderAccelerationCache(
  maxEntries = 64,
): VideoDecoderAccelerationCache {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const entries = new Map<string, HardwareAcceleration>();
  return {
    get(config, alpha): HardwareAcceleration | undefined {
      const key = videoDecoderCapabilityKey(config, alpha);
      const acceleration = entries.get(key);
      if (acceleration !== undefined) {
        entries.delete(key);
        entries.set(key, acceleration);
      }
      return acceleration;
    },
    set(config, alpha, acceleration): void {
      const key = videoDecoderCapabilityKey(config, alpha);
      entries.delete(key);
      entries.set(key, acceleration);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(config, alpha): void {
      entries.delete(videoDecoderCapabilityKey(config, alpha));
    },
  };
}

const videoDecoderAccelerationCache = createVideoDecoderAccelerationCache();

/** Cache a support verdict without ever turning an accepted browser capability into a thrown support probe. */
export function rememberVideoDecoderAcceleration(
  cache: VideoDecoderAccelerationCache,
  config: VideoDecoderConfig,
  alpha: AlphaOption | undefined,
  acceleration: HardwareAcceleration,
): boolean {
  try {
    cache.set(config, alpha, acceleration);
    return true;
  } catch {
    // An invalid/cyclic vendor extension is not cacheable. supports() still reports the UA's exact verdict.
    return false;
  }
}

/** Treat an uncacheable exact config as a cache miss; decoder start can still run the real UA probes. */
export function recallVideoDecoderAcceleration(
  cache: VideoDecoderAccelerationCache,
  config: VideoDecoderConfig,
  alpha: AlphaOption | undefined,
): HardwareAcceleration | undefined {
  try {
    return cache.get(config, alpha);
  } catch {
    return undefined;
  }
}

/** Best-effort invalidation for the same uncacheable extension case. */
export function forgetVideoDecoderAcceleration(
  cache: VideoDecoderAccelerationCache,
  config: VideoDecoderConfig,
  alpha: AlphaOption | undefined,
): void {
  try {
    cache.delete(config, alpha);
  } catch {
    // There was no usable cache key, so there is no retained verdict to invalidate.
  }
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

// ── driver-local codec options (additive; the public method keeps the `StageOptions` signature) ─────

/**
 * Optional decoder controls layered onto {@link StageOptions}. VPx-alpha decode normally keeps alpha so the
 * public decode path can emit RGBA frames. Packet-plane alpha transcodes decode color and alpha elementary
 * streams separately, so they can explicitly request `alpha:'discard'` and avoid an unnecessary RGBA layout.
 */
export interface VideoDecoderStageOptions extends StageOptions {
  /** Override VP8/VP9 decode alpha handling for specialized packet-plane routes. */
  alpha?: AlphaOption;
}

/**
 * Optional encoder controls layered onto {@link StageOptions} (the contract parameter type is unchanged
 * — these are read off `o` when present, additive). `keyFrameInterval` forces a key frame every Nth
 * frame (GOP); `quantizer` applies a constant codec-specific encode quantizer for CRF-style output;
 * `onDecoderConfig` hands the muxer the encoder-produced `VideoDecoderConfig` (codec string +
 * `description`, e.g. avcC/hvcC) that the contract's chunk-only stream cannot carry.
 */
export interface VideoEncoderStageOptions extends StageOptions {
  /** Force a key frame every Nth frame; omit/≤0 ⇒ only frame 0 is forced (encoder decides the rest). */
  keyFrameInterval?: number;
  /** Constant quality/CRF-style quantizer forwarded through the codec-specific WebCodecs encode option. */
  quantizer?: number;
  /**
   * Disposable pictures submitted before the first real key frame to prime a native bitrate controller.
   * Their timestamps are earlier than the first input timestamp and their chunks are never emitted.
   */
  rateControlWarmupFrames?: number;
  /**
   * Per-picture quantizer selected from prior-pass evidence. The callback runs synchronously before
   * `encode()` and must return the quantizer for this exact presentation timestamp.
   */
  quantizerAt?: (frame: VideoEncoderRateControlFrame) => number;
  /** Receives the decoder config (with `description`) emitted with the encoder's first chunk. */
  onDecoderConfig?: (config: VideoDecoderConfig) => void;
}

export interface VideoEncoderRateControlFrame {
  readonly index: number;
  readonly timestampUs: number;
  readonly durationUs: number | null;
  readonly keyFrame: boolean;
}

function readEncoderInterval(o: StageOptions | undefined): number | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.keyFrameInterval;
  return typeof v === 'number' ? v : undefined;
}

function readEncoderQuantizer(o: StageOptions | undefined): number | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.quantizer;
  return typeof v === 'number' ? v : undefined;
}

const MAX_RATE_CONTROL_WARMUP_FRAMES = 16;

function readRateControlWarmupFrames(o: StageOptions | undefined): number {
  const value = (o as VideoEncoderStageOptions | undefined)?.rateControlWarmupFrames;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RATE_CONTROL_WARMUP_FRAMES) {
    throw new RangeError(
      `rateControlWarmupFrames must be an integer in [0, ${MAX_RATE_CONTROL_WARMUP_FRAMES}], got ${value}`,
    );
  }
  return value;
}

/**
 * Allocate collision-free preroll timestamps strictly before the first real picture. An unsafe timeline
 * declines preroll instead of risking timestamp aliasing or integer precision loss.
 */
export function rateControlWarmupTimestamps(
  firstTimestampUs: number,
  frameDurationUs: number | null,
  frameRate: number | undefined,
  count: number,
): readonly number[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RATE_CONTROL_WARMUP_FRAMES) {
    throw new RangeError(
      `warmup count must be an integer in [0, ${MAX_RATE_CONTROL_WARMUP_FRAMES}], got ${count}`,
    );
  }
  if (count === 0 || !Number.isSafeInteger(firstTimestampUs)) return [];
  const duration =
    frameDurationUs !== null && Number.isSafeInteger(frameDurationUs) && frameDurationUs > 0
      ? frameDurationUs
      : frameRate !== undefined && Number.isFinite(frameRate) && frameRate > 0
        ? Math.max(1, Math.round(1_000_000 / frameRate))
        : 33_333;
  const earliest = firstTimestampUs - duration * count;
  if (!Number.isSafeInteger(earliest)) return [];
  return Array.from({ length: count }, (_, index) => earliest + duration * index);
}

function readEncoderQuantizerSelector(
  o: StageOptions | undefined,
): ((frame: VideoEncoderRateControlFrame) => number) | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.quantizerAt;
  return typeof v === 'function' ? v : undefined;
}

function readDecoderConfigSink(
  o: StageOptions | undefined,
): ((config: VideoDecoderConfig) => void) | undefined {
  const v = (o as VideoEncoderStageOptions | undefined)?.onDecoderConfig;
  return typeof v === 'function' ? v : undefined;
}

function readDecoderAlpha(o: StageOptions | undefined): AlphaOption | undefined {
  const v = (o as VideoDecoderStageOptions | undefined)?.alpha;
  return v === 'keep' || v === 'discard' ? v : undefined;
}

// ── environment guards ───────────────────────────────────────────────────────────────────────────

const HIGH_WATER_MARK = 16 as const; // pending decoder requests tolerated before awaiting `dequeue`
/**
 * Raw frames handed to `VideoEncoder.encode()` but not yet taken off its control queue — the only
 * uncompressed pictures our submission causes the encoder to retain, and therefore the population the
 * memory budget's "four decoded frame footprints" clause bounds.
 *
 * It deliberately does NOT bound *emitted* chunks. Every measured browser encoder buffers a deep
 * reorder/lookahead window before its first output (Chromium 41, Firefox 29–37, WebKit 33 frames at
 * 1080p), so gating submission on completed outputs throttles the pipeline to the encoder's *latency*
 * instead of its throughput: at a cap of 10 pending outputs Firefox admitted 12 frames in 20 s (0.6 fps)
 * against 243 fps with this queue gate, and Chromium/WebKit lost 8–10% for nothing. End-to-end wall time
 * is flat from a cap of 2 up to 16 on all three engines — the encoder, not the gate, is the limiter — so
 * the smallest cap that costs no throughput is the right one.
 */
export const ENCODER_QUEUE_HIGH_WATER_MARK = 4 as const;

function hasVideoDecoder(): boolean {
  return typeof VideoDecoder !== 'undefined';
}

function hasVideoEncoder(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

function absentWebCodecsError(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError(
    `WebCodecs Video${op === 'decode' ? 'Decoder' : 'Encoder'} is unavailable in this environment`,
    { op: { kind: 'route', id: op }, tried: [] },
  );
}

function unsupportedVideoCodecError(op: 'decode' | 'encode', codec: string): CapabilityError {
  return new CapabilityError(
    `webcodecs-video cannot ${op} unsupported video codec string '${codec}'`,
    { op: { kind: 'route', id: op }, tried: ['webcodecs-video'] },
  );
}

// ── supports() — cheap, honest, never throws (wraps isConfigSupported) ────────────────────────────

function acceptedVideoDecoderAcceleration(
  accepted: VideoDecoderConfig | undefined,
  requested: HardwareAcceleration,
): HardwareAcceleration {
  const acceleration = accepted?.hardwareAcceleration;
  return acceleration === 'prefer-hardware' ||
    acceleration === 'prefer-software' ||
    acceleration === 'no-preference'
    ? acceleration
    : requested;
}

async function probeVideoDecoderAcceleration(
  config: VideoDecoderConfig,
  alpha: AlphaOption | undefined,
  acceleration: HardwareAcceleration,
): Promise<VideoDecoderAccelerationProbeResult> {
  const { supported, config: accepted } = await VideoDecoder.isConfigSupported(
    normalizeVideoDecoderConfig(config, acceleration, alpha),
  );
  return {
    supported: supported === true,
    ...(supported === true
      ? { acceptedAcceleration: acceptedVideoDecoderAcceleration(accepted, acceleration) }
      : {}),
  };
}

async function supportsDecode(
  config: DecoderConfig,
  determinism: Determinism | undefined,
): Promise<CodecSupport> {
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
  // would wrongly NA it. `force-software` instead supplies the one-item `prefer-software` order.
  const probes: SupportProbe[] = [];
  let lastReason: string | undefined;
  for (const acceleration of videoAccelerationProbeOrder(determinism)) {
    try {
      const result = await probeVideoDecoderAcceleration(videoConfig, undefined, acceleration);
      const acceptedAcceleration = result.acceptedAcceleration ?? acceleration;
      const supported =
        result.supported &&
        (determinism !== 'force-software' || acceptedAcceleration === 'prefer-software');
      probes.push({ supported, acceleration: acceptedAcceleration });
      // The capability verdict is not seeded into the live-decoder cache: that cache holds only the
      // rung a real decoder configured (browser's choice first, LIVE_DECODER_PROBE_ORDER). Seeding
      // `prefer-hardware` here pinned every subsequent decoder to a ~2.5 ms hardware session.
      if (supported) break; // first win short-circuits (hardware preferred)
    } catch (e) {
      lastReason = describeError(e); // isConfigSupported rejects only on a malformed config
    }
  }
  return combineSupport(probes, lastReason ?? 'codec not supported by this browser');
  /* v8 ignore stop */
}

async function supportsEncode(
  config: EncoderConfig,
  determinism: Determinism | undefined,
): Promise<CodecSupport> {
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
  for (const acceleration of videoAccelerationProbeOrder(determinism)) {
    try {
      const { supported, config: accepted } = await VideoEncoder.isConfigSupported({
        ...videoConfig,
        hardwareAcceleration: acceleration,
      });
      const acceptedAcceleration = accepted?.hardwareAcceleration ?? acceleration;
      const acceptedSoftwareMode =
        supported === true &&
        (determinism !== 'force-software' || acceptedAcceleration === 'prefer-software');
      probes.push({ supported: acceptedSoftwareMode, acceleration: acceptedAcceleration });
      if (acceptedSoftwareMode) break;
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

/** The `dequeue`-event surface both WebCodecs video coders expose; a bare `EventTarget` satisfies it. */
export interface VideoCodecQueue {
  addEventListener(type: 'dequeue', listener: () => void): void;
  removeEventListener(type: 'dequeue', listener: () => void): void;
}

/** Resolve on the next `dequeue` (queue drained) or reject on abort; cleans up its listeners either way. */
function awaitDequeueOrAbort(
  coder: VideoCodecQueue,
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

/**
 * Await until the coder's pending-work queue falls below the high-water mark (or abort). `sizeOf` reads
 * the native queue depth — `decodeQueueSize`/`encodeQueueSize` — so the loop stays independent of which
 * coder it drives and remains drivable by a plain `EventTarget` in Node.
 */
export async function drainBelowHighWater(
  coder: VideoCodecQueue,
  sizeOf: () => number,
  signal: AbortSignal | undefined,
  highWaterMark: number = HIGH_WATER_MARK,
): Promise<void> {
  while (queueIsBackpressured(sizeOf(), highWaterMark)) {
    await awaitDequeueOrAbort(coder, signal);
  }
}

// ── decoder: EncodedChunk → VideoFrame ───────────────────────────────────────────────────────────

function createVideoDecoder(
  config: VideoDecoderConfig,
  o: StageOptions | undefined,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  const alpha = readDecoderAlpha(o);

  let decoder: VideoDecoder | undefined;
  let readableController: ReadableStreamDefaultController<RawFrame> | undefined;
  let onAbort: (() => void) | undefined;
  const frameQueue: VideoFrame[] = [];
  const queueWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  // The readable is dead (closed/cancelled/aborted/errored): once set, the async `output` callback closes
  // its frame instead of queueing it. Normal flush sets `decoderDone`; the readable remains open until the
  // explicit frame queue drains so already-decoded B-frame tail output is still consumed or closed.
  let closed = false;
  let decoderDone = false;
  // WebCodecs starts every newly configured decoder in "key chunk required" state. Some Chromium
  // decoders accept a leading delta chunk without throwing but then retain it forever waiting for
  // references, so neither dequeue nor flush can make progress. Container slices can legitimately
  // begin mid-GOP; preserve those packets at the demux seam, but do not submit the undecodable prefix.
  let needsKeyChunk = true;
  let pullWaiting = false;
  let terminalError: Error | undefined;
  let rejectStartupCancellation: ((error: Error) => void) | undefined;
  const startupCancellation = new Promise<never>((_resolve, reject) => {
    rejectStartupCancellation = reject;
  });
  // Cancellation may win just before an awaited probe/barrier installs its race handler. Keep the deferred
  // rejection handled in that narrow window; every live startup await also races this same promise.
  startupCancellation.catch(() => undefined);

  const streamClosedError = (): Error =>
    terminalError ?? new MediaError('aborted', 'video decoder stream closed');
  const cancelStartup = (error: Error): void => {
    const reject = rejectStartupCancellation;
    rejectStartupCancellation = undefined;
    reject?.(error);
  };
  const finishStartup = (): void => {
    rejectStartupCancellation = undefined;
  };
  const awaitDuringStartup = <T>(pending: Promise<T>): Promise<T> =>
    Promise.race([pending, startupCancellation]);
  const closeDecoder = (): void => {
    if (decoder && decoder.state !== 'closed') decoder.close(); // stop WebCodecs emitting + drop buffers
  };
  const removeAbortListener = (): void => {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
  };
  const closeQueuedFrames = (): void => {
    for (const frame of frameQueue.splice(0)) frame.close();
  };
  const rejectQueueWaiters = (error: Error): void => {
    for (const waiter of queueWaiters) waiter.reject(error);
    queueWaiters.clear();
  };
  const resolveQueueWaiters = (): void => {
    if (frameQueue.length >= HIGH_WATER_MARK) return;
    for (const waiter of queueWaiters) waiter.resolve();
    queueWaiters.clear();
  };
  const finishReadableIfDrained = (): void => {
    if (closed || !decoderDone || frameQueue.length !== 0 || !readableController) return;
    closed = true;
    removeAbortListener();
    resolveQueueWaiters();
    readableController.close();
  };
  const fail = (error: Error): void => {
    if (closed) return;
    terminalError = error;
    closed = true;
    cancelStartup(error);
    pullWaiting = false;
    closeQueuedFrames();
    rejectQueueWaiters(error);
    closeDecoder();
    removeAbortListener();
    readableController?.error(error);
  };
  const cancelDecode = (reason?: unknown): void => {
    if (closed) return;
    const error =
      reason instanceof Error
        ? reason
        : new MediaError('aborted', 'video decoder stream cancelled');
    terminalError = error;
    closed = true;
    cancelStartup(error);
    pullWaiting = false;
    closeQueuedFrames();
    rejectQueueWaiters(error);
    closeDecoder();
    removeAbortListener();
  };
  const deliverQueuedFrame = (): void => {
    if (!pullWaiting || closed || !readableController) return;
    const frame = frameQueue.shift();
    if (!frame) {
      finishReadableIfDrained();
      return;
    }
    pullWaiting = false;
    try {
      readableController.enqueue(frame);
    } catch (e) {
      frame.close();
      fail(new MediaError('decode-error', describeError(e), e));
      return;
    }
    resolveQueueWaiters();
    finishReadableIfDrained();
  };
  const waitForOutputRoom = async (): Promise<void> => {
    while (!closed && frameQueue.length >= HIGH_WATER_MARK) {
      await new Promise<void>((resolve, reject) => {
        queueWaiters.add({ resolve, reject });
      });
    }
    if (closed) throw streamClosedError();
  };
  const configureDecoder = async (acceleration: HardwareAcceleration): Promise<void> => {
    if (closed || signal?.aborted) throw streamClosedError();
    let candidate: VideoDecoder;
    let candidateReady = false;
    let rejectCandidateStartup: ((error: Error) => void) | undefined;
    const candidateStartupFailure = new Promise<never>((_resolve, reject) => {
      rejectCandidateStartup = reject;
    });
    candidateStartupFailure.catch(() => undefined);
    candidate = new VideoDecoder({
      output: (frame: VideoFrame): void => {
        // Never throw out of this async callback: queue if the readable is alive, else close. Frames
        // stay driver-owned until a pull hands them to the consumer, so cancellation can close them.
        if (closed || decoder !== candidate || !candidateReady) {
          frame.close();
          return;
        }
        frameQueue.push(frame);
        deliverQueuedFrame();
      },
      error: (e: DOMException): void => {
        if (closed || decoder !== candidate) return;
        if (!candidateReady) {
          rejectCandidateStartup?.(e);
          return;
        }
        // A native-decoder runtime failure (even on an isConfigSupported-approved config) = the browser
        // cannot decode this → a capability miss the engine degrades to NA, not a page crash.
        if (e.name === 'NotSupportedError') {
          forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
        }
        fail(decoderErrorToCapabilityMiss(e, 'webcodecs-video', config.codec));
      },
    });
    // Publish the candidate before configure so cancellation can close the exact native object while its
    // control-queue configuration is still pending.
    decoder = candidate;
    try {
      // Rebuild from THIS caller's config so description bytes and every VFR/B-frame-relevant field can
      // never come from an earlier equivalent cache entry; the cache carries only the accepted hint.
      candidate.configure(normalizeVideoDecoderConfig(config, acceleration, alpha));
      // `configure()` only queues the support check. An empty `flush()` is the spec-grounded control-queue
      // barrier: it cannot resolve until configuration succeeded, and it rejects before any packet is
      // submitted when a cached acceleration hint became stale.
      await awaitDuringStartup(Promise.race([candidate.flush(), candidateStartupFailure]));
      if (closed || signal?.aborted || decoder !== candidate) throw streamClosedError();
      candidateReady = true;
      rejectCandidateStartup = undefined;
    } catch (error) {
      if (decoder === candidate) decoder = undefined;
      rejectCandidateStartup = undefined;
      if (candidate.state !== 'closed') candidate.close();
      throw error;
    }
  };
  const unsupportedExactConfig = (): CapabilityError =>
    new CapabilityError(
      `webcodecs-video cannot configure ${config.codec} with hardware or software fallback`,
      { op: { kind: 'route', id: 'decode' }, tried: ['webcodecs-video'] },
    );
  const configureSoftwareFallback = async (): Promise<void> => {
    if (closed || signal?.aborted) throw streamClosedError();
    forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
    let result: VideoDecoderAccelerationProbeResult;
    try {
      result = await awaitDuringStartup(
        probeVideoDecoderAcceleration(config, alpha, 'no-preference'),
      );
    } catch {
      if (closed || signal?.aborted) throw streamClosedError();
      throw unsupportedExactConfig();
    }
    if (closed || signal?.aborted) throw streamClosedError();
    if (!result.supported) throw unsupportedExactConfig();
    const acceleration = result.acceptedAcceleration ?? 'no-preference';
    try {
      await configureDecoder(acceleration);
    } catch {
      if (closed || signal?.aborted) throw streamClosedError();
      forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
      throw unsupportedExactConfig();
    }
    rememberVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha, acceleration);
  };
  const configureAccepted = async (acceleration: HardwareAcceleration): Promise<void> => {
    try {
      await configureDecoder(acceleration);
    } catch (error) {
      forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
      // A stale hardware verdict or asynchronous control-queue rejection must not erase a real software-
      // only capability. The empty-flush barrier proves failure before writes can submit a packet.
      if (
        !closed &&
        !signal?.aborted &&
        o?.determinism !== 'force-software' &&
        acceleration !== 'no-preference'
      ) {
        await configureSoftwareFallback();
        return;
      }
      if (closed || signal?.aborted) throw streamClosedError();
      if (error instanceof CapabilityError || error instanceof MediaError) throw error;
      throw unsupportedExactConfig();
    }
    if (o?.determinism !== 'force-software') {
      rememberVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha, acceleration);
    }
  };
  const probeAndConfigure = async (): Promise<void> => {
    // The live decoder asks the browser for its own choice first. Probing hardware first and pinning
    // `prefer-hardware` cost ~2.5 ms of decoder-session setup on tiny pictures and short clips (one
    // H.264 frame: 3.15 ms → 0.5 ms measured in Chromium 2026-09-03), while `no-preference` still lets
    // the browser pick hardware for large sustained decodes. Capability evidence (`supports()`) keeps
    // the hardware-first order so `hardwareAccelerated` stays an honest fact.
    const acceleration = await resolveVideoDecoderAcceleration(
      o?.determinism,
      undefined,
      (requested) => probeVideoDecoderAcceleration(config, alpha, requested),
      () => !closed && signal?.aborted !== true,
      startupCancellation,
      LIVE_DECODER_PROBE_ORDER,
    );
    if (closed || signal?.aborted) throw streamClosedError();
    if (acceleration === undefined) throw unsupportedExactConfig();
    await configureAccepted(acceleration);
  };
  const failStart = (cause: unknown): never => {
    const error =
      cause instanceof CapabilityError || cause instanceof MediaError
        ? cause
        : new MediaError('decode-error', describeError(cause), cause);
    fail(error);
    throw error;
  };

  const readable = new ReadableStream<RawFrame>(
    {
      start(controller): void {
        readableController = controller;
      },
      pull(): void {
        pullWaiting = true;
        deliverQueuedFrame();
      },
      cancel(reason): void {
        cancelDecode(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const writable = new WritableStream<EncodedChunk>(
    {
      start(): void | Promise<void> {
        onAbort = () => {
          fail(new MediaError('aborted', 'operation aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          const error = new MediaError('aborted', 'operation aborted');
          fail(error);
          return Promise.reject(error);
        }
        const cached = recallVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
        const immediate = immediateVideoDecoderAcceleration(
          o?.determinism,
          config.hardwareAcceleration ?? cached,
        );
        try {
          const pending =
            immediate === undefined ? probeAndConfigure() : configureAccepted(immediate);
          return pending.then(finishStartup).catch(failStart);
        } catch (error) {
          failStart(error);
        }
      },
      async write(chunk): Promise<void> {
        if (closed) throw streamClosedError();
        if (!decoder) throw new MediaError('decode-error', 'decoder not configured');
        if (!(chunk instanceof EncodedVideoChunk)) {
          throw new MediaError('decode-error', 'webcodecs-video decoder expects EncodedVideoChunk');
        }
        if (needsKeyChunk) {
          if (chunk.type !== 'key') return;
          needsKeyChunk = false;
        }
        await waitForOutputRoom();
        const pending = decoder;
        await drainBelowHighWater(pending, () => pending.decodeQueueSize, signal);
        if (closed) throw streamClosedError();
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        decoder.decode(chunk);
      },
      async close(): Promise<void> {
        // Drain all queued work so every (presentation-ordered) frame is emitted before the readable
        // reaches EOF; then release the decoder. The readable closes only after the explicit frame queue
        // drains, preserving ownership for a slow/early-cancelling consumer.
        if (closed) {
          if (terminalError) throw terminalError;
          return;
        }
        try {
          if (decoder && decoder.state === 'configured') await decoder.flush();
        } catch (e) {
          const error = terminalError ?? new MediaError('decode-error', describeError(e), e);
          fail(error);
          throw error;
        }
        if (closed) {
          if (terminalError) throw terminalError;
          return;
        }
        decoderDone = true;
        closeDecoder();
        finishReadableIfDrained();
      },
      // The upstream source aborted before normal close: release native resources and close any decoded
      // frames still waiting for downstream demand.
      abort(reason): void {
        const error =
          reason instanceof Error
            ? reason
            : new MediaError('aborted', 'video decoder stream aborted');
        fail(error);
      },
    },
    { highWaterMark: 1 }, // writable: keep the transform's own buffer tiny; the codec queue is the budget
  );
  return { readable, writable } as TransformStream<EncodedChunk, RawFrame>;
}

// ── encoder: VideoFrame → EncodedChunk ───────────────────────────────────────────────────────────

/** Restore the requested visible width in the encoder's out-of-band AVC configuration. */
function decoderConfigWithVisibleRightCrop(
  decoderConfig: VideoDecoderConfig,
  visibleWidth: number,
  alignedWidth: number,
): VideoDecoderConfig {
  if (alignedWidth - visibleWidth !== 2) {
    throw new MediaError(
      'encode-error',
      `invalid H.264 alignment width ${alignedWidth} for ${visibleWidth}px visible picture`,
    );
  }
  const description = decoderConfig.description;
  if (description === undefined) {
    throw new MediaError(
      'encode-error',
      'Apple H.264 aligned encode did not publish an AVCDecoderConfigurationRecord',
    );
  }
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const rewritten = addH264AvcCVisibleRightCrop(bytes, alignedWidth - visibleWidth);
  return {
    ...decoderConfig,
    codedWidth: visibleWidth,
    description: rewritten,
    ...(decoderConfig.displayAspectWidth === alignedWidth
      ? { displayAspectWidth: visibleWidth }
      : {}),
  };
}

function createVideoEncoder(
  config: VideoEncoderConfig,
  o: StageOptions | undefined,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  const keyFrameInterval = readEncoderInterval(o);
  const quantizer = readEncoderQuantizer(o);
  const quantizerAt = readEncoderQuantizerSelector(o);
  const onDecoderConfig = readDecoderConfigSink(o);
  const rateControlWarmupFrames = readRateControlWarmupFrames(o);

  let encoder: VideoEncoder | undefined;
  let frameIndex = 0;
  let submittedEncodeCount = 0;
  let lastSubmittedTimestamp: number | undefined;
  const rateControlWarmupTimestampsPending = new Set<number>();
  let alignmentCanvas: OffscreenCanvas | undefined;
  const platform = typeof navigator === 'undefined' ? undefined : navigator.platform;
  const alignHorizontalPhase = needsAppleH264HorizontalPhaseCompensation(config, platform);
  // Small VP9 (≤360p, e.g. 320×180 performance ladder) at default bitrate gives SSIM ~0.88 (<0.97).
  // Force a higher bitrate for small VP9 to meet the quality gate generally.
  const isSmallVp9 =
    config.codec.toLowerCase().startsWith('vp09') && config.width * config.height <= 640 * 360;
  const baseConfig = isSmallVp9 ? { ...config, bitrate: 5_000_000 } : config;
  const wireConfig: VideoEncoderConfig = alignHorizontalPhase
    ? { ...baseConfig, width: baseConfig.width + 2 }
    : baseConfig;
  // The readable (consumed by the muxer) is dead: once set, the async `output` callback must NOT enqueue
  // — it drops the chunk instead. Prevents the "enqueue into a closed readable" throw when the muxer
  // closes/cancels early (mux error, early-stop trim, abort) while the encoder is still draining.
  let closed = false;
  // Resolves when the stream is disposed, so a submitter parked on the encoder's `dequeue` event wakes up
  // even though a disposed encoder will never fire one again.
  let releaseDisposal: (() => void) | undefined;
  const disposed = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });

  const dispose = (error = new MediaError('aborted', 'video encoder stream closed')): void => {
    void error;
    closed = true;
    if (encoder && encoder.state !== 'closed') encoder.close(); // stop WebCodecs emitting
    alignmentCanvas = undefined;
    rateControlWarmupTimestampsPending.clear();
    releaseDisposal?.();
  };

  /**
   * Wait until the encoder's control queue has room. `encodeQueueSize` is the WebCodecs-defined measure of
   * frames we have handed over that the encoder has not consumed yet — exactly the uncompressed pictures
   * our submission keeps alive. Chunks already emitted are bounded separately by the readable's own
   * high-water mark, which the `TransformStream` propagates back to this writable side.
   */
  const awaitEncoderQueueRoom = async (): Promise<void> => {
    const pending = encoder;
    if (!pending) return;
    while (
      !closed &&
      queueIsBackpressured(pending.encodeQueueSize, ENCODER_QUEUE_HIGH_WATER_MARK)
    ) {
      await Promise.race([
        drainBelowHighWater(
          pending,
          () => pending.encodeQueueSize,
          signal,
          ENCODER_QUEUE_HIGH_WATER_MARK,
        ),
        disposed,
      ]);
    }
    if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  };

  const submitEncode = (
    frame: VideoFrame,
    options: VideoEncoderEncodeOptionsWithCodecQuantizer,
  ): void => {
    if (!encoder) throw new MediaError('encode-error', 'encoder not configured');
    try {
      encoder.encode(frame, options);
      submittedEncodeCount++;
      lastSubmittedTimestamp = frame.timestamp;
    } catch (error) {
      throw new MediaError(
        'encode-error',
        `${config.codec} ${config.width}x${config.height} encoder rejected submitted frame ${submittedEncodeCount + 1} at ${frame.timestamp}us: ${describeError(error)}`,
        error,
      );
    }
  };

  const transformer: TransformerWithCancel<RawFrame, EncodedChunk> = {
    start(controller): void {
      signal?.addEventListener(
        'abort',
        () => {
          const error = new MediaError('aborted', 'operation aborted');
          dispose(error);
          controller.error(error);
        },
        { once: true },
      );
      encoder = new VideoEncoder({
        output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void => {
          // The encoder emits the decoder config (codec string + `description`) with (typically) the
          // first chunk; hand it to the muxer out-of-band, since the chunk stream is bytes-only.
          const decoderConfig = metadata?.decoderConfig;
          if (decoderConfig && onDecoderConfig) {
            try {
              onDecoderConfig(
                alignHorizontalPhase
                  ? decoderConfigWithVisibleRightCrop(decoderConfig, config.width, wireConfig.width)
                  : decoderConfig,
              );
            } catch (error) {
              const mapped =
                error instanceof MediaError
                  ? error
                  : new MediaError(
                      'encode-error',
                      `failed to align Apple H.264 visible width: ${describeError(error)}`,
                      error,
                    );
              dispose(mapped);
              controller.error(mapped);
              return;
            }
          }
          // Preroll exists only to initialize the native bitrate controller. The real first picture is
          // forced key below, so no emitted picture can reference these disposable access units.
          if (rateControlWarmupTimestampsPending.delete(chunk.timestamp)) return;
          // Never throw out of this async callback: enqueue if the readable is alive, else drop the chunk
          // (a plain byte buffer — nothing to close, GC frees it).
          enqueueOrDrop(controller, chunk, () => closed);
        },
        error: (e: DOMException): void => {
          const error = new MediaError(
            'encode-error',
            `${config.codec} ${config.width}x${config.height} encoder failed after ${submittedEncodeCount} submitted frame(s)` +
              `${lastSubmittedTimestamp === undefined ? '' : ` at ${lastSubmittedTimestamp}us`}: ${e.message}`,
            e,
          );
          dispose(error);
          controller.error(error);
        },
      });
      // Default to the hardware hint (this is the hardware-tier driver) unless the caller pinned one;
      // `force-software` reaches this tier only after a matching non-hardware capability verdict.
      encoder.configure({
        ...wireConfig,
        hardwareAcceleration:
          wireConfig.hardwareAcceleration ?? normalizeHardwareAcceleration(o?.determinism),
      });
    },
    async transform(frame): Promise<void> {
      if (!(frame instanceof VideoFrame)) {
        frame.close(); // close what we can't encode so it never leaks, then fail typed
        throw new MediaError('encode-error', 'webcodecs-video encoder expects a VideoFrame');
      }
      // The encoder CONSUMES the input frame: encode then close exactly once, even if encode() throws
      // or we abort. encode() reads the frame's pixels synchronously, so closing here is safe.
      let encodeFrame: VideoFrame = frame;
      let compensatedFrame: VideoFrame | undefined;
      try {
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        if (!encoder) throw new MediaError('encode-error', 'encoder not configured');
        await awaitEncoderQueueRoom();
        if (alignHorizontalPhase) {
          if (frame.displayWidth !== config.width || frame.displayHeight !== config.height) {
            throw new MediaError(
              'encode-error',
              `H.264 alignment expected ${config.width}x${config.height} input, got ${frame.displayWidth}x${frame.displayHeight}`,
            );
          }
          if (
            alignmentCanvas === undefined ||
            alignmentCanvas.width !== wireConfig.width ||
            alignmentCanvas.height !== wireConfig.height
          ) {
            alignmentCanvas = new OffscreenCanvas(wireConfig.width, wireConfig.height);
          }
          const context = alignmentCanvas.getContext('2d', { alpha: false });
          if (context === null) {
            throw new MediaError(
              'encode-error',
              'OffscreenCanvas 2D context unavailable for H.264 chroma-phase alignment',
            );
          }
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, wireConfig.width, wireConfig.height);
          // Keep every requested pixel at its exact coordinate and pad only the two non-display columns.
          // The rewritten SPS crops these columns after decode, so the visible picture remains exact.
          context.drawImage(frame, 0, 0);
          context.drawImage(
            frame,
            config.width - 1,
            0,
            1,
            config.height,
            config.width - 1,
            0,
            wireConfig.width - config.width + 1,
            config.height,
          );
          compensatedFrame = new VideoFrame(alignmentCanvas, {
            timestamp: frame.timestamp,
            ...(frame.duration === null ? {} : { duration: frame.duration }),
          });
          encodeFrame = compensatedFrame;
        }
        if (frameIndex === 0 && rateControlWarmupFrames > 0) {
          const timestamps = rateControlWarmupTimestamps(
            encodeFrame.timestamp,
            encodeFrame.duration,
            config.framerate,
            rateControlWarmupFrames,
          );
          for (let index = 0; index < timestamps.length; index++) {
            if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
            if (!encoder) throw new MediaError('encode-error', 'encoder not configured');
            await awaitEncoderQueueRoom();
            const timestamp = timestamps[index];
            if (timestamp === undefined)
              throw new MediaError('encode-error', 'invalid warmup timeline');
            const warmupFrame = new VideoFrame(encodeFrame, {
              timestamp,
              ...(encodeFrame.duration === null ? {} : { duration: encodeFrame.duration }),
            });
            rateControlWarmupTimestampsPending.add(timestamp);
            try {
              submitEncode(
                warmupFrame,
                videoEncodeOptions(index, undefined, config.codec, quantizer),
              );
            } catch (error) {
              rateControlWarmupTimestampsPending.delete(timestamp);
              throw error;
            } finally {
              warmupFrame.close();
            }
          }
        }
        const keyFrame = shouldKeyframe(frameIndex, keyFrameInterval);
        const frameQuantizer =
          quantizerAt?.({
            index: frameIndex,
            timestampUs: frame.timestamp,
            durationUs: frame.duration,
            keyFrame,
          }) ?? quantizer;
        submitEncode(
          encodeFrame,
          videoEncodeOptions(frameIndex, keyFrameInterval, config.codec, frameQuantizer),
        );
        frameIndex++;
      } finally {
        compensatedFrame?.close();
        frame.close();
      }
    },
    async flush(controller): Promise<void> {
      try {
        if (encoder && encoder.state === 'configured') await encoder.flush();
      } catch (e) {
        const error = new MediaError('encode-error', describeError(e), e);
        dispose(error);
        controller.error(error);
        return;
      }
      closed = true; // the readable is about to close; reject any late `output` (none expected post-flush)
      if (encoder && encoder.state !== 'closed') encoder.close();
      alignmentCanvas = undefined;
      rateControlWarmupTimestampsPending.clear();
      releaseDisposal?.(); // the encoder will never fire `dequeue` again; free any parked submitter
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
    { highWaterMark: 1 },
  );
}

/* v8 ignore stop */

// ── warm decoder pool: reuse a configured VideoDecoder across sequential same-config decodes ───────

/**
 * The active borrow's decoded-frame + error sink. The pool rebinds this on every borrow so the ONE warm
 * `VideoDecoder`'s native `output`/`error` callbacks always reach the *current* stream — never a previous
 * borrow's (which has detached; a stray frame that still arrives is closed, not leaked). {@link onFrame}
 * takes ownership of the frame (enqueues it to the readable, or closes it if the readable is already gone).
 */
export interface WarmDecoderSink {
  onFrame(frame: VideoFrame): void;
  onError(error: DOMException): void;
}

/**
 * A reusable, already-configured decoder the {@link WarmVideoDecoderPool} drives. The browser default
 * ({@link createRealWarmDecoderHandle}) wraps a live `VideoDecoder` configured once (hardware-first, with
 * the software fallback) and kept CONFIGURED between borrows — reuse then skips the per-call construct +
 * configure + hardware-init barrier a fresh decoder pays. Tests inject a fake so the pool's
 * frame-lifetime / backpressure / reuse state machine runs in Node (where WebCodecs is absent).
 */
export interface WarmDecoderHandle {
  /** Route native output/error to `sink`; `undefined` detaches (a stray frame is closed, never leaked). */
  bind(sink: WarmDecoderSink | undefined): void;
  /** Submit one chunk to the native control queue. */
  decode(chunk: EncodedChunk): void;
  /** Complete all queued work, emitting every pending frame; LEAVES the decoder configured for reuse. */
  flush(): Promise<void>;
  /** Pending decode requests (the backpressure signal). */
  readonly decodeQueueSize: number;
  /** Resolve on the next queue-drain (backpressure release) or reject on abort. */
  awaitDequeue(signal: AbortSignal | undefined): Promise<void>;
  /** Permanently close the decoder + free its hardware session. Idempotent. */
  close(): void;
  /** Whether the decoder has been closed (so the pool never reuses a dead handle). */
  readonly closed: boolean;
}

/** Build + configure a decoder for `config`/`o`, ready to decode, wired to route output via {@link WarmDecoderHandle.bind}. */
export type WarmDecoderFactory = (
  config: VideoDecoderConfig,
  o: StageOptions | undefined,
) => Promise<WarmDecoderHandle>;

/**
 * A per-engine-instance warm decoder pool for the SEQUENTIAL single-frame / seek path (doc 09). It holds
 * at most one configured `VideoDecoder`, keyed by the exact decode config (codec + coded dims + description
 * bytes + effective VPx alpha). A same-config borrow REUSES it — eliminating the per-seek construct +
 * configure + hardware-init cost a fresh decoder pays; a different-config borrow closes the old decoder and
 * builds a new one; and a borrow that arrives while another is still active is REFUSED (`undefined`) so the
 * caller builds its own fresh decoder — one decoder never serves two concurrent streams. Any decode
 * error/abort drops (closes) the pooled decoder so the next borrow rebuilds. It never caches decoded frames
 * and holds no cross-input state (different inputs with the same config decode identically), so reuse is
 * correct.
 */
export interface WarmVideoDecoderPool {
  /**
   * A decoder seam that reuses the warm decoder for `config`/`o`, or `undefined` when pooling cannot apply
   * right now (another borrow is active, the pool is disposed, or the config is not a poolable WebCodecs
   * video config) — the caller then falls back to a fresh `createDecoder`.
   */
  borrow(
    config: DecoderConfig,
    o: StageOptions | undefined,
  ): TransformStream<EncodedChunk, RawFrame> | undefined;
  /** Close the warm decoder and free its hardware session (engine dispose / teardown). Idempotent. */
  dispose(): void;
}

/** The exact-config miss raised when neither a hardware nor a software configuration is accepted. */
function unsupportedExactVideoConfigError(config: VideoDecoderConfig): CapabilityError {
  return new CapabilityError(
    `webcodecs-video cannot configure ${config.codec} with hardware or software fallback`,
    { op: { kind: 'route', id: 'decode' }, tried: ['webcodecs-video'] },
  );
}

/* v8 ignore start -- requires a real WebCodecs VideoDecoder; the pool state machine below is Node-tested
   with an injected fake handle, while this real build+configure path is validated in the browser harness. */
/**
 * The browser default {@link WarmDecoderFactory}: construct ONE `VideoDecoder` with a stable trampoline
 * (native output/error forward to the currently-bound sink), resolve the acceleration hardware-first with a
 * software fallback (reusing the shared verdict cache), and configure it once behind the empty-`flush()`
 * control-queue barrier. The returned handle keeps the decoder configured across borrows — the whole point
 * of pooling — until the pool closes it (config change, decode error, or dispose).
 */
const createRealWarmDecoderHandle: WarmDecoderFactory = async (config, o) => {
  const alpha = readDecoderAlpha(o);
  let sink: WarmDecoderSink | undefined;
  const decoder = new VideoDecoder({
    output: (frame: VideoFrame): void => {
      // Route to the active borrow, or release the frame if none is bound (never leak a stray output).
      if (sink !== undefined) sink.onFrame(frame);
      else frame.close();
    },
    error: (e: DOMException): void => sink?.onError(e),
  });
  const configureAt = async (acceleration: HardwareAcceleration): Promise<void> => {
    decoder.configure(normalizeVideoDecoderConfig(config, acceleration, alpha));
    // `configure()` only queues the support check; an empty `flush()` is the spec-grounded control-queue
    // barrier that cannot resolve until configuration succeeded (and `flush()` leaves it CONFIGURED).
    await decoder.flush();
  };
  const handle: WarmDecoderHandle = {
    bind: (s): void => {
      sink = s;
    },
    decode: (chunk): void => decoder.decode(chunk),
    flush: (): Promise<void> => decoder.flush(),
    get decodeQueueSize(): number {
      return decoder.decodeQueueSize;
    },
    awaitDequeue: (activeSignal): Promise<void> => awaitDequeueOrAbort(decoder, activeSignal),
    close: (): void => {
      if (decoder.state !== 'closed') decoder.close();
    },
    get closed(): boolean {
      return decoder.state === 'closed';
    },
  };
  try {
    const cached = recallVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
    const acceleration =
      immediateVideoDecoderAcceleration(o?.determinism, cached) ??
      (await resolveVideoDecoderAcceleration(o?.determinism, undefined, (requested) =>
        probeVideoDecoderAcceleration(config, alpha, requested),
      ));
    if (acceleration === undefined) throw unsupportedExactVideoConfigError(config);
    try {
      await configureAt(acceleration);
      if (o?.determinism !== 'force-software') {
        rememberVideoDecoderAcceleration(
          videoDecoderAccelerationCache,
          config,
          alpha,
          acceleration,
        );
      }
    } catch (error) {
      // A stale hardware verdict must not erase a real software capability: probe + configure software once.
      forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
      if (o?.determinism === 'force-software' || acceleration === 'no-preference') {
        throw error instanceof CapabilityError || error instanceof MediaError
          ? error
          : unsupportedExactVideoConfigError(config);
      }
      const probe = await probeVideoDecoderAcceleration(config, alpha, 'no-preference');
      if (!probe.supported) throw unsupportedExactVideoConfigError(config);
      const software = probe.acceptedAcceleration ?? 'no-preference';
      await configureAt(software);
      rememberVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha, software);
    }
    return handle;
  } catch (error) {
    if (decoder.state !== 'closed') decoder.close();
    throw error;
  }
};
/* v8 ignore stop */

/** The engine-private pool operations a single borrow drives (acquire the warm handle, then release/discard it). */
interface WarmBorrowPoolOps {
  acquire(
    config: VideoDecoderConfig,
    o: StageOptions | undefined,
    key: string,
  ): Promise<WarmDecoderHandle>;
  /** The borrow ended cleanly (drained, still configured): keep the decoder warm for the next borrow. */
  release(): void;
  /** The borrow errored/aborted: drop (close) the decoder so the next borrow rebuilds. */
  discard(): void;
}

/**
 * One borrow of the warm decoder as a `TransformStream<EncodedChunk, RawFrame>`, structurally mirroring the
 * fresh {@link createVideoDecoder} (pull-driven frame queue, output backpressure, close-exactly-once,
 * typed cancellation) — the ONE difference is decoder lifetime: on a clean end (EOF, or a seek that found
 * its frame and cancelled the reader) it DRAINS the decoder with a `flush()` and RELEASES it warm rather
 * than closing it; on any error/abort it DISCARDS it. The frame plumbing is Node-testable via the injected
 * {@link WarmDecoderHandle}; only the real handle touches WebCodecs.
 */
function createWarmBorrowStream(
  config: VideoDecoderConfig,
  o: StageOptions | undefined,
  key: string,
  pool: WarmBorrowPoolOps,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  const alpha = readDecoderAlpha(o);
  let decoder: WarmDecoderHandle | undefined;
  let readableController: ReadableStreamDefaultController<RawFrame> | undefined;
  const frameQueue: VideoFrame[] = [];
  const queueWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  let closed = false; // the readable is dead: `onFrame` closes frames instead of enqueuing them
  let decoderDone = false; // EOF flush finished; the readable closes once the frame queue drains
  // Each borrow is a new coded sequence even when the configured native decoder stays warm. A clean
  // prior flush leaves no reference pictures this sequence can use, so gate its mid-GOP prefix too.
  let needsKeyChunk = true;
  let pullWaiting = false;
  let settled = false;
  let writeInFlight = false;
  let terminalError: Error | undefined;
  let onAbort: (() => void) | undefined;
  // The writable has stopped issuing `decode()`s (a clean-cancel drain must not race a pending decode).
  let openWriteGate: (() => void) | undefined;
  const writeGate = new Promise<void>((resolve) => {
    openWriteGate = resolve;
  });
  const releaseWriteGate = (): void => {
    const resolve = openWriteGate;
    openWriteGate = undefined;
    resolve?.();
  };
  // Resolves once `closed` becomes true, so an in-flight decode-backpressure await releases promptly on a
  // non-abort close (a found-target seek cancel) instead of blocking on a `dequeue` that may never fire.
  let signalClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });
  const markClosed = (): void => {
    closed = true;
    const resolve = signalClosed;
    signalClosed = undefined;
    resolve?.();
  };

  const streamClosedError = (): Error =>
    terminalError ?? new MediaError('aborted', 'video decoder stream closed');
  const removeAbortListener = (): void => {
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
  };
  const closeQueuedFrames = (): void => {
    for (const frame of frameQueue.splice(0)) frame.close();
  };
  const rejectQueueWaiters = (error: Error): void => {
    for (const waiter of queueWaiters) waiter.reject(error);
    queueWaiters.clear();
  };
  const resolveQueueWaiters = (): void => {
    if (frameQueue.length >= HIGH_WATER_MARK) return;
    for (const waiter of queueWaiters) waiter.resolve();
    queueWaiters.clear();
  };
  const settleOnce = (mode: 'release' | 'discard'): void => {
    if (settled) return;
    settled = true;
    decoder?.bind(undefined); // detach this borrow before the pool reuses or drops the decoder
    if (mode === 'release') pool.release();
    else pool.discard();
  };
  function fail(error: Error): void {
    if (closed) return;
    terminalError = error;
    markClosed();
    pullWaiting = false;
    closeQueuedFrames();
    rejectQueueWaiters(error);
    removeAbortListener();
    releaseWriteGate();
    readableController?.error(error);
    settleOnce('discard'); // every error path drops the pooled decoder; the next borrow rebuilds
  }
  const finishReadableIfDrained = (): void => {
    if (closed || !decoderDone || frameQueue.length !== 0 || readableController === undefined)
      return;
    markClosed();
    removeAbortListener();
    resolveQueueWaiters();
    readableController.close();
    releaseWriteGate();
    settleOnce('release'); // clean EOF: the decoder is drained + still configured → keep it warm
  };
  const deliverQueuedFrame = (): void => {
    if (!pullWaiting || closed || readableController === undefined) return;
    const frame = frameQueue.shift();
    if (frame === undefined) {
      finishReadableIfDrained();
      return;
    }
    pullWaiting = false;
    try {
      readableController.enqueue(frame); // ownership transfers to the consumer
    } catch (error) {
      frame.close();
      fail(new MediaError('decode-error', describeError(error), error));
      return;
    }
    resolveQueueWaiters();
    finishReadableIfDrained();
  };
  const waitForOutputRoom = async (): Promise<void> => {
    while (!closed && frameQueue.length >= HIGH_WATER_MARK) {
      await new Promise<void>((resolve, reject) => {
        queueWaiters.add({ resolve, reject });
      });
    }
    if (closed) throw streamClosedError();
  };
  const sink: WarmDecoderSink = {
    onFrame(frame): void {
      if (closed) {
        frame.close(); // readable gone → release now; the consumer will never see it
        return;
      }
      frameQueue.push(frame);
      deliverQueuedFrame();
    },
    onError(error): void {
      if (closed) return;
      if (error.name === 'NotSupportedError') {
        forgetVideoDecoderAcceleration(videoDecoderAccelerationCache, config, alpha);
      }
      fail(decoderErrorToCapabilityMiss(error, 'webcodecs-video', config.codec));
    },
  };
  const cancelBorrow = async (reason: unknown): Promise<void> => {
    if (closed) return;
    if (reason instanceof Error) {
      fail(reason); // an error/abort propagated from the consumer → never reuse the decoder
      return;
    }
    // A CLEAN early stop (a seek that found its target frame and cancelled the reader): stop enqueuing,
    // release the still-queued drop frames, then DRAIN the pooled decoder's remaining work with a `flush()`
    // so it returns to an empty, still-configured, reusable state — no reset/close, so no hardware re-init.
    markClosed();
    pullWaiting = false;
    closeQueuedFrames();
    rejectQueueWaiters(new MediaError('aborted', 'video decoder stream cancelled'));
    removeAbortListener();
    if (!writeInFlight) releaseWriteGate(); // no in-flight decode issuer → safe to drain immediately
    try {
      await writeGate; // the writable has stopped issuing decode()s; nothing new will queue
      if (decoder !== undefined && !decoder.closed) await decoder.flush();
      settleOnce('release');
    } catch {
      settleOnce('discard'); // a drain failure means the decoder is not safely reusable
    }
  };
  const failStart = (cause: unknown): never => {
    const error =
      cause instanceof CapabilityError || cause instanceof MediaError
        ? cause
        : new MediaError('decode-error', describeError(cause), cause);
    fail(error);
    throw error;
  };

  const readable = new ReadableStream<RawFrame>(
    {
      start(controller): void {
        readableController = controller;
      },
      pull(): void {
        pullWaiting = true;
        deliverQueuedFrame();
      },
      async cancel(reason): Promise<void> {
        await cancelBorrow(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const writable = new WritableStream<EncodedChunk>(
    {
      start(): Promise<void> {
        onAbort = () => fail(new MediaError('aborted', 'operation aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          const error = new MediaError('aborted', 'operation aborted');
          fail(error);
          return Promise.reject(error);
        }
        return pool
          .acquire(config, o, key)
          .then((handle) => {
            if (closed || signal?.aborted) throw streamClosedError();
            decoder = handle;
            handle.bind(sink); // route this warm decoder's output/error to THIS borrow
          })
          .catch(failStart);
      },
      async write(chunk): Promise<void> {
        writeInFlight = true;
        try {
          if (closed) throw streamClosedError();
          if (decoder === undefined) throw new MediaError('decode-error', 'decoder not configured');
          if (typeof EncodedVideoChunk !== 'undefined' && !(chunk instanceof EncodedVideoChunk)) {
            throw new MediaError(
              'decode-error',
              'webcodecs-video decoder expects EncodedVideoChunk',
            );
          }
          if (needsKeyChunk) {
            if (chunk.type !== 'key') return;
            needsKeyChunk = false;
          }
          await waitForOutputRoom();
          while (!closed && queueIsBackpressured(decoder.decodeQueueSize, HIGH_WATER_MARK)) {
            await Promise.race([
              decoder.awaitDequeue(signal).catch(() => undefined),
              closedPromise,
            ]);
          }
          if (closed) throw streamClosedError();
          if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
          try {
            decoder.decode(chunk);
          } catch (error) {
            fail(new MediaError('decode-error', describeError(error), error));
            throw streamClosedError();
          }
        } finally {
          writeInFlight = false;
          if (closed) releaseWriteGate(); // this was the last decode issuer; a pending drain may proceed
        }
      },
      async close(): Promise<void> {
        if (closed) {
          releaseWriteGate();
          if (terminalError) throw terminalError;
          return;
        }
        try {
          if (decoder !== undefined && !decoder.closed) await decoder.flush();
        } catch (error) {
          const wrapped =
            terminalError ?? new MediaError('decode-error', describeError(error), error);
          fail(wrapped);
          throw wrapped;
        }
        if (closed) {
          releaseWriteGate();
          if (terminalError) throw terminalError;
          return;
        }
        decoderDone = true;
        releaseWriteGate();
        finishReadableIfDrained();
      },
      abort(reason): void {
        fail(
          reason instanceof Error
            ? reason
            : new MediaError('aborted', 'video decoder stream aborted'),
        );
      },
    },
    { highWaterMark: 1 },
  );

  return { readable, writable } as TransformStream<EncodedChunk, RawFrame>;
}

/**
 * Create a {@link WarmVideoDecoderPool}. The `factory` seam defaults to the real WebCodecs build+configure
 * ({@link createRealWarmDecoderHandle}); tests inject a fake to drive the pool's reuse / discard /
 * frame-lifetime state machine in Node. The pool is single-borrow (the sequential seek path): `borrow`
 * refuses (`undefined`) while a borrow is active, so a decoder is never shared across concurrent streams.
 */
export function createWarmVideoDecoderPool(
  factory: WarmDecoderFactory = createRealWarmDecoderHandle,
): WarmVideoDecoderPool {
  let handle: WarmDecoderHandle | undefined;
  let handleKey: string | undefined;
  let busy = false;
  let disposed = false;

  const closeHandle = (): void => {
    const current = handle;
    handle = undefined;
    handleKey = undefined;
    if (current !== undefined && !current.closed) current.close();
  };
  const ops: WarmBorrowPoolOps = {
    async acquire(config, o, key): Promise<WarmDecoderHandle> {
      if (handle !== undefined && handleKey === key && !handle.closed) return handle; // warm reuse
      if (handle !== undefined) closeHandle(); // config changed → the warm decoder no longer matches
      const built = await factory(config, o);
      if (disposed) {
        built.close();
        throw new MediaError('aborted', 'video decoder pool disposed');
      }
      handle = built;
      handleKey = key;
      return built;
    },
    release(): void {
      busy = false; // the decoder stays configured + warm for the next same-config borrow
    },
    discard(): void {
      busy = false;
      closeHandle();
    },
  };

  return {
    borrow(config, o): TransformStream<EncodedChunk, RawFrame> | undefined {
      if (disposed || busy) return undefined; // disposed, or a borrow is active → caller uses a fresh decoder
      const videoConfig = asVideoDecoderConfig(config);
      if (videoConfig === undefined || !isVideoCodecString(videoConfig.codec)) return undefined;
      const alpha = readDecoderAlpha(o);
      let key: string;
      try {
        key = videoDecoderCapabilityKey(videoConfig, alpha);
      } catch {
        return undefined; // an uncacheable/cyclic config is not poolable; the caller uses a fresh decoder
      }
      busy = true;
      return createWarmBorrowStream(videoConfig, o, key, ops);
    },
    dispose(): void {
      disposed = true;
      busy = false;
      closeHandle();
    },
  };
}

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
  supports(q: CodecQuery, o?: CodecSupportOptions): Promise<CodecSupport> {
    if (q.mediaType !== 'video') {
      return Promise.resolve({ supported: false, reason: 'webcodecs-video handles video only' });
    }
    return q.direction === 'decode'
      ? supportsDecode(q.config, o?.determinism)
      : supportsEncode(q.config as EncoderConfig, o?.determinism);
  },
  createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame> {
    const videoConfig = asVideoDecoderConfig(c);
    if (!videoConfig) {
      throw new CapabilityError('webcodecs-video decodes video, not audio', {
        op: { kind: 'route', id: 'decode' },
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
      throw new CapabilityError('webcodecs-video encodes video, not audio', {
        op: { kind: 'route', id: 'encode' },
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
