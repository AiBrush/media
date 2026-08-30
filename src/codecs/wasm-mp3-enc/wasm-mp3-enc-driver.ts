/**
 * WASM MP3 **encoder** tail. No browser ships an `AudioEncoder` for MP3 — WebCodecs registers MP3 for
 * decode only — so an MP3 encode target is a guaranteed native miss on every engine. This driver is the
 * fallback: `tier:'wasm'`, encode-only, and it lazily instantiates the vendored LAME core
 * (`mp3_enc_wasm_bg.wasm` + `mp3-enc-core.js`, see `BUILD.md`) same-origin via
 * `new URL('./mp3_enc_wasm_bg.wasm', import.meta.url)` — no CDN, no COOP/COEP, and nothing loaded until a
 * real MP3 encode arrives. That URL shape is measured to resolve under Vite dev (main thread and module
 * worker) and under a production Rollup build, and it keeps the core streaming-compilable and separately
 * cacheable rather than paying ~33% base64 overhead inside the JS chunk.
 *
 * Shape mirrors {@link import('../wasm-vorbis-enc/wasm-vorbis-enc-driver.ts')}: `createEncoder` is a
 * `TransformStream` (`AudioData` → `EncodedAudioChunk`) that builds the encoder on `start` (publishing the
 * destination `AudioDecoderConfig` through the `onConfig` hook so the muxer can add its track), encodes
 * each frame on `transform`, and flushes LAME's bit reservoir on `flush`.
 *
 * **Re-framing (load-bearing).** LAME returns whatever bytes its reservoir happens to release per call;
 * those runs do not align with MPEG frame boundaries. {@link Mp3FrameSplitter} re-frames them so each
 * emitted `EncodedAudioChunk` is exactly one MPEG frame with its own timestamp — what MP4's `esds`
 * object-type 0x6b track and the raw MP3 muxer both require.
 *
 * **`AudioData` close-exactly-once (docs/architecture/06 §3):** encoder *input* frames are owned by this
 * driver and closed once in `transform`; the emitted chunks are sealed WebCodecs objects with no lifetime.
 */

import type {
  AudioEncoderOutputTiming,
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
import { resolveWasmAssetUrl, wasmInitForProfile } from '../../kernel/wasm-loader-runtime.ts';
import { resolveWasmRuntimeProfile } from '../../kernel/wasm-runtime.ts';
import {
  MP3_CODEC,
  MP3_ENCODER_LEAD_IN_SAMPLES,
  type Mp3EncWasmCore,
  type Mp3EncoderInit,
  Mp3FrameSplitter,
  type Mp3WasmEncoder,
  buildMp3EncoderParams,
  errMessage,
  isMp3Codec,
  mp3SamplesPerFrame,
  normalizeMp3EncoderConfig,
  samplesToMicros,
  validateMp3Planes,
} from './mp3-enc.ts';

// ============ pure, Node-testable helpers ============

/** The MIME type the vendored core must report — the proof that the MP3 wasm (not the Ogg one) loaded. */
const MP3_CORE_MIME_TYPE = 'audio/mpeg';

/** True when a {@link CodecQuery} targets MP3 **encode** — the only thing this driver can serve. */
export function isMp3EncodeQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.direction === 'encode' && isMp3Codec(q.config.codec);
}

/** The honest {@link CodecSupport} for a query this driver cannot serve; `supports()` never throws. */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

/** True when this runtime can carry the public audio codec stream (`AudioData` → `EncodedAudioChunk`). */
function hasWebCodecsAudioSeam(): boolean {
  return typeof EncodedAudioChunk !== 'undefined' && typeof AudioData !== 'undefined';
}

/** Driver-local stage options: the destination-config and timing sinks the engine attaches. */
export interface Mp3EncoderStageOptions extends StageOptions {
  onConfig?(config: AudioDecoderConfig): void;
  /** Called once after flush with exact destination-owned sample accounting. */
  onTiming?(timing: AudioEncoderOutputTiming): void;
}

function mp3ConfigSink(
  o: StageOptions | undefined,
): ((config: AudioDecoderConfig) => void) | undefined {
  const sink = (o as Mp3EncoderStageOptions | undefined)?.onConfig;
  return typeof sink === 'function' ? sink : undefined;
}

function mp3TimingSink(
  o: StageOptions | undefined,
): ((timing: AudioEncoderOutputTiming) => void) | undefined {
  const sink = (o as Mp3EncoderStageOptions | undefined)?.onTiming;
  return typeof sink === 'function' ? sink : undefined;
}

// ============ lazy, self-hosted wasm core ============

/** Memoized core load (one wasm instantiation per asset+profile); `null` once known unavailable. */
const corePromises = new Map<string, Promise<Mp3EncWasmCore | null>>();
let coreGluePromise: Promise<boolean> | undefined;

/**
 * Why the last core load failed, kept for the capability error's causal chain.
 *
 * A tail that is simply not vendored and a tail whose wasm failed to instantiate are different classes of
 * failure (REQUIREMENTS §5.9: capability absence, browser failure and internal invariant failure must be
 * distinct, and errors must carry a causal chain). Collapsing both into a bare "core is not available"
 * hides real load faults — a blocked fetch, a bundler that relocated the module away from its `.wasm`
 * sibling, a CSP that forbids compilation — behind what looks like an ordinary capability miss.
 */
let lastCoreLoadFailure: unknown;

async function hasMp3EncCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./mp3-enc-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

/**
 * Load the vendored LAME wasm core, lazily and at most once per asset URL. Resolves to an
 * {@link Mp3EncWasmCore}, or `null` if the artifact fails to load or reports the wrong MIME type — keeping
 * the driver honest about absence rather than fabricating support. The wasm bytes are addressed via
 * `new URL('./mp3_enc_wasm_bg.wasm', import.meta.url)` so they ship same-origin alongside this chunk; the
 * specifier is a string literal so bundlers code-split it into its own chunk, pulled only on a real MP3
 * encode. Measured to resolve correctly under Vite dev (main thread and module worker) and under a
 * production Rollup build, which emits the core as a hashed asset and rewrites the reference.
 */
export async function loadMp3EncCore(
  runtime?: WasmRuntimeProfile,
  assetBaseUrl?: string,
): Promise<Mp3EncWasmCore | null> {
  const profile = runtime ?? resolveWasmRuntimeProfile();
  const moduleUrl = resolveWasmAssetUrl(
    './mp3_enc_wasm_bg.wasm',
    new URL('./mp3_enc_wasm_bg.wasm', import.meta.url),
    assetBaseUrl,
  );
  const key = `${profile.kind}|${moduleUrl.href}`;
  let corePromise = corePromises.get(key);
  if (corePromise === undefined) {
    corePromise = (async (): Promise<Mp3EncWasmCore | null> => {
      try {
        const mod = await import('./mp3-enc-core.js');
        await mod.default(wasmInitForProfile(moduleUrl, profile));
        const core = mod.createMp3EncCore();
        // The vendored package ships an Ogg core beside the MP3 one; refuse to encode with the wrong wasm.
        if (core.mimeType === MP3_CORE_MIME_TYPE) return core;
        lastCoreLoadFailure = new Error(
          `vendored core reports MIME type '${core.mimeType}', expected '${MP3_CORE_MIME_TYPE}'`,
        );
        return null;
      } catch (error) {
        lastCoreLoadFailure = error; // surfaced through coreMissing()'s cause, never silently dropped
        return null;
      }
    })();
    corePromises.set(key, corePromise);
  }
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetMp3EncCoreForTest(): void {
  corePromises.clear();
  coreGluePromise = undefined;
  lastCoreLoadFailure = undefined;
}

/** The reason the last core load failed, if one did — the cause behind {@link coreMissing}. */
export function mp3EncCoreLoadFailure(): unknown {
  return lastCoreLoadFailure;
}

/**
 * The {@link CapabilityError} the encoder raises when the vendored LAME core is unavailable. When a load
 * was actually attempted and failed, the underlying fault travels as the error's `cause` and in the
 * message, so a blocked fetch or a relocated `.wasm` is diagnosable instead of looking like plain absence.
 */
function coreMissing(): CapabilityError {
  const failure = lastCoreLoadFailure;
  const detail =
    failure === undefined
      ? ''
      : `: ${failure instanceof Error ? failure.message : String(failure)}`;
  return new CapabilityError(`wasm-mp3-enc core is not available${detail}`, {
    op: { kind: 'route', id: 'encode' },
    tried: ['wasm-mp3-enc'],
    suggestion: 'vendor the LAME encoder core per src/codecs/wasm-mp3-enc/BUILD.md',
    ...(failure === undefined ? {} : { cause: failure }),
  });
}

// ============ supports() ============

/**
 * Honest capability probe: an MP3 **encode** query whose config MP3 can actually represent, in a runtime
 * that carries WebCodecs-shaped audio frames and where the vendored glue resolves. Never throws; being
 * `tier:'wasm'` the router only reaches here after the native ladder has missed.
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-mp3-enc handles audio only');
  if (!isMp3Codec(q.config.codec)) {
    return unsupported(`wasm-mp3-enc handles MP3 only, not '${q.config.codec}'`);
  }
  if (q.direction !== 'encode') return unsupported('wasm-mp3-enc encodes only');
  try {
    normalizeMp3EncoderConfig(q.config as AudioEncoderConfig);
  } catch (e: unknown) {
    return unsupported(errMessage(e));
  }
  if (!hasWebCodecsAudioSeam()) {
    return unsupported('wasm-mp3-enc requires WebCodecs AudioData/EncodedAudioChunk');
  }
  if (!(await hasMp3EncCoreGlue())) {
    return unsupported('wasm-mp3-enc core glue is not vendored (see BUILD.md)');
  }
  return { supported: true, hardwareAccelerated: false };
}

// ============ seam narrowing (browser-only types) ============

/* v8 ignore start -- every branch below requires WebCodecs (absent in Node); validated in-browser. */

/** Narrow the raw-frame seam to the audio arm; a `VideoFrame` here is a router/seam bug. */
function asAudioData(frame: RawFrame): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError('encode-error', 'wasm-mp3-enc received a VideoFrame (router/seam mismatch)');
}

/** Copy an `AudioData` out as the planar f32 buffers LAME reads, checking it matches the encoder. */
export function audioDataToPlanes(data: AudioData, init: Mp3EncoderInit): readonly Float32Array[] {
  if (data.sampleRate !== init.sampleRate) {
    throw new MediaError(
      'encode-error',
      `mp3: input sample rate ${data.sampleRate} does not match encoder ${init.sampleRate}`,
    );
  }
  if (data.numberOfChannels !== init.channels) {
    throw new MediaError(
      'encode-error',
      `mp3: input channels ${data.numberOfChannels} do not match encoder ${init.channels}`,
    );
  }
  const frames = data.numberOfFrames;
  const channels = init.channels;
  // Prefer the single interleaved `f32` copy which every WebCodecs AudioData must support;
  // deinterleave into planes for LAME. WebKit rejects per-plane `f32-planar` for
  // interleaved sources and some planar paths have returned swapped channels.
  try {
    const interleaved = new Float32Array(frames * channels);
    data.copyTo(interleaved, { format: 'f32' } as AudioDataCopyToOptions);
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames);
      for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c] as number;
      planes.push(plane);
    }
    validateMp3Planes(planes, frames, channels);
    return planes;
  } catch {
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      planes.push(plane);
    }
    validateMp3Planes(planes, frames, channels);
    return planes;
  }
}

/* v8 ignore stop */

// ============ createDecoder() — honest miss (this tail is encode-only) ============

/** MP3 **decode** belongs to `wasm-mp3` (Symphonia); this tail refuses it rather than duplicate it. */
function createDecoder(
  _config: DecoderConfig,
  _o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  throw new CapabilityError('wasm-mp3-enc is encode-only', {
    op: { kind: 'route', id: 'decode' },
    tried: ['wasm-mp3-enc'],
    suggestion: 'MP3 decode routes through webcodecs-audio, then the wasm-mp3 tail',
  });
}

// ============ createEncoder() ============

/**
 * Build the MP3 **encode** stream: `AudioData` (f32-planar) → `EncodedAudioChunk` (one MPEG frame each).
 * The config is validated eagerly (fail-fast, Node-testable) before any wasm work; the core then loads on
 * `start`. MP3 has no codec-private header, so the published `AudioDecoderConfig` is just the destination
 * geometry — and it is the *normalised* geometry, so a snapped bitrate or rejected rate can never make the
 * muxer's track description disagree with the frames we emit.
 */
function createEncoder(
  config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  const init: Mp3EncoderInit = normalizeMp3EncoderConfig(config as AudioEncoderConfig);
  const onConfig = mp3ConfigSink(o);
  const onTiming = mp3TimingSink(o);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let encoder: Mp3WasmEncoder | undefined;
  let onAbort: (() => void) | undefined;
  const splitter = new Mp3FrameSplitter();
  const framePcmSamples = mp3SamplesPerFrame(init.sampleRate);
  let emittedFrames = 0; // running PTS in whole MPEG frames
  let submittedSamples = 0;

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    encoder?.free();
    encoder = undefined;
  };

  const emitRun = (run: Uint8Array, controller: TransformStreamDefaultController<EncodedChunk>) => {
    for (const frame of splitter.push(run)) {
      controller.enqueue(
        new EncodedAudioChunk({
          type: 'key', // every MPEG Layer-III frame is independently addressable
          timestamp: samplesToMicros(emittedFrames * framePcmSamples, init.sampleRate),
          duration: samplesToMicros(framePcmSamples, init.sampleRate),
          data: frame,
        }),
      );
      emittedFrames++;
    }
  };

  return new TransformStream<RawFrame, EncodedChunk>({
    async start(controller): Promise<void> {
      const core = await loadMp3EncCore(o?.wasmRuntime, o?.wasmAssetBaseUrl);
      if (core === null) {
        controller.error(coreMissing());
        return;
      }
      try {
        encoder = core.createEncoder(buildMp3EncoderParams(init), init.channels);
        onConfig?.({
          codec: MP3_CODEC,
          sampleRate: init.sampleRate,
          numberOfChannels: init.channels,
        });
      } catch (e) {
        controller.error(new MediaError('encode-error', `wasm-mp3-enc init: ${errMessage(e)}`, e));
        return;
      }
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(frame, controller): void {
      const data = asAudioData(frame);
      try {
        const enc = encoder;
        if (!enc) throw new MediaError('encode-error', 'wasm-mp3-enc encoder not configured');
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        const planes = audioDataToPlanes(data, init);
        emitRun(enc.encode(planes, data.numberOfFrames), controller);
        submittedSamples += data.numberOfFrames;
      } catch (e) {
        if (e instanceof MediaError) throw e;
        throw new MediaError('encode-error', `wasm-mp3-enc encode: ${errMessage(e)}`, e);
      } finally {
        data.close();
      }
    },
    flush(controller): void {
      try {
        const enc = encoder;
        if (enc) emitRun(enc.finish(), controller);
        const leftover = splitter.finish();
        if (leftover.length > 0) {
          throw new MediaError(
            'encode-error',
            `wasm-mp3-enc: ${leftover.length} trailing byte(s) do not form an MPEG frame`,
          );
        }
        // Destination gapless facts. LAME's lapped analysis window plus the decoder's synthesis
        // latency put `MP3_ENCODER_LEAD_IN_SAMPLES` of priming ahead of the program, and LAME pads
        // the final frame out to whole-frame geometry; the difference between the coded capacity and
        // (priming + program) is that terminal padding. The muxer trims both — an MP4 `elst`, a
        // Xing/LAME tag in a raw `.mp3` — so a decode of our output is exactly the program back.
        onTiming?.({
          sampleRate: init.sampleRate,
          submittedSamples,
          codedSamples: emittedFrames * framePcmSamples,
          leadingSamples: MP3_ENCODER_LEAD_IN_SAMPLES,
        });
      } catch (e) {
        if (e instanceof MediaError) throw e;
        throw new MediaError('encode-error', `wasm-mp3-enc finish: ${errMessage(e)}`, e);
      } finally {
        teardown();
      }
    },
  });
  /* v8 ignore stop */
}

// ============ driver + module ============

/** The WASM MP3 encoder driver — `tier:'wasm'`, encode-only, vendored LAME core (LGPL, see BUILD.md). */
export const WasmMp3EncoderDriver: CodecDriver = {
  id: 'wasm-mp3-enc',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const WasmMp3EncoderModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmMp3EncoderDriver);
  },
};

export default WasmMp3EncoderModule;
