/**
 * The WebM/MKV (EBML/Matroska) container driver — hand-written TS on top of {@link ebml}. Probe walks
 * EBML header → DocType, then Segment → Info (TimecodeScale, Duration) and Tracks (TrackEntry: type,
 * CodecID, geometry, declared AlphaMode, audio params). Metadata lives at the segment start (before
 * clusters), so a head read suffices (docs/architecture/09).
 */

import { probeJpeg } from '../../codecs/image/probe.ts';
import {
  type ByteSource,
  type ContainerDriver,
  type ContainerSideData,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MatroskaAttachmentProjection,
  type MediaType,
  type MuxOptions,
  type Muxer,
  type Packet,
  type PacketInfoMetadata,
  type PacketInfoTable,
  type PacketMetadata,
  type PacketMetadataStats,
  type Registry,
  type StageOptions,
  type StreamCopyOptions,
  type TrackInfo,
  type VideoColorMetadata,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { clockwiseFromMatroskaRoll } from '../../util/rotation.ts';
import { h273Matrix, h273Primaries, h273Transfer } from '../mp4/codec-strings.ts';
import { type ChunkStruct, WebmMuxer } from './ebml-write.ts';
import {
  type EbmlElement,
  elements,
  findChild,
  readAscii,
  readFloat,
  readInt,
  readUint,
  readVint,
} from './ebml.ts';
import { h264MaxNumReorderFramesFromAvcC } from './h264-sps.ts';
import {
  type WebmVideoCodecQualification,
  qualifyWebmVideoCodec,
} from './video-codec-qualification.ts';
import { matchesWebm } from './webm-sniff.ts';

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  DocTypeExtension: 0x4281,
  CRC32: 0xbf,
  Void: 0xec,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  TrackNumber: 0xd7,
  Language: 0x22b59c,
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
  BitDepth: 0x6264,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Cues: 0x1c53bb6b,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAdditional: 0xa5,
  BlockAddID: 0xee,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75a2,
} as const;

const MICROS_PER_SECOND = 1_000_000;
const NANOS_PER_SECOND = 1_000_000_000;
const OPUS_SAMPLE_RATE = 48_000;
/** RFC 6716 §3.1 TOC config -> one-frame duration on Opus' fixed 48 kHz output clock. */
const OPUS_FRAME_SAMPLES: readonly number[] = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960, 120, 240,
  480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];
const FULL_RANGE_EPSILON_US = 50_000;
/** One remote read is cheaper than prefix + terminal scan below this measured transfer crossover. */
const SMALL_REMOTE_WHOLE_PROBE_MAX_BYTES = 256 * 1024;
const WEBM_METADATA_PREFIX_BYTES = [
  8 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;
const WEBM_UNKNOWN_REMOTE_METADATA_PREFIX_BYTES = [
  SMALL_REMOTE_WHOLE_PROBE_MAX_BYTES,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;
/** Ordinary EBML bootstrap read; late declarations are discovered by the bounded Segment walk. */
const WEBM_PACKET_INFO_PREFIX_BYTES = 256 * 1024;
/** A valid but unusually padded EBML Header may exceed the ordinary prefix; keep that retry bounded. */
const WEBM_PACKET_INFO_EBML_HEADER_MAX_BYTES = 1024 * 1024;
/** Four-byte EBML id plus eight-byte size: the largest legal element header. */
const EBML_ELEMENT_HEADER_MAX_BYTES = 12;
/** Reuse one packet-scale sequential window without pulling large video payload tails into metadata I/O. */
const WEBM_PACKET_INFO_RANGE_WINDOW_BYTES = 16 * 1024;
/** Codec qualification may inspect a prefix, but must never retain an arbitrarily large keyframe. */
const WEBM_PACKET_INFO_CODEC_PREFIX_BYTES = 64 * 1024;
/** Bound aggregate retained VP9/AV1 qualification bytes across an adversarial multitrack table. */
const WEBM_PACKET_INFO_CODEC_PREFIX_TOTAL_BYTES = 1024 * 1024;
/** Bound how far an AV1 access unit may be header-walked while skipping sized non-sequence OBUs. */
const WEBM_PACKET_INFO_AV1_OBU_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** Bound CPU work independently of byte span for adversarial chains of empty AV1 OBUs. */
const WEBM_PACKET_INFO_AV1_OBU_SCAN_MAX_COUNT = 1024;
/** Bound range/CPU work for adversarial Xiph size tables made of long 0xff chains. */
const WEBM_PACKET_INFO_XIPH_LACE_HEADER_MAX_BYTES = 1024 * 1024;
/** Track declarations are metadata, but an adversarial CodecPrivate must still have a fixed ceiling. */
const WEBM_PACKET_INFO_TRACKS_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Exact attachment side data is public packet-info output. Keep the complete declaration below a
 * ceiling that remains under the 64 MiB heap gate even while the response and detached copies overlap.
 */
const WEBM_PACKET_INFO_ATTACHMENTS_MAX_BYTES = 16 * 1024 * 1024;
/** Keep object/array overhead bounded even when metadata is packed with tiny declarations. */
const WEBM_PACKET_INFO_TRACK_DECLARATION_MAX_COUNT = 4096;

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
  /** Explicit Matroska `Language` value (ISO-639-2); the implicit spec default is not invented. */
  language?: string;
  /** Declared stream that is enumerable but not decodable (for example a JSON attachment). */
  nonMedia?: true;
  /** Matroska TrackNumber — the value carried by each (Simple)Block, used to attribute block timing. */
  trackNumber?: number;
  /** Codec-inherent presentation delay from TrackEntry `CodecDelay`, in nanoseconds. */
  codecDelayNs?: number;
  /** Decoder convergence preroll from TrackEntry `SeekPreRoll`, in nanoseconds. */
  seekPreRollNs?: number;
  /** H.264 SPS VUI `max_num_reorder_frames`, used to synthesize the absent Matroska DTS clock. */
  reorderDepth?: number;
  /** Source-backed bytes for an attached image stream (one key packet, timestamp zero). */
  attachmentData?: Uint8Array;
  /** Complete AttachedFile payload, retained opaquely for exact Segment-level stream copy. */
  attachedFilePayload?: Uint8Array;
  width?: number;
  height?: number;
  /** Standards-declared Matroska `Video/AlphaMode=1`; absent means metadata did not prove alpha. */
  alpha?: true;
  /** Clockwise-positive display rotation, converted from Matroska's CCW ProjectionPoseRoll. */
  rotation?: number;
  /** Raw Matroska Colour values, preserved even when WebCodecs cannot name a code point. */
  color?: VideoColorMetadata;
  /** Exact WebCodecs string established from CodecPrivate or an in-band sequence header. */
  decoderCodec?: string;
  /** Whether `decoderCodec` is proved or is an explicit non-defaulting miss token. */
  decoderCodecSource?: 'codec-private' | 'bitstream' | 'unknown';
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

function parseColor(dv: DataView, color: EbmlElement): VideoColorMetadata | undefined {
  const values: VideoColorMetadata = {};
  for (const child of elements(dv, color.dataStart, color.dataEnd)) {
    const value = readUint(dv, child);
    switch (child.id) {
      case ID.MatrixCoefficients:
        values.matrixCoefficients = value;
        break;
      case ID.BitsPerChannel:
        values.bitsPerChannel = value;
        break;
      case ID.ChromaSubsamplingHorz:
        values.chromaSubsamplingHorz = value;
        break;
      case ID.ChromaSubsamplingVert:
        values.chromaSubsamplingVert = value;
        break;
      case ID.CbSubsamplingHorz:
        values.cbSubsamplingHorz = value;
        break;
      case ID.CbSubsamplingVert:
        values.cbSubsamplingVert = value;
        break;
      case ID.ChromaSitingHorz:
        values.chromaSitingHorz = value;
        break;
      case ID.ChromaSitingVert:
        values.chromaSitingVert = value;
        break;
      case ID.Range:
        values.range = value;
        break;
      case ID.TransferCharacteristics:
        values.transferCharacteristics = value;
        break;
      case ID.Primaries:
        values.primaries = value;
        break;
      case ID.MaxCLL:
        values.maxCll = value;
        break;
      case ID.MaxFALL:
        values.maxFall = value;
        break;
      default:
        break;
    }
  }
  return Object.keys(values).length === 0 ? undefined : values;
}

function parseTrackEntry(bytes: Uint8Array, dv: DataView, te: EbmlElement): WebmTrack | undefined {
  let type = 0;
  let codecId = '';
  let trackNumber: number | undefined;
  let language: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let alphaModeDeclarations = 0;
  let declaredAlpha = false;
  let rotation: number | undefined;
  let color: VideoColorMetadata | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;
  let codecPrivate: Uint8Array | undefined;
  let defaultDuration = 0;
  let codecDelayNs = 0;
  let seekPreRollNs = 0;

  for (const c of elements(dv, te.dataStart, te.dataEnd)) {
    if (c.id === ID.TrackType) type = readUint(dv, c);
    else if (c.id === ID.TrackNumber) trackNumber = readUint(dv, c);
    else if (c.id === ID.CodecID) codecId = readAscii(dv, c);
    else if (c.id === ID.Language) {
      const declared = readAscii(dv, c).toLowerCase();
      // TrackInfo's public language vocabulary is ISO-639-2/T. LanguageIETF is deliberately not
      // projected here because an arbitrary BCP-47 tag cannot be losslessly represented by that seam.
      if (/^[a-z]{3}$/.test(declared)) language = declared;
    } else if (c.id === ID.CodecPrivate) codecPrivate = readBytes(bytes, c);
    else if (c.id === ID.DefaultDuration) defaultDuration = readUint(dv, c);
    else if (c.id === ID.CodecDelay) codecDelayNs = readUint(dv, c);
    else if (c.id === ID.SeekPreRoll) seekPreRollNs = readUint(dv, c);
    else if (c.id === ID.Video) {
      for (const v of elements(dv, c.dataStart, c.dataEnd)) {
        if (v.id === ID.PixelWidth) width = readUint(dv, v);
        else if (v.id === ID.PixelHeight) height = readUint(dv, v);
        else if (v.id === ID.AlphaMode) {
          alphaModeDeclarations++;
          const byteLength = v.dataEnd - v.dataStart;
          declaredAlpha =
            alphaModeDeclarations === 1 &&
            c.complete &&
            v.complete &&
            !v.unknownSize &&
            byteLength >= 1 &&
            byteLength <= 8 &&
            readUint(dv, v) === 1;
        } else if (v.id === ID.Projection) {
          for (const projection of elements(dv, v.dataStart, v.dataEnd)) {
            if (projection.id !== ID.ProjectionPoseRoll) continue;
            const clockwise = clockwiseFromMatroskaRoll(readFloat(dv, projection));
            if (clockwise !== undefined) rotation = clockwise;
          }
        } else if (v.id === ID.Colour) color = parseColor(dv, v);
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
  // H.264's `avcC`, HEVC's `hvcC`, AAC's AudioSpecificConfig, Vorbis' Xiph-laced id/comment/setup
  // headers, native FLAC metadata prelude, and Opus' mandatory RFC 7845 OpusHead. VP8/VP9/AV1 are
  // self-describing for the paths this driver exposes, so their CodecPrivate is omitted.
  const videoQualification =
    (codec === 'vp9' || codec === 'av1') && codecPrivate !== undefined
      ? qualifyWebmVideoCodec({ codec, codecPrivate })
      : undefined;
  const description =
    videoQualification?.description ??
    ((codec === 'h264' ||
      codec === 'hevc' ||
      codec === 'aac' ||
      codec === 'vorbis' ||
      codec === 'flac' ||
      codec === 'opus') &&
    codecPrivate &&
    codecPrivate.byteLength > 0
      ? codecPrivate
      : undefined);
  const reorderDepth =
    codec === 'h264' && description !== undefined
      ? h264MaxNumReorderFramesFromAvcC(description)
      : undefined;
  return {
    mediaType,
    codec,
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(codecDelayNs > 0 ? { codecDelayNs } : {}),
    ...(seekPreRollNs > 0 ? { seekPreRollNs } : {}),
    ...(reorderDepth !== undefined ? { reorderDepth } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(declaredAlpha ? { alpha: true } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(videoQualification !== undefined
      ? {
          decoderCodec: videoQualification.codec,
          decoderCodecSource: videoQualification.source,
        }
      : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** Parse Matroska `Attachments` into declared streams plus exact ordered stream-copy payloads. */
function parseAttachments(
  bytes: Uint8Array,
  dv: DataView,
  attachmentsElement: EbmlElement,
  maxAttachedFiles = Number.POSITIVE_INFINITY,
): WebmTrack[] {
  const tracks: WebmTrack[] = [];
  let attachedFileCount = 0;
  for (const attachedFile of elements(
    dv,
    attachmentsElement.dataStart,
    attachmentsElement.dataEnd,
  )) {
    if (attachedFile.id !== ID.AttachedFile) continue;
    attachedFileCount++;
    if (attachedFileCount > maxAttachedFiles) {
      throw packetInfoMetadataCountLimit('AttachedFile', attachedFileCount, maxAttachedFiles);
    }
    if (!attachedFile.complete || attachedFile.unknownSize) {
      throw new MediaError('demux-error', 'Matroska AttachedFile is truncated or unknown-sized');
    }
    let filename = '';
    let mime = '';
    let data: Uint8Array | undefined;
    for (const child of elements(dv, attachedFile.dataStart, attachedFile.dataEnd)) {
      if (child.id === ID.FileName) {
        filename = readAscii(dv, child);
      } else if (child.id === ID.FileMimeType) {
        mime = readAscii(dv, child).toLowerCase();
      } else if (child.id === ID.FileData) data = readBytes(bytes, child);
    }
    const attachedFilePayload = readBytes(bytes, attachedFile);

    const jpegDeclared = mime === 'image/jpeg' || /\.(?:jpe?g)$/i.test(filename);
    if (jpegDeclared && data !== undefined) {
      try {
        const image = probeJpeg(data);
        tracks.push({
          mediaType: 'video',
          codec: 'mjpeg',
          width: image.width,
          height: image.height,
          // FFmpeg exposes Matroska attached pictures on its 90 kHz synthetic stream clock.
          fps: 90_000,
          attachmentData: data,
          attachedFilePayload,
        });
        continue;
      } catch {
        // A declared JPEG with invalid bytes is still a real attachment, but not a decodable video.
      }
    }
    tracks.push({ mediaType: 'audio', codec: '', nonMedia: true, attachedFilePayload });
  }
  return tracks;
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

/** Retain at most one sequence-bearing access-unit view/prefix per track for codec qualification. */
function collectFirstKeyframes(
  bytes: Uint8Array,
  dv: DataView,
  cluster: EbmlElement,
  firstKeyframes: Map<number, Uint8Array>,
): void {
  const retain = (
    block: EbmlElement,
    keyframe: boolean | undefined,
    allowUnprovenCandidate = false,
  ): void => {
    const parsed = blockFrames(
      bytes,
      dv,
      block,
      0,
      1_000_000,
      0,
      false,
      keyframe,
      undefined,
      undefined,
    );
    if (parsed === undefined || firstKeyframes.has(parsed.trackNumber)) return;
    // An incomplete BlockGroup cannot yet prove keyframe status from the absence of a later
    // ReferenceBlock. Its available leading payload is still safe as a qualification candidate:
    // VP9 validates frame_type+sync code and AV1 requires a sequence-header OBU. Inter/truncated data
    // therefore stays unqualified and makes the metadata ladder grow exactly as before.
    const frame = allowUnprovenCandidate
      ? parsed.frames[0]
      : parsed.frames.find((candidate) => candidate.keyframe);
    if (frame !== undefined) firstKeyframes.set(parsed.trackNumber, frame.data);
  };

  for (const child of elements(dv, cluster.dataStart, cluster.dataEnd)) {
    if (child.id === ID.SimpleBlock) {
      retain(child, undefined);
    } else if (child.id === ID.BlockGroup) {
      const block = findChild(dv, child.dataStart, child.dataEnd, ID.Block);
      if (block !== undefined) {
        const complete = child.complete;
        retain(
          block,
          complete
            ? findChild(dv, child.dataStart, child.dataEnd, ID.ReferenceBlock) === undefined
            : undefined,
          !complete,
        );
      }
    }
  }
}

// ── block → encoded frames (the demux seam) ───────────────────────────────────────────────────────

/** A decoded (Simple)Block frame: its bytes + absolute presentation timestamp (µs) + keyframe flag. */
export interface WebmFrame {
  data: Uint8Array;
  /** VPx alpha side-data bytes from Matroska BlockAdditions (BlockAddID=1), when present. */
  alpha?: Uint8Array;
  /** Signed Matroska BlockGroup DiscardPadding, in nanoseconds. */
  discardPaddingNs?: number;
  /** Explicit BlockDuration projected to microseconds, when authored by the container. */
  durationUs?: number;
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
  codecDelayNs: number,
  preserveSubTickCodecDelay: boolean,
  keyframeOverride: boolean | undefined,
  alpha: Uint8Array | undefined,
  discardPaddingNs: number | undefined,
  blockDurationTicks?: number,
): { trackNumber: number; frames: WebmFrame[] } | undefined {
  const tn = readVint(dv, block.dataStart, false);
  if (!tn || tn.value < 0) return undefined;
  const flagsOff = block.dataStart + tn.length + 2; // after the 2-byte int16 timecode
  if (flagsOff >= block.dataEnd) return undefined;
  const relTimecode = dv.getInt16(block.dataStart + tn.length, false);
  const flags = bytes[flagsOff] as number;
  const keyframe = keyframeOverride ?? (flags & 0x80) !== 0;
  // Track timestamps are `(BlockTimestamp * TimestampScale) - CodecDelay`. Opus needs the exact
  // sub-tick 48 kHz delay so demux -> mux can reproduce its canonical 312-sample pre-skip. Other
  // Matroska codecs expose timestamps on the Segment timebase, matching ffprobe and their declared
  // packet clock, so quantize the adjusted value back to a complete Segment tick.
  const presentationNs = (clusterTimecode + relTimecode) * timecodeScale - codecDelayNs;
  const roundedTimestampUs = preserveSubTickCodecDelay
    ? Math.round(presentationNs / 1000)
    : Math.round((Math.round(presentationNs / timecodeScale) * timecodeScale) / 1000);
  const timestampUs = Object.is(roundedTimestampUs, -0) ? 0 : roundedTimestampUs;
  const blockDurationUs =
    blockDurationTicks !== undefined
      ? Math.round((blockDurationTicks * timecodeScale) / 1000)
      : undefined;
  const lacing = lacingOf(flags);
  const headerStart = flagsOff + 1;

  if (lacing === 'none') {
    const frame: WebmFrame = {
      data: bytes.subarray(headerStart, block.dataEnd),
      timestampUs,
      keyframe,
      ...(blockDurationUs !== undefined && blockDurationUs > 0
        ? { durationUs: blockDurationUs }
        : {}),
      ...(alpha !== undefined ? { alpha } : {}),
      ...(discardPaddingNs !== undefined && discardPaddingNs !== 0 ? { discardPaddingNs } : {}),
    };
    return {
      trackNumber: tn.value,
      frames: [frame],
    };
  }
  const laced = laceSizes(bytes, headerStart, block.dataEnd, lacing);
  if (!laced) {
    // Malformed lacing header → treat the whole payload as one frame (robust, never crash/lose data).
    return {
      trackNumber: tn.value,
      frames: [
        {
          data: bytes.subarray(headerStart, block.dataEnd),
          timestampUs,
          keyframe,
          ...(blockDurationUs !== undefined && blockDurationUs > 0
            ? { durationUs: blockDurationUs }
            : {}),
          ...(alpha !== undefined ? { alpha } : {}),
          ...(discardPaddingNs !== undefined && discardPaddingNs !== 0 ? { discardPaddingNs } : {}),
        },
      ],
    };
  }
  const frames: WebmFrame[] = [];
  const frameDurationUs =
    blockDurationUs !== undefined && blockDurationUs > 0
      ? Math.round(blockDurationUs / laced.sizes.length)
      : undefined;
  let p = laced.dataStart;
  for (let index = 0; index < laced.sizes.length; index++) {
    const size = laced.sizes[index] as number;
    const end = Math.min(p + size, block.dataEnd);
    // Laced frames are emitted in block order; they share the block timestamp (Matroska stores no
    // per-laced-frame timecode — a decoder derives sub-timing from the codec). Keyframe flag is shared.
    const carriesDiscardPadding =
      discardPaddingNs !== undefined &&
      discardPaddingNs !== 0 &&
      (discardPaddingNs < 0 ? index === 0 : index === laced.sizes.length - 1);
    frames.push({
      data: bytes.subarray(p, end),
      timestampUs,
      keyframe,
      ...(frameDurationUs !== undefined && frameDurationUs > 0
        ? { durationUs: frameDurationUs }
        : {}),
      ...(carriesDiscardPadding ? { discardPaddingNs } : {}),
    });
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
  codecDelayByTrackNumber: ReadonlyMap<
    number,
    { readonly nanoseconds: number; readonly preserveSubTick: boolean }
  >,
): CollectedWebmFrames {
  const byTrack = new Map<number, WebmFrame[]>();
  const blockTimes = new Map<number, BlockTiming>();
  let lastEndTicks = 0;
  const codecDelayForBlock = (
    block: EbmlElement,
  ): { readonly nanoseconds: number; readonly preserveSubTick: boolean } => {
    const trackNumber = blockTrackNumber(dv, block);
    return trackNumber === undefined
      ? { nanoseconds: 0, preserveSubTick: false }
      : (codecDelayByTrackNumber.get(trackNumber) ?? {
          nanoseconds: 0,
          preserveSubTick: false,
        });
  };
  const push = (parsed: { trackNumber: number; frames: WebmFrame[] } | undefined): void => {
    if (!parsed) return;
    const list = byTrack.get(parsed.trackNumber) ?? [];
    for (const f of parsed.frames) list.push(f);
    byTrack.set(parsed.trackNumber, list);
  };
  for (const el of completeSegmentElements(dv, segment)) {
    if (el.id !== ID.Cluster) continue;
    let clusterTimecode = 0;
    for (const c of elements(dv, el.dataStart, el.dataEnd)) {
      if (c.id === ID.Timecode) {
        clusterTimecode = readUint(dv, c);
      } else if (c.id === ID.SimpleBlock) {
        const trackNumber = blockTrackNumber(dv, c);
        if (trackNumber !== undefined) {
          const blockTime = clusterTimecode + blockRelTimecode(dv, c);
          recordBlockTime(blockTimes, trackNumber, blockTime);
          lastEndTicks = Math.max(lastEndTicks, blockTime);
        }
        const delay = codecDelayForBlock(c);
        push(
          blockFrames(
            bytes,
            dv,
            c,
            clusterTimecode,
            timecodeScale,
            delay.nanoseconds,
            delay.preserveSubTick,
            undefined,
            undefined,
            undefined,
          ),
        );
      } else if (c.id === ID.BlockGroup) {
        const block = findChild(dv, c.dataStart, c.dataEnd, ID.Block);
        if (block) {
          const trackNumber = blockTrackNumber(dv, block);
          if (trackNumber !== undefined) {
            const blockTime = clusterTimecode + blockRelTimecode(dv, block);
            recordBlockTime(blockTimes, trackNumber, blockTime);
            lastEndTicks = Math.max(lastEndTicks, blockTime);
          }
          // A Block is a keyframe iff its BlockGroup has no ReferenceBlock (it references no other frame).
          const isKeyframe = findChild(dv, c.dataStart, c.dataEnd, ID.ReferenceBlock) === undefined;
          const discardPadding = findChild(dv, c.dataStart, c.dataEnd, ID.DiscardPadding);
          const blockDuration = findChild(dv, c.dataStart, c.dataEnd, ID.BlockDuration);
          const delay = codecDelayForBlock(block);
          push(
            blockFrames(
              bytes,
              dv,
              block,
              clusterTimecode,
              timecodeScale,
              delay.nanoseconds,
              delay.preserveSubTick,
              isKeyframe,
              readMainBlockAdditional(bytes, dv, c.dataStart, c.dataEnd),
              discardPadding === undefined ? undefined : readInt(dv, discardPadding),
              blockDuration === undefined ? undefined : readUint(dv, blockDuration),
            ),
          );
        }
      }
    }
  }
  return { byTrackNumber: byTrack, blockTimes, lastEndTicks };
}

function readMainBlockAdditional(
  bytes: Uint8Array,
  dv: DataView,
  start: number,
  end: number,
): Uint8Array | undefined {
  const blockAdditions = findChild(dv, start, end, ID.BlockAdditions);
  if (blockAdditions === undefined) return undefined;
  for (const blockMore of elements(dv, blockAdditions.dataStart, blockAdditions.dataEnd)) {
    if (blockMore.id !== ID.BlockMore) continue;
    let addId = 1;
    let data: Uint8Array | undefined;
    for (const child of elements(dv, blockMore.dataStart, blockMore.dataEnd)) {
      if (child.id === ID.BlockAddID) addId = readUint(dv, child);
      else if (child.id === ID.BlockAdditional) data = readBytes(bytes, child).slice();
    }
    if (addId === 1 && data !== undefined) return data;
  }
  return undefined;
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
interface ParseWebmOptions {
  readonly scanClusters?: boolean;
  /** Whether to scan only the leading clusters needed to qualify VP9/AV1 without CodecPrivate. */
  readonly scanFirstKeyframes?: boolean;
  /** Whole-container size, used only as a conservative VP9 bitrate upper bound during prefix probe. */
  readonly sourceSizeBytes?: number;
}

interface EbmlHeaderFacts {
  readonly docType: 'webm' | 'matroska';
  readonly maxIdLength: number;
  readonly maxSizeLength: number;
}

function ebmlHeaderError(reason: string): InputError {
  return new InputError(`not a WebM/Matroska file (invalid EBML header: ${reason})`);
}

function headerUint(dv: DataView, element: EbmlElement, name: string): number {
  const length = element.dataEnd - element.dataStart;
  if (!element.complete || length < 1 || length > 8) {
    throw ebmlHeaderError(`${name} is truncated or has an invalid width`);
  }
  return readUint(dv, element);
}

/** Validate the RFC 8794 header before trusting any Matroska body element. */
function parseEbmlHeader(dv: DataView, header: EbmlElement): EbmlHeaderFacts {
  if (!header.complete) throw ebmlHeaderError('the leading header is truncated');
  let ebmlVersion = 1;
  let ebmlReadVersion = 1;
  let maxIdLength = 4;
  let maxSizeLength = 8;
  let docType: string | undefined;
  let docTypeVersion = 1;
  let docTypeReadVersion = 1;
  let parsedEnd = header.dataStart;
  const seen = new Set<number>();

  for (const child of elements(dv, header.dataStart, header.dataEnd)) {
    parsedEnd = child.dataEnd;
    const mayRepeat = child.id === ID.Void || child.id === ID.DocTypeExtension;
    if (!mayRepeat && seen.has(child.id)) {
      throw ebmlHeaderError(`duplicate element 0x${child.id.toString(16)}`);
    }
    seen.add(child.id);
    switch (child.id) {
      case ID.EBMLVersion:
        ebmlVersion = headerUint(dv, child, 'EBMLVersion');
        break;
      case ID.EBMLReadVersion:
        ebmlReadVersion = headerUint(dv, child, 'EBMLReadVersion');
        break;
      case ID.EBMLMaxIDLength:
        maxIdLength = headerUint(dv, child, 'EBMLMaxIDLength');
        break;
      case ID.EBMLMaxSizeLength:
        maxSizeLength = headerUint(dv, child, 'EBMLMaxSizeLength');
        break;
      case ID.DocType:
        if (!child.complete) throw ebmlHeaderError('DocType is truncated');
        docType = readAscii(dv, child);
        break;
      case ID.DocTypeVersion:
        docTypeVersion = headerUint(dv, child, 'DocTypeVersion');
        break;
      case ID.DocTypeReadVersion:
        docTypeReadVersion = headerUint(dv, child, 'DocTypeReadVersion');
        break;
      case ID.CRC32:
        if (!child.complete || child.dataEnd - child.dataStart !== 4) {
          throw ebmlHeaderError('CRC-32 must contain exactly four bytes');
        }
        break;
      case ID.Void:
      case ID.DocTypeExtension:
        if (!child.complete) throw ebmlHeaderError('contains a truncated extension element');
        break;
      default:
        throw ebmlHeaderError(`contains unknown element 0x${child.id.toString(16)}`);
    }
  }

  if (parsedEnd !== header.dataEnd) throw ebmlHeaderError('contains malformed trailing bytes');
  if (ebmlVersion !== 1 || ebmlReadVersion !== 1) {
    throw ebmlHeaderError(`unsupported EBML version ${ebmlVersion}/${ebmlReadVersion}`);
  }
  if (maxIdLength !== 4) {
    throw ebmlHeaderError(`EBMLMaxIDLength must be 4, received ${maxIdLength}`);
  }
  if (maxSizeLength < 1 || maxSizeLength > 8) {
    throw ebmlHeaderError(`EBMLMaxSizeLength ${maxSizeLength} is outside 1..8`);
  }
  if (docType !== 'webm' && docType !== 'matroska') {
    throw ebmlHeaderError(`DocType '${docType ?? ''}' is not webm or matroska`);
  }
  if (
    docTypeVersion < 1 ||
    docTypeReadVersion < 1 ||
    docTypeReadVersion > docTypeVersion ||
    docTypeReadVersion > 4
  ) {
    throw ebmlHeaderError(`unsupported DocType version ${docTypeVersion}/${docTypeReadVersion}`);
  }
  return { docType, maxIdLength, maxSizeLength };
}

export function parseWebm(bytes: Uint8Array, options: ParseWebmOptions = {}): WebmInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanClusters = options.scanClusters ?? true;
  const scanFirstKeyframes = options.scanFirstKeyframes ?? true;
  let docType: 'webm' | 'matroska' | undefined;
  let maxIdLength = 4;
  let maxSizeLength = 8;
  let segment: EbmlElement | undefined;
  let expectedSegmentStart: number | undefined;
  let topLevelIndex = 0;
  for (const el of elements(dv, 0, dv.byteLength)) {
    if (topLevelIndex === 0 && (el.id !== ID.EBML || !el.complete)) {
      throw new InputError('not a WebM/Matroska file (missing complete leading EBML header)');
    }
    topLevelIndex += 1;
    if (el.id === ID.EBML) {
      const header = parseEbmlHeader(dv, el);
      docType = header.docType;
      maxIdLength = header.maxIdLength;
      maxSizeLength = header.maxSizeLength;
      expectedSegmentStart = el.dataEnd;
    } else if (el.id === ID.Segment) {
      if (topLevelIndex !== 2 || expectedSegmentStart === undefined) {
        throw ebmlHeaderError('the Segment does not immediately follow the EBML header');
      }
      const id = readVint(dv, expectedSegmentStart, true);
      const size =
        id === undefined ? undefined : readVint(dv, expectedSegmentStart + id.length, false);
      if (
        id === undefined ||
        size === undefined ||
        id.value !== ID.Segment ||
        id.length > maxIdLength ||
        size.length > maxSizeLength
      ) {
        throw ebmlHeaderError('the Segment exceeds the declared id/size limits');
      }
      segment = el;
      break;
    }
  }
  if (topLevelIndex === 0 || docType === undefined) {
    throw new InputError('not a WebM/Matroska file (missing complete leading EBML header)');
  }
  if (!segment) throw new InputError('not a WebM/Matroska (EBML) file');

  let timecodeScale = 1_000_000;
  let duration = 0;
  let lastEndTicks = 0; // max (clusterTimecode + blockRel), used when Duration is absent (streamed)
  const tracks: WebmTrack[] = [];
  const blockTimes = new Map<number, BlockTiming>(); // TrackNumber → block-timing, for fps fallback
  const firstKeyframes = new Map<number, Uint8Array>();
  let keyframeTrackNumbers: readonly number[] = [];
  for (const el of segmentElements(dv, segment, false)) {
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
      keyframeTrackNumbers = tracks.flatMap((track) =>
        track.mediaType === 'video' &&
        (track.codec === 'vp9' || track.codec === 'av1') &&
        track.trackNumber !== undefined &&
        track.decoderCodecSource !== 'codec-private'
          ? [track.trackNumber]
          : [],
      );
    } else if (el.id === ID.Attachments) {
      tracks.push(...parseAttachments(bytes, dv, el));
    } else if (el.id === ID.Cluster) {
      // Even metadata-only prefix probes inspect one complete key access unit when VP9/AV1 private
      // data is absent. This is bounded by the prefix ladder and does not retain packet tables.
      if (
        scanFirstKeyframes &&
        keyframeTrackNumbers.some((trackNumber) => !firstKeyframes.has(trackNumber))
      ) {
        collectFirstKeyframes(bytes, dv, el, firstKeyframes);
      }
      if (scanClusters) {
        lastEndTicks = Math.max(lastEndTicks, clusterEnd(dv, el));
        collectClusterBlockTimes(dv, el, blockTimes);
      }
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
  for (const track of tracks) {
    if (
      track.mediaType !== 'video' ||
      (track.codec !== 'vp9' && track.codec !== 'av1') ||
      track.decoderCodecSource === 'codec-private'
    ) {
      continue;
    }
    const firstKeyframe =
      track.trackNumber === undefined ? undefined : firstKeyframes.get(track.trackNumber);
    let qualification: WebmVideoCodecQualification;
    try {
      qualification = qualifyWebmVideoCodec({
        codec: track.codec,
        ...(firstKeyframe !== undefined ? { firstKeyframe } : {}),
        ...(track.width !== undefined ? { width: track.width } : {}),
        ...(track.height !== undefined ? { height: track.height } : {}),
        ...(track.fps !== undefined ? { fps: track.fps } : {}),
        sourceSizeBytes: options.sourceSizeBytes ?? bytes.byteLength,
        ...(durationSec > 0 ? { durationSec } : {}),
      });
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
      qualification = {
        codec: track.codec === 'vp9' ? 'vp09' : 'av01',
        source: 'unknown' as const,
      };
    }
    track.decoderCodec = qualification.codec;
    track.decoderCodecSource = qualification.source;
    if (qualification.description !== undefined) track.description = qualification.description;
  }
  return { container: docType === 'matroska' ? 'mkv' : 'webm', durationSec, tracks };
}

/** The full demux of a WebM/MKV: the {@link WebmInfo} plus each track's frames (by public index). */
export interface WebmDemux {
  info: WebmInfo;
  /** Per-public-track-index frames (decode order); index aligns with `info.tracks`. */
  framesByIndex: WebmFrame[][];
}

interface CollectedWebmFrames {
  readonly byTrackNumber: Map<number, WebmFrame[]>;
  readonly blockTimes: Map<number, BlockTiming>;
  readonly lastEndTicks: number;
}

export interface WebmPacketPayloadMetadata extends PacketInfoMetadata {
  /** Packet bytes as a view into the parsed source buffer. */
  readonly data: Uint8Array;
  /** VPx alpha side-data bytes as a source-buffer view, when present. */
  readonly alpha?: Uint8Array;
}

export interface WebmPacketPayloadInfoTable {
  readonly tracks: readonly TrackInfo[];
  readonly packets: readonly WebmPacketPayloadMetadata[];
}

/**
 * Yield the complete top-level Segment walk while validating each finite element. `elements()`
 * intentionally stops at an invalid vint so bounded metadata probes can retry with a larger prefix; a
 * full-file demux cannot treat that stop as EOF because doing so accepts a destroyed late element header
 * after otherwise usable Clusters. Unknown-size Clusters remain legal and end at the next Segment-level
 * sibling when a streaming author writes consecutive clusters.
 */
const SEGMENT_LEVEL_IDS = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Attachments,
  ID.Chapters,
  ID.Tags,
]);

/**
 * Resolve an unknown-size Cluster's end at the next element that is valid only at Segment level.
 * MediaRecorder commonly writes several consecutive unknown-size Clusters. EBML's generic iterator
 * cannot infer element levels, so treating the first Cluster as the Segment remainder silently drops
 * every later GOP. Walking complete child headers keeps payload bytes opaque and makes the boundary
 * standards-derived rather than a byte-pattern scan.
 */
function unknownClusterEnd(dv: DataView, start: number, limit: number): number {
  let offset = start;
  while (offset < limit) {
    const id = readVint(dv, offset, true);
    if (id === undefined) return limit;
    if (SEGMENT_LEVEL_IDS.has(id.value)) return offset;
    const size = readVint(dv, offset + id.length, false);
    if (size === undefined) return limit;
    const dataStart = offset + id.length + size.length;
    if (size.value < 0 || dataStart > limit) return limit;
    const dataEnd = dataStart + size.value;
    if (!Number.isSafeInteger(dataEnd) || dataEnd <= offset || dataEnd > limit) return limit;
    offset = dataEnd;
  }
  return limit;
}

/** Iterate Segment-level elements, including consecutive unknown-size MediaRecorder Clusters. */
function* segmentElements(
  dv: DataView,
  segment: EbmlElement,
  strict: boolean,
): Generator<EbmlElement> {
  if (!segment.complete && !segment.unknownSize) {
    if (strict) throw new MediaError('demux-error', 'WebM Segment is truncated');
  }

  let offset = segment.dataStart;
  while (offset < segment.dataEnd) {
    const id = readVint(dv, offset, true);
    if (id === undefined) {
      if (strict) {
        throw new MediaError('demux-error', `invalid EBML element id at Segment offset ${offset}`);
      }
      return;
    }
    const size = readVint(dv, offset + id.length, false);
    if (size === undefined) {
      if (strict) {
        throw new MediaError(
          'demux-error',
          `invalid EBML element size at Segment offset ${offset}`,
        );
      }
      return;
    }
    const dataStart = offset + id.length + size.length;
    if (dataStart > segment.dataEnd) {
      if (strict) {
        throw new MediaError(
          'demux-error',
          `truncated EBML element header at Segment offset ${offset}`,
        );
      }
      return;
    }
    if (size.value < 0) {
      if (id.value !== ID.Cluster) {
        throw new MediaError(
          'demux-error',
          `unknown-sized non-Cluster element 0x${id.value.toString(16)} in WebM Segment`,
        );
      }
      const dataEnd = unknownClusterEnd(dv, dataStart, segment.dataEnd);
      yield {
        id: id.value,
        dataStart,
        dataEnd,
        complete: false,
        unknownSize: true,
      };
      if (dataEnd >= segment.dataEnd) return;
      offset = dataEnd;
      continue;
    }
    const dataEnd = dataStart + size.value;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > segment.dataEnd) {
      if (!strict && Number.isSafeInteger(dataEnd) && dataEnd >= dataStart) {
        yield {
          id: id.value,
          dataStart,
          dataEnd: segment.dataEnd,
          complete: false,
          unknownSize: false,
        };
        return;
      }
      throw new MediaError(
        'demux-error',
        `EBML element 0x${id.value.toString(16)} escapes the WebM Segment`,
      );
    }
    yield {
      id: id.value,
      dataStart,
      dataEnd,
      complete: true,
      unknownSize: false,
    };
    offset = dataEnd;
  }
  if (offset !== segment.dataEnd) {
    if (strict) throw new MediaError('demux-error', 'WebM Segment has malformed trailing bytes');
  }
}

function* completeSegmentElements(dv: DataView, segment: EbmlElement): Generator<EbmlElement> {
  yield* segmentElements(dv, segment, true);
}

/**
 * Parse the whole file: metadata ({@link parseWebm}) + every Cluster's blocks → per-track frames. The
 * blocks are keyed in Matroska by `TrackNumber`; we remap them to the public **track index** (the array
 * position in `info.tracks`, which is also the `TrackInfo.id` the engine passes to `packets()`). Pure TS,
 * Node-validated; `packets()` adds only the browser-only `Encoded*Chunk` wrapping on top of this.
 */
export function demuxWebm(bytes: Uint8Array): WebmDemux {
  const info = parseWebm(bytes, {
    scanClusters: false,
    scanFirstKeyframes: true,
    sourceSizeBytes: bytes.byteLength,
  });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) throw new InputError('not a WebM/Matroska (EBML) file');
  let timecodeScale = 1_000_000;
  const infoEl = findChild(dv, segment.dataStart, segment.dataEnd, ID.Info);
  if (infoEl) {
    const ts = findChild(dv, infoEl.dataStart, infoEl.dataEnd, ID.TimecodeScale);
    if (ts) timecodeScale = readUint(dv, ts);
  }
  const codecDelayByTrackNumber = new Map<
    number,
    { readonly nanoseconds: number; readonly preserveSubTick: boolean }
  >();
  for (const track of info.tracks) {
    if (track.trackNumber !== undefined && track.codecDelayNs !== undefined) {
      codecDelayByTrackNumber.set(track.trackNumber, {
        nanoseconds: track.codecDelayNs,
        preserveSubTick: track.codec === 'opus',
      });
    }
  }
  const collected = collectFrames(bytes, dv, segment, timecodeScale, codecDelayByTrackNumber);
  const byTrackNumber = collected.byTrackNumber;
  if (info.durationSec <= 0) {
    info.durationSec = (collected.lastEndTicks * timecodeScale) / 1e9;
  }
  for (const track of info.tracks) {
    if (track.mediaType !== 'video' || track.fps !== undefined || track.trackNumber === undefined)
      continue;
    const timing = collected.blockTimes.get(track.trackNumber);
    const fps = timing === undefined ? undefined : fpsFromBlockTiming(timing, timecodeScale);
    if (fps !== undefined) track.fps = fps;
  }
  for (const track of info.tracks) {
    if (
      track.mediaType !== 'video' ||
      (track.codec !== 'vp9' && track.codec !== 'av1') ||
      track.decoderCodecSource === 'codec-private' ||
      track.trackNumber === undefined
    ) {
      continue;
    }
    const frames = byTrackNumber.get(track.trackNumber) ?? [];
    const firstKeyframe = frames.find((frame) => frame.keyframe) ?? frames[0];
    try {
      const qualification = qualifyWebmVideoCodec({
        codec: track.codec,
        ...(firstKeyframe === undefined ? {} : { firstKeyframe: firstKeyframe.data }),
        ...(track.width === undefined ? {} : { width: track.width }),
        ...(track.height === undefined ? {} : { height: track.height }),
        ...(track.fps === undefined ? {} : { fps: track.fps }),
        sourceSizeBytes: bytes.byteLength,
        ...(info.durationSec > 0 ? { durationSec: info.durationSec } : {}),
      });
      track.decoderCodec = qualification.codec;
      track.decoderCodecSource = qualification.source;
      if (qualification.description !== undefined) track.description = qualification.description;
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
      track.decoderCodec = track.codec === 'vp9' ? 'vp09' : 'av01';
      track.decoderCodecSource = 'unknown';
    }
  }
  // Remap TrackNumber → public index. A track without a TrackNumber (or with no blocks) gets an empty
  // list, so `packets()` is always a valid (possibly empty) stream rather than a missing-key surprise.
  const framesByIndex = info.tracks.map((track): WebmFrame[] => {
    if (track.attachmentData !== undefined) {
      return [{ data: track.attachmentData, timestampUs: 0, keyframe: true }];
    }
    return track.trackNumber !== undefined ? (byTrackNumber.get(track.trackNumber) ?? []) : [];
  });
  const declaredBlockTrackNumbers = info.tracks.flatMap((track) =>
    track.trackNumber === undefined ? [] : [track.trackNumber],
  );
  const hasDeclaredMediaBlock = declaredBlockTrackNumbers.some(
    (trackNumber) => (byTrackNumber.get(trackNumber)?.length ?? 0) > 0,
  );
  if (
    (declaredBlockTrackNumbers.length > 0 && !hasDeclaredMediaBlock) ||
    framesByIndex.every((frames) => frames.length === 0)
  ) {
    throw new MediaError(
      'demux-error',
      'WebM segment declares media tracks but contains no media blocks',
    );
  }
  return { info, framesByIndex };
}

function sourceViewOffset(source: Uint8Array, view: Uint8Array): number | undefined {
  if (view.buffer !== source.buffer) return undefined;
  const offset = view.byteOffset - source.byteOffset;
  if (offset < 0 || offset + view.byteLength > source.byteLength) return undefined;
  return offset;
}

interface WebmPacketMetadataRow extends PacketMetadata {
  readonly offset?: number;
}

/** Reduce retained WebM frames to constant-sized evidence without constructing packet rows. */
function webmTrackPacketStats(
  frames: readonly WebmFrame[],
  sourceDurationUs: number | undefined,
  reorderDepth: number,
): PacketMetadataStats | undefined {
  if (frames.length === 0) return undefined;
  let totalSizeBytes = 0;
  let presentationStartUs = Number.POSITIVE_INFINITY;
  let largestPtsUs = Number.NEGATIVE_INFINITY;
  let secondLargestPtsUs = Number.NEGATIVE_INFINITY;
  let terminalFrameNeedsInferredDuration = false;
  let explicitPresentationEndUs = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (!Number.isFinite(frame.timestampUs) || frame.data.byteLength <= 0) return undefined;
    totalSizeBytes += frame.data.byteLength;
    if (!Number.isSafeInteger(totalSizeBytes)) return undefined;
    presentationStartUs = Math.min(presentationStartUs, frame.timestampUs);
    if (frame.timestampUs > largestPtsUs) {
      secondLargestPtsUs = largestPtsUs;
      largestPtsUs = frame.timestampUs;
      terminalFrameNeedsInferredDuration = !(
        frame.durationUs !== undefined && frame.durationUs > 0
      );
    } else if (frame.timestampUs === largestPtsUs) {
      terminalFrameNeedsInferredDuration ||= !(
        frame.durationUs !== undefined && frame.durationUs > 0
      );
    } else if (frame.timestampUs < largestPtsUs && frame.timestampUs > secondLargestPtsUs) {
      secondLargestPtsUs = frame.timestampUs;
    }
    if (frame.durationUs !== undefined && frame.durationUs > 0) {
      explicitPresentationEndUs = Math.max(
        explicitPresentationEndUs,
        frame.timestampUs + frame.durationUs,
      );
    }
  }
  const inferredTerminalDurationUs = terminalFrameNeedsInferredDuration
    ? Number.isFinite(secondLargestPtsUs)
      ? largestPtsUs - secondLargestPtsUs
      : sourceDurationUs !== undefined && sourceDurationUs > largestPtsUs
        ? sourceDurationUs - largestPtsUs
        : undefined
    : undefined;
  const presentationEndUs = Math.max(
    explicitPresentationEndUs,
    inferredTerminalDurationUs === undefined
      ? Number.NEGATIVE_INFINITY
      : largestPtsUs + inferredTerminalDurationUs,
  );
  if (!Number.isFinite(presentationEndUs) || presentationEndUs <= presentationStartUs) {
    return undefined;
  }
  // Matroska Block order is decode order. The legacy packet table's DTS reconstruction sorts every PTS,
  // so a reordered track cannot publish exact decode bounds without packet-count auxiliary storage.
  // Omit those optional fields; rate planning deliberately falls back to this exact presentation span.
  return {
    packetCount: frames.length,
    totalSizeBytes,
    ...(reorderDepth > 0
      ? {}
      : { decodeStartUs: presentationStartUs, decodeEndUs: presentationEndUs }),
    presentationStartUs,
    presentationEndUs,
  };
}

function packetMetadataRows(
  bytes: Uint8Array,
  tracks: readonly WebmTrack[],
  framesByIndex: readonly (readonly WebmFrame[])[],
  sourceDurationUs: number | undefined,
): readonly WebmPacketMetadataRow[] {
  const rows: WebmPacketMetadataRow[] = [];
  for (let trackIndex = 0; trackIndex < framesByIndex.length; trackIndex++) {
    const frames = framesByIndex[trackIndex];
    const track = tracks[trackIndex];
    if (frames === undefined || track === undefined) continue;
    const codecDefinesAudioSync = track.codec === 'opus' || track.codec === 'vorbis';
    const reorderDepth = track.reorderDepth ?? 0;
    const presentationTimeline =
      reorderDepth > 0 ? frames.map((frame) => frame.timestampUs).sort((a, b) => a - b) : undefined;
    const durationsUs = frameDurationsUs(frames, sourceDurationUs);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      if (frame === undefined) continue;
      const durationUs = durationsUs[frameIndex];
      if (durationUs === undefined) {
        throw new MediaError(
          'demux-error',
          `WebM packet ${frameIndex} on track ${trackIndex} has no exact duration`,
        );
      }
      const dtsUs =
        presentationTimeline !== undefined && frameIndex >= reorderDepth
          ? (presentationTimeline[frameIndex - reorderDepth] ?? frame.timestampUs)
          : frame.timestampUs;
      const offset = sourceViewOffset(bytes, frame.data);
      rows.push({
        trackId: trackIndex,
        sizeBytes: frame.data.byteLength,
        ptsUs: frame.timestampUs,
        dtsUs,
        durationUs,
        keyframe: codecDefinesAudioSync || frame.keyframe,
        ...(offset !== undefined ? { offset } : {}),
      });
    }
  }
  return rows.sort(
    (left, right) =>
      (left.offset ?? Number.POSITIVE_INFINITY) - (right.offset ?? Number.POSITIVE_INFINITY),
  );
}

function packetPayloadRows(
  bytes: Uint8Array,
  tracks: readonly WebmTrack[],
  framesByIndex: readonly (readonly WebmFrame[])[],
  sourceDurationUs: number | undefined,
): WebmPacketPayloadMetadata[] {
  const rows: WebmPacketPayloadMetadata[] = [];
  for (let trackIndex = 0; trackIndex < framesByIndex.length; trackIndex++) {
    const frames = framesByIndex[trackIndex];
    if (frames === undefined) continue;
    const track = tracks[trackIndex];
    const codecDefinesAudioSync = track?.codec === 'opus' || track?.codec === 'vorbis';
    const reorderDepth = track?.reorderDepth ?? 0;
    const presentationTimeline =
      reorderDepth > 0 ? frames.map((frame) => frame.timestampUs).sort((a, b) => a - b) : undefined;
    const durationsUs = frameDurationsUs(frames, sourceDurationUs);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (frame === undefined) continue;
      const offset = sourceViewOffset(bytes, frame.data);
      const durationUs = durationsUs[i];
      const dtsUs =
        presentationTimeline !== undefined && i >= reorderDepth
          ? (presentationTimeline[i - reorderDepth] ?? frame.timestampUs)
          : frame.timestampUs;
      rows.push({
        trackIndex,
        ...(offset !== undefined ? { offset } : {}),
        size: frame.data.byteLength,
        ptsUs: frame.timestampUs,
        dtsUs,
        ...(durationUs !== undefined ? { durationUs } : {}),
        // FFmpeg derives sync status from the self-contained Opus/Vorbis packet syntax even when the
        // video-oriented block key bit is clear. Other Matroska audio codecs retain container flags.
        keyframe: codecDefinesAudioSync || frame.keyframe,
        data: frame.data,
        ...(frame.alpha !== undefined ? { alpha: frame.alpha } : {}),
      });
    }
  }
  // Per-track arrays are useful to `packets(trackId)`, but packet-info is a container-wide table. Sort
  // source-backed views by their actual byte position to restore Matroska's global block/decode order.
  return rows.sort(
    (a, b) => (a.offset ?? Number.POSITIVE_INFINITY) - (b.offset ?? Number.POSITIVE_INFINITY),
  );
}

export function webmPacketPayloadInfoFromBytes(bytes: Uint8Array): WebmPacketPayloadInfoTable {
  const { info, framesByIndex } = demuxWebm(bytes);
  const sourceDurationUs =
    info.durationSec > 0 ? Math.round(info.durationSec * MICROS_PER_SECOND) : undefined;
  return {
    tracks: toTrackInfos(info, framesByIndex),
    packets: packetPayloadRows(bytes, info.tracks, framesByIndex, sourceDurationUs),
  };
}

interface WebmSegmentRange {
  readonly dataStart: number;
  readonly dataEnd: number;
}

interface WebmPacketInfoBootstrap {
  readonly container: 'webm' | 'mkv';
  readonly segment: WebmSegmentRange;
}

interface WebmElementRange extends WebmSegmentRange {
  readonly id: number;
  readonly unknownSize: boolean;
}

interface ScannedWebmFrame extends WebmFrame {
  readonly offset: number;
  readonly size: number;
}

const EMPTY_PACKET_DATA = new Uint8Array(0);

type FiniteRangeByteSource = ByteSource & {
  readonly size: number;
  readonly range: NonNullable<ByteSource['range']>;
};

function copyWebmTrack(track: WebmTrack): WebmTrack {
  return {
    ...track,
    ...(track.color !== undefined ? { color: { ...track.color } } : {}),
    ...(track.description !== undefined ? { description: track.description.slice() } : {}),
    ...(track.attachmentData !== undefined ? { attachmentData: track.attachmentData.slice() } : {}),
    ...(track.attachedFilePayload !== undefined
      ? { attachedFilePayload: track.attachedFilePayload.slice() }
      : {}),
  };
}

async function readPacketInfoRange(
  src: ByteSource & { readonly range: NonNullable<ByteSource['range']> },
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  assertNotAborted(signal);
  const bytes = await src.range(start, end, signal);
  try {
    assertNotAborted(signal);
    const expected = end - start;
    if (bytes.byteLength !== expected) {
      throw new InputError(
        `WebM source returned ${bytes.byteLength} bytes for range [${start}, ${end}), expected ${expected}`,
      );
    }
    return bytes;
  } catch (error) {
    // The awaited request did return an owned view, but validation prevented ownership from reaching
    // the caller's `finally`. Return that exact response here, including the post-read abort race.
    src.releaseRange?.(bytes);
    throw error;
  }
}

/**
 * One-response read-ahead cursor for the packet-info EBML walk. Returned views are valid only until the
 * next cache miss or {@link close}; callers consume them synchronously and copy the few bytes that escape.
 */
class WebmPacketInfoRangeReader {
  #response: Uint8Array | undefined;
  #responseStart = 0;

  constructor(
    private readonly src: FiniteRangeByteSource,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async read(start: number, end: number, readAheadLimit: number): Promise<Uint8Array> {
    assertNotAborted(this.signal);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(readAheadLimit) ||
      start < 0 ||
      end < start ||
      end > readAheadLimit ||
      readAheadLimit > this.src.size
    ) {
      throw new MediaError(
        'demux-error',
        `invalid WebM packet-info range [${start}, ${end}) within ${readAheadLimit}`,
      );
    }
    if (start === end) return EMPTY_PACKET_DATA;

    const response = this.#response;
    const responseEnd = this.#responseStart + (response?.byteLength ?? 0);
    if (response !== undefined && start >= this.#responseStart && end <= responseEnd) {
      return response.subarray(start - this.#responseStart, end - this.#responseStart);
    }

    this.#release();
    const requestedLength = end - start;
    const physicalEnd =
      requestedLength >= WEBM_PACKET_INFO_RANGE_WINDOW_BYTES
        ? end
        : Math.min(readAheadLimit, start + WEBM_PACKET_INFO_RANGE_WINDOW_BYTES);
    const loaded = await readPacketInfoRange(this.src, start, physicalEnd, this.signal);
    this.#response = loaded;
    this.#responseStart = start;
    return loaded.subarray(0, requestedLength);
  }

  close(): void {
    this.#release();
  }

  #release(): void {
    const response = this.#response;
    this.#response = undefined;
    this.#responseStart = 0;
    if (response !== undefined) this.src.releaseRange?.(response);
  }
}

function packetInfoBootstrapFromBytes(
  bytes: Uint8Array,
  sourceSize: number,
): WebmPacketInfoBootstrap {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = elements(dv, 0, dv.byteLength).next().value;
  if (first === undefined || first.id !== ID.EBML || !first.complete) {
    throw new InputError('not a WebM/Matroska file (missing complete leading EBML header)');
  }
  const header = parseEbmlHeader(dv, first);
  const id = readVint(dv, first.dataEnd, true);
  const size = id === undefined ? undefined : readVint(dv, first.dataEnd + id.length, false);
  if (
    id === undefined ||
    size === undefined ||
    id.value !== ID.Segment ||
    id.length > header.maxIdLength ||
    size.length > header.maxSizeLength
  ) {
    throw ebmlHeaderError('the Segment does not immediately follow the EBML header');
  }
  const dataStart = first.dataEnd + id.length + size.length;
  const dataEnd = size.value < 0 ? sourceSize : dataStart + size.value;
  if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > sourceSize) {
    throw new MediaError('demux-error', 'WebM Segment escapes the declared source size');
  }
  return {
    container: header.docType === 'matroska' ? 'mkv' : 'webm',
    segment: { dataStart, dataEnd },
  };
}

async function packetInfoBootstrapFromPrefix(
  src: FiniteRangeByteSource,
  prefix: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<WebmPacketInfoBootstrap> {
  const dv = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const id = readVint(dv, 0, true);
  const size = id === undefined ? undefined : readVint(dv, id.length, false);
  if (id === undefined || size === undefined || id.value !== ID.EBML || size.value < 0) {
    throw new InputError('not a WebM/Matroska file (missing complete leading EBML header)');
  }
  const headerEnd = id.length + size.length + size.value;
  if (!Number.isSafeInteger(headerEnd) || headerEnd > src.size) {
    throw new InputError('not a WebM/Matroska file (the leading EBML header is truncated)');
  }
  if (headerEnd > WEBM_PACKET_INFO_EBML_HEADER_MAX_BYTES) {
    throw packetInfoMetadataLimit('EBML Header', headerEnd, WEBM_PACKET_INFO_EBML_HEADER_MAX_BYTES);
  }
  const neededEnd = Math.min(src.size, headerEnd + EBML_ELEMENT_HEADER_MAX_BYTES);
  if (neededEnd <= prefix.byteLength) {
    return packetInfoBootstrapFromBytes(prefix, src.size);
  }
  const headerAndSegment = await readPacketInfoRange(src, 0, neededEnd, signal);
  try {
    return packetInfoBootstrapFromBytes(headerAndSegment, src.size);
  } finally {
    src.releaseRange?.(headerAndSegment);
  }
}

async function readWebmElementRange(
  reader: WebmPacketInfoRangeReader,
  offset: number,
  limit: number,
  readAhead = true,
): Promise<WebmElementRange> {
  const headerEnd = Math.min(limit, offset + EBML_ELEMENT_HEADER_MAX_BYTES);
  const bytes = await reader.read(offset, headerEnd, readAhead ? limit : headerEnd);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = readVint(dv, 0, true);
  const size = id === undefined ? undefined : readVint(dv, id.length, false);
  if (id === undefined || size === undefined) {
    throw new MediaError('demux-error', `invalid EBML element header at Segment offset ${offset}`);
  }
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.value < 0 ? limit : dataStart + size.value;
  if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > limit) {
    throw new MediaError(
      'demux-error',
      `EBML element 0x${id.value.toString(16)} escapes the WebM Segment`,
    );
  }
  return { id: id.value, dataStart, dataEnd, unknownSize: size.value < 0 };
}

async function readPacketInfoInteger(
  reader: WebmPacketInfoRangeReader,
  element: WebmElementRange,
  limit: number,
  signed: boolean,
): Promise<number> {
  const length = element.dataEnd - element.dataStart;
  if (element.unknownSize || length > 8) {
    throw new MediaError(
      'demux-error',
      `WebM integer element 0x${element.id.toString(16)} has an invalid size`,
    );
  }
  const bytes = await reader.read(element.dataStart, element.dataEnd, limit);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local: EbmlElement = {
    id: element.id,
    dataStart: 0,
    dataEnd: bytes.byteLength,
    complete: true,
    unknownSize: false,
  };
  return signed ? readInt(dv, local) : readUint(dv, local);
}

async function readPacketInfoFloat(
  reader: WebmPacketInfoRangeReader,
  element: WebmElementRange,
  limit: number,
): Promise<number> {
  const length = element.dataEnd - element.dataStart;
  if (element.unknownSize || (length !== 4 && length !== 8)) return 0;
  const bytes = await reader.read(element.dataStart, element.dataEnd, limit);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return length === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
}

function codecDelayMap(
  info: WebmInfo,
): ReadonlyMap<number, { readonly nanoseconds: number; readonly preserveSubTick: boolean }> {
  const result = new Map<
    number,
    { readonly nanoseconds: number; readonly preserveSubTick: boolean }
  >();
  for (const track of info.tracks) {
    if (track.trackNumber === undefined || track.codecDelayNs === undefined) continue;
    result.set(track.trackNumber, {
      nanoseconds: track.codecDelayNs,
      preserveSubTick: track.codec === 'opus',
    });
  }
  return result;
}

function scannedPacketRows(
  tracks: readonly WebmTrack[],
  framesByIndex: readonly (readonly ScannedWebmFrame[])[],
  sourceDurationUs: number | undefined,
): readonly PacketInfoMetadata[] {
  const rows: PacketInfoMetadata[] = [];
  for (let trackIndex = 0; trackIndex < framesByIndex.length; trackIndex++) {
    // Both arrays are projected from the same parsed track list and are therefore dense and aligned.
    const frames = framesByIndex[trackIndex] as readonly ScannedWebmFrame[];
    const track = tracks[trackIndex] as WebmTrack;
    const codecDefinesAudioSync = track.codec === 'opus' || track.codec === 'vorbis';
    const reorderDepth = track.reorderDepth ?? 0;
    const presentationTimeline =
      reorderDepth > 0 ? frames.map((frame) => frame.timestampUs).sort((a, b) => a - b) : undefined;
    const durationsUs = frameDurationsUs(frames, sourceDurationUs);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex] as ScannedWebmFrame;
      const durationUs = durationsUs[frameIndex];
      if (durationUs === undefined) {
        throw new MediaError(
          'demux-error',
          `WebM packet ${frameIndex} on track ${trackIndex} has no exact duration`,
        );
      }
      const dtsUs =
        presentationTimeline !== undefined && frameIndex >= reorderDepth
          ? (presentationTimeline[frameIndex - reorderDepth] as number)
          : frame.timestampUs;
      rows.push({
        trackIndex,
        offset: frame.offset,
        size: frame.size,
        ptsUs: frame.timestampUs,
        dtsUs,
        durationUs,
        keyframe: codecDefinesAudioSync || frame.keyframe,
      });
    }
  }
  return rows.sort((left, right) => (left.offset as number) - (right.offset as number));
}

interface WebmQualificationPrefix {
  readonly bytes: Uint8Array;
  /** False means the access unit exceeded the bounded qualification budget. */
  readonly complete: boolean;
}

function qualifyScannedWebmTracks(
  info: WebmInfo,
  firstKeyframes: ReadonlyMap<number, WebmQualificationPrefix>,
  sourceSizeBytes: number,
): void {
  for (const track of info.tracks) {
    if (
      track.mediaType !== 'video' ||
      (track.codec !== 'vp9' && track.codec !== 'av1') ||
      track.decoderCodecSource !== 'unknown' ||
      track.trackNumber === undefined
    ) {
      continue;
    }
    const candidate = firstKeyframes.get(track.trackNumber);
    try {
      const qualification = qualifyWebmVideoCodec({
        codec: track.codec,
        ...(candidate === undefined ? {} : { firstKeyframe: candidate.bytes }),
        ...(track.width === undefined ? {} : { width: track.width }),
        ...(track.height === undefined ? {} : { height: track.height }),
        ...(track.fps === undefined ? {} : { fps: track.fps }),
        sourceSizeBytes,
        ...(info.durationSec > 0 ? { durationSec: info.durationSec } : {}),
      });
      track.decoderCodec = qualification.codec;
      track.decoderCodecSource = qualification.source;
    } catch (error) {
      // A complete access unit retains the whole-parser's strict malformed-bitstream behavior. A
      // deliberately truncated qualification prefix can only prove a capability miss, never corruption
      // beyond the inspected boundary, so leave that track honestly unqualified.
      const boundedPrefixMiss =
        candidate?.complete === false &&
        error instanceof MediaError &&
        error.code === 'demux-error';
      if (!(error instanceof CapabilityError) && !boundedPrefixMiss) throw error;
    }
  }
}

interface WebmPacketInfoScanState {
  readonly info: WebmInfo;
  readonly trackIndexByNumber: ReadonlyMap<number, number>;
  readonly delays: ReadonlyMap<
    number,
    { readonly nanoseconds: number; readonly preserveSubTick: boolean }
  >;
  readonly framesByIndex: ScannedWebmFrame[][];
  readonly blockTimes: Map<number, BlockTiming>;
  readonly firstKeyframes: Map<number, WebmQualificationPrefix>;
  qualificationBytesRemaining: number;
  timecodeScale: number;
  lastEndTicks: number;
}

interface ScannedBlockGroupRange {
  readonly block?: WebmElementRange;
  readonly keyframe: boolean;
  readonly hasAlpha: boolean;
  readonly discardPaddingNs?: number;
  readonly blockDurationTicks?: number;
}

function unknownPacketInfoChild(element: WebmElementRange, context: string): never {
  throw new MediaError(
    'demux-error',
    `unknown-sized ${context} element 0x${element.id.toString(16)} in WebM`,
  );
}

interface PacketInfoInfoFields {
  readonly timecodeScale?: number;
  readonly durationTicks?: number;
}

interface PacketInfoTrackDeclaration {
  readonly track: WebmTrack;
  /** Synthetic packet metadata for a JPEG attachment, whose bytes never need to escape packetInfo. */
  readonly attachmentFrame?: ScannedWebmFrame;
}

function packetInfoMetadataLimit(
  kind: 'EBML Header' | 'Tracks' | 'Attachments',
  byteLength: number,
  maxBytes: number,
): MediaError {
  return new MediaError(
    'constraint-unsatisfied',
    `WebM ${kind} metadata is ${byteLength} bytes; bounded packetInfo supports at most ${maxBytes}`,
    {
      constraint: 'webm-packet-info-metadata-bytes',
      kind,
      byteLength,
      maxBytes,
    },
  );
}

function packetInfoMetadataCountLimit(
  kind: 'TrackEntry' | 'AttachedFile',
  count: number,
  maxCount: number,
): MediaError {
  return new MediaError(
    'constraint-unsatisfied',
    `WebM ${kind} count is ${count}; bounded packetInfo supports at most ${maxCount}`,
    {
      constraint: 'webm-packet-info-metadata-count',
      kind,
      count,
      maxCount,
    },
  );
}

function packetInfoXiphLaceLimit(scannedBytes: number): MediaError {
  return new MediaError(
    'constraint-unsatisfied',
    `WebM Xiph lace header exceeds the bounded packetInfo limit of ${WEBM_PACKET_INFO_XIPH_LACE_HEADER_MAX_BYTES} bytes`,
    {
      constraint: 'webm-packet-info-xiph-lace-header-bytes',
      scannedBytes,
      maxBytes: WEBM_PACKET_INFO_XIPH_LACE_HEADER_MAX_BYTES,
    },
  );
}

async function scanPacketInfoTracks(
  reader: WebmPacketInfoRangeReader,
  tracksElement: WebmElementRange,
): Promise<readonly PacketInfoTrackDeclaration[]> {
  const byteLength = tracksElement.dataEnd - tracksElement.dataStart;
  if (byteLength > WEBM_PACKET_INFO_TRACKS_MAX_BYTES) {
    throw packetInfoMetadataLimit('Tracks', byteLength, WEBM_PACKET_INFO_TRACKS_MAX_BYTES);
  }
  const bytes = await reader.read(
    tracksElement.dataStart,
    tracksElement.dataEnd,
    tracksElement.dataEnd,
  );
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declarations: PacketInfoTrackDeclaration[] = [];
  let trackEntryCount = 0;
  let parsedEnd = 0;
  for (const entry of elements(dv, 0, dv.byteLength)) {
    parsedEnd = entry.dataEnd;
    if (!entry.complete || entry.unknownSize) {
      throw new MediaError('demux-error', 'WebM Tracks contains a truncated TrackEntry');
    }
    if (entry.id !== ID.TrackEntry) continue;
    trackEntryCount++;
    if (trackEntryCount > WEBM_PACKET_INFO_TRACK_DECLARATION_MAX_COUNT) {
      throw packetInfoMetadataCountLimit(
        'TrackEntry',
        trackEntryCount,
        WEBM_PACKET_INFO_TRACK_DECLARATION_MAX_COUNT,
      );
    }
    const track = parseTrackEntry(bytes, dv, entry);
    if (track !== undefined) {
      const detached = copyWebmTrack(track);
      if (
        (detached.codec === 'vp9' || detached.codec === 'av1') &&
        detached.decoderCodecSource === undefined
      ) {
        detached.decoderCodec = detached.codec === 'vp9' ? 'vp09' : 'av01';
        detached.decoderCodecSource = 'unknown';
      }
      declarations.push({ track: detached });
    }
  }
  if (parsedEnd !== dv.byteLength) {
    throw new MediaError('demux-error', 'WebM Tracks contains malformed trailing bytes');
  }
  return declarations;
}

async function scanPacketInfoAttachments(
  reader: WebmPacketInfoRangeReader,
  attachmentsElement: WebmElementRange,
): Promise<readonly PacketInfoTrackDeclaration[]> {
  const byteLength = attachmentsElement.dataEnd - attachmentsElement.dataStart;
  if (byteLength > WEBM_PACKET_INFO_ATTACHMENTS_MAX_BYTES) {
    throw packetInfoMetadataLimit(
      'Attachments',
      byteLength,
      WEBM_PACKET_INFO_ATTACHMENTS_MAX_BYTES,
    );
  }
  const bytes = await reader.read(
    attachmentsElement.dataStart,
    attachmentsElement.dataEnd,
    attachmentsElement.dataEnd,
  );
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const localElement: EbmlElement = {
    id: ID.Attachments,
    dataStart: 0,
    dataEnd: bytes.byteLength,
    complete: true,
    unknownSize: false,
  };
  return parseAttachments(
    bytes,
    dv,
    localElement,
    WEBM_PACKET_INFO_TRACK_DECLARATION_MAX_COUNT,
  ).map((track): PacketInfoTrackDeclaration => {
    const { attachmentData, ...detachedBase } = track;
    const localOffset =
      attachmentData === undefined ? undefined : sourceViewOffset(bytes, attachmentData);
    // Only attachment packet metadata escapes this path. Retain the exact AttachedFile side data, but
    // do not duplicate the image payload once more solely to discard it from PacketInfoTable.
    const detached: WebmTrack = {
      ...detachedBase,
      ...(track.color === undefined ? {} : { color: { ...track.color } }),
      ...(track.description === undefined ? {} : { description: track.description.slice() }),
      ...(track.attachedFilePayload === undefined
        ? {}
        : { attachedFilePayload: track.attachedFilePayload.slice() }),
    };
    return {
      track: detached,
      ...(attachmentData === undefined || localOffset === undefined
        ? {}
        : {
            attachmentFrame: {
              data: EMPTY_PACKET_DATA,
              timestampUs: 0,
              keyframe: true,
              offset: attachmentsElement.dataStart + localOffset,
              size: attachmentData.byteLength,
            },
          }),
    };
  });
}

async function scanPacketInfoInfo(
  reader: WebmPacketInfoRangeReader,
  info: WebmElementRange,
): Promise<PacketInfoInfoFields> {
  let timecodeScale: number | undefined;
  let durationTicks: number | undefined;
  let cursor = info.dataStart;
  while (cursor < info.dataEnd) {
    const child = await readWebmElementRange(reader, cursor, info.dataEnd);
    if (child.unknownSize) unknownPacketInfoChild(child, 'Info child');
    cursor = child.dataEnd;
    if (child.id === ID.TimecodeScale) {
      timecodeScale = await readPacketInfoInteger(reader, child, info.dataEnd, false);
    } else if (child.id === ID.Duration) {
      durationTicks = await readPacketInfoFloat(reader, child, info.dataEnd);
    }
  }
  return {
    ...(timecodeScale === undefined ? {} : { timecodeScale }),
    ...(durationTicks === undefined ? {} : { durationTicks }),
  };
}

/** Skip an unknown Cluster by direct-child sizes until the next parsed Segment-level sibling. */
async function skipPacketInfoCluster(
  reader: WebmPacketInfoRangeReader,
  cluster: WebmElementRange,
): Promise<number> {
  if (!cluster.unknownSize) return cluster.dataEnd;
  let cursor = cluster.dataStart;
  while (cursor < cluster.dataEnd) {
    const child = await readWebmElementRange(reader, cursor, cluster.dataEnd);
    if (SEGMENT_LEVEL_IDS.has(child.id)) return cursor;
    if (child.unknownSize) unknownPacketInfoChild(child, 'Cluster child');
    cursor = child.dataEnd;
  }
  return cursor;
}

/** Detect VPx alpha side data without reading the (potentially frame-sized) BlockAdditional payload. */
async function packetInfoBlockAdditionsHaveAlpha(
  reader: WebmPacketInfoRangeReader,
  additions: WebmElementRange,
): Promise<boolean> {
  let cursor = additions.dataStart;
  while (cursor < additions.dataEnd) {
    const blockMore = await readWebmElementRange(reader, cursor, additions.dataEnd);
    if (blockMore.unknownSize) unknownPacketInfoChild(blockMore, 'BlockAdditions child');
    cursor = blockMore.dataEnd;
    if (blockMore.id !== ID.BlockMore) continue;

    let addId = 1;
    let hasAdditional = false;
    let childCursor = blockMore.dataStart;
    while (childCursor < blockMore.dataEnd) {
      const child = await readWebmElementRange(reader, childCursor, blockMore.dataEnd);
      if (child.unknownSize) unknownPacketInfoChild(child, 'BlockMore child');
      childCursor = child.dataEnd;
      if (child.id === ID.BlockAddID) {
        addId = await readPacketInfoInteger(reader, child, blockMore.dataEnd, false);
      } else if (child.id === ID.BlockAdditional) {
        hasAdditional = true;
      }
    }
    if (hasAdditional && addId === 1) return true;
  }
  return false;
}

/** Walk BlockGroup metadata before decoding its Block, since ReferenceBlock may follow the payload. */
async function scanPacketInfoBlockGroup(
  reader: WebmPacketInfoRangeReader,
  group: WebmElementRange,
): Promise<ScannedBlockGroupRange> {
  let block: WebmElementRange | undefined;
  let hasReference = false;
  let hasAlpha = false;
  let discardPaddingNs: number | undefined;
  let blockDurationTicks: number | undefined;
  let sawDiscardPadding = false;
  let sawBlockDuration = false;
  let cursor = group.dataStart;

  while (cursor < group.dataEnd) {
    const child = await readWebmElementRange(reader, cursor, group.dataEnd);
    if (child.unknownSize) unknownPacketInfoChild(child, 'BlockGroup child');
    cursor = child.dataEnd;
    if (child.id === ID.Block && block === undefined) {
      block = child;
    } else if (child.id === ID.ReferenceBlock) {
      hasReference = true;
    } else if (child.id === ID.DiscardPadding && !sawDiscardPadding) {
      discardPaddingNs = await readPacketInfoInteger(reader, child, group.dataEnd, true);
      sawDiscardPadding = true;
    } else if (child.id === ID.BlockDuration && !sawBlockDuration) {
      blockDurationTicks = await readPacketInfoInteger(reader, child, group.dataEnd, false);
      sawBlockDuration = true;
    } else if (child.id === ID.BlockAdditions) {
      if (await packetInfoBlockAdditionsHaveAlpha(reader, child)) hasAlpha = true;
    }
  }

  return {
    ...(block === undefined ? {} : { block }),
    keyframe: !hasReference,
    hasAlpha,
    ...(sawDiscardPadding ? { discardPaddingNs: discardPaddingNs as number } : {}),
    ...(sawBlockDuration ? { blockDurationTicks: blockDurationTicks as number } : {}),
  };
}

interface PacketInfoFrameRange {
  readonly offset: number;
  readonly size: number;
}

interface PacketInfoBlockLayout {
  readonly frames: readonly PacketInfoFrameRange[];
  /** True only when a declared lace table parsed successfully. */
  readonly laced: boolean;
}

async function readPacketInfoVint(
  reader: WebmPacketInfoRangeReader,
  offset: number,
  limit: number,
  keepMarker: boolean,
): Promise<{ readonly value: number; readonly length: number } | undefined> {
  if (offset >= limit) return undefined;
  const bytes = await reader.read(offset, Math.min(limit, offset + 8), limit);
  return readVint(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, keepMarker);
}

function unparsedLaceLayout(headerStart: number, blockEnd: number): PacketInfoBlockLayout {
  return {
    frames: [{ offset: headerStart, size: Math.max(0, blockEnd - headerStart) }],
    laced: false,
  };
}

async function packetInfoBlockLayout(
  reader: WebmPacketInfoRangeReader,
  headerStart: number,
  blockEnd: number,
  lacing: Lacing,
): Promise<PacketInfoBlockLayout> {
  if (lacing === 'none') return unparsedLaceLayout(headerStart, blockEnd);
  if (headerStart >= blockEnd) return unparsedLaceLayout(headerStart, blockEnd);
  const count = await reader.read(headerStart, headerStart + 1, blockEnd);
  const frameCount = (count[0] ?? 0) + 1;
  let cursor = headerStart + 1;
  const sizes: number[] = [];

  if (lacing === 'fixed') {
    const total = blockEnd - cursor;
    if (total < 0 || total % frameCount !== 0) {
      return unparsedLaceLayout(headerStart, blockEnd);
    }
    for (let index = 0; index < frameCount; index++) sizes.push(total / frameCount);
  } else if (lacing === 'xiph') {
    let remaining = frameCount - 1;
    let currentSize = 0;
    let headerBytes = 1; // Lace-count byte.
    while (remaining > 0) {
      if (cursor >= blockEnd) return unparsedLaceLayout(headerStart, blockEnd);
      if (headerBytes >= WEBM_PACKET_INFO_XIPH_LACE_HEADER_MAX_BYTES) {
        throw packetInfoXiphLaceLimit(headerBytes);
      }
      const chunkEnd = Math.min(
        blockEnd,
        cursor + WEBM_PACKET_INFO_RANGE_WINDOW_BYTES,
        cursor + WEBM_PACKET_INFO_XIPH_LACE_HEADER_MAX_BYTES - headerBytes,
      );
      const chunk = await reader.read(cursor, chunkEnd, blockEnd);
      let consumed = 0;
      for (const byte of chunk) {
        consumed++;
        headerBytes++;
        currentSize += byte;
        if (!Number.isSafeInteger(currentSize)) {
          return unparsedLaceLayout(headerStart, blockEnd);
        }
        if (byte !== 0xff) {
          sizes.push(currentSize);
          currentSize = 0;
          remaining--;
          if (remaining === 0) break;
        }
      }
      cursor += consumed;
    }
  } else {
    const first = await readPacketInfoVint(reader, cursor, blockEnd, false);
    if (first === undefined || first.value < 0 || !Number.isSafeInteger(first.value)) {
      return unparsedLaceLayout(headerStart, blockEnd);
    }
    cursor += first.length;
    sizes.push(first.value);
    for (let index = 1; index < frameCount - 1; index++) {
      const raw = await readPacketInfoVint(reader, cursor, blockEnd, false);
      if (raw === undefined || raw.value < 0 || !Number.isSafeInteger(raw.value)) {
        return unparsedLaceLayout(headerStart, blockEnd);
      }
      const previous = sizes[sizes.length - 1] as number;
      const bias = 2 ** (7 * raw.length - 1) - 1;
      const size = previous + (raw.value - bias);
      if (!Number.isSafeInteger(size) || size < 0) {
        return unparsedLaceLayout(headerStart, blockEnd);
      }
      sizes.push(size);
      cursor += raw.length;
    }
  }

  let used = 0;
  for (const size of sizes) {
    used += size;
    if (!Number.isSafeInteger(used) || size < 0) {
      return unparsedLaceLayout(headerStart, blockEnd);
    }
  }
  const finalSize = blockEnd - cursor - used;
  if (!Number.isSafeInteger(finalSize) || finalSize < 0) {
    return unparsedLaceLayout(headerStart, blockEnd);
  }
  sizes.push(finalSize);

  const frames: PacketInfoFrameRange[] = [];
  let frameOffset = cursor;
  for (const size of sizes) {
    const frameEnd = frameOffset + size;
    if (!Number.isSafeInteger(frameEnd) || frameEnd > blockEnd) {
      return unparsedLaceLayout(headerStart, blockEnd);
    }
    frames.push({ offset: frameOffset, size });
    frameOffset = frameEnd;
  }
  if (frameOffset !== blockEnd) return unparsedLaceLayout(headerStart, blockEnd);
  return { frames, laced: true };
}

function encodePacketInfoLeb128(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(low | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

async function readPacketInfoAv1Leb128(
  reader: WebmPacketInfoRangeReader,
  offset: number,
  limit: number,
): Promise<{ readonly value: number; readonly length: number }> {
  const bytes = await reader.read(offset, Math.min(limit, offset + 8), limit);
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 8; index++) {
    const byte = bytes[index];
    if (byte === undefined) {
      throw new MediaError('demux-error', 'AV1 OBU LEB128 size is truncated');
    }
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      throw new MediaError('demux-error', 'AV1 OBU LEB128 size exceeds safe integer');
    }
    if ((byte & 0x80) === 0) return { value, length: index + 1 };
    multiplier *= 128;
  }
  throw new MediaError('demux-error', 'AV1 OBU LEB128 size exceeds eight bytes');
}

/**
 * Find the first AV1 Sequence Header OBU without retaining preceding Padding/Metadata payloads. The
 * returned synthetic one-OBU access unit carries only a bounded sequence payload prefix; the ordinary
 * qualifier remains the single parser for AV1 sequence syntax and codec-string construction.
 */
async function scanPacketInfoAv1SequenceHeader(
  reader: WebmPacketInfoRangeReader,
  frame: PacketInfoFrameRange,
  blockEnd: number,
  retainedByteBudget: number,
): Promise<WebmQualificationPrefix> {
  if (retainedByteBudget < 2) return { bytes: EMPTY_PACKET_DATA, complete: false };
  const frameEnd = frame.offset + frame.size;
  let offset = frame.offset;
  let obuCount = 0;
  while (offset < frameEnd) {
    if (
      offset - frame.offset > WEBM_PACKET_INFO_AV1_OBU_SCAN_MAX_BYTES ||
      obuCount >= WEBM_PACKET_INFO_AV1_OBU_SCAN_MAX_COUNT
    ) {
      return { bytes: EMPTY_PACKET_DATA, complete: false };
    }
    obuCount++;
    const headerBytes = await reader.read(offset, offset + 1, blockEnd);
    const header = headerBytes[0] as number;
    if ((header & 0x80) !== 0 || (header & 1) !== 0) {
      throw new MediaError('demux-error', 'AV1 OBU header has a forbidden or reserved bit set');
    }
    const type = (header >> 3) & 0x0f;
    const extension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    let payloadStart = offset + 1;
    if (extension) {
      if (payloadStart >= frameEnd) {
        throw new MediaError('demux-error', 'AV1 OBU extension is truncated');
      }
      const extensionBytes = await reader.read(payloadStart, payloadStart + 1, blockEnd);
      if (((extensionBytes[0] as number) & 0x07) !== 0) {
        throw new MediaError('demux-error', 'AV1 OBU extension reserved bits are set');
      }
      payloadStart++;
    }
    let payloadEnd = frameEnd;
    if (hasSize) {
      const size = await readPacketInfoAv1Leb128(reader, payloadStart, frameEnd);
      payloadStart += size.length;
      payloadEnd = payloadStart + size.value;
      if (!Number.isSafeInteger(payloadEnd) || payloadEnd > frameEnd) {
        throw new MediaError('demux-error', 'AV1 OBU payload is truncated');
      }
    }
    if (type === 1) {
      const declaredSize = payloadEnd - payloadStart;
      let prefixSize = Math.min(
        declaredSize,
        WEBM_PACKET_INFO_CODEC_PREFIX_BYTES,
        Math.max(0, retainedByteBudget - 4),
      );
      let sizeBytes = encodePacketInfoLeb128(prefixSize);
      while (1 + sizeBytes.byteLength + prefixSize > retainedByteBudget) {
        prefixSize--;
        sizeBytes = encodePacketInfoLeb128(prefixSize);
      }
      const payload =
        prefixSize === 0
          ? EMPTY_PACKET_DATA
          : (await reader.read(payloadStart, payloadStart + prefixSize, blockEnd)).slice();
      const synthetic = new Uint8Array(1 + sizeBytes.byteLength + payload.byteLength);
      synthetic[0] = 0x0a; // Sequence Header, no extension, explicit payload size.
      synthetic.set(sizeBytes, 1);
      synthetic.set(payload, 1 + sizeBytes.byteLength);
      return { bytes: synthetic, complete: prefixSize === declaredSize };
    }
    if (!hasSize) return { bytes: EMPTY_PACKET_DATA, complete: true };
    offset = payloadEnd;
  }
  return { bytes: EMPTY_PACKET_DATA, complete: true };
}

/** Parse one Block from bounded headers/prefixes; coded payload bytes are skipped by declared size. */
async function scanPacketInfoBlock(
  reader: WebmPacketInfoRangeReader,
  block: WebmElementRange,
  _readAheadLimit: number,
  clusterTimecode: number,
  state: WebmPacketInfoScanState,
  keyframeOverride: boolean | undefined,
  hasAlpha: boolean,
  discardPaddingNs: number | undefined,
  blockDurationTicks: number | undefined,
): Promise<void> {
  if (block.unknownSize) unknownPacketInfoChild(block, 'Block');
  const track = await readPacketInfoVint(reader, block.dataStart, block.dataEnd, false);
  if (track === undefined || track.value < 0) return;
  const timecodeOffset = block.dataStart + track.length;
  const flagsOffset = timecodeOffset + 2;
  if (flagsOffset >= block.dataEnd) return;
  const fixedHeader = await reader.read(timecodeOffset, flagsOffset + 1, block.dataEnd);
  const headerView = new DataView(
    fixedHeader.buffer,
    fixedHeader.byteOffset,
    fixedHeader.byteLength,
  );
  const relativeTimecode = headerView.getInt16(0, false);
  const flags = fixedHeader[2] as number;
  const blockTime = clusterTimecode + relativeTimecode;
  state.lastEndTicks = Math.max(state.lastEndTicks, blockTime);

  const trackIndex = state.trackIndexByNumber.get(track.value);
  if (trackIndex === undefined) return;
  recordBlockTime(state.blockTimes, track.value, blockTime);
  const trackInfo = state.info.tracks[trackIndex] as WebmTrack;
  const target = state.framesByIndex[trackIndex] as ScannedWebmFrame[];
  const delay = state.delays.get(track.value) ?? {
    nanoseconds: 0,
    preserveSubTick: false,
  };
  const presentationNs = blockTime * state.timecodeScale - delay.nanoseconds;
  const roundedTimestampUs = delay.preserveSubTick
    ? Math.round(presentationNs / 1000)
    : Math.round((Math.round(presentationNs / state.timecodeScale) * state.timecodeScale) / 1000);
  const timestampUs = Object.is(roundedTimestampUs, -0) ? 0 : roundedTimestampUs;
  const keyframe = keyframeOverride ?? (flags & 0x80) !== 0;
  const blockDurationUs =
    blockDurationTicks === undefined
      ? undefined
      : Math.round((blockDurationTicks * state.timecodeScale) / 1000);
  const layout = await packetInfoBlockLayout(
    reader,
    flagsOffset + 1,
    block.dataEnd,
    lacingOf(flags),
  );
  const frameDurationUs =
    blockDurationUs !== undefined && blockDurationUs > 0
      ? layout.laced
        ? Math.round(blockDurationUs / layout.frames.length)
        : blockDurationUs
      : undefined;

  for (let index = 0; index < layout.frames.length; index++) {
    const frame = layout.frames[index] as PacketInfoFrameRange;
    let data = EMPTY_PACKET_DATA;
    if (trackInfo.codec === 'opus' && frame.size > 0) {
      const prefixEnd = frame.offset + Math.min(2, frame.size);
      data = (await reader.read(frame.offset, prefixEnd, block.dataEnd)).slice();
    }
    if (
      keyframe &&
      trackInfo.mediaType === 'video' &&
      (trackInfo.codec === 'vp9' || trackInfo.codec === 'av1') &&
      trackInfo.decoderCodecSource === 'unknown' &&
      !state.firstKeyframes.has(track.value)
    ) {
      const retainedByteBudget = state.qualificationBytesRemaining;
      let candidate: WebmQualificationPrefix;
      if (trackInfo.codec === 'av1') {
        candidate = await scanPacketInfoAv1SequenceHeader(
          reader,
          frame,
          block.dataEnd,
          retainedByteBudget,
        );
      } else {
        const prefixSize = Math.min(
          frame.size,
          WEBM_PACKET_INFO_CODEC_PREFIX_BYTES,
          retainedByteBudget,
        );
        const bytes =
          prefixSize === 0
            ? EMPTY_PACKET_DATA
            : (await reader.read(frame.offset, frame.offset + prefixSize, block.dataEnd)).slice();
        candidate = { bytes, complete: prefixSize === frame.size };
      }
      state.qualificationBytesRemaining -= candidate.bytes.byteLength;
      state.firstKeyframes.set(track.value, candidate);
    }
    const carriesDiscardPadding =
      discardPaddingNs !== undefined &&
      discardPaddingNs !== 0 &&
      (discardPaddingNs < 0 ? index === 0 : index === layout.frames.length - 1);
    target.push({
      data,
      timestampUs,
      keyframe,
      ...(frameDurationUs !== undefined && frameDurationUs > 0
        ? { durationUs: frameDurationUs }
        : {}),
      ...(hasAlpha && !layout.laced ? { alpha: EMPTY_PACKET_DATA } : {}),
      ...(carriesDiscardPadding ? { discardPaddingNs } : {}),
      offset: frame.offset,
      size: frame.size,
    });
  }
}

/**
 * Walk one Cluster by declared child sizes. For an unknown-size Cluster, a parsed direct-child header
 * carrying a Segment-level id is its standards-derived boundary; payload bytes are never pattern-scanned.
 */
async function scanPacketInfoCluster(
  reader: WebmPacketInfoRangeReader,
  cluster: WebmElementRange,
  state: WebmPacketInfoScanState,
): Promise<number> {
  let clusterTimecode = 0;
  let cursor = cluster.dataStart;
  while (cursor < cluster.dataEnd) {
    const child = await readWebmElementRange(reader, cursor, cluster.dataEnd);
    if (cluster.unknownSize && SEGMENT_LEVEL_IDS.has(child.id)) return cursor;
    if (child.unknownSize) unknownPacketInfoChild(child, 'Cluster child');
    cursor = child.dataEnd;

    if (child.id === ID.Timecode) {
      clusterTimecode = await readPacketInfoInteger(reader, child, cluster.dataEnd, false);
    } else if (child.id === ID.SimpleBlock) {
      await scanPacketInfoBlock(
        reader,
        child,
        cluster.dataEnd,
        clusterTimecode,
        state,
        undefined,
        false,
        undefined,
        undefined,
      );
    } else if (child.id === ID.BlockGroup) {
      const group = await scanPacketInfoBlockGroup(reader, child);
      if (group.block !== undefined) {
        await scanPacketInfoBlock(
          reader,
          group.block,
          child.dataEnd,
          clusterTimecode,
          state,
          group.keyframe,
          group.hasAlpha,
          group.discardPaddingNs,
          group.blockDurationTicks,
        );
      }
    }
  }
  return cursor;
}

async function webmPacketInfoFromWholeSource(
  src: ByteSource,
  signal: AbortSignal | undefined,
): Promise<PacketInfoTable> {
  const ranged =
    src.range !== undefined && src.size !== undefined && src.size > 0
      ? (src as ByteSource & {
          readonly size: number;
          readonly range: NonNullable<ByteSource['range']>;
        })
      : undefined;
  const bytes =
    ranged === undefined
      ? await readAll(src, signal)
      : await readPacketInfoRange(ranged, 0, ranged.size, signal);
  try {
    const { info, framesByIndex } = demuxWebm(bytes);
    const sourceDurationUs =
      info.durationSec > 0 ? Math.round(info.durationSec * MICROS_PER_SECOND) : undefined;
    // `CodecPrivate`, image attachments, and AttachedFile payloads are source-buffer views. Packet-info
    // strips timed payloads, but its TrackInfo still escapes, so clone every track-backed byte field
    // before an owned whole-range response can be detached or recycled by `releaseRange`.
    const detachedInfo = { ...info, tracks: info.tracks.map(copyWebmTrack) };
    return {
      tracks: toTrackInfos(detachedInfo, framesByIndex),
      packets: packetPayloadRows(bytes, info.tracks, framesByIndex, sourceDurationUs).map(
        ({ data: _data, alpha: _alpha, ...row }) => row,
      ),
    };
  } finally {
    if (ranged !== undefined) ranged.releaseRange?.(bytes);
  }
}

/**
 * Metadata-only WebM scan over finite range sources. It retains one bounded prefix, one read-ahead
 * window, bounded declarations/codec prefixes, and lightweight packet rows — never a complete Block,
 * Cluster, or media body. The prefix validates only EBML + Segment; schema-order-independent metadata
 * discovery happens in the bounded top-level walk so late Info/Tracks/Attachments remain exact.
 */
async function webmPacketInfoFromSource(
  src: ByteSource,
  signal: AbortSignal | undefined,
): Promise<PacketInfoTable> {
  if (src.range === undefined || src.size === undefined || src.size <= 0) {
    return webmPacketInfoFromWholeSource(src, signal);
  }
  const ranged = src as FiniteRangeByteSource;
  const prefixEnd = Math.min(ranged.size, WEBM_PACKET_INFO_PREFIX_BYTES);
  const prefix = await readPacketInfoRange(ranged, 0, prefixEnd, signal);
  let bootstrap: WebmPacketInfoBootstrap;
  try {
    // Deliberately do not call parseWebm here: even with scanClusters:false, keyframe qualification in
    // an incomplete leading Cluster can couple codec facts to missing late Info. Qualification belongs
    // exclusively to the second bounded pass after all Segment metadata is known.
    bootstrap = await packetInfoBootstrapFromPrefix(ranged, prefix, signal);
  } finally {
    ranged.releaseRange?.(prefix);
  }
  const segment = bootstrap.segment;
  let timecodeScale = 1_000_000;
  let durationTicks = 0;

  // Segment metadata peers have no useful ordering guarantee. Discover and detach them before reading
  // any packet clock. A second Tracks is schema-invalid and rejected rather than ambiguously merged.
  let metadataCursor = segment.dataStart;
  let packetCursorStart = segment.dataStart;
  let singlePassClusters = false;
  let infoSeen = 0;
  let tracksSeen = 0;
  let attachmentsSeen = 0;
  const declarations: PacketInfoTrackDeclaration[] = [];
  const metadataReader = new WebmPacketInfoRangeReader(ranged, signal);
  try {
    while (metadataCursor < segment.dataEnd) {
      assertNotAborted(signal);
      const elementStart = metadataCursor;
      // The first pass skips complete Clusters and reads only Segment metadata. Do not prefetch 64 KiB
      // at every Cluster boundary: the packet pass below will consume those same sequential windows.
      const element = await readWebmElementRange(
        metadataReader,
        metadataCursor,
        segment.dataEnd,
        false,
      );
      if (element.unknownSize && element.id !== ID.Cluster) {
        throw new MediaError(
          'demux-error',
          `unknown-sized non-Cluster element 0x${element.id.toString(16)} in WebM Segment`,
        );
      }
      if (element.id === ID.Info) {
        infoSeen++;
        const fields = await scanPacketInfoInfo(metadataReader, element);
        timecodeScale = fields.timecodeScale ?? timecodeScale;
        durationTicks = fields.durationTicks ?? durationTicks;
        metadataCursor = element.dataEnd;
      } else if (element.id === ID.Tracks) {
        tracksSeen++;
        if (tracksSeen > 1) {
          throw new MediaError('demux-error', 'WebM Segment contains duplicate Tracks elements');
        }
        declarations.push(...(await scanPacketInfoTracks(metadataReader, element)));
        metadataCursor = element.dataEnd;
      } else if (element.id === ID.Attachments) {
        attachmentsSeen++;
        if (attachmentsSeen > 1) {
          throw new MediaError(
            'demux-error',
            'WebM Segment contains duplicate Attachments elements',
          );
        }
        declarations.push(...(await scanPacketInfoAttachments(metadataReader, element)));
        metadataCursor = element.dataEnd;
      } else {
        if (element.id === ID.Cluster && infoSeen === 1 && tracksSeen === 1) {
          // Info and the sole Tracks declaration precede the first Cluster in ordinary WebM. Walk
          // those clusters only once; late optional Attachments are still discovered by that walk.
          // Files with late required metadata retain the fully order-independent two-pass fallback.
          packetCursorStart = elementStart;
          singlePassClusters = true;
          break;
        }
        metadataCursor =
          element.id === ID.Cluster
            ? await skipPacketInfoCluster(metadataReader, element)
            : element.dataEnd;
      }
    }
  } finally {
    metadataReader.close();
  }
  if (declarations.length === 0) {
    throw new MediaError('demux-error', 'WebM segment has no decodable tracks');
  }
  const info: WebmInfo = {
    container: bootstrap.container,
    durationSec: durationTicks > 0 ? (durationTicks * timecodeScale) / NANOS_PER_SECOND : 0,
    tracks: declarations.map(({ track }) => track),
  };

  const trackIndexByNumber = new Map<number, number>();
  for (let index = 0; index < info.tracks.length; index++) {
    const trackNumber = info.tracks[index]?.trackNumber;
    if (trackNumber !== undefined) trackIndexByNumber.set(trackNumber, index);
  }
  const delays = codecDelayMap(info);
  const framesByIndex: ScannedWebmFrame[][] = declarations.map(({ attachmentFrame }) =>
    attachmentFrame === undefined ? [] : [attachmentFrame],
  );
  const blockTimes = new Map<number, BlockTiming>();
  const firstKeyframes = new Map<number, WebmQualificationPrefix>();
  const state: WebmPacketInfoScanState = {
    info,
    trackIndexByNumber,
    delays,
    framesByIndex,
    blockTimes,
    firstKeyframes,
    qualificationBytesRemaining: WEBM_PACKET_INFO_CODEC_PREFIX_TOTAL_BYTES,
    timecodeScale,
    lastEndTicks: 0,
  };
  let cursor = packetCursorStart;
  const reader = new WebmPacketInfoRangeReader(ranged, signal);
  try {
    while (cursor < segment.dataEnd) {
      assertNotAborted(signal);
      const element = await readWebmElementRange(reader, cursor, segment.dataEnd);
      if (element.unknownSize && element.id !== ID.Cluster) {
        throw new MediaError(
          'demux-error',
          `unknown-sized non-Cluster element 0x${element.id.toString(16)} in WebM Segment`,
        );
      }
      if (element.id === ID.Cluster) {
        cursor = await scanPacketInfoCluster(reader, element, state);
      } else {
        cursor = element.dataEnd;
        if (!singlePassClusters) continue;
        if (element.id === ID.Info) {
          throw new MediaError('demux-error', 'WebM Segment contains duplicate Info elements');
        }
        if (element.id === ID.Tracks) {
          throw new MediaError('demux-error', 'WebM Segment contains duplicate Tracks elements');
        }
        if (element.id === ID.Attachments) {
          attachmentsSeen++;
          if (attachmentsSeen > 1) {
            throw new MediaError(
              'demux-error',
              'WebM Segment contains duplicate Attachments elements',
            );
          }
          const lateDeclarations = await scanPacketInfoAttachments(reader, element);
          for (const declaration of lateDeclarations) {
            declarations.push(declaration);
            info.tracks.push(declaration.track);
            framesByIndex.push(
              declaration.attachmentFrame === undefined ? [] : [declaration.attachmentFrame],
            );
          }
        }
      }
    }
  } finally {
    reader.close();
  }

  const declaredMediaIndexes = info.tracks.flatMap((track, index) =>
    track.trackNumber === undefined ? [] : [index],
  );
  const hasDeclaredMediaBlock = declaredMediaIndexes.some(
    (trackIndex) => (framesByIndex[trackIndex]?.length ?? 0) > 0,
  );
  if (
    cursor !== segment.dataEnd ||
    (declaredMediaIndexes.length > 0 && !hasDeclaredMediaBlock) ||
    framesByIndex.every((frames) => frames.length === 0)
  ) {
    throw new MediaError(
      'demux-error',
      'WebM segment declares media tracks but contains no media blocks',
    );
  }
  if (info.durationSec <= 0) {
    info.durationSec = (state.lastEndTicks * state.timecodeScale) / NANOS_PER_SECOND;
  }
  for (const track of info.tracks) {
    if (track.mediaType !== 'video' || track.fps !== undefined || track.trackNumber === undefined) {
      continue;
    }
    const timing = blockTimes.get(track.trackNumber);
    const fps = timing === undefined ? undefined : fpsFromBlockTiming(timing, state.timecodeScale);
    if (fps !== undefined) track.fps = fps;
  }
  qualifyScannedWebmTracks(info, firstKeyframes, ranged.size);
  const sourceDurationUs =
    info.durationSec > 0 ? Math.round(info.durationSec * MICROS_PER_SECOND) : undefined;
  return {
    tracks: toTrackInfos(info, framesByIndex),
    packets: scannedPacketRows(info.tracks, framesByIndex, sourceDurationUs),
  };
}

function opusPreSkip(description: Uint8Array | undefined): number {
  if (description === undefined || description.byteLength < 12) return 0;
  const magic = String.fromCharCode(...description.subarray(0, 8));
  if (magic !== 'OpusHead') return 0;
  return new DataView(description.buffer, description.byteOffset, description.byteLength).getUint16(
    10,
    true,
  );
}

/** Exact decoded sample count of one valid RFC 6716 packet, or undefined for malformed framing. */
function opusPacketSamples(packet: Uint8Array): number | undefined {
  const toc = packet[0];
  if (toc === undefined) return undefined;
  const frameSamples = OPUS_FRAME_SAMPLES[toc >> 3];
  if (frameSamples === undefined) return undefined;
  const code = toc & 0x03;
  const frameCount =
    code === 0 ? 1 : code === 1 || code === 2 ? 2 : packet[1] === undefined ? 0 : packet[1] & 0x3f;
  const samples = frameSamples * frameCount;
  return frameCount > 0 && samples <= 5760 ? samples : undefined;
}

function opusSamplesFromNanoseconds(nanoseconds: number): number {
  return Math.max(0, Math.round((nanoseconds * OPUS_SAMPLE_RATE) / NANOS_PER_SECOND));
}

/** Project Matroska's nanosecond delay/padding facts onto the public decoded-sample contract. */
function opusGapless(
  track: WebmTrack,
  frames: readonly WebmFrame[] | undefined,
  includeLeadingDelay = true,
): TrackInfo['gapless'] | undefined {
  if (track.codec !== 'opus') return undefined;
  const codecDelaySamples = opusSamplesFromNanoseconds(track.codecDelayNs ?? 0);
  const headerPreSkip = opusPreSkip(track.description);
  // CodecDelay is the actual Matroska playback clock and therefore wins on malformed mismatches; an
  // OpusHead-only file still retains its RFC 7845 pre-skip when a legacy writer omitted CodecDelay.
  const leadingSamples = includeLeadingDelay
    ? codecDelaySamples > 0
      ? codecDelaySamples
      : headerPreSkip
    : 0;
  const firstDiscardNs = frames?.[0]?.discardPaddingNs;
  const terminalDiscardNs = frames?.[frames.length - 1]?.discardPaddingNs;
  const leadingDiscardSamples =
    firstDiscardNs !== undefined && firstDiscardNs < 0
      ? opusSamplesFromNanoseconds(-firstDiscardNs)
      : 0;
  const trailingSamples =
    terminalDiscardNs !== undefined && terminalDiscardNs > 0
      ? opusSamplesFromNanoseconds(terminalDiscardNs)
      : 0;
  const effectiveLeadingSamples = leadingSamples + leadingDiscardSamples;
  if (effectiveLeadingSamples === 0 && trailingSamples === 0 && includeLeadingDelay) {
    return undefined;
  }

  let codedSamples = 0;
  let completeSampleCount = frames !== undefined;
  for (const frame of frames ?? []) {
    const samples = opusPacketSamples(frame.data);
    if (samples === undefined) {
      completeSampleCount = false;
      break;
    }
    codedSamples += samples;
  }
  const totalSamples = codedSamples - effectiveLeadingSamples - trailingSamples;
  return {
    basis: 'webm-opus-codec-delay',
    ...(effectiveLeadingSamples > 0 || !includeLeadingDelay
      ? { leadingSamples: effectiveLeadingSamples }
      : {}),
    ...(trailingSamples > 0 ? { trailingSamples } : {}),
    ...(completeSampleCount && totalSamples >= 0 ? { totalSamples } : {}),
  };
}

function videoColorSpace(color: VideoColorMetadata | undefined): VideoColorSpaceInit | undefined {
  if (color === undefined) return undefined;
  const matrix =
    color.matrixCoefficients === undefined ? undefined : h273Matrix(color.matrixCoefficients);
  const primaries = color.primaries === undefined ? undefined : h273Primaries(color.primaries);
  const transfer =
    color.transferCharacteristics === undefined
      ? undefined
      : h273Transfer(color.transferCharacteristics);
  const fullRange = color.range === 1 ? false : color.range === 2 ? true : undefined;
  if (
    matrix === undefined &&
    primaries === undefined &&
    transfer === undefined &&
    fullRange === undefined
  ) {
    return undefined;
  }
  return {
    ...(matrix !== undefined ? { matrix } : {}),
    ...(primaries !== undefined ? { primaries } : {}),
    ...(transfer !== undefined ? { transfer } : {}),
    ...(fullRange !== undefined ? { fullRange } : {}),
  };
}

function toTrackInfo(
  track: WebmTrack,
  id: number,
  durationSec?: number,
  observedAlpha?: boolean,
  frames?: readonly WebmFrame[],
  includeLeadingGaplessDelay = true,
  containerSideData?: readonly ContainerSideData[],
  containerProjection?: MatroskaAttachmentProjection,
): TrackInfo {
  if (track.nonMedia === true) {
    return {
      id,
      mediaType: track.mediaType,
      codec: track.codec,
      nonMedia: true,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(containerSideData !== undefined ? { containerSideData } : {}),
      ...(containerProjection !== undefined ? { containerProjection } : {}),
    };
  }
  // The CodecPrivate rides in `description`: avcC/hvcC for H.264/HEVC decode config, and Vorbis'
  // Xiph-laced setup headers for cross-container muxing into Ogg. It is a `Uint8Array`, satisfying the
  // WebCodecs `description: AllowSharedBufferSource` field where a decoder consumes it.
  const colorSpace = videoColorSpace(track.color);
  const config: VideoDecoderConfig | AudioDecoderConfig =
    track.mediaType === 'video'
      ? {
          // `vp09`/`av01` are deliberate fourcc-only miss tokens when neither CodecPrivate nor an
          // in-band sequence header proved profile/depth. The generic normalizer does not turn them
          // into a false profile-0 8-bit declaration.
          codec:
            track.decoderCodec ??
            (track.codec === 'vp9' ? 'vp09' : track.codec === 'av1' ? 'av01' : track.codec),
          codedWidth: track.width ?? 0,
          codedHeight: track.height ?? 0,
          ...(track.description !== undefined ? { description: track.description } : {}),
          ...(colorSpace !== undefined ? { colorSpace } : {}),
        }
      : {
          codec: track.codec,
          sampleRate: track.sampleRate ?? 0,
          numberOfChannels: track.channels ?? 0,
          ...(track.description !== undefined ? { description: track.description } : {}),
        };
  const gapless = opusGapless(track, frames, includeLeadingGaplessDelay);
  return {
    id,
    mediaType: track.mediaType,
    codec: track.codec,
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(track.language !== undefined ? { language: track.language } : {}),
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
    ...(track.alpha === true || observedAlpha === true ? { alpha: true } : {}),
    ...(containerSideData !== undefined ? { containerSideData } : {}),
    ...(containerProjection !== undefined ? { containerProjection } : {}),
    ...(track.codecDelayNs !== undefined ? { codecDelayNs: track.codecDelayNs } : {}),
    ...(track.seekPreRollNs !== undefined ? { seekPreRollNs: track.seekPreRollNs } : {}),
    ...(track.color !== undefined ? { color: track.color } : {}),
    ...(gapless !== undefined ? { gapless } : {}),
    config,
  };
}

/**
 * Project internal WebM tracks to the public seam while sharing one bounded, owned attachment bundle.
 * Payloads are copied once so a retained TrackInfo does not pin the complete source MKV after close().
 */
function toTrackInfos(
  info: WebmInfo,
  framesByIndex?: readonly (readonly WebmFrame[])[],
): TrackInfo[] {
  const attachedFilePayloads = info.tracks.flatMap((track) =>
    track.attachedFilePayload === undefined ? [] : [track.attachedFilePayload.slice()],
  );
  const containerSideData: readonly ContainerSideData[] | undefined =
    attachedFilePayloads.length === 0
      ? undefined
      : [{ kind: 'matroska-attachments', attachedFilePayloads }];
  let attachmentIndex = 0;
  return info.tracks.map((track, index) => {
    const frames = framesByIndex?.[index];
    const containerProjection: MatroskaAttachmentProjection | undefined =
      track.attachedFilePayload === undefined
        ? undefined
        : {
            kind: 'matroska-attachment',
            sideDataIndex: 0,
            attachmentIndex: attachmentIndex++,
          };
    return toTrackInfo(
      track,
      index,
      info.durationSec,
      frames?.some((frame) => frame.alpha !== undefined) === true,
      frames,
      true,
      containerSideData,
      containerProjection,
    );
  });
}

/** Read the entire source into one buffer — demux walks every Cluster, which spans the whole file. */
async function readAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  assertNotAborted(signal);
  if (src.range && src.size !== undefined && src.size > 0) {
    const bytes = await src.range(0, src.size, signal);
    assertNotAborted(signal);
    return bytes;
  }
  return readStreamAll(src, signal);
}

/** Materialize through the source's sequential stream even when a range facade also exists. */
async function readStreamAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  assertNotAborted(signal);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(abortedError()).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      assertNotAborted(signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  assertNotAborted(signal);
  return out;
}

async function readOwnedWhole(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  const directReadAll = src.readAll;
  // Custom seekable sources may not expose the optional direct-response seam. Retain the established
  // known-size range fallback so a whole-metadata read never needlessly opens their stream facade.
  if (directReadAll === undefined) return readAll(src, signal);
  assertNotAborted(signal);
  try {
    const bytes = await directReadAll.call(src, signal);
    assertNotAborted(signal);
    return bytes;
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    throw error;
  }
}

function findSegment(dv: DataView): EbmlElement | undefined {
  for (const el of elements(dv, 0, dv.byteLength)) {
    if (el.id === ID.Segment) return el;
  }
  return undefined;
}

function segmentHasDeclaredDuration(dv: DataView, segment: EbmlElement): boolean {
  const info = findChild(dv, segment.dataStart, segment.dataEnd, ID.Info);
  return (
    info !== undefined && findChild(dv, info.dataStart, info.dataEnd, ID.Duration) !== undefined
  );
}

function videoTracksHaveDefaultDuration(dv: DataView, segment: EbmlElement): boolean {
  const tracks = findChild(dv, segment.dataStart, segment.dataEnd, ID.Tracks);
  if (tracks === undefined) return false;
  for (const te of elements(dv, tracks.dataStart, tracks.dataEnd)) {
    if (te.id !== ID.TrackEntry) continue;
    let trackType = 0;
    let hasDefaultDuration = false;
    for (const child of elements(dv, te.dataStart, te.dataEnd)) {
      if (child.id === ID.TrackType) trackType = readUint(dv, child);
      else if (child.id === ID.DefaultDuration) hasDefaultDuration = true;
    }
    if (trackType === 1 && !hasDefaultDuration) return false;
  }
  return true;
}

type MetadataReadiness = 'complete' | 'incomplete' | 'needs-terminal-scan';

function isRemoteByteSource(src: ByteSource): boolean {
  const kind = (src as ByteSource & { readonly kind?: string }).kind;
  return kind === 'url' || kind === 'element';
}

type SizedByteSource = ByteSource & { readonly size: number };

function shouldReadWholeRemoteMetadata(src: ByteSource): src is SizedByteSource {
  return (
    src.size !== undefined &&
    src.size > 0 &&
    src.size <= SMALL_REMOTE_WHOLE_PROBE_MAX_BYTES &&
    isRemoteByteSource(src)
  );
}

function metadataPrefixWindows(src: ByteSource): readonly number[] {
  return src.size === undefined && isRemoteByteSource(src)
    ? WEBM_UNKNOWN_REMOTE_METADATA_PREFIX_BYTES
    : WEBM_METADATA_PREFIX_BYTES;
}

function metadataReadiness(bytes: Uint8Array, info: WebmInfo): MetadataReadiness {
  if (info.tracks.length === 0) return 'incomplete';
  for (const track of info.tracks) {
    if (track.mediaType !== 'video') continue;
    if (track.width === undefined || track.height === undefined) return 'incomplete';
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findSegment(dv);
  if (segment === undefined) return 'incomplete';
  const tracks = findChild(dv, segment.dataStart, segment.dataEnd, ID.Tracks);
  // A bounded prefix may contain one complete TrackEntry while truncating its finite parent Tracks
  // element and every following entry. Never freeze that partial declaration as the public track list.
  if (tracks === undefined || !tracks.complete) return 'incomplete';
  for (const child of elements(dv, segment.dataStart, segment.dataEnd)) {
    // A prefix can contain the first AttachedFile while truncating a later one. Do not freeze that
    // partial stream list; grow the range until the finite Attachments element is wholly available.
    if (child.id === ID.Attachments && !child.complete) return 'incomplete';
  }
  // With scanClusters:false, absent duration/fps means the container declarations cannot answer the
  // public timeline. No larger bounded prefix can prove terminal cadence for VFR or a missing Duration;
  // a complete Cluster scan is required, so known-size callers can skip intermediate ladder windows.
  if (
    info.durationSec <= 0 ||
    info.tracks.some((track) => track.mediaType === 'video' && track.fps === undefined)
  ) {
    return 'needs-terminal-scan';
  }
  for (const track of info.tracks) {
    if (
      track.mediaType === 'video' &&
      (track.codec === 'vp9' || track.codec === 'av1') &&
      track.decoderCodecSource === 'unknown'
    ) {
      return 'incomplete';
    }
  }
  if (!segmentHasDeclaredDuration(dv, segment)) return 'incomplete';
  if (!videoTracksHaveDefaultDuration(dv, segment)) return 'incomplete';
  return 'complete';
}

async function readMetadataInfo(src: ByteSource, signal?: AbortSignal): Promise<WebmInfo> {
  assertNotAborted(signal);
  const range = src.range;
  if (range === undefined) return parseWebm(await readAll(src, signal));

  let lastError: unknown;
  const wholeRemote = shouldReadWholeRemoteMetadata(src);
  if (wholeRemote) {
    const declaredSize = src.size;
    const bytes = await readOwnedWhole(src, signal);
    assertNotAborted(signal);
    if (bytes.byteLength !== declaredSize) {
      throw new InputError(
        `WebM source returned ${bytes.byteLength} bytes for declared size ${declaredSize}`,
      );
    }
    return parseWebm(bytes, { sourceSizeBytes: bytes.byteLength });
  }

  // An unknown-size remote source otherwise pays one round trip for the 8 KiB header and another for
  // the terminal scan as soon as that first 206 response reveals a small file. Start at the measured
  // transfer crossover: a compliant range server clamps a smaller file to EOF in one response, while a
  // large source remains bounded and can continue the ordinary metadata ladder without a whole read.
  for (const prefixBytes of metadataPrefixWindows(src)) {
    assertNotAborted(signal);
    const end = src.size === undefined ? prefixBytes : Math.min(prefixBytes, src.size);
    const bytes = await range.call(src, 0, end);
    assertNotAborted(signal);
    let info: WebmInfo;
    try {
      info = parseWebm(bytes, {
        scanClusters: false,
        ...(src.size !== undefined ? { sourceSizeBytes: src.size } : {}),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    const readiness = metadataReadiness(bytes, info);
    if (readiness === 'complete') return info;
    if (
      readiness === 'needs-terminal-scan' &&
      src.size !== undefined &&
      bytes.byteLength < src.size
    ) {
      const completeBytes = await range.call(src, 0, src.size);
      assertNotAborted(signal);
      if (completeBytes.byteLength < src.size) {
        throw new InputError(
          `WebM source ended at ${completeBytes.byteLength} bytes before declared size ${src.size}`,
        );
      }
      return parseWebm(completeBytes, { sourceSizeBytes: src.size });
    }
    if (bytes.byteLength >= (src.size ?? Number.POSITIVE_INFINITY)) {
      return parseWebm(bytes, {
        ...(src.size !== undefined ? { sourceSizeBytes: src.size } : {}),
      });
    }
  }

  try {
    return parseWebm(await readAll(src, signal), {
      ...(src.size !== undefined ? { sourceSizeBytes: src.size } : {}),
    });
  } catch (error) {
    throw lastError ?? error;
  }
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

interface WebmTrimRange {
  startUs: number;
  endUs: number;
  durationSec: number;
  fullRange: boolean;
}

function normalizeTrimRange(
  trim: StreamCopyOptions['trim'] | undefined,
  durationSec: number,
): WebmTrimRange | undefined {
  if (trim === undefined) return undefined;
  const startUs = Math.round(trim.startSec * MICROS_PER_SECOND);
  const endUs = Math.round(trim.endSec * MICROS_PER_SECOND);
  if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || startUs < 0 || endUs <= startUs) {
    throw new InputError(`invalid WebM trim range ${trim.startSec}s..${trim.endSec}s`);
  }
  const sourceDurationUs =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * MICROS_PER_SECOND)
      : undefined;
  const fullRange =
    sourceDurationUs !== undefined &&
    startUs === 0 &&
    endUs >= sourceDurationUs - FULL_RANGE_EPSILON_US;
  return {
    startUs,
    endUs,
    durationSec: fullRange && durationSec > 0 ? durationSec : (endUs - startUs) / MICROS_PER_SECOND,
    fullRange,
  };
}

function videoDecodeStartUs(
  info: WebmInfo,
  framesByIndex: readonly WebmFrame[][],
  startUs: number,
): number {
  let candidate = Number.POSITIVE_INFINITY;
  for (let i = 0; i < info.tracks.length; i++) {
    const track = info.tracks[i];
    if (track?.mediaType !== 'video') continue;
    const frames = framesByIndex[i] ?? [];
    let keyAtOrBefore: number | undefined;
    let firstKey: number | undefined;
    for (const frame of frames) {
      if (!frame.keyframe) continue;
      firstKey ??= frame.timestampUs;
      if (frame.timestampUs <= startUs) keyAtOrBefore = frame.timestampUs;
    }
    const safeStart = keyAtOrBefore ?? firstKey;
    if (safeStart !== undefined) candidate = Math.min(candidate, safeStart);
  }
  return Number.isFinite(candidate) ? candidate : startUs;
}

function frameDurationsUs(
  frames: readonly WebmFrame[],
  sourceDurationUs: number | undefined,
): readonly (number | undefined)[] {
  // `frames` is Block/file order, which is decode order for reordered video. Its adjacent PTS can
  // therefore belong to a distant future/past presentation sample (I,P,B,B is the canonical case).
  // Find the actual neighbours on the presentation timeline instead of deriving a false long packet
  // duration from whichever access unit happens to sit next in the Cluster.
  const presentationTimestampsUs = [...new Set(frames.map((frame) => frame.timestampUs))].sort(
    (left, right) => left - right,
  );
  const inferredByTimestampUs = new Map<number, number>();
  for (let index = 0; index < presentationTimestampsUs.length; index++) {
    const timestampUs = presentationTimestampsUs[index] as number;
    const previousTimestampUs = presentationTimestampsUs[index - 1];
    const nextTimestampUs = presentationTimestampsUs[index + 1];
    if (nextTimestampUs !== undefined) {
      inferredByTimestampUs.set(timestampUs, nextTimestampUs - timestampUs);
    } else if (previousTimestampUs !== undefined) {
      inferredByTimestampUs.set(timestampUs, timestampUs - previousTimestampUs);
    } else if (sourceDurationUs !== undefined && sourceDurationUs > timestampUs) {
      inferredByTimestampUs.set(timestampUs, sourceDurationUs - timestampUs);
    }
  }
  return frames.map((frame) =>
    frame.durationUs !== undefined && frame.durationUs > 0
      ? frame.durationUs
      : inferredByTimestampUs.get(frame.timestampUs),
  );
}

/**
 * Project Matroska's authoritative Block/file decode order onto a monotone decode clock.
 *
 * ffprobe-compatible packet reporting below intentionally exposes its SPS-delay projection, whose
 * leading entries have no preceding presentation timestamps and are consequently PTS-prefixed. That
 * hybrid is useful as reported metadata but is not a safe mux scheduling key: sorting by it can move a
 * P/B access unit ahead of the I/P unit that decodes it. For an actual remux, the source order is the
 * authority; assigning its access units the sorted presentation ticks preserves that order and cadence.
 */
function muxDecodeTimelineUs(
  frames: readonly WebmFrame[],
  reorderDepth: number,
): readonly number[] | undefined {
  if (!Number.isSafeInteger(reorderDepth) || reorderDepth <= 0) return undefined;
  return frames.map((frame) => frame.timestampUs).sort((left, right) => left - right);
}

function firstKeyframeIndex(frames: readonly WebmFrame[], start: number): number {
  for (let i = start; i < frames.length; i++) {
    if (frames[i]?.keyframe === true) return i;
  }
  return start;
}

function firstVideoKeyframeAtOrAfter(
  info: WebmInfo,
  framesByIndex: readonly WebmFrame[][],
  startUs: number,
): number | undefined {
  const candidates: number[] = [];
  for (let i = 0; i < info.tracks.length; i++) {
    const track = info.tracks[i];
    if (track?.mediaType !== 'video') continue;
    const candidate = (framesByIndex[i] ?? []).find(
      (frame) => frame.keyframe && frame.timestampUs >= startUs,
    )?.timestampUs;
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function effectiveCopyRange(
  info: WebmInfo,
  framesByIndex: readonly WebmFrame[][],
  range: WebmTrimRange | undefined,
  sourceDurationUs: number | undefined,
): WebmTrimRange | undefined {
  if (range === undefined || range.fullRange) return range;
  const firstKeyframe = firstVideoKeyframeAtOrAfter(info, framesByIndex, range.startUs);
  const startUs = firstKeyframe ?? videoDecodeStartUs(info, framesByIndex, range.startUs);
  const requestedDurationUs = range.endUs - range.startUs;
  const unclampedEndUs = startUs + requestedDurationUs;
  const endUs =
    sourceDurationUs !== undefined ? Math.min(unclampedEndUs, sourceDurationUs) : unclampedEndUs;
  if (endUs <= startUs) {
    throw new MediaError('mux-error', 'WebM stream-copy trim selected an empty GOP window', {
      trim: { startUs: range.startUs, endUs: range.endUs },
    });
  }
  return {
    startUs,
    endUs,
    durationSec: (endUs - startUs) / MICROS_PER_SECOND,
    fullRange: false,
  };
}

function selectedFrameIndexes(
  track: WebmTrack,
  frames: readonly WebmFrame[],
  range: WebmTrimRange | undefined,
): number[] {
  if (range === undefined || range.fullRange) return frames.map((_frame, index) => index);
  const indexes: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (
      frame !== undefined &&
      frame.timestampUs >= range.startUs &&
      frame.timestampUs < range.endUs
    ) {
      indexes.push(i);
    }
  }
  if (track.mediaType !== 'video' || indexes.length === 0) return indexes;
  const first = indexes[0];
  if (first === undefined || frames[first]?.keyframe === true) return indexes;
  const keyIndex = firstKeyframeIndex(frames, first);
  return indexes.filter((index) => index >= keyIndex);
}

function chunkFromFrame(
  frames: readonly WebmFrame[],
  index: number,
  timestampOffsetUs: number,
  durationUs: number | undefined,
  dtsUs?: number,
): ChunkStruct | undefined {
  const frame = frames[index];
  if (frame === undefined) return undefined;
  return {
    timestampUs: frame.timestampUs - timestampOffsetUs,
    durationUs,
    key: frame.keyframe,
    data: frame.data,
    ...(dtsUs !== undefined ? { dtsUs: dtsUs - timestampOffsetUs } : {}),
    ...(frame.alpha !== undefined ? { alpha: frame.alpha } : {}),
    ...(frame.discardPaddingNs !== undefined ? { discardPaddingNs: frame.discardPaddingNs } : {}),
  };
}

function streamCopyDocType(info: WebmInfo, options: StreamCopyOptions | undefined): string {
  const sourceDocType = info.container === 'mkv' ? 'matroska' : 'webm';
  if (
    options?.trim !== undefined &&
    (options.container === undefined || options.container === 'webm')
  ) {
    return sourceDocType;
  }
  return options?.container === 'mkv' ? 'matroska' : 'webm';
}

async function streamCopyWebm(
  src: ByteSource,
  options: StreamCopyOptions | undefined,
): Promise<ReadableStream<Uint8Array>> {
  if (
    options?.container !== undefined &&
    options.container !== 'webm' &&
    options.container !== 'mkv'
  ) {
    throw new CapabilityError(`the webm driver cannot stream-copy to '${options.container}'`, {
      op: { kind: 'route', id: 'streamCopy' },
      tried: ['webm', 'mkv'],
    });
  }
  assertNotAborted(options?.signal);
  const bytes = await readAll(src, options?.signal);
  if (
    options?.trim !== undefined &&
    Math.abs(options.trim.startSec) <= Number.EPSILON &&
    options.fragmented !== true
  ) {
    const info = parseWebm(bytes, {
      scanClusters: false,
      scanFirstKeyframes: false,
      sourceSizeBytes: bytes.byteLength,
    });
    const requestedRange = normalizeTrimRange(options.trim, info.durationSec);
    const sourceDocType = info.container === 'mkv' ? 'matroska' : 'webm';
    if (requestedRange?.fullRange === true && streamCopyDocType(info, options) === sourceDocType) {
      assertNotAborted(options.signal);
      return streamFromBytes(bytes);
    }
  }
  const demux = demuxWebm(bytes);
  assertNotAborted(options?.signal);
  const sourceDurationUs =
    demux.info.durationSec > 0 ? Math.round(demux.info.durationSec * MICROS_PER_SECOND) : undefined;
  const requestedRange = normalizeTrimRange(options?.trim, demux.info.durationSec);
  const range = effectiveCopyRange(
    demux.info,
    demux.framesByIndex,
    requestedRange,
    sourceDurationUs,
  );
  const timestampOffsetUs = range === undefined || range.fullRange ? 0 : range.startUs;
  const declaredDurationSec = range?.durationSec ?? demux.info.durationSec;
  const muxOptions: MuxOptions = {
    ...(options?.container !== undefined ? { container: options.container } : {}),
    ...(options?.fragmented !== undefined ? { fragmented: options.fragmented } : {}),
  };
  const muxer = new WebmMuxer(muxOptions, streamCopyDocType(demux.info, options));
  for (const track of demux.info.tracks) {
    if (track.attachedFilePayload !== undefined) muxer.addAttachment(track.attachedFilePayload);
  }
  let selectedPackets = 0;
  for (let trackIndex = 0; trackIndex < demux.info.tracks.length; trackIndex++) {
    assertNotAborted(options?.signal);
    const track = demux.info.tracks[trackIndex];
    const frames = demux.framesByIndex[trackIndex] ?? [];
    // Attachments were forwarded above as Segment metadata; they are never Matroska Block tracks.
    if (
      track === undefined ||
      track.nonMedia === true ||
      track.attachmentData !== undefined ||
      frames.length === 0
    )
      continue;
    const indexes = selectedFrameIndexes(track, frames, range);
    if (indexes.length === 0) continue;
    const selectedFrames = indexes.flatMap((index) => {
      const frame = frames[index];
      return frame === undefined ? [] : [frame];
    });
    const decodeTimeline =
      track.mediaType === 'video'
        ? muxDecodeTimelineUs(frames, track.reorderDepth ?? 0)
        : undefined;
    const durationsUs = frameDurationsUs(frames, sourceDurationUs);
    const muxTrackId = muxer.addTrack(
      toTrackInfo(
        track,
        trackIndex,
        declaredDurationSec,
        selectedFrames.some((frame) => frame.alpha !== undefined),
        selectedFrames,
        indexes[0] === 0,
      ),
    );
    for (const index of indexes) {
      assertNotAborted(options?.signal);
      // Matroska blocks carry PTS but their file order is decode order. Use a complete monotone decode
      // clock for every selected access unit; the packet-info reporting projection has a PTS-prefixed
      // lead-in and must never become a writer sort key. Indexing the full clock keeps trim gaps intact.
      const dtsUs = decodeTimeline?.[index];
      const chunk = chunkFromFrame(frames, index, timestampOffsetUs, durationsUs[index], dtsUs);
      if (chunk === undefined) continue;
      muxer.addChunkStruct(muxTrackId, chunk);
      selectedPackets++;
    }
  }
  if (selectedPackets === 0) {
    throw new MediaError('mux-error', 'WebM stream-copy selected no packets', {
      trim: options?.trim,
    });
  }
  await muxer.finalize();
  return muxer.output;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Stream a track's (Simple)Block frames as WebCodecs encoded chunks. Browser-only: the `Encoded*Chunk`
 * constructors are unavailable in Node, so we raise a typed `CapabilityError` (mirroring the mp4/mpegts
 * drivers); the emission body is istanbul-ignored and validated under browser-mode (codec phase). Frame
 * order is decode order (block/file order); each chunk's `data` is a view into the parsed buffer.
 */
function packetStream(
  frames: readonly WebmFrame[],
  track: WebmTrack,
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'WebM packet demux requires WebCodecs EncodedVideoChunk/EncodedAudioChunk (browser/worker only)',
      { op: { kind: 'route', id: 'demux' }, tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (codec phase) */
  const isVideo = track.mediaType === 'video';
  const codecDefinesAudioSync = track.codec === 'opus' || track.codec === 'vorbis';
  const reorderDepth = track.reorderDepth ?? 0;
  const batchPacketLimit = 32;
  const batchByteLimit = 128 * 1024;
  const decodeTimeline = isVideo ? muxDecodeTimelineUs(frames, reorderDepth) : undefined;
  let i = 0;
  return new ReadableStream<Packet>(
    {
      pull(controller): void {
        let emittedPackets = 0;
        let emittedBytes = 0;
        while (
          emittedPackets < batchPacketLimit &&
          (emittedPackets === 0 || emittedBytes < batchByteLimit)
        ) {
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
          const keyframe = codecDefinesAudioSync || frame.keyframe;
          const type = (keyframe ? 'key' : 'delta') as EncodedVideoChunkType;
          if (decodeTimeline === undefined && frame.alpha === undefined) {
            const chunk = isVideo
              ? new EncodedVideoChunk({ type, timestamp: frame.timestampUs, data: frame.data })
              : new EncodedAudioChunk({ type, timestamp: frame.timestampUs, data: frame.data });
            controller.enqueue({
              chunk,
              data: frame.data,
              sizeBytes: frame.data.byteLength,
              // Audio blocks are presentation-order packets, so their PTS is also source-proven DTS.
              // Keep it explicit: packet-copy muxers can then quantize the authored source timeline as
              // cumulative boundaries instead of mistaking it for encoder-produced PTS-only timing.
              ...(!isVideo ? { dtsUs: frame.timestampUs } : {}),
            });
            emittedPackets++;
            emittedBytes += frame.data.byteLength;
            continue;
          }
          const init = {
            // FFmpeg-compatible semantics: self-contained Opus/Vorbis packets are sync packets even when
            // the Matroska block bit is clear; other codecs preserve their explicit container verdict.
            type,
            timestamp: frame.timestampUs,
            data: frame.data,
          };
          // Matroska blocks carry PTS in decode order. For H.264, project that authoritative file order
          // onto a monotone DTS clock; non-reordered frames keep DTS implicit under the Packet contract.
          const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
          const alpha =
            isVideo && frame.alpha !== undefined
              ? new EncodedVideoChunk({ ...init, data: frame.alpha })
              : undefined;
          const dtsUs = decodeTimeline?.[i - 1] ?? frame.timestampUs;
          controller.enqueue({
            chunk,
            data: frame.data,
            sizeBytes: frame.data.byteLength,
            ...(dtsUs !== frame.timestampUs ? { dtsUs } : {}),
            ...(alpha !== undefined ? { alpha } : {}),
          });
          emittedPackets++;
          emittedBytes += frame.data.byteLength;
        }
      },
    },
    { highWaterMark: 0 },
  );
  /* v8 ignore stop */
}

export const WebmDriver: ContainerDriver = {
  id: 'webm',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['webm', 'mkv'],
  supports: matchesWebm,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const signal = o?.signal;
    assertNotAborted(signal);
    const info = await readMetadataInfo(src, signal);
    assertNotAborted(signal);
    return toTrackInfos(info);
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    return webmPacketInfoFromSource(src, o?.signal);
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    // Demux reads the whole file (Clusters span the body) and decodes every (Simple)Block into per-track
    // frames; `packets()` then wraps each frame as a WebCodecs EncodedChunk (browser-gated). The metadata
    // (tracks/duration/description) comes from the same parse, so probe-fidelity carries into demux.
    const signal = o?.signal;
    const bytes = await readAll(src, signal);
    const { info, framesByIndex } = demuxWebm(bytes);
    assertNotAborted(signal);
    const tracks = toTrackInfos(info, framesByIndex);
    const sourceDurationUs =
      info.durationSec > 0 ? Math.round(info.durationSec * MICROS_PER_SECOND) : undefined;
    return {
      tracks,
      packetStats(trackId: number): PacketMetadataStats | undefined {
        const frames = framesByIndex[trackId];
        const track = info.tracks[trackId];
        return frames === undefined || track === undefined
          ? undefined
          : webmTrackPacketStats(frames, sourceDurationUs, track.reorderDepth ?? 0);
      },
      packets(trackId: number): ReadableStream<Packet> {
        const track = info.tracks[trackId];
        const frames = framesByIndex[trackId];
        if (!track || !frames) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(frames, track, signal);
      },
      packetTable(): readonly PacketMetadata[] {
        return packetMetadataRows(bytes, info.tracks, framesByIndex, sourceDurationUs);
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    return streamCopyWebm(src, o);
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
