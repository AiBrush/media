/**
 * The native **FLAC encode** codec driver — `tier:'native'`, pure-TS, miss-only behind WebCodecs (no
 * browser supports FLAC *encode*, so the router falls here after `AudioEncoder.isConfigSupported('flac')`
 * returns false). It re-chunks the engine's arbitrary-length `AudioData` into fixed FLAC blocks and codes
 * each into one native frame via {@link FlacFrameEncoder} (FIXED predictors + partitioned Rice; verbatim
 * fallback), emitting them as `EncodedAudioChunk`s the {@link FlacMuxer} writes. The STREAMINFO prelude is
 * published to the muxer out-of-band via the `onConfig` `StageOptions` hook (mirroring how the AAC encoder
 * surfaces its AudioSpecificConfig); the muxer backfills total samples + frame sizes at finalize.
 *
 * **Shape mirrors {@link import('../../codecs/wasm-opus/wasm-opus-driver.ts')}:** the coder is a
 * `TransformStream` whose lifecycle is the stream — configure on `start`, accumulate+emit on `transform`,
 * drain the final partial block on `flush`. Decode is NOT served here (it stays the container's pure-TS
 * `decodePcm` / the WebCodecs seam), so `supports()` answers `true` only for an encode query.
 *
 * **`AudioData` close-exactly-once (docs/architecture/06 §3):** every input `AudioData` is `close()`d in a
 * `finally` right after its planes are read, so a frame is released even if encoding throws or the stream
 * aborts mid-`transform`. Encoded chunks hold a byte copy (no `close()`), so a dropped chunk just GCs.
 */

import {
  FlacFrameEncoder,
  type FlacStreamConfig,
  streamInfoPrelude,
} from '../../codecs/flac/encode.ts';
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
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';

// ============ pure, Node-testable helpers ============

/** The default FLAC block size (samples/frame) the codec seam re-chunks `AudioData` into. */
export const FLAC_BLOCK_SIZE = 4096 as const;

/** True when a codec string names FLAC (the bare token or any `flac.*` variant). */
export function isFlacCodecString(codec: string): boolean {
  const c = codec.toLowerCase();
  return c === 'flac' || c.startsWith('flac.');
}

/** True when a {@link CodecQuery} asks to ENCODE FLAC audio — the only thing this driver serves. */
export function isFlacEncodeQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.direction === 'encode' && isFlacCodecString(q.config.codec);
}

/**
 * The FLAC bit depth the codec seam quantizes to. WebCodecs audio is float, so the codec-seam FLAC encode
 * targets a fixed integer depth; an integer-format `AudioData` (`s16`/`s32`) keeps its native depth so the
 * encode is bit-exact lossless, while a float source quantizes to 16-bit (the lossy→FLAC archival case,
 * where the source is already lossy). Pure; unit-tested.
 */
export function flacDepthForFormat(format: AudioSampleFormat | null | undefined): number {
  switch (format) {
    case 's16':
    case 's16-planar':
      return 16;
    case 's32':
    case 's32-planar':
      return 32;
    default:
      return 16; // f32/u8 sources → 16-bit archival depth
  }
}

/** The honest unsupported result (non-FLAC, or a decode query this driver does not serve). */
export function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

/** `StageOptions` plus the optional sink the parent passes so the encoder hands the muxer its STREAMINFO. */
export interface FlacEncoderStageOptions extends StageOptions {
  onConfig?(config: AudioDecoderConfig): void;
}

function configSink(
  o: StageOptions | undefined,
): ((config: AudioDecoderConfig) => void) | undefined {
  const sink = (o as FlacEncoderStageOptions | undefined)?.onConfig;
  return typeof sink === 'function' ? sink : undefined;
}

// ============ planar-int block accumulator ============

/**
 * Re-chunks streamed planar integer samples into fixed `blockSize` frames. Unlike the Opus accumulator,
 * the final partial block is emitted at its TRUE length (FLAC's last frame is simply shorter — zero-
 * padding would corrupt the sample count and MD5). Pure data structure; fully Node-testable.
 */
export class PlanarBlockAccumulator {
  readonly #channels: number;
  readonly #blockSize: number;
  #buffers: Int32Array[];
  #count = 0;

  constructor(channels: number, blockSize: number) {
    if (channels < 1) throw new MediaError('encode-error', 'FLAC encode needs ≥1 channel');
    if (blockSize < 1)
      throw new MediaError('encode-error', 'FLAC encode needs a positive block size');
    this.#channels = channels;
    this.#blockSize = blockSize;
    this.#buffers = Array.from({ length: channels }, () => new Int32Array(blockSize));
  }

  /** Append `frames` planar samples (one Int32Array per channel; only `frames` entries are read). */
  push(planes: readonly Int32Array[], frames: number): void {
    for (let written = 0; written < frames; ) {
      const space = this.#blockSize - this.#count;
      const take = Math.min(space, frames - written);
      for (let ch = 0; ch < this.#channels; ch++) {
        const dst = this.#buffers[ch];
        const src = planes[ch];
        if (dst === undefined || src === undefined) continue;
        dst.set(src.subarray(written, written + take), this.#count);
      }
      this.#count += take;
      written += take;
      if (this.#count === this.#blockSize) this.#rotateFull();
    }
  }

  #pending: { planes: Int32Array[]; frames: number }[] = [];

  #rotateFull(): void {
    this.#pending.push({ planes: this.#buffers, frames: this.#blockSize });
    this.#buffers = Array.from({ length: this.#channels }, () => new Int32Array(this.#blockSize));
    this.#count = 0;
  }

  /** Pull the next complete block (planes + frame count), or `undefined` when none is ready. */
  pull(): { planes: Int32Array[]; frames: number } | undefined {
    return this.#pending.shift();
  }

  /** The final partial block at its true length (no padding), or `undefined` when nothing remains. */
  drainFinal(): { planes: Int32Array[]; frames: number } | undefined {
    if (this.#count === 0) return undefined;
    const planes = this.#buffers.map((b) => b.subarray(0, this.#count));
    const frames = this.#count;
    this.#count = 0;
    return { planes, frames };
  }
}

/** Quantize one `AudioData` to planar Int32 at `bits` depth (the FLAC sample domain). Pure given planes. */
export function quantizePlanes(
  planes: readonly Float32Array[],
  frames: number,
  bits: number,
): Int32Array[] {
  const scale = 2 ** (bits - 1);
  const min = -scale;
  const max = scale - 1;
  return planes.map((plane) => {
    const out = new Int32Array(frames);
    for (let i = 0; i < frames; i++) {
      const v = Math.round((plane[i] ?? 0) * scale);
      out[i] = v < min ? min : v > max ? max : v;
    }
    return out;
  });
}

// ============ seam narrowing (browser-only types) ============

/* v8 ignore start -- every branch below requires WebCodecs (absent in Node); validated in-browser. */

/** Narrow the raw-frame seam to the `AudioData` arm; a `VideoFrame` here is a router/seam bug. */
function asAudioData(frame: RawFrame): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError('encode-error', 'flac-encode received a VideoFrame (router/seam mismatch)');
}

/** Read an `AudioData`'s channels as planar f32 (the encoder's pre-quantization layout). */
function audioDataToPlanarF32(data: AudioData): Float32Array[] {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const planes: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames);
    if (frames > 0) data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    planes.push(plane);
  }
  return planes;
}

/** Microseconds for a sample offset at a sample rate (WebCodecs timestamps are µs). */
function samplesToMicros(samples: number, sampleRate: number): number {
  return Math.round((samples / sampleRate) * 1e6);
}

/* v8 ignore stop */

// ============ supports() ============

/**
 * Honest capability probe: serve only an ENCODE query for FLAC audio, and only when the WebCodecs seam
 * types (`AudioData`/`EncodedAudioChunk`) exist to carry the frames. Decode is left to the container's
 * pure-TS `decodePcm` / the WebCodecs seam, so a decode query returns `false`. Never throws (docs 05 §4).
 */
async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('flac-encode handles audio only');
  if (q.direction !== 'encode')
    return unsupported('flac-encode handles encode only (decode is the container/WebCodecs path)');
  if (!isFlacCodecString(q.config.codec)) {
    return unsupported(`flac-encode handles FLAC only, not '${q.config.codec}'`);
  }
  if (typeof AudioData === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    return unsupported('flac-encode requires WebCodecs AudioData/EncodedAudioChunk');
  }
  return Promise.resolve({ supported: true, hardwareAccelerated: false });
}

// ============ createEncoder() ============

/**
 * Build the FLAC **encode** stream: `AudioData` → `EncodedAudioChunk` (native FLAC frames). The encoder
 * configures on `start` (publishing its STREAMINFO prelude to the muxer via `onConfig`), accumulates each
 * input into fixed blocks, codes every full block into one frame, and on `flush` codes the final partial
 * block at its true length. The STREAMINFO MD5 is hashed incrementally over the quantized PCM so the
 * published prelude carries a valid digest. Decode of this output is bit-exact (verified by the container
 * decoder and an independent `flac`/`ffmpeg` CLI in `flac-encode.test.ts`).
 */
function createEncoder(
  config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  const onConfig = configSink(o);
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  const audioConfig = config as AudioEncoderConfig;
  const sampleRate = audioConfig.sampleRate;
  const channels = audioConfig.numberOfChannels;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new MediaError('encode-error', `FLAC encode sample rate ${sampleRate} is invalid`);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new MediaError('encode-error', `FLAC encode channel count ${channels} is invalid`);
  }

  /* v8 ignore start -- requires WebCodecs AudioData/EncodedAudioChunk; validated in-browser + via the muxer test. */
  let depth = 16; // resolved from the first AudioData's format (integer formats stay lossless)
  let configured = false;
  let encoder: FlacFrameEncoder | undefined;
  const acc = new PlanarBlockAccumulator(channels, FLAC_BLOCK_SIZE);
  let emittedSamples = 0;
  let onAbort: (() => void) | undefined;

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
  };

  const ensureConfigured = (format: AudioSampleFormat | null | undefined): FlacStreamConfig => {
    if (!configured) {
      depth = flacDepthForFormat(format);
      const streamConfig: FlacStreamConfig = { sampleRate, channels, bitsPerSample: depth };
      encoder = new FlacFrameEncoder(streamConfig, { compress: true });
      // Publish the STREAMINFO prelude (rate/channels/bits; total samples 0 + MD5 0 = "unknown", which
      // the muxer backfills) so the muxer's addTrack has the codec-private description on the first chunk.
      onConfig?.({
        codec: 'flac',
        sampleRate,
        numberOfChannels: channels,
        description: streamInfoPrelude(streamConfig),
      });
      configured = true;
    }
    const enc = encoder;
    if (!enc) throw new MediaError('encode-error', 'FLAC encoder not configured');
    return enc.config;
  };

  const emitBlock = (
    enc: FlacFrameEncoder,
    block: { planes: Int32Array[]; frames: number },
    controller: TransformStreamDefaultController<EncodedChunk>,
  ): void => {
    const frame = enc.encodeBlock(block.planes, block.frames);
    controller.enqueue(
      new EncodedAudioChunk({
        type: 'key', // every FLAC frame is independently decodable
        timestamp: samplesToMicros(emittedSamples, sampleRate),
        duration: samplesToMicros(block.frames, sampleRate),
        data: frame.data,
      }),
    );
    emittedSamples += block.frames;
  };

  return new TransformStream<RawFrame, EncodedChunk>({
    start(controller): void {
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(frame, controller): void {
      const data = asAudioData(frame);
      try {
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        ensureConfigured(data.format);
        const enc = encoder;
        if (!enc) throw new MediaError('encode-error', 'FLAC encoder not configured');
        const planar = quantizePlanes(audioDataToPlanarF32(data), data.numberOfFrames, depth);
        acc.push(planar, data.numberOfFrames);
        for (let block = acc.pull(); block !== undefined; block = acc.pull()) {
          emitBlock(enc, block, controller);
        }
      } finally {
        data.close(); // close-exactly-once: the encoder owns each input AudioData
      }
    },
    flush(controller): void {
      const enc = encoder;
      if (enc) {
        const tail = acc.drainFinal();
        if (tail) emitBlock(enc, tail, controller); // the final partial block, at its true length
      }
      // STREAMINFO finalization (total samples, frame sizes, and the PCM MD5) is the muxer's job — it
      // backfills them from the buffered frames — so the encoder publishes only the "unknown" prelude.
      teardown();
    },
  });
  /* v8 ignore stop */
}

/** FLAC encode does not decode; the container's `decodePcm` / the WebCodecs seam own decode. */
function createDecoder(
  _config: DecoderConfig,
  _o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  throw new MediaError(
    'capability-miss',
    'flac-encode is an encode-only driver; FLAC decode is the container/WebCodecs path',
  );
}

// ============ driver + module ============

/** The native FLAC encode codec driver — `tier:'native'`, miss-only behind WebCodecs (ADR-085). */
export const FlacCodecDriver: CodecDriver = {
  id: 'flac-encode',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'native',
  supports,
  createDecoder,
  createEncoder,
};

/** The driver module (registered via the first-party defaults or `media.use(...)`). */
export const FlacCodecModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(FlacCodecDriver);
  },
};

export default FlacCodecModule;
