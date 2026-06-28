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

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';

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
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
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
} as const;

/** WebM default TimecodeScale: 1 ms per tick (ns). Matches {@link parseWebm}'s default. */
const TIMECODE_SCALE_NS = 1_000_000;
const NS_PER_MS = 1_000_000;
const MICROS_PER_MS = 1_000;
/**
 * A new Cluster is started before a block's timecode relative to the cluster would overflow the signed
 * int16 `SimpleBlock` field. The hard limit is 32767 ms; 30000 leaves margin (and bounds cluster size).
 */
const MAX_CLUSTER_REL_MS = 30_000;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
/**
 * Video+audio MP4 inputs often carry tiny AAC priming/padding that extends the audio track declaration
 * beyond the movie/video duration. For WebM remux metadata, keep that padding from redefining the global
 * Segment duration when a video declaration exists and the overhang is clearly codec padding, not content.
 */
const DECLARED_AV_PADDING_SLACK_MS = 250;
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

/**
 * Encode a non-negative magnitude as an EBML size/value vint: the smallest width L∈[1,8] whose value
 * range can hold `n` (the all-ones value of a width is reserved for "unknown size", so a magnitude that
 * exactly equals it rolls to the next width), with the length marker `0x80 >> (L-1)` in the first byte.
 * This is the exact inverse of {@link readVint} with `keepMarker=false`.
 */
function vintBytes(n: number): number[] {
  if (n < 0 || !Number.isFinite(n)) {
    throw new MediaError('mux-error', `cannot EBML-encode a negative/invalid length ${n}`);
  }
  for (let length = 1; length <= 8; length++) {
    const capacity = 2 ** (7 * length) - 1; // all-ones (reserved) → usable range is [0, capacity)
    if (n < capacity) {
      const out = new Array<number>(length).fill(0);
      let v = n;
      for (let i = length - 1; i >= 1; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] = (v & 0xff) | (0x80 >> (length - 1)); // remaining high bits + the length marker
      return out;
    }
  }
  throw new MediaError('mux-error', `length ${n} does not fit an 8-byte EBML vint`);
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
  throw new CapabilityError(
    'capability-miss',
    `the webm muxer cannot write ${mediaType} codec '${codec}'`,
    { op: { op: 'mux', mediaType, codec }, tried: ['webm'] },
  );
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
}

/** Round µs to whole-ms ticks (the chosen TimecodeScale). */
function usToMs(us: number): number {
  return Math.round(us / MICROS_PER_MS);
}

interface TrackChunks {
  trackNumber: number;
  mediaType?: 'video' | 'audio';
  durationSec?: number;
  chunks: readonly ChunkStruct[];
}

interface DeclaredTrackDuration {
  mediaType: 'video' | 'audio' | undefined;
  endMs: number;
}

/**
 * Flatten every track's chunks into one **decode**-ordered block list (ms ticks) and report the stream
 * end time (ms) for the `Duration` element. Normal positive-timeline files are rebased so their first
 * presentation timestamp sits at t=0; when declared source durations exist and only codec priming is
 * negative, the positive timeline remains anchored at zero and the priming packet is written as a signed
 * negative `SimpleBlock` relative time. Blocks are sorted by `(dtsMs, trackNumber)` — Matroska reads a
 * Cluster front-to-back and submits blocks to the decoder, so storage order must be DECODE order even
 * though each `SimpleBlock` carries a PTS timecode. The end time uses source-declared durations when the
 * demuxer provided them; for video+audio, a small audio overhang is treated as codec padding and the video
 * declaration wins. Unknown-duration tracks fall back to their packet tail.
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
    for (const c of t.chunks) {
      blocks.push({
        trackNumber: t.trackNumber,
        timeMs: usToMs(c.timestampUs - baseUs),
        dtsMs: usToMs((c.dtsUs ?? c.timestampUs) - baseUs),
        key: c.key,
        data: c.data,
        ...(c.alpha !== undefined ? { alpha: c.alpha } : {}),
      });
    }
    const declaredEndMs = durationSecToMs(t.durationSec);
    if (declaredEndMs !== undefined) {
      declaredDurations.push({ mediaType: t.mediaType, endMs: declaredEndMs });
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
  let maxEndMs = 0;
  let maxVideoEndMs = 0;
  for (const duration of durations) {
    maxEndMs = Math.max(maxEndMs, duration.endMs);
    if (duration.mediaType === 'video') maxVideoEndMs = Math.max(maxVideoEndMs, duration.endMs);
  }
  if (maxVideoEndMs > 0 && maxEndMs <= maxVideoEndMs + DECLARED_AV_PADDING_SLACK_MS) {
    return maxVideoEndMs;
  }
  return maxEndMs;
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
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly fps: number | undefined;
  readonly durationSec: number | undefined;
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

/** Copy an immutable WebCodecs chunk into owned bytes for muxer buffering. */
function encodedChunkBytes(chunk: EncodedAudioChunk | EncodedVideoChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

/** Build the immutable {@link TrackState} from a track's {@link TrackInfo} (codec + WebCodecs config). */
function trackStateFrom(info: TrackInfo, trackNumber: number): TrackState {
  const codecId = toCodecId(info.mediaType, info.codec);
  const decoderConfig = info.config;
  const codecPrivate =
    decoderConfig?.description !== undefined ? toBytes(decoderConfig.description) : undefined;
  if (info.mediaType === 'video') {
    const vc = decoderConfig as VideoDecoderConfig | undefined;
    return {
      trackNumber,
      mediaType: 'video',
      codecId,
      codecPrivate,
      width: vc?.codedWidth,
      height: vc?.codedHeight,
      fps: info.fps,
      durationSec: info.durationSec,
      sampleRate: undefined,
      channels: undefined,
      chunks: [],
    };
  }
  const ac = decoderConfig as AudioDecoderConfig | undefined;
  return {
    trackNumber,
    mediaType: 'audio',
    codecId,
    codecPrivate,
    width: undefined,
    height: undefined,
    fps: undefined,
    durationSec: info.durationSec,
    sampleRate: ac?.sampleRate,
    channels: ac?.numberOfChannels,
    chunks: [],
  };
}

/** The EBML Header (`EBML`), declaring DocType (`webm`/`matroska`) + version limits. */
function ebmlHeader(docType: string): Uint8Array {
  return element(
    EBML_ID.EBML,
    concatBytes([
      uintEl(EBML_ID.EBMLVersion, 1),
      uintEl(EBML_ID.EBMLReadVersion, 1),
      uintEl(EBML_ID.EBMLMaxIDLength, 4),
      uintEl(EBML_ID.EBMLMaxSizeLength, 8),
      stringEl(EBML_ID.DocType, docType),
      uintEl(EBML_ID.DocTypeVersion, 2),
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
  if (t.mediaType === 'video') {
    if (t.fps !== undefined && t.fps > 0) {
      parts.push(uintEl(EBML_ID.DefaultDuration, Math.round((NS_PER_MS * 1000) / t.fps)));
    }
    parts.push(
      element(
        EBML_ID.Video,
        concatBytes([
          uintEl(EBML_ID.PixelWidth, t.width ?? 0),
          uintEl(EBML_ID.PixelHeight, t.height ?? 0),
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

function blockPayloadLength(block: TimelineBlock): number {
  return vintBytes(block.trackNumber).length + 2 + 1 + block.data.byteLength;
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
  if (block.alpha === undefined) {
    return (
      idBytes(EBML_ID.SimpleBlock).length +
      vintBytes(rawBlockPayloadLength).length +
      rawBlockPayloadLength
    );
  }
  const blockElementLength =
    idBytes(EBML_ID.Block).length + vintBytes(rawBlockPayloadLength).length + rawBlockPayloadLength;
  const referenceElementLength = block.key
    ? 0
    : idBytes(EBML_ID.ReferenceBlock).length + vintBytes(1).length + 1;
  const blockAddId = uintEl(EBML_ID.BlockAddID, 1);
  const blockAdditionalLength =
    idBytes(EBML_ID.BlockAdditional).length +
    vintBytes(block.alpha.byteLength).length +
    block.alpha.byteLength;
  const blockMorePayloadLength = blockAddId.byteLength + blockAdditionalLength;
  const blockMoreLength =
    idBytes(EBML_ID.BlockMore).length +
    vintBytes(blockMorePayloadLength).length +
    blockMorePayloadLength;
  const blockAdditionsLength =
    idBytes(EBML_ID.BlockAdditions).length + vintBytes(blockMoreLength).length + blockMoreLength;
  const blockGroupPayloadLength =
    blockElementLength + referenceElementLength + blockAdditionsLength;
  return (
    idBytes(EBML_ID.BlockGroup).length +
    vintBytes(blockGroupPayloadLength).length +
    blockGroupPayloadLength
  );
}

function writeBlockElement(writer: ByteWriter, block: TimelineBlock, clusterTimeMs: number): void {
  if (block.alpha === undefined) {
    writer.write(element(EBML_ID.SimpleBlock, blockPayloadBytes(block, clusterTimeMs, true)));
    return;
  }

  const parts: Uint8Array[] = [
    element(EBML_ID.Block, blockPayloadBytes(block, clusterTimeMs, false)),
  ];
  if (!block.key) parts.push(element(EBML_ID.ReferenceBlock, [0x01]));
  parts.push(blockAdditionsElement(block.alpha));
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
export function writeWebm(tracks: readonly TrackState[], docType: string): Uint8Array {
  const { blocks, endMs } = buildBlockTimeline(
    tracks.map((t): TrackChunks => {
      const durationSec = durationSecToMs(t.durationSec) !== undefined ? t.durationSec : undefined;
      return durationSec !== undefined
        ? { trackNumber: t.trackNumber, mediaType: t.mediaType, durationSec, chunks: t.chunks }
        : { trackNumber: t.trackNumber, mediaType: t.mediaType, chunks: t.chunks };
    }),
  );
  const header = ebmlHeader(docType);
  const info = infoElement(endMs);
  const trackBytes = tracksElement(tracks);
  const clusters = planClusters(blocks);
  const clustersLength = clusters.reduce((sum, cluster) => sum + cluster.totalLength, 0);
  const segmentPayloadLength = info.byteLength + trackBytes.byteLength + clustersLength;
  const segmentHeader = elementHeader(EBML_ID.Segment, segmentPayloadLength);
  const writer = new ByteWriter(
    header.byteLength + segmentHeader.byteLength + segmentPayloadLength,
  );
  writer.write(header);
  writer.write(segmentHeader);
  writer.write(info);
  writer.write(trackBytes);
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
): Uint8Array {
  const header = ebmlHeader(docType);
  const info = infoElement(endMs, { includeDuration: false });
  const trackBytes = tracksElement(tracks);
  const out = new Uint8Array(
    header.byteLength +
      idBytes(EBML_ID.Segment).length +
      SEGMENT_UNKNOWN_SIZE.byteLength +
      info.byteLength +
      trackBytes.byteLength,
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
): Generator<Uint8Array, void, undefined> {
  const { blocks, endMs } = buildBlockTimeline(
    tracks.map((t): TrackChunks => {
      const durationSec = durationSecToMs(t.durationSec) !== undefined ? t.durationSec : undefined;
      return durationSec !== undefined
        ? { trackNumber: t.trackNumber, mediaType: t.mediaType, durationSec, chunks: t.chunks }
        : { trackNumber: t.trackNumber, mediaType: t.mediaType, chunks: t.chunks };
    }),
  );
  const videoKeyTrackNumbers = new Set<number>(
    tracks.filter((t) => t.mediaType === 'video').map((t) => t.trackNumber),
  );

  yield webmInitSegment(tracks, docType, endMs);

  for (const range of planWebmFragments(blocks, videoKeyTrackNumbers, opts)) {
    if (range.end > range.start) yield serializeFragmentCluster(blocks, range);
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
  readonly #docType: string;
  readonly #fragmented: boolean;
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
    this.#tracks.set(trackNumber, trackStateFrom(info, trackNumber));
    return trackNumber;
  }

  /**
   * Buffer one encoded packet on its track. Extracting the bytes/timing from a real WebCodecs
   * `Encoded*Chunk` (`copyTo`) is the only browser-only step (guarded); the resulting struct flows
   * through the pure {@link addChunkStruct}, which the tests drive directly.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    const data = encodedChunkBytes(chunk);
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
      if (this.#fragmented) {
        // Stream the init segment then one top-level Cluster per fragment (bounded output memory, ADR-091).
        for (const segment of fragmentWebm(tracks, this.#docType)) controller.enqueue(segment);
      } else {
        controller.enqueue(writeWebm(tracks, this.#docType));
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
