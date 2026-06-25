/**
 * Pure-TS still/animated **image probe** — magic-byte format detection plus a from-scratch container
 * parse that yields the dimensions, frame count, animation flag, bit depth/colour descriptor, and loop
 * count for GIF, PNG/APNG, JPEG, WebP, and AVIF. These bitstreams are integer, self-describing headers,
 * so the probe is **bit-exact and Node-validatable** without a browser or WASM toolchain — the
 * un-fakeable oracle is "frame count + dimensions match the real file" (BUILD §6.2; ADR-025 Node tier).
 *
 * Scope: this is the *header* parser only — it never decodes pixels (that is {@link ./decode.ts}, behind
 * the browser-only WebCodecs `ImageDecoder`). It parses just enough structure to count frames and read
 * the canvas geometry: GIF block walk (Image Descriptors + NETSCAPE2.0 loop), PNG chunk walk (IHDR +
 * `acTL`), JPEG marker walk (SOFn), WebP RIFF chunk walk (VP8/VP8L/VP8X + ANMF/ANIM), and the ISO-BMFF
 * box tree for AVIF (`ftyp` brand + `ispe` + `av1C` depth, and `stsz` sample count for `avis` sequences).
 *
 * Robustness: a truncated/garbled header rejects with a typed {@link InputError} rather than crashing or
 * fabricating a number; an unknown magic is an honest {@link InputError}, never a guess.
 */

import { InputError } from '../../contracts/errors.ts';

/** The still/animated image formats this module probes + decodes. */
export type ImageFormat = 'gif' | 'png' | 'jpeg' | 'webp' | 'avif';

/** Canonical MIME for each format — the `type` an {@link ImageDecoder} is constructed with. */
export const IMAGE_MIME: Readonly<Record<ImageFormat, string>> = {
  gif: 'image/gif',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Structured result of {@link probeImage}. `frameCount` is the number of animation frames (1 for a still
 * image); `animated` is `frameCount > 1` for a true multi-frame track. `loopCount` is the number of
 * additional plays — `Infinity` means "loop forever" (the common GIF/APNG/WebP default), a finite integer
 * is an explicit repeat count, and `undefined` means the format/stream did not specify one. `bitDepth` is
 * bits per channel/component; `colorType` is a short, format-specific colour descriptor (e.g. PNG colour
 * type name, JPEG component count, WebP `'lossy'`/`'lossless'`).
 */
export interface ImageInfo {
  format: ImageFormat;
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
  /** Number of animation frames; 1 for a still image. */
  frameCount: number;
  /** True iff the image carries more than one frame. */
  animated: boolean;
  /** Bits per channel/component (e.g. 8). */
  bitDepth: number;
  /** Short, format-specific colour descriptor. */
  colorType: string;
  /** Additional plays: `Infinity` = forever, a finite count, or `undefined` if unspecified. */
  loopCount?: number;
}

// ── tiny byte helpers (bounds-checked; an overrun is a typed InputError, never a wrong number) ─────

/** A read past the end of the buffer means the header is truncated — reject, never fabricate. */
function truncated(format: string): never {
  throw new InputError('unsupported-input', `${format}: truncated/garbled image header`);
}

function u8(b: Uint8Array, i: number, format: string): number {
  const v = b[i];
  if (v === undefined) truncated(format);
  return v;
}

function u16be(b: Uint8Array, i: number, format: string): number {
  return (u8(b, i, format) << 8) | u8(b, i + 1, format);
}

function u16le(b: Uint8Array, i: number, format: string): number {
  return u8(b, i, format) | (u8(b, i + 1, format) << 8);
}

function u24le(b: Uint8Array, i: number, format: string): number {
  return u8(b, i, format) | (u8(b, i + 1, format) << 8) | (u8(b, i + 2, format) << 16);
}

/** Big-endian uint32 as an unsigned value (`>>> 0` keeps the top bit from going negative). */
function u32be(b: Uint8Array, i: number, format: string): number {
  return (
    ((u8(b, i, format) << 24) |
      (u8(b, i + 1, format) << 16) |
      (u8(b, i + 2, format) << 8) |
      u8(b, i + 3, format)) >>>
    0
  );
}

function u32le(b: Uint8Array, i: number, format: string): number {
  return (
    (u8(b, i, format) | (u8(b, i + 1, format) << 8) | (u8(b, i + 2, format) << 16)) +
    u8(b, i + 3, format) * 0x1000000
  );
}

/** ASCII compare a fixed 4-byte tag at `i` without allocating (FourCC / box-type matching). */
function tagEquals(b: Uint8Array, i: number, tag: string): boolean {
  if (i + tag.length > b.length) return false;
  for (let k = 0; k < tag.length; k++) {
    if (b[i + k] !== tag.charCodeAt(k)) return false;
  }
  return true;
}

// ── magic-byte sniffing ────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Identify the image format from its leading magic bytes, or `undefined` if none match. Cheap and pure —
 * the same routine backs both the public {@link probeImage} dispatch and a driver's `supports()` gate.
 */
export function sniffImageFormat(b: Uint8Array): ImageFormat | undefined {
  if (b.length >= 6 && tagEquals(b, 0, 'GIF87a')) return 'gif';
  if (b.length >= 6 && tagEquals(b, 0, 'GIF89a')) return 'gif';
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && tagEquals(b, 0, 'RIFF') && tagEquals(b, 8, 'WEBP')) return 'webp';
  // AVIF: an ISO-BMFF `ftyp` whose major brand or a compatible brand is an AVIF brand.
  if (b.length >= 12 && tagEquals(b, 4, 'ftyp') && isAvifFtyp(b)) return 'avif';
  return undefined;
}

const AVIF_BRANDS = new Set(['avif', 'avis', 'avio', 'av01']);

/** True iff the `ftyp` box's major brand or any compatible brand is an AVIF brand. */
function isAvifFtyp(b: Uint8Array): boolean {
  const size = u32be(b, 0, 'avif');
  // major_brand at 8; compatible_brands run from 16 to the end of the (bounded) ftyp box.
  if (AVIF_BRANDS.has(ascii(b, 8, 4))) return true;
  const end = Math.min(size > 0 ? size : b.length, b.length);
  for (let i = 16; i + 4 <= end; i += 4) {
    if (AVIF_BRANDS.has(ascii(b, i, 4))) return true;
  }
  return false;
}

/** Decode a fixed ASCII run (FourCC/brand). Out-of-range bytes read as 0 (only used after a length check). */
function ascii(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i] ?? 0);
  return s;
}

// ── GIF (CompuServe GIF87a/89a) ──────────────────────────────────────────────────────────────────

/**
 * Walk a GIF: the logical-screen descriptor gives the canvas size and global-colour-table depth; each
 * Image Descriptor (`0x2C`) is a frame; a NETSCAPE2.0 Application Extension carries the loop count. The
 * sub-block chains (after a local colour table / in extensions) are skipped by their length bytes.
 */
export function probeGif(b: Uint8Array): ImageInfo {
  const fmt = 'gif';
  const version = ascii(b, 0, 6);
  if (version !== 'GIF87a' && version !== 'GIF89a') {
    throw new InputError('unsupported-input', 'gif: bad signature');
  }
  const width = u16le(b, 6, fmt);
  const height = u16le(b, 8, fmt);
  const packed = u8(b, 10, fmt);
  const gctFlag = (packed & 0x80) !== 0;
  const bitDepth = (packed & 0x07) + 1; // bits-per-pixel of the (global) colour table
  let i = 13 + (gctFlag ? 3 * (1 << ((packed & 0x07) + 1)) : 0);

  let frameCount = 0;
  let loopCount: number | undefined;

  for (;;) {
    const block = u8(b, i, fmt);
    if (block === 0x3b) break; // trailer
    if (block === 0x2c) {
      // Image Descriptor: 10 fixed bytes; optional local colour table; LZW data as sub-blocks.
      frameCount++;
      const localPacked = u8(b, i + 9, fmt);
      i += 10;
      if ((localPacked & 0x80) !== 0) i += 3 * (1 << ((localPacked & 0x07) + 1));
      i += 1; // LZW minimum code size
      i = skipGifSubBlocks(b, i, fmt);
    } else if (block === 0x21) {
      // Extension: a label byte, then sub-blocks. The NETSCAPE2.0 app-extension carries the loop count.
      const label = u8(b, i + 1, fmt);
      const j = i + 2;
      if (label === 0xff) {
        const blockSize = u8(b, j, fmt);
        if (blockSize === 11 && ascii(b, j + 1, 11) === 'NETSCAPE2.0') {
          // Next sub-block: [0x03, 0x01, loopLow, loopHigh]; loop 0 ⇒ forever.
          const sub = u8(b, j + 12, fmt);
          if (sub >= 3) {
            const loops = u16le(b, j + 14, fmt);
            loopCount = loops === 0 ? Number.POSITIVE_INFINITY : loops;
          }
        }
      }
      i = skipGifSubBlocks(b, j, fmt);
    } else {
      throw new InputError('unsupported-input', `gif: unknown block 0x${block.toString(16)}`);
    }
  }
  if (frameCount === 0) throw new InputError('unsupported-input', 'gif: no image frames');
  return {
    format: fmt,
    width,
    height,
    frameCount,
    animated: frameCount > 1,
    bitDepth,
    colorType: 'indexed',
    ...(loopCount !== undefined ? { loopCount } : {}),
  };
}

/** Advance past a GIF sub-block chain (each `len` byte then `len` data bytes; 0 terminates). */
function skipGifSubBlocks(b: Uint8Array, start: number, fmt: string): number {
  let i = start;
  for (;;) {
    const len = u8(b, i, fmt);
    i += 1 + len;
    if (len === 0) return i;
  }
}

// ── PNG / APNG ───────────────────────────────────────────────────────────────────────────────────

const PNG_COLOR_TYPE: Readonly<Record<number, string>> = {
  0: 'grayscale',
  2: 'rgb',
  3: 'indexed',
  4: 'grayscale-alpha',
  6: 'rgba',
};

/**
 * Walk PNG chunks: IHDR (the second chunk, fixed layout) gives width/height/bit-depth/colour-type; an
 * `acTL` (Animation Control, the APNG extension) makes it animated and carries `num_frames`/`num_plays`.
 * The frame count is `acTL.num_frames` (governs the animation regardless of a separate default image),
 * else 1 for a plain PNG.
 */
export function probePng(b: Uint8Array): ImageInfo {
  const fmt = 'png';
  for (let k = 0; k < PNG_SIGNATURE.length; k++) {
    if (u8(b, k, fmt) !== PNG_SIGNATURE[k]) {
      throw new InputError('unsupported-input', 'png: bad signature');
    }
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = '';
  let frameCount = 1;
  let animated = false;
  let loopCount: number | undefined;

  let i = 8;
  for (;;) {
    if (i + 8 > b.length) break; // ran out of chunks (no IEND seen): stop gracefully
    const len = u32be(b, i, fmt);
    const type = ascii(b, i + 4, 4);
    const body = i + 8;
    if (type === 'IHDR') {
      width = u32be(b, body, fmt);
      height = u32be(b, body + 4, fmt);
      bitDepth = u8(b, body + 8, fmt);
      colorType = PNG_COLOR_TYPE[u8(b, body + 9, fmt)] ?? 'unknown';
    } else if (type === 'acTL') {
      animated = true;
      frameCount = u32be(b, body, fmt);
      const plays = u32be(b, body + 4, fmt);
      loopCount = plays === 0 ? Number.POSITIVE_INFINITY : plays;
    }
    if (type === 'IEND') break;
    i = body + len + 4; // skip body + CRC32
  }
  if (width === 0 || height === 0) throw new InputError('unsupported-input', 'png: missing IHDR');
  return {
    format: fmt,
    width,
    height,
    frameCount,
    animated,
    bitDepth,
    colorType,
    ...(loopCount !== undefined ? { loopCount } : {}),
  };
}

// ── JPEG (JFIF/EXIF) ───────────────────────────────────────────────────────────────────────────

/** SOFn markers carry the frame geometry; SOF4/SOF8/SOF12 (DHT/JPG/DAC) are not frame headers. */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

/**
 * Walk JPEG markers to the Start-Of-Frame (SOFn): it holds sample precision (bit depth, 8 or 12),
 * height, width, and component count. JPEG is a single still frame. Standalone markers (RSTn, SOI, EOI,
 * TEM) have no length; every other marker segment is skipped by its big-endian length.
 */
export function probeJpeg(b: Uint8Array): ImageInfo {
  const fmt = 'jpeg';
  if (u8(b, 0, fmt) !== 0xff || u8(b, 1, fmt) !== 0xd8) {
    throw new InputError('unsupported-input', 'jpeg: missing SOI');
  }
  let i = 2;
  for (;;) {
    if (u8(b, i, fmt) !== 0xff) {
      throw new InputError('unsupported-input', 'jpeg: lost marker sync');
    }
    // Skip fill bytes (0xFF padding) before the marker code.
    let marker = u8(b, i + 1, fmt);
    let p = i + 1;
    while (marker === 0xff) {
      p += 1;
      marker = u8(b, p, fmt);
    }
    // Standalone markers (no length payload): SOI/EOI, RSTn, TEM.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      i = p + 1;
      continue;
    }
    const segLen = u16be(b, p + 1, fmt);
    if (isSofMarker(marker)) {
      const seg = p + 3;
      const precision = u8(b, seg, fmt);
      const height = u16be(b, seg + 1, fmt);
      const width = u16be(b, seg + 3, fmt);
      const components = u8(b, seg + 5, fmt);
      return {
        format: fmt,
        width,
        height,
        frameCount: 1,
        animated: false,
        bitDepth: precision,
        colorType: `${components}-component`,
      };
    }
    i = p + 1 + segLen; // advance past this marker segment
  }
}

// ── WebP (RIFF) ──────────────────────────────────────────────────────────────────────────────────

/**
 * Walk a WebP RIFF: the first chunk's FourCC selects the kind — `VP8 ` (lossy simple), `VP8L` (lossless
 * simple), or `VP8X` (extended). VP8X carries the canvas size and an ANIM flag; for an animated file the
 * `ANIM` chunk holds the loop count and each `ANMF` chunk is a frame. Simple files take their dimensions
 * from the VP8/VP8L bitstream header. RIFF chunks are padded to even length.
 */
export function probeWebp(b: Uint8Array): ImageInfo {
  if (!tagEquals(b, 0, 'RIFF') || !tagEquals(b, 8, 'WEBP')) {
    throw new InputError('unsupported-input', 'webp: not a RIFF/WEBP container');
  }
  const fourcc = ascii(b, 12, 4);
  if (fourcc === 'VP8X') return probeWebpExtended(b);
  if (fourcc === 'VP8 ') return probeWebpLossy(b);
  if (fourcc === 'VP8L') return probeWebpLossless(b);
  throw new InputError('unsupported-input', `webp: unknown stream '${fourcc.trim()}'`);
}

/** VP8 lossy simple: the keyframe header has 14-bit width/height (+ a 2-bit scale) after the start code. */
function probeWebpLossy(b: Uint8Array): ImageInfo {
  const fmt = 'webp';
  // The 3-byte start code 0x9D 0x01 0x2A precedes the dimensions at chunk-body+6 (=file offset 26).
  const width = u16le(b, 26, fmt) & 0x3fff;
  const height = u16le(b, 28, fmt) & 0x3fff;
  return frame(fmt, width, height, 'lossy', 8);
}

/** VP8L lossless simple: a 1-byte signature then 14-bit (width-1) and 14-bit (height-1), little-endian. */
function probeWebpLossless(b: Uint8Array): ImageInfo {
  const fmt = 'webp';
  if (u8(b, 20, fmt) !== 0x2f)
    throw new InputError('unsupported-input', 'webp: bad VP8L signature');
  const bits = u32le(b, 21, fmt);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >> 14) & 0x3fff) + 1;
  return frame(fmt, width, height, 'lossless', 8);
}

/**
 * VP8X extended: a flags byte (ANIM bit 0x02, ALPHA bit 0x10) and a 24-bit (canvas-1) width/height. For
 * an animated file, walk the remaining chunks counting `ANMF` frames and reading the `ANIM` loop count.
 */
function probeWebpExtended(b: Uint8Array): ImageInfo {
  const fmt = 'webp';
  const flags = u8(b, 20, fmt);
  const animatedFlag = (flags & 0x02) !== 0;
  const alpha = (flags & 0x10) !== 0;
  const width = u24le(b, 24, fmt) + 1;
  const height = u24le(b, 27, fmt) + 1;

  let frameCount = 0;
  let loopCount: number | undefined;
  // The VP8X chunk itself is 10 bytes of body; chunks start after it (RIFF body begins at offset 12,
  // each chunk = 4-byte FourCC + 4-byte LE size + padded body).
  let i = 12 + 8 + roundUpEven(u32le(b, 16, fmt));
  while (i + 8 <= b.length) {
    const cc = ascii(b, i, 4);
    const size = u32le(b, i + 4, fmt);
    const body = i + 8;
    if (cc === 'ANIM') {
      // background colour (4 bytes) then a 16-bit loop count; 0 ⇒ forever.
      const loops = u16le(b, body + 4, fmt);
      loopCount = loops === 0 ? Number.POSITIVE_INFINITY : loops;
    } else if (cc === 'ANMF') {
      frameCount++;
    }
    i = body + roundUpEven(size);
  }

  const color = alpha ? 'rgba' : 'rgb';
  if (animatedFlag) {
    if (frameCount === 0) throw new InputError('unsupported-input', 'webp: animated but no frames');
    return {
      format: fmt,
      width,
      height,
      frameCount,
      animated: frameCount > 1,
      bitDepth: 8,
      colorType: color,
      ...(loopCount !== undefined ? { loopCount } : {}),
    };
  }
  return frame(fmt, width, height, color, 8);
}

/** A still single-frame {@link ImageInfo} (the common case for simple/non-animated formats). */
function frame(
  format: ImageFormat,
  width: number,
  height: number,
  colorType: string,
  bitDepth: number,
): ImageInfo {
  return { format, width, height, frameCount: 1, animated: false, bitDepth, colorType };
}

/** RIFF/ISO chunks pad to an even byte boundary; round a body length up so the walk stays aligned. */
function roundUpEven(n: number): number {
  return n + (n & 1);
}

// ── AVIF (ISO-BMFF / HEIF) ───────────────────────────────────────────────────────────────────────

/** Accumulated facts the AVIF box walk extracts from the relevant boxes. */
interface AvifAcc {
  width: number;
  height: number;
  bitDepth: number;
  /** Sample count from the first `stsz` (animated `avis` sequences); 0 if none seen. */
  sampleCount: number;
}

/** Box containers whose children we descend into for `ispe`/`av1C`/`stsz`. */
const AVIF_CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl']);
/** `meta` is a FullBox: 4 bytes of version/flags precede its child boxes. */
const FULLBOX_CONTAINERS = new Set(['meta']);

/**
 * Probe AVIF: identify still (`avif`) vs animated sequence (`avis`) from the `ftyp` brands, then walk the
 * ISO-BMFF box tree for `ispe` (image spatial extents → width/height), `av1C` (AV1 config → bit depth),
 * and — for a sequence — the first `stsz` (sample count → frame count). Boxes are length-prefixed
 * (`size`/`type`, with `size==1` ⇒ 64-bit largesize); unknown boxes are skipped by their size.
 */
export function probeAvif(b: Uint8Array): ImageInfo {
  const fmt = 'avif';
  if (!tagEquals(b, 4, 'ftyp')) throw new InputError('unsupported-input', 'avif: missing ftyp');
  const sequence = ftypHasBrand(b, 'avis');
  const acc: AvifAcc = { width: 0, height: 0, bitDepth: 8, sampleCount: 0 };
  walkAvifBoxes(b, 0, b.length, acc, fmt);
  if (acc.width === 0 || acc.height === 0) {
    throw new InputError('unsupported-input', 'avif: no ispe (image dimensions)');
  }
  const frameCount = sequence ? Math.max(1, acc.sampleCount) : 1;
  return {
    format: fmt,
    width: acc.width,
    height: acc.height,
    frameCount,
    animated: frameCount > 1,
    bitDepth: acc.bitDepth,
    colorType: sequence ? 'av01-sequence' : 'av01',
  };
}

/** True iff the `ftyp` major brand or a compatible brand equals `brand`. */
function ftypHasBrand(b: Uint8Array, brand: string): boolean {
  const size = u32be(b, 0, 'avif');
  if (ascii(b, 8, 4) === brand) return true;
  const end = Math.min(size > 0 ? size : b.length, b.length);
  for (let i = 16; i + 4 <= end; i += 4) if (ascii(b, i, 4) === brand) return true;
  return false;
}

/** Recursively walk ISO-BMFF boxes in `[start,end)`, accumulating the geometry/depth/sample facts. */
function walkAvifBoxes(b: Uint8Array, start: number, end: number, acc: AvifAcc, fmt: string): void {
  let i = start;
  while (i + 8 <= end) {
    let size = u32be(b, i, fmt);
    const type = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1) {
      // 64-bit largesize: the low 32 bits suffice for our small fixtures (high word must be 0).
      if (u32be(b, i + 8, fmt) !== 0)
        throw new InputError('unsupported-input', 'avif: box too large');
      size = u32be(b, i + 12, fmt);
      header = 16;
    } else if (size === 0) {
      size = end - i; // box extends to the end of its parent
    }
    if (size < header || i + size > end) {
      // A box that overruns its parent is a malformed/truncated file — reject, never guess.
      throw new InputError('unsupported-input', 'avif: malformed box length');
    }
    const body = i + header;
    readAvifBox(b, type, body, i + size, acc, fmt);
    i += size;
  }
}

/** Handle one AVIF box: read `ispe`/`av1C`/`stsz`, or descend into a known container. */
function readAvifBox(
  b: Uint8Array,
  type: string,
  body: number,
  boxEnd: number,
  acc: AvifAcc,
  fmt: string,
): void {
  if (type === 'ispe') {
    // FullBox: 4 bytes version/flags, then 32-bit width + 32-bit height. Keep the first (primary) seen.
    if (acc.width === 0) {
      acc.width = u32be(b, body + 4, fmt);
      acc.height = u32be(b, body + 8, fmt);
    }
  } else if (type === 'av1C') {
    // AV1CodecConfigurationRecord: byte[1] bit 6 = high_bitdepth, bit 5 = twelve_bit (with seq_profile 2).
    const seqProfile = (u8(b, body + 1, fmt) >> 5) & 0x07;
    const b2 = u8(b, body + 2, fmt);
    const highBitdepth = (b2 & 0x40) !== 0;
    const twelveBit = (b2 & 0x20) !== 0;
    acc.bitDepth = highBitdepth ? (seqProfile === 2 && twelveBit ? 12 : 10) : 8;
  } else if (type === 'stsz') {
    // SampleSizeBox: version/flags(4) + sample_size(4) + sample_count(4). Sample count = frame count.
    if (acc.sampleCount === 0) acc.sampleCount = u32be(b, body + 8, fmt);
  } else if (AVIF_CONTAINERS.has(type)) {
    const childStart = FULLBOX_CONTAINERS.has(type) ? body + 4 : body;
    walkAvifBoxes(b, childStart, boxEnd, acc, fmt);
  }
}

// ── public dispatch ──────────────────────────────────────────────────────────────────────────────

/**
 * Probe a still/animated image's header: detect the format by magic bytes and parse just enough of the
 * container to return {@link ImageInfo} (dimensions, frame count, animation flag, bit depth/colour, loop
 * count). Pure and Node-runnable — this is the bit-exact validation surface. Unknown magic or a truncated
 * header is a typed {@link InputError}, never a crash or a fabricated value.
 */
export function probeImage(bytes: Uint8Array): ImageInfo {
  const format = sniffImageFormat(bytes);
  switch (format) {
    case 'gif':
      return probeGif(bytes);
    case 'png':
      return probePng(bytes);
    case 'jpeg':
      return probeJpeg(bytes);
    case 'webp':
      return probeWebp(bytes);
    case 'avif':
      return probeAvif(bytes);
    case undefined:
      throw new InputError(
        'unsupported-input',
        'not a recognized image (expected GIF/PNG/JPEG/WebP/AVIF magic)',
      );
    default:
      return assertNever(format);
  }
}

/** Exhaustiveness guard: the `switch` above covers every {@link ImageFormat}; this is unreachable. */
function assertNever(x: never): never {
  throw new InputError('unsupported-input', `unhandled image format ${String(x)}`);
}
