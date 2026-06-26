/**
 * Pure, Node-testable MP3 helpers for the WASM decode driver (docs/architecture/04 wasm tier, 05
 * §CodecDriver, ADR-032). The lossy Layer-III decode (Huffman/IMDCT/synthesis filterbank) lives in
 * Symphonia compiled to wasm (see `BUILD.md`); this module holds the deterministic, spec-defined glue that
 * is validated in Node:
 *
 *  - **MPEG-audio frame header** (ISO/IEC 11172-3 §2.4.1.3 / 13818-3): the 32-bit header — MPEG version
 *    1/2/2.5, layer, the bitrate & sample-rate index tables, padding, channel mode — and the derived
 *    per-frame byte size and sample count (1152 for MPEG-1 Layer III, 576 for MPEG-2/2.5). Bit-exact.
 *  - **ID3v2 / ID3v1 tag sizing** (ID3v2.x §3.1, syncsafe integers): how many leading/trailing bytes to
 *    skip to reach the first/after the last MP3 frame.
 *  - **Xing/Info + LAME + VBRI** VBR headers (the de-facto frame-count + encoder-delay/padding tags): so a
 *    VBR stream's exact duration and gapless trim are known.
 *  - **planar↔interleaved f32**, channel/rate validation, and the {@link Mp3WasmCore} contract.
 *
 * Everything here is integer/byte logic with a real spec and a falsifiable oracle — no oracle that cannot
 * fail (directive 6).
 */

import { InputError, MediaError } from '../../contracts/errors.ts';

// ============ MP3 invariants ============

/** The MP3 codec id WebCodecs / RFC 6381 use (also accepts the `mp4a.40.34` / `mp4a.6B` aliases). */
export const MP3_CODEC = 'mp3' as const;

/** Codec strings that denote MP3 in a WebCodecs `AudioDecoderConfig` (RFC 6381 / ISO-BMFF aliases). */
const MP3_CODEC_ALIASES: readonly string[] = ['mp3', 'mp4a.40.34', 'mp4a.6b', 'mp4a.69'] as const;

/** This driver bridges mono/stereo MP3 to WebCodecs `AudioData` (MP3 is at most 2 channels). */
export const MP3_MAX_CHANNELS = 2 as const;

// ============ MPEG-audio frame header (ISO/IEC 11172-3 §2.4.1.3) ============

/** MPEG audio version a frame header's `B` field selects. */
export type MpegVersion = 'mpeg1' | 'mpeg2' | 'mpeg2.5';
/** MPEG audio layer a frame header's `C` field selects (this driver targets Layer III = MP3). */
export type MpegLayer = 1 | 2 | 3;
/** Channel mode a frame header's `I` field selects. */
export type ChannelMode = 'stereo' | 'joint' | 'dual' | 'mono';

/** Decoded fields of an MPEG-audio frame header + the derived frame size and sample count. */
export interface Mp3FrameHeader {
  version: MpegVersion;
  layer: MpegLayer;
  /** True when the frame is **not** CRC-protected (header bit D = 1). */
  crcAbsent: boolean;
  /** Bitrate in bits/second (from the version/layer table; the `free` index 0 is rejected here). */
  bitrate: number;
  /** Sample rate in Hz (from the version table). */
  sampleRate: number;
  /** Padding byte present (header bit G): adds one slot (1 byte for L2/L3) to the frame size. */
  padding: boolean;
  channelMode: ChannelMode;
  /** Channel count: 1 for `mono`, else 2. */
  channels: number;
  /** Total frame size in bytes (header + side info + main data + padding). */
  frameSize: number;
  /** Decoded PCM samples per channel this frame yields (1152 MPEG-1 L3, 576 MPEG-2/2.5 L3). */
  samplesPerFrame: number;
}

// Bitrate tables in kbps, indexed by the 4-bit `E` field (index 0 = "free", 15 = invalid → both rejected).
// MPEG-1 Layer III (ISO/IEC 11172-3 Table 8).
const BITRATE_MPEG1_L3: readonly number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
// MPEG-2 / 2.5 Layer III (ISO/IEC 13818-3 Table — the low-rate table).
const BITRATE_MPEG2_L3: readonly number[] = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
// MPEG-1 Layer II (Table 8) and Layer I — included so the header parser is honest across layers.
const BITRATE_MPEG1_L2: readonly number[] = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];
const BITRATE_MPEG1_L1: readonly number[] = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
];
const BITRATE_MPEG2_L2_L1: readonly number[] = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
];

// Sample-rate tables in Hz, indexed by the 2-bit `F` field (index 3 = reserved → rejected).
const SAMPLE_RATE: Readonly<Record<MpegVersion, readonly number[]>> = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  'mpeg2.5': [11025, 12000, 8000],
};

/** Samples-per-frame per (version, layer) — the IMDCT block size (ISO/IEC 11172-3 §2.4.2.1). */
function samplesPerFrame(version: MpegVersion, layer: MpegLayer): number {
  if (layer === 1) return 384;
  if (layer === 2) return 1152;
  // Layer III: 1152 for MPEG-1, 576 for MPEG-2/2.5 (the granule count halves).
  return version === 'mpeg1' ? 1152 : 576;
}

/** Pick the bitrate table for a (version, layer) pair. */
function bitrateTable(version: MpegVersion, layer: MpegLayer): readonly number[] {
  if (version === 'mpeg1') {
    if (layer === 1) return BITRATE_MPEG1_L1;
    if (layer === 2) return BITRATE_MPEG1_L2;
    return BITRATE_MPEG1_L3;
  }
  // MPEG-2 / 2.5
  if (layer === 1) return BITRATE_MPEG2_L2_L1;
  if (layer === 2) return BITRATE_MPEG2_L2_L1;
  return BITRATE_MPEG2_L3;
}

/** The per-frame byte size (ISO/IEC 11172-3 §2.4.3.1): a function of layer, bitrate, rate, and padding. */
function frameSizeBytes(
  version: MpegVersion,
  layer: MpegLayer,
  bitrate: number,
  sampleRate: number,
  padding: boolean,
): number {
  const pad = padding ? 1 : 0;
  if (layer === 1) {
    // Layer I: slot = 4 bytes; size = (12 * br / sr + pad) * 4.
    return (Math.floor((12 * bitrate) / sampleRate) + pad) * 4;
  }
  // Layer II always, Layer III for MPEG-1: 144 * br / sr; Layer III for MPEG-2/2.5: 72 * br / sr.
  const coefficient = layer === 3 && version !== 'mpeg1' ? 72 : 144;
  return Math.floor((coefficient * bitrate) / sampleRate) + pad;
}

/** True if `(b0,b1)` begin a valid MPEG-audio frame sync: 11 set sync bits + a non-reserved version/layer. */
export function isFrameSync(b0: number, b1: number): boolean {
  if (b0 !== 0xff) return false;
  if ((b1 & 0xe0) !== 0xe0) return false; // top 3 bits of byte 1 are part of the 11-bit sync
  if ((b1 & 0x18) === 0x08) return false; // version `01` is reserved
  if ((b1 & 0x06) === 0x00) return false; // layer `00` is reserved
  return true;
}

/**
 * Parse an MPEG-audio frame header from the 4 bytes at `offset` (ISO/IEC 11172-3 §2.4.1.3). Decodes the
 * version/layer/bitrate/sample-rate/padding/channel-mode and derives the frame's byte size + sample count.
 * The `free` bitrate (index 0), the invalid bitrate (15), and the reserved sample-rate (3) are rejected as
 * malformed input — the wasm decoder needs a concrete frame geometry. Used to walk a raw MP3 stream and to
 * size/validate; the audio decode itself is the wasm core's job.
 */
export function parseMp3FrameHeader(bytes: Uint8Array, offset = 0): Mp3FrameHeader {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new InputError('unsupported-input', 'mp3: frame shorter than its 4-byte header');
  }
  if (!isFrameSync(b0, b1)) {
    throw new InputError('unsupported-input', 'mp3: no MPEG-audio frame sync at offset');
  }
  const version = versionFromBits((b1 >> 3) & 0x3);
  const layer = layerFromBits((b1 >> 1) & 0x3);
  const crcAbsent = (b1 & 0x1) === 1;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const sampleRateIndex = (b2 >> 2) & 0x3;
  const padding = ((b2 >> 1) & 0x1) === 1;
  const channelMode = channelModeFromBits((b3 >> 6) & 0x3);

  if (sampleRateIndex === 3) {
    throw new MediaError('decode-error', 'mp3: reserved sample-rate index 3');
  }
  const sampleRate = SAMPLE_RATE[version][sampleRateIndex];
  if (sampleRate === undefined) {
    throw new MediaError('decode-error', `mp3: invalid sample-rate index ${sampleRateIndex}`);
  }
  const bitrateKbps = bitrateTable(version, layer)[bitrateIndex];
  if (bitrateKbps === undefined || bitrateKbps === 0) {
    throw new MediaError(
      'decode-error',
      `mp3: unsupported bitrate index ${bitrateIndex} (free/invalid)`,
    );
  }
  const bitrate = bitrateKbps * 1000;
  return {
    version,
    layer,
    crcAbsent,
    bitrate,
    sampleRate,
    padding,
    channelMode,
    channels: channelMode === 'mono' ? 1 : 2,
    frameSize: frameSizeBytes(version, layer, bitrate, sampleRate, padding),
    samplesPerFrame: samplesPerFrame(version, layer),
  };
}

function versionFromBits(bits: number): MpegVersion {
  switch (bits) {
    case 0:
      return 'mpeg2.5';
    case 2:
      return 'mpeg2';
    case 3:
      return 'mpeg1';
    /* v8 ignore next 2 -- isFrameSync rejects the reserved MPEG version before this switch. */
    default:
      // bits === 1 is the reserved version; isFrameSync already rejects it, so this is unreachable.
      throw new MediaError('decode-error', 'mp3: reserved MPEG version');
  }
}

function layerFromBits(bits: number): MpegLayer {
  switch (bits) {
    case 1:
      return 3; // `01` = Layer III
    case 2:
      return 2; // `10` = Layer II
    case 3:
      return 1; // `11` = Layer I
    /* v8 ignore next 2 -- isFrameSync rejects the reserved layer before this switch. */
    default:
      // bits === 0 is the reserved layer; isFrameSync already rejects it.
      throw new MediaError('decode-error', 'mp3: reserved layer');
  }
}

function channelModeFromBits(bits: number): ChannelMode {
  switch (bits) {
    case 0:
      return 'stereo';
    case 1:
      return 'joint';
    case 2:
      return 'dual';
    case 3:
      return 'mono';
    /* v8 ignore next 2 -- bits is masked to 0–3; the switch is exhaustive. */
    default:
      throw new MediaError('decode-error', `mp3: impossible channel-mode bits ${bits}`);
  }
}

// ============ ID3v2 / ID3v1 tag sizing ============

/** Bytes an `ID3` tag occupies at the start of `bytes` (header + syncsafe size), or 0 if none present. */
export function id3v2Size(bytes: Uint8Array): number {
  // ID3v2 header: 'ID3', version(2), flags(1), size(4 syncsafe) = 10 bytes, then the tag body.
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0; // not 'ID3'
  const s0 = bytes[6] as number;
  const s1 = bytes[7] as number;
  const s2 = bytes[8] as number;
  const s3 = bytes[9] as number;
  // Syncsafe: each byte uses only its low 7 bits (ID3v2.4 §3.1).
  if ((s0 | s1 | s2 | s3) & 0x80) return 0; // a high bit set ⇒ not a valid syncsafe size
  const bodySize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
  const footer = ((bytes[5] as number) & 0x10) !== 0 ? 10 : 0; // ID3v2.4 footer present flag
  return 10 + bodySize + footer;
}

/** True when `bytes` ends with a 128-byte ID3v1 `TAG` trailer (which must not be fed to the decoder). */
export function hasId3v1(bytes: Uint8Array): boolean {
  if (bytes.length < 128) return false;
  const o = bytes.length - 128;
  return bytes[o] === 0x54 && bytes[o + 1] === 0x41 && bytes[o + 2] === 0x47; // 'TAG'
}

/**
 * The byte offset of the first MP3 frame in a raw stream: skip a leading ID3v2 tag if present, then scan
 * forward to the first valid frame sync (defensive — some files pad with junk). Throws if no frame sync is
 * found within the buffer. Pure; lets the driver/tests locate the first decodable frame.
 */
export function firstFrameOffset(bytes: Uint8Array): number {
  const start = id3v2Size(bytes);
  for (let i = start; i + 4 <= bytes.length; i++) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    if (isFrameSync(b0, b1)) {
      // Confirm by fully parsing (rejects a false sync inside data): a parse that doesn't throw wins.
      try {
        parseMp3FrameHeader(bytes, i);
        return i;
      } catch {
        // not a real frame at i — keep scanning
      }
    }
  }
  throw new InputError('unsupported-input', 'mp3: no MPEG-audio frame found');
}

/**
 * Walk every MP3 frame in a raw stream (after any ID3v2 tag), yielding each frame's header + a zero-copy
 * view of its bytes. Stops at an ID3v1 trailer or end of buffer; a sync loss mid-stream ends iteration
 * (the tail may be a tag or padding). Generator so callers stream; pure and Node-testable on a real `.mp3`.
 */
export function* iterateMp3Frames(
  bytes: Uint8Array,
): Generator<{ header: Mp3FrameHeader; data: Uint8Array }, void, unknown> {
  const end = hasId3v1(bytes) ? bytes.length - 128 : bytes.length;
  let pos = firstFrameOffset(bytes);
  while (pos + 4 <= end) {
    let header: Mp3FrameHeader;
    try {
      header = parseMp3FrameHeader(bytes, pos);
    } catch {
      return; // lost sync (padding / trailing tag) — stop cleanly
    }
    const frameEnd = pos + header.frameSize;
    if (frameEnd > end) return; // a truncated final frame — stop
    yield { header, data: bytes.subarray(pos, frameEnd) };
    pos = frameEnd;
  }
}

// ============ Xing / Info / VBRI + LAME headers ============

/** A VBR header found in the first MP3 frame: total frame count + LAME encoder delay/padding when present. */
export interface VbrInfo {
  /** `'Xing'` (VBR) or `'Info'` (CBR-but-tagged) or `'VBRI'` (Fraunhofer). */
  tag: 'Xing' | 'Info' | 'VBRI';
  /** Total MPEG frames in the stream (excludes this header frame), when the count flag is set. */
  frameCount?: number;
  /** Encoder delay in samples (LAME tag) — leading decoder warm-up to drop for gapless playback. */
  encoderDelay?: number;
  /** Encoder padding in samples (LAME tag) — trailing samples to drop. */
  encoderPadding?: number;
}

/** The fixed offset of Xing/Info data within a frame, by (version, channelMode) — side-info size + 4. */
function xingOffset(version: MpegVersion, channelMode: ChannelMode): number {
  // Side info size (ISO/IEC 11172-3): MPEG-1 stereo=32, mono=17; MPEG-2/2.5 stereo=17, mono=9. The 4-byte
  // header sits after the (header 4 + side info).
  const mono = channelMode === 'mono';
  const sideInfo = version === 'mpeg1' ? (mono ? 17 : 32) : mono ? 9 : 17;
  return 4 + sideInfo;
}

/**
 * Detect + parse a Xing/Info/VBRI VBR header in the **first** frame of an MP3 stream (the de-facto LAME
 * tags). Xing/Info live at a fixed side-info-dependent offset; VBRI lives at a fixed offset 36. Returns the
 * total frame count (so an exact duration is known without decoding) and the LAME encoder delay/padding
 * (so a gapless `decode` can trim warm-up/end). `undefined` when the first frame carries no VBR header (a
 * plain CBR stream). Pure; the byte layout is fully specified.
 */
export function parseVbrHeader(frame: Uint8Array, header: Mp3FrameHeader): VbrInfo | undefined {
  // Xing / Info at the side-info-relative offset.
  const xo = xingOffset(header.version, header.channelMode);
  const xingTag = readTag(frame, xo);
  if (xingTag === 'Xing' || xingTag === 'Info') {
    return parseXing(frame, xo, xingTag);
  }
  // VBRI is always at offset 36 (4-byte header + 32-byte fixed side info region).
  if (readTag(frame, 36) === 'VBRI') {
    const frameCount = readU32BE(frame, 36 + 14); // VBRI: …, frames @ +14 (big-endian)
    return frameCount === undefined ? { tag: 'VBRI' } : { tag: 'VBRI', frameCount };
  }
  return undefined;
}

/** Parse the Xing/Info body at `offset` (flags u32, then optional frames/bytes/TOC/quality, then LAME). */
function parseXing(frame: Uint8Array, offset: number, tag: 'Xing' | 'Info'): VbrInfo {
  const flags = readU32BE(frame, offset + 4) ?? 0;
  let cursor = offset + 8;
  const info: VbrInfo = { tag };
  if (flags & 0x1) {
    const frameCount = readU32BE(frame, cursor);
    if (frameCount !== undefined) info.frameCount = frameCount;
    cursor += 4;
  }
  if (flags & 0x2) cursor += 4; // bytes field present
  if (flags & 0x4) cursor += 100; // 100-byte TOC present
  if (flags & 0x8) cursor += 4; // quality field present
  // LAME tag (9-byte version string + fields); encoder delay/padding are a packed 3-byte field at +21.
  const lame = readTag(frame, cursor);
  if (lame === 'LAME' || lame === 'Lavf' || lame === 'Lavc') {
    const d0 = frame[cursor + 21];
    const d1 = frame[cursor + 22];
    const d2 = frame[cursor + 23];
    if (d0 !== undefined && d1 !== undefined && d2 !== undefined) {
      info.encoderDelay = (d0 << 4) | (d1 >> 4); // 12 bits
      info.encoderPadding = ((d1 & 0x0f) << 8) | d2; // 12 bits
    }
  }
  return info;
}

/** Read a 4-char ASCII tag at `offset`, or `undefined` if out of range. */
function readTag(bytes: Uint8Array, offset: number): string | undefined {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return String.fromCharCode(a, b, c, d);
}

/** Read a big-endian unsigned 32-bit value at `offset`, or `undefined` if out of range. */
function readU32BE(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

// ============ planar ↔ interleaved f32 ============

/**
 * Split an interleaved `[c0,c1,…]` f32 buffer (what the wasm MP3 core returns) into `channels` per-channel
 * planes — the shape an `f32-planar` `AudioData` is built from. `interleaved.length` must be
 * `frames × channels`.
 */
export function deinterleaveF32(
  interleaved: Float32Array,
  channels: number,
  frames: number,
): Float32Array[] {
  if (interleaved.length !== frames * channels) {
    throw new MediaError(
      'decode-error',
      `mp3: interleaved length ${interleaved.length} ≠ ${frames}×${channels}`,
    );
  }
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let c = 0; c < channels; c++) {
    const plane = planes[c] as Float32Array;
    for (let i = 0; i < frames; i++) plane[i] = interleaved[i * channels + c] as number;
  }
  return planes;
}

// ============ config validation ============

/** A validated decode configuration (channels/rate the driver seeds its `AudioData` geometry from). */
export interface Mp3DecodeConfig {
  channels: number;
  sampleRate: number;
}

/** True when a WebCodecs codec id denotes MP3 (the bare `mp3` or an ISO-BMFF `mp4a.*` alias). */
export function isMp3Codec(codec: string): boolean {
  return MP3_CODEC_ALIASES.includes(codec.trim().toLowerCase());
}

/**
 * Validate + normalize an {@link AudioDecoderConfig} for the wasm MP3 core. Requires an MP3 codec id and a
 * sane channel count; unlike Vorbis, MP3 needs **no** `description` (each frame self-describes), so none is
 * required. A bad config is a typed {@link MediaError} (`decode-error`) — never a silent misconfigure.
 */
export function normalizeMp3DecoderConfig(config: AudioDecoderConfig): Mp3DecodeConfig {
  if (!isMp3Codec(config.codec)) {
    throw new MediaError('decode-error', `mp3: wasm-mp3 cannot decode codec '${config.codec}'`);
  }
  const channels = config.numberOfChannels;
  if (channels < 1 || channels > MP3_MAX_CHANNELS) {
    throw new MediaError(
      'decode-error',
      `mp3: wasm-mp3 supports 1–${MP3_MAX_CHANNELS} channels, got ${channels}`,
    );
  }
  if (!(config.sampleRate > 0)) {
    throw new MediaError('decode-error', `mp3: invalid sampleRate ${config.sampleRate}`);
  }
  return { channels, sampleRate: config.sampleRate };
}

// ============ the wasm-core contract (what BUILD.md produces) ============

/**
 * The surface the Symphonia-in-wasm glue exposes (see `BUILD.md`), wrapping `symphonia-bundle-mp3`'s
 * `MpaDecoder`. The driver constructs one {@link Mp3WasmDecoder} per stream (seeded with the
 * container-declared geometry — MP3 needs no codec-private headers), decodes each MP3 frame to interleaved
 * f32, and `free()`s on teardown. Mirrors the generated `Mp3Wasm` class.
 */
export interface Mp3WasmCore {
  /**
   * Construct a decoder seeded with the container-declared `channels`/`sampleRate` (each frame's own
   * header is authoritative and reconciled on the first decoded frame, so the values are correct either
   * way). MP3 has no `extra_data`.
   */
  createDecoder(channels: number, sampleRate: number): Mp3WasmDecoder;
}

/** A live Symphonia MP3 decoder: frames in, interleaved f32 out (bit reservoir held internally). */
export interface Mp3WasmDecoder {
  /** Channel count (container-declared, reconciled with the decoded frame's header). */
  readonly channels: number;
  /** Sample rate (Hz) (container-declared, reconciled with the decoded frame's header). */
  readonly sampleRate: number;
  /** Decode one MP3 frame → interleaved f32 (`frames × channels`; 1152 MPEG-1 L3, 576 MPEG-2/2.5 L3). */
  decode(frame: Uint8Array): Float32Array;
  /** Reset the bit reservoir at a seek/discontinuity. */
  reset(): void;
  /** Release the native decoder. Idempotent. */
  free(): void;
}
