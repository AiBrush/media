/**
 * Parse an ISO-BMFF `moov` into a {@link Movie}: per-track codec config, geometry, timing, and the
 * full sample tables (`stts`/`ctts`/`stsz`/`stsc`/`stco`/`stss`) that the demuxer turns into packets
 * with correct PTS/DTS and keyframe flags (docs/architecture/09 demux). Pure TS; no browser APIs.
 */

import { h264AvcCSampleAspectRatios } from '../../codecs/h264-avcc-crop.ts';
import type { MediaType } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import {
  type ColrInfo,
  av1CodecString,
  avcCodecString,
  hevcCodecString,
  parseEsds,
  qtPcmCodec,
  videoColorSpaceFromColr,
} from './codec-strings.ts';
import {
  type Mp4DisplayMatrix,
  type Mp4DisplayTransform,
  clockwiseRotationFromMp4Matrix,
} from './display-transform.ts';
import { decodeMdhdLanguage, decodeQuickTimeMdhdLanguage } from './mdhd-language.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

export type { ColrInfo } from './codec-strings.ts';

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

/** ISO-BMFF `sdtp.sample_depends_on`: 0 unknown, 1 dependent, 2 independent, 3 reserved. */
export type SampleDependency = 0 | 1 | 2 | 3;

export interface SampleTable {
  timeToSample: TimeToSample[];
  compositionOffsets: CompositionOffset[];
  /** Per-sample sizes (length === sampleCount). */
  sampleSizes: number[];
  sampleToChunk: SampleToChunk[];
  chunkOffsets: number[];
  /** 1-based sample numbers that are sync (keyframes); empty means "every sample is sync". */
  syncSamples: number[];
  /** Per-sample `sdtp.sample_depends_on` values; missing/short entries mean unknown. */
  sampleDependencies: SampleDependency[];
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

/** A `pasp` pixel-aspect-ratio box (ISO/IEC 14496-12 §12.1.4): hSpacing:vSpacing == ffprobe SAR. */
export interface PaspInfo {
  hSpacing: number;
  vSpacing: number;
}

/**
 * A `clap` clean-aperture box (ISO/IEC 14496-12 §12.1.4 / QTFF): the displayable crop as exact
 * fractions. Width/height numerators are unsigned; the centre offsets are signed per QTFF semantics.
 */
export interface ClapInfo {
  cleanApertureWidthN: number;
  cleanApertureWidthD: number;
  cleanApertureHeightN: number;
  cleanApertureHeightD: number;
  horizOffN: number;
  horizOffD: number;
  vertOffN: number;
  vertOffD: number;
}

/**
 * A declared `trak` whose handler is not audio/video — surfaced honestly instead of dropped
 * (ADR-185): QuickTime files routinely carry `tmcd` timecode traks that ffprobe counts as streams.
 * Parsed leniently (a malformed non-media trak still enumerates with what could be read). Metadata
 * mode reads only count headers; full/packet-info modes retain sample tables so packet-bearing `tmcd`
 * and metadata tracks are enumerated without ever reading their payload bytes.
 */
export interface OtherTrack {
  id: number;
  /** Whether the `tkhd` Track_enabled flag is set. */
  defaultDisposition?: boolean;
  /** `hdlr` component subtype, e.g. 'tmcd' (timecode), 'text', 'sbtl', 'meta'; '' when unreadable. */
  handler: string;
  /** The stsd sample-entry fourcc (== ffprobe `codec_tag_string`), e.g. 'tmcd'; '' when unreadable. */
  codec: string;
  timescale: number;
  durationSec: number;
  /** Packed `mdhd` ISO-639-2/T language, when valid; explicit `und` is retained. */
  language?: string;
  sampleCount: number;
  /** Present in full/packet-info parses when a readable packet table exists. */
  samples?: SampleTable;
  /** Present for a normal single-rate edit list, just as on decodable tracks. */
  edit?: TrackEdit;
  /** 0-based position of this trak in `moov` — ffprobe's stream order for file-order listings. */
  trakIndex: number;
}

/** A supported MP4 edit-list mapping from movie time 0 to track media time. */
export interface TrackEdit {
  /** `elst.media_time`, in this track's `mdhd` timescale ticks. */
  mediaTimeTicks: number;
  /** `elst.segment_duration`, converted from the movie timescale. */
  durationSec: number;
  /** Exact source `elst.segment_duration` in the movie timescale, for lossless same-family rewrite. */
  durationMovieTicks: number;
  /** Timescale governing the exact movie-tick edit durations. */
  movieTimescale: number;
  /** Total duration of consecutive leading empty edits, converted from the movie timescale. */
  leadingEmptyDurationSec?: number;
  /** Exact sum of leading empty `elst.segment_duration` values in the movie timescale. */
  leadingEmptyDurationMovieTicks?: number;
}

export interface ParsedTrack {
  id: number;
  mediaType: MediaType;
  /** Whether the `tkhd` Track_enabled flag is set. */
  defaultDisposition: boolean;
  /** mdhd timescale (ticks per second). */
  timescale: number;
  durationSec: number;
  /** Packed `mdhd` ISO-639-2/T language, when valid; explicit `und` is retained. */
  language?: string;
  /** Exact source `mdhd.duration` in this track timescale, distinct from summed sample durations. */
  mediaDurationTicks?: number;
  /** Present for a normal single-rate edit list; applied by the packet/WebCodecs seam. */
  edit?: TrackEdit;
  codec: string;
  sampleEntryType: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  /** Raw codec-config box for verbatim remux (separate from the WebCodecs decode `config`). */
  codecPrivate?: CodecPrivate;
  width?: number;
  height?: number;
  /** Raw `tkhd` matrix + display dimensions, distinct from coded sample-entry geometry. */
  displayTransform?: Mp4DisplayTransform;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /** Raw `colr` nclc/nclx code points (video; ADR-185) — the container colour truth for remux. */
  colr?: ColrInfo;
  /** The `colr` mapped to WebCodecs values — also set on `config.colorSpace` for the decode seam. */
  colorSpace?: VideoColorSpaceInit;
  /** `pasp` pixel aspect ratio (video), when the sample entry carries one. */
  pasp?: PaspInfo;
  /** `clap` clean aperture (video), when the sample entry carries one. */
  clap?: ClapInfo;
  /** 0-based position of this trak in `moov` (file order, == ffprobe stream order). */
  trakIndex?: number;
  /** Samples indexed by the initial `moov/stbl` (metadata parses retain the count without the sizes). */
  moovSampleCount?: number;
  /** Sum of initial `moov/stts` durations; metadata mode retains this scalar without run objects. */
  moovMediaTicks?: number;
  /**
   * For fragmented/CMAF tracks (empty `moov` sample table), the sample count accumulated from the
   * movie fragments ({@link applyFragmentTiming}). Lets probe report timing the `stts`/`stsz` path
   * cannot, without faking a sample table the demuxer would mis-read.
   */
  fragmentSampleCount?: number;
  /** Sum of the later `moof/trun` sample durations, in this track's native timescale. */
  fragmentMediaTicks?: number;
  /** Present when the track is CENC-protected (sample entry was `enca`/`encv`). */
  encryption?: TrackProtection;
  samples: SampleTable;
}

export interface Movie {
  brand: string;
  timescale: number;
  durationSec: number;
  tracks: ParsedTrack[];
  /** `moov/mvex` declares that later `moof` runs may extend even a non-empty initial sample table. */
  hasFragments?: true;
  /** Declared non-media traks (tmcd/text/…), in addition to the decodable `tracks` (ADR-185). */
  otherTracks?: OtherTrack[];
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
    ...(parsed.hasFragments === true ? { hasFragments: true as const } : {}),
    ...(parsed.otherTracks !== undefined ? { otherTracks: parsed.otherTracks } : {}),
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
    ...(parsed.hasFragments === true ? { hasFragments: true as const } : {}),
    ...(parsed.otherTracks !== undefined ? { otherTracks: parsed.otherTracks } : {}),
  };
}

type ParseMode = 'full' | 'metadata' | 'packet-info';

type ParsedTrakResult =
  | { kind: 'av'; track: ParsedTrack; needsFragmentTiming: boolean }
  | { kind: 'other'; track: OtherTrack };

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
  const hasFragments = child(r, root, 'mvex') !== undefined;

  const tracks: ParsedTrack[] = [];
  const otherTracks: OtherTrack[] = [];
  let needsFragmentTiming = false;
  let trakIndex = 0;
  for (const trak of children(r, root, 'trak')) {
    const parsed = parseTrak(r, trak, movie.timescale, mode, trakIndex, brand === 'qt  ');
    trakIndex++;
    if (parsed.kind === 'other') {
      otherTracks.push(parsed.track);
      continue;
    }
    tracks.push(parsed.track);
    needsFragmentTiming ||= parsed.needsFragmentTiming;
  }
  if (tracks.length === 0) fail('moov has no decodable tracks');

  return {
    brand,
    timescale: movie.timescale,
    durationSec: movie.durationSec,
    tracks,
    ...(otherTracks.length > 0 ? { otherTracks } : {}),
    ...(hasFragments ? { hasFragments: true as const } : {}),
    needsFragmentTiming: needsFragmentTiming || hasFragments,
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
): {
  trackId: number;
  sampleCount: number;
  durationTicks: number;
  baseDecodeTime: number;
} {
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
  if (
    movie.hasFragments !== true &&
    !movie.tracks.some((t) => t.samples.sampleSizes.length === 0)
  ) {
    return movie;
  }
  const timing = parseFragments(file);
  let movieDurationSec = movie.durationSec;
  for (const track of movie.tracks) {
    const frag = timing.get(track.id);
    if (!frag || frag.durationTicks <= 0 || track.timescale <= 0) continue;
    const declaredMediaDurationTicks = track.mediaDurationTicks ?? 0;
    const durationSec = frag.durationTicks / track.timescale;
    track.durationSec = Math.max(track.durationSec, durationSec);
    track.mediaDurationTicks = Math.max(track.mediaDurationTicks ?? 0, frag.durationTicks);
    track.fragmentSampleCount = frag.sampleCount;
    track.fragmentMediaTicks = frag.mediaTicks;
    // Seekable FFmpeg hybrid-fragmented output can leave a provisional zero-duration `elst` in the
    // initial moov. The media-time is still the exact AAC priming offset; the final fragment end closes
    // that otherwise-empty window. A positive edit remains authoritative (it may be an intentional trim).
    if (
      track.edit !== undefined &&
      track.edit.durationSec <= 0 &&
      frag.durationTicks > track.edit.mediaTimeTicks
    ) {
      track.edit = {
        ...track.edit,
        durationSec: (frag.durationTicks - track.edit.mediaTimeTicks) / track.timescale,
      };
    }
    // fps is frames over the *content* span (Σ sample durations), not the presentation end, so a
    // start offset in `durationSec` doesn't deflate it — this equals ffprobe's avg_frame_rate.
    const moovMediaTicks =
      track.moovMediaTicks ??
      track.samples.timeToSample.reduce((total, entry) => total + entry.count * entry.delta, 0);
    const mediaSec =
      Math.max(declaredMediaDurationTicks, moovMediaTicks + frag.mediaTicks) / track.timescale;
    const sampleCount =
      (track.moovSampleCount ?? track.samples.sampleSizes.length) + frag.sampleCount;
    if (track.mediaType === 'video' && mediaSec > 0) track.fps = sampleCount / mediaSec;
    movieDurationSec = Math.max(movieDurationSec, durationSec);
  }
  movie.durationSec = movieDurationSec;
  return movie;
}

/** Run a lenient sub-parse: malformed boxes in a non-media trak yield undefined, never a throw. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The `hdlr` component subtype of a trak, read leniently (undefined when absent/truncated). */
function handlerOf(r: Reader, trak: BoxHeader): string | undefined {
  const mdia = child(r, trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = child(r, mdia, 'hdlr');
  if (!hdlr) return undefined;
  return attempt(() => parseHandler(r, hdlr));
}

/** The first stsd sample-entry fourcc (== ffprobe `codec_tag_string`), read leniently. */
function stsdFirstEntryType(r: Reader, stsd: BoxHeader): string | undefined {
  return attempt(() => {
    r.seek(stsd.payloadStart);
    readFullBoxHeader(r);
    if (r.u32() === 0) return undefined; // entry_count
    r.skip(4); // first entry's size
    return r.fourcc();
  });
}

/**
 * Surface a declared non-media trak (`tmcd`/`text`/…) with whatever structure is readable. Metadata
 * mode reads count headers only; full and packet-info modes retain the real sample table. Every field
 * degrades independently: a malformed data trak must never break AV probing or AV packet enumeration.
 */
function parseOtherTrak(
  r: Reader,
  trak: BoxHeader,
  handler: string,
  movieTimescale: number,
  mode: ParseMode,
  trakIndex: number,
  legacyQuickTimeLanguage: boolean,
): OtherTrack {
  const trackHeader = attempt(() => {
    const tkhd = child(r, trak, 'tkhd');
    return tkhd ? parseTkhd(r, tkhd) : undefined;
  });
  const timing = attempt(() => {
    const mdia = child(r, trak, 'mdia');
    const mdhd = mdia ? child(r, mdia, 'mdhd') : undefined;
    return mdhd ? parseMdhd(r, mdhd, legacyQuickTimeLanguage) : undefined;
  });
  const stbl = attempt(() => {
    const mdia = child(r, trak, 'mdia');
    const minf = mdia ? child(r, mdia, 'minf') : undefined;
    return minf ? child(r, minf, 'stbl') : undefined;
  });
  const codec = stbl
    ? attempt(() => {
        const stsd = child(r, stbl, 'stsd');
        return stsd ? stsdFirstEntryType(r, stsd) : undefined;
      })
    : undefined;
  const parsedSamples = stbl
    ? attempt(() =>
        mode === 'full'
          ? parseSampleTableWithCount(r, stbl)
          : mode === 'packet-info'
            ? parsePacketInfoSampleTable(r, stbl)
            : undefined,
      )
    : undefined;
  const sampleCountFallback = stbl
    ? attempt(
        () =>
          parseStszSampleCount(r, child(r, stbl, 'stsz')) ??
          parseSttsSummary(r, child(r, stbl, 'stts')).sampleCount,
      )
    : undefined;
  const edit = attempt(() => parseTrackEdit(r, trak, movieTimescale));
  return {
    id: trackHeader?.trackId ?? 0,
    ...(trackHeader !== undefined ? { defaultDisposition: trackHeader.defaultDisposition } : {}),
    handler,
    codec: codec ?? '',
    timescale: timing?.timescale ?? 0,
    durationSec: timing?.durationSec ?? 0,
    ...(timing?.language !== undefined ? { language: timing.language } : {}),
    sampleCount: parsedSamples?.sampleCount ?? sampleCountFallback ?? 0,
    ...(parsedSamples !== undefined && parsedSamples.sampleCount > 0
      ? { samples: parsedSamples.samples }
      : {}),
    ...(edit !== undefined ? { edit } : {}),
    trakIndex,
  };
}

function parseTrak(
  r: Reader,
  trak: BoxHeader,
  movieTimescale: number,
  mode: ParseMode,
  trakIndex: number,
  legacyQuickTimeLanguage: boolean,
): ParsedTrakResult {
  // The handler decides the path: `vide`/`soun` keep the strict decode-grade parse below; any other
  // (or unreadable) handler surfaces as a lenient OtherTrack — a declared trak is NEVER dropped.
  const handler = handlerOf(r, trak);
  const mediaType: MediaType | undefined =
    handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
  if (mediaType === undefined) {
    return {
      kind: 'other',
      track: parseOtherTrak(
        r,
        trak,
        handler ?? '',
        movieTimescale,
        mode,
        trakIndex,
        legacyQuickTimeLanguage,
      ),
    };
  }

  const tkhd = child(r, trak, 'tkhd') ?? fail('trak has no tkhd');
  const { trackId, defaultDisposition, rotation, displayTransform } = parseTkhd(r, tkhd);

  const mdia = child(r, trak, 'mdia') ?? fail('trak has no mdia');
  const mdhd = child(r, mdia, 'mdhd') ?? fail('mdia has no mdhd');
  const {
    timescale,
    durationSec,
    durationTicks: mediaDurationTicks,
    language,
  } = parseMdhd(r, mdhd, legacyQuickTimeLanguage);

  const minf = child(r, mdia, 'minf') ?? fail('mdia has no minf');
  const stbl = child(r, minf, 'stbl') ?? fail('minf has no stbl');
  const stsd = child(r, stbl, 'stsd') ?? fail('stbl has no stsd');

  const parsedSamples =
    mode === 'full'
      ? parseSampleTableWithCount(r, stbl)
      : mode === 'packet-info'
        ? parsePacketInfoSampleTable(r, stbl)
        : parseMetadataSampleTable(r, stbl);
  const { samples, sampleCount } = parsedSamples;
  const fps = mediaType === 'video' && durationSec > 0 ? sampleCount / durationSec : undefined;
  const needsFragmentTiming = sampleCount === 0;

  const entry = parseStsd(r, stsd, mediaType);
  const encryption =
    entry.encryption && mode === 'full' ? readSenc(r, stbl, entry.encryption) : entry.encryption;
  const edit = parseTrackEdit(r, trak, movieTimescale);

  const base = {
    id: trackId,
    mediaType,
    defaultDisposition,
    timescale,
    durationSec,
    ...(language !== undefined ? { language } : {}),
    mediaDurationTicks,
    moovSampleCount: sampleCount,
    trakIndex,
    ...(edit !== undefined ? { edit } : {}),
    codec: entry.codec,
    sampleEntryType: entry.type,
    config: entry.config,
    samples,
    ...(parsedSamples.mediaTicks !== undefined ? { moovMediaTicks: parsedSamples.mediaTicks } : {}),
    ...(entry.codecPrivate ? { codecPrivate: entry.codecPrivate } : {}),
    ...(encryption ? { encryption } : {}),
  };
  if (mediaType === 'video') {
    return {
      kind: 'av',
      needsFragmentTiming,
      track: {
        ...base,
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
        displayTransform,
        ...(entry.colr !== undefined ? { colr: entry.colr } : {}),
        ...(entry.colorSpace !== undefined ? { colorSpace: entry.colorSpace } : {}),
        ...(entry.pasp !== undefined ? { pasp: entry.pasp } : {}),
        ...(entry.clap !== undefined ? { clap: entry.clap } : {}),
        ...(rotation !== undefined ? { rotation } : {}),
        ...(fps !== undefined ? { fps } : {}),
      },
    };
  }
  return {
    kind: 'av',
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
  let leadingEmptyDurationSec = 0;
  let leadingEmptyDurationMovieTicks = 0;

  for (let i = 0; i < entryCount; i++) {
    const segmentDuration = version === 1 ? r.u64() : r.u32();
    const mediaTime = version === 1 ? readI64(r) : r.i32();
    const mediaRateInteger = r.i16();
    const mediaRateFraction = r.i16();

    if (mediaTime < 0) {
      if (active === undefined && movieTimescale > 0) {
        leadingEmptyDurationSec += segmentDuration / movieTimescale;
        leadingEmptyDurationMovieTicks += segmentDuration;
      }
      continue;
    }
    if (mediaRateInteger !== 1 || mediaRateFraction !== 0) return undefined;
    if (active !== undefined) return undefined; // multiple active edits need sample filtering/concatenation
    active = {
      mediaTimeTicks: mediaTime,
      durationSec: movieTimescale > 0 ? segmentDuration / movieTimescale : 0,
      durationMovieTicks: segmentDuration,
      movieTimescale,
      ...(leadingEmptyDurationSec > 0 ? { leadingEmptyDurationSec } : {}),
      ...(leadingEmptyDurationMovieTicks > 0 ? { leadingEmptyDurationMovieTicks } : {}),
    };
  }

  return active;
}

function parseTkhd(
  r: Reader,
  box: BoxHeader,
): {
  trackId: number;
  defaultDisposition: boolean;
  rotation?: number;
  displayTransform: Mp4DisplayTransform;
} {
  r.seek(box.payloadStart);
  const { version, flags } = readFullBoxHeader(r);
  const defaultDisposition = (flags & 0x000001) !== 0;
  r.skip(version === 1 ? 16 : 8); // creation + modification
  const trackId = r.u32();
  r.skip(4); // reserved
  r.skip(version === 1 ? 8 : 4); // duration
  r.skip(8 + 2 + 2 + 2 + 2); // reserved + layer + altgroup + volume + reserved
  const matrix: Mp4DisplayMatrix = [
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
    r.u32(),
  ];
  const displayTransform: Mp4DisplayTransform = {
    matrix,
    width16_16: r.u32(),
    height16_16: r.u32(),
  };
  const rotation = clockwiseRotationFromMp4Matrix(matrix);
  return rotation === undefined
    ? { trackId, defaultDisposition, displayTransform }
    : { trackId, defaultDisposition, rotation, displayTransform };
}

function parseMdhd(
  r: Reader,
  box: BoxHeader,
  legacyQuickTimeLanguage = false,
): { timescale: number; durationSec: number; durationTicks: number; language?: string } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  const language =
    r.pos + 2 <= box.end
      ? legacyQuickTimeLanguage
        ? decodeQuickTimeMdhdLanguage(r.u16())
        : decodeMdhdLanguage(r.u16())
      : undefined;
  return {
    timescale,
    durationSec: timescale > 0 ? duration / timescale : 0,
    durationTicks: duration,
    ...(language !== undefined ? { language } : {}),
  };
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
  /** Video colour tags parsed from the sample entry's `colr` extension (ADR-185). */
  colr?: ColrInfo;
  /** `colr` mapped to WebCodecs values (also mirrored onto `config.colorSpace` for the decode seam). */
  colorSpace?: VideoColorSpaceInit;
  /** `pasp` pixel aspect ratio, when the visual sample entry carries one. */
  pasp?: PaspInfo;
  /** `clap` clean aperture, when the visual sample entry carries one. */
  clap?: ClapInfo;
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
  return {
    originalType,
    schemeType,
    tenc: r.bytesAt(tenc.payloadStart, tenc.end).slice(),
  };
}

function readBoxHeaderAt(r: Reader): BoxHeader {
  const start = r.pos;
  const size = r.u32();
  const type = r.fourcc();
  return {
    type,
    size,
    headerSize: 8,
    start,
    payloadStart: start + 8,
    end: start + size,
  };
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

/**
 * The `colr` colour-parameter box of a visual sample entry (ISO/IEC 14496-12 §12.1.5 / QTFF): only the
 * on-screen colour types `nclc`/`nclx` carry H.273 code points. An ICC-profile colr (`rICC`/`prof`)
 * has none, so it is ignored (undefined) rather than faked. `nclx` appends a 1-byte `full_range_flag`
 * (top bit); QuickTime `nclc` has no range field, so `fullRange` stays undefined there.
 */
function parseColr(r: Reader, childStart: number, end: number): ColrInfo | undefined {
  r.seek(childStart);
  const colr = boxFrom(r, end, 'colr');
  if (!colr) return undefined;
  r.seek(colr.payloadStart);
  const colourType = r.fourcc();
  if (colourType !== 'nclc' && colourType !== 'nclx') return undefined;
  const primaries = r.u16();
  const transfer = r.u16();
  const matrix = r.u16();
  if (colourType === 'nclx') {
    return {
      colourType,
      primaries,
      transfer,
      matrix,
      fullRange: (r.u8() & 0x80) !== 0,
    };
  }
  return { colourType, primaries, transfer, matrix };
}

/** The `pasp` pixel-aspect-ratio box of a visual sample entry: hSpacing:vSpacing == ffprobe SAR. */
function parsePasp(r: Reader, childStart: number, end: number): PaspInfo | undefined {
  r.seek(childStart);
  const pasp = boxFrom(r, end, 'pasp');
  if (!pasp) return undefined;
  r.seek(pasp.payloadStart);
  return { hSpacing: r.u32(), vSpacing: r.u32() };
}

const MAX_WEBCODECS_DIMENSION = 0xffff_ffff;

function greatestCommonDivisor(a: number, b: number): number {
  let left = a;
  let right = b;
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

/**
 * Project ISO-BMFF sample aspect ratio into the display aspect WebCodecs applies to decoded frames.
 * Keep the exact reduced display ratio: DAR = coded width:height * pasp hSpacing:vSpacing. Malformed or
 * unrepresentable values stay available as raw `pasp` side data but must not make decoder.configure throw.
 * An explicit square-pixel container override must still be emitted when it supersedes non-square
 * in-band codec metadata; otherwise an omitted WebCodecs aspect lets the decoder reuse that metadata.
 */
function decoderDisplayAspect(
  width: number,
  height: number,
  pasp: PaspInfo | undefined,
  preserveSquarePixelOverride = false,
): Pick<VideoDecoderConfig, 'displayAspectWidth' | 'displayAspectHeight'> {
  if (
    pasp === undefined ||
    pasp.hSpacing === 0 ||
    pasp.vSpacing === 0 ||
    (pasp.hSpacing === pasp.vSpacing && !preserveSquarePixelOverride)
  ) {
    return {};
  }
  // Visual-sample-entry dimensions are u16 and pasp components are u32, so both products remain exact
  // JS safe integers. Reduce before enforcing WebCodecs' unsigned-long range.
  const horizontal = width * pasp.hSpacing;
  const vertical = height * pasp.vSpacing;
  const divisor = greatestCommonDivisor(horizontal, vertical);
  const displayAspectWidth = horizontal / divisor;
  const displayAspectHeight = vertical / divisor;
  if (
    displayAspectWidth <= 0 ||
    displayAspectHeight <= 0 ||
    displayAspectWidth > MAX_WEBCODECS_DIMENSION ||
    displayAspectHeight > MAX_WEBCODECS_DIMENSION
  ) {
    return {};
  }
  return { displayAspectWidth, displayAspectHeight };
}

/**
 * A container pasp is authoritative. Otherwise, use a global SPS ratio only when every declared SPS
 * agrees; conflicting parameter sets cannot be represented by one VideoDecoderConfig display aspect.
 */
function decoderSampleAspect(
  containerPasp: PaspInfo | undefined,
  sampleEntryType: string,
  codecRecord: Uint8Array,
): PaspInfo | undefined {
  if (containerPasp !== undefined) return containerPasp;
  if (sampleEntryType !== 'avc1' && sampleEntryType !== 'avc3') return undefined;
  try {
    const ratios = h264AvcCSampleAspectRatios(codecRecord);
    const first = ratios[0];
    if (
      first === undefined ||
      ratios.some(
        (candidate) =>
          candidate === undefined ||
          // extended_SAR pairs need not be reduced; compare their exact rational values.
          candidate.width * first.height !== first.width * candidate.height,
      )
    ) {
      return undefined;
    }
    return { hSpacing: first.width, vSpacing: first.height };
  } catch {
    // Preserve malformed/unsupported SPS bytes as description; do not turn optional display metadata
    // extraction into a structural MP4 parse failure.
    return undefined;
  }
}

/** The `clap` clean-aperture box: width/height numerators are unsigned; the centre offsets are signed. */
function parseClap(r: Reader, childStart: number, end: number): ClapInfo | undefined {
  r.seek(childStart);
  const clap = boxFrom(r, end, 'clap');
  if (!clap) return undefined;
  r.seek(clap.payloadStart);
  return {
    cleanApertureWidthN: r.u32(),
    cleanApertureWidthD: r.u32(),
    cleanApertureHeightN: r.u32(),
    cleanApertureHeightD: r.u32(),
    horizOffN: r.i32(),
    horizOffD: r.u32(),
    vertOffN: r.i32(),
    vertOffD: r.u32(),
  };
}

function parseVisualEntry(r: Reader, entry: BoxHeader): SampleEntry {
  r.seek(entry.payloadStart);
  r.skip(6 + 2); // reserved + data_reference_index
  r.skip(2 + 2 + 12); // pre_defined + reserved + pre_defined[3]
  const width = r.u16();
  const height = r.u16();
  r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2); // resolutions + reserved + frame_count + compressorname + depth + pre_defined
  const childStart = r.pos;

  // Display/colour extension atoms follow the codec-config box (any order) — parse them first so both
  // the recognized-codec and fourcc-fallback paths carry the same container colour truth.
  const colr = parseColr(r, childStart, entry.end);
  const colorSpace = colr !== undefined ? videoColorSpaceFromColr(colr) : undefined;
  const pasp = parsePasp(r, childStart, entry.end);
  const clap = parseClap(r, childStart, entry.end);
  const extras = {
    ...(colr !== undefined ? { colr } : {}),
    ...(colorSpace !== undefined ? { colorSpace } : {}),
    ...(pasp !== undefined ? { pasp } : {}),
    ...(clap !== undefined ? { clap } : {}),
  };
  // Container display metadata rides on the WebCodecs config: colour overrides missing bitstream facts,
  // while pasp sets the presentation ratio of the decoded VideoFrame rather than changing coded geometry.
  const colorInit = colorSpace !== undefined ? { colorSpace } : {};
  const containerDisplayAspectInit = decoderDisplayAspect(width, height, pasp, true);

  const spec = VIDEO_CONFIG[entry.type];
  if (spec) {
    r.seek(childStart);
    const cfg = boxFrom(r, entry.end, spec.box);
    if (cfg) {
      const record = r.bytesAt(cfg.payloadStart, cfg.end).slice();
      const codec = spec.codec(entry.type, record);
      const displayAspectInit = decoderDisplayAspect(
        width,
        height,
        decoderSampleAspect(pasp, entry.type, record),
        pasp !== undefined,
      );
      return {
        type: entry.type,
        codec,
        config: {
          codec,
          codedWidth: width,
          codedHeight: height,
          description: record,
          ...colorInit,
          ...displayAspectInit,
        },
        width,
        height,
        codecPrivate: { boxType: spec.box, data: record },
        ...extras,
      };
    }
  }
  const codec = entry.type;
  return {
    type: entry.type,
    codec,
    config: {
      codec,
      codedWidth: width,
      codedHeight: height,
      ...colorInit,
      ...containerDisplayAspectInit,
    },
    width,
    height,
    ...extras,
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
  /** Bits per sample: v0/v1 `samplesize`, v2 `constBitsPerChannel`. Drives PCM token width. */
  bitsPerSample: number;
  /** v2 `formatSpecificFlags` (CoreAudio) — the endianness/signedness/float bits for an `lpcm` entry. */
  lpcmFlags?: number;
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
  const v0SampleSize = r.u16(); // samplesize (bits per sample)
  r.skip(2 + 2); // pre_defined + reserved
  const v0SampleRate = r.u32() >>> 16; // 16.16 fixed-point → integer Hz

  if (version === 2) {
    // QTFF v2 struct (after the 8-byte version/revision/vendor preamble at base+8): always3(u16),
    // always16(u16), alwaysMinus2(s16), always0(u16), always65536(u32), sizeOfStructOnly(u32),
    // audioSampleRate(f64), numAudioChannels(u32), always7F000000(u32), constBitsPerChannel(u32),
    // formatSpecificFlags(u32), constBytesPerAudioPacket(u32), constLPCMFramesPerAudioPacket(u32) — 56
    // bytes total, so codec sub-boxes start at base+64. The real rate/channels live in the f64 +
    // numAudioChannels; PCM width/endianness come from constBitsPerChannel + formatSpecificFlags.
    const f64 = r.bytesAt(base + 32, base + 40);
    const sampleRate = Math.round(
      new DataView(f64.buffer, f64.byteOffset, f64.byteLength).getFloat64(0),
    );
    r.seek(base + 40);
    const channels = r.u32();
    r.seek(base + 48);
    const bitsPerSample = r.u32(); // constBitsPerChannel
    const lpcmFlags = r.u32(); // formatSpecificFlags
    return {
      channels,
      sampleRate,
      bitsPerSample,
      lpcmFlags,
      childStart: base + 64,
    };
  }

  // v1 appends samplesPerPacket/bytesPerPacket/bytesPerFrame/bytesPerSample (4×u32 = 16 bytes) before
  // the sub-boxes; v0 (and any unknown version, treated as v0) has the sub-boxes immediately after.
  const childStart = base + 28 + (version === 1 ? 16 : 0);
  return {
    channels: v0Channels,
    sampleRate: v0SampleRate,
    bitsPerSample: v0SampleSize,
    childStart,
  };
}

/**
 * The `enda` endianness atom (QTFF sound extension, usually nested in `wave`): value 1 ⇒ little-endian.
 * Undefined when absent, so {@link qtPcmCodec} applies each wide PCM format's big-endian default.
 */
function endaLittleEndian(r: Reader, childStart: number, end: number): boolean | undefined {
  const enda = findAudioConfigBox(r, childStart, end, 'enda');
  if (!enda) return undefined;
  r.seek(enda.payloadStart);
  return r.u16() === 1;
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

/** The wide PCM formats whose byte order a sibling `enda` atom may flip (fixed-endian formats ignore it). */
const ENDA_SENSITIVE_PCM = new Set(['in24', 'in32', 'fl32', 'fl64']);

function parseAudioEntry(r: Reader, entry: BoxHeader): SampleEntry {
  const { channels, sampleRate, bitsPerSample, lpcmFlags, childStart } = parseAudioGeometry(
    r,
    entry,
  );

  // Uncompressed QuickTime PCM sound descriptions (sowt/twos/raw /in*/fl*/lpcm) classify to the engine's
  // honest PCM tokens (ADR-185) — a real codec the DSP/decode seams understand, never a bare fourcc.
  const littleEndian = ENDA_SENSITIVE_PCM.has(entry.type)
    ? endaLittleEndian(r, childStart, entry.end)
    : undefined;
  const pcmCodec = qtPcmCodec(entry.type, bitsPerSample, littleEndian, lpcmFlags);
  if (pcmCodec !== undefined) {
    return {
      type: entry.type,
      codec: pcmCodec,
      config: { codec: pcmCodec, sampleRate, numberOfChannels: channels },
      sampleRate,
      channels,
    };
  }

  const esds = findAudioConfigBox(r, childStart, entry.end, 'esds');
  if (esds && entry.type === 'mp4a') {
    // Codec-private metadata escapes the parser through Movie/TrackInfo and can outlive the input window.
    // Own these few bytes so a tiny `esds` view never pins an entire in-memory MP4 backing store.
    const esdsPayload = r.bytesAt(esds.payloadStart, esds.end).slice();
    const info = parseEsds(esdsPayload);
    const aacSampleRate = info.sampleRate ?? sampleRate;
    const aacChannels = info.sbrPresent === true ? channels : (info.channels ?? channels);
    const config: AudioDecoderConfig = {
      codec: info.codec,
      sampleRate: aacSampleRate,
      numberOfChannels: aacChannels,
      ...(info.asc ? { description: info.asc } : {}),
    };
    return {
      type: entry.type,
      codec: info.codec,
      config,
      sampleRate: aacSampleRate,
      channels: aacChannels,
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
    sampleDependencies: [],
  };
}

interface ParsedSampleTable {
  readonly samples: SampleTable;
  readonly sampleCount: number;
  readonly mediaTicks?: number;
}

function parseSampleTableWithCount(r: Reader, stbl: BoxHeader): ParsedSampleTable {
  const samples = {
    timeToSample: parseStts(r, child(r, stbl, 'stts')),
    compositionOffsets: parseCtts(r, child(r, stbl, 'ctts')),
    sampleSizes: parseStsz(r, child(r, stbl, 'stsz')),
    sampleToChunk: parseStsc(r, child(r, stbl, 'stsc')),
    chunkOffsets: parseChunkOffsets(r, child(r, stbl, 'stco'), child(r, stbl, 'co64')),
    syncSamples: parseStss(r, child(r, stbl, 'stss')),
    sampleDependencies: parseSdtp(r, child(r, stbl, 'sdtp')),
  };
  return { samples, sampleCount: samples.sampleSizes.length };
}

function parsePacketInfoSampleTable(r: Reader, stbl: BoxHeader): ParsedSampleTable {
  const samples = {
    timeToSample: parseStts(r, child(r, stbl, 'stts')),
    compositionOffsets: parseCtts(r, child(r, stbl, 'ctts')),
    sampleSizes: parseStsz(r, child(r, stbl, 'stsz')),
    sampleToChunk: [],
    chunkOffsets: [],
    syncSamples: parseStss(r, child(r, stbl, 'stss')),
    sampleDependencies: parseSdtp(r, child(r, stbl, 'sdtp')),
  };
  return { samples, sampleCount: samples.sampleSizes.length };
}

function parseMetadataSampleTable(r: Reader, stbl: BoxHeader): ParsedSampleTable {
  const timing = parseSttsSummary(r, child(r, stbl, 'stts'));
  const sampleCount = parseStszSampleCount(r, child(r, stbl, 'stsz')) ?? timing.sampleCount;
  return { samples: emptySampleTable(), sampleCount, mediaTicks: timing.mediaTicks };
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

function parseSttsSummary(
  r: Reader,
  box: BoxHeader | undefined,
): { sampleCount: number; mediaTicks: number } {
  if (!box) return { sampleCount: 0, mediaTicks: 0 };
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  let sampleCount = 0;
  let mediaTicks = 0;
  for (let i = 0; i < n; i++) {
    const count = r.u32();
    const delta = r.u32();
    sampleCount += count;
    mediaTicks += count * delta;
  }
  return { sampleCount, mediaTicks };
}

function parseCtts(r: Reader, box: BoxHeader | undefined): CompositionOffset[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r); // version/flags — offsets are read signed for BOTH versions (see below)
  const n = r.u32();
  const out: CompositionOffset[] = [];
  // Read composition offsets as signed int32 regardless of the `ctts` version. Version 1 defines them
  // signed; version 0 defines them unsigned, but real-world muxers (ffmpeg's mov muxer, QuickTime) write
  // genuinely-negative composition offsets into a *version-0* `ctts` as two's-complement, and every real
  // demuxer — including ffmpeg's own mov demuxer, which reads `avio_rb32` straight into a signed int —
  // interprets them signed. A legitimate composition offset never approaches 2^31 ticks, so signed
  // reading is lossless for real positive offsets and corrects the negative ones. Real .mov B-frame
  // reorder regression: a version-0 `ctts` carrying −40 ticks was read as 4294967256, exploding the PTS
  // (0.0667 s → 7.16e6 s) and breaking decode/seek frame selection (ADR-185 addendum).
  for (let i = 0; i < n; i++) out.push({ count: r.u32(), offset: r.i32() });
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
    out.push({
      firstChunk: r.u32(),
      samplesPerChunk: r.u32(),
      descIndex: r.u32(),
    });
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

function parseSdtp(r: Reader, box: BoxHeader | undefined): SampleDependency[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const out: SampleDependency[] = [];
  while (r.pos < box.end) out.push(((r.u8() >> 4) & 3) as SampleDependency);
  return out;
}
