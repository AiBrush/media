/**
 * The WebM/Matroska `Muxer` seam (docs/architecture/05 §2, 09 mux) — a hand-written EBML byte writer
 * plus the {@link WebmMuxer} adapter over it, mirroring the MP4 muxer's "Muxer-over-writer" shape
 * ({@link Mp4Muxer}). It writes an **EBML Header** + a **Segment** (`Info` with TimecodeScale/Duration,
 * `Tracks` with one `TrackEntry` per track carrying CodecID + CodecPrivate + geometry, and `Cluster`s of
 * `SimpleBlock`s — one per encoded packet, with presentation timecodes derived from each chunk's PTS).
 *
 * EBML element = `ID(vint, marker kept) · size(vint, marker stripped) · data`. This writer always emits
 * **definite** sizes (every element's payload is built first, then length-prefixed), so the output is
 * fully seekable and re-parses with {@link parseWebm} + a `SimpleBlock` scan (the round-trip oracle).
 *
 * The packet→block timing (the only non-trivial logic) is a pure, Node-testable helper
 * ({@link buildBlockTimeline}); only the `write()` extraction of a real `EncodedChunk` (`copyTo`) is
 * browser-only and guarded. WebM `SimpleBlock`s carry **presentation** time + a keyframe flag (no
 * separate DTS/ctts as in MP4), so reordered (B-frame) input simply yields blocks timestamped by PTS.
 */

import type {
  MuxOptions,
  Muxer,
  Packet,
  TrackInfo,
  VideoColorMetadata,
} from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { matroskaRollFromClockwise, normalizeClockwiseRotation } from '../../util/rotation.ts';
import { webmVideoCodecPrivate } from './video-codec-qualification.ts';

// ============ Matroska/EBML element IDs (verbatim, marker bits included) ============

const EBML_ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  DefaultDuration: 0x23e383,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AlphaMode: 0x53c0,
  Projection: 0x7670,
  ProjectionPoseRoll: 0x7675,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  BitsPerChannel: 0x55b2,
  ChromaSubsamplingHorz: 0x55b3,
  ChromaSubsamplingVert: 0x55b4,
  CbSubsamplingHorz: 0x55b5,
  CbSubsamplingVert: 0x55b6,
  ChromaSitingHorz: 0x55b7,
  ChromaSitingVert: 0x55b8,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  MaxCLL: 0x55bc,
  MaxFALL: 0x55bd,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAdditional: 0xa5,
  BlockAddID: 0xee,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75a2,
} as const;

/** WebM default TimecodeScale: 1 ms per tick (ns). Matches {@link parseWebm}'s default. */
const TIMECODE_SCALE_NS = 1_000_000;
const NS_PER_MS = 1_000_000;
const MICROS_PER_MS = 1_000;
const NANOS_PER_SECOND = 1_000_000_000;
const OPUS_SAMPLE_RATE = 48_000;
const OPUS_SEEK_PREROLL_NS = 80_000_000;
/**
 * A new Cluster is started before a block's timecode relative to the cluster would overflow the signed
 * int16 `SimpleBlock` field. The hard limit is 32767 ms; 30000 leaves margin (and bounds cluster size).
 */
const MAX_CLUSTER_REL_MS = 30_000;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
const APP_NAME = 'aibrush-media';

// ============ EBML write primitives ============

/** The big-endian bytes of an element ID (1–4 bytes), inferred from its magnitude. */
function idBytes(id: number): number[] {
  const bytes: number[] = [];
  let width = 1;
  if (id > 0xffffff) width = 4;
  else if (id > 0xffff) width = 3;
  else if (id > 0xff) width = 2;
  for (let i = width - 1; i >= 0; i--) bytes.push((id >>> (i * 8)) & 0xff);
  return bytes;
}

function idByteLength(id: number): number {
  if (id > 0xffffff) return 4;
  if (id > 0xffff) return 3;
  if (id > 0xff) return 2;
  return 1;
}

function vintByteLength(n: number): number {
  if (n < 0 || !Number.isFinite(n)) {
    throw new MediaError('mux-error', `cannot EBML-encode a negative/invalid length ${n}`);
  }
  for (let length = 1; length <= 8; length++) {
    const capacity = 2 ** (7 * length) - 1; // all-ones (reserved) → usable range is [0, capacity)
    if (n < capacity) return length;
  }
  throw new MediaError('mux-error', `length ${n} does not fit an 8-byte EBML vint`);
}

/**
 * Encode a non-negative magnitude as an EBML size/value vint: the smallest width L∈[1,8] whose value
 * range can hold `n` (the all-ones value of a width is reserved for "unknown size", so a magnitude that
 * exactly equals it rolls to the next width), with the length marker `0x80 >> (L-1)` in the first byte.
 * This is the exact inverse of {@link readVint} with `keepMarker=false`.
 */
function vintBytes(n: number): number[] {
  const length = vintByteLength(n);
  const out = new Array<number>(length).fill(0);
  let v = n;
  for (let i = length - 1; i >= 1; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] = (v & 0xff) | (0x80 >> (length - 1)); // remaining high bits + the length marker
  return out;
}

/** Concatenate `parts` (each a byte array) into one `Uint8Array`. */
function concatBytes(parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Build a complete EBML element: `ID · size(definite) · payload`. */
function element(id: number, payload: Uint8Array | readonly number[]): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  return concatBytes([idBytes(id), vintBytes(body.length), body]);
}

/** Build only an EBML element prefix: `ID · size(definite)`. */
function elementHeader(id: number, payloadLength: number): Uint8Array {
  return concatBytes([idBytes(id), vintBytes(payloadLength)]);
}

/** Big-endian minimal-width unsigned-integer bytes (≥ 1 byte; EBML uint elements are 1–8 bytes). */
function uintBytes(n: number): number[] {
  if (n < 0 || !Number.isFinite(n)) {
    throw new MediaError('mux-error', `cannot encode a negative/invalid uint ${n}`);
  }
  const bytes: number[] = [];
  let v = Math.floor(n);
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return bytes;
}

/** An EBML unsigned-integer element. */
function uintEl(id: number, n: number): Uint8Array {
  return element(id, uintBytes(n));
}

/** Big-endian minimal-width two's-complement bytes for a safe signed EBML integer. */
function intBytes(n: number): number[] {
  if (!Number.isSafeInteger(n)) {
    throw new MediaError('mux-error', `cannot encode an unsafe/invalid signed integer ${n}`);
  }
  let width = 1;
  while (width < 8) {
    const bound = 2 ** (width * 8 - 1);
    if (n >= -bound && n < bound) break;
    width++;
  }
  const bytes = new Array<number>(width).fill(0);
  let value = n;
  for (let index = width - 1; index >= 0; index--) {
    bytes[index] = ((value % 256) + 256) % 256;
    value = Math.floor(value / 256);
  }
  return bytes;
}

/** An EBML signed-integer element (used by BlockGroup DiscardPadding). */
function intEl(id: number, n: number): Uint8Array {
  return element(id, intBytes(n));
}

/** An EBML 64-bit float element (Matroska `Duration`/`SamplingFrequency` are floats). */
function floatEl(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, false);
  return element(id, buf);
}

/** An EBML ASCII/UTF-8 string element. */
function stringEl(id: number, s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return element(id, bytes);
}

/** A signed 16-bit big-endian value (the `SimpleBlock` relative timecode). */
function int16Bytes(n: number): number[] {
  if (n < INT16_MIN || n > INT16_MAX || !Number.isFinite(n)) {
    throw new MediaError('mux-error', `SimpleBlock relative timecode ${n}ms exceeds int16 range`);
  }
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setInt16(0, n, false);
  return [buf[0] ?? 0, buf[1] ?? 0];
}

/** A single pre-sized output writer used by the WebM serializer to avoid full-output recopy cascades. */
class ByteWriter {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(length: number) {
    this.#bytes = new Uint8Array(length);
  }

  write(part: Uint8Array | readonly number[]): void {
    this.#bytes.set(part, this.#offset);
    this.#offset += part.length;
  }

  writeByte(value: number): void {
    this.#bytes[this.#offset++] = value & 0xff;
  }

  writeInt16(value: number): void {
    if (value < INT16_MIN || value > INT16_MAX || !Number.isFinite(value)) {
      throw new MediaError(
        'mux-error',
        `SimpleBlock relative timecode ${value}ms exceeds int16 range`,
      );
    }
    const unsigned = value < 0 ? value + 0x10000 : value;
    this.writeByte(unsigned >>> 8);
    this.writeByte(unsigned);
  }

  writeVint(value: number): void {
    const length = vintByteLength(value);
    let remaining = value;
    const start = this.#offset;
    for (let i = length - 1; i >= 1; i--) {
      this.#bytes[start + i] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    this.#bytes[start] = (remaining & 0xff) | (0x80 >> (length - 1));
    this.#offset += length;
  }

  finish(): Uint8Array {
    if (this.#offset !== this.#bytes.byteLength) {
      throw new MediaError(
        'mux-error',
        `webm writer planned ${this.#bytes.byteLength} bytes but wrote ${this.#offset}`,
      );
    }
    return this.#bytes;
  }
}

// ============ codec mapping (write side — inverse of parseWebm's mapCodec) ============

/** Map a WebCodecs codec string to its Matroska CodecID; a typed miss for an unmappable codec. */
function toCodecId(mediaType: 'video' | 'audio', codec: string): string {
  const c = codec.toLowerCase();
  if (mediaType === 'video') {
    if (c.startsWith('vp8') || c.startsWith('vp08')) return 'V_VP8';
    if (c.startsWith('vp9') || c.startsWith('vp09')) return 'V_VP9';
    if (c.startsWith('av1') || c.startsWith('av01')) return 'V_AV1';
    if (c.startsWith('avc1') || c.startsWith('avc3') || c.startsWith('h264'))
      return 'V_MPEG4/ISO/AVC';
    if (
      c.startsWith('hev1') ||
      c.startsWith('hvc1') ||
      c.startsWith('hevc') ||
      c.startsWith('h265')
    )
      return 'V_MPEGH/ISO/HEVC';
  } else {
    if (c.startsWith('opus')) return 'A_OPUS';
    if (c.startsWith('vorbis')) return 'A_VORBIS';
    if (c.startsWith('mp4a') || c.startsWith('aac')) return 'A_AAC';
    if (c.startsWith('flac')) return 'A_FLAC';
    if (c === 'mp3' || c.startsWith('mp3')) return 'A_MPEG/L3';
  }
  throw new CapabilityError(`the webm muxer cannot write ${mediaType} codec '${codec}'`, {
    op: { kind: 'route', id: 'mux', facts: { mediaType, codec } },
    tried: ['webm'],
  });
}

/** Public codec-id projection for prepared-packet WebM/Matroska helpers. */
export function webmCodecIdForTrack(mediaType: 'video' | 'audio', codec: string): string {
  return toCodecId(mediaType, codec);
}

// ============ chunk struct + block timeline (pure) ============

/**
 * A decoded view of one `EncodedChunk` in container-neutral terms — the pure input to the timeline. Owns
 * its byte copy (`data`), so no live WebCodecs object is retained past `write()`.
 */
export interface ChunkStruct {
  /** Presentation timestamp (µs), from `chunk.timestamp`. */
  timestampUs: number;
  /** Sample duration (µs), from `chunk.duration`; `undefined` when the encoder omitted it. */
  durationUs: number | undefined;
  /** Sync sample? `chunk.type === 'key'`. */
  key: boolean;
  /** The packet bytes (owned copy). */
  data: Uint8Array;
  /** VPx alpha side-data bytes from Matroska BlockAdditions (BlockAddID=1), when present. */
  alpha?: Uint8Array;
  /** Signed Matroska BlockGroup DiscardPadding, in nanoseconds. */
  discardPaddingNs?: number;
  /**
   * Decode timestamp (µs), from the demuxer's {@link Packet.dtsUs} on a verbatim remux. Matroska stores
   * blocks in **decode** order (a Cluster is read front-to-back and fed straight to the decoder), so a
   * reordered (B-frame) source must lay its blocks down by DTS even though each `SimpleBlock` timecode is
   * the PTS. `undefined` ⇒ DTS == PTS (the no-reorder case, where decode order == presentation order).
   */
  dtsUs?: number;
}

/** One block on the timeline: stored in **decode** order (`dtsMs`); its `SimpleBlock` timecode is `timeMs` (PTS). */
export interface TimelineBlock {
  trackNumber: number;
  /** Presentation time (ms ticks) — written as the `SimpleBlock` timecode (relative to its Cluster). */
  timeMs: number;
  /** Decode time (ms ticks) — the storage/decode order key; equals `timeMs` for a non-reordered stream. */
  dtsMs: number;
  key: boolean;
  data: Uint8Array;
  /** VPx alpha side-data bytes to write as BlockAdditions (BlockAddID=1), when present. */
  alpha?: Uint8Array;
  /** Signed Matroska BlockGroup DiscardPadding, in nanoseconds. */
  discardPaddingNs?: number;
}

/** Round µs to whole-ms ticks (the chosen TimecodeScale). */
function usToMs(us: number): number {
  return Math.round(us / MICROS_PER_MS);
}

interface TrackChunks {
  trackNumber: number;
  mediaType?: 'video' | 'audio';
  durationSec?: number;
  sampleRate?: number;
  gapless?: TrackInfo['gapless'];
  timestampAdjustmentNs?: number;
  trailingDiscardPaddingNs?: number;
  chunks: readonly ChunkStruct[];
}

interface DeclaredTrackDuration {
  endMs: number;
}

/**
 * Flatten every track's chunks into one **decode**-ordered block list (ms ticks) and report the stream
 * end time (ms) for the `Duration` element. Normal positive-timeline files are rebased so their first
 * presentation timestamp sits at t=0; when declared source durations exist and only codec priming is
 * negative, the positive timeline remains anchored at zero and the priming packet is written as a signed
 * negative `SimpleBlock` relative time. Blocks are sorted by `(dtsMs, trackNumber)` — Matroska reads a
 * Cluster front-to-back and submits blocks to the decoder, so storage order must be DECODE order even
 * though each `SimpleBlock` carries a PTS timecode. The end time is the maximum source-declared
 * presentation duration when the demuxer provided one. AAC gapless edits contribute their exact
 * presentation sample count rather than the longer coded `mdhd` span; without such explicit trim facts,
 * an audio tail remains genuine declared media and must not be truncated to a shorter video track.
 * Unknown-duration tracks fall back to their packet tail.
 */
export function buildBlockTimeline(tracks: readonly TrackChunks[]): {
  blocks: TimelineBlock[];
  endMs: number;
} {
  let baseUs = Number.POSITIVE_INFINITY;
  let hasDeclaredDuration = false;
  let hasNonNegativeTimestamp = false;
  for (const t of tracks) {
    if (durationSecToMs(t.durationSec) !== undefined) hasDeclaredDuration = true;
    for (const c of t.chunks) {
      if (c.timestampUs < baseUs) baseUs = c.timestampUs;
      if (c.timestampUs >= 0) hasNonNegativeTimestamp = true;
    }
  }
  if (!Number.isFinite(baseUs)) return { blocks: [], endMs: 0 };
  if (hasDeclaredDuration && hasNonNegativeTimestamp && baseUs < 0) baseUs = 0;

  const blocks: TimelineBlock[] = [];
  const declaredDurations: DeclaredTrackDuration[] = [];
  let fallbackEndMs = 0;
  for (const t of tracks) {
    const codecDelayUs = (t.timestampAdjustmentNs ?? 0) / 1000;
    for (let chunkIndex = 0; chunkIndex < t.chunks.length; chunkIndex++) {
      const c = t.chunks[chunkIndex] as ChunkStruct;
      const isTerminal = chunkIndex === t.chunks.length - 1;
      const discardPaddingNs =
        c.discardPaddingNs ?? (isTerminal ? t.trailingDiscardPaddingNs : undefined);
      blocks.push({
        trackNumber: t.trackNumber,
        // CodecDelay is subtracted by readers, so add it back to the raw Block timestamp here. Sorting
        // remains on the actual decode clock below, keeping cross-track/B-frame ordering independent.
        timeMs: usToMs(c.timestampUs - baseUs + codecDelayUs),
        dtsMs: usToMs((c.dtsUs ?? c.timestampUs) - baseUs),
        key: c.key,
        data: c.data,
        ...(c.alpha !== undefined ? { alpha: c.alpha } : {}),
        ...(discardPaddingNs !== undefined && discardPaddingNs !== 0 ? { discardPaddingNs } : {}),
      });
    }
    const declaredEndMs = durationSecToMs(t.durationSec);
    if (declaredEndMs !== undefined) {
      const gaplessEndMs =
        t.mediaType === 'audio' &&
        t.gapless?.totalSamples !== undefined &&
        Number.isFinite(t.gapless.totalSamples) &&
        t.gapless.totalSamples > 0 &&
        t.sampleRate !== undefined &&
        Number.isFinite(t.sampleRate) &&
        t.sampleRate > 0
          ? (t.gapless.totalSamples * 1000) / t.sampleRate
          : undefined;
      declaredDurations.push({ endMs: gaplessEndMs ?? declaredEndMs });
      continue;
    }
    // Track end = last presented chunk's PTS + its duration (recovered from the prior gap if missing).
    const sorted = [...t.chunks].sort((a, b) => a.timestampUs - b.timestampUs);
    const last = sorted[sorted.length - 1];
    if (last !== undefined) {
      const lastDurUs = last.durationUs ?? lastGapUs(sorted);
      fallbackEndMs = Math.max(fallbackEndMs, usToMs(last.timestampUs + lastDurUs - baseUs));
    }
  }
  blocks.sort((a, b) => a.dtsMs - b.dtsMs || a.trackNumber - b.trackNumber);
  const declaredEndMs = declaredTimelineEndMs(declaredDurations);
  const endMs = declaredEndMs ?? fallbackEndMs;
  return { blocks, endMs };
}

function durationSecToMs(durationSec: number | undefined): number | undefined {
  return durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
    ? durationSec * 1000
    : undefined;
}

function declaredTimelineEndMs(durations: readonly DeclaredTrackDuration[]): number | undefined {
  if (durations.length === 0) return undefined;
  return durations.reduce((maxEndMs, duration) => Math.max(maxEndMs, duration.endMs), 0);
}

/** The gap between the last two presented chunks (µs), a duration estimate for the final chunk; 0 if <2. */
function lastGapUs(sortedByPts: readonly ChunkStruct[]): number {
  const n = sortedByPts.length;
  if (n < 2) return 0;
  return Math.max(
    0,
    (sortedByPts[n - 1]?.timestampUs ?? 0) - (sortedByPts[n - 2]?.timestampUs ?? 0),
  );
}

// ============ segment assembly ============

/** A finalized track's metadata + buffered packets, projected to {@link TrackEntry} + blocks. */
interface TrackState {
  readonly trackNumber: number;
  readonly mediaType: 'video' | 'audio';
  readonly codecId: string;
  readonly codecPrivate: Uint8Array | undefined;
  readonly codecDelayNs?: number;
  readonly seekPreRollNs?: number;
  /** Delay already subtracted from incoming packet timestamps; add it back when storing Blocks. */
  readonly timestampAdjustmentNs?: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly alpha: boolean;
  readonly rotation?: number;
  readonly color?: VideoColorMetadata;
  readonly fps: number | undefined;
  readonly durationSec: number | undefined;
  readonly gapless?: TrackInfo['gapless'];
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
  readonly chunks: ChunkStruct[];
}

/** Convert a WebCodecs `description` (ArrayBuffer / SharedArrayBuffer / view) to an owned `Uint8Array`. */
function toBytes(src: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  }
  return new Uint8Array(src).slice();
}

function isOpusHead(bytes: Uint8Array | undefined): bytes is Uint8Array {
  return (
    bytes !== undefined &&
    bytes.byteLength >= 19 &&
    String.fromCharCode(...bytes.subarray(0, 8)) === 'OpusHead'
  );
}

function opusHeadPreSkip(bytes: Uint8Array | undefined): number {
  if (!isOpusHead(bytes)) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(10, true);
}

function buildOpusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new CapabilityError(
      `WebM Opus without CodecPrivate needs a mono/stereo mapping-family-0 track, got ${channels}`,
      { op: { kind: 'route', id: 'mux' }, tried: ['webm', 'opus'] },
    );
  }
  if (!Number.isInteger(preSkip) || preSkip < 0 || preSkip > 0xffff) {
    throw new MediaError('mux-error', `WebM Opus pre-skip ${preSkip} is outside uint16`);
  }
  if (!Number.isInteger(inputSampleRate) || inputSampleRate <= 0) {
    throw new MediaError('mux-error', `WebM Opus input sample rate ${inputSampleRate} is invalid`);
  }
  const out = new Uint8Array(19);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  out[8] = 1;
  out[9] = channels;
  const view = new DataView(out.buffer);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true);
  out[18] = 0;
  return out;
}

function opusDelayNanoseconds(preSkip: number): number {
  return Math.round((preSkip * NANOS_PER_SECOND) / OPUS_SAMPLE_RATE);
}

function opusPrivateAndDelay(
  codecId: string,
  sourcePrivate: Uint8Array | undefined,
  gapless: TrackInfo['gapless'],
  channels: number,
  sampleRate: number,
): {
  codecPrivate: Uint8Array | undefined;
  codecDelayNs: number | undefined;
  seekPreRollNs: number | undefined;
} {
  if (codecId !== 'A_OPUS') {
    return {
      codecPrivate: sourcePrivate,
      codecDelayNs: undefined,
      seekPreRollNs: undefined,
    };
  }
  // A legacy caller with neither OpusHead nor explicit gapless facts gives us no honest pre-skip to
  // publish. Preserve the prior omission instead of fabricating an algorithmic delay.
  if (!isOpusHead(sourcePrivate) && gapless?.leadingSamples === undefined) {
    return {
      codecPrivate: sourcePrivate,
      codecDelayNs: undefined,
      seekPreRollNs: undefined,
    };
  }
  const sourcePreSkip = opusHeadPreSkip(sourcePrivate);
  const preSkip = gapless?.leadingSamples ?? sourcePreSkip;
  let codecPrivate: Uint8Array;
  if (isOpusHead(sourcePrivate) && sourcePreSkip === preSkip) {
    codecPrivate = sourcePrivate;
  } else if (isOpusHead(sourcePrivate)) {
    codecPrivate = sourcePrivate.slice();
    new DataView(codecPrivate.buffer, codecPrivate.byteOffset, codecPrivate.byteLength).setUint16(
      10,
      preSkip,
      true,
    );
  } else {
    codecPrivate = buildOpusHead(channels, preSkip, sampleRate);
  }
  return {
    codecPrivate,
    codecDelayNs: opusDelayNanoseconds(preSkip),
    seekPreRollNs: OPUS_SEEK_PREROLL_NS,
  };
}

/** Copy an immutable WebCodecs chunk into owned bytes for muxer buffering. */
function encodedChunkBytes(chunk: EncodedAudioChunk | EncodedVideoChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

function colorCode(
  value: string | null | undefined,
  values: Readonly<Record<string, number>>,
): number | undefined {
  return value === undefined || value === null ? undefined : values[value];
}

function colorFromTrack(
  info: TrackInfo,
  config: VideoDecoderConfig | undefined,
): VideoColorMetadata | undefined {
  if (info.color !== undefined) return info.color;
  const colorSpace = config?.colorSpace;
  if (colorSpace === undefined) return undefined;
  const primaries = colorCode(colorSpace.primaries, {
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    bt2020: 9,
    smpte432: 12,
  });
  const transferCharacteristics = colorCode(colorSpace.transfer, {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    'iec61966-2-1': 13,
    pq: 16,
    hlg: 18,
  });
  const matrixCoefficients = colorCode(colorSpace.matrix, {
    rgb: 0,
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    'bt2020-ncl': 9,
  });
  const range = colorSpace.fullRange === true ? 2 : colorSpace.fullRange === false ? 1 : undefined;
  if (
    primaries === undefined &&
    transferCharacteristics === undefined &&
    matrixCoefficients === undefined &&
    range === undefined
  ) {
    return undefined;
  }
  return {
    ...(matrixCoefficients !== undefined ? { matrixCoefficients } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(transferCharacteristics !== undefined ? { transferCharacteristics } : {}),
    ...(primaries !== undefined ? { primaries } : {}),
  };
}

/** Build the immutable {@link TrackState} from a track's {@link TrackInfo} (codec + WebCodecs config). */
function trackStateFrom(info: TrackInfo, trackNumber: number): TrackState {
  const codecId = toCodecId(info.mediaType, info.codec);
  const decoderConfig = info.config;
  const sourcePrivate =
    decoderConfig?.description !== undefined ? toBytes(decoderConfig.description) : undefined;
  if (info.mediaType === 'video') {
    const vc = decoderConfig as VideoDecoderConfig | undefined;
    const codecPrivate =
      codecId === 'V_VP9' || codecId === 'V_AV1'
        ? webmVideoCodecPrivate(codecId, vc?.codec ?? info.codec, sourcePrivate)
        : sourcePrivate;
    const rotation = normalizeClockwiseRotation(info.rotation);
    const color = colorFromTrack(info, vc);
    return {
      trackNumber,
      mediaType: 'video',
      codecId,
      codecPrivate,
      ...(info.codecDelayNs !== undefined ? { codecDelayNs: info.codecDelayNs } : {}),
      ...(info.seekPreRollNs !== undefined ? { seekPreRollNs: info.seekPreRollNs } : {}),
      ...(info.codecDelayNs !== undefined ? { timestampAdjustmentNs: info.codecDelayNs } : {}),
      width: vc?.codedWidth,
      height: vc?.codedHeight,
      alpha: info.alpha === true,
      ...(rotation !== undefined ? { rotation } : {}),
      ...(color !== undefined ? { color } : {}),
      fps: info.fps,
      durationSec: info.durationSec,
      sampleRate: undefined,
      channels: undefined,
      chunks: [],
    };
  }
  const ac = decoderConfig as AudioDecoderConfig | undefined;
  const opus = opusPrivateAndDelay(
    codecId,
    sourcePrivate,
    info.gapless,
    ac?.numberOfChannels ?? 0,
    ac?.sampleRate ?? OPUS_SAMPLE_RATE,
  );
  const codecDelayNs = info.codecDelayNs ?? opus.codecDelayNs;
  const seekPreRollNs = info.seekPreRollNs ?? opus.seekPreRollNs;
  return {
    trackNumber,
    mediaType: 'audio',
    codecId,
    codecPrivate: opus.codecPrivate,
    ...(codecDelayNs !== undefined ? { codecDelayNs } : {}),
    ...(seekPreRollNs !== undefined ? { seekPreRollNs } : {}),
    ...(info.codecDelayNs !== undefined ? { timestampAdjustmentNs: info.codecDelayNs } : {}),
    width: undefined,
    height: undefined,
    alpha: false,
    fps: undefined,
    durationSec: info.durationSec,
    ...(info.gapless !== undefined ? { gapless: info.gapless } : {}),
    sampleRate: ac?.sampleRate,
    channels: ac?.numberOfChannels,
    chunks: [],
  };
}

function timelineTrack(t: TrackState): TrackChunks {
  const durationSec = durationSecToMs(t.durationSec) !== undefined ? t.durationSec : undefined;
  const trailingDiscardPaddingNs = trackTrailingDiscardPaddingNs(t);
  const base = {
    trackNumber: t.trackNumber,
    mediaType: t.mediaType,
    chunks: t.chunks,
    ...(t.sampleRate !== undefined ? { sampleRate: t.sampleRate } : {}),
    ...(t.gapless !== undefined ? { gapless: t.gapless } : {}),
    ...(t.timestampAdjustmentNs !== undefined
      ? { timestampAdjustmentNs: t.timestampAdjustmentNs }
      : {}),
    ...(trailingDiscardPaddingNs !== undefined ? { trailingDiscardPaddingNs } : {}),
  };
  return durationSec !== undefined ? { ...base, durationSec } : base;
}

function trackTrailingDiscardPaddingNs(track: TrackState): number | undefined {
  const trailingSamples = track.gapless?.trailingSamples;
  if (
    track.codecId !== 'A_OPUS' ||
    trailingSamples === undefined ||
    !Number.isInteger(trailingSamples) ||
    trailingSamples <= 0
  ) {
    return undefined;
  }
  return Math.round((trailingSamples * NANOS_PER_SECOND) / OPUS_SAMPLE_RATE);
}

/** The EBML Header (`EBML`), declaring DocType (`webm`/`matroska`) + version limits. */
function ebmlHeader(docType: string, docTypeVersion: 2 | 4): Uint8Array {
  return element(
    EBML_ID.EBML,
    concatBytes([
      uintEl(EBML_ID.EBMLVersion, 1),
      uintEl(EBML_ID.EBMLReadVersion, 1),
      uintEl(EBML_ID.EBMLMaxIDLength, 4),
      uintEl(EBML_ID.EBMLMaxSizeLength, 8),
      stringEl(EBML_ID.DocType, docType),
      uintEl(EBML_ID.DocTypeVersion, docTypeVersion),
      uintEl(EBML_ID.DocTypeReadVersion, 2),
    ]),
  );
}

/** The `Info` element: TimecodeScale (ns/tick), optional Duration (ticks, float), and app identifiers. */
function infoElement(endMs: number, opts: { includeDuration?: boolean } = {}): Uint8Array {
  const includeDuration = opts.includeDuration ?? true;
  return element(
    EBML_ID.Info,
    concatBytes([
      uintEl(EBML_ID.TimecodeScale, TIMECODE_SCALE_NS),
      ...(includeDuration ? [floatEl(EBML_ID.Duration, endMs)] : []),
      stringEl(EBML_ID.MuxingApp, APP_NAME),
      stringEl(EBML_ID.WritingApp, APP_NAME),
    ]),
  );
}

function colorElement(color: VideoColorMetadata): Uint8Array | undefined {
  const parts: Uint8Array[] = [];
  const add = (id: number, value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MediaError(
        'mux-error',
        `Matroska Colour value ${value} is not a non-negative integer`,
      );
    }
    parts.push(uintEl(id, value));
  };
  add(EBML_ID.MatrixCoefficients, color.matrixCoefficients);
  add(EBML_ID.BitsPerChannel, color.bitsPerChannel);
  add(EBML_ID.ChromaSubsamplingHorz, color.chromaSubsamplingHorz);
  add(EBML_ID.ChromaSubsamplingVert, color.chromaSubsamplingVert);
  add(EBML_ID.CbSubsamplingHorz, color.cbSubsamplingHorz);
  add(EBML_ID.CbSubsamplingVert, color.cbSubsamplingVert);
  add(EBML_ID.ChromaSitingHorz, color.chromaSitingHorz);
  add(EBML_ID.ChromaSitingVert, color.chromaSitingVert);
  add(EBML_ID.Range, color.range);
  add(EBML_ID.TransferCharacteristics, color.transferCharacteristics);
  add(EBML_ID.Primaries, color.primaries);
  add(EBML_ID.MaxCLL, color.maxCll);
  add(EBML_ID.MaxFALL, color.maxFall);
  return parts.length === 0 ? undefined : element(EBML_ID.Colour, concatBytes(parts));
}

/** One `TrackEntry`: number/UID/type + CodecID(+private) + Video/Audio geometry. */
function trackEntryElement(t: TrackState): Uint8Array {
  const parts: Uint8Array[] = [
    uintEl(EBML_ID.TrackNumber, t.trackNumber),
    uintEl(EBML_ID.TrackUID, t.trackNumber),
    uintEl(EBML_ID.TrackType, t.mediaType === 'video' ? 1 : 2),
    uintEl(EBML_ID.FlagLacing, 0),
    stringEl(EBML_ID.CodecID, t.codecId),
  ];
  if (t.codecPrivate !== undefined && t.codecPrivate.byteLength > 0) {
    parts.push(element(EBML_ID.CodecPrivate, t.codecPrivate));
  }
  if (t.codecDelayNs !== undefined) parts.push(uintEl(EBML_ID.CodecDelay, t.codecDelayNs));
  if (t.seekPreRollNs !== undefined) parts.push(uintEl(EBML_ID.SeekPreRoll, t.seekPreRollNs));
  if (t.mediaType === 'video') {
    if (t.fps !== undefined && t.fps > 0) {
      parts.push(uintEl(EBML_ID.DefaultDuration, Math.round((NS_PER_MS * 1000) / t.fps)));
    }
    const roll = matroskaRollFromClockwise(t.rotation);
    const color = t.color === undefined ? undefined : colorElement(t.color);
    const alpha = t.alpha || t.chunks.some((chunk) => chunk.alpha !== undefined);
    parts.push(
      element(
        EBML_ID.Video,
        concatBytes([
          uintEl(EBML_ID.PixelWidth, t.width ?? 0),
          uintEl(EBML_ID.PixelHeight, t.height ?? 0),
          ...(alpha ? [uintEl(EBML_ID.AlphaMode, 1)] : []),
          ...(roll !== undefined && roll !== 0
            ? [element(EBML_ID.Projection, floatEl(EBML_ID.ProjectionPoseRoll, roll))]
            : []),
          ...(color !== undefined ? [color] : []),
        ]),
      ),
    );
  } else {
    parts.push(
      element(
        EBML_ID.Audio,
        concatBytes([
          floatEl(EBML_ID.SamplingFrequency, t.sampleRate ?? 0),
          uintEl(EBML_ID.Channels, t.channels ?? 0),
        ]),
      ),
    );
  }
  return element(EBML_ID.TrackEntry, concatBytes(parts));
}

/** The `Tracks` element wrapping one `TrackEntry` per track (in track-number order). */
function tracksElement(tracks: readonly TrackState[]): Uint8Array {
  return element(EBML_ID.Tracks, concatBytes(tracks.map(trackEntryElement)));
}

/** Ordered Segment-level attachments; each complete AttachedFile payload remains byte-identical. */
function attachmentsElement(attachedFilePayloads: readonly Uint8Array[]): Uint8Array | undefined {
  if (attachedFilePayloads.length === 0) return undefined;
  return element(
    EBML_ID.Attachments,
    concatBytes(attachedFilePayloads.map((payload) => element(EBML_ID.AttachedFile, payload))),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function attachmentBundlesEqual(
  left: readonly Uint8Array[],
  right: readonly Uint8Array[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftPayload = left[index];
    const rightPayload = right[index];
    if (leftPayload === undefined || rightPayload === undefined) return false;
    if (!bytesEqual(leftPayload, rightPayload)) return false;
  }
  return true;
}

/**
 * Incremental exact collector for {@link TrackInfo.containerSideData}. A demux repeats one ordered
 * attachment bundle on every track so normal selection retains it; muxing sees those repeats one track at
 * a time, snapshots the first bundle, and byte-compares later copies before emitting it exactly once.
 */
export class WebmContainerSideData {
  readonly #docType: string;
  readonly #attachmentBundles: Uint8Array[][] = [];
  readonly #seenAttachmentBundles = new WeakSet<object>();

  constructor(docType: string) {
    this.#docType = docType;
  }

  /** Ingest one track's side data; returns true when the track is only an attachment projection. */
  addTrack(info: TrackInfo): boolean {
    const sideData = info.containerSideData ?? [];
    for (let index = 0; index < sideData.length; index++) {
      const item = sideData[index];
      if (item === undefined || item.kind !== 'matroska-attachments') {
        throw new MediaError('mux-error', `unknown container side data at index ${index}`);
      }
      const payloads = item.attachedFilePayloads;
      if (
        !Array.isArray(payloads) ||
        payloads.some((payload) => !(payload instanceof Uint8Array))
      ) {
        throw new MediaError('mux-error', `invalid Matroska attachment bundle at index ${index}`);
      }
      if (payloads.length === 0) continue;
      if (this.#docType !== 'matroska') {
        throw new CapabilityError('WebM output cannot contain Matroska Attachments', {
          op: { kind: 'route', id: 'mux' },
          tried: ['webm', 'matroska-attachments'],
        });
      }
      if (this.#seenAttachmentBundles.has(item)) continue;
      this.#seenAttachmentBundles.add(item);
      if (!this.#attachmentBundles.some((existing) => attachmentBundlesEqual(existing, payloads))) {
        this.#attachmentBundles.push(payloads.map((payload) => payload.slice()));
      }
    }

    const projection = info.containerProjection;
    if (projection === undefined) return false;
    if (
      projection.kind !== 'matroska-attachment' ||
      !Number.isSafeInteger(projection.sideDataIndex) ||
      projection.sideDataIndex < 0 ||
      !Number.isSafeInteger(projection.attachmentIndex) ||
      projection.attachmentIndex < 0
    ) {
      throw new MediaError('mux-error', 'invalid Matroska attachment projection');
    }
    const bundle = sideData[projection.sideDataIndex];
    if (
      bundle?.kind !== 'matroska-attachments' ||
      bundle.attachedFilePayloads[projection.attachmentIndex] === undefined
    ) {
      throw new MediaError('mux-error', 'Matroska attachment projection has no matching side data');
    }
    return true;
  }

  /** Ordered exact AttachedFile payloads, with repeated per-track bundles collapsed once. */
  get attachedFilePayloads(): readonly Uint8Array[] {
    return this.#attachmentBundles.flat();
  }

  /**
   * Merge the legacy/manual attachment bundle with TrackInfo side data. An exact whole-bundle match is
   * one source declaration reaching the muxer through both APIs and is emitted once; partial matches stay
   * distinct because they may be intentional additional files. Duplicate files inside either bundle are
   * therefore never collapsed individually.
   */
  mergeAttachedFilePayloads(manualBundle: readonly Uint8Array[]): readonly Uint8Array[] {
    if (manualBundle.length === 0) return this.attachedFilePayloads;
    const matchingIndex = this.#attachmentBundles.findIndex((bundle) =>
      attachmentBundlesEqual(bundle, manualBundle),
    );
    if (matchingIndex < 0) return [...manualBundle, ...this.attachedFilePayloads];
    return this.#attachmentBundles.flatMap((bundle, index) =>
      index === matchingIndex ? manualBundle : bundle,
    );
  }
}

function docTypeVersionFor(tracks: readonly TrackState[]): 2 | 4 {
  return tracks.some((track) => {
    const rotation = normalizeClockwiseRotation(track.rotation);
    return (
      (rotation !== undefined && rotation !== 0) ||
      track.codecDelayNs !== undefined ||
      track.seekPreRollNs !== undefined ||
      track.color !== undefined ||
      (track.gapless?.trailingSamples ?? 0) > 0
    );
  })
    ? 4
    : 2;
}

function blockPayloadLength(block: TimelineBlock): number {
  return vintByteLength(block.trackNumber) + 2 + 1 + block.data.byteLength;
}

function blockPayloadBytes(
  block: TimelineBlock,
  clusterTimeMs: number,
  simpleBlock: boolean,
): Uint8Array {
  const rel = block.timeMs - clusterTimeMs;
  const flags = simpleBlock && block.key ? 0x80 : 0x00;
  const trackNumber = vintBytes(block.trackNumber);
  const payloadLength = trackNumber.length + 2 + 1 + block.data.byteLength;
  const out = new Uint8Array(payloadLength);
  let off = 0;
  out.set(trackNumber, off);
  off += trackNumber.length;
  out.set(int16Bytes(rel), off);
  off += 2;
  out[off++] = flags;
  out.set(block.data, off);
  return out;
}

function blockAdditionsElement(alpha: Uint8Array): Uint8Array {
  return element(
    EBML_ID.BlockAdditions,
    element(
      EBML_ID.BlockMore,
      concatBytes([uintEl(EBML_ID.BlockAddID, 1), element(EBML_ID.BlockAdditional, alpha)]),
    ),
  );
}

function blockElementLength(block: TimelineBlock): number {
  const rawBlockPayloadLength = blockPayloadLength(block);
  if (block.alpha === undefined && block.discardPaddingNs === undefined) {
    return (
      idByteLength(EBML_ID.SimpleBlock) +
      vintByteLength(rawBlockPayloadLength) +
      rawBlockPayloadLength
    );
  }
  const blockElementLength =
    idByteLength(EBML_ID.Block) + vintByteLength(rawBlockPayloadLength) + rawBlockPayloadLength;
  const referenceElementLength = block.key
    ? 0
    : idByteLength(EBML_ID.ReferenceBlock) + vintByteLength(1) + 1;
  const blockAdditionsLength =
    block.alpha === undefined ? 0 : blockAdditionsElement(block.alpha).byteLength;
  const discardPaddingLength =
    block.discardPaddingNs === undefined
      ? 0
      : intEl(EBML_ID.DiscardPadding, block.discardPaddingNs).byteLength;
  const blockGroupPayloadLength =
    blockElementLength + referenceElementLength + blockAdditionsLength + discardPaddingLength;
  return (
    idByteLength(EBML_ID.BlockGroup) +
    vintByteLength(blockGroupPayloadLength) +
    blockGroupPayloadLength
  );
}

function writeBlockElement(writer: ByteWriter, block: TimelineBlock, clusterTimeMs: number): void {
  if (block.alpha === undefined && block.discardPaddingNs === undefined) {
    const rel = block.timeMs - clusterTimeMs;
    const flags = block.key ? 0x80 : 0x00;
    const payloadLength = vintByteLength(block.trackNumber) + 2 + 1 + block.data.byteLength;
    writer.writeByte(EBML_ID.SimpleBlock);
    writer.writeVint(payloadLength);
    writer.writeVint(block.trackNumber);
    writer.writeInt16(rel);
    writer.writeByte(flags);
    writer.write(block.data);
    return;
  }

  const parts: Uint8Array[] = [
    element(EBML_ID.Block, blockPayloadBytes(block, clusterTimeMs, false)),
  ];
  if (!block.key) parts.push(element(EBML_ID.ReferenceBlock, [0x01]));
  if (block.alpha !== undefined) parts.push(blockAdditionsElement(block.alpha));
  if (block.discardPaddingNs !== undefined) {
    parts.push(intEl(EBML_ID.DiscardPadding, block.discardPaddingNs));
  }
  writer.write(element(EBML_ID.BlockGroup, concatBytes(parts)));
}

interface ClusterPlan {
  start: number;
  end: number;
  timeMs: number;
  timecodeElement: Uint8Array;
  payloadLength: number;
  totalLength: number;
}

/**
 * Plan the **decode**-ordered blocks into one or more `Cluster`s. Blocks are accumulated greedily
 * while their **presentation**-time span (max−min PTS) fits the signed int16 relative-timecode range (so
 * a long stream never overflows the `SimpleBlock` field, and a reordered B-frame whose PTS dips below a
 * sibling's still encodes a non-negative relative timecode). Each cluster opens with its absolute
 * `Timecode` set to the cluster's minimum non-negative PTS; small negative priming packets remain legal
 * signed `SimpleBlock` relatives without moving the visible timeline later.
 */
function planClusters(blocks: readonly TimelineBlock[]): ClusterPlan[] {
  const clusters: ClusterPlan[] = [];
  let i = 0;
  while (i < blocks.length) {
    const start = i;
    let minPts = blocks[i]?.timeMs ?? 0;
    let maxPts = minPts;
    i++;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b === undefined) break;
      const newMin = Math.min(minPts, b.timeMs);
      const newMax = Math.max(maxPts, b.timeMs);
      if (newMax - newMin > MAX_CLUSTER_REL_MS) break; // PTS span would overflow int16 → new cluster
      minPts = newMin;
      maxPts = newMax;
      i++;
    }
    const clusterTimeMs = Math.max(0, minPts);
    const timecodeElement = uintEl(EBML_ID.Timecode, clusterTimeMs);
    let payloadLength = timecodeElement.byteLength;
    for (let j = start; j < i; j++) {
      const b = blocks[j];
      if (b !== undefined) {
        payloadLength += blockElementLength(b);
      }
    }
    clusters.push({
      start,
      end: i,
      timeMs: clusterTimeMs,
      timecodeElement,
      payloadLength,
      totalLength: elementHeader(EBML_ID.Cluster, payloadLength).byteLength + payloadLength,
    });
  }
  return clusters;
}

function writeCluster(
  writer: ByteWriter,
  blocks: readonly TimelineBlock[],
  cluster: ClusterPlan,
): void {
  writer.write(elementHeader(EBML_ID.Cluster, cluster.payloadLength));
  writer.write(cluster.timecodeElement);
  for (let i = cluster.start; i < cluster.end; i++) {
    const block = blocks[i];
    if (block !== undefined) writeBlockElement(writer, block, cluster.timeMs);
  }
}

/** Assemble the full WebM byte stream from finalized tracks (definite sizes throughout). */
export function writeWebm(
  tracks: readonly TrackState[],
  docType: string,
  attachedFilePayloads: readonly Uint8Array[] = [],
): Uint8Array {
  const { blocks, endMs } = buildBlockTimeline(tracks.map(timelineTrack));
  const header = ebmlHeader(docType, docTypeVersionFor(tracks));
  const info = infoElement(endMs);
  const trackBytes = tracksElement(tracks);
  const attachmentBytes = attachmentsElement(attachedFilePayloads);
  const clusters = planClusters(blocks);
  const clustersLength = clusters.reduce((sum, cluster) => sum + cluster.totalLength, 0);
  const segmentPayloadLength =
    info.byteLength + trackBytes.byteLength + (attachmentBytes?.byteLength ?? 0) + clustersLength;
  const segmentHeader = elementHeader(EBML_ID.Segment, segmentPayloadLength);
  const writer = new ByteWriter(
    header.byteLength + segmentHeader.byteLength + segmentPayloadLength,
  );
  writer.write(header);
  writer.write(segmentHeader);
  writer.write(info);
  writer.write(trackBytes);
  if (attachmentBytes !== undefined) writer.write(attachmentBytes);
  for (const cluster of clusters) writeCluster(writer, blocks, cluster);
  return writer.finish();
}

// ============ fragmented / CMAF WebM (streaming output, ADR-091) ============

/**
 * The EBML "unknown size" vint, canonical 8-byte form (`0x01` + seven `0xFF`). A {@link EBML_ID.Segment}
 * written with this size has no declared length, so its Clusters can be emitted live (the streaming form
 * MediaRecorder and DASH/CMAF WebM use). The reader ({@link import('./ebml.ts').readVint}) decodes an
 * all-ones size to `-1` and {@link import('./ebml.ts').elements} then runs the element to EOF — so the
 * init segment is self-terminating and every later top-level Cluster is a sibling inside the Segment.
 */
const SEGMENT_UNKNOWN_SIZE = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/**
 * Default maximum blocks per fragment when no keyframe boundary forces a split sooner — e.g. an audio-only
 * stream, whose every packet is a sync frame, would otherwise be one unbounded Cluster. 90 mirrors the
 * MP4 fragmenter's `maxSamplesPerFragment` ({@link import('../mp4/fragment.ts')}), keeping segment sizes
 * comparable across the two containers. The int16-span bound ({@link MAX_CLUSTER_REL_MS}) still applies.
 */
const DEFAULT_MAX_BLOCKS_PER_FRAGMENT = 90;

/** Tuning for {@link planWebmFragments} / {@link fragmentWebm}. */
export interface WebmFragmentOptions {
  /** Maximum blocks per fragment before a new Cluster is forced (default {@link DEFAULT_MAX_BLOCKS_PER_FRAGMENT}). */
  maxBlocksPerFragment?: number;
}

/** A contiguous half-open block range `[start, end)` forming one fragment (one media-segment Cluster). */
export interface FragmentRange {
  start: number;
  end: number;
}

/**
 * Partition **decode**-ordered blocks ({@link buildBlockTimeline} output) into fragment ranges — each
 * becomes one top-level Cluster (a CMAF media segment). A new fragment is opened when, with the current
 * fragment already non-empty, any of:
 *   - the next block is a **video keyframe** (so every fragment after the first begins decodable — the
 *     CMAF rule; blocks are in decode order, so a keyframe's decode-predecessors already sit in the prior
 *     fragment, audio leading);
 *   - adding the block would push the fragment's **presentation-time span** (max−min PTS) past
 *     {@link MAX_CLUSTER_REL_MS} (the signed-int16 `SimpleBlock` relative-timecode bound — identical to
 *     the non-fragmented {@link planClusters} invariant, so a long stream never overflows the field);
 *   - the fragment already holds `maxBlocks` blocks (bounds audio-only / keyframe-sparse segments).
 * The ranges are contiguous and cover every block exactly once (no drop/dup). `videoKeyTrackNumbers` is
 * the set of track numbers whose keyframe flag means "start a new GOP" (video tracks only — an audio sync
 * frame is not a fragment boundary, else every audio packet would split).
 */
export function planWebmFragments(
  blocks: readonly TimelineBlock[],
  videoKeyTrackNumbers: ReadonlySet<number>,
  opts: WebmFragmentOptions = {},
): FragmentRange[] {
  const maxBlocks = Math.max(1, opts.maxBlocksPerFragment ?? DEFAULT_MAX_BLOCKS_PER_FRAGMENT);
  const ranges: FragmentRange[] = [];
  let i = 0;
  while (i < blocks.length) {
    const start = i;
    const first = blocks[i];
    if (first === undefined) break;
    let minPts = first.timeMs;
    let maxPts = first.timeMs;
    i++;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b === undefined) break;
      const isVideoKey = b.key && videoKeyTrackNumbers.has(b.trackNumber);
      if (isVideoKey) break; // a new GOP head starts a fresh, independently-decodable fragment
      const newMin = Math.min(minPts, b.timeMs);
      const newMax = Math.max(maxPts, b.timeMs);
      if (newMax - newMin > MAX_CLUSTER_REL_MS) break; // PTS span would overflow int16 → new cluster
      if (i - start >= maxBlocks) break; // per-fragment cap reached
      minPts = newMin;
      maxPts = newMax;
      i++;
    }
    ranges.push({ start, end: i });
  }
  return ranges;
}

/** Serialize one top-level `Cluster` (`Timecode` + the range's `SimpleBlock`s) as a standalone element. */
function serializeFragmentCluster(
  blocks: readonly TimelineBlock[],
  range: FragmentRange,
): Uint8Array {
  // Cluster Timecode = the fragment's minimum non-negative PTS; each block's relative timecode is then a
  // signed int16 (PTS − base), so small negative priming packets stay legal without moving the timeline.
  let minPts = Number.POSITIVE_INFINITY;
  for (let i = range.start; i < range.end; i++) {
    const b = blocks[i];
    if (b !== undefined && b.timeMs < minPts) minPts = b.timeMs;
  }
  const clusterTimeMs = Number.isFinite(minPts) ? Math.max(0, minPts) : 0;
  const timecodeElement = uintEl(EBML_ID.Timecode, clusterTimeMs);

  let payloadLength = timecodeElement.byteLength;
  for (let i = range.start; i < range.end; i++) {
    const b = blocks[i];
    if (b === undefined) continue;
    payloadLength += blockElementLength(b);
  }

  const clusterHeader = elementHeader(EBML_ID.Cluster, payloadLength);
  const writer = new ByteWriter(clusterHeader.byteLength + payloadLength);
  writer.write(clusterHeader);
  writer.write(timecodeElement);
  for (let i = range.start; i < range.end; i++) {
    const b = blocks[i];
    if (b !== undefined) writeBlockElement(writer, b, clusterTimeMs);
  }
  return writer.finish();
}

/**
 * The init segment for a streaming WebM: the EBML Header, then the `Segment` element header with an
 * **unknown size** ({@link SEGMENT_UNKNOWN_SIZE}), then `Info` + `Tracks`. The Clusters that follow are
 * Segment children emitted live. Live/append-only WebM deliberately omits `Info/Duration`: consumers can
 * derive a materialized duration from Cluster timecodes, while the layout remains MediaRecorder-like
 * (unknown duration until the stream ends).
 */
function webmInitSegment(
  tracks: readonly TrackState[],
  docType: string,
  endMs: number,
  attachedFilePayloads: readonly Uint8Array[] = [],
): Uint8Array {
  const header = ebmlHeader(docType, docTypeVersionFor(tracks));
  const info = infoElement(endMs, { includeDuration: false });
  const trackBytes = tracksElement(tracks);
  const attachmentBytes = attachmentsElement(attachedFilePayloads);
  const out = new Uint8Array(
    header.byteLength +
      idBytes(EBML_ID.Segment).length +
      SEGMENT_UNKNOWN_SIZE.byteLength +
      info.byteLength +
      trackBytes.byteLength +
      (attachmentBytes?.byteLength ?? 0),
  );
  let off = 0;
  out.set(header, off);
  off += header.byteLength;
  const segId = idBytes(EBML_ID.Segment);
  out.set(segId, off);
  off += segId.length;
  out.set(SEGMENT_UNKNOWN_SIZE, off);
  off += SEGMENT_UNKNOWN_SIZE.byteLength;
  out.set(info, off);
  off += info.byteLength;
  out.set(trackBytes, off);
  off += trackBytes.byteLength;
  if (attachmentBytes !== undefined) out.set(attachmentBytes, off);
  return out;
}

/**
 * Stream a fragmented/CMAF WebM as a sequence of byte chunks: first the **init segment** (EBML Header +
 * unknown-size `Segment` header + `Info` + `Tracks`), then one **media segment** — a complete top-level
 * `Cluster` — per fragment ({@link planWebmFragments}). Yielding incrementally keeps peak **output** memory
 * bounded to a single Cluster (the streaming-target guarantee, doc 09 streaming-output): the muxer's
 * `finalize` enqueues each yielded chunk straight to the readable, so a {@link import('../../sinks/stream-target.ts').StreamTarget}
 * writes each segment as it is produced. The block timeline (decode order, t=0 rebasing, B-frame/priming
 * handling) is the **same** {@link buildBlockTimeline} the non-fragmented path uses — only the on-disk box
 * layout (live Clusters vs one length-prefixed Segment) differs.
 */
export function* fragmentWebm(
  tracks: readonly TrackState[],
  docType: string,
  opts: WebmFragmentOptions = {},
  attachedFilePayloads: readonly Uint8Array[] = [],
): Generator<Uint8Array, void, undefined> {
  const { blocks, endMs } = buildBlockTimeline(tracks.map(timelineTrack));
  const videoKeyTrackNumbers = new Set<number>(
    tracks.filter((t) => t.mediaType === 'video').map((t) => t.trackNumber),
  );

  yield webmInitSegment(tracks, docType, endMs, attachedFilePayloads);

  for (const range of planWebmFragments(blocks, videoKeyTrackNumbers, opts)) {
    if (range.end > range.start) yield serializeFragmentCluster(blocks, range);
  }
}

/** Options for the true streaming WebM/MKV muxer used by large cross-container remux. */
export interface WebmStreamingMuxerOptions extends WebmFragmentOptions {
  /**
   * Timeline base in microseconds. Supplying the packet-table-derived value preserves the same timestamp
   * rebasing as {@link buildBlockTimeline} without buffering every packet before the first Cluster.
   */
  timelineBaseUs?: number;
}

/**
 * A bounded Cluster-on-write muxer: unlike {@link WebmMuxer}, this never stores the full packet timeline.
 * Callers add all tracks up front, then feed packets in decode order. The muxer emits the streaming init
 * segment before the first packet and flushes each bounded Cluster as soon as a keyframe/span/block-count
 * boundary is reached, so peak output memory is one Cluster plus one packet per caller-side reader.
 */
export class WebmStreamingMuxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #tracks = new Map<number, TrackState>();
  readonly #docType: string;
  readonly #containerSideData: WebmContainerSideData;
  readonly #maxBlocksPerFragment: number;
  #nextTrackNumber = 1;
  #finalized = false;
  #started = false;
  #timelineBaseUs: number | undefined;
  #currentBlocks: TimelineBlock[] = [];
  #currentMinPtsMs = 0;
  #currentMaxPtsMs = 0;
  readonly #writtenTrackNumbers = new Set<number>();
  readonly #attachmentProjectionTrackNumbers = new Set<number>();
  readonly #pullWaiters: Array<() => void> = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions & WebmStreamingMuxerOptions, docType = 'webm') {
    this.#docType = docType;
    this.#containerSideData = new WebmContainerSideData(docType);
    this.#maxBlocksPerFragment = Math.max(
      1,
      options?.maxBlocksPerFragment ?? DEFAULT_MAX_BLOCKS_PER_FRAGMENT,
    );
    this.#timelineBaseUs = options?.timelineBaseUs;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
      pull: (): void => this.#resolvePullWaiters(),
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    if (this.#started) {
      throw new MediaError(
        'mux-error',
        'cannot add a track after streaming mux output has started',
      );
    }
    const trackNumber = this.#nextTrackNumber++;
    if (this.#containerSideData.addTrack(info)) {
      this.#attachmentProjectionTrackNumbers.add(trackNumber);
      return trackNumber;
    }
    this.#tracks.set(trackNumber, trackStateFrom(info, trackNumber));
    return trackNumber;
  }

  async start(): Promise<void> {
    this.#assertOpen();
    await this.#ensureStarted();
  }

  async write(trackId: number, packet: Packet, lastInTrack = false): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; browser-harness validated. */
    if (this.#attachmentProjectionTrackNumbers.has(trackId)) return;
    const chunk = packet.chunk;
    const data = packet.data ?? encodedChunkBytes(chunk);
    await this.addChunkStruct(
      trackId,
      {
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? undefined,
        key: chunk.type === 'key',
        data,
        ...(packet.alpha !== undefined ? { alpha: encodedChunkBytes(packet.alpha) } : {}),
        ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
      },
      lastInTrack,
    );
    /* v8 ignore stop */
  }

  async addChunkStruct(trackId: number, chunk: ChunkStruct, lastInTrack = false): Promise<void> {
    this.#assertOpen();
    if (this.#attachmentProjectionTrackNumbers.has(trackId)) return;
    await this.#ensureStarted();
    const pendingFlush = this.addChunkStructStarted(trackId, chunk, lastInTrack);
    if (pendingFlush !== undefined) await pendingFlush;
  }

  addChunkStructStarted(
    trackId: number,
    chunk: ChunkStruct,
    lastInTrack = false,
  ): Promise<void> | undefined {
    this.#assertOpen();
    if (this.#attachmentProjectionTrackNumbers.has(trackId)) return undefined;
    if (!this.#started) {
      throw new MediaError('mux-error', 'streaming muxer has not started');
    }
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    const block = this.#blockFromChunk(track, chunk, lastInTrack);
    if (this.#shouldFlushBefore(block)) {
      return this.#flushCurrentCluster().then(() => {
        this.#appendBlock(block);
        this.#writtenTrackNumbers.add(trackId);
      });
    }
    this.#appendBlock(block);
    this.#writtenTrackNumbers.add(trackId);
    return undefined;
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    try {
      await this.#ensureStarted();
      if (this.#writtenTrackNumbers.size === 0) {
        throw new MediaError('mux-error', 'cannot finalize a muxer with no packets');
      }
      await this.#flushCurrentCluster();
      this.#controller?.close();
    } catch (err) {
      this.#controller?.error(err);
      throw err;
    }
  }

  fail(error: unknown): void {
    this.#finalized = true;
    this.#resolveAllPullWaiters();
    void this.#ready.then(() => this.#controller?.error(error));
  }

  async #ensureStarted(): Promise<void> {
    if (this.#started) return;
    if (this.#tracks.size === 0) {
      throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
    }
    this.#started = true;
    await this.#ready;
    const controller = this.#controller;
    if (controller === undefined) {
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    const tracks = [...this.#tracks.values()].sort((a, b) => a.trackNumber - b.trackNumber);
    await this.#enqueue(
      webmInitSegment(tracks, this.#docType, 0, this.#containerSideData.attachedFilePayloads),
    );
  }

  #blockFromChunk(track: TrackState, chunk: ChunkStruct, lastInTrack: boolean): TimelineBlock {
    const baseUs = this.#timelineBaseUs ?? chunk.timestampUs;
    this.#timelineBaseUs = baseUs;
    const discardPaddingNs =
      chunk.discardPaddingNs ?? (lastInTrack ? trackTrailingDiscardPaddingNs(track) : undefined);
    return {
      trackNumber: track.trackNumber,
      timeMs: usToMs(chunk.timestampUs - baseUs + (track.timestampAdjustmentNs ?? 0) / 1000),
      dtsMs: usToMs((chunk.dtsUs ?? chunk.timestampUs) - baseUs),
      key: chunk.key,
      data: chunk.data,
      ...(chunk.alpha !== undefined ? { alpha: chunk.alpha } : {}),
      ...(discardPaddingNs !== undefined && discardPaddingNs !== 0 ? { discardPaddingNs } : {}),
    };
  }

  #shouldFlushBefore(block: TimelineBlock): boolean {
    if (this.#currentBlocks.length === 0) return false;
    const track = this.#tracks.get(block.trackNumber);
    const isVideoKey = block.key && track?.mediaType === 'video';
    if (isVideoKey) return true;
    const newMin = Math.min(this.#currentMinPtsMs, block.timeMs);
    const newMax = Math.max(this.#currentMaxPtsMs, block.timeMs);
    if (newMax - newMin > MAX_CLUSTER_REL_MS) return true;
    return this.#currentBlocks.length >= this.#maxBlocksPerFragment;
  }

  #appendBlock(block: TimelineBlock): void {
    if (this.#currentBlocks.length === 0) {
      this.#currentMinPtsMs = block.timeMs;
      this.#currentMaxPtsMs = block.timeMs;
    } else {
      this.#currentMinPtsMs = Math.min(this.#currentMinPtsMs, block.timeMs);
      this.#currentMaxPtsMs = Math.max(this.#currentMaxPtsMs, block.timeMs);
    }
    this.#currentBlocks.push(block);
  }

  async #flushCurrentCluster(): Promise<void> {
    if (this.#currentBlocks.length === 0) return;
    const blocks = [...this.#currentBlocks].sort(
      (a, b) => a.dtsMs - b.dtsMs || a.trackNumber - b.trackNumber,
    );
    await this.#enqueue(serializeFragmentCluster(blocks, { start: 0, end: blocks.length }));
    this.#currentBlocks = [];
    this.#currentMinPtsMs = 0;
    this.#currentMaxPtsMs = 0;
  }

  async #enqueue(chunk: Uint8Array): Promise<void> {
    await this.#waitForDemand();
    this.#controller?.enqueue(chunk);
  }

  async #waitForDemand(): Promise<void> {
    await this.#ready;
    const desiredSize = this.#controller?.desiredSize;
    if (desiredSize === undefined || desiredSize === null || desiredSize > 0) return;
    await new Promise<void>((resolve) => {
      this.#pullWaiters.push(resolve);
    });
  }

  #resolvePullWaiters(): void {
    while ((this.#controller?.desiredSize ?? 0) > 0) {
      const waiter = this.#pullWaiters.shift();
      if (waiter === undefined) return;
      waiter();
    }
  }

  #resolveAllPullWaiters(): void {
    for (;;) {
      const waiter = this.#pullWaiters.shift();
      if (waiter === undefined) return;
      waiter();
    }
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}

// ============ the Muxer adapter ============

/**
 * `Muxer` over the EBML byte writer: buffers each track's packets and serializes the WebM on
 * {@link finalize}, emitting it on {@link output}. Single-shot — `addTrack`/`write` after `finalize`, and
 * a second `finalize`, are typed misuse (`mux-error`). `output` is `error()`d if finalization fails, so
 * failures surface on the reader (mirrors {@link Mp4Muxer}).
 *
 * Two on-disk layouts (ADR-091): the default emits one length-prefixed `Segment` ({@link writeWebm}) as a
 * single `output` chunk (fully seekable, faststart-like). `{ fragmented: true }` instead streams a CMAF
 * WebM — an init segment then one live top-level `Cluster` per fragment ({@link fragmentWebm}), each
 * enqueued separately so a {@link import('../../sinks/stream-target.ts').StreamTarget} writes incrementally
 * and peak **output** memory stays bounded to a single Cluster.
 */
export class WebmMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #tracks = new Map<number, TrackState>();
  readonly #attachedFilePayloads: Uint8Array[] = [];
  readonly #docType: string;
  readonly #containerSideData: WebmContainerSideData;
  readonly #fragmented: boolean;
  readonly #attachmentProjectionTrackNumbers = new Set<number>();
  #nextTrackNumber = 1;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions, docType = 'webm') {
    // Fragmented/CMAF output (ADR-091): finalize emits an init segment + one Cluster per fragment via
    // {@link fragmentWebm}, instead of the single length-prefixed Segment from {@link writeWebm}.
    this.#fragmented = options?.fragmented === true;
    this.#docType = docType;
    this.#containerSideData = new WebmContainerSideData(docType);
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    const trackNumber = this.#nextTrackNumber++;
    if (this.#containerSideData.addTrack(info)) {
      this.#attachmentProjectionTrackNumbers.add(trackNumber);
      return trackNumber;
    }
    this.#tracks.set(trackNumber, trackStateFrom(info, trackNumber));
    return trackNumber;
  }

  /**
   * Preserve one Matroska `AttachedFile` as Segment metadata. Attachments are outside the WebM subset and
   * are never accepted as media tracks or Blocks.
   */
  addAttachment(attachedFilePayload: Uint8Array): void {
    this.#assertOpen();
    if (this.#docType !== 'matroska') {
      throw new CapabilityError('WebM output cannot contain Matroska Attachments', {
        op: { kind: 'route', id: 'mux' },
        tried: ['webm', 'matroska-attachments'],
      });
    }
    this.#attachedFilePayloads.push(attachedFilePayload.slice());
  }

  /**
   * Buffer one encoded packet on its track. Extracting the bytes/timing from a real WebCodecs
   * `Encoded*Chunk` (`copyTo`) is the only browser-only step (guarded); the resulting struct flows
   * through the pure {@link addChunkStruct}, which the tests drive directly.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    if (this.#attachmentProjectionTrackNumbers.has(trackId)) return Promise.resolve();
    const chunk = packet.chunk;
    const data = packet.data ?? encodedChunkBytes(chunk);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
      ...(packet.alpha !== undefined ? { alpha: encodedChunkBytes(packet.alpha) } : {}),
      ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /**
   * Pure packet ingest: append an already-extracted {@link ChunkStruct} to its track's buffer. Shared by
   * {@link write} (after the browser-only `copyTo`) and the Node tests (which feed plain structs), so the
   * timeline + serialization are fully validated without WebCodecs.
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#attachmentProjectionTrackNumbers.has(trackId)) return;
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    track.chunks.push(chunk);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready; // the readable's `start` has run → the controller is captured
    const controller = this.#controller;
    if (controller === undefined) {
      // Unreachable: `start` resolves `#ready` and captures the controller before this awaits.
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    try {
      const tracks = this.#buildTracks();
      const attachedFilePayloads = this.#containerSideData.mergeAttachedFilePayloads(
        this.#attachedFilePayloads,
      );
      if (this.#fragmented) {
        // Stream the init segment then one top-level Cluster per fragment (bounded output memory, ADR-091).
        for (const segment of fragmentWebm(tracks, this.#docType, {}, attachedFilePayloads))
          controller.enqueue(segment);
      } else {
        controller.enqueue(writeWebm(tracks, this.#docType, attachedFilePayloads));
      }
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  /** Validate the buffered tracks and return them in track-number order for {@link writeWebm}. */
  #buildTracks(): TrackState[] {
    if (this.#tracks.size === 0) {
      throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
    }
    const out: TrackState[] = [];
    for (const [number, track] of this.#tracks) {
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${number} received no packets`);
      }
      out.push(track);
    }
    return out.sort((a, b) => a.trackNumber - b.trackNumber);
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}
