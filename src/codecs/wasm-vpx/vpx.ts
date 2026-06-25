/**
 * Pure, Node-testable VP8/VP9 helpers for the WASM fallback **decode** driver (docs/architecture/04 wasm
 * tier, 05 §CodecDriver, ADR-026 — the Opus sibling's decision applies verbatim to video). This module
 * holds the parts of the VPX decode path that are **bit-exact integer logic with a real spec** — the VP8
 * frame tag (RFC 6386 §9.1), the VP9 uncompressed header prefix (VP9 bitstream spec §6.2) and superframe
 * index (Annex B), `vp8`/`vp09.…` codec-string parsing (RFC 6381 / VP-codec ISO-BMFF binding), IVF
 * framing (the de-facto raw VP8/VP9 wrapper), I420/I420P10/I420P12 plane-layout arithmetic, and decoder
 * config validation/normalization — so they are validated in Node without a browser or the wasm core
 * (which carries the lossy DCT/transform/loop-filter decode).
 *
 * The actual entropy-coded pixel decode lives in libvpx compiled to wasm (see `BUILD.md`); this file
 * defines {@link VpxWasmCore}, the narrow contract that wasm glue must satisfy, so the driver skeleton is
 * fully typed against it and the build recipe has a precise target. Everything here is deterministic and
 * falsifiable — no oracle that cannot fail (directive 6).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';

// ============ codecs this driver bridges ============

/** The two VPX video codecs this fallback serves (the WebCodecs gap is VP9; VP8 rides along). */
export type VpxCodec = 'vp8' | 'vp9';

/** Maximum VP9 profile (0–3); profile selects bit depth and chroma subsampling (VP9 spec §7.2.2). */
export const VP9_MAX_PROFILE = 3 as const;

// ============ codec-string parsing (RFC 6381 / VP9 ISO-BMFF binding) ============

/**
 * What a VP8/VP9 codec string tells the driver about the *output* frame layout. VP8 is always profile-0
 * 8-bit 4:2:0. VP9's `vp09.PP.LL.DD[.CC…]` carries profile (PP), level (LL), bit depth (DD), and an
 * optional chroma-subsampling code (CC). The wasm core re-derives all of this from the bitstream, but we
 * parse the string to (a) route to the right driver and (b) pre-size buffers / validate before any decode.
 */
export interface VpxCodecInfo {
  codec: VpxCodec;
  /** VP9 profile 0–3 (always 0 for VP8). */
  profile: number;
  /** Luma/chroma bit depth: 8 for VP8 and VP9 profiles 0/1; 8/10/12 for VP9 (from the `DD` field). */
  bitDepth: 8 | 10 | 12;
  /**
   * Chroma subsampling code (ISO VP-codec binding, same numbering as VP9's `subsampling_x/y`):
   * 0 → 4:2:0 colocated, 1 → 4:2:0, 2 → 4:2:2, 3 → 4:4:4. VP8 is always 4:2:0 (1). When the codec string
   * omits it (the common `vp09.PP.LL.DD` form), it defaults to 1 (4:2:0), the VP9 binding's default.
   */
  subsampling: 0 | 1 | 2 | 3;
}

/** Narrow an arbitrary number to a supported VPX bit depth, or `undefined`. */
function asBitDepth(n: number): 8 | 10 | 12 | undefined {
  return n === 8 || n === 10 || n === 12 ? n : undefined;
}

/** Narrow an arbitrary number to a chroma-subsampling code (0–3), or `undefined`. */
function asSubsampling(n: number): 0 | 1 | 2 | 3 | undefined {
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : undefined;
}

/**
 * Parse a WebCodecs/RFC-6381 VP8 or VP9 codec string into {@link VpxCodecInfo}. Accepts:
 *  - `vp8` → profile 0, 8-bit, 4:2:0.
 *  - `vp9` (bare, legacy) → profile 0, 8-bit, 4:2:0.
 *  - `vp09.PP.LL.DD` and `vp09.PP.LL.DD.CC.…` → fields parsed per the VP9 ISO-BMFF binding; only the
 *    leading PP/LL/DD/CC fields are significant to us (the rest — colour primaries/transfer/matrix/range —
 *    do not change the plane geometry the driver allocates).
 * A malformed string is a typed {@link MediaError} (`decode-error`) — never a silently-wrong layout.
 */
export function parseVpxCodec(codecRaw: string): VpxCodecInfo {
  const codec = codecRaw.trim().toLowerCase();
  if (codec === 'vp8') return { codec: 'vp8', profile: 0, bitDepth: 8, subsampling: 1 };
  if (codec === 'vp9') return { codec: 'vp9', profile: 0, bitDepth: 8, subsampling: 1 };
  if (!codec.startsWith('vp09.')) {
    throw new MediaError('decode-error', `vpx: not a VP8/VP9 codec string: '${codecRaw}'`);
  }
  const fields = codec.slice('vp09.'.length).split('.');
  const profile = parseDecimalField(fields[0], 'profile');
  if (profile < 0 || profile > VP9_MAX_PROFILE) {
    throw new MediaError('decode-error', `vpx: VP9 profile ${profile} out of range (0–3)`);
  }
  // Level (fields[1]) does not affect plane geometry; we validate it is present and numeric but ignore it.
  parseDecimalField(fields[1], 'level');
  const bitDepth = asBitDepth(parseDecimalField(fields[2], 'bitDepth'));
  if (bitDepth === undefined) {
    throw new MediaError('decode-error', `vpx: VP9 bit depth '${fields[2]}' must be 8, 10, or 12`);
  }
  // Profile 0 & 2 are 4:2:0 only; the binding still lets CC be stated. Default to 4:2:0 when omitted.
  const subsampling =
    fields[3] === undefined ? 1 : asSubsampling(parseDecimalField(fields[3], 'subsampling'));
  if (subsampling === undefined) {
    throw new MediaError('decode-error', `vpx: VP9 chroma subsampling '${fields[3]}' must be 0–3`);
  }
  return { codec: 'vp9', profile, bitDepth, subsampling };
}

/** Parse a zero-padded decimal codec-string field (e.g. `'02'`), rejecting non-numeric/empty input. */
function parseDecimalField(field: string | undefined, name: string): number {
  if (field === undefined || field === '' || !/^\d+$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `vpx: codec-string ${name} field '${field}' is not numeric`,
    );
  }
  return Number.parseInt(field, 10);
}

// ============ VP8 frame tag (RFC 6386 §9.1) ============

/** Decoded fields of a VP8 frame's 3-byte uncompressed tag (RFC 6386 §9.1) + keyframe dimensions. */
export interface Vp8FrameInfo {
  keyFrame: boolean;
  /** VP8 version (0–3): selects the reconstruction/loop filters; informational here. */
  version: number;
  /** `show_frame` flag — VP8 frames are normally shown (alt-ref-style hidden frames are VP9-only). */
  showFrame: boolean;
  /** Size of the first (control) partition, in bytes (RFC 6386 §9.1). */
  firstPartitionSize: number;
  /** Frame width in pixels (keyframes only; `undefined` for inter frames, which inherit dims). */
  width?: number;
  /** Frame height in pixels (keyframes only). */
  height?: number;
}

const VP8_KEYFRAME_START_CODE = [0x9d, 0x01, 0x2a] as const; // RFC 6386 §9.1, after the 3-byte tag

/**
 * Parse a VP8 frame's uncompressed tag (RFC 6386 §9.1). The first 3 bytes are a little-endian 24-bit
 * value: bit 0 is `key_frame` **inverted** (0 ⇒ key), bits 1–3 `version`, bit 4 `show_frame`, bits 5–23
 * `first_part_size`. A keyframe then carries the start code `9d 01 2a` and 14-bit width/height (each with
 * a 2-bit upscale code in the top bits, which does not change the coded dimension). A short packet is
 * rejected as malformed input. Used to validate/route and to size keyframe output; the pixel decode is the
 * wasm core's job.
 */
export function parseVp8FrameInfo(packet: Uint8Array): Vp8FrameInfo {
  const b0 = packet[0];
  const b1 = packet[1];
  const b2 = packet[2];
  if (b0 === undefined || b1 === undefined || b2 === undefined) {
    throw new InputError('unsupported-input', 'vpx: VP8 frame shorter than its 3-byte tag');
  }
  const tag = b0 | (b1 << 8) | (b2 << 16);
  const keyFrame = (tag & 0x1) === 0; // inverted: 0 ⇒ key frame
  const info: Vp8FrameInfo = {
    keyFrame,
    version: (tag >> 1) & 0x7,
    showFrame: ((tag >> 4) & 0x1) === 1,
    firstPartitionSize: (tag >> 5) & 0x7ffff,
  };
  if (!keyFrame) return info; // inter frames inherit the keyframe's dimensions
  for (let i = 0; i < VP8_KEYFRAME_START_CODE.length; i++) {
    if (packet[3 + i] !== VP8_KEYFRAME_START_CODE[i]) {
      throw new InputError('unsupported-input', 'vpx: VP8 keyframe missing the 9d012a start code');
    }
  }
  const wLo = packet[6];
  const wHi = packet[7];
  const hLo = packet[8];
  const hHi = packet[9];
  if (wLo === undefined || wHi === undefined || hLo === undefined || hHi === undefined) {
    throw new InputError('unsupported-input', 'vpx: VP8 keyframe truncated before dimensions');
  }
  info.width = (wLo | (wHi << 8)) & 0x3fff; // low 14 bits; top 2 are the horizontal scale
  info.height = (hLo | (hHi << 8)) & 0x3fff; // low 14 bits; top 2 are the vertical scale
  return info;
}

// ============ VP9 uncompressed header prefix (VP9 bitstream spec §6.2) ============

/** A minimal MSB-first bit reader over a byte slice (VP9 reads the uncompressed header big-endian). */
class BitReader {
  readonly #bytes: Uint8Array;
  #bitPos = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Read one bit (MSB-first); throws if the slice is exhausted (a truncated header is malformed input). */
  readBit(): number {
    const byteIndex = this.#bitPos >> 3;
    const byte = this.#bytes[byteIndex];
    if (byte === undefined) {
      throw new InputError('unsupported-input', 'vpx: VP9 header truncated (out of bits)');
    }
    const bit = (byte >> (7 - (this.#bitPos & 0x7))) & 0x1;
    this.#bitPos++;
    return bit;
  }

  /** Read `n` bits (MSB-first) into an unsigned integer (n ≤ 31 for safe bit-ops). */
  readBits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | this.readBit();
    return value >>> 0;
  }
}

/** Decoded prefix of a VP9 frame's uncompressed header (VP9 bitstream spec §6.2). */
export interface Vp9FrameInfo {
  /** VP9 profile 0–3, from `profile_low_bit`/`profile_high_bit` (§7.2). */
  profile: number;
  /** `show_existing_frame` — when true the frame just re-displays a reference; no new decode output. */
  showExistingFrame: boolean;
  /** True for a key frame (`frame_type == 0`); `undefined` when `show_existing_frame` short-circuits. */
  keyFrame?: boolean;
  /** `show_frame` — false for non-displayed (alt-ref) frames; `undefined` under `show_existing_frame`. */
  showFrame?: boolean;
}

const VP9_FRAME_MARKER = 0b10; // §6.2: the header opens with this 2-bit marker

/**
 * Parse the prefix of a VP9 frame's uncompressed header (VP9 bitstream spec §6.2): the 2-bit
 * `frame_marker` (must be `0b10`), the profile (low+high bits, plus a reserved bit at profile 3),
 * `show_existing_frame`, and — when not short-circuited — `frame_type` and `show_frame`. This is enough to
 * decide whether a frame produces a displayed output (the driver only enqueues a `VideoFrame` for shown
 * frames) and to assert key-frame placement. Full dimension/colour parsing is left to the wasm core, which
 * reports the decoded frame's geometry. A bad marker or truncation is typed malformed input.
 */
export function parseVp9FrameInfo(packet: Uint8Array): Vp9FrameInfo {
  const r = new BitReader(packet);
  if (r.readBits(2) !== VP9_FRAME_MARKER) {
    throw new InputError('unsupported-input', 'vpx: VP9 frame_marker is not 0b10');
  }
  const profileLow = r.readBit();
  const profileHigh = r.readBit();
  const profile = (profileHigh << 1) | profileLow;
  if (profile === 3) r.readBit(); // §7.2: reserved_zero bit follows profile 3
  const showExistingFrame = r.readBit() === 1;
  if (showExistingFrame) {
    r.readBits(3); // frame_to_show_map_idx — consumed for completeness; the frame emits no new output
    return { profile, showExistingFrame: true };
  }
  const keyFrame = r.readBit() === 0; // frame_type: 0 ⇒ key frame
  const showFrame = r.readBit() === 1;
  return { profile, showExistingFrame: false, keyFrame, showFrame };
}

// ============ VP9 superframe index (VP9 spec Annex B) ============

/** A parsed VP9 superframe: the byte ranges of each sub-frame within one packet (Annex B). */
export interface Superframe {
  /** `[offset, length]` of each coded sub-frame, in order, within the packet (excludes the index bytes). */
  frames: ReadonlyArray<readonly [offset: number, length: number]>;
}

const VP9_SUPERFRAME_MARKER = 0b110; // top 3 bits of the index's first/last byte (§Annex B)

/**
 * Split a VP9 packet into its constituent coded frames per the superframe index (VP9 spec Annex B). A
 * superframe bundles several coded frames (commonly a hidden alt-ref + the shown frame) into one sample;
 * the index lives in the trailing bytes. When the last byte's top 3 bits are `0b110` it is a superframe
 * marker: `bytes_per_framesize = ((b>>3)&3)+1`, `frames_in_superframe = (b&7)+1`, the index is
 * `2 + frames*bytes_per_framesize` bytes with the same marker at both ends, and each frame size is stored
 * little-endian. A packet without the marker is a single frame spanning the whole buffer. The result lets
 * the driver advance the presentation clock per displayed sub-frame even though the wasm core decodes the
 * packet as a unit. Pure arithmetic — fully Node-testable; a malformed index is typed input error.
 */
export function parseSuperframeIndex(packet: Uint8Array): Superframe {
  const n = packet.length;
  const last = packet[n - 1];
  if (n === 0 || last === undefined || last >> 5 !== VP9_SUPERFRAME_MARKER) {
    return { frames: [[0, n]] }; // not a superframe: one frame over the whole packet
  }
  const bytesPerFrameSize = ((last >> 3) & 0x3) + 1;
  const framesInSuperframe = (last & 0x7) + 1;
  const indexSize = 2 + framesInSuperframe * bytesPerFrameSize;
  if (indexSize > n) {
    throw new InputError('unsupported-input', 'vpx: VP9 superframe index larger than the packet');
  }
  const indexStart = n - indexSize;
  if (packet[indexStart] !== last) {
    // The marker byte must be identical at both ends of the index (Annex B); otherwise the trailing byte
    // coincidentally matched the marker pattern but is real frame data → treat as a single frame.
    return { frames: [[0, n]] };
  }
  const frames: Array<readonly [number, number]> = [];
  let offset = 0;
  let cursor = indexStart + 1;
  for (let f = 0; f < framesInSuperframe; f++) {
    let size = 0;
    for (let i = 0; i < bytesPerFrameSize; i++) {
      const byte = packet[cursor++];
      if (byte === undefined) {
        throw new InputError('unsupported-input', 'vpx: VP9 superframe index truncated');
      }
      size |= byte << (8 * i); // little-endian frame size
    }
    if (offset + size > indexStart) {
      throw new InputError('unsupported-input', 'vpx: VP9 superframe sizes overrun the packet');
    }
    frames.push([offset, size]);
    offset += size;
  }
  return { frames };
}

// ============ IVF framing (the de-facto raw VP8/VP9 wrapper) ============

/** Decoded IVF file header (the 32-byte `DKIF` header that opens a raw VP8/VP9 `.ivf` stream). */
export interface IvfHeader {
  codec: VpxCodec;
  width: number;
  height: number;
  /** Timebase numerator/denominator: a frame's timestamp × (num/den) seconds gives its presentation time. */
  timebaseNum: number;
  timebaseDen: number;
  /** Declared frame count (informational; may be 0 for live captures). */
  frameCount: number;
  /** Byte length of the header (almost always 32). */
  headerSize: number;
}

const IVF_MAGIC = [0x44, 0x4b, 0x49, 0x46] as const; // "DKIF"
const IVF_FILE_HEADER_MIN = 32 as const;
const IVF_FRAME_HEADER_SIZE = 12 as const;

/** Read a little-endian unsigned 16-bit value at `off` (throws on truncation). */
function readU16LE(bytes: Uint8Array, off: number): number {
  const a = bytes[off];
  const b = bytes[off + 1];
  if (a === undefined || b === undefined) {
    throw new InputError('unsupported-input', `vpx: IVF truncated reading u16 at ${off}`);
  }
  return a | (b << 8);
}

/** Read a little-endian unsigned 32-bit value at `off` (throws on truncation). */
function readU32LE(bytes: Uint8Array, off: number): number {
  const a = bytes[off];
  const b = bytes[off + 1];
  const c = bytes[off + 2];
  const d = bytes[off + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new InputError('unsupported-input', `vpx: IVF truncated reading u32 at ${off}`);
  }
  return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
}

/** Map an IVF FourCC to a {@link VpxCodec}; `undefined` for anything but `VP80`/`VP90`. */
function ivfFourCcToCodec(bytes: Uint8Array): VpxCodec | undefined {
  const fourcc = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  if (fourcc === 'VP80') return 'vp8';
  if (fourcc === 'VP90') return 'vp9';
  return undefined;
}

/**
 * Parse the 32-byte IVF file header (the raw VP8/VP9 wrapper test fixtures ship in). Layout (all
 * little-endian): `DKIF`(4) magic, version u16, header-size u16, FourCC(4) `VP80`/`VP90`, width u16,
 * height u16, timebase-denominator u32, timebase-numerator u32, frame-count u32, then 4 unused bytes. A
 * non-`DKIF` head or an unknown codec FourCC is typed malformed input. Used by tests/tools to iterate raw
 * VPX frames deterministically without a browser; the live path receives demuxed WebCodecs chunks instead.
 */
export function parseIvfHeader(bytes: Uint8Array): IvfHeader {
  if (bytes.length < IVF_FILE_HEADER_MIN) {
    throw new InputError('unsupported-input', 'vpx: IVF header shorter than 32 bytes');
  }
  for (let i = 0; i < IVF_MAGIC.length; i++) {
    if (bytes[i] !== IVF_MAGIC[i]) {
      throw new InputError('unsupported-input', 'vpx: not an IVF stream (missing DKIF magic)');
    }
  }
  const codec = ivfFourCcToCodec(bytes);
  if (codec === undefined) {
    throw new InputError('unsupported-input', 'vpx: IVF FourCC is not VP80/VP90');
  }
  return {
    codec,
    headerSize: readU16LE(bytes, 6),
    width: readU16LE(bytes, 12),
    height: readU16LE(bytes, 14),
    timebaseDen: readU32LE(bytes, 16),
    timebaseNum: readU32LE(bytes, 20),
    frameCount: readU32LE(bytes, 24),
  };
}

/** One IVF frame: its declared timestamp (in timebase units) and a view of its coded payload. */
export interface IvfFrame {
  timestamp: number;
  data: Uint8Array;
}

/**
 * Iterate the frames of an IVF stream: after the file header, each frame is a 12-byte header (size u32 LE,
 * timestamp u64 LE) followed by `size` payload bytes. Yields a zero-copy `subarray` view per frame.
 * Timestamps are kept as numbers (frame counts × timebase fit comfortably in a double for any real clip).
 * A header that runs past the buffer is typed malformed input. Generator so callers stream without
 * materialising every frame; pure and Node-testable end-to-end on a real `.ivf` fixture.
 */
export function* iterateIvfFrames(bytes: Uint8Array): Generator<IvfFrame, void, unknown> {
  const header = parseIvfHeader(bytes);
  let pos = Math.max(header.headerSize, IVF_FILE_HEADER_MIN);
  while (pos + IVF_FRAME_HEADER_SIZE <= bytes.length) {
    const size = readU32LE(bytes, pos);
    // u64 timestamp little-endian; real clips never exceed 2^53 frames, so combine the two u32 halves.
    const tsLo = readU32LE(bytes, pos + 4);
    const tsHi = readU32LE(bytes, pos + 8);
    const timestamp = tsHi * 0x1_0000_0000 + tsLo;
    const start = pos + IVF_FRAME_HEADER_SIZE;
    const end = start + size;
    if (end > bytes.length) {
      throw new InputError('unsupported-input', 'vpx: IVF frame runs past end of stream');
    }
    yield { timestamp, data: bytes.subarray(start, end) };
    pos = end;
  }
}

// ============ I420 / I420P10 / I420P12 plane layout ============

/** The WebCodecs `VideoPixelFormat`s this decoder can emit (4:2:0, the only VP8/profile-0/2 layout). */
export type VpxPixelFormat = 'I420' | 'I420P10' | 'I420P12';

/** A planar frame's per-plane byte offsets/strides + total size — what a `VideoFrame` `BufferInit` needs. */
export interface PlaneLayout {
  format: VpxPixelFormat;
  codedWidth: number;
  codedHeight: number;
  /** Per-plane `{ offset, stride }` (Y, U, V) into one contiguous buffer, in bytes. */
  planes: ReadonlyArray<{ offset: number; stride: number }>;
  /** Total contiguous buffer size in bytes (sum of the three planes). */
  byteLength: number;
}

/** The WebCodecs pixel format for a VPX bit depth (4:2:0 only — VP8 and VP9 profiles 0/2). */
export function pixelFormatForBitDepth(bitDepth: 8 | 10 | 12): VpxPixelFormat {
  switch (bitDepth) {
    case 8:
      return 'I420';
    case 10:
      return 'I420P10';
    case 12:
      return 'I420P12';
    /* v8 ignore next 2 -- the union is exhaustive; satisfies the checker. */
    default:
      return bitDepth;
  }
}

/**
 * Compute the tightly-packed I420 (or I420P10/P12) plane layout for a coded frame: Y is `width × height`,
 * U and V are each `ceil(width/2) × ceil(height/2)` (4:2:0), every sample widening to 2 bytes above 8-bit.
 * Strides equal the per-plane widths (no padding — the wasm core returns tightly packed planes and the
 * `VideoFrame` `BufferInit` carries explicit strides). Rejects non-positive dimensions (a decode that
 * yields a 0-dimension frame is a core/bitstream bug). This is what the driver hands `new VideoFrame(buf,
 * { format, codedWidth, codedHeight, layout })`.
 */
export function planeLayoutI420(width: number, height: number, bitDepth: 8 | 10 | 12): PlaneLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MediaError('decode-error', `vpx: invalid decoded dimensions ${width}×${height}`);
  }
  const bytesPerSample = bitDepth === 8 ? 1 : 2;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const yStride = width * bytesPerSample;
  const cStride = chromaWidth * bytesPerSample;
  const ySize = yStride * height;
  const cSize = cStride * chromaHeight;
  return {
    format: pixelFormatForBitDepth(bitDepth),
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

// ============ decoder config validation / normalization ============

/** A validated, wasm-core-ready VPX decoder configuration (derived from {@link VideoDecoderConfig}). */
export interface VpxDecoderInit {
  codec: VpxCodec;
  /** VP9 profile 0–3 (0 for VP8). */
  profile: number;
  bitDepth: 8 | 10 | 12;
  /** Coded width hint from the config, when present (the bitstream is authoritative for actual dims). */
  codedWidth?: number;
  codedHeight?: number;
}

/**
 * Validate + normalize a {@link VideoDecoderConfig} for the VPX wasm decoder. Enforces a VP8/VP9 codec id
 * (via {@link parseVpxCodec}) and carries the parsed profile/bit-depth plus any coded-dimension hints. A
 * bad config is a typed {@link MediaError} (`decode-error`) — never a silent wrong-codec decode. Mirrors
 * the Opus driver's `normalizeOpusDecoderConfig` shape so the two fallbacks read identically.
 */
export function normalizeVpxDecoderConfig(config: VideoDecoderConfig): VpxDecoderInit {
  const info = parseVpxCodec(config.codec);
  const init: VpxDecoderInit = {
    codec: info.codec,
    profile: info.profile,
    bitDepth: info.bitDepth,
  };
  // `codedWidth`/`codedHeight` are optional in the config; only carry them when both are valid positives
  // (exactOptionalPropertyTypes: omit rather than assign `undefined`).
  const { codedWidth, codedHeight } = config;
  if (
    typeof codedWidth === 'number' &&
    typeof codedHeight === 'number' &&
    codedWidth > 0 &&
    codedHeight > 0
  ) {
    init.codedWidth = codedWidth;
    init.codedHeight = codedHeight;
  }
  return init;
}

// ============ the wasm-core contract (what BUILD.md must produce) ============

/** One decoded VPX frame as the wasm core hands it back: tightly-packed planar pixels + their geometry. */
export interface VpxDecodedFrame {
  /** Coded width/height the bitstream produced (authoritative over the config hint). */
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  /**
   * Tightly-packed 4:2:0 planes in one contiguous buffer (Y then U then V), laid out exactly as
   * {@link planeLayoutI420} describes for `(width, height, bitDepth)`. The driver wraps this directly in a
   * `VideoFrame` `BufferInit` — no copy beyond what `VideoFrame` itself takes.
   */
  data: Uint8Array;
}

/**
 * The narrow, synchronous surface the libvpx-in-wasm glue must expose for the driver to drive it (see
 * `BUILD.md`). Deliberately tiny — one decoder object holding native (wasm-heap) state — so the JS glue
 * produced by `wasm-pack build --target web` (Recipe B) or an Emscripten `cwrap` shim (Recipe A) maps to
 * it directly. Decode-only: VP9 *encode* is out of WebCodecs' gap and out of this fallback's scope.
 *
 * Lifetime: the driver constructs exactly one {@link VpxWasmDecoder} per stream and calls `free()` once on
 * teardown (cancel, flush, or error); the wasm module owns the heap buffers.
 */
export interface VpxWasmCore {
  /** Create a libvpx decoder (`vpx_codec_dec_init` with the VP8 or VP9 interface) for the validated init. */
  createDecoder(init: VpxDecoderInit): VpxWasmDecoder;
}

/** A live libvpx decoder: feed coded VP8/VP9 packets, pull decoded 4:2:0 frames. */
export interface VpxWasmDecoder {
  /**
   * Decode one coded packet (`vpx_codec_decode`) and return every **displayable** frame it produced, in
   * order (`vpx_codec_get_frame` drained to completion). A packet may yield zero frames (a hidden alt-ref
   * with no shown frame) or several (a superframe). Each returned frame's planes are tightly packed per
   * {@link planeLayoutI420}. The driver pairs these with timestamps it derives from the chunk/superframe.
   */
  decode(packet: Uint8Array): VpxDecodedFrame[];
  /** Release the native decoder (`vpx_codec_destroy`). Idempotent. */
  free(): void;
}
