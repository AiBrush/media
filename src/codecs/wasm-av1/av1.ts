/**
 * Pure, Node-testable AV1 helpers for the dav1d WASM fallback decode driver (docs/architecture/04 wasm
 * tier, 05 §CodecDriver). This module owns only deterministic glue: AV1 RFC-6381 codec-string parsing,
 * display-timestamp queueing for reordered/B-frame streams, tightly-packed 4:2:0 plane layout, decoder
 * config normalization, and the narrow dav1d core contract. The lossy AV1 entropy/transform/loop-filter
 * decode belongs to the dav1d core built in `BUILD.md`.
 */

import { MediaError } from '../../contracts/errors.ts';

/** This fallback serves AV1 decode only. */
export type Av1Codec = 'av1';

/** AV1 profile values from the AV1 codec parameter string (`av01.P...`). */
export type Av1Profile = 0 | 1 | 2;

/** AV1 codec-string tier: Main (`M`) or High (`H`). */
export type Av1Tier = 'main' | 'high';

/** Luma/chroma bit depth carried by the AV1 codec string. */
export type Av1BitDepth = 8 | 10 | 12;

/** Chroma sampling shape decoded from the optional AV1 codec-string chroma fields. */
export type Av1ChromaSubsampling = '400' | '420' | '422' | '444';

/** Parsed AV1 codec-string facts used for routing and core initialization. */
export interface Av1CodecInfo {
  codec: Av1Codec;
  profile: Av1Profile;
  level: number;
  tier: Av1Tier;
  bitDepth: Av1BitDepth;
  monochrome: boolean;
  chromaSubsampling: Av1ChromaSubsampling;
}

const AV1_MAX_LEVEL = 31 as const;
const BARE_AV1_DEFAULT: Av1CodecInfo = {
  codec: 'av1',
  profile: 0,
  level: 4,
  tier: 'main',
  bitDepth: 8,
  monochrome: false,
  chromaSubsampling: '420',
};

/** Parse a decimal AV1 codec-string field, rejecting empty/non-numeric input. */
function parseDecimalField(field: string | undefined, name: string): number {
  if (field === undefined || field === '' || !/^\d+$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: codec-string ${name} field '${field}' is not numeric`,
    );
  }
  return Number.parseInt(field, 10);
}

/** Narrow a number to an AV1 profile. */
function asAv1Profile(n: number): Av1Profile | undefined {
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

/** Narrow a number to an AV1 bit depth. */
function asAv1BitDepth(n: number): Av1BitDepth | undefined {
  return n === 8 || n === 10 || n === 12 ? n : undefined;
}

/** Parse the `LLT` field: two decimal level digits plus `M` or `H`. */
function parseLevelTier(field: string | undefined): { level: number; tier: Av1Tier } {
  if (field === undefined || !/^\d{2}[mMhH]$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: codec-string level/tier field '${field}' is malformed`,
    );
  }
  const level = Number.parseInt(field.slice(0, 2), 10);
  if (level < 0 || level > AV1_MAX_LEVEL) {
    throw new MediaError('decode-error', `av1: level ${level} out of range (0–31)`);
  }
  return { level, tier: field.endsWith('H') || field.endsWith('h') ? 'high' : 'main' };
}

/** Parse the optional monochrome flag (`0` or `1`). Absent means colour 4:2:0 for the common strings. */
function parseMonochrome(field: string | undefined): boolean {
  if (field === undefined) return false;
  if (field === '0') return false;
  if (field === '1') return true;
  throw new MediaError('decode-error', `av1: monochrome flag '${field}' must be 0 or 1`);
}

/** Parse the optional AV1 chroma-subsampling triplet (`xyP`), defaulting to colour 4:2:0. */
function parseChromaSubsampling(
  monochrome: boolean,
  field: string | undefined,
): Av1ChromaSubsampling {
  if (monochrome) return '400';
  if (field === undefined) return '420';
  if (!/^[01][01][0-3]$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: chroma-subsampling field '${field}' must be a three-digit xyP code`,
    );
  }
  const subsamplingX = field[0] === '1';
  const subsamplingY = field[1] === '1';
  if (subsamplingX && subsamplingY) return '420';
  if (subsamplingX && !subsamplingY) return '422';
  if (!subsamplingX && !subsamplingY) return '444';
  throw new MediaError('decode-error', `av1: chroma-subsampling field '${field}' is invalid`);
}

/**
 * Parse an AV1 WebCodecs/RFC-6381 codec string. Accepts bare `av1` as the same conservative default the
 * engine uses for Matroska/WebM decode normalization, and qualified `av01.P.LLT.DD[.M.CCC...]` strings.
 */
export function parseAv1Codec(codecRaw: string): Av1CodecInfo {
  const codec = codecRaw.trim().toLowerCase();
  if (codec === 'av1') return { ...BARE_AV1_DEFAULT };
  if (!codec.startsWith('av01.')) {
    throw new MediaError('decode-error', `av1: not an AV1 codec string: '${codecRaw}'`);
  }

  const fields = codec.slice('av01.'.length).split('.');
  const profile = asAv1Profile(parseDecimalField(fields[0], 'profile'));
  if (profile === undefined) {
    throw new MediaError('decode-error', `av1: profile '${fields[0]}' must be 0, 1, or 2`);
  }
  const { level, tier } = parseLevelTier(fields[1]);
  const bitDepth = asAv1BitDepth(parseDecimalField(fields[2], 'bitDepth'));
  if (bitDepth === undefined) {
    throw new MediaError('decode-error', `av1: bit depth '${fields[2]}' must be 8, 10, or 12`);
  }
  const monochrome = parseMonochrome(fields[3]);
  const chromaSubsampling = parseChromaSubsampling(monochrome, fields[4]);

  return { codec: 'av1', profile, level, tier, bitDepth, monochrome, chromaSubsampling };
}

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

/** The narrow synchronous facade the dav1d JS glue must expose after WASM initialization. */
export interface Dav1dWasmCore {
  /** Optional cheap truth predicate for profile/bit-depth/subsampling the compiled core can wrap. */
  supports?(init: Av1DecoderInit): boolean;
  /** Create one stateful dav1d decoder. */
  createDecoder(init: Av1DecoderInit): Dav1dWasmDecoder;
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
