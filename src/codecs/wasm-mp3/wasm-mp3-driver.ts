/**
 * The **WASM MP3** codec driver — a real miss-only fallback for MP3 *decode* when the browser's WebCodecs
 * has no MP3 `AudioDecoder` (some WebKit/Firefox builds lack it; docs/architecture/04 wasm tier, 05
 * §CodecDriver, ADR-032). `tier:'wasm'`, so the router ranks it **last** and only builds it on a real
 * WebCodecs MP3 miss.
 *
 * **The codec is real, not a scaffold:** Symphonia's pure-Rust `symphonia-bundle-mp3` (`MpaDecoder`, no C)
 * is compiled to WebAssembly and **vendored into this directory** (`mp3_wasm_bg.wasm` + `mp3-core.js`,
 * built per `BUILD.md`), loaded same-origin via `new URL('./mp3_wasm_bg.wasm', import.meta.url)` — lazy, no
 * CDN, no COOP/COEP. The pure frame-header / ID3 / Xing-LAME / format glue is in
 * {@link import('./mp3.ts')} and Node-validated; the lossy Layer-III decode is the wasm core's.
 *
 * **Shape mirrors {@link import('../wasm-vorbis/wasm-vorbis-driver.ts')}:** `createDecoder` is a
 * `TransformStream` (`EncodedAudioChunk` → `AudioData`) — construct the wasm decoder on `start` (MP3 needs
 * no codec-private `description`, unlike Vorbis), decode each frame on `transform`, release on
 * `flush`/`cancel`/abort. MP3 *encode* is not provided: libmp3lame would introduce LGPL obligations and
 * has not been explicitly approved for this build, so `createEncoder` honestly raises a typed
 * {@link CapabilityError}.
 *
 * **`AudioData` close-exactly-once (docs/architecture/06 §3):** decoder *output* `AudioData` is enqueued
 * to the readable and owned by the consumer — the driver never closes an emitted frame. There is no
 * encoder input to own. On cancel/error the wasm decoder is `free()`d once.
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
  type Mp3DecodeConfig,
  type Mp3WasmCore,
  type Mp3WasmDecoder,
  deinterleaveF32,
  isMp3Codec,
  normalizeMp3DecoderConfig,
} from './mp3.ts';

// ============ pure, Node-testable helpers ============

/** True when a {@link CodecQuery} targets MP3 audio — the only thing this driver can serve. */
export function isMp3Query(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && isMp3Codec(q.config.codec);
}

/**
 * The honest {@link CodecSupport} for a query this driver cannot serve — non-MP3, encode (no encoder), or
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
let corePromise: Promise<Mp3WasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasMp3CoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./mp3-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored Symphonia-MP3 wasm core, lazily and at most once. Resolves to an {@link Mp3WasmCore}
 * (wrapping the generated `Mp3Wasm` class), or `null` if the artifact fails to load — keeping the driver
 * honest about absence rather than fabricating support. The wasm bytes are addressed via
 * `new URL('./mp3_wasm_bg.wasm', import.meta.url)` so they ship same-origin alongside this chunk; the
 * specifier is a string literal so bundlers code-split it into its own lazy chunk (loaded only on a real
 * MP3 miss).
 */
export async function loadMp3Core(runtime?: WasmRuntimeProfile): Promise<Mp3WasmCore | null> {
  corePromise ??= (async (): Promise<Mp3WasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      // String-literal specifier → its own code-split chunk; the artifact is vendored in this dir.
      const mod = await import('./mp3-core.js');
      await mod.default(
        wasmInitForProfile(new URL('./mp3_wasm_bg.wasm', import.meta.url), profile),
      );
      return {
        createDecoder(channels: number, sampleRate: number): Mp3WasmDecoder {
          return new mod.Mp3Wasm(channels, sampleRate);
        },
      };
    } catch {
      return null; // not loadable here → honest miss; router yields a CapabilityError
    }
  })();
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetMp3CoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored MP3 wasm core is unavailable. */
function coreMissing(): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-mp3 core is not available', {
    op: 'decode',
    tried: ['wasm-mp3'],
    suggestion: 'build + vendor the MP3 wasm core per src/codecs/wasm-mp3/BUILD.md',
  });
}

// ============ supports() ============

/**
 * Honest capability probe: an MP3 **decode** query in a runtime that can carry WebCodecs-shaped audio
 * frames and whose vendored wasm core loads. Non-MP3, `encode` (no approved MP3 encoder core), missing
 * `AudioData`/`EncodedAudioChunk`, or core-absent → `{ supported:false }` with a reason; never throws.
 * Being `tier:'wasm'`, the router only calls this after WebCodecs MP3 has already missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-mp3 handles audio only');
  if (!isMp3Codec(q.config.codec)) {
    return unsupported(`wasm-mp3 handles MP3 only, not '${q.config.codec}'`);
  }
  if (q.direction === 'encode') {
    return unsupported('wasm-mp3 decodes only (LGPL MP3 encode core is not approved)');
  }
  try {
    normalizeMp3DecoderConfig(q.config as AudioDecoderConfig);
  } catch (e: unknown) {
    return unsupported(errMessage(e));
  }
  if (!hasWebCodecsAudioSeam()) {
    return unsupported('wasm-mp3 requires WebCodecs AudioData/EncodedAudioChunk');
  }
  if (!(await hasMp3CoreGlue())) {
    return unsupported('wasm-mp3 core glue is not vendored (see BUILD.md)');
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
    'wasm-mp3 received a non-audio chunk (router/seam mismatch)',
  );
}

/** Copy an MP3 frame's bytes out of an `EncodedAudioChunk` (the wasm decoder takes a `Uint8Array`). */
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
 * Build the MP3 **decode** stream: `EncodedAudioChunk` (MP3 frames) → `AudioData` (f32-planar). The wasm
 * core loads lazily on `start` and is seeded with the config geometry (MP3 needs no codec-private headers);
 * each frame decodes to one block of interleaved f32 (1152 samples/ch for MPEG-1 Layer III, 576 for
 * MPEG-2/2.5). MP3's bit reservoir is held inside the single decoder instance, so frames must be fed in
 * order — which the stream does. Output `AudioData` is enqueued for the consumer to own (close-once).
 */
function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  // Validate the config eagerly (fail-fast, Node-testable) before any wasm work.
  const cfg: Mp3DecodeConfig = normalizeMp3DecoderConfig(config as AudioDecoderConfig);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let decoder: Mp3WasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  let emittedSamples = 0; // running PTS in output-rate samples (MP3 frames are contiguous)

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    decoder?.free();
    decoder = undefined;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadMp3Core(o?.wasmRuntime);
      if (core === null) {
        controller.error(coreMissing());
        return;
      }
      try {
        decoder = core.createDecoder(cfg.channels, cfg.sampleRate);
      } catch (e) {
        controller.error(new MediaError('decode-error', `wasm-mp3 init: ${errMessage(e)}`, e));
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
      if (!dec) throw new MediaError('decode-error', 'wasm-mp3 decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const frame = chunkBytes(asAudioChunk(chunk));
      let interleaved: Float32Array;
      try {
        interleaved = dec.decode(frame);
      } catch (e) {
        throw new MediaError('decode-error', `wasm-mp3 decode: ${errMessage(e)}`, e);
      }
      const channels = dec.channels;
      const frames = channels > 0 ? interleaved.length / channels : 0;
      if (frames === 0) return; // an empty frame — nothing to emit
      const data = buildAudioData(
        interleaved,
        channels,
        frames,
        dec.sampleRate,
        samplesToMicros(emittedSamples, dec.sampleRate),
      );
      emittedSamples += frames;
      controller.enqueue(data); // consumer owns + closes it
    },
    flush(): void {
      // MP3 is frame-synchronous here: every decoded block was emitted in `transform`. Nothing to drain.
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

// ============ createEncoder() — honest miss (no approved MP3 encoder core) ============

/**
 * MP3 **encode** is not provided: Symphonia is decode-only, and the practical C encoder path
 * (libmp3lame) is LGPL and not approved for this build. Per the no-silent-degrade contract (ADR-017) this
 * raises a typed {@link CapabilityError} immediately. The router only reaches here on a WebCodecs
 * MP3-encode miss.
 */
function createEncoder(
  _config: EncoderConfig,
  _o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  throw new CapabilityError(
    'capability-miss',
    'wasm-mp3 does not support MP3 encode (no approved MP3 encoder core is vendored)',
    {
      op: 'encode',
      tried: ['wasm-mp3'],
      suggestion:
        'encode to Opus/AAC, or explicitly approve and isolate an LGPL libmp3lame tail before registering MP3 encode',
    },
  );
}

// ============ driver + module ============

/** The WASM MP3 codec driver — `tier:'wasm'`, decode-only, vendored Symphonia core (ADR-032). */
export const WasmMp3Driver: CodecDriver = {
  id: 'wasm-mp3',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmMp3Module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmMp3Driver);
  },
};

export default WasmMp3Module;
