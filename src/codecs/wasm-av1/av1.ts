/**
 * Pure, Node-testable AV1 helpers for the dav1d WASM fallback decode driver (docs/architecture/04 wasm
 * tier, 05 §CodecDriver). This module owns only deterministic glue: AV1 RFC-6381 codec-string parsing,
 * display-timestamp queueing for reordered/B-frame streams, tightly-packed 4:2:0 plane layout, decoder
 * config normalization, and the narrow dav1d core contract. The lossy AV1 entropy/transform/loop-filter
 * decode belongs to the dav1d core built in `BUILD.md`.
 */

import { MediaError } from '../../contracts/errors.ts';
import { type Av1BitDepth, type Av1CodecInfo, parseAv1Codec } from '../av1-codec-string.ts';

export { parseAv1Codec };
export type {
  Av1BitDepth,
  Av1ChromaSubsampling,
  Av1Codec,
  Av1CodecInfo,
  Av1Profile,
  Av1Tier,
} from '../av1-codec-string.ts';

/** A queued input access unit's display timestamp facts (WebCodecs timestamps are microseconds). */
export interface DisplayTimestamp {
  timestampUs: number;
  durationUs: number | null;
}

/**
 * Insert an access unit's presentation timestamp into the pending display queue. AV1 can output frames
 * after reordering, so the driver assigns timestamps in presentation order by taking the lowest queued PTS
 * for each displayed frame dav1d returns.
 */
export function pushDisplayTimestamp(queue: DisplayTimestamp[], timestamp: DisplayTimestamp): void {
  queue.push(timestamp);
  queue.sort((a, b) => a.timestampUs - b.timestampUs);
}

/** Pop the next display timestamp, if the decoder emitted a shown frame. */
export function shiftDisplayTimestamp(queue: DisplayTimestamp[]): DisplayTimestamp | undefined {
  return queue.shift();
}

/** The WebCodecs `VideoPixelFormat`s this scaffold can wrap from dav1d's 4:2:0 output. */
export type Av1PixelFormat = 'I420' | 'I420P10' | 'I420P12';

/** A planar frame layout for `VideoFrame(BufferInit)`. */
export interface PlaneLayout {
  format: Av1PixelFormat;
  codedWidth: number;
  codedHeight: number;
  planes: ReadonlyArray<{ offset: number; stride: number }>;
  byteLength: number;
}

/** Map AV1 bit depth to the WebCodecs 4:2:0 pixel format. */
export function pixelFormatForAv1BitDepth(bitDepth: Av1BitDepth): Av1PixelFormat {
  switch (bitDepth) {
    case 8:
      return 'I420';
    case 10:
      return 'I420P10';
    case 12:
      return 'I420P12';
    /* v8 ignore next 2 -- the union is exhaustive. */
    default:
      return bitDepth;
  }
}

/**
 * Compute a tightly-packed 4:2:0 layout (Y, U, V) for dav1d output. Odd dimensions round chroma up; 10/12
 * bit samples use two bytes each. Non-4:2:0 AV1 profiles must be converted by the core before reaching
 * this wrapper, or declined by the core's support predicate.
 */
export function planeLayoutI420(width: number, height: number, bitDepth: Av1BitDepth): PlaneLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MediaError('decode-error', `av1: invalid decoded dimensions ${width}×${height}`);
  }
  const bytesPerSample = bitDepth === 8 ? 1 : 2;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const yStride = width * bytesPerSample;
  const cStride = chromaWidth * bytesPerSample;
  const ySize = yStride * height;
  const cSize = cStride * chromaHeight;
  return {
    format: pixelFormatForAv1BitDepth(bitDepth),
    codedWidth: width,
    codedHeight: height,
    planes: [
      { offset: 0, stride: yStride },
      { offset: ySize, stride: cStride },
      { offset: ySize + cSize, stride: cStride },
    ],
    byteLength: ySize + 2 * cSize,
  };
}

/** A validated dav1d decoder configuration derived from `VideoDecoderConfig`. */
export interface Av1DecoderInit extends Av1CodecInfo {
  codedWidth?: number;
  codedHeight?: number;
  description?: Uint8Array;
}

/** Read-only byte view over a WebCodecs description. */
function bufferSourceBytes(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src).slice();
  const view = src as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/** Validate and normalize a `VideoDecoderConfig` for the dav1d core. */
export function normalizeAv1DecoderConfig(config: VideoDecoderConfig): Av1DecoderInit {
  const info = parseAv1Codec(config.codec);
  const init: Av1DecoderInit = { ...info };
  const { codedWidth, codedHeight, description } = config;
  if (
    typeof codedWidth === 'number' &&
    typeof codedHeight === 'number' &&
    codedWidth > 0 &&
    codedHeight > 0
  ) {
    init.codedWidth = codedWidth;
    init.codedHeight = codedHeight;
  }
  if (description !== undefined) init.description = bufferSourceBytes(description);
  return init;
}

/** One dav1d-decoded display frame as tightly-packed 4:2:0 planar bytes. */
export interface Av1DecodedFrame {
  width: number;
  height: number;
  bitDepth: Av1BitDepth;
  data: Uint8Array;
}

/** The narrow facade the dav1d JS glue must expose after WASM initialization. */
export interface Dav1dWasmCore {
  /** Optional cheap truth predicate for profile/bit-depth/subsampling the compiled core can wrap. */
  supports?(init: Av1DecoderInit): boolean;
  /**
   * Create one stateful dav1d decoder. Async because the vendored prebuilt core (`dav1d.js`)
   * instantiates its wasm per decoder; the driver `await`s it in its async `start`. The returned
   * decoder's `decode` is synchronous (the hot path).
   */
  createDecoder(init: Av1DecoderInit): Promise<Dav1dWasmDecoder>;
}

/** A live dav1d decoder. */
export interface Dav1dWasmDecoder {
  /**
   * Feed one coded AV1 access unit and return every displayed frame dav1d releases, in presentation order.
   * Reordered/B-frame streams may return zero frames until enough future input arrives.
   */
  decode(packet: Uint8Array): Av1DecodedFrame[];
  /** Drain delayed display frames on writable close. */
  flush?(): Av1DecodedFrame[];
  /** Release native decoder state. Idempotent. */
  free(): void;
}
