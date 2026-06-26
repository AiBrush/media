/**
 * The **WASM AAC** codec driver — a real miss-only fallback for AAC (AAC-LC) *decode* when the browser's
 * WebCodecs has no AAC `AudioDecoder` (e.g. Chromium builds without proprietary codecs, or locked-down
 * embeddings; docs/architecture/04 wasm tier, 05 §CodecDriver, ADR-037). `tier:'wasm'`, so the router
 * ranks it **last** and only builds it on a real WebCodecs AAC miss.
 *
 * **The codec is real, not a scaffold:** Symphonia's pure-Rust `symphonia-codec-aac` is compiled to
 * WebAssembly (no C toolchain) and **vendored into this directory** (`aac_wasm_bg.wasm` + `aac-core.js`,
 * built per `BUILD.md`), loaded same-origin via `new URL('./aac_wasm_bg.wasm', import.meta.url)` — lazy,
 * no CDN, no COOP/COEP. The pure ADTS-framing / ASC / format glue is in {@link import('./aac.ts')} and
 * Node-validated; the lossy MDCT decode is the wasm core's.
 *
 * **Shape mirrors {@link import('../wasm-vorbis/wasm-vorbis-driver.ts')}:** `createDecoder` is a
 * `TransformStream` (`EncodedAudioChunk` → `AudioData`) — configure the wasm decoder on `start` (from the
 * codec-private `description`/ASC), decode each **raw** AAC packet on `transform`, release on
 * `flush`/`cancel`/abort. Symphonia is decode-only, so `createEncoder` honestly raises a typed
 * {@link CapabilityError} (the router only reaches it on a WebCodecs AAC-encode miss anyway).
 *
 * **AAC packet framing:** Symphonia's decoder consumes the **raw AAC payload**. For MP4 (`mp4a`) the
 * demuxer already yields raw packets + the ASC in `esds` (→ the WebCodecs `description`). For an ADTS
 * source the 7/9-byte ADTS header must be stripped first ({@link import('./aac.ts')} `parseAdtsFrame`);
 * the router's container layer does that before the codec seam.
 *
 * **`AudioData` close-exactly-once (docs/architecture/06 §3):** decoder *output* `AudioData` is enqueued
 * to the readable and owned by the consumer — the driver never closes an emitted frame. On cancel/error
 * the wasm decoder is `free()`d once.
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
  type AacDecodeConfig,
  type AacWasmCore,
  type AacWasmDecoder,
  deinterleaveF32,
  isAacCodec,
  normalizeAacDecoderConfig,
} from './aac.ts';

// ============ pure, Node-testable helpers ============

/** True when a {@link CodecQuery} targets AAC audio — the only thing this driver can serve. */
export function isAacQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && isAacCodec(q.config.codec);
}

/**
 * The honest {@link CodecSupport} for a query this driver cannot serve — non-AAC, encode (no encoder), or
 * the vendored wasm core failing to load. `supports()` must answer `false` (never throw) so the router
 * probes the ladder cheaply (docs/architecture/05 §4); a miss then surfaces as a typed
 * {@link CapabilityError} upstream.
 */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

/** True when this runtime can carry the public audio codec stream (`EncodedAudioChunk` → `AudioData`). */
function hasWebCodecsAudioSeam(): boolean {
  return typeof EncodedAudioChunk !== 'undefined' && typeof AudioData !== 'undefined';
}

// ============ lazy, self-hosted wasm core ============

/** Memoized core load (one wasm instantiation per session); `null` once we've learned it is unavailable. */
let corePromise: Promise<AacWasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasAacCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./aac-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored Symphonia-AAC wasm core, lazily and at most once. Resolves to an {@link AacWasmCore}
 * (wrapping the generated `AacWasm` class), or `null` if the artifact fails to load — keeping the driver
 * honest about absence rather than fabricating support. The wasm bytes are addressed via
 * `new URL('./aac_wasm_bg.wasm', import.meta.url)` so they ship same-origin.
 */
export async function loadAacCore(runtime?: WasmRuntimeProfile): Promise<AacWasmCore | null> {
  corePromise ??= (async (): Promise<AacWasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      // String-literal specifier → its own code-split chunk; the artifact is vendored in this dir.
      const mod = await import('./aac-core.js');
      await mod.default(
        wasmInitForProfile(new URL('./aac_wasm_bg.wasm', import.meta.url), profile),
      );
      return {
        createDecoder(extraData: Uint8Array, channels: number, sampleRate: number): AacWasmDecoder {
          return new mod.AacWasm(extraData, channels, sampleRate);
        },
      };
    } catch {
      return null; // not loadable here → honest miss; router yields a CapabilityError
    }
  })();
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetAacCoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored AAC wasm core is unavailable. */
function coreMissing(): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-aac core is not available', {
    op: 'decode',
    tried: ['wasm-aac'],
    suggestion: 'build + vendor the AAC wasm core per src/codecs/wasm-aac/BUILD.md',
  });
}

// ============ supports() ============

/**
 * Honest capability probe: an AAC **decode** query in a runtime that can carry WebCodecs-shaped audio
 * frames and whose vendored wasm core loads. Non-AAC, `encode` (no pure-Rust AAC encoder), missing
 * `AudioData`/`EncodedAudioChunk`, or core-absent → `{ supported:false }` with a reason; never throws.
 * Being `tier:'wasm'`, the router only calls this after WebCodecs AAC has already missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-aac handles audio only');
  if (!isAacCodec(q.config.codec)) {
    return unsupported(`wasm-aac handles AAC only, not '${q.config.codec}'`);
  }
  if (q.direction === 'encode') return unsupported('wasm-aac decodes only (no AAC encoder)');
  if (!hasWebCodecsAudioSeam()) {
    return unsupported('wasm-aac requires WebCodecs AudioData/EncodedAudioChunk');
  }
  if (!(await hasAacCoreGlue())) {
    return unsupported('wasm-aac core glue is not vendored (see BUILD.md)');
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
    'wasm-aac received a non-audio chunk (router/seam mismatch)',
  );
}

/** Copy an AAC packet's bytes out of an `EncodedAudioChunk` (the wasm decoder takes a `Uint8Array`). */
function chunkBytes(chunk: EncodedAudioChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
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
 * Build the AAC **decode** stream: `EncodedAudioChunk` (raw AAC packets) → `AudioData` (f32-planar). The
 * wasm core loads lazily on `start` and is configured from the codec-private `description` (ASC); each
 * AAC-LC packet decodes to 1024 samples/channel of interleaved f32. Output `AudioData` is enqueued for
 * the consumer to own (close-exactly-once).
 */
function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  // Validate the config eagerly (fail-fast, Node-testable) before any wasm work.
  const cfg: AacDecodeConfig = normalizeAacDecoderConfig(config as AudioDecoderConfig);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let decoder: AacWasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  let emittedSamples = 0; // running PTS in output-rate samples (AAC packets are contiguous)
  // Cache the geometry once (the stream's channels/rate are fixed): reading the wasm-bindgen getters
  // repeatedly, interleaved with `decode` round-trips, can corrupt the glue's heap-object table.
  let decChannels = cfg.channels;
  let decSampleRate = cfg.sampleRate;

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    decoder?.free();
    decoder = undefined;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadAacCore(o?.wasmRuntime);
      if (core === null) {
        controller.error(coreMissing());
        return;
      }
      try {
        decoder = core.createDecoder(cfg.extraData, cfg.channels, cfg.sampleRate);
        decChannels = decoder.channels; // authoritative geometry, read once
        decSampleRate = decoder.sampleRate;
      } catch (e) {
        controller.error(new MediaError('decode-error', `wasm-aac init: ${errMessage(e)}`, e));
        return;
      }
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(chunk, controller): void {
      const dec = decoder;
      if (!dec) throw new MediaError('decode-error', 'wasm-aac decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const packet = chunkBytes(asAudioChunk(chunk));
      let interleaved: Float32Array;
      try {
        interleaved = dec.decode(packet);
      } catch (e) {
        throw new MediaError('decode-error', `wasm-aac decode: ${errMessage(e)}`, e);
      }
      const frames = decChannels > 0 ? interleaved.length / decChannels : 0;
      if (frames === 0) return; // nothing to emit
      const data = buildAudioData(
        interleaved,
        decChannels,
        frames,
        decSampleRate,
        samplesToMicros(emittedSamples, decSampleRate),
      );
      emittedSamples += frames;
      controller.enqueue(data); // consumer owns + closes it
    },
    flush(): void {
      // AAC is packet-synchronous here: every decoded block was emitted in `transform`. Nothing to drain.
      teardown();
    },
  });
  /* v8 ignore stop */
}

/** Extract a message from an unknown thrown value (the wasm glue rejects with a string or Error). */
function errMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'unknown error';
}

// ============ createEncoder() — honest miss (no pure-Rust AAC encoder) ============

/**
 * AAC **encode** is not provided: Symphonia is decode-only and there is no production pure-Rust AAC
 * encoder to compile to wasm. Per the no-silent-degrade contract (ADR-017) this raises a typed
 * {@link CapabilityError} immediately. The router only reaches here on a WebCodecs AAC-encode miss;
 * callers should target Opus instead.
 */
function createEncoder(
  _config: EncoderConfig,
  _o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  throw new CapabilityError('capability-miss', 'wasm-aac does not support AAC encode', {
    op: 'encode',
    tried: ['wasm-aac'],
    suggestion: 'encode to Opus instead (no pure-Rust AAC encoder exists)',
  });
}

// ============ driver + module ============

/** The WASM AAC codec driver — `tier:'wasm'`, decode-only (AAC-LC), vendored Symphonia core (ADR-037). */
export const WasmAacDriver: CodecDriver = {
  id: 'wasm-aac',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmAacModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmAacDriver);
  },
};

export default WasmAacModule;
