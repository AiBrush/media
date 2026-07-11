/**
 * The MP4/MOV container driver (ISO-BMFF) — hand-written TS (ADR-002: containers are ours). Demuxes
 * to WebCodecs-native `EncodedVideoChunk`/`EncodedAudioChunk` with correct PTS/DTS and keyframe flags,
 * reading only the `moov` header for probe and the sample bytes on demand (bounded memory). The
 * byte-level muxer (`write.ts`) + lossless stream-copy ({@link muxTracksFromMovie}) are round-trip
 * validated; the contract `Muxer` (EncodedChunk seam) adapter is {@link Mp4Muxer} (`mux.ts`).
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  DecryptParams,
  Demuxer,
  DriverModule,
  MuxOptions,
  Muxer,
  Packet,
  PacketInfoTable,
  PacketMetadata,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { aesCbcPkcs7, hexToBytes } from '../../crypto/aes.ts';
import { SOURCE_CACHE_KEY } from '../../sources/source.ts';
import {
  fragmentSamplesToDemuxSamples,
  mergeMoovAndFragmentSamples,
  parseFragmentSamples,
} from './fragment-samples.ts';
import { gaplessFromMp4Edit } from './gapless.ts';
import {
  type FragmentInitTrackInput,
  buildMediaSegment,
  fragmentMp4,
  fragmentMp4InitSegment,
} from './fragment.ts';
import { h264AccessUnitIsKeyPicture } from './h264-access-unit.ts';
import { Mp4Muxer } from './mux.ts';
import {
  type Movie,
  type MovieMetadata,
  type OtherTrack,
  type ParsedTrack,
  applyFragmentTiming,
  parseMovie,
  parseMovieMetadata,
  parseMoviePacketInfo,
} from './parse.ts';
import { Reader } from './reader.ts';
import {
  type Sample,
  type SampleData,
  buildSampleData,
  buildSamples,
  walkSampleRanges,
} from './samples.ts';
import {
  type ContainerBrand,
  type Mp4ByteStreamLayout,
  type MuxSampleChunkLayoutInput,
  type MuxSampleInput,
  type MuxTrackInput,
  type MuxTrackLayoutInput,
  planMp4ByteStreamLayout,
  writeMp4,
} from './write.ts';

const MP4_MIMES = new Set(['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a']);
const MP4_EXTENSIONS = new Set(['mp4', 'mov', 'm4a', 'm4v', 'qt']);
const TRIM_DECODE_VERIFY_HIGH_WATER = 8 as const;
const SAMPLE_READ_WINDOW_BYTES = 8 * 1024 * 1024;
const SAMPLE_READ_GAP_BYTES = 256 * 1024;
const AVC_IN_MEMORY_READ_BATCH_SAMPLES = 2048;
const LAZY_FRAGMENT_TARGET_SAMPLES = 900;
const LAZY_FRAGMENT_BUFFERED_SEGMENT_MULTIPLIER = 32;
const LAZY_FRAGMENT_BUFFERED_TARGET_SAMPLES =
  LAZY_FRAGMENT_TARGET_SAMPLES * LAZY_FRAGMENT_BUFFERED_SEGMENT_MULTIPLIER;
const PACKET_INFO_OFFSET_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const LAZY_FRAGMENT_HARD_VIDEO_SAMPLES = LAZY_FRAGMENT_TARGET_SAMPLES * 4;
const LAZY_FRAGMENT_BUFFERED_HARD_VIDEO_SAMPLES = LAZY_FRAGMENT_BUFFERED_TARGET_SAMPLES * 4;
const FASTSTART_METADATA_PREFETCH_BYTES = 32 * 1024;
const SMALL_FASTSTART_METADATA_PREFETCH_BYTES = 4 * 1024;
const FASTSTART_PREFIX_CACHE_READ_MAX_BYTES = 1024 * 1024;
const TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES = 16 * 1024;
const SIMPLE_VIDEO_FASTSTART_PROBE_MAX_SOURCE_BYTES = 256 * 1024;
const FULL_RANGE_EOF_SLACK_SEC = 0.05;
const SMALL_MOVIE_PARSE_HANDOFF_MAX_BYTES = 1024 * 1024;
const MOVIE_PARSE_HANDOFF_TTL_MS = 250;
const PROGRESSIVE_SINGLE_READ_MAX_BYTES = 64 * 1024 * 1024;
const PROGRESSIVE_SINGLE_READ_MAX_GAP_BYTES = 1024 * 1024;
const SMALL_URL_TRIM_RANDOM_ACCESS_MAX_BYTES = 8 * 1024 * 1024;
const TRIM_END_RANGE_SLACK_SEC = 1;
const TRIM_DECODE_VALIDATION_CACHE_TTL_MS = 60_000;
const TRIM_DECODE_VALIDATION_CACHE_MAX_ENTRIES = 128;
const FNV1A_32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;
const CENC_SCHEME = 'cenc' as const;
const CENS_SCHEME = 'cens' as const;
const CBCS_SCHEME = 'cbcs' as const;
/** Target container token → the `ftyp` brand writeMp4 emits ('mov'/'qt' ⇒ QuickTime; else ISO mp4). */
function brandFor(container: string | undefined): ContainerBrand {
  return container === 'mov' || container === 'qt' ? 'mov' : 'mp4';
}

/** A random-access view over a source: range reads when available, else a one-time buffer. */
interface RandomAccess {
  read(offset: number, length: number): Promise<Uint8Array>;
  size?: number | undefined;
  /** `read()` returns a zero-copy in-memory view, so sample-granular reads carry no I/O round trip. */
  readonly inMemory?: boolean;
  /** A complete prior read retained as a view, used to validate a probe→demux handoff without new I/O. */
  readonly cachedWhole?: () => Uint8Array | undefined;
}

type SizedRandomAccess = RandomAccess & { readonly size: number };

interface RandomAccessOptions {
  readonly eagerReadMaxBytes?: number;
}

/** Return a zero-copy view only when retained bytes cover the complete safe half-open interval. */
function coveredByteView(
  bytes: Uint8Array | undefined,
  offset: number,
  length: number,
): Uint8Array | undefined {
  const end = offset + length;
  if (
    bytes === undefined ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(end) ||
    offset < 0 ||
    length < 0 ||
    end > bytes.byteLength
  ) {
    return undefined;
  }
  return bytes.subarray(offset, end);
}

interface MovieParseHandoff {
  readonly movie?: Movie;
  readonly faststart?: {
    readonly brand: string;
    readonly moov: Uint8Array;
  };
  readonly mediaDataRanges: readonly MediaDataRange[];
  readonly token: object;
}

const movieParseHandoff = new Map<string, MovieParseHandoff>();
const trimDecodeValidationCache = new Map<string, number>();
let faststartProbeModulePromise: Promise<typeof import('./simple-video-probe.ts')> | undefined;
let faststartProbeModule: typeof import('./simple-video-probe.ts') | undefined;
type CencScheme = typeof CENC_SCHEME | typeof CENS_SCHEME | typeof CBCS_SCHEME;
type CencModule = typeof import('./cenc.ts');
type TencInfo = ReturnType<CencModule['parseTenc']>;
type SencSamples = ReturnType<CencModule['parseSenc']>;
let cencModulePromise: Promise<CencModule> | undefined;

async function loadFaststartProbeModule(): Promise<typeof import('./simple-video-probe.ts')> {
  if (faststartProbeModule !== undefined) return faststartProbeModule;
  faststartProbeModulePromise ??= import('./simple-video-probe.ts');
  faststartProbeModule = await faststartProbeModulePromise;
  return faststartProbeModule;
}

function loadCencModule(): Promise<CencModule> {
  cencModulePromise ??= import('./cenc.ts');
  return cencModulePromise;
}

function sourceKind(src: ByteSource): string | undefined {
  return (src as ByteSource & { readonly kind?: string }).kind;
}

function shouldEagerReadRandomAccess(
  src: ByteSource,
  maxBytes: number | undefined,
): src is ByteSource & {
  readonly range: NonNullable<ByteSource['range']>;
  readonly size: number;
} {
  if (maxBytes === undefined || src.range === undefined || src.size === undefined) return false;
  if (src.size > maxBytes) return false;
  const kind = sourceKind(src);
  return kind === 'url' || kind === 'element';
}

async function randomAccess(
  src: ByteSource,
  opts: RandomAccessOptions = {},
): Promise<RandomAccess> {
  const range = src.range;
  if (range) {
    if (shouldEagerReadRandomAccess(src, opts.eagerReadMaxBytes)) {
      const buffered = await range.call(src, 0, src.size);
      return {
        read: (offset, length) => Promise.resolve(buffered.subarray(offset, offset + length)),
        size: buffered.byteLength,
        inMemory: true,
        cachedWhole: () => buffered,
      };
    }
    let cachedWhole: Uint8Array | undefined;
    return {
      async read(offset, length): Promise<Uint8Array> {
        const retained = coveredByteView(cachedWhole, offset, length);
        if (retained !== undefined) return retained;
        const bytes = await range.call(src, offset, offset + length);
        const learnedSize = src.size;
        if (
          offset === 0 &&
          learnedSize !== undefined &&
          length >= learnedSize &&
          bytes.byteLength >= learnedSize
        ) {
          cachedWhole = bytes.subarray(0, learnedSize);
        }
        return bytes;
      },
      // URL/element sources learn their length from the first range response. Keep the random-access
      // view live so a later full-container validation sees that learned size instead of the undefined
      // snapshot that existed before the request completed.
      get size(): number | undefined {
        return src.size;
      },
      inMemory: sourceKind(src) === 'bytes',
      cachedWhole: () => cachedWhole,
    };
  }
  const buffered = await readAll(src.stream());
  return {
    read: (o, l) => Promise.resolve(buffered.subarray(o, o + l)),
    size: buffered.byteLength,
    inMemory: true,
    cachedWhole: () => buffered,
  };
}

function sourceCacheKey(src: ByteSource): string | undefined {
  return (src as ByteSource & { readonly [SOURCE_CACHE_KEY]?: string })[SOURCE_CACHE_KEY];
}

function sourceMimeHint(src: ByteSource): string | undefined {
  return (src as ByteSource & { readonly mimeHint?: string }).mimeHint;
}

function trimDecodeValidationCacheBase(src: ByteSource, ra: RandomAccess): string | undefined {
  const key = sourceCacheKey(src);
  if (key === undefined || ra.size === undefined) return undefined;
  return `${key.length}:${key}:${ra.size}`;
}

function mixHashByte(hash: number, byte: number): number {
  return Math.imul(hash ^ (byte & 0xff), FNV1A_32_PRIME) >>> 0;
}

function mixHashWord(hash: number, word: number): number {
  let out = hash;
  out = mixHashByte(out, word);
  out = mixHashByte(out, word >>> 8);
  out = mixHashByte(out, word >>> 16);
  return mixHashByte(out, word >>> 24);
}

function mixHashNumber(hash: number, value: number): number {
  const finite = Math.trunc(value);
  return mixHashWord(mixHashWord(hash, finite >>> 0), Math.floor(finite / 0x1_0000_0000) >>> 0);
}

function mixHashString(hash: number, value: string): number {
  let out = hash;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out = mixHashByte(out, code);
    out = mixHashByte(out, code >>> 8);
  }
  return out;
}

function mixHashBytes(hash: number, value: Uint8Array): number {
  let out = hash;
  for (const byte of value) out = mixHashByte(out, byte);
  return out;
}

function trimDecodeValidationSampleDigest(
  track: ParsedTrack,
  selected: readonly SampleData[],
): string {
  let hash = FNV1A_32_OFFSET_BASIS;
  hash = mixHashNumber(hash, track.id);
  hash = mixHashString(hash, track.sampleEntryType);
  hash = mixHashString(hash, track.codec);
  hash = mixHashNumber(hash, track.timescale);
  if (track.codecPrivate !== undefined) {
    hash = mixHashString(hash, track.codecPrivate.boxType);
    hash = mixHashBytes(hash, track.codecPrivate.data);
  }
  for (const sample of selected) {
    hash = mixHashNumber(hash, sample.index);
    hash = mixHashNumber(hash, sample.offset);
    hash = mixHashNumber(hash, sample.size);
    hash = mixHashNumber(hash, sample.dtsTicks);
    hash = mixHashNumber(hash, sample.durationTicks);
    hash = mixHashNumber(hash, sample.cttsTicks);
    hash = mixHashByte(hash, sample.keyframe ? 1 : 0);
  }
  return hash.toString(36);
}

function trimDecodeValidationCacheKey(
  base: string | undefined,
  track: ParsedTrack,
  selected: readonly SampleData[],
): string | undefined {
  if (base === undefined || selected.length === 0) return undefined;
  const first = selected[0] as SampleData;
  const last = selected[selected.length - 1] as SampleData;
  return [
    base,
    track.id,
    track.mediaType,
    track.sampleEntryType,
    track.codec,
    track.timescale,
    selected.length,
    first.index,
    first.offset,
    first.size,
    last.index,
    last.offset,
    last.size,
    trimDecodeValidationSampleDigest(track, selected),
  ].join('|');
}

function pruneTrimDecodeValidationCache(nowMs: number): void {
  for (const [key, expiresAtMs] of trimDecodeValidationCache) {
    if (expiresAtMs > nowMs) continue;
    trimDecodeValidationCache.delete(key);
  }
  while (trimDecodeValidationCache.size >= TRIM_DECODE_VALIDATION_CACHE_MAX_ENTRIES) {
    const oldest = trimDecodeValidationCache.keys().next().value as string;
    trimDecodeValidationCache.delete(oldest);
  }
}

function hasTrimDecodeValidationCacheHit(key: string | undefined): boolean {
  if (key === undefined) return false;
  const nowMs = Date.now();
  const expiresAtMs = trimDecodeValidationCache.get(key);
  if (expiresAtMs === undefined) return false;
  if (expiresAtMs <= nowMs) {
    trimDecodeValidationCache.delete(key);
    return false;
  }
  return true;
}

function rememberTrimDecodeValidation(key: string | undefined): void {
  if (key === undefined) return;
  const nowMs = Date.now();
  pruneTrimDecodeValidationCache(nowMs);
  trimDecodeValidationCache.set(key, nowMs + TRIM_DECODE_VALIDATION_CACHE_TTL_MS);
}

function shouldTryTinyAudioFaststartProbe(src: ByteSource, ra: RandomAccess): boolean {
  if (ra.size === undefined || ra.size > TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES) return false;
  const mime = sourceMimeHint(src)?.toLowerCase();
  if (mime !== undefined && (mime === 'audio/mp4' || mime === 'audio/x-m4a')) return true;
  const key = sourceCacheKey(src);
  return key !== undefined && /\.m4a(?:[?#]|$)/i.test(key);
}

function shouldTrySimpleVideoFaststartProbe(
  src: ByteSource,
  ra: RandomAccess,
): ra is SizedRandomAccess {
  if (
    ra.size === undefined ||
    ra.size > SIMPLE_VIDEO_FASTSTART_PROBE_MAX_SOURCE_BYTES ||
    ra.size <= 0
  ) {
    return false;
  }
  const mime = sourceMimeHint(src)?.toLowerCase();
  if (mime !== undefined) {
    return mime.startsWith('video/') || mime === 'application/mp4';
  }
  const key = sourceCacheKey(src);
  return key !== undefined && /\.(mp4|m4v|mov|qt)(?:[?#]|$)/i.test(key);
}

function canHandoffFullMovie(src: ByteSource, ra: RandomAccess): boolean {
  return (
    sourceCacheKey(src) !== undefined &&
    ra.size !== undefined &&
    ra.size <= SMALL_MOVIE_PARSE_HANDOFF_MAX_BYTES
  );
}

function storeMovieParseHandoff(
  key: string,
  movie: Movie,
  mediaDataRanges: readonly MediaDataRange[],
): void {
  storeMovieParseHandoffValue(key, { movie, mediaDataRanges });
}

function storeFaststartMoovParseHandoff(
  key: string,
  brand: string,
  moov: Uint8Array,
  mediaDataRanges: readonly MediaDataRange[],
): void {
  storeMovieParseHandoffValue(key, { faststart: { brand, moov }, mediaDataRanges });
}

function storeMovieParseHandoffValue(key: string, value: Omit<MovieParseHandoff, 'token'>): void {
  const token = {};
  movieParseHandoff.set(key, { ...value, token });
  setTimeout(() => {
    if (movieParseHandoff.get(key)?.token === token) {
      movieParseHandoff.delete(key);
    }
  }, MOVIE_PARSE_HANDOFF_TTL_MS);
}

async function readMovieForProbe(src: ByteSource, ra: RandomAccess): Promise<Movie> {
  const key = sourceCacheKey(src);
  if (key !== undefined && canHandoffFullMovie(src, ra)) {
    const movie = await readMovie(ra);
    storeMovieParseHandoff(key, movie, await readMediaDataRanges(ra));
    return movie;
  }
  return readMovieMetadata(ra);
}

interface MovieForDemux {
  readonly movie: Movie;
  /** Validated `mdat` ownership cached by an immediate probe of the same stable source, when present. */
  readonly mediaDataRanges?: readonly MediaDataRange[];
}

async function readMovieForDemux(src: ByteSource, ra: RandomAccess): Promise<MovieForDemux> {
  const key = sourceCacheKey(src);
  if (key !== undefined) {
    const cached = movieParseHandoff.get(key);
    if (cached !== undefined) {
      movieParseHandoff.delete(key);
      if (cached.movie !== undefined) {
        return { movie: cached.movie, mediaDataRanges: cached.mediaDataRanges };
      }
      if (cached.faststart !== undefined) {
        return {
          movie: parseMovie(cached.faststart.brand, cached.faststart.moov),
          mediaDataRanges: cached.mediaDataRanges,
        };
      }
    }
  }
  return { movie: await readMovie(ra) };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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

interface TopBoxHeader {
  size: number;
  type: string;
  headerSize: number;
}

function topBoxHeader(bytes: Uint8Array, offset: number): TopBoxHeader | undefined {
  if (offset + 8 > bytes.byteLength) return undefined;
  const r = new Reader(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 16)));
  let size = r.u32();
  const type = r.fourcc();
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.byteLength) return undefined;
    size = r.u64();
    headerSize = 16;
  } else if (size === 0) {
    return undefined;
  }
  if (size < headerSize || size <= 0) return undefined;
  return { size, type, headerSize };
}

async function readFaststartMetadata(ra: RandomAccess): Promise<MovieMetadata | undefined> {
  const prefetchBytes = Math.min(
    FASTSTART_METADATA_PREFETCH_BYTES,
    ra.size ?? FASTSTART_METADATA_PREFETCH_BYTES,
  );
  const head = await ra.read(0, prefetchBytes);
  let offset = 0;
  let brand = 'mp42';

  for (;;) {
    const header = topBoxHeader(head, offset);
    if (header === undefined) return undefined;
    if (header.type === 'ftyp' && offset + 12 <= head.byteLength) {
      brand = new Reader(head.subarray(offset + 8, offset + 12)).fourcc();
    }
    if (header.type === 'moov') {
      if (offset + header.size <= head.byteLength) {
        return parseMovieMetadata(
          brand,
          head.subarray(offset + header.headerSize, offset + header.size),
        );
      }
      const moovEnd = offset + header.size;
      if (moovEnd <= FASTSTART_PREFIX_CACHE_READ_MAX_BYTES) {
        const prefix = await ra.read(0, moovEnd);
        if (prefix.byteLength >= moovEnd) {
          return parseMovieMetadata(brand, prefix.subarray(offset + header.headerSize, moovEnd));
        }
      }
      const box = await ra.read(offset, header.size);
      if (box.byteLength < header.headerSize) return undefined;
      return parseMovieMetadata(brand, box.subarray(header.headerSize));
    }
    offset += header.size;
    if (offset + 8 > head.byteLength) return undefined;
  }
}

type SmallFaststartMetadataProbeTracks = readonly TrackInfo[] | false | undefined;

function isSmallFaststartMetadataTrack(track: ParsedTrack): boolean {
  if (track.mediaType === 'video') {
    return (
      (track.sampleEntryType === 'avc1' || track.sampleEntryType === 'avc3') &&
      track.width !== undefined &&
      track.height !== undefined &&
      track.fps !== undefined &&
      track.fps > 0
    );
  }
  return (
    track.mediaType === 'audio' &&
    track.sampleEntryType === 'mp4a' &&
    track.sampleRate !== undefined &&
    track.channels !== undefined
  );
}

async function readSmallFaststartMetadataProbeTracks(
  src: ByteSource,
  ra: SizedRandomAccess,
): Promise<SmallFaststartMetadataProbeTracks> {
  const head = await ra.read(0, Math.min(ra.size, SMALL_FASTSTART_METADATA_PREFETCH_BYTES));
  let offset = 0;
  let brand = 'mp42';
  for (;;) {
    const header = topBoxHeader(head, offset);
    if (header === undefined) return undefined;
    if (header.type === 'ftyp' && offset + 12 <= head.byteLength) {
      brand = new Reader(head.subarray(offset + 8, offset + 12)).fourcc();
    }
    if (header.type === 'moov') {
      const moovEnd = offset + header.size;
      const moov =
        moovEnd <= head.byteLength
          ? head.subarray(offset + header.headerSize, moovEnd)
          : (await ra.read(offset, header.size)).subarray(header.headerSize);
      if (moov.byteLength < header.size - header.headerSize) return undefined;
      try {
        const movie = parseMovieMetadata(brand, moov);
        if (
          movie.needsFragmentTiming ||
          !movie.tracks.some((track) => track.mediaType === 'video') ||
          !movie.tracks.every(isSmallFaststartMetadataTrack)
        ) {
          return false;
        }
        const key = sourceCacheKey(src);
        if (key !== undefined && canHandoffFullMovie(src, ra)) {
          storeFaststartMoovParseHandoff(key, brand, moov.slice(), await readMediaDataRanges(ra));
        }
        return toProbeTracks(movie);
      } catch {
        return false;
      }
    }
    offset += header.size;
    if (offset + 8 > head.byteLength) return undefined;
  }
}

async function readSimpleVideoFaststartProbeTracks(
  src: ByteSource,
  ra: RandomAccess,
): Promise<readonly TrackInfo[] | undefined> {
  const { readSimpleVideoFaststartProbe } = await loadFaststartProbeModule();
  const result = await readSimpleVideoFaststartProbe(ra);
  if (result === undefined) return undefined;
  const key = sourceCacheKey(src);
  if (key !== undefined && canHandoffFullMovie(src, ra)) {
    storeFaststartMoovParseHandoff(
      key,
      result.brand,
      result.moov.slice(),
      await readMediaDataRanges(ra),
    );
  }
  return result.tracks;
}

async function readTinyAudioFaststartProbeTracks(
  ra: RandomAccess,
): Promise<readonly TrackInfo[] | undefined> {
  const { readTinyAudioFaststartProbe } = await loadFaststartProbeModule();
  return readTinyAudioFaststartProbe(ra);
}

/** A fragmented track whose initialization `stbl` declares no progressive samples at all. */
function hasEmptyInitializationSampleTable(track: ParsedTrack): boolean {
  const table = track.samples;
  return (
    track.moovSampleCount === 0 &&
    table.timeToSample.length === 0 &&
    table.compositionOffsets.length === 0 &&
    table.sampleSizes.length === 0 &&
    table.sampleToChunk.length === 0 &&
    table.chunkOffsets.length === 0 &&
    table.syncSamples.length === 0
  );
}

/**
 * Whether a fragmented audio initialization movie already contains authoritative presentation timing.
 *
 * ISO-BMFF permits a fragmented movie to retain positive final `mvhd`/`mdhd` durations even though its
 * initial sample tables are empty. For that exact completed-audio shape, scanning every later `moof` only
 * re-derives metadata already present in the initialization segment. Any video/non-media track, zero or
 * contradictory duration, initial sample, or edit list keeps the existing fragment scan: video fps,
 * hybrid timelines, and AAC gapless facts depend on fragment sample ticks.
 */
function hasAuthoritativeFragmentedAudioInitDuration(movie: MovieMetadata): boolean {
  if (
    movie.hasFragments !== true ||
    movie.needsFragmentTiming !== true ||
    movie.timescale <= 0 ||
    !Number.isFinite(movie.durationSec) ||
    movie.durationSec <= 0 ||
    movie.tracks.length === 0 ||
    (movie.otherTracks?.length ?? 0) > 0
  ) {
    return false;
  }

  let maximumTrackDurationSec = 0;
  let durationToleranceSec = 1 / movie.timescale;
  for (const track of movie.tracks) {
    if (
      track.mediaType !== 'audio' ||
      !hasEmptyInitializationSampleTable(track) ||
      track.edit !== undefined ||
      track.timescale <= 0 ||
      !Number.isFinite(track.durationSec) ||
      track.durationSec <= 0
    ) {
      return false;
    }
    maximumTrackDurationSec = Math.max(maximumTrackDurationSec, track.durationSec);
    durationToleranceSec = Math.max(durationToleranceSec, 1 / track.timescale);
  }

  return Math.abs(movie.durationSec - maximumTrackDurationSec) <= durationToleranceSec;
}

/** Walk the top-level boxes to find the `ftyp` brand and the `moov`, then parse it. */
export async function readMovie(ra: RandomAccess): Promise<Movie> {
  let offset = 0;
  let brand = 'mp42';
  const limit = ra.size ?? Number.MAX_SAFE_INTEGER;

  while (offset + 8 <= limit) {
    const header = await ra.read(offset, 16);
    if (header.byteLength < 8) break;
    const r = new Reader(header);
    let size = r.u32();
    const type = r.fourcc();
    let headerSize = 8;
    if (size === 1) {
      size = r.u64();
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || size <= 0) break;

    if (type === 'ftyp' && header.byteLength >= 12) {
      brand = r.fourcc();
    }
    if (type === 'moov') {
      const box = await ra.read(offset, size);
      const movie = parseMovie(brand, box.subarray(headerSize));
      // Empty-table CMAF and hybrid-fragmented MP4 both carry later timing in top-level `moof`/`sidx`.
      if (
        movie.hasFragments === true ||
        movie.tracks.some((t) => t.samples.sampleSizes.length === 0)
      ) {
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** Read only metadata needed for probe; full packet tables remain a demux-only cost. */
export async function readMovieMetadata(ra: RandomAccess): Promise<Movie> {
  const faststart = await readFaststartMetadata(ra);
  if (faststart !== undefined) {
    if (faststart.needsFragmentTiming) {
      if (hasAuthoritativeFragmentedAudioInitDuration(faststart)) return faststart;
      return applyFragmentTiming(
        faststart,
        await readWholeFile(ra, ra.size ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return faststart;
  }

  let offset = 0;
  let brand = 'mp42';
  const limit = ra.size ?? Number.MAX_SAFE_INTEGER;

  while (offset + 8 <= limit) {
    const header = await ra.read(offset, 16);
    if (header.byteLength < 8) break;
    const r = new Reader(header);
    let size = r.u32();
    const type = r.fourcc();
    let headerSize = 8;
    if (size === 1) {
      size = r.u64();
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || size <= 0) break;

    if (type === 'ftyp' && header.byteLength >= 12) {
      brand = r.fourcc();
    }
    if (type === 'moov') {
      const box = await ra.read(offset, size);
      const movie = parseMovieMetadata(brand, box.subarray(headerSize));
      if (movie.needsFragmentTiming) {
        if (hasAuthoritativeFragmentedAudioInitDuration(movie)) return movie;
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** Read track metadata plus timeline packet tables; payload byte offsets remain unmaterialized. */
export async function readMoviePacketInfo(ra: RandomAccess): Promise<Movie> {
  let offset = 0;
  let brand = 'mp42';
  const limit = ra.size ?? Number.MAX_SAFE_INTEGER;

  while (offset + 8 <= limit) {
    const header = await ra.read(offset, 16);
    if (header.byteLength < 8) break;
    const r = new Reader(header);
    let size = r.u32();
    const type = r.fourcc();
    let headerSize = 8;
    if (size === 1) {
      size = r.u64();
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || size <= 0) break;

    if (type === 'ftyp' && header.byteLength >= 12) {
      brand = r.fourcc();
    }
    if (type === 'moov') {
      const movie = parseMoviePacketInfo(brand, (await ra.read(offset, size)).subarray(headerSize));
      return movie.hasFragments === true
        ? applyFragmentTiming(movie, await readWholeFile(ra, limit))
        : movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** The full source bytes (fragments can follow `moov`); the size is known once we have reached `moov`. */
async function readWholeFile(ra: RandomAccess, limit: number): Promise<Uint8Array> {
  const size = ra.size ?? limit;
  if (!Number.isFinite(size))
    throw new MediaError('demux-error', 'fragmented MP4 needs a known size');
  const retained = coveredByteView(ra.cachedWhole?.(), 0, size);
  if (retained !== undefined) return retained;
  return ra.read(0, size);
}

function muxTrackMeta(track: ParsedTrack): Omit<MuxTrackInput, 'samples'> {
  return {
    mediaType: track.mediaType,
    sampleEntryType: track.sampleEntryType,
    timescale: track.timescale,
    ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}),
    ...(track.width !== undefined ? { width: track.width } : {}),
    ...(track.height !== undefined ? { height: track.height } : {}),
    ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
    ...(track.displayTransform !== undefined ? { displayTransform: track.displayTransform } : {}),
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.channels !== undefined ? { channels: track.channels } : {}),
    ...(track.edit !== undefined
      ? {
          edit: {
            mediaTimeTicks: track.edit.mediaTimeTicks,
            durationTicks: Math.round(track.edit.durationSec * track.timescale),
            ...(track.edit.leadingEmptyDurationSec !== undefined
              ? {
                  leadingEmptyDurationTicks: Math.round(
                    track.edit.leadingEmptyDurationSec * track.timescale,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

async function readSamples(
  ra: RandomAccess,
  samples: readonly SampleData[],
): Promise<MuxSampleInput[]> {
  validateSampleRanges(samples, ra.size);

  const sampleBytes = new Array<Uint8Array | undefined>(samples.length);
  for (const window of planSampleReadWindows(samples)) {
    const span = await ra.read(window.start, window.end - window.start);
    if (span.byteLength !== window.end - window.start) {
      throw new MediaError(
        'demux-error',
        `sample window [${window.start}, ${window.end}) short read: got ${span.byteLength} of ${
          window.end - window.start
        } bytes (truncated MP4)`,
      );
    }
    for (const item of window.items) {
      const rel = item.sample.offset - window.start;
      sampleBytes[item.ordinal] = span.subarray(rel, rel + item.sample.size);
    }
  }

  const out: MuxSampleInput[] = [];
  let ordinal = 0;
  for (const s of samples) {
    const data = sampleBytes[ordinal];
    if (data === undefined) {
      throw new MediaError(
        'demux-error',
        `sample ${s.index} was not read from the source (internal read plan error)`,
      );
    }
    out.push({
      data,
      durationTicks: s.durationTicks,
      cttsTicks: s.cttsTicks,
      keyframe: s.keyframe,
    });
    ordinal++;
  }
  return out;
}

interface SampleRange {
  readonly index: number;
  readonly offset: number;
  readonly size: number;
}

interface MediaDataRange {
  /** First media byte, immediately after the top-level `mdat` header. */
  readonly start: number;
  /** Exclusive end of the declared top-level `mdat` box. */
  readonly end: number;
}

/**
 * Walk the complete ISO-BMFF top level and return every `mdat` payload range. Unknown boxes are legal;
 * malformed/truncated headers are not. Demux needs this stronger pass because `readMovie()` can return as
 * soon as it finds `moov`, while sample offsets may point into a later box whose header was destroyed.
 */
async function readMediaDataRanges(ra: RandomAccess): Promise<MediaDataRange[]> {
  const sourceSize = ra.size;
  if (sourceSize === undefined) {
    throw new MediaError('demux-error', 'MP4 demux needs a known source size');
  }
  const cachedWhole = ra.cachedWhole?.();
  const fullBytes =
    cachedWhole ?? (ra.inMemory === true ? await ra.read(0, sourceSize) : undefined);
  if (fullBytes !== undefined && fullBytes.byteLength !== sourceSize) {
    throw new MediaError(
      'demux-error',
      `short in-memory MP4 read: got ${fullBytes.byteLength} of ${sourceSize} bytes`,
    );
  }
  const ranges: MediaDataRange[] = [];
  let offset = 0;
  while (offset < sourceSize) {
    const headerLength = Math.min(16, sourceSize - offset);
    const header =
      fullBytes?.subarray(offset, offset + headerLength) ?? (await ra.read(offset, headerLength));
    if (header.byteLength < 8) {
      throw new MediaError('demux-error', `truncated top-level MP4 box header at offset ${offset}`);
    }
    const reader = new Reader(header);
    let size = reader.u32();
    const type = reader.fourcc();
    // ISO-BMFF boxes have a four-character-code type. 0x00000000 is a legacy QuickTime terminator only
    // inside a sound-description `wave` atom; at file top level it is a destroyed header, not an unknown
    // extension box. Keep every nonzero unknown type forward-compatible and skip it by its declared size.
    if (header[4] === 0 && header[5] === 0 && header[6] === 0 && header[7] === 0) {
      throw new MediaError('demux-error', `zero top-level MP4 box type at offset ${offset}`);
    }
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) {
        throw new MediaError(
          'demux-error',
          `truncated 64-bit top-level MP4 box header at offset ${offset}`,
        );
      }
      size = reader.u64();
      headerSize = 16;
    } else if (size === 0) {
      size = sourceSize - offset;
    }
    const end = offset + size;
    if (size < headerSize || !Number.isSafeInteger(end) || end <= offset || end > sourceSize) {
      throw new MediaError(
        'demux-error',
        `invalid top-level MP4 box '${type}' range [${offset}, ${end}) for source size ${sourceSize}`,
      );
    }
    if (type === 'mdat') ranges.push({ start: offset + headerSize, end });
    offset = end;
  }
  return ranges;
}

function mediaDataRangeContains(
  ranges: readonly MediaDataRange[],
  offset: number,
  size: number,
): boolean {
  const sampleEnd = offset + size;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(sampleEnd) ||
    offset < 0 ||
    size < 0
  ) {
    return false;
  }
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle];
    if (range === undefined) return false;
    if (offset < range.start) {
      high = middle - 1;
    } else if (offset > range.end || (offset === range.end && size !== 0)) {
      low = middle + 1;
    } else {
      return sampleEnd <= range.end;
    }
  }
  return false;
}

/** Require every exposed sample to be physically owned by an `mdat`; valid empty tracks remain valid. */
function validateDemuxSampleStorage(
  movie: Movie,
  fragmentSamples: ReadonlyMap<number, readonly Sample[]> | undefined,
  mediaDataRanges: readonly MediaDataRange[],
): void {
  const validate = (index: number, offset: number, size: number): void => {
    if (mediaDataRangeContains(mediaDataRanges, offset, size)) return;
    throw new MediaError(
      'demux-error',
      `sample ${index} range [${offset}, ${offset + size}) is not inside a declared MP4 mdat`,
    );
  };
  for (const track of movie.tracks) {
    const samples = fragmentSamples?.get(track.id);
    if (samples === undefined) {
      const placedSamples = walkSampleRanges(track, validate);
      const declaredSamples = track.samples.sampleSizes.length;
      if (placedSamples !== declaredSamples) {
        throw new MediaError(
          'demux-error',
          `track ${track.id} sample table declares ${declaredSamples} samples but its chunk layout places ${placedSamples}`,
        );
      }
      continue;
    }
    for (const sample of samples) validate(sample.index, sample.offset, sample.size);
  }
}

function validateSampleRanges(
  samples: readonly SampleRange[],
  sourceSize: number | undefined,
): void {
  for (const s of samples) {
    // A sample whose byte range escapes the source (truncated/corrupt mdat, or a bit-flipped
    // stsz/stco/co64 entry) would otherwise be read as a silently clamped short buffer and copied as
    // garbage. Reject it as corrupt input rather than emit a wrong file (graceful-failure, doc 11 §6.3).
    validateSampleRange(s.index, s.offset, s.size, sourceSize);
  }
}

function validateSampleRange(
  index: number,
  offset: number,
  size: number,
  sourceSize: number | undefined,
): void {
  const end = offset + size;
  if (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(size) &&
    Number.isSafeInteger(end) &&
    offset >= 0 &&
    size >= 0 &&
    (sourceSize === undefined || end <= sourceSize)
  ) {
    return;
  }
  const sizeNote = sourceSize !== undefined ? ` size ${sourceSize}` : '';
  throw new MediaError(
    'demux-error',
    `sample ${index} byte range [${offset}, ${offset + size}) is outside the source${sizeNote} (truncated or corrupt MP4)`,
  );
}

interface SampleReadItem<T extends SampleRange = SampleData> {
  readonly ordinal: number;
  readonly sample: T;
}

interface SampleReadWindow<T extends SampleRange = SampleData> {
  start: number;
  end: number;
  readonly items: SampleReadItem<T>[];
}

function planSampleReadWindows<T extends SampleRange>(
  samples: readonly T[],
): SampleReadWindow<T>[] {
  const items = samples
    .map((sample, ordinal): SampleReadItem<T> => ({ sample, ordinal }))
    .sort((a, b) => a.sample.offset - b.sample.offset || a.ordinal - b.ordinal);
  const windows: SampleReadWindow<T>[] = [];
  let current: SampleReadWindow<T> | undefined;
  for (const item of items) {
    const start = item.sample.offset;
    const end = item.sample.offset + item.sample.size;
    if (current === undefined) {
      current = { start, end, items: [item] };
      windows.push(current);
      continue;
    }
    const gap = start - current.end;
    const combinedSpan = end - current.start;
    if (gap <= SAMPLE_READ_GAP_BYTES && combinedSpan <= SAMPLE_READ_WINDOW_BYTES) {
      current.end = Math.max(current.end, end);
      current.items.push(item);
      continue;
    }
    current = { start, end, items: [item] };
    windows.push(current);
  }
  return windows;
}

interface PacketReadWindow {
  start: number;
  end: number;
}

interface MonotonicPacketReadWindow extends PacketReadWindow {
  lastOrdinal: number;
}

type PacketReadPlan =
  | { readonly kind: 'monotonic'; readonly windows: readonly MonotonicPacketReadWindow[] }
  | { readonly kind: 'ordinal'; readonly byOrdinal: readonly (PacketReadWindow | undefined)[] };

/**
 * Map decode-order packet ordinals to bounded read windows without per-sample planner objects on the
 * ordinary monotonic MP4 layout. A legal decreasing-offset layout retains the stable general planner.
 */
function planPacketReadWindows(samples: readonly Sample[]): PacketReadPlan {
  let previousOffset = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.offset < previousOffset) {
      const byOrdinal = new Array<PacketReadWindow | undefined>(samples.length);
      for (const window of planSampleReadWindows(samples)) {
        for (const item of window.items) byOrdinal[item.ordinal] = window;
      }
      return { kind: 'ordinal', byOrdinal };
    }
    previousOffset = sample.offset;
  }

  const windows: MonotonicPacketReadWindow[] = [];
  let current: MonotonicPacketReadWindow | undefined;
  for (let ordinal = 0; ordinal < samples.length; ordinal++) {
    const sample = samples[ordinal];
    if (sample === undefined) break;
    const start = sample.offset;
    const end = start + sample.size;
    if (current === undefined) {
      current = { start, end, lastOrdinal: ordinal };
      windows.push(current);
    } else {
      const gap = start - current.end;
      const combinedSpan = end - current.start;
      if (gap <= SAMPLE_READ_GAP_BYTES && combinedSpan <= SAMPLE_READ_WINDOW_BYTES) {
        current.end = Math.max(current.end, end);
        current.lastOrdinal = ordinal;
      } else {
        current = { start, end, lastOrdinal: ordinal };
        windows.push(current);
      }
    }
  }
  return { kind: 'monotonic', windows };
}

function avcNalLengthSize(track: ParsedTrack): 1 | 2 | 4 | undefined {
  if (track.mediaType !== 'video') return undefined;
  if (track.sampleEntryType !== 'avc1' && track.sampleEntryType !== 'avc3') return undefined;
  if (track.codecPrivate?.boxType !== 'avcC' || track.codecPrivate.data.byteLength < 5) {
    return undefined;
  }
  const lengthSize = ((track.codecPrivate.data[4] as number) & 3) + 1;
  return lengthSize === 1 || lengthSize === 2 || lengthSize === 4 ? lengthSize : undefined;
}

/** Whether packet truth needs payload inspection beyond the container's `stss` sync table. */
function trackNeedsAvcPictureClassification(track: ParsedTrack): boolean {
  return (
    avcNalLengthSize(track) !== undefined &&
    track.samples.sampleSizes.length > 0 &&
    track.samples.syncSamples.length > 0 &&
    track.samples.syncSamples.length < track.samples.sampleSizes.length
  );
}

function movieNeedsAvcPictureClassification(movie: Movie): boolean {
  return movie.tracks.some(trackNeedsAvcPictureClassification);
}

function mergeSampleNumbers(
  declaredSyncSamples: readonly number[],
  inferredIntraSamples: readonly number[],
): number[] {
  if (inferredIntraSamples.length === 0) return [...declaredSyncSamples];
  const merged = new Set<number>(declaredSyncSamples);
  for (const sampleNumber of inferredIntraSamples) merged.add(sampleNumber);
  return [...merged].sort((left, right) => left - right);
}

function classifyAvcSample(
  sample: SampleData,
  bytes: Uint8Array,
  lengthSize: 1 | 2 | 4,
  inferredIntraSamples: number[],
): void {
  if (h264AccessUnitIsKeyPicture(bytes, lengthSize) === true) {
    inferredIntraSamples.push(sample.index + 1);
  }
}

/**
 * Add non-IDR I/SI pictures to packet-reporting key flags by parsing real AVC sample payloads.
 * Declared `stss` samples are never removed. Payload memory is bounded: cheap in-memory sources are
 * visited in fixed-size batches of zero-copy views; I/O sources reuse the 8 MiB sample-window plan.
 */
async function enrichAvcPictureClassification(
  movie: Movie,
  ra: RandomAccess,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const track of movie.tracks) {
    const lengthSize = avcNalLengthSize(track);
    if (lengthSize === undefined || !trackNeedsAvcPictureClassification(track)) continue;

    const samples = buildSampleData(track).filter((sample) => !sample.keyframe);
    if (samples.length === 0) continue;
    validateSampleRanges(samples, ra.size);
    const inferredIntraSamples: number[] = [];

    if (ra.inMemory === true) {
      for (let start = 0; start < samples.length; start += AVC_IN_MEMORY_READ_BATCH_SAMPLES) {
        throwIfAborted(signal);
        const batch = samples.slice(start, start + AVC_IN_MEMORY_READ_BATCH_SAMPLES);
        const bytes = await Promise.all(batch.map((sample) => ra.read(sample.offset, sample.size)));
        for (let index = 0; index < batch.length; index++) {
          const sample = batch[index];
          const accessUnit = bytes[index];
          if (sample === undefined || accessUnit === undefined) continue;
          if (accessUnit.byteLength !== sample.size) {
            throw new MediaError(
              'demux-error',
              `sample ${sample.index} short read: got ${accessUnit.byteLength} of ${sample.size} bytes (truncated MP4)`,
            );
          }
          classifyAvcSample(sample, accessUnit, lengthSize, inferredIntraSamples);
        }
      }
    } else {
      for (const window of planSampleReadWindows(samples)) {
        throwIfAborted(signal);
        const span = await ra.read(window.start, window.end - window.start);
        if (span.byteLength !== window.end - window.start) {
          throw new MediaError(
            'demux-error',
            `sample window [${window.start}, ${window.end}) short read: got ${span.byteLength} of ${
              window.end - window.start
            } bytes (truncated MP4)`,
          );
        }
        for (const item of window.items) {
          const relativeOffset = item.sample.offset - window.start;
          classifyAvcSample(
            item.sample,
            span.subarray(relativeOffset, relativeOffset + item.sample.size),
            lengthSize,
            inferredIntraSamples,
          );
        }
      }
    }

    track.samples.syncSamples = mergeSampleNumbers(track.samples.syncSamples, inferredIntraSamples);
  }
}

/** Turn a parsed movie + its bytes into mux-ready tracks (lossless stream-copy), for `remux`. */
/**
 * For a fragmented movie, recover each track's native-tick {@link SampleData} list from the
 * `moof`/`traf`/`trun` runs (ADR-186) so every stream-copy/mux/remux path sees real samples instead of an
 * empty `moov` table. Returns `undefined` for a progressive movie (the common path drives
 * `buildSampleData` directly). Samples whose bytes escape the file (a truncated final fragment) are dropped
 * so downstream sample reads never fault.
 */
async function buildFragmentSampleDataMap(
  movie: Movie,
  ra: RandomAccess,
): Promise<Map<number, SampleData[]> | undefined> {
  if (!movieIsFragmented(movie)) return undefined;
  const file = await readWholeFile(ra, ra.size ?? Number.MAX_SAFE_INTEGER);
  const fragmentsByTrack = parseFragmentSamples(file);
  const out = new Map<number, SampleData[]>();
  for (const track of movie.tracks) {
    const fragments = fragmentsByTrack.get(track.id);
    if (fragments === undefined || fragments.length === 0) continue;
    const merged = mergeMoovAndFragmentSamples(buildSampleData(track), fragments);
    out.set(
      track.id,
      merged.filter((s) => s.offset >= 0 && s.offset + s.size <= file.byteLength),
    );
  }
  return out;
}

export async function muxTracksFromMovie(ra: RandomAccess, movie: Movie): Promise<MuxTrackInput[]> {
  const fragmentSamples = await buildFragmentSampleDataMap(movie, ra);
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    const data = fragmentSamples?.get(track.id) ?? buildSampleData(track);
    out.push({ ...muxTrackMeta(track), samples: await readSamples(ra, data) });
  }
  return out;
}

/**
 * Convert a fragmented video's signed composition-offset representation into the equivalent progressive
 * `ctts` + edit-list form. Adding `shift` to every CTO and subtracting the same shift through `elst`
 * preserves every presentation timestamp exactly while retaining negative-PTS samples as decoder preroll.
 * Tracks already carrying an edit, non-video tracks, and non-negative CTO tracks are returned unchanged.
 */
export function normalizeDecryptedFragmentTracks(
  tracks: readonly MuxTrackInput[],
): MuxTrackInput[] {
  return tracks.map((track) => {
    if (track.mediaType !== 'video' || track.edit !== undefined || track.samples.length === 0) {
      return track;
    }
    const minCttsTicks = track.samples.reduce(
      (minimum, sample) => Math.min(minimum, sample.cttsTicks),
      0,
    );
    if (minCttsTicks >= 0) return track;

    const shift = -minCttsTicks;
    const durationTicks = track.samples.reduce(
      (duration, sample) => duration + sample.durationTicks,
      0,
    );
    return {
      ...track,
      samples: track.samples.map((sample) => ({
        ...sample,
        cttsTicks: sample.cttsTicks + shift,
      })),
      edit: { mediaTimeTicks: shift, durationTicks },
    };
  });
}

function hasCompleteSampleTables(movie: Movie): boolean {
  // The moov-only packet-table helpers do not include later trun rows. Demux packets use the merged map.
  if (movie.hasFragments === true) return false;
  return movie.tracks.every((track) => {
    if (track.samples.sampleSizes.length > 0) return true;
    return track.fragmentSampleCount === undefined && track.durationSec === 0;
  });
}

type PacketMetadataRow = PacketMetadata & { trackIndex: number; size: number };

export interface Mp4PacketInfoMetadata {
  trackIndex: number;
  offset?: number;
  size: number;
  ptsUs: number;
  dtsUs: number;
  durationUs?: number;
  keyframe: boolean;
}

interface SampleTableRunCursor {
  index: number;
  remaining: number;
  value: number;
}

/** Timeline fields shared by decodable tracks and packet-bearing non-media tracks. */
interface PacketTimelineTrack {
  readonly timescale: number;
  readonly edit?: ParsedTrack['edit'];
  readonly samples: ParsedTrack['samples'];
}

/**
 * ISO edit lists bound the presented tail. Keep leading decode pre-roll (including negative rebased
 * timestamps) and the final sample that overlaps the edit end, but do not expose coded samples whose
 * decode interval starts wholly after the active edit. This mirrors ffprobe packet enumeration while
 * retaining every packet needed to decode the visible B-frame/AAC boundary.
 */
function sampleStartsBeforeActiveEditEnd(track: PacketTimelineTrack, dtsTicks: number): boolean {
  const edit = track.edit;
  if (edit === undefined || edit.durationSec <= 0 || track.timescale <= 0) return true;
  const durationTicks = Math.max(0, Math.round(edit.durationSec * track.timescale));
  return dtsTicks < edit.mediaTimeTicks + durationTicks;
}

function samplesWithinActiveEdit(
  track: PacketTimelineTrack,
  samples: readonly Sample[],
): readonly Sample[] {
  const edit = track.edit;
  if (edit === undefined || edit.durationSec <= 0) return samples;
  const editEndUs = Math.round(edit.durationSec * 1_000_000);
  let end = samples.length;
  while (end > 0 && (samples[end - 1]?.dtsUs ?? Number.NEGATIVE_INFINITY) >= editEndUs) {
    end--;
  }
  return end === samples.length ? samples : samples.slice(0, end);
}

type DeclaredTrackEntry =
  | { readonly kind: 'av'; readonly order: number; readonly track: ParsedTrack }
  | {
      readonly kind: 'other';
      readonly order: number;
      readonly track: OtherTrack;
    };

/** Every declared `trak`, sorted by its position in `moov` (the public packet track-index space). */
function declaredTrackEntries(movie: Movie): DeclaredTrackEntry[] {
  const entries: DeclaredTrackEntry[] = [
    ...movie.tracks.map(
      (track): DeclaredTrackEntry => ({
        kind: 'av',
        order: track.trakIndex ?? Number.MAX_SAFE_INTEGER,
        track,
      }),
    ),
    ...(movie.otherTracks ?? []).map(
      (track): DeclaredTrackEntry => ({
        kind: 'other',
        order: track.trakIndex,
        track,
      }),
    ),
  ];
  entries.sort((left, right) => left.order - right.order);
  return entries;
}

function otherTrackHasSamples(
  track: OtherTrack,
): track is OtherTrack & { readonly samples: ParsedTrack['samples'] } {
  return track.samples !== undefined;
}

function nextPacketTimeDelta(
  entries: ParsedTrack['samples']['timeToSample'],
  cursor: SampleTableRunCursor,
): number {
  while (cursor.remaining <= 0) {
    const entry = entries[cursor.index];
    if (entry === undefined) return cursor.value;
    cursor.index++;
    if (entry.count <= 0) continue;
    cursor.remaining = entry.count;
    cursor.value = entry.delta;
  }
  cursor.remaining--;
  return cursor.value;
}

function nextPacketCompositionOffset(
  entries: ParsedTrack['samples']['compositionOffsets'],
  cursor: SampleTableRunCursor,
): number {
  while (cursor.remaining <= 0) {
    const entry = entries[cursor.index];
    if (entry === undefined) return cursor.value;
    cursor.index++;
    if (entry.count <= 0) continue;
    cursor.remaining = entry.count;
    cursor.value = entry.offset;
  }
  cursor.remaining--;
  return cursor.value;
}

function sampleNumbersAreAscending(values: readonly number[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < previous) return false;
    previous = value;
  }
  return true;
}

function appendTrackPacketMetadata(
  packets: PacketMetadataRow[],
  packetIndex: number,
  track: ParsedTrack,
  trackIndex: number,
  sourceSize: number | undefined,
): number {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const timeToSample = st.timeToSample;
  const compositionOffsets = st.compositionOffsets;
  const syncSamples = st.syncSamples;
  const sampleToChunk = st.sampleToChunk;
  const chunkOffsets = st.chunkOffsets;
  const count = sizes.length;
  const timescale = track.timescale;
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  const hasCtts = compositionOffsets.length > 0;
  const allSync = syncSamples.length === 0;
  const sortedSync = allSync || sampleNumbersAreAscending(syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(syncSamples);
  const deltaCursor: SampleTableRunCursor = {
    index: 0,
    remaining: 0,
    value: 0,
  };
  const cttsCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };

  let writeIndex = packetIndex;
  let stscIndex = 0;
  let samplesPerChunk = 0;
  let syncIndex = 0;
  let sampleIndex = 0;
  let dtsTicks = 0;
  for (let c = 0; c < chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const chunkNumber = c + 1;
    while (true) {
      const entry = sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
    let offset = chunkOffset;
    for (let s = 0; s < samplesPerChunk && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const durationTicks = nextPacketTimeDelta(timeToSample, deltaCursor);
      const cttsTicks = hasCtts ? nextPacketCompositionOffset(compositionOffsets, cttsCursor) : 0;
      validateSampleRange(sampleIndex, offset, size, sourceSize);

      const sampleNumber = sampleIndex + 1;
      let syncSample = syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = syncSamples[syncIndex];
      }
      const dtsUs = ticksToUs(dtsTicks - editOffsetTicks, timescale);
      if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
        packets[writeIndex] = {
          trackId: track.id,
          trackIndex,
          size,
          sizeBytes: size,
          ptsUs: ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, timescale),
          dtsUs,
          durationUs: ticksToUs(durationTicks, timescale),
          keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
        };
        writeIndex++;
      }
      offset += size;
      dtsTicks += durationTicks;
      sampleIndex++;
    }
  }
  return writeIndex;
}

export function mp4PacketMetadata(movie: Movie, sourceSize?: number): readonly PacketMetadata[] {
  const packetCount = movie.tracks.reduce(
    (sum, track) => sum + track.samples.sampleSizes.length,
    0,
  );
  const packets = new Array<PacketMetadataRow>(packetCount);
  let packetIndex = 0;
  for (let trackIndex = 0; trackIndex < movie.tracks.length; trackIndex++) {
    const track = movie.tracks[trackIndex];
    if (track === undefined) continue;
    packetIndex = appendTrackPacketMetadata(packets, packetIndex, track, trackIndex, sourceSize);
  }
  packets.length = packetIndex;
  return packets;
}

function appendTrackPacketInfoBySampleOrder(
  packets: Mp4PacketInfoMetadata[],
  packetIndex: number,
  track: PacketTimelineTrack,
  trackIndex: number,
): number {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const timeToSample = st.timeToSample;
  const compositionOffsets = st.compositionOffsets;
  const syncSamples = st.syncSamples;
  const timescale = track.timescale;
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  const hasCtts = compositionOffsets.length > 0;
  const allSync = syncSamples.length === 0;
  const sortedSync = allSync || sampleNumbersAreAscending(syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(syncSamples);
  const deltaCursor: SampleTableRunCursor = {
    index: 0,
    remaining: 0,
    value: 0,
  };
  const cttsCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };
  let writeIndex = packetIndex;
  let syncIndex = 0;
  let dtsTicks = 0;

  for (let sampleIndex = 0; sampleIndex < sizes.length; sampleIndex++) {
    const size = sizes[sampleIndex] ?? 0;
    const durationTicks = nextPacketTimeDelta(timeToSample, deltaCursor);
    const cttsTicks = hasCtts ? nextPacketCompositionOffset(compositionOffsets, cttsCursor) : 0;
    if (size < 0) validateSampleRange(sampleIndex, 0, size, undefined);

    const sampleNumber = sampleIndex + 1;
    let syncSample = syncSamples[syncIndex];
    while (syncSample !== undefined && syncSample < sampleNumber) {
      syncIndex++;
      syncSample = syncSamples[syncIndex];
    }
    if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
      packets[writeIndex] = {
        trackIndex,
        size,
        ptsUs: ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, timescale),
        dtsUs: ticksToUs(dtsTicks - editOffsetTicks, timescale),
        durationUs: ticksToUs(durationTicks, timescale),
        keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
      };
      writeIndex++;
    }
    dtsTicks += durationTicks;
  }
  return writeIndex;
}

function appendTrackPacketInfoMetadata(
  packets: Mp4PacketInfoMetadata[],
  packetIndex: number,
  track: PacketTimelineTrack,
  trackIndex: number,
  sourceSize: number | undefined,
  includeOffsets: boolean,
): number {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const timeToSample = st.timeToSample;
  const compositionOffsets = st.compositionOffsets;
  const syncSamples = st.syncSamples;
  const sampleToChunk = st.sampleToChunk;
  const chunkOffsets = st.chunkOffsets;
  const count = sizes.length;
  const timescale = track.timescale;
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  const hasCtts = compositionOffsets.length > 0;
  const allSync = syncSamples.length === 0;
  const sortedSync = allSync || sampleNumbersAreAscending(syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(syncSamples);
  const deltaCursor: SampleTableRunCursor = {
    index: 0,
    remaining: 0,
    value: 0,
  };
  const cttsCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };

  let writeIndex = packetIndex;
  let stscIndex = 0;
  let samplesPerChunk = 0;
  let syncIndex = 0;
  let sampleIndex = 0;
  let dtsTicks = 0;
  for (let c = 0; c < chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const chunkNumber = c + 1;
    while (true) {
      const entry = sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
    let offset = chunkOffset;
    for (let s = 0; s < samplesPerChunk && sampleIndex < count; s++) {
      const size = sizes[sampleIndex] ?? 0;
      const durationTicks = nextPacketTimeDelta(timeToSample, deltaCursor);
      const cttsTicks = hasCtts ? nextPacketCompositionOffset(compositionOffsets, cttsCursor) : 0;
      validateSampleRange(sampleIndex, offset, size, sourceSize);

      const sampleNumber = sampleIndex + 1;
      let syncSample = syncSamples[syncIndex];
      while (syncSample !== undefined && syncSample < sampleNumber) {
        syncIndex++;
        syncSample = syncSamples[syncIndex];
      }
      if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
        packets[writeIndex] = {
          trackIndex,
          ...(includeOffsets ? { offset } : {}),
          size,
          ptsUs: ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, timescale),
          dtsUs: ticksToUs(dtsTicks - editOffsetTicks, timescale),
          durationUs: ticksToUs(durationTicks, timescale),
          keyframe: allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber,
        };
        writeIndex++;
      }
      offset += size;
      dtsTicks += durationTicks;
      sampleIndex++;
    }
  }
  return writeIndex;
}

export function mp4PacketInfoMetadata(
  movie: Movie,
  sourceSize?: number,
  includeOffsets = true,
): readonly Mp4PacketInfoMetadata[] {
  const entries = declaredTrackEntries(movie);
  const packetCount = entries.reduce((sum, entry) => {
    if (entry.kind === 'av') return sum + entry.track.samples.sampleSizes.length;
    return sum + (entry.track.samples?.sampleSizes.length ?? 0);
  }, 0);
  const packets = new Array<Mp4PacketInfoMetadata>(packetCount);
  let packetIndex = 0;
  const appendTrack = (track: PacketTimelineTrack, trackIndex: number): void => {
    packetIndex =
      track.samples.chunkOffsets.length === 0 && track.samples.sampleToChunk.length === 0
        ? appendTrackPacketInfoBySampleOrder(packets, packetIndex, track, trackIndex)
        : appendTrackPacketInfoMetadata(
            packets,
            packetIndex,
            track,
            trackIndex,
            sourceSize,
            includeOffsets,
          );
  };
  for (let trackIndex = 0; trackIndex < entries.length; trackIndex++) {
    const entry = entries[trackIndex];
    if (entry === undefined) continue;
    if (entry.kind === 'av') appendTrack(entry.track, trackIndex);
    else if (otherTrackHasSamples(entry.track)) appendTrack(entry.track, trackIndex);
  }
  packets.length = packetIndex;
  return packets;
}

function ticksToUs(ticks: number, timescale: number): number {
  return timescale > 0 ? Math.round((ticks * 1_000_000) / timescale) : 0;
}

/**
 * Select a keyframe-aligned time range for a lossless trim: video starts at the keyframe at/before
 * `startSec` (the GOP head, so the cut decodes), audio at the first sample overlapping it; both end at
 * the last sample before `endSec`. The muxer re-bases DTS to 0, preserving each sample's `ctts`.
 */
function selectTrimmed(track: ParsedTrack, startSec: number, endSec: number): SampleData[] {
  const all = buildSampleData(track);
  if (all.length === 0) return all;
  const startTicks = startSec * track.timescale;
  const endTicks = endSec * track.timescale;

  let startIdx = 0;
  if (track.mediaType === 'video') {
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s?.keyframe && s.dtsTicks + s.cttsTicks <= startTicks) startIdx = i;
    }
  } else {
    const found = all.findIndex((s) => s.dtsTicks + s.durationTicks > startTicks);
    startIdx = found < 0 ? 0 : found;
  }

  let endIdx = all.length - 1;
  for (let i = startIdx; i < all.length; i++) {
    if ((all[i]?.dtsTicks ?? 0) >= endTicks) {
      endIdx = i - 1;
      break;
    }
  }
  return all.slice(startIdx, Math.max(startIdx, endIdx) + 1);
}

/**
 * Present the requested interval while retaining any leading decode/keyframe pre-roll in `samples`.
 * The output sample clock is rebased to the first selected DTS, so `mediaTimeTicks` is the requested
 * source start relative to that DTS. Duration is clamped only for malformed/short source timelines.
 */
function trimPresentationEdit(
  track: ParsedTrack,
  samples: readonly SampleData[],
  startSec: number,
  endSec: number,
): MuxTrackInput['edit'] | undefined {
  const first = samples[0];
  if (first === undefined || track.timescale <= 0) return undefined;
  const mediaTimeTicks = Math.max(0, Math.round(startSec * track.timescale - first.dtsTicks));
  const selectedDurationTicks = samples.reduce(
    (duration, sample) => duration + sample.durationTicks,
    0,
  );
  const availableDurationTicks = Math.max(0, selectedDurationTicks - mediaTimeTicks);
  const requestedDurationTicks = Math.max(0, Math.round((endSec - startSec) * track.timescale));
  const durationTicks = Math.min(requestedDurationTicks, availableDurationTicks);
  return durationTicks > 0 ? { mediaTimeTicks, durationTicks } : undefined;
}

function toUs(ticks: number, timescale: number): number {
  return timescale > 0 ? Math.round((ticks * 1_000_000) / timescale) : 0;
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function describeUnknownError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    return `${e.name}: ${e.message}`;
  }
  return String(e);
}

function avcDecodeValidationError(track: ParsedTrack, operation: string, e: unknown): MediaError {
  return new MediaError(
    'demux-error',
    `track ${track.id} failed browser decode validation during ${operation} (${describeUnknownError(e)})`,
    e,
  );
}

function avcDecodeConfig(track: ParsedTrack): VideoDecoderConfig | undefined {
  if (track.mediaType !== 'video') return undefined;
  if (track.sampleEntryType !== 'avc1' && track.sampleEntryType !== 'avc3') return undefined;
  if (track.codecPrivate?.boxType !== 'avcC') return undefined;
  const config = track.config;
  return 'codedWidth' in config || 'codedHeight' in config
    ? {
        ...(config as VideoDecoderConfig),
        hardwareAcceleration: 'no-preference',
      }
    : undefined;
}

async function canBrowserDecodeForTrim(config: VideoDecoderConfig): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false;
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

function closeDecoder(decoder: VideoDecoder | undefined): void {
  if (decoder && decoder.state !== 'closed') decoder.close();
}

function awaitDecoderDequeueOrAbort(
  decoder: VideoDecoder,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      decoder.removeEventListener('dequeue', onDequeue);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDequeue = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortedError());
    };
    decoder.addEventListener('dequeue', onDequeue);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function drainDecoderBelowHighWater(
  decoder: VideoDecoder,
  signal: AbortSignal | undefined,
): Promise<void> {
  while (decoder.decodeQueueSize >= TRIM_DECODE_VERIFY_HIGH_WATER) {
    await awaitDecoderDequeueOrAbort(decoder, signal);
  }
}

async function verifyTrimmedAvcDecodeIfAvailable(
  track: ParsedTrack,
  selected: readonly SampleData[],
  samples: readonly MuxSampleInput[],
  signal: AbortSignal | undefined,
  validationCacheBase: string | undefined,
  operation = 'MP4 trim',
  expectedOutputFrames?: number,
): Promise<void> {
  if (selected.length === 0) return;
  const config = avcDecodeConfig(track);
  const validationCacheKey = trimDecodeValidationCacheKey(validationCacheBase, track, selected);
  if (hasTrimDecodeValidationCacheHit(validationCacheKey)) return;
  if (!config || !(await canBrowserDecodeForTrim(config))) return;

  let decoder: VideoDecoder | undefined;
  let outputFrames = 0;
  let settled = false;
  let failDecode = (_error: MediaError): void => undefined;
  const errorPromise = new Promise<never>((_, reject: (reason?: unknown) => void) => {
    failDecode = (error): void => reject(error);
  });
  const fail = (error: MediaError): void => {
    if (settled) return;
    settled = true;
    closeDecoder(decoder);
    failDecode(error);
  };
  const onAbort = (): void => fail(abortedError());

  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    decoder = new VideoDecoder({
      output: (frame: VideoFrame): void => {
        outputFrames++;
        frame.close();
      },
      error: (e: DOMException): void => fail(avcDecodeValidationError(track, operation, e)),
    });
    try {
      decoder.configure(config);
    } catch {
      return;
    }
    for (let i = 0; i < selected.length; i++) {
      throwIfAborted(signal);
      const sample = selected[i];
      const muxSample = samples[i];
      if (!sample || !muxSample) continue;
      await Promise.race([drainDecoderBelowHighWater(decoder, signal), errorPromise]);
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.keyframe ? 'key' : 'delta',
          timestamp: toUs(sample.dtsTicks + sample.cttsTicks, track.timescale),
          duration: toUs(sample.durationTicks, track.timescale),
          data: muxSample.data,
        }),
      );
    }
    await Promise.race([decoder.flush(), errorPromise]);
    if (expectedOutputFrames !== undefined && outputFrames !== expectedOutputFrames) {
      throw new MediaError(
        'demux-error',
        `track ${track.id} failed browser decode validation during ${operation}: decoded ${outputFrames} frames from ${expectedOutputFrames} AVC access units`,
      );
    }
    rememberTrimDecodeValidation(validationCacheKey);
  } catch (e) {
    throw e instanceof MediaError ? e : avcDecodeValidationError(track, operation, e);
  } finally {
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    closeDecoder(decoder);
  }
}

async function verifyTrimmedAvcDecodeFromSourceIfAvailable(
  track: ParsedTrack,
  selected: readonly SampleData[],
  ra: RandomAccess,
  signal: AbortSignal | undefined,
  validationCacheBase: string | undefined,
): Promise<void> {
  if (selected.length === 0) return;
  const config = avcDecodeConfig(track);
  validateSampleRanges(selected, ra.size);
  const validationCacheKey = trimDecodeValidationCacheKey(validationCacheBase, track, selected);
  if (hasTrimDecodeValidationCacheHit(validationCacheKey)) return;
  if (!config || !(await canBrowserDecodeForTrim(config))) return;

  const windows = planSampleReadWindows(selected);
  const windowByOrdinal = new Array<SampleReadWindow<SampleData> | undefined>(selected.length);
  for (const window of windows) {
    for (const item of window.items) windowByOrdinal[item.ordinal] = window;
  }

  let decoder: VideoDecoder | undefined;
  let settled = false;
  let failDecode = (_error: MediaError): void => undefined;
  const errorPromise = new Promise<never>((_, reject: (reason?: unknown) => void) => {
    failDecode = (error): void => reject(error);
  });
  const fail = (error: MediaError): void => {
    if (settled) return;
    settled = true;
    closeDecoder(decoder);
    failDecode(error);
  };
  const onAbort = (): void => fail(abortedError());

  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    decoder = new VideoDecoder({
      output: (frame: VideoFrame): void => frame.close(),
      error: (e: DOMException): void => fail(avcDecodeValidationError(track, 'MP4 trim', e)),
    });
    try {
      decoder.configure(config);
    } catch {
      return;
    }

    let currentWindow: SampleReadWindow<SampleData> | undefined;
    let currentBytes: Uint8Array | undefined;
    for (let i = 0; i < selected.length; i++) {
      throwIfAborted(signal);
      const sample = selected[i];
      if (sample === undefined) continue;
      const window = windowByOrdinal[i];
      if (window === undefined) {
        throw new MediaError(
          'demux-error',
          `sample ${sample.index} has no read window (internal read plan error)`,
        );
      }
      if (window !== currentWindow) {
        currentBytes = await ra.read(window.start, window.end - window.start);
        throwIfAborted(signal);
        if (currentBytes.byteLength !== window.end - window.start) {
          throw new MediaError(
            'demux-error',
            `sample window [${window.start}, ${window.end}) short read: got ${
              currentBytes.byteLength
            } of ${window.end - window.start} bytes (truncated MP4)`,
          );
        }
        currentWindow = window;
      }
      if (currentBytes === undefined) {
        throw new MediaError(
          'demux-error',
          'sample window bytes are missing (internal read error)',
        );
      }
      const rel = sample.offset - window.start;
      await Promise.race([drainDecoderBelowHighWater(decoder, signal), errorPromise]);
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.keyframe ? 'key' : 'delta',
          timestamp: toUs(sample.dtsTicks + sample.cttsTicks, track.timescale),
          duration: toUs(sample.durationTicks, track.timescale),
          data: currentBytes.subarray(rel, rel + sample.size),
        }),
      );
    }
    await Promise.race([decoder.flush(), errorPromise]);
    rememberTrimDecodeValidation(validationCacheKey);
  } catch (e) {
    throw e instanceof MediaError ? e : avcDecodeValidationError(track, 'MP4 trim', e);
  } finally {
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    closeDecoder(decoder);
  }
}

async function trimMuxTracks(
  ra: RandomAccess,
  movie: Movie,
  startSec: number,
  endSec: number,
  signal: AbortSignal | undefined,
  validationCacheBase: string | undefined,
): Promise<MuxTrackInput[]> {
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    const selected = selectTrimmed(track, startSec, endSec);
    const samples = await readSamples(ra, selected);
    await verifyTrimmedAvcDecodeIfAvailable(track, selected, samples, signal, validationCacheBase);
    const edit = trimPresentationEdit(track, selected, startSec, endSec);
    out.push({
      ...muxTrackMeta(track),
      ...(edit !== undefined ? { edit } : {}),
      samples,
    });
  }
  return out;
}

function toTrackInfo(t: ParsedTrack): TrackInfo {
  const gapless = audioGaplessInfo(t);
  const color: TrackInfo['color'] | undefined =
    t.mediaType === 'video' && t.colr !== undefined
      ? {
          matrixCoefficients: t.colr.matrix,
          transferCharacteristics: t.colr.transfer,
          primaries: t.colr.primaries,
          ...(t.colr.fullRange !== undefined ? { range: t.colr.fullRange ? 2 : 1 } : {}),
        }
      : undefined;
  return {
    id: t.id,
    mediaType: t.mediaType,
    codec: t.codec,
    durationSec: presentationDurationSec(t),
    ...(t.fps !== undefined ? { fps: t.fps } : {}),
    ...(t.rotation !== undefined ? { rotation: t.rotation } : {}),
    ...(t.encryption !== undefined ? { encrypted: true } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(gapless !== undefined ? { gapless } : {}),
    config: t.config,
  };
}

/**
 * A fully-contained non-AAC edit is a presentation trim: expose its segment duration to every demux
 * consumer, including cross-container muxers. The media duration can be longer because it contains
 * decode pre-roll; forwarding that raw span makes a target container declare the pre-roll as playable
 * timeline. AAC edits retain media duration because their contained edit is the separate gapless
 * priming/padding contract exposed by `gapless`.
 */
function presentationDurationSec(track: ParsedTrack): number {
  const edit = track.edit;
  if (edit === undefined || edit.durationSec <= 0 || isAacTrack(track) || track.timescale <= 0) {
    return track.durationSec;
  }
  const editEndSec = edit.mediaTimeTicks / track.timescale + edit.durationSec;
  const containedToleranceSec = 1 / track.timescale;
  const isContainedPresentationTrim =
    edit.durationSec < track.durationSec && editEndSec <= track.durationSec + containedToleranceSec;
  return isContainedPresentationTrim ? edit.durationSec : track.durationSec;
}

function toProbeTrackInfo(track: ParsedTrack): TrackInfo {
  return toTrackInfo(track);
}

export function mp4PacketInfoTable(movie: Movie, sourceSize?: number): PacketInfoTable {
  return {
    tracks: declaredTrackEntries(movie).map((entry) =>
      entry.kind === 'av' ? toTrackInfo(entry.track) : toOtherProbeTrackInfo(entry.track),
    ),
    // A full parse may have been required internally to classify AVC pictures in a large source.
    // Keep the public large-file shape identical to the offset-free packet-info fast path.
    packets: mp4PacketInfoMetadata(movie, sourceSize, sourceSize !== undefined),
  };
}

/**
 * A declared non-media trak (e.g. a QuickTime `tmcd` timecode trak) as a probe-only {@link TrackInfo}.
 * Surfacing it keeps probe's track count and order aligned with ffprobe's `nb_streams`; it carries no
 * config, so the engine reports it as `MediaInfoTrack.type: 'other'` with an empty codec (ffprobe emits
 * no `codec_name` for such a stream). Its media duration participates in the container duration exactly
 * as ffprobe's `format` duration is the maximum across all streams.
 */
function toOtherProbeTrackInfo(track: OtherTrack): TrackInfo {
  return {
    id: track.id,
    mediaType: 'video',
    nonMedia: true,
    codec: '',
    ...(track.durationSec > 0 ? { durationSec: track.durationSec } : {}),
  };
}

/**
 * Every declared trak (audio/video **and** non-media) as probe tracks, in `moov` file order — the
 * stream order ffprobe lists. AV tracks retain media-header duration except for a fully-contained
 * presentation trim (whose edit-list duration is the public span); AAC gapless edits stay separate.
 * Non-media traks are enumerated honestly instead of dropped.
 */
function toProbeTracks(movie: Movie): readonly TrackInfo[] {
  const others = movie.otherTracks ?? [];
  if (others.length === 0) return movie.tracks.map(toProbeTrackInfo);
  const merged: Array<{ order: number; info: TrackInfo }> = [
    ...movie.tracks.map((track) => ({
      order: track.trakIndex ?? Number.MAX_SAFE_INTEGER,
      info: toProbeTrackInfo(track),
    })),
    ...others.map((track) => ({
      order: track.trakIndex,
      info: toOtherProbeTrackInfo(track),
    })),
  ];
  merged.sort((a, b) => a.order - b.order);
  return merged.map((entry) => entry.info);
}

function isAacTrack(track: ParsedTrack): boolean {
  return track.mediaType === 'audio' && track.codec.startsWith('mp4a');
}

function audioGaplessInfo(track: ParsedTrack): TrackInfo['gapless'] | undefined {
  if (!isAacTrack(track) || track.sampleRate === undefined || track.edit === undefined) {
    return undefined;
  }
  const sampleRate = track.sampleRate;
  const scale = sampleRate / track.timescale;
  const durationTicks =
    track.samples.timeToSample.reduce((total, entry) => total + entry.count * entry.delta, 0) +
    (track.fragmentMediaTicks ?? 0);
  const codedSamples =
    durationTicks > 0
      ? Math.max(0, Math.round(durationTicks * scale))
      : buildSampleData(track).reduce(
          (total, sample) => total + Math.round(sample.durationTicks * scale),
          0,
        );
  return gaplessFromMp4Edit(
    track.edit.mediaTimeTicks,
    track.edit.durationSec,
    sampleRate,
    track.timescale,
    codedSamples,
  );
}

/**
 * Stream a track's samples as seam {@link Packet}s (browser: requires `Encoded*Chunk`). The chunk's
 * `timestamp` is the PTS (DTS + composition offset); the packet's `dtsUs` carries the true **decode**
 * timestamp from the `stts` table, so a B-frame/open-GOP track enumerates and remuxes in decode order
 * losslessly (ADR-045). For a non-reordered track `dtsUs === ptsUs`, which is the documented no-op.
 */
function packetStream(
  ra: RandomAccess,
  track: ParsedTrack,
  signal: AbortSignal | undefined,
  precomputedSamples?: readonly Sample[],
): ReadableStream<Packet> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebCodecs EncodedVideoChunk/EncodedAudioChunk are unavailable in this environment',
      { op: 'demux', tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
  // Fragmented tracks carry no `moov` sample table; the demuxer pre-builds their samples from the
  // `moof`/`traf`/`trun` runs (fragment-samples.ts) and passes them here.
  const samples = samplesWithinActiveEdit(track, precomputedSamples ?? buildSamples(track));
  // `demux()` proved these same immutable progressive tables or merged fragment samples safe before
  // exposing the Demuxer. Re-scanning every range when a consumer opens its packet stream is redundant.
  const readPlan = planPacketReadWindows(samples);
  const isVideo = track.mediaType === 'video';
  let i = 0;
  let plannedWindowIndex = 0;
  let cancelled = false;
  let currentWindow: PacketReadWindow | undefined;
  let currentBytes: Uint8Array | undefined;
  const enqueueSample = (
    controller: ReadableStreamDefaultController<Packet>,
    sample: Sample,
    window: PacketReadWindow,
    bytes: Uint8Array,
  ): void => {
    const rel = sample.offset - window.start;
    const data = bytes.subarray(rel, rel + sample.size);
    const init = {
      type: (sample.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
      timestamp: sample.ptsUs,
      duration: sample.durationUs,
      data,
    };
    const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
    controller.enqueue({
      chunk,
      data,
      dtsUs: sample.dtsUs,
      sizeBytes: sample.size,
    });
  };
  return new ReadableStream<Packet>({
    pull(controller): void | Promise<void> {
      if (signal?.aborted) {
        controller.error(abortedError());
        return;
      }
      const ordinal = i;
      const sample = samples[ordinal];
      if (sample === undefined) {
        controller.close();
        return;
      }
      i = ordinal + 1;
      let window: PacketReadWindow | undefined;
      if (readPlan.kind === 'ordinal') {
        window = readPlan.byOrdinal[ordinal];
      } else {
        let monotonicWindow = readPlan.windows[plannedWindowIndex];
        if (monotonicWindow !== undefined && ordinal > monotonicWindow.lastOrdinal) {
          plannedWindowIndex++;
          monotonicWindow = readPlan.windows[plannedWindowIndex];
        }
        window = monotonicWindow;
      }
      if (window === undefined) {
        throw new MediaError(
          'demux-error',
          `sample ${sample.index} has no read window (internal read plan error)`,
        );
      }
      if (window === currentWindow && currentBytes !== undefined) {
        enqueueSample(controller, sample, window, currentBytes);
        return;
      }

      const windowLength = window.end - window.start;
      const retained = coveredByteView(ra.cachedWhole?.(), window.start, windowLength);
      if (retained !== undefined) {
        currentWindow = window;
        currentBytes = retained;
        enqueueSample(controller, sample, window, retained);
        return;
      }

      return ra.read(window.start, windowLength).then((bytes): void => {
        if (cancelled) return;
        throwIfAborted(signal);
        if (bytes.byteLength !== windowLength) {
          throw new MediaError(
            'demux-error',
            `sample window [${window.start}, ${window.end}) short read: got ${
              bytes.byteLength
            } of ${windowLength} bytes (truncated MP4)`,
          );
        }
        currentWindow = window;
        currentBytes = bytes;
        enqueueSample(controller, sample, window, bytes);
      });
    },
    cancel(): void {
      cancelled = true;
      currentWindow = undefined;
      currentBytes = undefined;
    },
  });
  /* v8 ignore stop */
}

/** True when `mvex`/parsed fragment timing says later `moof` runs extend the movie. */
function movieIsFragmented(movie: Movie): boolean {
  return (
    movie.hasFragments === true ||
    movie.tracks.some((t) => t.samples.sampleSizes.length === 0 && (t.fragmentSampleCount ?? 0) > 0)
  );
}

/**
 * For a fragmented movie, read the file once and pre-build every track's demux sample list from the
 * `moof`/`traf`/`trun` runs (fragment-samples.ts), mapped to the WebCodecs microsecond seam. Returns
 * `undefined` for a progressive movie (its `moov` sample tables drive `packetStream` directly), so the
 * common path pays nothing. Samples whose bytes escape the file are dropped inside the mapper.
 */
async function buildFragmentSampleMap(
  movie: Movie,
  ra: RandomAccess,
): Promise<Map<number, Sample[]> | undefined> {
  if (!movieIsFragmented(movie)) return undefined;
  const file = await readWholeFile(ra, ra.size ?? Number.MAX_SAFE_INTEGER);
  const byTrack = parseFragmentSamples(file);
  const out = new Map<number, Sample[]>();
  for (const track of movie.tracks) {
    const fragments = byTrack.get(track.id);
    if (fragments === undefined || fragments.length === 0) continue;
    const data = mergeMoovAndFragmentSamples(buildSampleData(track), fragments);
    out.set(
      track.id,
      fragmentSamplesToDemuxSamples(
        data,
        track.timescale,
        track.edit?.mediaTimeTicks ?? 0,
        file.byteLength,
      ),
    );
  }
  return out;
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && MP4_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && MP4_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head && head.byteLength >= 8) {
    const magic = String.fromCharCode(
      head[4] as number,
      head[5] as number,
      head[6] as number,
      head[7] as number,
    );
    if (magic === 'ftyp' || magic === 'styp' || magic === 'moov') return true;
  }
  return false;
}

/**
 * Verify every sample's byte range `[offset, offset+size)` lies within the source before it is read for
 * decryption. A truncated `mdat` (sample bytes promised by the index but missing from the file) would
 * otherwise be read as a silently-clamped short buffer and "decrypted" into garbage; instead reject it as
 * corrupt input ({@link MediaError} `demux-error`). `sourceSize` is omitted only when the source is a
 * non-seekable stream — which {@link randomAccess} fully buffers, so a size is always available here.
 */
function assertSampleRangesInBounds(track: ParsedTrack, sourceSize: number): void {
  for (const s of buildSampleData(track)) {
    if (s.offset < 0 || s.size < 0 || s.offset + s.size > sourceSize) {
      throw new MediaError(
        'demux-error',
        `protected sample ${s.index} range [${s.offset}, ${s.offset + s.size}) exceeds source size ${sourceSize} (truncated/corrupt mdat)`,
      );
    }
  }
}

/** Look up the AES key (bytes) for a track's KID, or raise a typed miss if the caller didn't supply it. */
function resolveKey(
  keys: Record<string, string>,
  kid: Uint8Array,
  formatKid: (kid: Uint8Array) => string,
): Uint8Array<ArrayBuffer> {
  const kidId = formatKid(kid);
  const hexKey = keys[kidId];
  if (hexKey === undefined) {
    throw new CapabilityError('capability-miss', `no key provided for KID ${kidId}`, {
      op: 'decrypt',
      tried: ['mp4'],
    });
  }
  return hexToBytes(hexKey);
}

function cencSamplesForTrack(
  cenc: Pick<CencModule, 'parseSenc'>,
  enc: NonNullable<ParsedTrack['encryption']>,
  tenc: TencInfo,
  containerScheme: CencScheme,
  trackId: number,
): SencSamples | undefined {
  if (enc.senc) return cenc.parseSenc(enc.senc, tenc.perSampleIvSize, containerScheme);
  if (
    containerScheme === CBCS_SCHEME &&
    tenc.perSampleIvSize === 0 &&
    tenc.constantIv !== undefined
  ) {
    return undefined;
  }
  throw new MediaError(
    'demux-error',
    `${containerScheme} track ${trackId} missing senc/default_IV metadata`,
  );
}

function supportedCencScheme(schemeType: string): CencScheme | undefined {
  if (schemeType === CENC_SCHEME || schemeType === CENS_SCHEME || schemeType === CBCS_SCHEME) {
    return schemeType;
  }
  return undefined;
}

/**
 * Decrypt one CENC-protected track (`cenc` AES-CTR, `cens` AES-CTR-pattern, or `cbcs`
 * AES-CBC-pattern) into a cleartext
 * {@link MuxTrackInput}. The scheme is the container's own (`enc.schemeType` from `schm`); the caller's
 * declared `scheme` must match it (a mismatch is corrupt/contradictory input). A protected track with an
 * empty sample table (e.g. fragmented/CMAF metadata in `moof/traf`, which this `moov` path does not read)
 * cannot be honestly decrypted here, so it rejects rather than emit a sample-less blob. `senc` is required
 * for byte decryption; if a cbcs track has a `tenc` default_constant_IV but no sample auxiliary encryption
 * data at all, Bento4's `mp4decrypt` leaves the samples unchanged, so this path strips the protection
 * wrapper after key resolution rather than corrupting already-clear samples.
 */
async function decryptCencTrack(
  cenc: CencModule,
  parsed: ParsedTrack,
  track: MuxTrackInput,
  enc: NonNullable<ParsedTrack['encryption']>,
  keys: Record<string, string>,
  declaredScheme: CencScheme,
  sourceSize: number | undefined,
): Promise<MuxTrackInput> {
  const containerScheme = supportedCencScheme(enc.schemeType);
  if (!containerScheme) {
    throw new CapabilityError(
      'capability-miss',
      `unsupported MP4 protection scheme '${enc.schemeType}'`,
      { op: 'decrypt', tried: ['mp4'] },
    );
  }
  if (containerScheme !== declaredScheme) {
    throw new MediaError(
      'demux-error',
      `track ${parsed.id} is ${containerScheme}, not requested ${declaredScheme}`,
    );
  }
  if (parsed.samples.sampleSizes.length === 0) {
    throw new MediaError(
      'demux-error',
      `${containerScheme} track ${parsed.id} has no decryptable samples`,
    );
  }
  const tenc = cenc.parseTenc(enc.tenc, containerScheme);
  const key = resolveKey(keys, tenc.kid, cenc.kidHex);
  const senc = cencSamplesForTrack(cenc, enc, tenc, containerScheme, parsed.id);
  if (senc === undefined) return track;
  // A protected track's ciphertext must lie entirely within the file; a truncated mdat (sample bytes
  // promised by the index but missing) is rejected rather than decrypted from a clamped short buffer.
  if (sourceSize !== undefined) assertSampleRangesInBounds(parsed, sourceSize);
  if (senc.length !== track.samples.length) {
    throw new MediaError(
      'demux-error',
      `senc sample count ${senc.length} != track sample count ${track.samples.length}`,
    );
  }
  const cipher = track.samples.map((s) => s.data);
  const clear =
    containerScheme === CBCS_SCHEME
      ? await cenc.decryptSamplesCbcs(
          key,
          cipher,
          senc,
          tenc.pattern ?? { cryptByteBlock: 1, skipByteBlock: 0 }, // version-0 cbcs ⇒ full CBC, no pattern
          tenc.constantIv,
        )
      : containerScheme === CENS_SCHEME
        ? await cenc.decryptSamplesCens(
            key,
            cipher,
            senc,
            tenc.pattern ?? { cryptByteBlock: 1, skipByteBlock: 0 },
          )
        : await cenc.decryptSamples(key, cipher, senc);
  return {
    ...track,
    samples: track.samples.map((s, j) => ({ ...s, data: clear[j] ?? s.data })),
  };
}

/** Hex (16-byte) value from the HLS key map, or a typed error naming the missing/short field. */
function hlsKeyField(keys: Record<string, string>, field: 'key' | 'iv'): Uint8Array<ArrayBuffer> {
  const hex = keys[field];
  if (hex === undefined) {
    throw new CapabilityError(
      'capability-miss',
      `HLS AES-128 needs '${field}' (hex) in keys; none provided`,
      { op: 'decrypt', tried: ['mp4'] },
    );
  }
  return hexToBytes(hex);
}

/**
 * Decrypt a full-segment HLS `AES-128` (AES-128-CBC + PKCS#7) **MP4** segment: the whole byte stream is
 * the ciphertext of a clear MP4. The key/IV come from the caller's `keys` (`key`/`iv` hex). The recovered
 * bytes must re-parse as an MP4 (a sanity gate that we produced a real container, not garbage). A raw
 * MPEG-TS HLS segment is not an MP4 and is out of this driver's scope — use `decryptHlsAes128` directly.
 */
async function decryptHlsSegmentMp4(
  ra: RandomAccess,
  keys: Record<string, string>,
): Promise<Uint8Array> {
  if (ra.size === undefined) {
    throw new MediaError(
      'demux-error',
      'HLS AES-128 needs the full segment size (non-seekable source)',
    );
  }
  const cipher = await ra.read(0, ra.size);
  if (cipher.byteLength === 0 || cipher.byteLength % 16 !== 0) {
    throw new MediaError(
      'demux-error',
      `HLS AES-128 segment must be a positive multiple of 16 bytes (CBC), got ${cipher.byteLength}`,
    );
  }
  const key = hlsKeyField(keys, 'key');
  const iv = hlsKeyField(keys, 'iv');
  if (key.byteLength !== 16 || iv.byteLength !== 16) {
    throw new MediaError(
      'demux-error',
      `HLS AES-128 key and IV must be 16 bytes (got key=${key.byteLength}, iv=${iv.byteLength})`,
    );
  }
  // A wrong key/IV trips PKCS#7 validation (SubtleCrypto throws a DOMException `OperationError`) or
  // yields bytes that are not a valid MP4 (`readMovie` throws). Either way the segment did not decrypt;
  // surface a typed MediaError, never a leaked DOMException (the typed-error model, ADR-017).
  try {
    const clear = await aesCbcPkcs7(key, iv, cipher.slice(), 'decrypt');
    await readMovie({
      read: (off, len) => Promise.resolve(clear.subarray(off, off + len)),
      size: clear.byteLength,
    });
    return clear;
  } catch (e) {
    if (e instanceof MediaError) throw e; // already typed (CapabilityError/InputError/MediaError)
    throw new MediaError(
      'demux-error',
      'HLS AES-128 segment did not decrypt to a valid MP4 (wrong key/IV, or not an AES-128 MP4 segment)',
      e,
    );
  }
}

/** A single-chunk byte stream (the whole output is already materialized in memory). */
function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/**
 * Stream a fragmented/CMAF MP4 (ADR-034): drive the {@link fragmentMp4} generator one segment at a time
 * (init segment, then one `moof`+`mdat` media segment per pull) so a `StreamTarget` writes each segment as
 * it is produced and peak memory stays bounded to a single fragment — never buffering the whole movie.
 */
function fragmentedStream(
  tracks: readonly MuxTrackInput[],
  movieTimescale: number,
): ReadableStream<Uint8Array> {
  const segments = fragmentMp4(tracks, { movieTimescale });
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const { done, value } = segments.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

interface LazyFragmentTrack {
  readonly metadata: FragmentInitTrackInput;
  readonly samples: readonly SampleData[];
}

export function planLazySampleDataFragmentRuns(
  samples: readonly SampleData[],
  targetSamples: number,
  splitAtKeyframes: boolean,
  hardMaxSamples: number = targetSamples,
): SampleData[][] {
  if (samples.length === 0) return [];
  const runs: SampleData[][] = [];
  let current: SampleData[] = [];
  for (const sample of samples) {
    const reachedAudioTarget = !splitAtKeyframes && current.length >= targetSamples;
    const reachedVideoTargetAtKeyframe =
      splitAtKeyframes && sample.keyframe && current.length >= targetSamples;
    const reachedHardVideoCap = splitAtKeyframes && current.length >= hardMaxSamples;
    if (
      current.length > 0 &&
      (reachedAudioTarget || reachedVideoTargetAtKeyframe || reachedHardVideoCap)
    ) {
      runs.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function lazyFragmentTracksFromMovie(
  ra: RandomAccess,
  movie: Movie,
  fragmentSamples?: Map<number, SampleData[]>,
): LazyFragmentTrack[] {
  const tracks = movie.tracks.map((track): LazyFragmentTrack => {
    const samples = fragmentSamples?.get(track.id) ?? buildSampleData(track);
    validateSampleRanges(samples, ra.size);
    return { metadata: muxTrackMeta(track), samples };
  });
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot fragment a movie with no tracks');
  }
  for (const [i, track] of tracks.entries()) {
    if (track.samples.length === 0) {
      throw new MediaError('mux-error', `track ${i + 1} has no samples to fragment`);
    }
  }
  return tracks;
}

interface LazyProgressiveTrack {
  readonly metadata: MuxTrackLayoutInput;
  readonly samples: readonly SampleData[];
}

interface InterleavedPayloadSample extends SampleRange {
  readonly trackIndex: number;
  readonly sampleIndex: number;
}

interface OpenInterleavedChunk {
  trackIndex: number;
  firstSample: number;
  sampleCount: number;
  payloadOffset: number;
}

interface InterleavedProgressivePlan {
  readonly tracks: readonly LazyProgressiveTrack[];
  readonly samples: readonly InterleavedPayloadSample[];
}

function lazyProgressiveTracksFromMovie(
  ra: RandomAccess,
  movie: Movie,
  fragmentSamples?: Map<number, SampleData[]>,
): LazyProgressiveTrack[] {
  const tracks = movie.tracks.map((track): LazyProgressiveTrack => {
    // Fragmented tracks carry no `moov` sample table; use the recovered `moof` samples (ADR-186).
    const samples = fragmentSamples?.get(track.id) ?? buildSampleData(track);
    validateSampleRanges(samples, ra.size);
    return {
      metadata: {
        ...muxTrackMeta(track),
        samples: samples.map((sample) => ({
          byteLength: sample.size,
          durationTicks: sample.durationTicks,
          cttsTicks: sample.cttsTicks,
          keyframe: sample.keyframe,
        })),
      },
      samples,
    };
  });
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot stream-copy a movie with no tracks');
  }
  for (const [i, track] of tracks.entries()) {
    if (track.samples.length === 0) {
      throw new MediaError('mux-error', `track ${i + 1} has no samples to stream-copy`);
    }
  }
  return tracks;
}

function sourceOrderInterleavedPlan(
  tracks: readonly LazyProgressiveTrack[],
): InterleavedProgressivePlan | undefined {
  if (tracks.length < 2) return undefined;
  const samples: InterleavedPayloadSample[] = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    if (track === undefined) continue;
    for (let sampleIndex = 0; sampleIndex < track.samples.length; sampleIndex++) {
      const sample = track.samples[sampleIndex];
      if (sample === undefined) continue;
      samples.push({
        index: sample.index,
        offset: sample.offset,
        size: sample.size,
        trackIndex,
        sampleIndex,
      });
    }
  }
  samples.sort(
    (a, b) => a.offset - b.offset || a.trackIndex - b.trackIndex || a.sampleIndex - b.sampleIndex,
  );

  const nextSampleByTrack = new Array<number>(tracks.length).fill(0);
  const chunksByTrack: MuxSampleChunkLayoutInput[][] = tracks.map(() => []);
  let open: OpenInterleavedChunk | undefined;
  let payloadOffset = 0;

  const closeOpenChunk = (): void => {
    if (open === undefined) return;
    chunksByTrack[open.trackIndex]?.push({
      firstSample: open.firstSample,
      sampleCount: open.sampleCount,
      payloadOffset: open.payloadOffset,
    });
    open = undefined;
  };

  for (const sample of samples) {
    const expectedSample = nextSampleByTrack[sample.trackIndex];
    if (sample.sampleIndex !== expectedSample) return undefined;
    nextSampleByTrack[sample.trackIndex] = expectedSample + 1;

    if (
      open !== undefined &&
      open.trackIndex === sample.trackIndex &&
      open.firstSample + open.sampleCount === sample.sampleIndex
    ) {
      open.sampleCount++;
    } else {
      closeOpenChunk();
      open = {
        trackIndex: sample.trackIndex,
        firstSample: sample.sampleIndex,
        sampleCount: 1,
        payloadOffset,
      };
    }
    payloadOffset += sample.size;
  }
  closeOpenChunk();

  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    if (nextSampleByTrack[trackIndex] !== tracks[trackIndex]?.samples.length) return undefined;
  }

  return {
    tracks: tracks.map((track, trackIndex) => ({
      ...track,
      metadata: {
        ...track.metadata,
        sampleChunks: chunksByTrack[trackIndex] ?? [],
      },
    })),
    samples,
  };
}

async function lazyProgressiveTrimTracksFromMovie(
  ra: RandomAccess,
  movie: Movie,
  startSec: number,
  endSec: number,
  signal: AbortSignal | undefined,
  validationCacheBase: string | undefined,
): Promise<LazyProgressiveTrack[]> {
  const tracks: LazyProgressiveTrack[] = [];
  for (const track of movie.tracks) {
    const samples = selectTrimmed(track, startSec, endSec);
    validateSampleRanges(samples, ra.size);
    await verifyTrimmedAvcDecodeFromSourceIfAvailable(
      track,
      samples,
      ra,
      signal,
      validationCacheBase,
    );
    const edit = trimPresentationEdit(track, samples, startSec, endSec);
    tracks.push({
      metadata: {
        ...muxTrackMeta(track),
        ...(edit !== undefined ? { edit } : {}),
        samples: samples.map((sample) => ({
          byteLength: sample.size,
          durationTicks: sample.durationTicks,
          cttsTicks: sample.cttsTicks,
          keyframe: sample.keyframe,
        })),
      },
      samples,
    });
  }
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'cannot trim-copy a movie with no tracks');
  }
  if (!tracks.some((track) => track.samples.length > 0)) {
    throw new MediaError('mux-error', 'trim selected no samples');
  }
  return tracks;
}

function progressiveLayoutFromTracks(
  tracks: readonly LazyProgressiveTrack[],
  o: StreamCopyOptions | undefined,
  movieTimescale: number,
): Mp4ByteStreamLayout {
  return planMp4ByteStreamLayout(
    tracks.map((track) => track.metadata),
    { faststart: o?.faststart ?? true, brand: brandFor(o?.container), movieTimescale },
  );
}

async function* progressivePayloadSegments(
  ra: RandomAccess,
  tracks: readonly LazyProgressiveTrack[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const track of tracks) {
    for (const window of planOrderedSampleReadWindows(track.samples)) {
      throwIfAborted(signal);
      const chunk = await readProgressivePayloadChunk(ra, window);
      throwIfAborted(signal);
      yield chunk;
    }
  }
}

async function* interleavedProgressivePayloadSegments(
  ra: RandomAccess,
  samples: readonly InterleavedPayloadSample[],
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const window of planSampleReadWindows(samples)) {
    throwIfAborted(signal);
    const chunk = await readProgressivePayloadChunk(ra, window);
    throwIfAborted(signal);
    yield chunk;
  }
}

async function* progressiveSegmentsFromTracks(
  ra: RandomAccess,
  tracks: readonly LazyProgressiveTrack[],
  o: StreamCopyOptions | undefined,
  movieTimescale: number,
  payloadSamples?: readonly InterleavedPayloadSample[],
): AsyncGenerator<Uint8Array, void, undefined> {
  const signal = o?.signal;
  const layout = progressiveLayoutFromTracks(tracks, o, movieTimescale);

  throwIfAborted(signal);
  yield layout.ftyp;
  if (layout.mdatBeforeMoov) {
    yield layout.mdatHeader;
    if (payloadSamples !== undefined) {
      yield* interleavedProgressivePayloadSegments(ra, payloadSamples, signal);
    } else {
      yield* progressivePayloadSegments(ra, tracks, signal);
    }
    yield layout.moov;
    return;
  }
  yield layout.moov;
  yield layout.mdatHeader;
  if (payloadSamples !== undefined) {
    yield* interleavedProgressivePayloadSegments(ra, payloadSamples, signal);
    return;
  }
  yield* progressivePayloadSegments(ra, tracks, signal);
}

async function materializeProgressiveTracksBytes(
  ra: RandomAccess,
  tracks: readonly LazyProgressiveTrack[],
  o: StreamCopyOptions | undefined,
  movieTimescale: number,
): Promise<Uint8Array> {
  const signal = o?.signal;
  const layout = progressiveLayoutFromTracks(tracks, o, movieTimescale);

  throwIfAborted(signal);
  const out = new Uint8Array(layout.totalLen);
  let p = 0;
  out.set(layout.ftyp, p);
  p += layout.ftyp.byteLength;
  if (!layout.mdatBeforeMoov) {
    out.set(layout.moov, p);
    p += layout.moov.byteLength;
  }
  out.set(layout.mdatHeader, p);
  p += layout.mdatHeader.byteLength;
  const payloadStart = p;
  const payloadEnd = payloadStart + layout.mdatPayloadLen;

  await copyProgressivePayload(out, ra, progressivePayloadCopies(tracks, payloadStart), signal);
  p = payloadEnd;
  if (layout.mdatBeforeMoov) {
    out.set(layout.moov, p);
    p += layout.moov.byteLength;
  }
  if (p !== layout.totalLen) {
    throw new MediaError(
      'mux-error',
      `internal MP4 layout mismatch: wrote ${p} total bytes, expected ${layout.totalLen}`,
    );
  }
  return out;
}

interface ProgressivePayloadCopy extends SampleRange {
  readonly outputOffset: number;
}

interface SourceReadWindow {
  readonly start: number;
  readonly end: number;
}

function progressivePayloadCopies(
  tracks: readonly LazyProgressiveTrack[],
  payloadStart: number,
): ProgressivePayloadCopy[] {
  const copies: ProgressivePayloadCopy[] = [];
  let outputOffset = payloadStart;
  for (const track of tracks) {
    for (const sample of track.samples) {
      copies.push({
        index: sample.index,
        offset: sample.offset,
        size: sample.size,
        outputOffset,
      });
      outputOffset += sample.size;
    }
  }
  copies.sort((a, b) => a.offset - b.offset || a.outputOffset - b.outputOffset);
  return copies;
}

async function copyProgressivePayload(
  out: Uint8Array,
  ra: RandomAccess,
  copies: readonly ProgressivePayloadCopy[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const singleRead = denseSingleReadWindow(copies);
  if (singleRead !== undefined) {
    throwIfAborted(signal);
    const span = await ra.read(singleRead.start, singleRead.end - singleRead.start);
    if (span.byteLength !== singleRead.end - singleRead.start) {
      throw new MediaError(
        'demux-error',
        `sample window [${singleRead.start}, ${singleRead.end}) short read: got ${
          span.byteLength
        } of ${singleRead.end - singleRead.start} bytes (truncated MP4)`,
      );
    }
    throwIfAborted(signal);
    for (const copy of copies) {
      const rel = copy.offset - singleRead.start;
      out.set(span.subarray(rel, rel + copy.size), copy.outputOffset);
    }
    return;
  }

  for (const window of planSampleReadWindows(copies)) {
    throwIfAborted(signal);
    const span = await ra.read(window.start, window.end - window.start);
    if (span.byteLength !== window.end - window.start) {
      throw new MediaError(
        'demux-error',
        `sample window [${window.start}, ${window.end}) short read: got ${span.byteLength} of ${
          window.end - window.start
        } bytes (truncated MP4)`,
      );
    }
    throwIfAborted(signal);
    for (const item of window.items) {
      const rel = item.sample.offset - window.start;
      out.set(span.subarray(rel, rel + item.sample.size), item.sample.outputOffset);
    }
  }
}

function denseSingleReadWindow(
  copies: readonly ProgressivePayloadCopy[],
): SourceReadWindow | undefined {
  if (copies.length === 0) return undefined;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  let payloadBytes = 0;
  for (const copy of copies) {
    start = Math.min(start, copy.offset);
    end = Math.max(end, copy.offset + copy.size);
    payloadBytes += copy.size;
  }
  const spanBytes = end - start;
  if (spanBytes <= 0 || spanBytes > PROGRESSIVE_SINGLE_READ_MAX_BYTES) return undefined;
  if (spanBytes - payloadBytes > PROGRESSIVE_SINGLE_READ_MAX_GAP_BYTES) return undefined;
  return { start, end };
}

function planOrderedSampleReadWindows(samples: readonly SampleData[]): SampleReadWindow[] {
  const windows: SampleReadWindow[] = [];
  let current: SampleReadWindow | undefined;
  for (let ordinal = 0; ordinal < samples.length; ordinal++) {
    const sample = samples[ordinal];
    if (sample === undefined) continue;
    const start = sample.offset;
    const end = sample.offset + sample.size;
    const item: SampleReadItem = { ordinal, sample };
    if (current === undefined) {
      current = { start, end, items: [item] };
      windows.push(current);
      continue;
    }
    const gap = start - current.end;
    const combinedSpan = end - current.start;
    if (
      start >= current.end &&
      gap <= SAMPLE_READ_GAP_BYTES &&
      combinedSpan <= SAMPLE_READ_WINDOW_BYTES
    ) {
      current.end = Math.max(current.end, end);
      current.items.push(item);
      continue;
    }
    current = { start, end, items: [item] };
    windows.push(current);
  }
  return windows;
}

async function readProgressivePayloadChunk(
  ra: RandomAccess,
  window: SampleReadWindow<SampleRange>,
): Promise<Uint8Array> {
  const span = await ra.read(window.start, window.end - window.start);
  if (span.byteLength !== window.end - window.start) {
    throw new MediaError(
      'demux-error',
      `sample window [${window.start}, ${window.end}) short read: got ${span.byteLength} of ${
        window.end - window.start
      } bytes (truncated MP4)`,
    );
  }

  let payloadLen = 0;
  for (const item of window.items) payloadLen += item.sample.size;
  if (payloadLen === span.byteLength) return span;

  const chunk = new Uint8Array(payloadLen);
  let p = 0;
  for (const item of window.items) {
    const rel = item.sample.offset - window.start;
    chunk.set(span.subarray(rel, rel + item.sample.size), p);
    p += item.sample.size;
  }
  return chunk;
}

function shouldLoadCompatibleMovToMp4Rewrite(
  movie: Movie,
  o: StreamCopyOptions | undefined,
): boolean {
  if ((o?.container ?? 'mp4') !== 'mp4') return false;
  if (o?.trim !== undefined || o?.fragmented === true || o?.streaming === true) return false;
  if (o?.buffered !== true) return false;
  if (o?.faststart === false) return false;
  return movie.brand === 'qt  ' && movie.tracks.length > 0;
}

async function* progressiveSourceSegments(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  const fragmentSamples = await buildFragmentSampleDataMap(movie, ra);
  const tracks = lazyProgressiveTracksFromMovie(ra, movie, fragmentSamples);
  const interleaved = sourceOrderInterleavedPlan(tracks);
  if (interleaved !== undefined) {
    yield* progressiveSegmentsFromTracks(
      ra,
      interleaved.tracks,
      o,
      movie.timescale,
      interleaved.samples,
    );
    return;
  }
  yield* progressiveSegmentsFromTracks(ra, tracks, o, movie.timescale);
}

async function* trimmedProgressiveSourceSegments(
  ra: RandomAccess,
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
  o: StreamCopyOptions | undefined,
  validationCacheBase: string | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  yield* progressiveSegmentsFromTracks(
    ra,
    await lazyProgressiveTrimTracksFromMovie(
      ra,
      movie,
      trim.startSec,
      trim.endSec,
      o?.signal,
      validationCacheBase,
    ),
    o,
    movie.timescale,
  );
}

function progressiveSourceStream(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): ReadableStream<Uint8Array> {
  const segments = progressiveSourceSegments(ra, movie, o);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await segments.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(): Promise<void> {
        await segments.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

function trimmedProgressiveSourceStream(
  ra: RandomAccess,
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
  o: StreamCopyOptions | undefined,
  validationCacheBase: string | undefined,
): ReadableStream<Uint8Array> {
  const segments = trimmedProgressiveSourceSegments(ra, movie, trim, o, validationCacheBase);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await segments.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(): Promise<void> {
        await segments.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

async function materializeProgressiveSourceBytes(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): Promise<Uint8Array> {
  const fragmentSamples = await buildFragmentSampleDataMap(movie, ra);
  return materializeProgressiveTracksBytes(
    ra,
    lazyProgressiveTracksFromMovie(ra, movie, fragmentSamples),
    o,
    movie.timescale,
  );
}

async function materializeTrimmedProgressiveSourceBytes(
  ra: RandomAccess,
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
  o: StreamCopyOptions | undefined,
  validationCacheBase: string | undefined,
): Promise<Uint8Array> {
  return materializeProgressiveTracksBytes(
    ra,
    await lazyProgressiveTrimTracksFromMovie(
      ra,
      movie,
      trim.startSec,
      trim.endSec,
      o?.signal,
      validationCacheBase,
    ),
    o,
    movie.timescale,
  );
}

function progressiveSourceBufferStream(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): ReadableStream<Uint8Array> {
  let emitted = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        if (emitted) {
          controller.close();
          return;
        }
        emitted = true;
        try {
          controller.enqueue(await materializeProgressiveSourceBytes(ra, movie, o));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(): void {
        // Range reads are one-shot promises; abort is handled through StreamCopyOptions.signal.
      },
    },
    { highWaterMark: 0 },
  );
}

function trimmedProgressiveSourceBufferStream(
  ra: RandomAccess,
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
  o: StreamCopyOptions | undefined,
  validationCacheBase: string | undefined,
): ReadableStream<Uint8Array> {
  let emitted = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        if (emitted) {
          controller.close();
          return;
        }
        emitted = true;
        try {
          controller.enqueue(
            await materializeTrimmedProgressiveSourceBytes(ra, movie, trim, o, validationCacheBase),
          );
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(): void {
        // Range reads are one-shot promises; abort is handled through StreamCopyOptions.signal.
      },
    },
    { highWaterMark: 0 },
  );
}

function trimCoversMovie(movie: Movie, trim: NonNullable<StreamCopyOptions['trim']>): boolean {
  if (trim.startSec !== 0) return false;
  const trackDurationSec = movie.tracks.reduce((max, track) => Math.max(max, track.durationSec), 0);
  if (trackDurationSec <= 0) return false;
  if (trim.endSec >= trackDurationSec) return true;
  return (
    movie.durationSec > 0 &&
    trim.endSec >= movie.durationSec &&
    trackDurationSec - trim.endSec <= FULL_RANGE_EOF_SLACK_SEC
  );
}

function validateStreamCopyTrimRange(
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
): void {
  const startSec = trim.startSec;
  const endSec = trim.endSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('unsupported-input', 'bad trim');
  }
  if (startSec < 0) {
    throw new InputError('unsupported-input', 'start<0');
  }
  if (endSec <= startSec) {
    throw new InputError('unsupported-input', 'empty trim');
  }
  const durationSec = movie.tracks.reduce((max, track) => Math.max(max, track.durationSec), 0);
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError('unsupported-input', 'start>=duration');
    }
    if (endSec > durationSec + TRIM_END_RANGE_SLACK_SEC) {
      throw new InputError('unsupported-input', 'end>duration');
    }
  }
}

/**
 * Same-container MP4/MOV streaming copy, lazy on both output and sample payload reads. The init segment is
 * emitted before any mdat bytes are read; each later pull reads only that fragment's source sample windows
 * and serializes one `moof`+`mdat`.
 */
function fragmentedSourceStream(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
  fragmentSamples?: Map<number, SampleData[]>,
): ReadableStream<Uint8Array> {
  const signal = o?.signal;
  const tracks = lazyFragmentTracksFromMovie(ra, movie, fragmentSamples);
  const targetSamples =
    o?.buffered === true ? LAZY_FRAGMENT_BUFFERED_TARGET_SAMPLES : LAZY_FRAGMENT_TARGET_SAMPLES;
  const hardVideoSamples =
    o?.buffered === true
      ? LAZY_FRAGMENT_BUFFERED_HARD_VIDEO_SAMPLES
      : LAZY_FRAGMENT_HARD_VIDEO_SAMPLES;
  const plans = tracks.map((track) =>
    planLazySampleDataFragmentRuns(
      track.samples,
      targetSamples,
      track.metadata.mediaType === 'video',
      hardVideoSamples,
    ),
  );
  const cursors = new Array<number>(tracks.length).fill(0);
  const baseDts = new Array<number>(tracks.length).fill(0);
  const maxRuns = plans.reduce((max, plan) => Math.max(max, plan.length), 0);
  let emittedInit = false;
  let step = 0;
  let sequenceNumber = 1;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        if (signal?.aborted) {
          controller.error(abortedError());
          return;
        }
        if (!emittedInit) {
          controller.enqueue(
            fragmentMp4InitSegment(
              tracks.map((track) => track.metadata),
              {
                movieTimescale: movie.timescale,
              },
            ),
          );
          emittedInit = true;
          return;
        }
        while (step < maxRuns) {
          const runSpecs: Array<{
            readonly trackId: number;
            readonly samples: readonly SampleData[];
            readonly baseDecodeTime: number;
          }> = [];
          for (let ti = 0; ti < tracks.length; ti++) {
            const run = plans[ti]?.[cursors[ti] ?? 0];
            if (run === undefined || run.length === 0) continue;
            cursors[ti] = (cursors[ti] ?? 0) + 1;
            const base = baseDts[ti] ?? 0;
            runSpecs.push({
              trackId: ti + 1,
              samples: run,
              baseDecodeTime: base,
            });
            let duration = 0;
            for (const sample of run) duration += sample.durationTicks;
            baseDts[ti] = base + duration;
          }
          step++;
          if (runSpecs.length === 0) continue;
          const runs = [];
          for (const run of runSpecs) {
            throwIfAborted(signal);
            runs.push({
              trackId: run.trackId,
              samples: await readSamples(ra, run.samples),
              baseDecodeTime: run.baseDecodeTime,
            });
          }
          throwIfAborted(signal);
          controller.enqueue(buildMediaSegment(sequenceNumber, runs));
          sequenceNumber++;
          return;
        }
        controller.close();
      },
      cancel(): void {
        // The stream owns no persistent reader/decoder state; range reads are one-shot promises.
      },
    },
    { highWaterMark: 0 },
  );
}

export const Mp4Driver: ContainerDriver = {
  id: 'mp4',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['mp4', 'mov'],
  validatesStreamCopyTrim: true,
  supports: matches,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const signal = o?.signal;
    const ra = await randomAccess(src);
    throwIfAborted(signal);
    if (shouldTrySimpleVideoFaststartProbe(src, ra)) {
      const metadataTracks = await readSmallFaststartMetadataProbeTracks(src, ra);
      if (metadataTracks !== false) {
        throwIfAborted(signal);
        if (metadataTracks !== undefined) return metadataTracks;
      }
      const tracks =
        metadataTracks === false ? undefined : await readSimpleVideoFaststartProbeTracks(src, ra);
      throwIfAborted(signal);
      if (tracks !== undefined) return tracks;
    }
    if (shouldTryTinyAudioFaststartProbe(src, ra)) {
      const tracks = await readTinyAudioFaststartProbeTracks(ra);
      throwIfAborted(signal);
      if (tracks !== undefined) return tracks;
    }
    const movie = await readMovieForProbe(src, ra);
    throwIfAborted(signal);
    return toProbeTracks(movie);
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const signal = o?.signal;
    const ra = await randomAccess(src);
    throwIfAborted(signal);
    const wantsOffsets = ra.size !== undefined && ra.size <= PACKET_INFO_OFFSET_MAX_SOURCE_BYTES;
    let movie = wantsOffsets ? await readMovie(ra) : await readMoviePacketInfo(ra);
    // The large-file timeline parser intentionally omits chunk offsets. Re-read the same `moov` in
    // full mode only when AVC picture classification genuinely needs payload offsets; other large
    // codecs retain the header-only fast path.
    if (!wantsOffsets && movieNeedsAvcPictureClassification(movie)) movie = await readMovie(ra);
    await enrichAvcPictureClassification(movie, ra, signal);
    throwIfAborted(signal);
    return mp4PacketInfoTable(movie, wantsOffsets ? ra.size : undefined);
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const ra = await randomAccess(src);
    const { movie, mediaDataRanges } = await readMovieForDemux(src, ra);
    const byId = new Map(movie.tracks.map((t) => [t.id, t]));
    const signal = o?.signal;
    const supportsPacketTable = hasCompleteSampleTables(movie);
    // Fragmented/CMAF inputs carry no `moov` sample table — the timeline lives in `moof`/`traf`/`trun`.
    // Recover each track's flat sample list once so `packets()` streams real samples (without it the
    // demuxer emits nothing and decode/convert produce empty output). Progressive files skip this.
    const fragmentSamples = await buildFragmentSampleMap(movie, ra);
    // A keyed probe handoff carries the already-validated mdat map, preserving the zero-I/O handoff while
    // applying the same sample-ownership invariant as a cold demux.
    validateDemuxSampleStorage(
      movie,
      fragmentSamples,
      mediaDataRanges ?? (await readMediaDataRanges(ra)),
    );
    return {
      tracks: movie.tracks.map(toTrackInfo),
      ...(supportsPacketTable
        ? {
            packetTable: () => mp4PacketMetadata(movie, ra.size),
            packetInfoTable: () => mp4PacketInfoMetadata(movie, ra.size),
          }
        : {}),
      packets(trackId: number): ReadableStream<Packet> {
        const track = byId.get(trackId);
        if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(ra, track, signal, fragmentSamples?.get(trackId));
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src, {
      ...(o?.trim !== undefined
        ? { eagerReadMaxBytes: SMALL_URL_TRIM_RANDOM_ACCESS_MAX_BYTES }
        : {}),
    });
    const movie = await readMovie(ra);
    const requestedTrim = o?.trim;
    if (requestedTrim !== undefined) validateStreamCopyTrimRange(movie, requestedTrim);
    const trim =
      requestedTrim !== undefined && !trimCoversMovie(movie, requestedTrim)
        ? requestedTrim
        : undefined;
    const validationCacheBase =
      trim !== undefined ? trimDecodeValidationCacheBase(src, ra) : undefined;
    if (shouldLoadCompatibleMovToMp4Rewrite(movie, o)) {
      const { materializeCompatibleMovToMp4Bytes } = await import('./compatible-mov-rewrite.ts');
      const compatibleBrandRewrite = await materializeCompatibleMovToMp4Bytes(src, ra, movie, o);
      if (compatibleBrandRewrite !== undefined) return oneShot(compatibleBrandRewrite);
    }
    if (o?.fragmented === true && trim === undefined) {
      return fragmentedSourceStream(ra, movie, o, await buildFragmentSampleDataMap(movie, ra));
    }
    if (o?.streaming === true && trim === undefined) {
      return progressiveSourceStream(ra, movie, o);
    }
    if (o?.buffered === true && trim === undefined) {
      return progressiveSourceBufferStream(ra, movie, o);
    }
    if (o?.streaming === true && trim !== undefined) {
      return trimmedProgressiveSourceStream(ra, movie, trim, o, validationCacheBase);
    }
    if (o?.buffered === true && trim !== undefined) {
      return trimmedProgressiveSourceBufferStream(ra, movie, trim, o, validationCacheBase);
    }
    const tracks = trim
      ? await trimMuxTracks(ra, movie, trim.startSec, trim.endSec, o?.signal, validationCacheBase)
      : await muxTracksFromMovie(ra, movie);
    // Fragmented/CMAF output (ADR-034): a sequence of self-describing `moof`+`mdat` segments after the
    // init segment, streamed one at a time so a StreamTarget never buffers the whole movie. The lossless
    // sample copy (DTS/ctts/codec-private preserved) is identical; only the on-disk box layout differs.
    if (o?.fragmented === true) return fragmentedStream(tracks, movie.timescale);
    const bytes = writeMp4(tracks, {
      faststart: o?.faststart ?? true,
      brand: brandFor(o?.container),
      movieTimescale: movie.timescale,
    });
    return oneShot(bytes);
  },
  async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src);

    // HLS AES-128: the whole MP4 segment is one AES-128-CBC (PKCS#7) ciphertext — decrypt it as a unit.
    if (o.scheme === 'hls-aes128') {
      const clear = await decryptHlsSegmentMp4(ra, o.keys);
      return oneShot(clear);
    }

    // CENC sample decryption: 'cenc' (AES-CTR), 'cens' (AES-CTR pattern), or 'cbcs' (AES-CBC pattern).
    if (o.scheme !== CENC_SCHEME && o.scheme !== CENS_SCHEME && o.scheme !== CBCS_SCHEME) {
      throw new CapabilityError(
        'capability-miss',
        `mp4 decrypt supports cenc/cens/cbcs/hls-aes128, not '${o.scheme}'`,
        { op: 'decrypt', tried: ['mp4'] },
      );
    }
    const movie = await readMovie(ra);
    const cenc = await loadCencModule();
    // Fragmented/CMAF protected files carry sample-encryption metadata in `moof`/`traf`, not the (empty)
    // `moov` sample tables — the per-track flat path below cannot see it and would reject the file with
    // "no decryptable samples". Route those through the whole-file CENC engine (ADR-182), which parses the
    // fragments directly and decrypts every scheme/layout in place. Flat `moov`-protected files keep the
    // proven per-track path (no behaviour change for the cells it already passes).
    if (
      movie.tracks.some((t) => t.encryption !== undefined && t.samples.sampleSizes.length === 0)
    ) {
      const fileBytes = await readWholeFile(ra, ra.size ?? Number.MAX_SAFE_INTEGER);
      const decrypted = await cenc.decryptCencFile(fileBytes, {
        scheme: o.scheme,
        keys: o.keys,
      });
      const clearRa: SizedRandomAccess = {
        read: (offset, length) => Promise.resolve(decrypted.subarray(offset, offset + length)),
        size: decrypted.byteLength,
      };
      const clearMovie = await readMovie(clearRa);
      const clearTracks = await muxTracksFromMovie(clearRa, clearMovie);
      // AES-CTR authenticates neither its IV nor its ciphertext. A structurally valid `senc` IV mutation
      // therefore decrypts to garbage without tripping the box parser. Progressive CENC already validates
      // every recovered AVC access unit below; fragmented CENC must cross the same browser codec boundary
      // before any output is exposed. `MuxTrackInput` retains exact duration/CTO/keyframe data but not
      // absolute DTS, so rebuild its decode-order clock by accumulating durations (the same `stts` model).
      const protectedTrackIds = new Set(
        movie.tracks.filter((track) => track.encryption !== undefined).map((track) => track.id),
      );
      for (let index = 0; index < clearMovie.tracks.length; index++) {
        const parsed = clearMovie.tracks[index];
        const track = clearTracks[index];
        if (parsed === undefined || track === undefined || !protectedTrackIds.has(parsed.id))
          continue;
        let dtsTicks = 0;
        const validationSamples: SampleData[] = track.samples.map((sample, sampleIndex) => {
          const selected: SampleData = {
            index: sampleIndex,
            offset: 0,
            size: sample.data.byteLength,
            dtsTicks,
            durationTicks: sample.durationTicks,
            cttsTicks: sample.cttsTicks,
            keyframe: sample.keyframe,
          };
          dtsTicks += sample.durationTicks;
          return selected;
        });
        await verifyTrimmedAvcDecodeIfAvailable(
          parsed,
          validationSamples,
          track.samples,
          o.signal,
          undefined,
          'fragmented CENC decrypt',
          validationSamples.length,
        );
      }
      const normalizedTracks = normalizeDecryptedFragmentTracks(clearTracks);
      if (normalizedTracks.every((track, index) => track === clearTracks[index])) {
        return oneShot(decrypted);
      }
      return oneShot(writeMp4(normalizedTracks, { faststart: true }));
    }
    const sourceSize = ra.size;
    const tracks = await muxTracksFromMovie(ra, movie); // clear-structured (mp4a), ciphertext samples
    const out: MuxTrackInput[] = [];
    for (const [i, parsed] of movie.tracks.entries()) {
      const track = tracks[i];
      if (!track) continue;
      const enc = parsed.encryption;
      if (!enc) {
        out.push(track); // genuinely unprotected track passes through unchanged
        continue;
      }
      // The track IS CENC-protected (enca/encv + tenc), so it must go through the scheme-specific decrypt
      // decision. That path rejects undecryptable protected input (empty sample table / scheme mismatch /
      // missing required aux data) and only strips protection metadata without AES when the file has no
      // sample auxiliary encryption data (Bento4 mp4decrypt leaves those bytes unchanged too).
      const clearTrack = await decryptCencTrack(
        cenc,
        parsed,
        track,
        enc,
        o.keys,
        o.scheme,
        sourceSize,
      );
      // AES-CTR is intentionally unauthenticated: structurally valid ciphertext corruption is only
      // observable after decrypt at the codec seam. In browsers, validate every recovered AVC access unit
      // with the same bounded/backpressured decoder path used by MP4 trim; any decode error rejects before
      // clear output is emitted. Node/unsupported decoders retain the bit-exact crypto-only path.
      const sampleData = buildSampleData(parsed);
      await verifyTrimmedAvcDecodeIfAvailable(
        parsed,
        sampleData,
        clearTrack.samples,
        o.signal,
        undefined,
        'CENC decrypt',
        sampleData.length,
      );
      out.push(clearTrack);
    }
    return oneShot(writeMp4(out, { faststart: true }));
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over writeMp4 ({@link Mp4Muxer}): its packet→sample timing
    // (DTS/ctts, B-frames) is pure + Node-validated; only the per-chunk `copyTo` is browser-only.
    return new Mp4Muxer(o);
  },
};

/** The MP4 driver module (registered via `media.use(...)` or the first-party defaults). */
export const Mp4Module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(Mp4Driver);
  },
};

export default Mp4Module;
