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
 * directory* — inlined into the JS chunk by `libopus-wasm`, so it is same-origin by construction, with no
 * CDN, no COOP/COEP and no sibling `.wasm` to co-vendor — and loaded only when a coder is actually built. `supports()` answers honestly: if the vendored
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
import { resolveWasmRuntimeProfile } from '../../kernel/wasm-runtime.ts';
import {
  FrameAccumulator,
  OPUS_RATE,
  type OpusDecoderInit,
  type OpusEncoderInit,
  type OpusWasmCore,
  type OpusWasmDecoder,
  type OpusWasmEncoder,
  buildOpusHead,
  deinterleaveF32,
  interleaveF32,
  normalizeOpusDecoderConfig,
  normalizeOpusEncoderConfig,
  opusDrainFrameCount,
  packetDurationSamples,
} from './opus.ts';

/**
 * `StageOptions` plus the optional sink the parent passes so the Opus encoder can hand the muxer the
 * {@link AudioDecoderConfig} it produced — notably the **OpusHead** `description` (RFC 7845) carrying the
 * pre-skip, which an Ogg/WebM Opus track needs. Read structurally off the options (a driver-local
 * additive extension), mirroring {@link import('../webcodecs-audio.ts').AudioEncoderStageOptions}.
 */
export interface OpusEncoderStageOptions extends StageOptions {
  onConfig?(config: AudioDecoderConfig): void;
  /** Called once after flush with exact destination-owned sample accounting. */
  onTiming?(timing: AudioEncoderOutputTiming): void;
}

/** Read the optional {@link OpusEncoderStageOptions.onConfig} sink off a `StageOptions` object. */
function opusConfigSink(
  o: StageOptions | undefined,
): ((config: AudioDecoderConfig) => void) | undefined {
  const sink = (o as OpusEncoderStageOptions | undefined)?.onConfig;
  return typeof sink === 'function' ? sink : undefined;
}

/** Read the optional destination-timing sink off the driver-local stage options. */
function opusTimingSink(
  o: StageOptions | undefined,
): ((timing: AudioEncoderOutputTiming) => void) | undefined {
  const sink = (o as OpusEncoderStageOptions | undefined)?.onTiming;
  return typeof sink === 'function' ? sink : undefined;
}

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
 * an init function — a no-op here, since the vendored core carries its own bytes — and it exposes the
 * {@link OpusWasmCore} factory. Typed structurally so
 * the driver compiles before the artifact exists (its shape is declared in `opus-core.d.ts`); the
 * dynamic specifier is a string literal so bundlers code-split it into its own lazy chunk.
 */

/** Memoized core load (one wasm instantiation per session); `null` once we've learned it is unavailable. */
const corePromises = new Map<string, Promise<OpusWasmCore | null>>();
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
 * driver *honest* about wasm absence rather than fabricating support. This is a **self-contained** tail:
 * `libopus-wasm` inlines its wasm into the JS chunk, so there is no sibling `.wasm` asset to address. It
 * previously computed `new URL('./opus_wasm_bg.wasm', import.meta.url)` and handed it to an init that
 * ignores it (see BUILD.md) — a dangling reference to a file this repo has never vendored, which made the
 * loader look like it fetched an asset that does not exist. `assetBaseUrl` is accepted for call-site
 * symmetry with the tails that really do fetch one.
 */
export async function loadOpusCore(
  runtime?: WasmRuntimeProfile,
  assetBaseUrl?: string,
): Promise<OpusWasmCore | null> {
  const profile = runtime ?? resolveWasmRuntimeProfile();
  void assetBaseUrl;
  const key = profile.kind;
  let corePromise = corePromises.get(key);
  if (corePromise === undefined) {
    corePromise = (async (): Promise<OpusWasmCore | null> => {
      try {
        // String-literal specifier → its own code-split chunk; absent until `BUILD.md` is run.
        const mod = await import('./opus-core.js');
        await mod.default();
        return mod.createOpusCore();
      } catch {
        // Not vendored (or failed to instantiate): report absence; the router yields a CapabilityError.
        return null;
      }
    })();
    corePromises.set(key, corePromise);
  }
  return corePromise;
}

/** Reset the memoized core (tests only — lets a suite re-evaluate availability). */
export function resetOpusCoreForTest(): void {
  corePromises.clear();
  coreGluePromise = undefined;
}

/** The {@link CapabilityError} a coder throws when the vendored Opus wasm core is unavailable. */
function coreMissing(op: 'decode' | 'encode'): CapabilityError {
  return new CapabilityError('wasm-opus core is not available (not vendored)', {
    op: { kind: 'route', id: op },
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
  try {
    if (q.direction === 'decode') {
      normalizeOpusDecoderConfig(q.config as AudioDecoderConfig);
    } else {
      normalizeOpusEncoderConfig(q.config as AudioEncoderConfig);
    }
  } catch (e: unknown) {
    return unsupported(errMessage(e));
  }
  if (!(await hasOpusCoreGlue())) {
    return unsupported('wasm-opus core glue is not vendored (see BUILD.md)');
  }
  if (typeof EncodedAudioChunk === 'undefined' || typeof AudioData === 'undefined') {
    return unsupported('wasm-opus requires WebCodecs AudioData/EncodedAudioChunk');
  }
  return { supported: true, hardwareAccelerated: false };
}

function errMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'unsupported Opus config';
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
export function audioDataToInterleaved(data: AudioData): Float32Array {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  // Prefer the single `f32` interleaved copy which every WebCodecs AudioData must support.
  // WebKit rejects per-plane `f32-planar` for interleaved sources and has historically
  // returned swapped channels via the planar path; interleaved keeps the two engines
  // bit-exact without fixture branching.
  try {
    const interleaved = new Float32Array(frames * channels);
    data.copyTo(interleaved, { format: 'f32' } as AudioDataCopyToOptions);
    return interleaved;
  } catch {
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      planes.push(plane);
    }
    return interleaveF32(planes, frames);
  }
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
      const core = await loadOpusCore(o?.wasmRuntime, o?.wasmAssetBaseUrl);
      if (core === null) {
        controller.error(coreMissing('decode'));
        return;
      }
      decoder = await core.createDecoder(init);
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
  const onConfig = opusConfigSink(o);
  const onTiming = opusTimingSink(o);

  /* v8 ignore start -- requires WebCodecs AudioData + the vendored wasm core; validated in-browser. */
  let encoder: OpusWasmEncoder | undefined;
  let onAbort: (() => void) | undefined;
  const acc = new FrameAccumulator(init.channels, init.frameSamples);
  let encodedFrames = 0; // running PTS in input-rate samples
  let submittedSamples = 0;
  let codedSamples = 0;
  let leadingSamples = 0;

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    encoder?.free();
    encoder = undefined;
  };

  const emitFrame = (
    frame: Float32Array,
    controller: TransformStreamDefaultController<EncodedChunk>,
  ): void => {
    const enc = encoder;
    if (!enc) return;
    const bytes = enc.encode(frame);
    controller.enqueue(
      new EncodedAudioChunk({
        type: 'key', // every Opus packet is independently decodable
        timestamp: samplesToMicros(encodedFrames, init.sampleRate),
        // The encoded packet always contains one complete Opus frame. Program-tail padding belongs in
        // the container's gapless metadata; shortening the packet duration as well makes Matroska
        // decoders apply two independent end trims.
        duration: samplesToMicros(init.frameSamples, init.sampleRate),
        data: bytes,
      }),
    );
    encodedFrames += init.frameSamples;
    codedSamples += init.frameSamples;
  };

  const drainTo = (controller: TransformStreamDefaultController<EncodedChunk>): void => {
    for (let frame = acc.pull(); frame !== undefined; frame = acc.pull()) {
      emitFrame(frame, controller);
    }
  };

  return new TransformStream<RawFrame, EncodedChunk>({
    async start(controller): Promise<void> {
      const core = await loadOpusCore(o?.wasmRuntime, o?.wasmAssetBaseUrl);
      if (core === null) {
        controller.error(coreMissing('encode'));
        return;
      }
      encoder = await core.createEncoder(init);
      const preSkipAtInputRate = (encoder.preSkip() * init.sampleRate) / OPUS_RATE;
      if (!Number.isSafeInteger(preSkipAtInputRate) || preSkipAtInputRate < 0) {
        throw new MediaError(
          'encode-error',
          `opus: encoder pre-skip cannot be represented at ${init.sampleRate}Hz`,
        );
      }
      leadingSamples = preSkipAtInputRate;
      // Publish the OpusHead (RFC 7845) so the muxer's track carries the channel count, the real encoder
      // pre-skip (OPUS_GET_LOOKAHEAD), and the input sample rate — the Ogg/WebM Opus codec-private.
      onConfig?.({
        codec: 'opus',
        sampleRate: init.sampleRate,
        numberOfChannels: init.channels,
        description: buildOpusHead(init.channels, encoder.preSkip(), init.sampleRate),
      });
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
        if (data.sampleRate !== init.sampleRate || data.numberOfChannels !== init.channels) {
          throw new MediaError(
            'encode-error',
            `wasm-opus expected ${init.channels}ch at ${init.sampleRate}Hz, got ${data.numberOfChannels}ch at ${data.sampleRate}Hz`,
          );
        }
        if (!Number.isSafeInteger(submittedSamples + data.numberOfFrames)) {
          throw new MediaError('encode-error', 'opus: submitted sample count overflow');
        }
        acc.push(audioDataToInterleaved(data));
        submittedSamples += data.numberOfFrames;
        drainTo(controller);
      } finally {
        data.close(); // close-exactly-once: the encoder owns each input AudioData
      }
    },
    flush(controller): void {
      try {
        if (!encoder) return;
        drainTo(controller); // any whole frames still buffered
        const tail = acc.drainFinal(); // zero-padded final frame, if a partial remains
        if (tail) {
          emitFrame(tail.frame, controller);
        }
        const drainFrames = opusDrainFrameCount(
          submittedSamples,
          codedSamples,
          leadingSamples,
          init.frameSamples,
        );
        for (let i = 0; i < drainFrames; i++) {
          emitFrame(new Float32Array(init.frameSamples * init.channels), controller);
        }
        onTiming?.({ sampleRate: init.sampleRate, submittedSamples, codedSamples, leadingSamples });
      } finally {
        teardown();
      }
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
