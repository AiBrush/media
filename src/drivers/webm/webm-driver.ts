/**
 * The WebM/MKV (EBML/Matroska) container driver — hand-written TS on top of {@link ebml}. Probe walks
 * EBML header → DocType, then Segment → Info (TimecodeScale, Duration) and Tracks (TrackEntry: type,
 * CodecID, geometry, audio params). Metadata lives at the segment start (before clusters), so a head
 * read suffices (docs/architecture/09).
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MediaType,
  type MuxOptions,
  type Muxer,
  type Packet,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { WebmMuxer } from './ebml-write.ts';
import {
  type EbmlElement,
  elements,
  findChild,
  readAscii,
  readFloat,
  readUint,
  readVint,
} from './ebml.ts';

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  TrackNumber: 0xd7,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
} as const;

/**
 * Matroska CodecID → the engine's canonical codec token (the short vocabulary the harness goldens and
 * the other container drivers use: `h264`/`hevc`/`vp8`/`vp9`/`av1`/`opus`/`vorbis`/`aac`/`mp3`/`flac`,
 * and `pcm-s16`/… for raw PCM). The full WebCodecs decode string is NOT pinned here on purpose: H.264/
 * HEVC need their `description` (avcC/hvcC) to form `avc1.PPCCLL`/`hev1…`, which the codec tier expands
 * from `config.description` (set in {@link toTrackInfo}); pinning a profile string in probe would diverge
 * from the `h264`/`hevc` goldens and still be incomplete without the level byte. VP8/VP9/AV1/Opus are
 * already their own canonical tokens. (Matroska CodecID list: matroska.org/technical/codec_specs.html.)
 */
const CODEC_MAP: Record<string, string> = {
  V_VP8: 'vp8',
  V_VP9: 'vp9',
  V_AV1: 'av1',
  A_VORBIS: 'vorbis',
  A_OPUS: 'opus',
  A_AAC: 'aac',
  A_FLAC: 'flac',
  A_AC3: 'ac-3',
  A_EAC3: 'ec-3',
  A_DTS: 'dts',
  A_TRUEHD: 'truehd',
};

/** Canonical PCM token for a Matroska raw-PCM CodecID at the track's BitDepth (matches the WAV driver). */
function pcmCodec(codecId: string, bitDepth: number | undefined): string {
  const bits = bitDepth ?? 16;
  if (codecId.startsWith('A_PCM/FLOAT')) return bits === 64 ? 'pcm-f64' : 'pcm-f32';
  // A_PCM/INT/LIT and A_PCM/INT/BIG are signed two's-complement (8-bit is unsigned by RIFF convention,
  // but Matroska PCM is signed at every depth); endianness is decided at the decode seam, not the token.
  return `pcm-s${bits}`;
}

/**
 * Map a Matroska CodecID to the canonical codec token. `bitDepth` (Matroska `BitDepth`) sizes the raw-PCM
 * token. Unrecognized ids fall back to the lowercased CodecID rather than being dropped (honest), but the
 * common families — AVC/HEVC, the VPx/AV1 set, the MPEG audio layers, and PCM — are all canonicalized.
 */
function mapCodec(codecId: string, bitDepth?: number): string {
  if (codecId.startsWith('V_MPEG4') || codecId.includes('AVC')) return 'h264';
  if (codecId.includes('HEVC') || codecId === 'V_MPEGH/ISO/HEVC') return 'hevc';
  if (codecId === 'V_MPEG2') return 'mpeg2video';
  if (codecId === 'A_MPEG/L3') return 'mp3';
  if (codecId === 'A_MPEG/L2' || codecId === 'A_MPEG/L1') return 'mp2';
  if (codecId.startsWith('A_PCM')) return pcmCodec(codecId, bitDepth);
  return CODEC_MAP[codecId] ?? codecId.toLowerCase();
}

export interface WebmTrack {
  mediaType: MediaType;
  codec: string;
  /** Matroska TrackNumber — the value carried by each (Simple)Block, used to attribute block timing. */
  trackNumber?: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /**
   * The WebCodecs decoder `description` — the codec-private bytes a decoder needs to configure. For
   * H.264 (`V_MPEG4/ISO/AVC`) the Matroska CodecPrivate **is** the `avcC` box, for HEVC
   * (`V_MPEGH/ISO/HEVC`) it **is** `hvcC`, and for AAC it is the AudioSpecificConfig that MP4 `esds`
   * / WebCodecs need. Surfacing it is what unblocks Matroska packet-copy into codec-private-aware targets.
   * For Vorbis, Matroska `CodecPrivate` is the Xiph-laced id/comment/setup header triplet that an Ogg muxer
   * needs to author a valid logical stream.
   */
  description?: Uint8Array;
}

export interface WebmInfo {
  container: string;
  durationSec: number;
  tracks: WebmTrack[];
}

/** A no-copy view of an element's raw payload bytes (`[dataStart, dataEnd)` of the source). */
function readBytes(bytes: Uint8Array, el: EbmlElement): Uint8Array {
  return bytes.subarray(el.dataStart, el.dataEnd);
}

function parseTrackEntry(bytes: Uint8Array, dv: DataView, te: EbmlElement): WebmTrack | undefined {
  let type = 0;
  let codecId = '';
  let trackNumber: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;
  let codecPrivate: Uint8Array | undefined;
  let defaultDuration = 0;

  for (const c of elements(dv, te.dataStart, te.dataEnd)) {
    if (c.id === ID.TrackType) type = readUint(dv, c);
    else if (c.id === ID.TrackNumber) trackNumber = readUint(dv, c);
    else if (c.id === ID.CodecID) codecId = readAscii(dv, c);
    else if (c.id === ID.CodecPrivate) codecPrivate = readBytes(bytes, c);
    else if (c.id === ID.DefaultDuration) defaultDuration = readUint(dv, c);
    else if (c.id === ID.Video) {
      for (const v of elements(dv, c.dataStart, c.dataEnd)) {
        if (v.id === ID.PixelWidth) width = readUint(dv, v);
        else if (v.id === ID.PixelHeight) height = readUint(dv, v);
      }
    } else if (c.id === ID.Audio) {
      for (const a of elements(dv, c.dataStart, c.dataEnd)) {
        if (a.id === ID.SamplingFrequency) sampleRate = Math.round(readFloat(dv, a));
        else if (a.id === ID.Channels) channels = readUint(dv, a);
        else if (a.id === ID.BitDepth) bitDepth = readUint(dv, a);
      }
    }
  }

  const mediaType: MediaType | undefined = type === 1 ? 'video' : type === 2 ? 'audio' : undefined;
  if (mediaType === undefined) return undefined;
  const codec = mapCodec(codecId, bitDepth);
  const fps = defaultDuration > 0 ? 1e9 / defaultDuration : undefined;
  // The CodecPrivate IS the WebCodecs/muxer `description` for codecs that need out-of-band setup:
  // H.264's `avcC`, HEVC's `hvcC`, AAC's AudioSpecificConfig, and Vorbis' Xiph-laced id/comment/setup
  // headers. VP8/VP9/AV1/Opus are self-describing for the paths this driver currently exposes, so their
  // CodecPrivate is omitted.
  const description =
    (codec === 'h264' || codec === 'hevc' || codec === 'aac' || codec === 'vorbis') &&
    codecPrivate &&
    codecPrivate.byteLength > 0
      ? codecPrivate
      : undefined;
  return {
    mediaType,
    codec,
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** A (Simple)Block's timecode relative to its cluster (int16 BE after the track-number vint). */
function blockRelTimecode(dv: DataView, el: EbmlElement): number {
  const tn = readVint(dv, el.dataStart, false);
  if (!tn || el.dataStart + tn.length + 2 > el.dataEnd) return 0;
  return dv.getInt16(el.dataStart + tn.length, false);
}

/** Scan a cluster for its end timecode (cluster Timecode + the latest block's relative timecode). */
function clusterEnd(dv: DataView, cluster: EbmlElement): number {
  let timecode = 0;
  let maxRel = 0;
  for (const c of elements(dv, cluster.dataStart, cluster.dataEnd)) {
    if (c.id === ID.Timecode) timecode = readUint(dv, c);
    else if (c.id === ID.SimpleBlock || c.id === ID.Block)
      maxRel = Math.max(maxRel, blockRelTimecode(dv, c));
    else if (c.id === ID.BlockGroup) {
      const block = findChild(dv, c.dataStart, c.dataEnd, ID.Block);
      if (block) maxRel = Math.max(maxRel, blockRelTimecode(dv, block));
    }
  }
  return timecode + maxRel;
}

/** A (Simple)Block's TrackNumber (the leading vint), or `undefined` if it can't be read. */
function blockTrackNumber(dv: DataView, el: EbmlElement): number | undefined {
  const tn = readVint(dv, el.dataStart, false);
  if (!tn || tn.value < 0) return undefined;
  return tn.value;
}

/**
 * Per-track block-timing accumulator (presentation timecodes in TimecodeScale ticks): the first and
 * last observed times plus the count. That triplet is all the cadence estimate needs — `(count − 1) /
 * (last − first)` — so we never retain the full per-block array even for long streams.
 */
interface BlockTiming {
  first: number;
  last: number;
  count: number;
}

/** Fold one block's `time` (cluster Timecode + relative) into the accumulator for its track number. */
function recordBlockTime(acc: Map<number, BlockTiming>, trackNumber: number, time: number): void {
  const prev = acc.get(trackNumber);
  if (prev === undefined) {
    acc.set(trackNumber, { first: time, last: time, count: 1 });
    return;
  }
  // Blocks are emitted in decode order, which for these streams equals presentation order; still take
  // min/max so an out-of-order block can't corrupt the span.
  prev.first = Math.min(prev.first, time);
  prev.last = Math.max(prev.last, time);
  prev.count += 1;
}

/** Accumulate every (Simple)Block's presentation time into `acc`, keyed by its TrackNumber. */
function collectClusterBlockTimes(
  dv: DataView,
  cluster: EbmlElement,
  acc: Map<number, BlockTiming>,
): void {
  let timecode = 0;
  for (const c of elements(dv, cluster.dataStart, cluster.dataEnd)) {
    if (c.id === ID.Timecode) {
      timecode = readUint(dv, c);
    } else if (c.id === ID.SimpleBlock || c.id === ID.Block) {
      const tn = blockTrackNumber(dv, c);
      if (tn !== undefined) recordBlockTime(acc, tn, timecode + blockRelTimecode(dv, c));
    } else if (c.id === ID.BlockGroup) {
      const block = findChild(dv, c.dataStart, c.dataEnd, ID.Block);
      if (block) {
        const tn = blockTrackNumber(dv, block);
        if (tn !== undefined) recordBlockTime(acc, tn, timecode + blockRelTimecode(dv, block));
      }
    }
  }
}

// ── block → encoded frames (the demux seam) ───────────────────────────────────────────────────────

/** A decoded (Simple)Block frame: its bytes + absolute presentation timestamp (µs) + keyframe flag. */
export interface WebmFrame {
  data: Uint8Array;
  timestampUs: number;
  keyframe: boolean;
}

/** The 2-bit lacing field of a (Simple)Block flags byte (bits 5-6): none / Xiph / fixed / EBML. */
type Lacing = 'none' | 'xiph' | 'ebml' | 'fixed';
function lacingOf(flags: number): Lacing {
  switch ((flags >> 1) & 0x03) {
    case 0x00:
      return 'none';
    case 0x01:
      return 'xiph';
    case 0x03:
      return 'ebml';
    default:
      return 'fixed'; // 0x02
  }
}

/** Read an unsigned EBML vint at `off` of `b` (lacing size tables); `undefined` if malformed. */
function readUVint(b: Uint8Array, off: number): { value: number; length: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return readVint(dv, off, false);
}

/**
 * Split a laced block body into individual frame byte-lengths (the bytes that follow the lacing header).
 * `bodyStart` points at the first frame's data after the `[frameCount-1]` byte + size table; the returned
 * `sizes` sum to the payload and `dataStart` is where frame 0 begins. Returns `undefined` on a malformed
 * lacing header (so the caller falls back to treating the block as a single frame — never crash).
 */
function laceSizes(
  b: Uint8Array,
  headerStart: number,
  blockEnd: number,
  lacing: Lacing,
): { sizes: number[]; dataStart: number } | undefined {
  const frameCount = (b[headerStart] ?? 0) + 1; // `number_of_frames_minus_1`
  let p = headerStart + 1;
  if (lacing === 'fixed') {
    const total = blockEnd - p;
    if (frameCount <= 0 || total % frameCount !== 0) return undefined;
    return { sizes: Array.from({ length: frameCount }, () => total / frameCount), dataStart: p };
  }
  const sizes: number[] = [];
  if (lacing === 'xiph') {
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      for (;;) {
        const byte = b[p++];
        if (byte === undefined || p > blockEnd) return undefined;
        size += byte;
        if (byte !== 0xff) break;
      }
      sizes.push(size);
    }
  } else {
    // EBML lacing: first size is an unsigned vint; each subsequent is a SIGNED vint delta from the prev.
    const first = readUVint(b, p);
    if (!first) return undefined;
    p += first.length;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const raw = readUVint(b, p);
      if (!raw) return undefined;
      // Signed-vint bias: subtract 2^(7*length - 1) - 1 to recover the signed delta.
      const bias = 2 ** (7 * raw.length - 1) - 1;
      sizes.push((sizes[sizes.length - 1] as number) + (raw.value - bias));
      p += raw.length;
    }
  }
  // The final frame fills the remaining bytes.
  const used = sizes.reduce((s, x) => s + x, 0);
  const last = blockEnd - p - used;
  if (last < 0) return undefined;
  sizes.push(last);
  return { sizes, dataStart: p };
}

/**
 * Decode one (Simple)Block (or BlockGroup's Block) into its frames. The block layout is: track-number
 * vint · int16 relative timecode · flags byte · [lacing header] · frame data. `keyframeOverride` carries
 * the BlockGroup verdict (a Block has no keyframe bit; its key-ness is "no ReferenceBlock"); for a
 * SimpleBlock the flags' bit 0x80 decides. Each frame's timestamp is `clusterTimeUs` + the block's
 * relative timecode (laced frames share the block's start time — Matroska gives no per-laced-frame time).
 */
function blockFrames(
  bytes: Uint8Array,
  dv: DataView,
  block: EbmlElement,
  clusterTimecode: number,
  timecodeScale: number,
  keyframeOverride: boolean | undefined,
): { trackNumber: number; frames: WebmFrame[] } | undefined {
  const tn = readVint(dv, block.dataStart, false);
  if (!tn || tn.value < 0) return undefined;
  const flagsOff = block.dataStart + tn.length + 2; // after the 2-byte int16 timecode
  if (flagsOff >= block.dataEnd) return undefined;
  const relTimecode = dv.getInt16(block.dataStart + tn.length, false);
  const flags = bytes[flagsOff] as number;
  const keyframe = keyframeOverride ?? (flags & 0x80) !== 0;
  const timestampUs = Math.round(((clusterTimecode + relTimecode) * timecodeScale) / 1000);
  const lacing = lacingOf(flags);
  const headerStart = flagsOff + 1;

  if (lacing === 'none') {
    return {
      trackNumber: tn.value,
      frames: [{ data: bytes.subarray(headerStart, block.dataEnd), timestampUs, keyframe }],
    };
  }
  const laced = laceSizes(bytes, headerStart, block.dataEnd, lacing);
  if (!laced) {
    // Malformed lacing header → treat the whole payload as one frame (robust, never crash/lose data).
    return {
      trackNumber: tn.value,
      frames: [{ data: bytes.subarray(headerStart, block.dataEnd), timestampUs, keyframe }],
    };
  }
  const frames: WebmFrame[] = [];
  let p = laced.dataStart;
  for (const size of laced.sizes) {
    const end = Math.min(p + size, block.dataEnd);
    // Laced frames are emitted in block order; they share the block timestamp (Matroska stores no
    // per-laced-frame timecode — a decoder derives sub-timing from the codec). Keyframe flag is shared.
    frames.push({ data: bytes.subarray(p, end), timestampUs, keyframe });
    p = end;
  }
  return { trackNumber: tn.value, frames };
}

/**
 * Walk every Cluster in the segment, decoding each (Simple)Block / BlockGroup into per-track frames in
 * file (decode) order. Returns a map TrackNumber → frames. The whole file must be read first (clusters
 * span the body). A BlockGroup's keyframe verdict is "no ReferenceBlock present".
 */
function collectFrames(
  bytes: Uint8Array,
  dv: DataView,
  segment: EbmlElement,
  timecodeScale: number,
): Map<number, WebmFrame[]> {
  const byTrack = new Map<number, WebmFrame[]>();
  const push = (parsed: { trackNumber: number; frames: WebmFrame[] } | undefined): void => {
    if (!parsed) return;
    const list = byTrack.get(parsed.trackNumber) ?? [];
    for (const f of parsed.frames) list.push(f);
    byTrack.set(parsed.trackNumber, list);
  };
  for (const el of elements(dv, segment.dataStart, segment.dataEnd)) {
    if (el.id !== ID.Cluster) continue;
    let clusterTimecode = 0;
    for (const c of elements(dv, el.dataStart, el.dataEnd)) {
      if (c.id === ID.Timecode) {
        clusterTimecode = readUint(dv, c);
      } else if (c.id === ID.SimpleBlock) {
        push(blockFrames(bytes, dv, c, clusterTimecode, timecodeScale, undefined));
      } else if (c.id === ID.BlockGroup) {
        const block = findChild(dv, c.dataStart, c.dataEnd, ID.Block);
        if (block) {
          // A Block is a keyframe iff its BlockGroup has no ReferenceBlock (it references no other frame).
          const isKeyframe = findChild(dv, c.dataStart, c.dataEnd, ID.ReferenceBlock) === undefined;
          push(blockFrames(bytes, dv, block, clusterTimecode, timecodeScale, isKeyframe));
        }
      }
    }
  }
  return byTrack;
}

// A timestamp-derived fps from MediaRecorder output carries jitter (frames land a millisecond
// early/late around a nominal integer cadence such as 24/25/30/60). We therefore snap a raw estimate
// to the nearest integer **only** when it lands within a tight relative band; otherwise the raw value
// is reported unchanged. Web captures use integer rates, so integer rounding (not an NTSC-fraction
// table) is the right quantizer here. The band is narrow enough that a genuinely fractional cadence
// (e.g. 12.5 fps) is not forced onto a neighbour — the estimate can still disagree with a wrong
// golden, so this is a quantizer, not a hardcoded answer.
const FPS_SNAP_REL_TOLERANCE = 0.02; // ±2 % — covers MediaRecorder jitter, excludes adjacent cadences

/** Snap a raw fps estimate to the nearest integer cadence within the band, else leave it unchanged. */
function snapFpsToCadence(rawFps: number): number {
  const nearest = Math.round(rawFps);
  if (nearest >= 1 && Math.abs(rawFps - nearest) / nearest <= FPS_SNAP_REL_TOLERANCE)
    return nearest;
  return rawFps;
}

/**
 * Estimate a video track's fps from its block timing when {@link parseTrackEntry} found no
 * DefaultDuration. Needs ≥ 2 blocks spanning a positive interval; returns `undefined` otherwise so the
 * field is honestly omitted rather than fabricated.
 */
function fpsFromBlockTiming(timing: BlockTiming, timecodeScale: number): number | undefined {
  if (timing.count < 2) return undefined;
  const spanSec = ((timing.last - timing.first) * timecodeScale) / 1e9;
  if (spanSec <= 0) return undefined;
  return snapFpsToCadence((timing.count - 1) / spanSec);
}

/** Parse WebM/MKV metadata from (enough of) the file head. Pure. */
export function parseWebm(bytes: Uint8Array): WebmInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let docType = 'webm';
  let segment: EbmlElement | undefined;
  for (const el of elements(dv, 0, dv.byteLength)) {
    if (el.id === ID.EBML) {
      const dt = findChild(dv, el.dataStart, el.dataEnd, ID.DocType);
      if (dt) docType = readAscii(dv, dt);
    } else if (el.id === ID.Segment) {
      segment = el;
      break;
    }
  }
  if (!segment) throw new InputError('unsupported-input', 'not a WebM/Matroska (EBML) file');

  let timecodeScale = 1_000_000;
  let duration = 0;
  let lastEndTicks = 0; // max (clusterTimecode + blockRel), used when Duration is absent (streamed)
  const tracks: WebmTrack[] = [];
  const blockTimes = new Map<number, BlockTiming>(); // TrackNumber → block-timing, for fps fallback
  for (const el of elements(dv, segment.dataStart, segment.dataEnd)) {
    if (el.id === ID.Info) {
      for (const c of elements(dv, el.dataStart, el.dataEnd)) {
        if (c.id === ID.TimecodeScale) timecodeScale = readUint(dv, c);
        else if (c.id === ID.Duration) duration = readFloat(dv, c);
      }
    } else if (el.id === ID.Tracks) {
      for (const te of elements(dv, el.dataStart, el.dataEnd)) {
        if (te.id === ID.TrackEntry) {
          const track = parseTrackEntry(bytes, dv, te);
          if (track) tracks.push(track);
        }
      }
    } else if (el.id === ID.Cluster) {
      lastEndTicks = Math.max(lastEndTicks, clusterEnd(dv, el));
      collectClusterBlockTimes(dv, el, blockTimes);
    }
  }
  if (tracks.length === 0)
    throw new MediaError('demux-error', 'WebM segment has no decodable tracks');

  // fps fallback: MediaRecorder WebM omit DefaultDuration, so a video track has no header frame rate.
  // Derive it from that track's block cadence (the clusters in this head hold enough blocks). The
  // DefaultDuration path above stays primary; this only fills a still-undefined fps (regression-safe).
  for (const track of tracks) {
    if (track.mediaType !== 'video' || track.fps !== undefined || track.trackNumber === undefined)
      continue;
    const timing = blockTimes.get(track.trackNumber);
    if (timing === undefined) continue;
    const fps = fpsFromBlockTiming(timing, timecodeScale);
    if (fps !== undefined) track.fps = fps;
  }

  // Duration when declared; otherwise derive it from the last cluster's timecode (MediaRecorder webm
  // commonly omits Duration). Never a degenerate 0 when the file clearly has content (doc 11 §5).
  const durationSec =
    duration > 0 ? (duration * timecodeScale) / 1e9 : (lastEndTicks * timecodeScale) / 1e9;
  return { container: docType === 'matroska' ? 'mkv' : 'webm', durationSec, tracks };
}

/** The full demux of a WebM/MKV: the {@link WebmInfo} plus each track's frames (by public index). */
export interface WebmDemux {
  info: WebmInfo;
  /** Per-public-track-index frames (decode order); index aligns with `info.tracks`. */
  framesByIndex: WebmFrame[][];
}

/**
 * Parse the whole file: metadata ({@link parseWebm}) + every Cluster's blocks → per-track frames. The
 * blocks are keyed in Matroska by `TrackNumber`; we remap them to the public **track index** (the array
 * position in `info.tracks`, which is also the `TrackInfo.id` the engine passes to `packets()`). Pure TS,
 * Node-validated; `packets()` adds only the browser-only `Encoded*Chunk` wrapping on top of this.
 */
export function demuxWebm(bytes: Uint8Array): WebmDemux {
  const info = parseWebm(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) throw new InputError('unsupported-input', 'not a WebM/Matroska (EBML) file');
  let timecodeScale = 1_000_000;
  const infoEl = findChild(dv, segment.dataStart, segment.dataEnd, ID.Info);
  if (infoEl) {
    const ts = findChild(dv, infoEl.dataStart, infoEl.dataEnd, ID.TimecodeScale);
    if (ts) timecodeScale = readUint(dv, ts);
  }
  const byTrackNumber = collectFrames(bytes, dv, segment, timecodeScale);
  // Remap TrackNumber → public index. A track without a TrackNumber (or with no blocks) gets an empty
  // list, so `packets()` is always a valid (possibly empty) stream rather than a missing-key surprise.
  const framesByIndex = info.tracks.map((t) =>
    t.trackNumber !== undefined ? (byTrackNumber.get(t.trackNumber) ?? []) : [],
  );
  return { info, framesByIndex };
}

function toTrackInfo(track: WebmTrack, id: number, durationSec: number): TrackInfo {
  // The CodecPrivate rides in `description`: avcC/hvcC for H.264/HEVC decode config, and Vorbis'
  // Xiph-laced setup headers for cross-container muxing into Ogg. It is a `Uint8Array`, satisfying the
  // WebCodecs `description: AllowSharedBufferSource` field where a decoder consumes it.
  const config: VideoDecoderConfig | AudioDecoderConfig =
    track.mediaType === 'video'
      ? {
          codec: track.codec,
          codedWidth: track.width ?? 0,
          codedHeight: track.height ?? 0,
          ...(track.description !== undefined ? { description: track.description } : {}),
        }
      : {
          codec: track.codec,
          sampleRate: track.sampleRate ?? 0,
          numberOfChannels: track.channels ?? 0,
          ...(track.description !== undefined ? { description: track.description } : {}),
        };
  return {
    id,
    mediaType: track.mediaType,
    codec: track.codec,
    durationSec,
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    config,
  };
}

/** Read the entire source into one buffer — demux walks every Cluster, which spans the whole file. */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Stream a track's (Simple)Block frames as WebCodecs encoded chunks. Browser-only: the `Encoded*Chunk`
 * constructors are unavailable in Node, so we raise a typed `CapabilityError` (mirroring the mp4/mpegts
 * drivers); the emission body is istanbul-ignored and validated under browser-mode (codec phase). Frame
 * order is decode order (block/file order); each chunk's `data` is a view into the parsed buffer.
 */
function packetStream(
  frames: readonly WebmFrame[],
  mediaType: MediaType,
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebM packet demux requires WebCodecs EncodedVideoChunk/EncodedAudioChunk (browser/worker only)',
      { op: 'demux', tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (codec phase) */
  const isVideo = mediaType === 'video';
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i++;
      const init = {
        type: (frame.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
        timestamp: frame.timestampUs,
        data: frame.data,
      };
      // Matroska `SimpleBlock`s carry only a presentation timecode and are stored in decode order; the
      // container has no separate DTS, so `dtsUs` is left implicit (== PTS) per the {@link Packet} contract.
      const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
      controller.enqueue({ chunk });
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (
    q.mime !== undefined &&
    (q.mime === 'video/webm' || q.mime === 'audio/webm' || q.mime === 'video/x-matroska')
  ) {
    return true;
  }
  if (
    q.extension !== undefined &&
    (q.extension === 'webm' || q.extension === 'mkv' || q.extension === 'mka')
  ) {
    return true;
  }
  const head = q.head;
  return (
    head !== undefined &&
    head.byteLength >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  );
}

export const WebmDriver: ContainerDriver = {
  id: 'webm',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['webm', 'mkv'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    // Demux reads the whole file (Clusters span the body) and decodes every (Simple)Block into per-track
    // frames; `packets()` then wraps each frame as a WebCodecs EncodedChunk (browser-gated). The metadata
    // (tracks/duration/description) comes from the same parse, so probe-fidelity carries into demux.
    const { info, framesByIndex } = demuxWebm(await readAll(src));
    const signal = o?.signal;
    return {
      tracks: info.tracks.map((t, i) => toTrackInfo(t, i, info.durationSec)),
      packets(trackId: number): ReadableStream<Packet> {
        const track = info.tracks[trackId];
        const frames = framesByIndex[trackId];
        if (!track || !frames) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(frames, track.mediaType, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over the EBML byte writer ({@link WebmMuxer}); the packet→block
    // timeline is pure + Node-validated, only the per-chunk `copyTo` is browser-only (ebml-write.ts).
    return new WebmMuxer(o, o?.container === 'mkv' ? 'matroska' : 'webm');
  },
};

export const WebmModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(WebmDriver);
  },
};

export default WebmModule;
