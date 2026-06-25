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

import type { EncodedChunk, MuxOptions, Muxer, TrackInfo } from '../../contracts/driver.ts';
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
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setInt16(0, n, false);
  return [buf[0] ?? 0, buf[1] ?? 0];
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
}

/** One block placed on the global, time-ordered timeline (presentation time in ms ticks). */
export interface TimelineBlock {
  trackNumber: number;
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}

/** Round µs to whole-ms ticks (the chosen TimecodeScale). */
function usToMs(us: number): number {
  return Math.round(us / MICROS_PER_MS);
}

interface TrackChunks {
  trackNumber: number;
  chunks: readonly ChunkStruct[];
}

/**
 * Flatten every track's chunks into one presentation-time-ordered block list (ms ticks), rebased so the
 * earliest block sits at t=0 (a standalone file starts at zero), and report the stream end time (ms) for
 * the `Duration` element. Blocks are sorted by `(timeMs, trackNumber)` — Matroska expects roughly
 * time-ordered blocks; each block independently carries its TrackNumber + absolute time, so the demuxer
 * recovers per-track timing regardless. The end time uses each track's last chunk duration (recovered
 * from the prior gap when the encoder omitted it), so `Duration` reflects real content, never a bare 0.
 */
export function buildBlockTimeline(tracks: readonly TrackChunks[]): {
  blocks: TimelineBlock[];
  endMs: number;
} {
  let baseUs = Number.POSITIVE_INFINITY;
  for (const t of tracks)
    for (const c of t.chunks) if (c.timestampUs < baseUs) baseUs = c.timestampUs;
  if (!Number.isFinite(baseUs)) return { blocks: [], endMs: 0 };

  const blocks: TimelineBlock[] = [];
  let endUs = baseUs;
  for (const t of tracks) {
    const sorted = [...t.chunks].sort((a, b) => a.timestampUs - b.timestampUs);
    for (const c of t.chunks) {
      blocks.push({
        trackNumber: t.trackNumber,
        timeMs: usToMs(c.timestampUs - baseUs),
        key: c.key,
        data: c.data,
      });
    }
    // Track end = last presented chunk's PTS + its duration (recovered from the prior gap if missing).
    const last = sorted[sorted.length - 1];
    if (last !== undefined) {
      const lastDurUs = last.durationUs ?? lastGapUs(sorted);
      endUs = Math.max(endUs, last.timestampUs + lastDurUs);
    }
  }
  blocks.sort((a, b) => a.timeMs - b.timeMs || a.trackNumber - b.trackNumber);
  return { blocks, endMs: usToMs(endUs - baseUs) };
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

/** The `Info` element: TimecodeScale (ns/tick), Duration (ticks, float), and the muxing/writing app. */
function infoElement(endMs: number): Uint8Array {
  return element(
    EBML_ID.Info,
    concatBytes([
      uintEl(EBML_ID.TimecodeScale, TIMECODE_SCALE_NS),
      floatEl(EBML_ID.Duration, endMs),
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

/** One `SimpleBlock`: track-number vint + int16 relative timecode + flags(keyframe) + frame bytes. */
function simpleBlock(block: TimelineBlock, clusterTimeMs: number): Uint8Array {
  const rel = block.timeMs - clusterTimeMs; // guaranteed in [0, MAX_CLUSTER_REL_MS] by the splitter
  const flags = block.key ? 0x80 : 0x00;
  const payload = concatBytes([vintBytes(block.trackNumber), int16Bytes(rel), [flags], block.data]);
  return element(EBML_ID.SimpleBlock, payload);
}

/**
 * Serialize the time-ordered blocks into one or more `Cluster`s, starting a new cluster whenever the next
 * block's time would exceed the int16 relative-timecode range (so a long stream never overflows the
 * `SimpleBlock` field). Each cluster opens with its absolute `Timecode` (ms ticks).
 */
function clusterElements(blocks: readonly TimelineBlock[]): Uint8Array {
  const clusters: Uint8Array[] = [];
  let i = 0;
  while (i < blocks.length) {
    const clusterTime = blocks[i]?.timeMs ?? 0;
    const body: Uint8Array[] = [uintEl(EBML_ID.Timecode, clusterTime)];
    while (i < blocks.length) {
      const b = blocks[i];
      if (b === undefined) break;
      if (b.timeMs - clusterTime > MAX_CLUSTER_REL_MS) break; // would overflow int16 → new cluster
      body.push(simpleBlock(b, clusterTime));
      i++;
    }
    clusters.push(element(EBML_ID.Cluster, concatBytes(body)));
  }
  return concatBytes(clusters);
}

/** Assemble the full WebM byte stream from finalized tracks (definite sizes throughout). */
export function writeWebm(tracks: readonly TrackState[], docType: string): Uint8Array {
  const { blocks, endMs } = buildBlockTimeline(
    tracks.map((t) => ({ trackNumber: t.trackNumber, chunks: t.chunks })),
  );
  const segment = element(
    EBML_ID.Segment,
    concatBytes([infoElement(endMs), tracksElement(tracks), clusterElements(blocks)]),
  );
  return concatBytes([ebmlHeader(docType), segment]);
}

// ============ the Muxer adapter ============

/**
 * `Muxer` over {@link writeWebm}: buffers each track's packets and serializes the whole WebM on
 * {@link finalize}, emitting it on {@link output}. Single-shot — `addTrack`/`write` after `finalize`, and
 * a second `finalize`, are typed misuse (`mux-error`). `output` carries the finalized bytes (one chunk)
 * and is `error()`d if finalization fails, so failures surface on the reader (mirrors {@link Mp4Muxer}).
 */
export class WebmMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #tracks = new Map<number, TrackState>();
  readonly #docType: string;
  #nextTrackNumber = 1;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions, docType = 'webm') {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'fragmented/CMAF webm mux is not supported', {
        op: { op: 'mux', fragmented: true },
        tried: ['webm'],
      });
    }
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
  write(trackId: number, chunk: EncodedChunk): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
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
      controller.enqueue(writeWebm(tracks, this.#docType));
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
