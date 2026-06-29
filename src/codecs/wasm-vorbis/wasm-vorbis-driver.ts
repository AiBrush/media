/**
 * The **WASM Vorbis** codec driver — a real miss-only fallback for Vorbis *decode* when the browser's
 * WebCodecs has no Vorbis `AudioDecoder` (common: Chrome/Safari lack it; docs/architecture/04 wasm tier,
 * 05 §CodecDriver, ADR-032). `tier:'wasm'`, so the router ranks it **last** and only builds it on a real
 * WebCodecs Vorbis miss.
 *
 * **The codec is real, not a scaffold:** Symphonia's pure-Rust `symphonia-codec-vorbis` is compiled to
 * WebAssembly (no C toolchain needed) and **vendored into this directory** (`vorbis_wasm_bg.wasm` +
 * `vorbis-core.js`, built per `BUILD.md`), loaded same-origin via `new URL('./vorbis_wasm_bg.wasm',
 * import.meta.url)` — lazy, no CDN, no COOP/COEP. The pure header-lacing / Ogg-de-lacing / format glue is
 * in {@link import('./vorbis.ts')} and Node-validated; the lossy MDCT decode is the wasm core's.
 *
 * **Shape mirrors {@link import('../webcodecs-audio.ts')}:** `createDecoder` is a `TransformStream`
 * (`EncodedAudioChunk` → `AudioData`) — configure the wasm decoder on `start` (from the codec-private
 * `description`), decode each packet on `transform`, release on `flush`/`cancel`/abort. Vorbis encode is
 * an honest miss until a vetted permissive encoder core (for example libvorbisenc + libogg with notices)
 * is vendored behind the codec seam, so `createEncoder` raises a typed {@link CapabilityError}.
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
  VORBIS_CODEC,
  type VorbisDecodeConfig,
  type VorbisWasmCore,
  type VorbisWasmDecoder,
  deinterleaveF32,
  normalizeVorbisDecoderConfig,
} from './vorbis.ts';

// ============ pure, Node-testable helpers ============

/** True when a {@link CodecQuery} targets Vorbis audio — the only thing this driver can serve. */
export function isVorbisQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.config.codec === VORBIS_CODEC;
}

/**
 * The honest {@link CodecSupport} for a query this driver cannot serve — non-Vorbis, encode (no
 * encoder), or the vendored wasm core failing to load. `supports()` must answer `false` (never throw) so
 * the router probes the ladder cheaply (docs/architecture/05 §4); a miss then surfaces as a typed
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
let corePromise: Promise<VorbisWasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasVorbisCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./vorbis-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored Symphonia-Vorbis wasm core, lazily and at most once. Resolves to a
 * {@link VorbisWasmCore} (wrapping the generated `VorbisWasm` class), or `null` if the artifact fails to
 * load — keeping the driver honest about absence rather than fabricating support. The wasm bytes are
 * addressed via `new URL('./vorbis_wasm_bg.wasm', import.meta.url)` so they ship same-origin.
 */
export async function loadVorbisCore(runtime?: WasmRuntimeProfile): Promise<VorbisWasmCore | null> {
  corePromise ??= (async (): Promise<VorbisWasmCore | null> => {
    try {
      const profile = runtime ?? resolveWasmRuntimeProfile();
      // String-literal specifier → its own code-split chunk; the artifact is vendored in this dir.
      const mod = await import('./vorbis-core.js');
      await mod.default(
        wasmInitForProfile(new URL('./vorbis_wasm_bg.wasm', import.meta.url), profile),
      );
      return {
        createDecoder(
          extraData: Uint8Array,
          channels: number,
          sampleRate: number,
        ): VorbisWasmDecoder {
          return new mod.VorbisWasm(extraData, channels, sampleRate);
        },
      };
    } catch {
      return null; // not loadable here → honest miss; router yields a CapabilityError
    }
  })();
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetVorbisCoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored Vorbis wasm core is unavailable. */
function coreMissing(): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-vorbis core is not available', {
    op: 'decode',
    tried: ['wasm-vorbis'],
    suggestion: 'build + vendor the Vorbis wasm core per src/codecs/wasm-vorbis/BUILD.md',
  });
}

// ============ supports() ============

/**
 * Honest capability probe: a Vorbis **decode** query in a runtime that can carry WebCodecs-shaped audio
 * frames and whose vendored wasm core loads. Non-Vorbis, `encode` (no vetted Vorbis encoder core),
 * missing `AudioData`/`EncodedAudioChunk`, or core-absent → `{ supported:false }` with a reason; never throws.
 * Being `tier:'wasm'`, the router only calls this after WebCodecs Vorbis has already missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-vorbis handles audio only');
  if (q.config.codec !== VORBIS_CODEC) {
    return unsupported(`wasm-vorbis handles Vorbis only, not '${q.config.codec}'`);
  }
  if (q.direction === 'encode') {
    return unsupported('wasm-vorbis decodes only (no vetted Vorbis encoder core vendored)');
  }
  try {
    normalizeVorbisDecoderConfig(q.config as AudioDecoderConfig);
  } catch (e: unknown) {
    return unsupported(errMessage(e));
  }
  if (!hasWebCodecsAudioSeam()) {
    return unsupported('wasm-vorbis requires WebCodecs AudioData/EncodedAudioChunk');
  }
  if (!(await hasVorbisCoreGlue())) {
    return unsupported('wasm-vorbis core glue is not vendored (see BUILD.md)');
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
    'wasm-vorbis received a non-audio chunk (router/seam mismatch)',
  );
}

/** Copy a Vorbis packet's bytes out of an `EncodedAudioChunk` (the wasm decoder takes a `Uint8Array`). */
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
 * Build the Vorbis **decode** stream: `EncodedAudioChunk` (Vorbis packets) → `AudioData` (f32-planar).
 * The wasm core loads lazily on `start` and is configured from the codec-private `description`; each
 * audio packet decodes to one block of interleaved f32 (the first may be empty — overlap priming — and is
 * dropped). Output `AudioData` is enqueued for the consumer to own (close-exactly-once).
 */
function createDecoder(
  config: DecoderConfig,
  o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before decode');
  // Validate the config eagerly (fail-fast, Node-testable) before any wasm work.
  const cfg: VorbisDecodeConfig = normalizeVorbisDecoderConfig(config as AudioDecoderConfig);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let decoder: VorbisWasmDecoder | undefined;
  let onAbort: (() => void) | undefined;
  let emittedSamples = 0; // running PTS in output-rate samples (Vorbis packets are contiguous)

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    decoder?.free();
    decoder = undefined;
  };

  return new TransformStream<EncodedChunk, RawFrame>({
    async start(controller): Promise<void> {
      const core = await loadVorbisCore(o?.wasmRuntime);
      if (core === null) {
        controller.error(coreMissing());
        return;
      }
      try {
        decoder = core.createDecoder(cfg.extraData, cfg.channels, cfg.sampleRate);
      } catch (e) {
        controller.error(new MediaError('decode-error', `wasm-vorbis init: ${errMessage(e)}`, e));
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
      if (!dec) throw new MediaError('decode-error', 'wasm-vorbis decoder not configured');
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const packet = chunkBytes(asAudioChunk(chunk));
      let interleaved: Float32Array;
      try {
        interleaved = dec.decode(packet);
      } catch (e) {
        throw new MediaError('decode-error', `wasm-vorbis decode: ${errMessage(e)}`, e);
      }
      const channels = dec.channels;
      const frames = channels > 0 ? interleaved.length / channels : 0;
      if (frames === 0) return; // overlap priming / empty block — nothing to emit
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
      // Vorbis is packet-synchronous here: every decoded block was emitted in `transform`. Nothing to drain.
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

// ============ createEncoder() — honest miss (no vetted Vorbis encoder core) ============

/**
 * Vorbis **encode** is not provided: the vendored Symphonia tail is decode-only and no production,
 * provenance-cleared permissive encoder core is registered. Per the no-silent-degrade contract (ADR-017)
 * this raises a typed {@link CapabilityError} immediately. The router only reaches here on a WebCodecs
 * Vorbis-encode miss.
 */
function createEncoder(
  _config: EncoderConfig,
  _o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  throw new CapabilityError(
    'capability-miss',
    'wasm-vorbis does not support Vorbis encode (no vetted permissive encoder core is vendored)',
    {
      op: 'encode',
      tried: ['wasm-vorbis'],
      suggestion:
        'vendor a permissive libvorbis/libogg encoder core with notices, or encode to Opus/AAC',
    },
  );
}

// ============ driver + module ============

/** The WASM Vorbis codec driver — `tier:'wasm'`, decode-only, vendored Symphonia core (ADR-032). */
export const WasmVorbisDriver: CodecDriver = {
  id: 'wasm-vorbis',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmVorbisModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmVorbisDriver);
  },
};

export default WasmVorbisModule;
