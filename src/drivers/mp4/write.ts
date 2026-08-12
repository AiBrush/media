/**
 * Write a valid MP4 (ISO-BMFF) from encoded samples — the mirror of {@link parseMovie}. Works in
 * container-native ticks so a demux→mux stream-copy (`remux`) is exact. Layout is faststart by default
 * (moov before mdat, streamable). Each track is one chunk of contiguous samples. Pure TS — round-trip
 * validated (`parse(write(x)) == x`) against the real corpus without a browser.
 */

import { MediaError } from '../../contracts/errors.ts';
import {
  type Mp4DisplayTransform,
  mp4DisplayDimensionWord,
  mp4MatrixFromClockwiseRotation,
} from './display-transform.ts';

const u8 = (n: number): number[] => [n & 0xff];
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u24 = (n: number): number[] => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const u64 = (n: bigint): number[] => [
  Number((n >> 56n) & 0xffn),
  Number((n >> 48n) & 0xffn),
  Number((n >> 40n) & 0xffn),
  Number((n >> 32n) & 0xffn),
  Number((n >> 24n) & 0xffn),
  Number((n >> 16n) & 0xffn),
  Number((n >> 8n) & 0xffn),
  Number(n & 0xffn),
];
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const fourcc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const cat = (...parts: number[][]): number[] => parts.flat();

function box(type: string, payload: number[]): number[] {
  return cat(u32(8 + payload.length), fourcc(type), payload);
}
function full(type: string, version: number, flags: number, payload: number[]): number[] {
  return box(type, cat(u8(version), u24(flags), payload));
}

const IDENTITY_MATRIX = cat(
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

export interface MuxSampleInput {
  data: Uint8Array;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}

export interface MuxSampleLayoutInput {
  byteLength: number;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}

export interface MuxSampleChunkLayoutInput {
  /** First sample index in this track chunk. Chunks must cover the track samples in order. */
  firstSample: number;
  /** Number of consecutive samples from `firstSample` in this chunk. */
  sampleCount: number;
  /** Byte offset of this chunk relative to the first byte of the `mdat` payload. */
  payloadOffset: number;
}

/** CENC protection for a track (ADR-023/121): emits `enca`/`encv` + `sinf`/`tenc` and optional `senc` IVs. */
export interface TrackEncryption {
  schemeType: string; // 'cenc' | 'cens' | 'cbcs'
  kid: Uint8Array; // 16-byte default_KID
  perSampleIvSize: number; // 8/16 per-sample IVs, or 0 for cbcs default_constant_IV
  /** One IV per sample when a `senc` box is emitted. Omitted only for valid cbcs constant-IV tracks. */
  ivs?: Uint8Array[];
  /** cens/cbcs crypt:skip block pattern, serialized in tenc version 1. */
  pattern?: { cryptByteBlock: number; skipByteBlock: number };
  /** cbcs default_constant_IV, serialized only when `perSampleIvSize === 0`. */
  constantIv?: Uint8Array;
}

export interface MuxTrackInput {
  mediaType: 'video' | 'audio';
  sampleEntryType: string; // 'avc1' | 'mp4a'
  timescale: number;
  /** Exact source `mdhd.duration`; omitted on encode paths that derive duration from samples. */
  mediaDurationTicks?: number;
  /** Raw codec-config box (avcC/esds) preserved verbatim for lossless stream-copy. */
  codecPrivate?: { boxType: string; data: Uint8Array };
  /** avcC record (video) or AudioSpecificConfig (audio) — used to synthesize the box on the encode path. */
  description?: Uint8Array;
  width?: number;
  height?: number;
  /** Container-neutral clockwise display rotation, used only when no raw source transform is present. */
  rotation?: number;
  /** Opaque source `tkhd` metadata; takes precedence over synthesized scalar rotation and dimensions. */
  displayTransform?: Mp4DisplayTransform;
  /** Raw parsed `colr` code points preserved for semantic same-family rewrite. */
  colr?: {
    colourType: 'nclc' | 'nclx';
    primaries: number;
    transfer: number;
    matrix: number;
    fullRange?: boolean;
  };
  /** Exact pixel aspect ratio from the visual sample entry. */
  pasp?: { hSpacing: number; vSpacing: number };
  /** Exact clean-aperture fractions from the visual sample entry. */
  clap?: {
    cleanApertureWidthN: number;
    cleanApertureWidthD: number;
    cleanApertureHeightN: number;
    cleanApertureHeightD: number;
    horizOffN: number;
    horizOffD: number;
    vertOffN: number;
    vertOffD: number;
  };
  sampleRate?: number;
  channels?: number;
  /** When set, the track is written as CENC-protected (the samples must already be ciphertext). */
  encryption?: TrackEncryption;
  /** Single-rate edit list, optionally preceded by an empty segment that preserves a delayed track start. */
  edit?: {
    mediaTimeTicks: number;
    durationTicks: number;
    leadingEmptyDurationTicks?: number;
    /** Exact source movie-tick durations, used only when the output retains this movie timescale. */
    movieTimescale?: number;
    durationMovieTicks?: number;
    leadingEmptyDurationMovieTicks?: number;
  };
  /** ISO BMFF `roll` sample-group distance; AAC normally uses -1 (one access unit of decoder preroll). */
  rollDistance?: number;
  /** Optional explicit `mdat` chunk layout; omitted means one contiguous chunk per track. */
  sampleChunks?: readonly MuxSampleChunkLayoutInput[];
  samples: MuxSampleInput[];
}

export type MuxTrackLayoutInput = Omit<MuxTrackInput, 'samples'> & {
  samples: readonly (MuxSampleInput | MuxSampleLayoutInput)[];
};

export interface Mp4ByteStreamLayout {
  ftyp: Uint8Array;
  moov: Uint8Array;
  mdatHeader: Uint8Array;
  mdatBeforeMoov: boolean;
  mdatPayloadLen: number;
  totalLen: number;
}

/** A bounded positioned-write plan for MP4 `faststart:'reserve'`. */
export interface ReservedMp4ByteStreamLayout {
  readonly ftyp: Uint8Array;
  /** Final `moov` followed by a valid `free` box that fills the complete reservation. */
  readonly moovPatch: Uint8Array;
  readonly mdatHeader: Uint8Array;
  readonly reservationPosition: number;
  readonly reservationBytes: number;
  readonly mdatPosition: number;
  readonly mdatPayloadLen: number;
  readonly totalLen: number;
  readonly observedPacketCount: number;
}

/**
 * Output container flavor for callers that target MP4 vs MOV. The writer emits ISO-compatible `ftyp`
 * brands for both flavors because the rest of the file is authored as ISO-BMFF; Safari/WebKit can raise a
 * decode error when a `qt  ` major brand advertises a stricter QuickTime dialect over this layout.
 */
export type ContainerBrand = 'mp4' | 'mov';

export interface WriteOptions {
  faststart?: boolean;
  movieTimescale?: number;
  /** Container flavor for the `ftyp` brands (default `'mp4'`). */
  brand?: ContainerBrand;
}

/** Positioned output used when a valid MP4 address space is larger than one JavaScript buffer. */
export interface SparseMp4WriteTarget {
  setSize(size: bigint | string): void;
  write(position: bigint | string, bytes: Uint8Array): void;
}

export interface SparseMp4WriteOptions extends Omit<WriteOptions, 'faststart'> {
  /** Complete virtual file extent. Sparse holes are part of the large `mdat` box. */
  fileSize: bigint;
  /** One absolute file offset per sample, in the same per-track order as `tracks`. */
  sampleOffsets: readonly (readonly bigint[])[];
}

interface RunLength {
  count: number;
  value: number;
}

interface NormalizedTrackChunk {
  firstSample: number;
  sampleCount: number;
  payloadOffset: number;
  byteLength: number;
}

interface TrackChunkLayout {
  chunks: readonly NormalizedTrackChunk[];
}

interface TrackChunkTable {
  chunks: readonly NormalizedTrackChunk[];
  chunkOffsets: readonly (number | bigint)[];
}

function runLength(values: readonly number[]): RunLength[] {
  const out: RunLength[] = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last.value === v) last.count++;
    else out.push({ count: 1, value: v });
  }
  return out;
}

// Sample tables (stsz/stts/ctts/stss) hold one or two u32s per entry and can run to 100k+ entries on a
// long file. Build them by pushing bytes into a single array — NEVER `cat(u32(n), ...vals.map(u32))`,
// whose spread passes every entry as a separate function argument and overflows the call stack at the
// massive rung (the `Maximum call stack size exceeded` crash). Output bytes are identical either way.
function pushU32(out: number[], n: number): void {
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
function u32Table(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) pushU32(out, v);
  return out;
}
function u64Table(values: readonly (number | bigint)[]): number[] {
  const out: number[] = [];
  for (const value of values) out.push(...u64(typeof value === 'bigint' ? value : BigInt(value)));
  return out;
}
function runLengthTable(runs: readonly RunLength[]): number[] {
  const out: number[] = [];
  for (const e of runs) {
    pushU32(out, e.count);
    pushU32(out, e.value);
  }
  return out;
}

function sampleByteLength(sample: MuxSampleInput | MuxSampleLayoutInput): number {
  return 'data' in sample ? sample.data.byteLength : sample.byteLength;
}

function trackDurationTicks(track: MuxTrackLayoutInput): number {
  return track.samples.reduce((a, s) => a + s.durationTicks, 0);
}

function tkhdDisplayFields(track: MuxTrackLayoutInput): number[] {
  const raw = track.displayTransform;
  const matrix =
    raw?.matrix ?? mp4MatrixFromClockwiseRotation(track.rotation, track.width, track.height);
  return cat(
    ...matrix.map((word) => u32(word)),
    u32(raw?.width16_16 ?? mp4DisplayDimensionWord(track.width)),
    u32(raw?.height16_16 ?? mp4DisplayDimensionWord(track.height)),
  );
}

function trackMovieDurationTicks(track: MuxTrackLayoutInput, movieTimescale: number): number {
  if (
    track.edit?.movieTimescale === movieTimescale &&
    track.edit.durationMovieTicks !== undefined
  ) {
    return track.edit.durationMovieTicks + (track.edit.leadingEmptyDurationMovieTicks ?? 0);
  }
  const durationTicks = track.edit?.durationTicks ?? trackDurationTicks(track);
  const leadingEmptyDurationTicks = track.edit?.leadingEmptyDurationTicks ?? 0;
  return (
    Math.round((durationTicks * movieTimescale) / track.timescale) +
    Math.round((leadingEmptyDurationTicks * movieTimescale) / track.timescale)
  );
}

/** Build an `esds` box wrapping an AudioSpecificConfig (the reverse of `parseEsds`). */
function esdsBox(asc: Uint8Array): number[] {
  const dsi = cat([0x05, asc.byteLength], [...asc]);
  const dcdPayload = cat([0x40, 0x15], u24(0), u32(0), u32(0), dsi);
  const dcd = cat([0x04, dcdPayload.length], dcdPayload);
  const esPayload = cat(u16(0), u8(0), dcd);
  const es = cat([0x03, esPayload.length], esPayload);
  return full('esds', 0, 0, es);
}

/** The codec-config box: the preserved raw box (lossless remux) or a synthesized one (encode path). */
function codecConfigBox(track: MuxTrackLayoutInput): number[] {
  if (track.codecPrivate) return box(track.codecPrivate.boxType, [...track.codecPrivate.data]);
  if (track.mediaType === 'video' && track.description) return box('avcC', [...track.description]);
  if (track.mediaType === 'audio' && track.description) return esdsBox(track.description);
  return [];
}

function visualSideDataBoxes(track: MuxTrackLayoutInput): number[] {
  const colr = track.colr;
  const colrBox =
    colr === undefined
      ? []
      : box(
          'colr',
          cat(
            fourcc(colr.colourType),
            u16(colr.primaries),
            u16(colr.transfer),
            u16(colr.matrix),
            colr.colourType === 'nclx' ? u8(colr.fullRange === true ? 0x80 : 0) : [],
          ),
        );
  const paspBox =
    track.pasp === undefined
      ? []
      : box('pasp', cat(u32(track.pasp.hSpacing), u32(track.pasp.vSpacing)));
  const clapBox =
    track.clap === undefined
      ? []
      : box(
          'clap',
          cat(
            u32(track.clap.cleanApertureWidthN),
            u32(track.clap.cleanApertureWidthD),
            u32(track.clap.cleanApertureHeightN),
            u32(track.clap.cleanApertureHeightD),
            u32(track.clap.horizOffN),
            u32(track.clap.horizOffD),
            u32(track.clap.vertOffN),
            u32(track.clap.vertOffD),
          ),
        );
  return cat(colrBox, paspBox, clapBox);
}

/** The `sinf` protection box (`frma`/`schm`/`schi`→`tenc`) wrapping the original format, when protected. */
function sinfBox(track: MuxTrackLayoutInput): number[] {
  const enc = track.encryption;
  if (!enc) return [];
  if (enc.constantIv && enc.schemeType !== 'cbcs') {
    throw new MediaError('mux-error', 'default_constant_IV is valid only for cbcs protection');
  }
  if (enc.constantIv && enc.perSampleIvSize !== 0) {
    throw new MediaError('mux-error', 'cbcs default_constant_IV requires perSampleIvSize 0');
  }
  if (enc.perSampleIvSize === 0 && !enc.constantIv) {
    throw new MediaError('mux-error', 'perSampleIvSize 0 requires a cbcs default_constant_IV');
  }
  const patternByte = enc.pattern
    ? ((enc.pattern.cryptByteBlock & 0x0f) << 4) | (enc.pattern.skipByteBlock & 0x0f)
    : 0;
  const version = enc.pattern || enc.constantIv ? 1 : 0;
  const constantIv = enc.constantIv ? cat(u8(enc.constantIv.byteLength), [...enc.constantIv]) : [];
  const frma = box('frma', fourcc(track.sampleEntryType));
  const schm = full('schm', 0, 0, cat(fourcc(enc.schemeType), u32(0x00010000)));
  const tenc = full(
    'tenc',
    version,
    0,
    cat(u8(0), u8(patternByte), u8(1), u8(enc.perSampleIvSize), [...enc.kid], constantIv),
  );
  return box('sinf', cat(frma, schm, box('schi', tenc)));
}

/** The `senc` sample-encryption box: per-sample IVs (flags=0 → no subsamples for audio). */
function sencBox(track: MuxTrackLayoutInput): number[] {
  const enc = track.encryption;
  if (!enc) return [];
  if (!enc.ivs) {
    if (enc.perSampleIvSize === 0) return [];
    throw new MediaError('mux-error', 'per-sample CENC encryption requires one IV per sample');
  }
  if (enc.ivs.length !== track.samples.length) {
    throw new MediaError(
      'mux-error',
      `senc IV count ${enc.ivs.length} does not match sample count ${track.samples.length}`,
    );
  }
  for (const iv of enc.ivs) {
    if (iv.byteLength !== enc.perSampleIvSize) {
      throw new MediaError(
        'mux-error',
        `senc IV length ${iv.byteLength} does not match perSampleIvSize ${enc.perSampleIvSize}`,
      );
    }
  }
  return full(
    'senc',
    0,
    0,
    cat(
      u32(enc.ivs.length),
      enc.ivs.flatMap((iv) => [...iv]),
    ),
  );
}

function videoSampleEntry(track: MuxTrackLayoutInput): number[] {
  return box(
    track.encryption ? 'encv' : track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(16), // pre_defined + reserved + pre_defined[3]
      u16(track.width ?? 0),
      u16(track.height ?? 0),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1), // resolutions + reserved + frame_count
      zeros(32),
      u16(0x0018),
      u16(0xffff), // compressorname + depth + pre_defined
      codecConfigBox(track),
      visualSideDataBoxes(track),
      sinfBox(track),
    ),
  );
}

function audioSampleEntry(track: MuxTrackLayoutInput): number[] {
  return box(
    track.encryption ? 'enca' : track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(8), // reserved
      u16(track.channels ?? 2),
      u16(16),
      zeros(4), // samplesize + pre_defined + reserved
      u32((track.sampleRate ?? 48000) * 65536), // 16.16 fixed
      codecConfigBox(track),
      sinfBox(track),
    ),
  );
}

function sampleToChunkEntries(chunks: readonly NormalizedTrackChunk[]): number[] {
  const out: number[] = [];
  let previousSampleCount: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const sampleCount = chunks[i]?.sampleCount;
    if (sampleCount === undefined || sampleCount === previousSampleCount) continue;
    pushU32(out, i + 1);
    pushU32(out, sampleCount);
    pushU32(out, 1);
    previousSampleCount = sampleCount;
  }
  return out;
}

/**
 * Explicit AAC priming marker (ISO sample groups / QuickTime AAC priming appendix). `elst` carries the
 * source waveform window; `sgpd` + `sbgp` declare that the offset is explicit and describe one access
 * unit of decoder roll. Without these boxes Apple readers apply the historical implicit 2,112 rule.
 */
function rollSampleGroups(track: MuxTrackLayoutInput): number[] {
  const distance = track.rollDistance;
  if (distance === undefined) return [];
  if (!Number.isInteger(distance) || distance < -0x8000 || distance > 0x7fff) {
    throw new MediaError('mux-error', `roll distance ${distance} is outside signed 16-bit range`);
  }
  const sgpd = full(
    'sgpd',
    1,
    0,
    cat(
      fourcc('roll'),
      u32(2), // default_length: one signed i16 roll_distance
      u32(1), // entry_count
      u16(distance),
    ),
  );
  const sbgp = full(
    'sbgp',
    0,
    0,
    cat(
      fourcc('roll'),
      u32(1), // entry_count
      u32(track.samples.length),
      u32(1), // group_description_index
    ),
  );
  return cat(sgpd, sbgp);
}

function sampleTable(track: MuxTrackLayoutInput, chunkTable: TrackChunkTable): number[] {
  const entry = track.mediaType === 'video' ? videoSampleEntry(track) : audioSampleEntry(track);
  const sizes = track.samples.map(sampleByteLength);
  const stts = runLength(track.samples.map((s) => s.durationTicks));
  const cttsVals = track.samples.map((s) => s.cttsTicks);
  const hasCtts = cttsVals.some((v) => v !== 0);
  const ctts = runLength(cttsVals);
  const cttsVersion = cttsVals.some((v) => v < 0) ? 1 : 0;
  const sync = track.samples.flatMap((s, i) => (s.keyframe ? [i + 1] : []));
  const allSync = sync.length === track.samples.length;
  const sampleToChunk = sampleToChunkEntries(chunkTable.chunks);
  const useCo64 = chunkTable.chunkOffsets.some(
    (offset) => typeof offset === 'bigint' || offset > 0xffffffff,
  );
  const chunkOffsetPayload = useCo64
    ? u64Table(chunkTable.chunkOffsets)
    : u32Table(chunkTable.chunkOffsets as readonly number[]);

  const children = cat(
    full('stsd', 0, 0, cat(u32(1), entry)),
    full('stts', 0, 0, cat(u32(stts.length), runLengthTable(stts))),
    hasCtts ? full('ctts', cttsVersion, 0, cat(u32(ctts.length), runLengthTable(ctts))) : [],
    full('stsz', 0, 0, cat(u32(0), u32(sizes.length), u32Table(sizes))),
    full('stsc', 0, 0, cat(u32(sampleToChunk.length / 12), sampleToChunk)),
    full(
      useCo64 ? 'co64' : 'stco',
      0,
      0,
      cat(u32(chunkTable.chunkOffsets.length), chunkOffsetPayload),
    ),
    allSync ? [] : full('stss', 0, 0, cat(u32(sync.length), u32Table(sync))),
    rollSampleGroups(track),
    sencBox(track),
  );
  return box('stbl', children);
}

function editList(track: MuxTrackLayoutInput, movieTimescale: number): number[] {
  const edit = track.edit;
  if (edit === undefined) return [];
  const preservesSourceMovieClock = edit.movieTimescale === movieTimescale;
  const segmentDuration =
    preservesSourceMovieClock && edit.durationMovieTicks !== undefined
      ? edit.durationMovieTicks
      : Math.round((edit.durationTicks * movieTimescale) / track.timescale);
  const leadingEmptyDuration =
    preservesSourceMovieClock && edit.leadingEmptyDurationMovieTicks !== undefined
      ? edit.leadingEmptyDurationMovieTicks
      : Math.round(((edit.leadingEmptyDurationTicks ?? 0) * movieTimescale) / track.timescale);
  if (segmentDuration < 0 || segmentDuration > 0xffffffff) {
    throw new MediaError(
      'mux-error',
      `MP4 edit segment_duration ${segmentDuration} exceeds version-0 elst`,
    );
  }
  if (edit.mediaTimeTicks < 0 || edit.mediaTimeTicks > 0x7fffffff) {
    throw new MediaError(
      'mux-error',
      `MP4 edit media_time ${edit.mediaTimeTicks} exceeds version-0 elst`,
    );
  }
  if (leadingEmptyDuration < 0 || leadingEmptyDuration > 0xffffffff) {
    throw new MediaError(
      'mux-error',
      `MP4 leading empty edit duration ${leadingEmptyDuration} exceeds version-0 elst`,
    );
  }
  const activeEntry = cat(u32(segmentDuration), u32(edit.mediaTimeTicks), u16(1), u16(0));
  const entries =
    leadingEmptyDuration > 0
      ? cat(u32(2), u32(leadingEmptyDuration), u32(0xffffffff), u16(1), u16(0), activeEntry)
      : cat(u32(1), activeEntry);
  return box('edts', full('elst', 0, 0, entries));
}

function trak(
  track: MuxTrackLayoutInput,
  trackId: number,
  movieTimescale: number,
  chunkTable: TrackChunkTable,
): number[] {
  const durTicks = track.mediaDurationTicks ?? trackDurationTicks(track);
  const movieDur = trackMovieDurationTicks(track, movieTimescale);
  const isVideo = track.mediaType === 'video';

  const tkhd = full(
    'tkhd',
    0,
    0x000007,
    cat(
      zeros(8),
      u32(trackId),
      zeros(4),
      u32(movieDur),
      zeros(8),
      u16(0),
      u16(0),
      u16(isVideo ? 0 : 0x0100),
      u16(0), // layer + altgroup + volume + reserved
      tkhdDisplayFields(track),
    ),
  );

  const mdhd = full(
    'mdhd',
    0,
    0,
    cat(zeros(8), u32(track.timescale), u32(durTicks), u16(0x55c4), u16(0)),
  );
  const hdlr = full(
    'hdlr',
    0,
    0,
    cat(zeros(4), fourcc(isVideo ? 'vide' : 'soun'), zeros(12), u8(0)),
  );
  const mediaHeader = isVideo
    ? full('vmhd', 0, 1, cat(u16(0), zeros(6)))
    : full('smhd', 0, 0, cat(u16(0), u16(0)));
  const dref = full('dref', 0, 0, cat(u32(1), full('url ', 0, 1, [])));
  const minf = box('minf', cat(mediaHeader, box('dinf', dref), sampleTable(track, chunkTable)));
  const mdia = box('mdia', cat(mdhd, hdlr, minf));
  return box('trak', cat(tkhd, editList(track, movieTimescale), mdia));
}

function moov(
  tracks: readonly MuxTrackLayoutInput[],
  movieTimescale: number,
  chunkTables: readonly TrackChunkTable[],
): number[] {
  const movieDur = tracks.reduce(
    (max, t) => Math.max(max, trackMovieDurationTicks(t, movieTimescale)),
    0,
  );
  const mvhd = full(
    'mvhd',
    0,
    0,
    cat(
      zeros(8),
      u32(movieTimescale),
      u32(movieDur),
      u32(0x00010000),
      u16(0x0100),
      zeros(10), // rate + volume + reserved
      IDENTITY_MATRIX,
      zeros(24), // pre_defined
      u32(tracks.length + 1), // next_track_id
    ),
  );
  const traks = tracks.flatMap((t, i) =>
    trak(t, i + 1, movieTimescale, chunkTables[i] ?? { chunks: [], chunkOffsets: [] }),
  );
  return box('moov', cat(mvhd, traks));
}

function addUniqueBrand(out: string[], brand: string): void {
  if (!out.includes(brand)) out.push(brand);
}

function compatibleBrandsFor(tracks: readonly MuxTrackLayoutInput[]): string[] {
  const brands = ['isom', 'iso2'];
  for (const track of tracks) {
    if (track.mediaType !== 'video') continue;
    const entry = track.sampleEntryType;
    if (entry === 'avc1' || entry === 'avc3') addUniqueBrand(brands, 'avc1');
    else if (entry === 'hvc1' || entry === 'hev1') addUniqueBrand(brands, entry);
    else if (entry === 'av01') addUniqueBrand(brands, 'av01');
  }
  addUniqueBrand(brands, 'mp41');
  return brands;
}

function ftypBox(brand: ContainerBrand, tracks: readonly MuxTrackLayoutInput[]): number[] {
  void brand;
  return box(
    'ftyp',
    cat(
      fourcc('isom'),
      u32(0x200),
      ...compatibleBrandsFor(tracks).map((codecBrand) => fourcc(codecBrand)),
    ),
  );
}

// A single Uint8Array (and the ISO 32-bit box `size`) tops out near 4.29 GB. Beyond that a buffer
// target genuinely can't materialize the output in one allocation — the caller must use a stream
// target. Named so the guard is testable without allocating multi-GB buffers.
const MAX_SINGLE_BUFFER = 0xffffffff;

/** Guard that an in-memory (buffer-target) output fits one Uint8Array; else a typed mux miss. */
export function assertSingleBufferSize(totalLen: number): void {
  if (totalLen > MAX_SINGLE_BUFFER) {
    throw new MediaError(
      'mux-error',
      `output is ${totalLen} bytes, over the ${MAX_SINGLE_BUFFER}-byte single-buffer limit; use a stream target`,
    );
  }
}

function chunkByteLength(
  track: MuxTrackLayoutInput,
  firstSample: number,
  sampleCount: number,
): number {
  let bytes = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = track.samples[firstSample + i];
    if (sample === undefined) {
      throw new MediaError('mux-error', 'MP4 chunk layout references a missing sample');
    }
    bytes += sampleByteLength(sample);
  }
  return bytes;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MediaError('mux-error', `MP4 chunk layout has invalid ${label}: ${value}`);
  }
}

function explicitTrackChunks(track: MuxTrackLayoutInput): NormalizedTrackChunk[] {
  const chunks = track.sampleChunks;
  if (chunks === undefined) {
    throw new MediaError('mux-error', 'MP4 explicit chunk layout is missing for a track');
  }
  const out: NormalizedTrackChunk[] = [];
  let expectedFirstSample = 0;
  for (const chunk of chunks) {
    assertNonNegativeInteger(chunk.firstSample, 'firstSample');
    assertNonNegativeInteger(chunk.sampleCount, 'sampleCount');
    assertNonNegativeInteger(chunk.payloadOffset, 'payloadOffset');
    if (chunk.sampleCount === 0) {
      throw new MediaError('mux-error', 'MP4 chunk layout contains an empty chunk');
    }
    if (chunk.firstSample !== expectedFirstSample) {
      throw new MediaError('mux-error', 'MP4 chunk layout must cover track samples in order');
    }
    if (chunk.firstSample + chunk.sampleCount > track.samples.length) {
      throw new MediaError('mux-error', 'MP4 chunk layout extends past the track sample table');
    }
    out.push({
      firstSample: chunk.firstSample,
      sampleCount: chunk.sampleCount,
      payloadOffset: chunk.payloadOffset,
      byteLength: chunkByteLength(track, chunk.firstSample, chunk.sampleCount),
    });
    expectedFirstSample += chunk.sampleCount;
  }
  if (expectedFirstSample !== track.samples.length) {
    throw new MediaError('mux-error', 'MP4 chunk layout does not cover every track sample');
  }
  return out;
}

function defaultTrackChunks(tracks: readonly MuxTrackLayoutInput[]): {
  readonly layouts: TrackChunkLayout[];
  readonly totalPayloadBytes: number;
} {
  const layouts: TrackChunkLayout[] = [];
  let payloadOffset = 0;
  for (const track of tracks) {
    const byteLength = track.samples.reduce((sum, sample) => sum + sampleByteLength(sample), 0);
    const chunks =
      track.samples.length === 0
        ? []
        : [{ firstSample: 0, sampleCount: track.samples.length, payloadOffset, byteLength }];
    layouts.push({ chunks });
    payloadOffset += byteLength;
  }
  return { layouts, totalPayloadBytes: payloadOffset };
}

function explicitTrackChunkLayouts(tracks: readonly MuxTrackLayoutInput[]): {
  readonly layouts: TrackChunkLayout[];
  readonly totalPayloadBytes: number;
} {
  const chunks: Array<NormalizedTrackChunk & { readonly trackIndex: number }> = [];
  const layouts = tracks.map((track, trackIndex) => {
    const trackChunks = explicitTrackChunks(track);
    for (const chunk of trackChunks) chunks.push({ ...chunk, trackIndex });
    return { chunks: trackChunks };
  });
  chunks.sort((a, b) => a.payloadOffset - b.payloadOffset || a.trackIndex - b.trackIndex);
  let expectedPayloadOffset = 0;
  for (const chunk of chunks) {
    if (chunk.payloadOffset !== expectedPayloadOffset) {
      throw new MediaError(
        'mux-error',
        'MP4 chunk layout must cover the mdat payload without gaps',
      );
    }
    expectedPayloadOffset += chunk.byteLength;
  }
  return { layouts, totalPayloadBytes: expectedPayloadOffset };
}

function trackChunkLayouts(tracks: readonly MuxTrackLayoutInput[]): {
  readonly layouts: TrackChunkLayout[];
  readonly totalPayloadBytes: number;
} {
  const hasExplicitChunks = tracks.some((track) => track.sampleChunks !== undefined);
  if (!hasExplicitChunks) return defaultTrackChunks(tracks);
  if (!tracks.every((track) => track.sampleChunks !== undefined)) {
    throw new MediaError('mux-error', 'MP4 explicit chunk layout must be provided for every track');
  }
  return explicitTrackChunkLayouts(tracks);
}

function chunkTablesFor(
  layouts: readonly TrackChunkLayout[],
  mdatStart: number,
): TrackChunkTable[] {
  return layouts.map((layout) => ({
    chunks: layout.chunks,
    chunkOffsets: layout.chunks.map((chunk) => mdatStart + 8 + chunk.payloadOffset),
  }));
}

function zeroChunkTables(layouts: readonly TrackChunkLayout[]): TrackChunkTable[] {
  return layouts.map((layout) => ({
    chunks: layout.chunks,
    chunkOffsets: layout.chunks.map(() => 0),
  }));
}

interface GeneratedBoxRange {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

function generatedU32(bytes: readonly number[], offset: number): number {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new MediaError('mux-error', 'internal MP4 moov patch encountered a truncated u32');
  }
  return a * 0x1000000 + b * 0x10000 + c * 0x100 + d;
}

function generatedFourcc(bytes: readonly number[], offset: number): string {
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new MediaError('mux-error', 'internal MP4 moov patch encountered a truncated fourcc');
  }
  return String.fromCharCode(a, b, c, d);
}

function generatedBoxAt(
  bytes: readonly number[],
  start: number,
  parentEnd: number,
): GeneratedBoxRange {
  if (start < 0 || start + 8 > parentEnd || parentEnd > bytes.length) {
    throw new MediaError('mux-error', 'internal MP4 moov patch encountered a truncated box header');
  }
  const size = generatedU32(bytes, start);
  const end = start + size;
  if (size < 8 || !Number.isSafeInteger(end) || end <= start || end > parentEnd) {
    throw new MediaError('mux-error', 'internal MP4 moov patch encountered an invalid box range');
  }
  return {
    type: generatedFourcc(bytes, start + 4),
    start,
    end,
  };
}

function generatedChildren(
  bytes: readonly number[],
  parent: GeneratedBoxRange,
): GeneratedBoxRange[] {
  const children: GeneratedBoxRange[] = [];
  let offset = parent.start + 8;
  while (offset < parent.end) {
    const child = generatedBoxAt(bytes, offset, parent.end);
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) {
    throw new MediaError('mux-error', 'internal MP4 moov patch did not consume a container box');
  }
  return children;
}

function requiredGeneratedChild(
  bytes: readonly number[],
  parent: GeneratedBoxRange,
  type: string,
): GeneratedBoxRange {
  const matches = generatedChildren(bytes, parent).filter((child) => child.type === type);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new MediaError(
      'mux-error',
      `internal MP4 moov patch expected one '${type}' child, got ${matches.length}`,
    );
  }
  return matches[0];
}

function patchGeneratedU32(bytes: number[], offset: number, value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff ||
    offset + 4 > bytes.length
  ) {
    throw new MediaError('mux-error', `internal MP4 moov patch has invalid stco offset ${value}`);
  }
  bytes[offset] = Math.floor(value / 0x1000000) & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x10000) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** Patch only fixed-width `stco` values in a writer-owned zero-offset moov; its byte length is unchanged. */
function patchGeneratedMoovChunkOffsets(
  moovBytes: number[],
  chunkTables: readonly TrackChunkTable[],
): void {
  const root = generatedBoxAt(moovBytes, 0, moovBytes.length);
  if (root.type !== 'moov' || root.end !== moovBytes.length) {
    throw new MediaError('mux-error', 'internal MP4 moov patch expected one complete moov box');
  }
  const tracks = generatedChildren(moovBytes, root).filter((child) => child.type === 'trak');
  if (tracks.length !== chunkTables.length) {
    throw new MediaError(
      'mux-error',
      `internal MP4 moov patch track count ${tracks.length} does not match ${chunkTables.length}`,
    );
  }

  let patchedOffsets = 0;
  let plannedOffsets = 0;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const chunkTable = chunkTables[trackIndex];
    if (track === undefined || chunkTable === undefined) {
      throw new MediaError('mux-error', 'internal MP4 moov patch lost track order');
    }
    const mdia = requiredGeneratedChild(moovBytes, track, 'mdia');
    const minf = requiredGeneratedChild(moovBytes, mdia, 'minf');
    const stbl = requiredGeneratedChild(moovBytes, minf, 'stbl');
    const stco = requiredGeneratedChild(moovBytes, stbl, 'stco');
    if (stco.start + 16 > stco.end) {
      throw new MediaError('mux-error', 'internal MP4 moov patch encountered a truncated stco');
    }
    const entryCount = generatedU32(moovBytes, stco.start + 12);
    if (
      entryCount !== chunkTable.chunkOffsets.length ||
      stco.start + 16 + entryCount * 4 !== stco.end
    ) {
      throw new MediaError(
        'mux-error',
        `internal MP4 moov patch stco count ${entryCount} does not match ${chunkTable.chunkOffsets.length}`,
      );
    }
    plannedOffsets += chunkTable.chunkOffsets.length;
    for (let index = 0; index < entryCount; index++) {
      const chunkOffset = chunkTable.chunkOffsets[index];
      if (chunkOffset === undefined) {
        throw new MediaError('mux-error', 'internal MP4 moov patch lost a planned chunk offset');
      }
      if (typeof chunkOffset === 'bigint') {
        throw new MediaError('mux-error', 'internal MP4 stco patch received a 64-bit chunk offset');
      }
      patchGeneratedU32(moovBytes, stco.start + 16 + index * 4, chunkOffset);
      patchedOffsets++;
    }
  }
  if (patchedOffsets !== plannedOffsets) {
    throw new MediaError(
      'mux-error',
      `internal MP4 moov patch wrote ${patchedOffsets} of ${plannedOffsets} offsets`,
    );
  }
}

/** Copy samples into their planned `mdat` chunk positions; returns the advanced position. */
function writeSamples(
  out: Uint8Array,
  pos: number,
  tracks: MuxTrackInput[],
  layouts: readonly TrackChunkLayout[],
): number {
  let end = pos;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const layout = layouts[trackIndex];
    if (track === undefined || layout === undefined) continue;
    for (const chunk of layout.chunks) {
      let p = pos + chunk.payloadOffset;
      for (let i = 0; i < chunk.sampleCount; i++) {
        const sample = track.samples[chunk.firstSample + i];
        if (sample === undefined)
          throw new MediaError('mux-error', 'MP4 chunk write missed a sample');
        out.set(sample.data, p);
        p += sample.data.byteLength;
      }
      end = Math.max(end, p);
    }
  }
  return end;
}

interface Mp4LayoutParts {
  ftyp: number[];
  moov: number[];
  mdatHeader: number[];
  mdatBeforeMoov: boolean;
  mdatPayloadLen: number;
  totalLen: number;
  trackChunks: readonly TrackChunkLayout[];
}

function mp4LayoutParts(
  tracks: readonly MuxTrackLayoutInput[],
  opts: WriteOptions = {},
): Mp4LayoutParts {
  const movieTimescale = opts.movieTimescale ?? 1000;
  const faststart = opts.faststart ?? true;
  const ftyp = ftypBox(opts.brand ?? 'mp4', tracks);

  const { layouts: trackChunks, totalPayloadBytes: mdatPayloadLen } = trackChunkLayouts(tracks);
  const mdatHeader = cat(u32(8 + mdatPayloadLen), fourcc('mdat')); // 8-byte box header (size ≤ 4.29 GB)

  // moov carries absolute sample offsets, which depend on whether mdat follows it (faststart) or
  // precedes it. Offsets are fixed-width u32, so a zero-offset pass yields moov's exact length, letting
  // us place mdat right after it.
  let moovBytes: number[];
  let mdatBeforeMoov: boolean;
  if (faststart) {
    moovBytes = moov(tracks, movieTimescale, zeroChunkTables(trackChunks));
    const mdatStart = ftyp.length + moovBytes.length;
    patchGeneratedMoovChunkOffsets(moovBytes, chunkTablesFor(trackChunks, mdatStart));
    mdatBeforeMoov = false;
  } else {
    moovBytes = moov(tracks, movieTimescale, chunkTablesFor(trackChunks, ftyp.length));
    mdatBeforeMoov = true;
  }

  const totalLen = ftyp.length + moovBytes.length + mdatHeader.length + mdatPayloadLen;
  assertSingleBufferSize(totalLen);
  return {
    ftyp,
    moov: moovBytes,
    mdatHeader,
    mdatBeforeMoov,
    mdatPayloadLen,
    totalLen,
    trackChunks,
  };
}

export function planMp4ByteStreamLayout(
  tracks: readonly MuxTrackLayoutInput[],
  opts: WriteOptions = {},
): Mp4ByteStreamLayout {
  const parts = mp4LayoutParts(tracks, opts);
  return {
    ftyp: Uint8Array.from(parts.ftyp),
    moov: Uint8Array.from(parts.moov),
    mdatHeader: Uint8Array.from(parts.mdatHeader),
    mdatBeforeMoov: parts.mdatBeforeMoov,
    mdatPayloadLen: parts.mdatPayloadLen,
    totalLen: parts.totalLen,
  };
}

const RESERVE_TRACK_OVERHEAD_BYTES = 4 * 1024;
const RESERVE_PACKET_TABLE_BYTES = 64;

/**
 * Plan a sparse reserved-moov MP4. The estimate deliberately covers the maximum simultaneous `stts`,
 * `ctts`, `stsz`, `stss`, `stsc`, `stco`, and 16-byte `senc` growth per packet, plus fixed track box
 * overhead. The actual writer-owned moov remains the final authority: unusually large codec metadata
 * expands the reservation rather than producing a truncated patch.
 */
export function planReservedMp4ByteStreamLayout(
  tracks: readonly MuxTrackLayoutInput[],
  maximumPacketCount: number,
  opts: Omit<WriteOptions, 'faststart'> = {},
): ReservedMp4ByteStreamLayout {
  if (!Number.isSafeInteger(maximumPacketCount) || maximumPacketCount < 1) {
    throw new MediaError(
      'mux-error',
      `MP4 faststart reserve maximumPacketCount must be a positive integer, got ${maximumPacketCount}`,
    );
  }
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot reserve an MP4 moov for zero tracks');
  }

  let observedPacketCount = 0;
  for (let index = 0; index < tracks.length; index++) {
    const count = tracks[index]?.samples.length ?? 0;
    observedPacketCount = Math.max(observedPacketCount, count);
    if (count > maximumPacketCount) {
      throw new MediaError(
        'mux-error',
        `[MP4_FASTSTART_RESERVE_PACKET_OVERFLOW] track ${index + 1} has ${count} packets, exceeding maximumPacketCount ${maximumPacketCount}`,
      );
    }
  }

  const movieTimescale = opts.movieTimescale ?? 1000;
  const ftyp = ftypBox(opts.brand ?? 'mp4', tracks);
  const { layouts: trackChunks, totalPayloadBytes: mdatPayloadLen } = trackChunkLayouts(tracks);
  const moovBytes = moov(tracks, movieTimescale, zeroChunkTables(trackChunks));
  const estimate =
    1024 +
    tracks.length *
      (RESERVE_TRACK_OVERHEAD_BYTES + maximumPacketCount * RESERVE_PACKET_TABLE_BYTES);
  if (!Number.isSafeInteger(estimate) || estimate > 0xffffffff) {
    throw new MediaError(
      'mux-error',
      `MP4 faststart reserve estimate ${estimate} exceeds the 32-bit box limit`,
    );
  }
  // Always leave at least one legal 8-byte `free` box. Besides making under-fill explicit, this avoids
  // an invalid 1..7-byte tail when actual moov length happens to sit just below the estimate.
  const reservationBytes = Math.max(estimate, moovBytes.length + 8);
  if (reservationBytes > 0xffffffff) {
    throw new MediaError(
      'mux-error',
      `MP4 faststart reserve ${reservationBytes} exceeds the 32-bit box limit`,
    );
  }
  const reservationPosition = ftyp.length;
  const mdatPosition = reservationPosition + reservationBytes;
  patchGeneratedMoovChunkOffsets(moovBytes, chunkTablesFor(trackChunks, mdatPosition));

  const moovPatch = new Uint8Array(reservationBytes);
  moovPatch.set(moovBytes);
  const freeBytes = reservationBytes - moovBytes.length;
  const freeOffset = moovBytes.length;
  moovPatch.set(u32(freeBytes), freeOffset);
  moovPatch.set(fourcc('free'), freeOffset + 4);

  const mdatHeader = Uint8Array.from(cat(u32(8 + mdatPayloadLen), fourcc('mdat')));
  const totalLen = ftyp.length + reservationBytes + mdatHeader.byteLength + mdatPayloadLen;
  assertSingleBufferSize(totalLen);
  return {
    ftyp: Uint8Array.from(ftyp),
    moovPatch,
    mdatHeader,
    reservationPosition,
    reservationBytes,
    mdatPosition,
    mdatPayloadLen,
    totalLen,
    observedPacketCount,
  };
}

/**
 * Author a progressive MP4 into a positioned sparse target without materializing its virtual `mdat`.
 * Every sample is an independent chunk, so absolute offsets can straddle the 32-bit boundary while the
 * metadata stays bounded. The resulting `co64` table and 64-bit `mdat` extent are ordinary ISO-BMFF;
 * holes are supplied by the target rather than represented by an in-memory allocation.
 */
export function writeSparseMp4(
  tracks: readonly MuxTrackInput[],
  target: SparseMp4WriteTarget,
  opts: SparseMp4WriteOptions,
): Uint8Array {
  if (tracks.length === 0) throw new MediaError('mux-error', 'sparse MP4 mux received no tracks');
  if (opts.fileSize <= 0xffff_ffffn) {
    throw new MediaError('mux-error', 'sparse MP4 extent must cross the 32-bit address boundary');
  }
  if (opts.fileSize > UINT64_MAX) {
    throw new MediaError('mux-error', 'sparse MP4 extent exceeds the unsigned 64-bit box limit');
  }
  if (opts.sampleOffsets.length !== tracks.length) {
    throw new MediaError('mux-error', 'sparse MP4 sample-offset track count does not match input');
  }

  const chunkLayouts: TrackChunkLayout[] = [];
  const chunkTables: TrackChunkTable[] = [];
  const sampleRegions: Array<{ start: bigint; end: bigint; data: Uint8Array }> = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const offsets = opts.sampleOffsets[trackIndex];
    if (track === undefined || offsets === undefined || offsets.length !== track.samples.length) {
      throw new MediaError(
        'mux-error',
        `sparse MP4 track ${trackIndex + 1} needs one offset per sample`,
      );
    }
    const chunks = track.samples.map((sample, sampleIndex) => {
      const start = offsets[sampleIndex];
      if (start === undefined || start < 0n || start > UINT64_MAX) {
        throw new MediaError(
          'mux-error',
          'sparse MP4 sample offset must be an unsigned 64-bit bigint',
        );
      }
      const end = start + BigInt(sample.data.byteLength);
      sampleRegions.push({ start, end, data: sample.data });
      return {
        firstSample: sampleIndex,
        sampleCount: 1,
        payloadOffset: 0,
        byteLength: sample.data.byteLength,
      };
    });
    chunkLayouts.push({ chunks });
    chunkTables.push({ chunks, chunkOffsets: offsets });
  }

  const movieTimescale = opts.movieTimescale ?? 1000;
  const ftyp = ftypBox(opts.brand ?? 'mp4', tracks);
  const moovBytes = moov(tracks, movieTimescale, chunkTables);
  const mdatStart = BigInt(ftyp.length + moovBytes.length);
  const mdatSize = opts.fileSize - mdatStart;
  if (mdatSize <= 0xffff_ffffn) {
    throw new MediaError('mux-error', 'sparse MP4 mdat must require its 64-bit large-size header');
  }
  const mdatHeader = cat(u32(1), fourcc('mdat'), u64(mdatSize));
  const mdatBodyStart = mdatStart + BigInt(mdatHeader.length);

  sampleRegions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let previousEnd = mdatBodyStart;
  for (const region of sampleRegions) {
    if (region.start < mdatBodyStart || region.end > opts.fileSize || region.start < previousEnd) {
      throw new MediaError(
        'mux-error',
        'sparse MP4 sample regions overlap or escape the mdat payload',
      );
    }
    previousEnd = region.end;
  }

  const prefix = Uint8Array.from(cat(ftyp, moovBytes, mdatHeader));
  target.setSize(opts.fileSize);
  target.write(0n, prefix);
  for (const region of sampleRegions) target.write(region.start, region.data);
  return prefix;
}

/**
 * Serialize tracks + samples into an MP4 byte stream. The structural boxes (`ftyp`/`moov`) are built
 * as small `number[]`s, but the `mdat` payload is copied straight from each sample's `Uint8Array` into
 * one output buffer via `.set` — never a giant `number[]` (which exceeds the JS array length cap /
 * exhausts the heap on multi-hundred-MB remuxes; that was the `huge`/`massive` rung crash). Byte layout
 * is identical to a naive concat, so `parse(write(x)) == x` still holds.
 */
export function writeMp4(tracks: MuxTrackInput[], opts: WriteOptions = {}): Uint8Array {
  const layout = mp4LayoutParts(tracks, opts);
  const out = new Uint8Array(layout.totalLen);
  let p = 0;
  out.set(layout.ftyp, p);
  p += layout.ftyp.length;
  if (layout.mdatBeforeMoov) {
    out.set(layout.mdatHeader, p);
    p += layout.mdatHeader.length;
    p = writeSamples(out, p, tracks, layout.trackChunks);
    out.set(layout.moov, p);
  } else {
    out.set(layout.moov, p);
    p += layout.moov.length;
    out.set(layout.mdatHeader, p);
    p += layout.mdatHeader.length;
    writeSamples(out, p, tracks, layout.trackChunks);
  }
  return out;
}
