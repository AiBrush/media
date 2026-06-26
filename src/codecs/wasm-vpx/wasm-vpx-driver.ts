/**
 * The **WASM VP8/VP9** codec driver — the Phase-2 "miss-only" fallback for VPX **decode** when the
 * browser's WebCodecs has no VP9 (or VP8) `VideoDecoder` (docs/architecture/04 wasm tier, 05 §CodecDriver,
 * ADR-026). `tier:'wasm'`, so the router ranks it **last** (hardware/gpu first) and only builds it on a
 * real WebCodecs VPX miss — most desktop Chromium decodes VP9 in hardware; this covers the browsers that
 * do not (e.g. some Safari/WebKit builds).
 *
 * **Shape mirrors {@link import('../webcodecs-video.ts')} and the {@link import('../wasm-opus/wasm-opus-driver.ts')}
 * sibling:** the decoder is a `TransformStream` — the stream *is* the lifecycle (load the core + arm abort
 * on `start`, decode each chunk on `transform`, release on `flush`/`cancel`). The seam types are
 * WebCodecs-native (`EncodedVideoChunk` → `VideoFrame`) so the codec substrate (here libvpx-in-wasm) can
 * change without touching its container/filter neighbours.
 *
 * **Self-hosted wasm, lazy, miss-only (BUILD §7, ADR-004):** the libvpx core is vendored *into this
 * directory* and loaded through `new URL('./vpx.wasm', import.meta.url)` — same-origin, no CDN, no
 * COOP/COEP — and only when a decoder is actually built. `supports()` answers honestly: if the vendored
 * core is absent (not yet built — see `BUILD.md`) it returns `false`, so the router falls through to a
 * typed {@link CapabilityError} instead of pretending VP9 works. The pure framing/format math lives in
 * {@link import('./vpx.ts')} and is validated in Node; the lossy transform/loop-filter decode is the core's.
 *
 * **`VideoFrame` close-exactly-once (docs/architecture/06 §3):** a decoded chunk yields zero or more
 * `VideoFrame`s (a hidden alt-ref produces none; a superframe several). Each is built from the core's raw
 * planes and enqueued to the readable — ownership transfers to the consumer, which `close()`s it. A frame
 * still in this driver's hands (constructed but not yet enqueued when an abort/error races) is closed
 * exactly once here. The encoded input chunks are plain byte holders (no `close()`).
 *
 * **Decode-only:** VP9 *encode* is not a WebCodecs gap this fallback exists to fill, and a pure-software
 * VP9 encoder is far too slow to be a credible browser fallback — so {@link createEncoder} is an honest
 * {@link CapabilityError} miss (the contract requires the method to exist; ADR-017 forbids faking it).
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
  type VpxCodec,
  type VpxDecodedFrame,
  type VpxDecoderInit,
  type VpxPixelFormat,
  type VpxWasmCore,
  type VpxWasmDecoder,
  normalizeVpxDecoderConfig,
  parseSuperframeIndex,
  parseVpxCodec,
  planeLayoutI420,
} from './vpx.ts';

// ============ pure, Node-testable helpers ============

/** The VPX video codec ids this driver can serve (decode). VP9 is the WebCodecs gap; VP8 rides along. */
export const VPX_CODECS: readonly VpxCodec[] = ['vp8', 'vp9'] as const;

/** True when a {@link CodecQuery} targets a VP8/VP9 *decode* — the only thing this driver can serve. */
export function isVpxDecodeQuery(q: CodecQuery): boolean {
  if (q.mediaType !== 'video' || q.direction !== 'decode') return false;
  try {
    parseVpxCodec(q.config.codec);
    return true;
  } catch {
    return false; // not a VP8/VP9 codec string
  }
}

/**
 * The honest {@link CodecSupport} for a query this driver cannot serve — non-VPX, encode, or the vendored
 * wasm core being absent. `supports()` must answer `false` (never throw) so the router can probe the
 * ladder cheaply (docs/architecture/05 §4); a miss then surfaces as a typed {@link CapabilityError}.
 */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

// ============ lazy, self-hosted wasm core ============

/** Memoized core load (one wasm instantiation per session); `null` once we've learned it is unavailable. */
let corePromise: Promise<VpxWasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasVpxCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./vpx-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored libvpx-in-wasm core, lazily and at most once. Resolves to the {@link VpxWasmCore}, or
 * `null` if the artifact is not vendored yet (the import throws) — that `null` is what makes the driver
 * *honest* about wasm absence rather than fabricating support. The wasm bytes are addressed via
 * `new URL('./vpx.wasm', import.meta.url)` so they ship same-origin alongside this chunk; the specifier is
 * a string literal so bundlers code-split it into its own lazy chunk (loaded only on a real VPX miss).
 */
export async function loadVpxCore(runtime?: WasmRuntimeProfile): Promise<VpxWasmCore | null> {
  corePromise ??= (async (): Promise<VpxWasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      // String-literal specifier → its own code-split chunk; absent until `BUILD.md` is run.
      const mod = await import('./vpx-core.js');
      await mod.default(wasmInitForProfile(new URL('./vpx.wasm', import.meta.url), profile));
      return mod.createVpxCore();
    } catch {
      // Not vendored (or failed to instantiate): report absence; the router yields a CapabilityError.
      return null;
    }
  })();
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetVpxCoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored VPX wasm core is unavailable. */
function coreMissing(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-vpx core is not available (not vendored)', {
    op,
    tried: ['wasm-vpx'],
    suggestion: 'build + vendor the libvpx wasm core per src/codecs/wasm-vpx/BUILD.md',
  });
}

/** The {@link CapabilityError} for VP9/VP8 *encode* — out of this decode-only fallback's scope (ADR-017). */
function encodeUnsupported(): CapabilityError {
  return new CapabilityError(
    'capability-miss',
    'wasm-vpx is a decode-only fallback; VP8/VP9 software encode is out of scope',
    { op: 'encode', tried: ['wasm-vpx'], suggestion: 'encode VP8/VP9 via WebCodecs VideoEncoder' },
  );
}

// ============ supports() ============

/**
 * Honest capability probe: a VP8/VP9 *decode* query **and** the vendored wasm core actually loads. Non-VPX,
 * encode, or core-absent → `{ supported:false }` with a reason; never throws (docs/architecture/05 §4).
 * Being `tier:'wasm'`, the router only calls this after WebCodecs VP9/VP8 has already missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'video') return unsupported('wasm-vpx handles video only');
  if (q.direction === 'encode') {
    return unsupported('wasm-vpx is a decode-only fallback (VP8/VP9 encode is out of scope)');
  }
  try {
    parseVpxCodec(q.config.codec);
  } catch {
    return unsupported(`wasm-vpx handles VP8/VP9 only, not '${q.config.codec}'`);
  }
  if (!(await hasVpxCoreGlue())) {
    return unsupported('wasm-vpx core glue is not vendored (see BUILD.md)');
  }
  if (typeof EncodedVideoChunk === 'undefined' || typeof VideoFrame === 'undefined') {
    return unsupported('wasm-vpx requires WebCodecs VideoFrame/EncodedVideoChunk');
  }
  return { supported: true, hardwareAccelerated: false };
}

// ============ seam narrowing + VideoFrame construction (browser-only types) ============

/* v8 ignore start -- every branch below requires WebCodecs (absent in Node); validated in-browser. */

/** Narrow the encoded-unit seam to the video arm; an audio chunk here is a router/seam bug. */
function asVideoChunk(chunk: EncodedChunk): EncodedVideoChunk {
  if (chunk instanceof EncodedVideoChunk) return chunk;
  throw new MediaError(
    'decode-error',
    'wasm-vpx received a non-video chunk (router/seam mismatch)',
  );
}

/** Copy a coded VP8/VP9 packet's bytes out of an `EncodedVideoChunk` (the wasm decoder takes a `Uint8Array`). */
function chunkBytes(chunk: EncodedVideoChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
}

/**
 * The bundled `lib.dom.d.ts` `VideoPixelFormat` omits the WebCodecs 10/12-bit planar formats
 * (`I420P10`/`I420P12`) that the spec defines and `VideoFrame` accepts — the same DOM-lib lag the audio
 * driver patches for `hardwareAcceleration` (`AudioDecoderConfigEx`). Narrow our {@link VpxPixelFormat} to
 * the lib's `VideoPixelFormat` at the single point it enters the `BufferInit` (no `any`); the runtime
 * accepts every value, so this widens the *type* surface to the spec without weakening the rest of the init.
 */
function asVideoPixelFormat(format: VpxPixelFormat): VideoPixelFormat {
  return format as VideoPixelFormat;
}

/**
 * Build a `VideoFrame` from one tightly-packed 4:2:0 frame the wasm core returned. The plane layout is
 * derived purely ({@link planeLayoutI420}) from the decoded dims + bit depth; `timestamp`/`duration` come
 * from the source chunk (WebCodecs µs convention). The readable consumer owns and `close()`s it exactly
 * once. `duration` is set only when the chunk carried one (exactOptionalPropertyTypes / ADR-011) — the
 * base init is spread so neither branch ever assigns `duration: undefined`.
 */
function buildVideoFrame(
  decoded: VpxDecodedFrame,
  timestampUs: number,
  durationUs: number | null,
): VideoFrame {
  const layout = planeLayoutI420(decoded.width, decoded.height, decoded.bitDepth);
  const base: VideoFrameBufferInit = {
    format: asVideoPixelFormat(layout.format),
    codedWidth: layout.codedWidth,
    codedHeight: layout.codedHeight,
    timestamp: timestampUs,
    layout: [...layout.planes],
  };
  const init: VideoFrameBufferInit = durationUs === null ? base : { ...base, duration: durationUs };
  return new VideoFrame(decoded.data, init);
}

/* v8 ignore stop */

// ============ createDecoder() ============

/**
 * Build the VPX **decode** stream: `EncodedVideoChunk` (VP8/VP9 packets) → `VideoFrame` (4:2:0). The wasm
 * core loads lazily on `start`; each packet decodes through libvpx (VP8/VP9 have no presentation reorder —
 * altref/hidden frames are handled inside the core and simply emit no displayed frame), and every
 * displayable frame the packet produced is enqueued in order for the consumer to own.
 *
 * Timestamps: a single-frame packet carries the chunk's own timestamp. A superframe (several coded frames
 * in one chunk) advances the presentation clock per displayed sub-frame, spacing them by the chunk's
 * duration ÷ displayed-frame-count when a duration is known — so multi-frame packets keep a monotonic PTS.
 */
function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  // Validate the config eagerly (fail-fast, Node-testable) before any wasm work — also rejects audio
  // configs (no VP8/VP9 codec string) up front with a typed decode-error.
  const init: VpxDecoderInit = normalizeVpxDecoderConfig(config as VideoDecoderConfig);

  /* v8 ignore start -- requires WebCodecs VideoFrame + the vendored wasm core; validated in-browser. */
  let decoder: VpxWasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  // Frames built but not yet enqueued (none, outside the synchronous enqueue loop) — so an abort racing
  // construction still closes a frame exactly once.
  const pendingFrames = new Set<VideoFrame>();

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    for (const frame of pendingFrames) frame.close();
    pendingFrames.clear();
    decoder?.free(); // idempotent; releases the native decoder
    decoder = undefined;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadVpxCore(o?.wasmRuntime);
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
      if (!dec) throw new MediaError('decode-error', 'wasm-vpx decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const videoChunk = asVideoChunk(chunk);
      const packet = chunkBytes(videoChunk);
      // Parse the superframe index purely (count coded sub-frames) so multi-frame packets get spaced
      // timestamps; the core decodes the whole packet and returns only the displayable frames.
      const subFrameCount = parseSuperframeIndex(packet).frames.length;
      const frames = dec.decode(packet);
      enqueueFrames(controller, frames, videoChunk, subFrameCount, pendingFrames);
    },
    flush(): void {
      // VP8/VP9 are packet-synchronous in this fallback (no decoder reorder buffer to drain); every
      // displayable frame was emitted in `transform`. Release the native decoder.
      teardown();
    },
  });
  /* v8 ignore stop */
}

/* v8 ignore start -- requires WebCodecs VideoFrame; validated in-browser. */

/**
 * Enqueue every displayable frame a packet produced, assigning each a monotonic timestamp. With a single
 * displayed frame, it inherits the chunk's timestamp/duration. With several (a superframe), they are
 * spaced by `chunkDuration ÷ count` from the chunk's start when a duration is known, else they share the
 * chunk timestamp with no duration (the muxer/sink re-derives spacing from the next chunk). Each frame's
 * ownership transfers to the readable on `enqueue`; until then it sits in `pending` so an error closes it.
 */
function enqueueFrames(
  controller: TransformStreamDefaultController<RawFrame>,
  frames: readonly VpxDecodedFrame[],
  chunk: EncodedVideoChunk,
  subFrameCount: number,
  pending: Set<VideoFrame>,
): void {
  const count = frames.length;
  if (count === 0) return; // a hidden alt-ref packet: decoded, but nothing to display
  const chunkDuration = chunk.duration; // µs or null
  // Per-displayed-frame step: split the chunk's duration across however many frames it actually displayed.
  const step =
    chunkDuration === null ? 0 : Math.round(chunkDuration / Math.max(count, subFrameCount, 1));
  for (let i = 0; i < count; i++) {
    const decoded = frames[i];
    if (decoded === undefined) continue; // unreachable for i in [0,count); satisfies the checker
    const timestamp = chunk.timestamp + (chunkDuration === null ? 0 : step * i);
    const duration = chunkDuration === null ? null : step;
    const frame = buildVideoFrame(decoded, timestamp, duration);
    pending.add(frame);
    try {
      controller.enqueue(frame); // ownership transfers to the readable side
    } finally {
      pending.delete(frame);
    }
  }
}

/* v8 ignore stop */

// ============ createEncoder() — honest decode-only miss ============

/**
 * VP8/VP9 *encode* is out of this fallback's scope (it exists to fill the VP9 *decode* gap; a pure-software
 * VP9 encoder is not a credible browser path). The contract requires the method, so it exists — and raises
 * a typed {@link CapabilityError} immediately rather than faking an encoder (ADR-017, directive 6).
 */
function createEncoder(
  _config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  throw encodeUnsupported();
}

// ============ driver + module ============

/** The WASM VP8/VP9 codec driver — `tier:'wasm'`, decode-only, vendored core loaded miss-only (ADR-026). */
export const WasmVpxDriver: CodecDriver = {
  id: 'wasm-vpx',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmVpxModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmVpxDriver);
  },
};

export default WasmVpxModule;
