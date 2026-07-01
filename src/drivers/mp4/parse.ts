/**
 * Parse an ISO-BMFF `moov` into a {@link Movie}: per-track codec config, geometry, timing, and the
 * full sample tables (`stts`/`ctts`/`stsz`/`stsc`/`stco`/`stss`) that the demuxer turns into packets
 * with correct PTS/DTS and keyframe flags (docs/architecture/09 demux). Pure TS; no browser APIs.
 */

import type { MediaType } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { av1CodecString, avcCodecString, hevcCodecString, parseEsds } from './codec-strings.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

export interface TimeToSample {
  count: number;
  delta: number;
}
export interface CompositionOffset {
  count: number;
  offset: number;
}
export interface SampleToChunk {
  firstChunk: number;
  samplesPerChunk: number;
  descIndex: number;
}

export interface SampleTable {
  timeToSample: TimeToSample[];
  compositionOffsets: CompositionOffset[];
  /** Per-sample sizes (length === sampleCount). */
  sampleSizes: number[];
  sampleToChunk: SampleToChunk[];
  chunkOffsets: number[];
  /** 1-based sample numbers that are sync (keyframes); empty means "every sample is sync". */
  syncSamples: number[];
}

/** The raw codec-configuration box (`avcC`/`esds`) preserved verbatim for lossless stream-copy. */
export interface CodecPrivate {
  boxType: string;
  data: Uint8Array;
}

/** CENC protection metadata for a track (ADR-023) — raw boxes; the decrypt path parses their fields. */
export interface TrackProtection {
  schemeType: string; // 'cenc' (from schm)
  /** Raw `tenc` full-box payload (default_KID + per-sample IV size). */
  tenc: Uint8Array;
  /** Raw `senc` full-box payload (version+flags+count+IVs). */
  senc?: Uint8Array;
}

/** A supported MP4 edit-list mapping from movie time 0 to track media time. */
export interface TrackEdit {
  /** `elst.media_time`, in this track's `mdhd` timescale ticks. */
  mediaTimeTicks: number;
  /** `elst.segment_duration`, converted from the movie timescale. */
  durationSec: number;
}

export interface ParsedTrack {
  id: number;
  mediaType: MediaType;
  /** mdhd timescale (ticks per second). */
  timescale: number;
  durationSec: number;
  /** Present for a normal single-rate edit list; applied by the packet/WebCodecs seam. */
  edit?: TrackEdit;
  codec: string;
  sampleEntryType: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  /** Raw codec-config box for verbatim remux (separate from the WebCodecs decode `config`). */
  codecPrivate?: CodecPrivate;
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /**
   * For fragmented/CMAF tracks (empty `moov` sample table), the sample count accumulated from the
   * movie fragments ({@link applyFragmentTiming}). Lets probe report timing the `stts`/`stsz` path
   * cannot, without faking a sample table the demuxer would mis-read.
   */
  fragmentSampleCount?: number;
  /** Present when the track is CENC-protected (sample entry was `enca`/`encv`). */
  encryption?: TrackProtection;
  samples: SampleTable;
}

export interface Movie {
  brand: string;
  timescale: number;
  durationSec: number;
  tracks: ParsedTrack[];
}

export interface MovieMetadata extends Movie {
  needsFragmentTiming: boolean;
}

function fail(message: string): never {
  throw new MediaError('demux-error', message);
}

function child(r: Reader, parent: BoxHeader, type: string): BoxHeader | undefined {
  r.seek(parent.payloadStart);
  for (const b of boxes(r, parent.end)) {
    if (b.type === type) return b;
  }
  return undefined;
}

function children(r: Reader, parent: BoxHeader, type: string): BoxHeader[] {
  r.seek(parent.payloadStart);
  const out: BoxHeader[] = [];
  for (const b of boxes(r, parent.end)) {
    if (b.type === type) out.push(b);
  }
  return out;
}

/** Find a child box by type starting from the current cursor (for sample entries with fixed fields). */
function boxFrom(r: Reader, end: number, type: string): BoxHeader | undefined {
  for (const b of boxes(r, end)) {
    if (b.type === type) return b;
  }
  return undefined;
}

/** Parse a `moov` payload (with the file's `ftyp` major brand) into a {@link Movie}. */
export function parseMovie(brand: string, moov: Uint8Array): Movie {
  const parsed = parseMovieInternal(brand, moov, 'full');
  return {
    brand: parsed.brand,
    timescale: parsed.timescale,
    durationSec: parsed.durationSec,
    tracks: parsed.tracks,
  };
}

/** Parse only metadata needed for probe; per-sample byte tables stay unmaterialized. */
export function parseMovieMetadata(brand: string, moov: Uint8Array): MovieMetadata {
  return parseMovieInternal(brand, moov, 'metadata');
}

/** Parse packet-info tables needed for timeline-only demux; payload byte-offset tables stay lazy. */
export function parseMoviePacketInfo(brand: string, moov: Uint8Array): Movie {
  const parsed = parseMovieInternal(brand, moov, 'packet-info');
  return {
    brand: parsed.brand,
    timescale: parsed.timescale,
    durationSec: parsed.durationSec,
    tracks: parsed.tracks,
  };
}

type ParseMode = 'full' | 'metadata' | 'packet-info';

interface ParsedTrakResult {
  track: ParsedTrack;
  needsFragmentTiming: boolean;
}

function parseMovieInternal(brand: string, moov: Uint8Array, mode: ParseMode): MovieMetadata {
  const r = new Reader(moov);
  const root: BoxHeader = {
    type: 'moov',
    size: moov.byteLength,
    headerSize: 0,
    start: 0,
    payloadStart: 0,
    end: moov.byteLength,
  };

  const mvhd = child(r, root, 'mvhd') ?? fail('moov has no mvhd');
  const movie = parseMvhd(r, mvhd);

  const tracks: ParsedTrack[] = [];
  let needsFragmentTiming = false;
  for (const trak of children(r, root, 'trak')) {
    const parsed = parseTrak(r, trak, movie.timescale, mode);
    if (!parsed) continue;
    tracks.push(parsed.track);
    needsFragmentTiming ||= parsed.needsFragmentTiming;
  }
  if (tracks.length === 0) fail('moov has no decodable tracks');

  return {
    brand,
    timescale: movie.timescale,
    durationSec: movie.durationSec,
    tracks,
    needsFragmentTiming,
  };
}

function parseMvhd(r: Reader, box: BoxHeader): { timescale: number; durationSec: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8); // creation + modification time
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  return { timescale, durationSec: timescale > 0 ? duration / timescale : 0 };
}

function readI64(r: Reader): number {
  const hi = r.i32();
  const lo = r.u32();
  return hi * 2 ** 32 + lo;
}

/**
 * Per-track timing recovered from movie fragments, in track-timescale ticks.
 * - `durationTicks` is the **presentation end** (prefers `sidx`, which carries the start offset) — the
 *   value to report as the track's `durationSec`, matching ffprobe's stream duration.
 * - `mediaTicks` is the **sum of sample durations** (the content span) — the denominator for `fps`
 *   (`sampleCount / mediaSec` = ffprobe `avg_frame_rate`); it excludes any presentation start offset.
 */
export interface FragmentTiming {
  sampleCount: number;
  durationTicks: number;
  mediaTicks: number;
}

// trun flags (ISO/IEC 14496-12 §8.8.8): which optional per-sample fields are present, and the
// run-level data-offset / first-sample-flags. tfhd flags (§8.8.7): which track-level defaults are set.
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESC_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;

/** `mvex`→`trex` per-track defaults (default_sample_duration), the last-resort fragment timing source. */
function parseTrexDefaults(r: Reader, moov: BoxHeader): Map<number, number> {
  const out = new Map<number, number>();
  const mvex = child(r, moov, 'mvex');
  if (!mvex) return out;
  for (const trex of children(r, mvex, 'trex')) {
    r.seek(trex.payloadStart);
    readFullBoxHeader(r);
    const trackId = r.u32();
    r.skip(4); // default_sample_description_index
    out.set(trackId, r.u32()); // default_sample_duration
  }
  return out;
}

/** One `traf`: its track id, sample count, and summed duration (per-sample `trun` deltas, else defaults). */
function parseTraf(
  r: Reader,
  traf: BoxHeader,
  trexDefaults: Map<number, number>,
): { trackId: number; sampleCount: number; durationTicks: number; baseDecodeTime: number } {
  const tfhd = child(r, traf, 'tfhd');
  let trackId = 0;
  let tfhdDefaultDuration: number | undefined;
  if (tfhd) {
    r.seek(tfhd.payloadStart);
    const { flags } = readFullBoxHeader(r);
    trackId = r.u32();
    if (flags & TFHD_BASE_DATA_OFFSET) r.skip(8);
    if (flags & TFHD_SAMPLE_DESC_INDEX) r.skip(4);
    if (flags & TFHD_DEFAULT_SAMPLE_DURATION) tfhdDefaultDuration = r.u32();
  }
  const fallbackDuration = tfhdDefaultDuration ?? trexDefaults.get(trackId) ?? 0;

  const tfdt = child(r, traf, 'tfdt');
  let baseDecodeTime = 0;
  if (tfdt) {
    r.seek(tfdt.payloadStart);
    const { version } = readFullBoxHeader(r);
    baseDecodeTime = version === 1 ? r.u64() : r.u32();
  }

  let sampleCount = 0;
  let durationTicks = 0;
  for (const trun of children(r, traf, 'trun')) {
    r.seek(trun.payloadStart);
    const { flags } = readFullBoxHeader(r);
    const count = r.u32();
    if (flags & TRUN_DATA_OFFSET) r.skip(4);
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) r.skip(4);
    for (let i = 0; i < count; i++) {
      const sampleDuration = flags & TRUN_SAMPLE_DURATION ? r.u32() : fallbackDuration;
      if (flags & TRUN_SAMPLE_SIZE) r.skip(4);
      if (flags & TRUN_SAMPLE_FLAGS) r.skip(4);
      if (flags & TRUN_SAMPLE_CTO) r.skip(4);
      durationTicks += sampleDuration;
    }
    sampleCount += count;
  }
  return { trackId, sampleCount, durationTicks, baseDecodeTime };
}

/**
 * A `sidx` (Segment Index, §8.16.3) total for one `reference_ID` (track): the presentation end =
 * `earliest_presentation_time + Σ subsegment_duration`, in the sidx's own timescale. Returns the
 * per-track maximum across every sidx in the file. This is the most accurate fragmented duration when
 * present (it carries the presentation start offset that `moof`/`tfdt` decode times omit).
 */
function parseSidxEnds(
  r: Reader,
  file: Uint8Array,
): Map<number, { ticks: number; timescale: number }> {
  const out = new Map<number, { ticks: number; timescale: number }>();
  r.seek(0);
  for (const box of boxes(r, file.byteLength)) {
    if (box.type !== 'sidx') continue;
    const cursor = r.pos;
    r.seek(box.payloadStart);
    const { version } = readFullBoxHeader(r);
    const referenceId = r.u32();
    const timescale = r.u32();
    const earliest = version === 0 ? r.u32() : r.u64();
    r.skip(version === 0 ? 4 : 8); // first_offset
    r.skip(2); // reserved
    const refCount = r.u16();
    let subDuration = 0;
    for (let i = 0; i < refCount; i++) {
      r.skip(4); // reference_type(1) + referenced_size(31)
      subDuration += r.u32(); // subsegment_duration
      r.skip(4); // starts_with_SAP(1) + SAP_type(3) + SAP_delta_time(28)
    }
    const end = earliest + subDuration;
    const prev = out.get(referenceId);
    if (!prev || end > prev.ticks) out.set(referenceId, { ticks: end, timescale });
    r.seek(cursor);
  }
  return out;
}

/**
 * Recover per-track timing from movie fragments, for fragmented/CMAF MP4 whose `moov` carries an empty
 * sample table (so `stts`/`stsz` are absent and `mvhd`/`mdhd` duration is 0).
 *
 * Sample count is the sum of all `trun` counts. For duration we prefer a `sidx` total (presentation
 * end = earliest_presentation_time + Σ subsegment_duration) when present, since it carries the
 * presentation start offset; otherwise we use the fragment presentation end
 * `max(tfdt.baseMediaDecodeTime + Σ trun sample durations)`. Per-sample `trun` durations are honored
 * (VFR); else the `tfhd`/`trex` default applies. `durationTicks` is in the track timescale, so the
 * caller divides by `track.timescale`.
 */
export function parseFragments(file: Uint8Array): Map<number, FragmentTiming> {
  const r = new Reader(file);
  const moov = boxFrom(r, file.byteLength, 'moov');
  const trexDefaults = moov ? parseTrexDefaults(r, moov) : new Map<number, number>();
  const sidxEnds = parseSidxEnds(r, file);

  const counts = new Map<number, number>();
  const moofEnds = new Map<number, number>(); // max(tfdt + Σ run durations) — presentation end
  const mediaTotals = new Map<number, number>(); // Σ sample durations — content span (for fps)
  const trackTimescales = new Map<number, number>();
  for (const track of moov ? trackTimescalesOf(r, moov) : [])
    trackTimescales.set(track.id, track.timescale);

  r.seek(0);
  for (const top of boxes(r, file.byteLength)) {
    if (top.type !== 'moof') continue;
    const cursor = r.pos; // boxes() left the cursor at top.end; restore after scanning children
    for (const traf of children(r, top, 'traf')) {
      const { trackId, sampleCount, durationTicks, baseDecodeTime } = parseTraf(
        r,
        traf,
        trexDefaults,
      );
      counts.set(trackId, (counts.get(trackId) ?? 0) + sampleCount);
      mediaTotals.set(trackId, (mediaTotals.get(trackId) ?? 0) + durationTicks);
      moofEnds.set(trackId, Math.max(moofEnds.get(trackId) ?? 0, baseDecodeTime + durationTicks));
    }
    r.seek(cursor);
  }

  const out = new Map<number, FragmentTiming>();
  for (const [trackId, sampleCount] of counts) {
    const sidx = sidxEnds.get(trackId);
    const trackTs = trackTimescales.get(trackId);
    // sidx ticks are in the sidx timescale; rescale to the track timescale when they differ.
    const sidxTicks =
      sidx && trackTs && sidx.timescale > 0 ? (sidx.ticks * trackTs) / sidx.timescale : undefined;
    const mediaTicks = mediaTotals.get(trackId) ?? 0;
    const durationTicks = Math.max(sidxTicks ?? 0, moofEnds.get(trackId) ?? 0, mediaTicks);
    out.set(trackId, { sampleCount, durationTicks, mediaTicks });
  }
  return out;
}

/** Per-track (id, mdhd timescale) from a `moov`, so fragment timing can rescale `sidx` totals. */
function trackTimescalesOf(r: Reader, moov: BoxHeader): Array<{ id: number; timescale: number }> {
  const out: Array<{ id: number; timescale: number }> = [];
  for (const trak of children(r, moov, 'trak')) {
    const tkhd = child(r, trak, 'tkhd');
    const mdia = child(r, trak, 'mdia');
    const mdhd = mdia ? child(r, mdia, 'mdhd') : undefined;
    if (!tkhd || !mdhd) continue;
    const { trackId } = parseTkhd(r, tkhd);
    const { timescale } = parseMdhd(r, mdhd);
    out.push({ id: trackId, timescale });
  }
  return out;
}

/**
 * Patch a fragmented movie's tracks in place from {@link parseFragments}: for any track whose `moov`
 * sample table is empty, set `durationSec` (and the movie's, as the longest track) and—for video—`fps`
 * (avg = sampleCount/duration, matching ffprobe's `avg_frame_rate`). A track that already has samples is
 * left untouched, so non-fragmented inputs are unaffected.
 */
export function applyFragmentTiming(movie: Movie, file: Uint8Array): Movie {
  if (!movie.tracks.some((t) => t.samples.sampleSizes.length === 0)) return movie;
  const timing = parseFragments(file);
  let movieDurationSec = movie.durationSec;
  for (const track of movie.tracks) {
    if (track.samples.sampleSizes.length > 0) continue;
    const frag = timing.get(track.id);
    if (!frag || frag.durationTicks <= 0 || track.timescale <= 0) continue;
    const durationSec = frag.durationTicks / track.timescale;
    track.durationSec = durationSec;
    track.fragmentSampleCount = frag.sampleCount;
    // fps is frames over the *content* span (Σ sample durations), not the presentation end, so a
    // start offset in `durationSec` doesn't deflate it — this equals ffprobe's avg_frame_rate.
    const mediaSec = frag.mediaTicks / track.timescale;
    if (track.mediaType === 'video' && mediaSec > 0) track.fps = frag.sampleCount / mediaSec;
    movieDurationSec = Math.max(movieDurationSec, durationSec);
  }
  movie.durationSec = movieDurationSec;
  return movie;
}

function parseTrak(
  r: Reader,
  trak: BoxHeader,
  movieTimescale: number,
  mode: ParseMode,
): ParsedTrakResult | undefined {
  const tkhd = child(r, trak, 'tkhd') ?? fail('trak has no tkhd');
  const { trackId, rotation } = parseTkhd(r, tkhd);

  const mdia = child(r, trak, 'mdia') ?? fail('trak has no mdia');
  const mdhd = child(r, mdia, 'mdhd') ?? fail('mdia has no mdhd');
  const { timescale, durationSec } = parseMdhd(r, mdhd);

  const hdlr = child(r, mdia, 'hdlr') ?? fail('mdia has no hdlr');
  const handler = parseHandler(r, hdlr);
  const mediaType: MediaType | undefined =
    handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
  if (mediaType === undefined) return undefined; // skip subtitle/data tracks

  const minf = child(r, mdia, 'minf') ?? fail('mdia has no minf');
  const stbl = child(r, minf, 'stbl') ?? fail('minf has no stbl');
  const stsd = child(r, stbl, 'stsd') ?? fail('stbl has no stsd');

  const { samples, sampleCount } =
    mode === 'full'
      ? parseSampleTableWithCount(r, stbl)
      : mode === 'packet-info'
        ? parsePacketInfoSampleTable(r, stbl)
        : parseMetadataSampleTable(r, stbl);
  const fps = mediaType === 'video' && durationSec > 0 ? sampleCount / durationSec : undefined;
  const needsFragmentTiming = sampleCount === 0;

  const entry = parseStsd(r, stsd, mediaType);
  const encryption =
    entry.encryption && mode === 'full' ? readSenc(r, stbl, entry.encryption) : entry.encryption;
  const edit = parseTrackEdit(r, trak, movieTimescale);

  const base = {
    id: trackId,
    mediaType,
    timescale,
    durationSec,
    ...(edit !== undefined ? { edit } : {}),
    codec: entry.codec,
    sampleEntryType: entry.type,
    config: entry.config,
    samples,
    ...(entry.codecPrivate ? { codecPrivate: entry.codecPrivate } : {}),
    ...(encryption ? { encryption } : {}),
  };
  if (mediaType === 'video') {
    return {
      needsFragmentTiming,
      track: {
        ...base,
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
        ...(rotation !== undefined ? { rotation } : {}),
        ...(fps !== undefined ? { fps } : {}),
      },
    };
  }
  return {
    needsFragmentTiming,
    track: {
      ...base,
      ...(entry.sampleRate !== undefined ? { sampleRate: entry.sampleRate } : {}),
      ...(entry.channels !== undefined ? { channels: entry.channels } : {}),
    },
  };
}

function parseTrackEdit(r: Reader, trak: BoxHeader, movieTimescale: number): TrackEdit | undefined {
  const edts = child(r, trak, 'edts');
  if (edts === undefined) return undefined;
  const elst = child(r, edts, 'elst');
  if (elst === undefined) return undefined;

  r.seek(elst.payloadStart);
  const { version } = readFullBoxHeader(r);
  const entryCount = r.u32();
  let active: TrackEdit | undefined;

  for (let i = 0; i < entryCount; i++) {
    const segmentDuration = version === 1 ? r.u64() : r.u32();
    const mediaTime = version === 1 ? readI64(r) : r.i32();
    const mediaRateInteger = r.i16();
    const mediaRateFraction = r.i16();

    if (mediaTime < 0) continue; // leading empty edit: no media samples to timestamp
    if (mediaRateInteger !== 1 || mediaRateFraction !== 0) return undefined;
    if (active !== undefined) return undefined; // multiple active edits need sample filtering/concatenation
    active = {
      mediaTimeTicks: mediaTime,
      durationSec: movieTimescale > 0 ? segmentDuration / movieTimescale : 0,
    };
  }

  return active;
}

function parseTkhd(r: Reader, box: BoxHeader): { trackId: number; rotation?: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8); // creation + modification
  const trackId = r.u32();
  r.skip(4); // reserved
  r.skip(version === 1 ? 8 : 4); // duration
  r.skip(8 + 2 + 2 + 2 + 2); // reserved + layer + altgroup + volume + reserved
  const a = r.fixed16();
  const b = r.fixed16();
  r.skip(4); // u
  const c = r.fixed16();
  const d = r.fixed16();
  // remaining matrix (v, x, y, w) + width + height are unused for rotation
  const rotation = matrixRotation(a, b, c, d);
  return rotation === undefined ? { trackId } : { trackId, rotation };
}

function matrixRotation(a: number, b: number, _c: number, _d: number): number | undefined {
  if (a === 1 && b === 0) return 0;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  return norm === 0 ? undefined : norm;
}

function parseMdhd(r: Reader, box: BoxHeader): { timescale: number; durationSec: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  return { timescale, durationSec: timescale > 0 ? duration / timescale : 0 };
}

function parseHandler(r: Reader, box: BoxHeader): string {
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  r.skip(4); // pre_defined
  return r.fourcc();
}

interface SampleEntry {
  type: string;
  codec: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  codecPrivate?: CodecPrivate;
  encryption?: Omit<TrackProtection, 'senc'>;
}

function parseStsd(r: Reader, stsd: BoxHeader, mediaType: MediaType): SampleEntry {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  r.u32(); // entry_count
  const entry = { ...readBoxHeaderAt(r) };
  const protection =
    entry.type === 'enca' || entry.type === 'encv'
      ? parseProtection(r, entry, mediaType)
      : undefined;
  // Parse the inner sample entry as the original format (`frma`), so codec config + dims are read.
  const effective = protection ? { ...entry, type: protection.originalType } : entry;
  const parsed =
    mediaType === 'video' ? parseVisualEntry(r, effective) : parseAudioEntry(r, effective);
  if (!protection) return parsed;
  return {
    ...parsed,
    type: protection.originalType,
    encryption: { schemeType: protection.schemeType, tenc: protection.tenc },
  };
}

/** Parse the `sinf` protection boxes inside an `enca`/`encv` entry: `frma`, `schm`, `schi`→`tenc`. */
function parseProtection(
  r: Reader,
  entry: BoxHeader,
  mediaType: MediaType,
): { originalType: string; schemeType: string; tenc: Uint8Array } | undefined {
  r.seek(entry.payloadStart + (mediaType === 'audio' ? 28 : 78)); // skip fixed sample-entry fields
  const sinf = boxFrom(r, entry.end, 'sinf');
  if (!sinf) return undefined;
  r.seek(sinf.payloadStart);
  const frma = boxFrom(r, sinf.end, 'frma');
  r.seek(sinf.payloadStart);
  const schm = boxFrom(r, sinf.end, 'schm');
  r.seek(sinf.payloadStart);
  const schi = boxFrom(r, sinf.end, 'schi');
  if (!frma || !schi) return undefined;
  r.seek(frma.payloadStart);
  const originalType = r.fourcc();
  let schemeType = 'cenc';
  if (schm) {
    r.seek(schm.payloadStart);
    readFullBoxHeader(r);
    schemeType = r.fourcc();
  }
  r.seek(schi.payloadStart);
  const tenc = boxFrom(r, schi.end, 'tenc');
  if (!tenc) return undefined;
  return { originalType, schemeType, tenc: r.bytesAt(tenc.payloadStart, tenc.end).slice() };
}

function readBoxHeaderAt(r: Reader): BoxHeader {
  const start = r.pos;
  const size = r.u32();
  const type = r.fourcc();
  return { type, size, headerSize: 8, start, payloadStart: start + 8, end: start + size };
}

function vp9CodecString(vpcC: Uint8Array): string {
  if (vpcC.byteLength < 8) return 'vp9';
  const profile = vpcC[4] ?? 0;
  const level = vpcC[5] ?? 10;
  const bitDepth = (vpcC[6] ?? 0x80) >> 4;
  return `vp09.${profile.toString().padStart(2, '0')}.${level.toString().padStart(2, '0')}.${bitDepth
    .toString()
    .padStart(2, '0')}`;
}

function opusHeadFromDops(dops: Uint8Array, fallbackSampleRate: number): Uint8Array | undefined {
  if (dops.byteLength < 11) return undefined;
  const dv = new DataView(dops.buffer, dops.byteOffset, dops.byteLength);
  const channels = dv.getUint8(1);
  const preSkip = dv.getUint16(2, false);
  const sampleRate = dv.getUint32(4, false) || fallbackSampleRate;
  const outputGain = dv.getInt16(8, false);
  const mappingFamily = dv.getUint8(10);
  if (channels < 1 || channels > 2 || mappingFamily !== 0) return undefined;
  const out = new Uint8Array(19);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  const od = new DataView(out.buffer);
  od.setUint8(8, 1);
  od.setUint8(9, channels);
  od.setUint16(10, preSkip, true);
  od.setUint32(12, sampleRate, true);
  od.setInt16(16, outputGain, true);
  od.setUint8(18, mappingFamily);
  return out;
}

// Video sample-entry → (config box type, codec-string fn). avc1/avc3→avcC, hvc1/hev1→hvcC, av01→av1C.
const VIDEO_CONFIG: Record<
  string,
  { box: string; codec: (type: string, rec: Uint8Array) => string }
> = {
  avc1: { box: 'avcC', codec: (_t, rec) => avcCodecString(rec) },
  avc3: { box: 'avcC', codec: (_t, rec) => avcCodecString(rec) },
  hvc1: { box: 'hvcC', codec: (t, rec) => hevcCodecString(t, rec) },
  hev1: { box: 'hvcC', codec: (t, rec) => hevcCodecString(t, rec) },
  av01: { box: 'av1C', codec: (_t, rec) => av1CodecString(rec) },
  vp09: { box: 'vpcC', codec: (_t, rec) => vp9CodecString(rec) },
};

function parseVisualEntry(r: Reader, entry: BoxHeader): SampleEntry {
  r.seek(entry.payloadStart);
  r.skip(6 + 2); // reserved + data_reference_index
  r.skip(2 + 2 + 12); // pre_defined + reserved + pre_defined[3]
  const width = r.u16();
  const height = r.u16();
  r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2); // resolutions + reserved + frame_count + compressorname + depth + pre_defined
  const childStart = r.pos;

  const spec = VIDEO_CONFIG[entry.type];
  if (spec) {
    r.seek(childStart);
    const cfg = boxFrom(r, entry.end, spec.box);
    if (cfg) {
      const record = r.bytesAt(cfg.payloadStart, cfg.end).slice();
      const codec = spec.codec(entry.type, record);
      return {
        type: entry.type,
        codec,
        config: { codec, codedWidth: width, codedHeight: height, description: record },
        width,
        height,
        codecPrivate: { boxType: spec.box, data: record },
      };
    }
  }
  const codec = entry.type;
  return {
    type: entry.type,
    codec,
    config: { codec, codedWidth: width, codedHeight: height },
    width,
    height,
  };
}

/**
 * The version-dependent geometry of an `AudioSampleEntry` / QuickTime sound sample description: the
 * channel count, sample rate (Hz), and the absolute offset where the codec sub-boxes (e.g. `esds`)
 * begin. After the 8-byte preamble (6 reserved + 2 `data_reference_index`) the entry carries a
 * `version` (u16) + `revision` (u16) + `vendor` (u32); the layout then differs by version
 * (ISO/IEC 14496-12 §12.2.3.2 + Apple QTFF "Sound Sample Descriptions", v0/v1/v2).
 */
interface AudioGeometry {
  channels: number;
  sampleRate: number;
  /** Absolute offset (from the start of the file buffer) of the first codec sub-box. */
  childStart: number;
}

function parseAudioGeometry(r: Reader, entry: BoxHeader): AudioGeometry {
  const base = entry.payloadStart;
  r.seek(base + 6 + 2); // skip 6 reserved + data_reference_index
  const version = r.u16();
  r.skip(2 + 4); // revision + vendor

  // v0 slots: channelcount(u16), samplesize(u16), pre_defined(u16), reserved(u16), sampleRate(16.16).
  // v1 keeps these valid and appends 16 bytes; v2 overwrites them with constants and stores the real
  // values in a wider struct, so it is read separately below.
  const v0Channels = r.u16();
  r.skip(2 + 2 + 2); // samplesize + pre_defined + reserved
  const v0SampleRate = r.u32() >>> 16; // 16.16 fixed-point → integer Hz

  if (version === 2) {
    // QTFF v2 struct (after the 8-byte version/revision/vendor preamble at base+8): always3(u16),
    // always16(u16), alwaysMinus2(s16), always0(u16), always65536(u32), sizeOfStructOnly(u32),
    // audioSampleRate(f64), numAudioChannels(u32), then five trailing u32s — 56 bytes total, so the
    // codec sub-boxes start at base+64. The real rate/channels live in the f64 + numAudioChannels.
    const f64 = r.bytesAt(base + 32, base + 40);
    const sampleRate = Math.round(
      new DataView(f64.buffer, f64.byteOffset, f64.byteLength).getFloat64(0),
    );
    r.seek(base + 40);
    const channels = r.u32();
    return { channels, sampleRate, childStart: base + 64 };
  }

  // v1 appends samplesPerPacket/bytesPerPacket/bytesPerFrame/bytesPerSample (4×u32 = 16 bytes) before
  // the sub-boxes; v0 (and any unknown version, treated as v0) has the sub-boxes immediately after.
  const childStart = base + 28 + (version === 1 ? 16 : 0);
  return { channels: v0Channels, sampleRate: v0SampleRate, childStart };
}

/**
 * Locate the codec-configuration box for an audio sample entry. In ISO MP4 the box (`esds`) is a
 * direct child of the entry; in QuickTime it is commonly nested inside a `wave` box (the sound
 * extension) alongside `frma`/`<codec>`. Search both so v0/v1/v2 QuickTime entries resolve.
 */
function findAudioConfigBox(
  r: Reader,
  childStart: number,
  end: number,
  type: string,
): BoxHeader | undefined {
  r.seek(childStart);
  const direct = boxFrom(r, end, type);
  if (direct) return direct;
  r.seek(childStart);
  const wave = boxFrom(r, end, 'wave');
  if (!wave) return undefined;
  r.seek(wave.payloadStart);
  return boxFrom(r, wave.end, type);
}

function parseAudioEntry(r: Reader, entry: BoxHeader): SampleEntry {
  const { channels, sampleRate, childStart } = parseAudioGeometry(r, entry);

  const esds = findAudioConfigBox(r, childStart, entry.end, 'esds');
  if (esds && entry.type === 'mp4a') {
    const esdsPayload = r.bytesAt(esds.payloadStart, esds.end);
    const info = parseEsds(esdsPayload);
    const config: AudioDecoderConfig = {
      codec: info.codec,
      sampleRate,
      numberOfChannels: channels,
      ...(info.asc ? { description: info.asc } : {}),
    };
    return {
      type: entry.type,
      codec: info.codec,
      config,
      sampleRate,
      channels,
      codecPrivate: { boxType: 'esds', data: esdsPayload },
    };
  }
  const dops = findAudioConfigBox(r, childStart, entry.end, 'dOps');
  if (dops && entry.type === 'Opus') {
    const dopsPayload = r.bytesAt(dops.payloadStart, dops.end).slice();
    const opusHead = opusHeadFromDops(dopsPayload, sampleRate);
    const config: AudioDecoderConfig = {
      codec: 'opus',
      sampleRate,
      numberOfChannels: channels,
      ...(opusHead !== undefined ? { description: opusHead } : {}),
    };
    return {
      type: entry.type,
      codec: 'opus',
      config,
      sampleRate,
      channels,
      codecPrivate: { boxType: 'dOps', data: dopsPayload },
    };
  }
  if (entry.type === '.mp3') {
    return {
      type: entry.type,
      codec: 'mp3',
      config: { codec: 'mp3', sampleRate, numberOfChannels: channels },
      sampleRate,
      channels,
    };
  }
  const codec = entry.type;
  return {
    type: entry.type,
    codec,
    config: { codec, sampleRate, numberOfChannels: channels },
    sampleRate,
    channels,
  };
}

/** Attach the raw `senc` IV box (from `stbl`) to the track's protection metadata, if present. */
function readSenc(r: Reader, stbl: BoxHeader, enc: Omit<TrackProtection, 'senc'>): TrackProtection {
  const senc = child(r, stbl, 'senc');
  if (!senc) return enc;
  return { ...enc, senc: r.bytesAt(senc.payloadStart, senc.end).slice() };
}

function emptySampleTable(): SampleTable {
  return {
    timeToSample: [],
    compositionOffsets: [],
    sampleSizes: [],
    sampleToChunk: [],
    chunkOffsets: [],
    syncSamples: [],
  };
}

function parseSampleTableWithCount(
  r: Reader,
  stbl: BoxHeader,
): { samples: SampleTable; sampleCount: number } {
  const samples = {
    timeToSample: parseStts(r, child(r, stbl, 'stts')),
    compositionOffsets: parseCtts(r, child(r, stbl, 'ctts')),
    sampleSizes: parseStsz(r, child(r, stbl, 'stsz')),
    sampleToChunk: parseStsc(r, child(r, stbl, 'stsc')),
    chunkOffsets: parseChunkOffsets(r, child(r, stbl, 'stco'), child(r, stbl, 'co64')),
    syncSamples: parseStss(r, child(r, stbl, 'stss')),
  };
  return { samples, sampleCount: samples.sampleSizes.length };
}

function parsePacketInfoSampleTable(
  r: Reader,
  stbl: BoxHeader,
): { samples: SampleTable; sampleCount: number } {
  const samples = {
    timeToSample: parseStts(r, child(r, stbl, 'stts')),
    compositionOffsets: parseCtts(r, child(r, stbl, 'ctts')),
    sampleSizes: parseStsz(r, child(r, stbl, 'stsz')),
    sampleToChunk: [],
    chunkOffsets: [],
    syncSamples: parseStss(r, child(r, stbl, 'stss')),
  };
  return { samples, sampleCount: samples.sampleSizes.length };
}

function parseMetadataSampleTable(
  r: Reader,
  stbl: BoxHeader,
): { samples: SampleTable; sampleCount: number } {
  const timeToSample = parseStts(r, child(r, stbl, 'stts'));
  const sampleCount =
    parseStszSampleCount(r, child(r, stbl, 'stsz')) ?? sampleCountFromStts(timeToSample);
  return { samples: { ...emptySampleTable(), timeToSample }, sampleCount };
}

function sampleCountFromStts(entries: readonly TimeToSample[]): number {
  return entries.reduce((total, entry) => total + entry.count, 0);
}

function parseStszSampleCount(r: Reader, box: BoxHeader | undefined): number | undefined {
  if (!box) return undefined;
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  r.skip(4); // sample_size
  return r.u32();
}

function parseStts(r: Reader, box: BoxHeader | undefined): TimeToSample[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: TimeToSample[] = [];
  for (let i = 0; i < n; i++) out.push({ count: r.u32(), delta: r.u32() });
  return out;
}

function parseCtts(r: Reader, box: BoxHeader | undefined): CompositionOffset[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  const n = r.u32();
  const out: CompositionOffset[] = [];
  for (let i = 0; i < n; i++)
    out.push({ count: r.u32(), offset: version === 1 ? r.i32() : r.u32() });
  return out;
}

function parseStsz(r: Reader, box: BoxHeader | undefined): number[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const sampleSize = r.u32();
  const count = r.u32();
  if (sampleSize !== 0) return new Array<number>(count).fill(sampleSize);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(r.u32());
  return out;
}

function parseStsc(r: Reader, box: BoxHeader | undefined): SampleToChunk[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: SampleToChunk[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ firstChunk: r.u32(), samplesPerChunk: r.u32(), descIndex: r.u32() });
  }
  return out;
}

function parseChunkOffsets(
  r: Reader,
  stco: BoxHeader | undefined,
  co64: BoxHeader | undefined,
): number[] {
  const box = stco ?? co64;
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(co64 ? r.u64() : r.u32());
  return out;
}

function parseStss(r: Reader, box: BoxHeader | undefined): number[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.u32());
  return out;
}
