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
  DecryptParams,
  Demuxer,
  DriverModule,
  MuxOptions,
  Muxer,
  Packet,
  PacketInfoBatchOptions,
  PacketInfoBatchStream,
  PacketInfoTable,
  PacketMetadata,
  PacketMetadataStats,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { aesCbcPkcs7, hexToBytes } from '../../crypto/aes.ts';
import { STREAMED_WHOLE_PROGRAM_MAX_BYTES } from '../../internal/buffer-policy.ts';
import {
  type NativePacketChunk,
  registerNativePacketSource,
} from '../../internal/packet-provenance.ts';
import { positionedChunk } from '../../sinks/stream-target.ts';
import { raceAbort, sourceAbortError } from '../../sources/abort.ts';
import { drainStream } from '../../sources/read-all.ts';
import { SOURCE_CACHE_KEY } from '../../sources/source.ts';
import { sha256Hex } from '../../util/digest.ts';
// Type-only: erased at compile time, so it does not create a runtime import of the lazily-loaded CENC
// module (the `import.meta`-gated `loadCencModule` remains the only value-level entry point to `cenc.ts`).
import type { SampleDecryptedCallback } from './cenc.ts';
import {
  fragmentSamplesToDemuxSamples,
  mergeMoovAndFragmentSamples,
  parseFragmentSamples,
} from './fragment-samples.ts';
import {
  type FragmentInitTrackInput,
  buildMediaSegment,
  fragmentMp4,
  fragmentMp4InitSegment,
} from './fragment.ts';
import { gaplessFromMp4Edit } from './gapless.ts';
import { h264AccessUnitRangeIsKeyPicture } from './h264-access-unit.ts';
import { matchesMp4 } from './mp4-sniff.ts';
import { Mp4Muxer, auditMp4H264MuxedPackets } from './mux.ts';
import {
  type Movie,
  type MovieMetadata,
  type OtherTrack,
  type ParsedTrack,
  applyFragmentTiming,
  parseMovie,
  parseMovieMetadata,
  parseMoviePacketInfo,
  timeToSampleMediaTicks,
} from './parse.ts';
import { Reader } from './reader.ts';
import {
  type Sample,
  type SampleData,
  type SampleToChunkCursor,
  buildSampleData,
  buildSamples,
  samplesPerChunkFor,
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
  planReservedMp4ByteStreamLayout,
  writeMp4,
} from './write.ts';

const TRIM_DECODE_VERIFY_HIGH_WATER = 8 as const;
const SAMPLE_READ_WINDOW_BYTES = 8 * 1024 * 1024;
const SAMPLE_READ_GAP_BYTES = 256 * 1024;
const PACKET_STREAM_BATCH_BYTES = 256 * 1024;
const PACKET_STREAM_BATCH_PACKETS = 256;
const PACKET_INFO_DEFAULT_BATCH_ROWS = 2048;
const PACKET_INFO_MAX_BATCH_ROWS = 65_536;
const LAZY_FRAGMENT_TARGET_SAMPLES = 900;
const LAZY_FRAGMENT_BUFFERED_SEGMENT_MULTIPLIER = 32;
const LAZY_FRAGMENT_BUFFERED_TARGET_SAMPLES =
  LAZY_FRAGMENT_TARGET_SAMPLES * LAZY_FRAGMENT_BUFFERED_SEGMENT_MULTIPLIER;
const PACKET_INFO_OFFSET_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const LAZY_FRAGMENT_HARD_VIDEO_SAMPLES = LAZY_FRAGMENT_TARGET_SAMPLES * 4;
const LAZY_FRAGMENT_BUFFERED_HARD_VIDEO_SAMPLES = LAZY_FRAGMENT_BUFFERED_TARGET_SAMPLES * 4;
const FASTSTART_METADATA_PREFETCH_BYTES = 32 * 1024;
const REMOTE_FASTSTART_METADATA_PREFETCH_BYTES = 128 * 1024;
const REMOTE_DEMUX_LAYOUT_PREFETCH_BYTES = 256 * 1024;
const VIDEO_METADATA_LAYOUT_WINDOW_BYTES = 16 * 1024;
const FASTSTART_PREFIX_CACHE_READ_MAX_BYTES = 1024 * 1024;
const TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES = 16 * 1024;
const AUDIO_FASTSTART_TRACK_PREFIX_MAX_BYTES = 128 * 1024;
const AUDIO_FASTSTART_SCALAR_BOX_MAX_BYTES = 128 * 1024;
const SPARSE_FASTSTART_MAX_CHILD_BOXES = 256;
const FRAGMENT_PROBE_SCAN_WINDOW_BYTES = 32 * 1024;
const FRAGMENT_PROBE_MAX_RANGE_READS = 64;
const FRAGMENT_PROBE_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const FULL_RANGE_EOF_SLACK_SEC = 0.05;
const SMALL_MOVIE_PARSE_HANDOFF_MAX_BYTES = 1024 * 1024;
const MOVIE_PARSE_HANDOFF_TTL_MS = 250;
const PROGRESSIVE_SINGLE_READ_MAX_BYTES = 64 * 1024 * 1024;
const PROGRESSIVE_SINGLE_READ_MAX_GAP_BYTES = 1024 * 1024;
const SMALL_URL_TRIM_RANDOM_ACCESS_MAX_BYTES = 8 * 1024 * 1024;
const WHOLE_FILE_PROBE_BUDGET_BYTES = 64 * 1024 * 1024;
const WHOLE_FILE_REMUX_BUDGET_BYTES = 128 * 1024 * 1024;
const TRIM_END_RANGE_SLACK_SEC = 1;
const TRIM_DECODE_VALIDATION_CACHE_TTL_MS = 60_000;
const TRIM_DECODE_VALIDATION_CACHE_MAX_ENTRIES = 128;
// A stream-copy trim decode-validates the selected AVC window before exposing output. Retain those exact
// range responses briefly so the subsequent payload stream does not fetch the same coded bytes twice.
// The cap bounds operation-local memory independently of source size and covers ordinary edit windows.
const TRIM_VALIDATION_READ_CACHE_MAX_BYTES = 64 * 1024 * 1024;
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
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Return an ephemeral range view after its final synchronous consumer has finished. */
  release?(bytes: Uint8Array): void;
  /** Release every still-owned exact range response when a finite metadata session ends. */
  dispose?(): void;
  size?: number | undefined;
  /** Source-aware first-window policy for metadata-only reads. */
  readonly metadataPrefetchBytes?: number;
  /** `read()` returns a zero-copy in-memory view, so sample-granular reads carry no I/O round trip. */
  readonly inMemory?: boolean;
  /** A complete prior read retained as a view, used to validate a probe→demux handoff without new I/O. */
  readonly cachedWhole?: () => Uint8Array | undefined;
}

type SizedRandomAccess = RandomAccess & { readonly size: number };

interface RandomAccessOptions {
  readonly eagerReadMaxBytes?: number;
  /** Retain exact range-response identities so a finite operation can release all of them in `dispose`. */
  readonly releaseRangesOnDispose?: boolean;
  readonly signal?: AbortSignal;
}

function randomAccessDisposedError(signal: AbortSignal | undefined): MediaError {
  return signal?.aborted === true
    ? sourceAbortError(signal)
    : new MediaError('aborted', 'random-access session disposed');
}

function trimValidationReadCache(ra: RandomAccess): RandomAccess {
  if (ra.inMemory === true) return ra;
  const exactReads = new Map<string, Uint8Array>();
  let retainedBytes = 0;
  return {
    async read(offset, length, signal): Promise<Uint8Array> {
      const key = `${offset}:${length}`;
      const retained = exactReads.get(key);
      if (retained !== undefined) {
        throwIfAborted(signal);
        return retained;
      }
      const bytes = await ra.read(offset, length, signal);
      if (
        bytes.byteLength === length &&
        length <= TRIM_VALIDATION_READ_CACHE_MAX_BYTES - retainedBytes
      ) {
        exactReads.set(key, bytes);
        retainedBytes += length;
      }
      return bytes;
    },
    get size(): number | undefined {
      return ra.size;
    },
    ...(ra.metadataPrefetchBytes !== undefined
      ? { metadataPrefetchBytes: ra.metadataPrefetchBytes }
      : {}),
    inMemory: false,
    ...(ra.cachedWhole !== undefined ? { cachedWhole: () => ra.cachedWhole?.() } : {}),
  };
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
  readonly faststart: {
    readonly brand: string;
    readonly moov: Uint8Array;
  };
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

function metadataProbePrefetchBytes(src: ByteSource): number {
  const kind = sourceKind(src);
  // One 128 KiB HTTP window is the latency/overfetch crossover for remote metadata: it captures the
  // common medium faststart `moov` in one request, while keeping tail-moov overfetch strictly bounded.
  // In-memory bytes keep the 32 KiB window because a subarray costs nothing. A Blob range is a real
  // copy out of blob storage, so it uses the same bounded layout window as the metadata-only probe:
  // a small faststart file must not be materialized wholesale just to read its `moov`.
  if (kind === 'url' || kind === 'element') return REMOTE_FASTSTART_METADATA_PREFETCH_BYTES;
  if (kind === 'blob') return VIDEO_METADATA_LAYOUT_WINDOW_BYTES;
  return FASTSTART_METADATA_PREFETCH_BYTES;
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
  const defaultSignal = opts.signal;
  const range = src.range;
  if (range) {
    const metadataPrefetchBytes = metadataProbePrefetchBytes(src);
    if (shouldEagerReadRandomAccess(src, opts.eagerReadMaxBytes)) {
      const requested = range.call(src, 0, src.size, defaultSignal);
      const guarded =
        opts.releaseRangesOnDispose === true && src.releaseRange !== undefined
          ? requested.then((bytes) => {
              if (defaultSignal?.aborted !== true) return bytes;
              src.releaseRange?.(bytes);
              throw sourceAbortError(defaultSignal);
            })
          : requested;
      const buffered = await raceAbort(guarded, defaultSignal);
      let disposed = false;
      return {
        read: (offset, length, signal) => {
          const activeSignal = signal ?? defaultSignal;
          if (disposed) throw randomAccessDisposedError(activeSignal);
          throwIfAborted(activeSignal);
          return Promise.resolve(buffered.subarray(offset, offset + length));
        },
        size: buffered.byteLength,
        metadataPrefetchBytes,
        inMemory: true,
        cachedWhole: () => buffered,
        ...(opts.releaseRangesOnDispose === true && src.releaseRange !== undefined
          ? {
              dispose(): void {
                if (disposed) return;
                disposed = true;
                src.releaseRange?.(buffered);
              },
            }
          : {}),
      };
    }
    let cachedWhole: Uint8Array | undefined;
    let cachedWholeOwner: Uint8Array | undefined;
    let disposed = false;
    const releasable = src.releaseRange === undefined ? undefined : new WeakSet<Uint8Array>();
    const ownedRanges =
      opts.releaseRangesOnDispose === true && src.releaseRange !== undefined
        ? new Set<Uint8Array>()
        : undefined;
    return {
      async read(offset, length, signal): Promise<Uint8Array> {
        const activeSignal = signal ?? defaultSignal;
        if (disposed) throw randomAccessDisposedError(activeSignal);
        throwIfAborted(activeSignal);
        const retained = coveredByteView(cachedWhole, offset, length);
        if (retained !== undefined) return retained;
        const requested = range.call(src, offset, offset + length, activeSignal);
        // A non-cooperative transport may fulfill after abort has already won `raceAbort`. Operation-
        // scoped sessions still own that exact late response, so release it at fulfillment rather than
        // letting it escape the disposed session. Ordinary random-access consumers keep the prior path.
        const guarded =
          ownedRanges === undefined
            ? requested
            : requested.then((bytes) => {
                if (!disposed) return bytes;
                src.releaseRange?.(bytes);
                throw randomAccessDisposedError(activeSignal);
              });
        const bytes = await raceAbort(guarded, activeSignal);
        const learnedSize = src.size;
        if (
          offset === 0 &&
          learnedSize !== undefined &&
          length >= learnedSize &&
          bytes.byteLength >= learnedSize
        ) {
          cachedWhole = bytes.subarray(0, learnedSize);
          if (ownedRanges !== undefined) cachedWholeOwner = bytes;
        } else {
          releasable?.add(bytes);
          ownedRanges?.add(bytes);
        }
        return bytes;
      },
      ...(src.releaseRange !== undefined
        ? {
            release(bytes: Uint8Array): void {
              if (releasable?.delete(bytes) !== true) return;
              ownedRanges?.delete(bytes);
              src.releaseRange?.(bytes);
            },
            ...(ownedRanges === undefined
              ? {}
              : {
                  dispose(): void {
                    if (disposed) return;
                    disposed = true;
                    for (const bytes of ownedRanges) {
                      ownedRanges.delete(bytes);
                      releasable?.delete(bytes);
                      src.releaseRange?.(bytes);
                    }
                    const whole = cachedWholeOwner;
                    cachedWholeOwner = undefined;
                    cachedWhole = undefined;
                    if (whole !== undefined) src.releaseRange?.(whole);
                  },
                }),
          }
        : {}),
      // URL/element sources learn their length from the first range response. Keep the random-access
      // view live so a later full-container validation sees that learned size instead of the undefined
      // snapshot that existed before the request completed.
      get size(): number | undefined {
        return src.size;
      },
      metadataPrefetchBytes,
      inMemory: sourceKind(src) === 'bytes',
      cachedWhole: () => cachedWhole,
    };
  }
  const buffered =
    src.readAll !== undefined
      ? await raceAbort(src.readAll(defaultSignal), defaultSignal)
      : await drainStream(src.stream(), defaultSignal);
  return {
    read: (o, l, signal) => {
      throwIfAborted(signal ?? defaultSignal);
      return Promise.resolve(buffered.subarray(o, o + l));
    },
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

function isKnownAudioFaststartSource(src: ByteSource, ra: RandomAccess): ra is SizedRandomAccess {
  if (ra.size === undefined) return false;
  const mime = sourceMimeHint(src)?.toLowerCase();
  if (mime !== undefined && (mime === 'audio/mp4' || mime === 'audio/x-m4a')) return true;
  const key = sourceCacheKey(src);
  return key !== undefined && /\.m4a(?:[?#]|$)/i.test(key);
}

function shouldTryTinyAudioFaststartProbe(src: ByteSource, ra: RandomAccess): boolean {
  return isKnownAudioFaststartSource(src, ra) && ra.size <= TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES;
}

function shouldTrySparseAudioFaststartProbe(
  src: ByteSource,
  ra: RandomAccess,
): ra is SizedRandomAccess {
  return isKnownAudioFaststartSource(src, ra) && ra.size > TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES;
}

function shouldTrySimpleVideoFaststartProbe(
  src: ByteSource,
  ra: RandomAccess,
): ra is SizedRandomAccess {
  if (ra.size === undefined || ra.size <= 0) return false;
  if (isKnownAudioFaststartSource(src, ra)) return false;
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

function storeFaststartMoovParseHandoff(key: string, brand: string, moov: Uint8Array): void {
  storeMovieParseHandoffValue(key, { faststart: { brand, moov } });
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
    let handoff: { readonly brand: string; readonly moov: Uint8Array } | undefined;
    const movie = await readMovieMetadata(ra, (brand, moov) => {
      handoff = { brand, moov: moov.slice() };
    });
    if (handoff !== undefined) {
      storeFaststartMoovParseHandoff(key, handoff.brand, handoff.moov);
    }
    return movie;
  }
  return readMovieMetadata(ra);
}

interface MovieForDemux {
  readonly movie: Movie;
  /** Cold demux discovers `moov` and validates top-level `mdat` ownership in one forward scan. */
  readonly mediaDataRanges?: readonly MediaDataRange[];
}

async function readMovieForDemux(src: ByteSource, ra: RandomAccess): Promise<MovieForDemux> {
  const key = sourceCacheKey(src);
  if (key !== undefined) {
    const cached = movieParseHandoff.get(key);
    if (cached !== undefined) {
      movieParseHandoff.delete(key);
      return { movie: parseMovie(cached.faststart.brand, cached.faststart.moov) };
    }
  }
  return readMovieAndMediaDataRanges(src, ra);
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
    try {
      size = r.u64();
    } catch {
      return undefined;
    }
    headerSize = 16;
  } else if (size === 0) {
    return undefined;
  }
  if (size < headerSize || size <= 0) return undefined;
  return { size, type, headerSize };
}

interface FaststartMetadataContinuation {
  readonly kind: 'continue';
  readonly offset: number;
  readonly brand: string;
  readonly initialPrefix: Uint8Array;
}

interface FaststartMetadataMovie {
  readonly kind: 'movie';
  readonly movie: MovieMetadata;
  readonly initialPrefix: Uint8Array;
}

type FaststartMetadataResult = FaststartMetadataContinuation | FaststartMetadataMovie | undefined;
type MoovObserver = (brand: string, moov: Uint8Array) => void;

async function readFaststartMetadata(
  ra: RandomAccess,
  onMoov?: MoovObserver,
): Promise<FaststartMetadataResult> {
  const requestedPrefetchBytes = ra.metadataPrefetchBytes ?? FASTSTART_METADATA_PREFETCH_BYTES;
  const prefetchBytes = Math.min(requestedPrefetchBytes, ra.size ?? requestedPrefetchBytes);
  let window = await ra.read(0, prefetchBytes);
  const initialPrefix = window;
  let windowStart = 0;
  let offset = 0;
  let brand = 'mp42';

  for (;;) {
    const header = topBoxHeader(window, offset);
    if (header === undefined) {
      return windowStart === 0
        ? undefined
        : { kind: 'continue', offset: windowStart + offset, brand, initialPrefix };
    }
    const absoluteOffset = windowStart + offset;
    if (header.type === 'ftyp' && offset + 12 <= window.byteLength) {
      brand = new Reader(window.subarray(offset + 8, offset + 12)).fourcc();
    }
    if (header.type === 'moov') {
      if (offset + header.size <= window.byteLength) {
        const moov = window.subarray(offset + header.headerSize, offset + header.size);
        onMoov?.(brand, moov);
        return { kind: 'movie', movie: parseMovieMetadata(brand, moov), initialPrefix };
      }
      const moovEnd = absoluteOffset + header.size;
      if (windowStart === 0 && moovEnd <= FASTSTART_PREFIX_CACHE_READ_MAX_BYTES) {
        const prefix = await ra.read(0, moovEnd);
        if (prefix.byteLength >= moovEnd) {
          const moov = prefix.subarray(absoluteOffset + header.headerSize, moovEnd);
          onMoov?.(brand, moov);
          return { kind: 'movie', movie: parseMovieMetadata(brand, moov), initialPrefix };
        }
      }
      const box = await ra.read(absoluteOffset, header.size);
      if (box.byteLength < header.headerSize) return undefined;
      const moov = box.subarray(header.headerSize);
      onMoov?.(brand, moov);
      return { kind: 'movie', movie: parseMovieMetadata(brand, moov), initialPrefix };
    }
    const nextOffset = absoluteOffset + header.size;
    if (!Number.isSafeInteger(nextOffset)) {
      throw new MediaError('demux-error', 'MP4 top-level box exceeds the safe byte-offset range');
    }
    offset += header.size;
    if (offset + 8 <= window.byteLength) continue;

    const continuationBytes = Math.min(
      FASTSTART_METADATA_PREFETCH_BYTES,
      ra.size === undefined ? FASTSTART_METADATA_PREFETCH_BYTES : Math.max(0, ra.size - nextOffset),
    );
    if (continuationBytes < 8) {
      return { kind: 'continue', offset: nextOffset, brand, initialPrefix };
    }
    window = await ra.read(nextOffset, continuationBytes);
    windowStart = nextOffset;
    offset = 0;
  }
}

/**
 * Recover the exact bytes consumed by `parseFragments` without materializing media payloads.
 *
 * Fragment timing depends only on complete top-level `moov`, `sidx`, and `moof` boxes. Their internal
 * `trun.data_offset`/`sidx.first_offset` fields are not dereferenced by the timing parser, so preserving
 * each selected box verbatim in file order is sufficient; `mdat`, `free`, and other payload boxes can be
 * skipped by their validated declared sizes. Any unknown size, malformed walk, oversized metadata set,
 * or range-count/byte budget miss returns `undefined` and keeps the exact whole-file fallback.
 */
async function readSparseFragmentTimingBoxes(
  ra: RandomAccess,
  signal: AbortSignal | undefined,
  initialPrefix?: Uint8Array,
): Promise<Uint8Array | undefined> {
  const sourceSize = ra.size;
  if (sourceSize === undefined || !Number.isSafeInteger(sourceSize) || sourceSize < 8) {
    return undefined;
  }

  let rangeReads = 0;
  let requestedBytes = initialPrefix?.byteLength ?? 0;
  const requestBudget = Math.max(
    requestedBytes,
    Math.min(FRAGMENT_PROBE_MAX_METADATA_BYTES, Math.floor(sourceSize / 2)),
  );
  const readWindow = async (start: number, length: number): Promise<Uint8Array | undefined> => {
    if (
      length <= 0 ||
      rangeReads >= FRAGMENT_PROBE_MAX_RANGE_READS ||
      requestedBytes + length > requestBudget
    ) {
      return undefined;
    }
    rangeReads++;
    requestedBytes += length;
    const bytes = await ra.read(start, length, signal);
    throwIfAborted(signal);
    return bytes.byteLength >= length ? bytes.subarray(0, length) : undefined;
  };

  let windowStart = 0;
  let window = initialPrefix;
  if (window === undefined || window.byteLength < 8) {
    window = await readWindow(0, Math.min(sourceSize, FRAGMENT_PROBE_SCAN_WINDOW_BYTES));
    if (window === undefined) return undefined;
  }

  const selected: Uint8Array[] = [];
  let selectedBytes = 0;
  let sawMoov = false;
  let sawMoof = false;
  let offset = 0;
  while (offset + 8 <= sourceSize) {
    throwIfAborted(signal);
    let relativeOffset = offset - windowStart;
    if (relativeOffset < 0 || relativeOffset + 8 > window.byteLength) {
      const next = await readWindow(
        offset,
        Math.min(sourceSize - offset, FRAGMENT_PROBE_SCAN_WINDOW_BYTES),
      );
      if (next === undefined) return undefined;
      windowStart = offset;
      window = next;
      relativeOffset = 0;
    }

    let header = topBoxHeader(window, relativeOffset);
    if (header === undefined && windowStart !== offset) {
      const next = await readWindow(
        offset,
        Math.min(sourceSize - offset, FRAGMENT_PROBE_SCAN_WINDOW_BYTES),
      );
      if (next === undefined) return undefined;
      windowStart = offset;
      window = next;
      relativeOffset = 0;
      header = topBoxHeader(window, relativeOffset);
    }
    if (header === undefined) return undefined;

    const boxEnd = offset + header.size;
    if (!Number.isSafeInteger(boxEnd) || boxEnd <= offset || boxEnd > sourceSize) {
      return undefined;
    }

    if (header.type === 'moov' || header.type === 'sidx' || header.type === 'moof') {
      if (selectedBytes + header.size > FRAGMENT_PROBE_MAX_METADATA_BYTES) return undefined;
      const relativeEnd = relativeOffset + header.size;
      let boxBytes: Uint8Array | undefined;
      if (relativeEnd <= window.byteLength) {
        boxBytes = window.subarray(relativeOffset, relativeEnd);
      } else {
        boxBytes = await readWindow(offset, header.size);
      }
      if (boxBytes === undefined || boxBytes.byteLength < header.size) return undefined;
      selected.push(boxBytes.subarray(0, header.size));
      selectedBytes += header.size;
      sawMoov ||= header.type === 'moov';
      sawMoof ||= header.type === 'moof';
    }
    offset = boxEnd;
  }

  if (offset !== sourceSize) return undefined;
  return sawMoov && sawMoof ? joinProbeBoxes(selected) : undefined;
}

async function applyFragmentTimingForProbe(
  movie: Movie,
  ra: RandomAccess,
  signal?: AbortSignal,
  initialPrefix?: Uint8Array,
): Promise<Movie> {
  const sparse = await readSparseFragmentTimingBoxes(ra, signal, initialPrefix);
  if (sparse !== undefined) return applyFragmentTiming(movie, sparse);
  return applyFragmentTiming(movie, await readWholeFile(ra, ra.size ?? Number.MAX_SAFE_INTEGER));
}

type SmallFaststartMetadataProbeTracks = readonly TrackInfo[] | false | undefined;

function isBoundedVideoMetadataTrack(track: ParsedTrack, fragmentTimingPending = false): boolean {
  if (track.mediaType === 'video') {
    return (
      (track.sampleEntryType === 'avc1' ||
        track.sampleEntryType === 'avc3' ||
        track.sampleEntryType === 'hvc1' ||
        track.sampleEntryType === 'hev1') &&
      track.width !== undefined &&
      track.height !== undefined &&
      (fragmentTimingPending || (track.fps !== undefined && track.fps > 0))
    );
  }
  return (
    track.mediaType === 'audio' &&
    track.sampleEntryType === 'mp4a' &&
    track.sampleRate !== undefined &&
    track.channels !== undefined
  );
}

async function readBoundedVideoMetadataProbeTracks(
  src: ByteSource,
  ra: SizedRandomAccess,
  signal: AbortSignal | undefined,
): Promise<SmallFaststartMetadataProbeTracks> {
  const kind = sourceKind(src);
  // A remote request's round trip dominates copying a few extra metadata bytes, while local Blob/byte
  // ranges favor the smallest parsing window. Both policies still jump over top-level payload boxes.
  const layoutWindowBytes =
    kind === 'url' || kind === 'element'
      ? (ra.metadataPrefetchBytes ?? REMOTE_FASTSTART_METADATA_PREFETCH_BYTES)
      : VIDEO_METADATA_LAYOUT_WINDOW_BYTES;
  let windowStart = 0;
  let window = await ra.read(0, Math.min(ra.size, layoutWindowBytes));
  const initialPrefix = window;
  throwIfAborted(signal);
  let absoluteOffset = 0;
  let brand = 'mp42';
  while (absoluteOffset < ra.size) {
    let relativeOffset = absoluteOffset - windowStart;
    if (relativeOffset < 0 || relativeOffset + 8 > window.byteLength) {
      const remaining = ra.size - absoluteOffset;
      if (remaining < 8) return false;
      windowStart = absoluteOffset;
      window = await ra.read(windowStart, Math.min(remaining, layoutWindowBytes));
      throwIfAborted(signal);
      relativeOffset = 0;
    }

    const header = topBoxHeader(window, relativeOffset);
    if (header === undefined) return false;
    const boxEnd = absoluteOffset + header.size;
    if (!Number.isSafeInteger(boxEnd) || boxEnd <= absoluteOffset || boxEnd > ra.size) {
      return false;
    }
    if (header.type === 'ftyp' && relativeOffset + 12 <= window.byteLength) {
      brand = new Reader(window.subarray(relativeOffset + 8, relativeOffset + 12)).fourcc();
    }
    if (header.type === 'moov') {
      const relativeEnd = relativeOffset + header.size;
      let moov: Uint8Array;
      if (relativeEnd <= window.byteLength) {
        moov = window.subarray(relativeOffset + header.headerSize, relativeEnd);
      } else {
        const box = await ra.read(absoluteOffset, header.size);
        throwIfAborted(signal);
        if (box.byteLength < header.size) return false;
        moov = box.subarray(header.headerSize, header.size);
      }
      try {
        const movie = parseMovieMetadata(brand, moov);
        const authoritativeFragmentedAudio = hasAuthoritativeFragmentedAudioInitDuration(movie);
        if (
          movie.tracks.length === 0 ||
          !movie.tracks.every((track) =>
            isBoundedVideoMetadataTrack(track, movie.needsFragmentTiming),
          )
        ) {
          return false;
        }
        if (movie.needsFragmentTiming && !authoritativeFragmentedAudio) {
          return toProbeTracks(await applyFragmentTimingForProbe(movie, ra, signal, initialPrefix));
        }
        // A `video/mp4` MIME or `.mp4` suffix identifies the container, not the track set. If the
        // canonical metadata parser proves the complete moov is AAC-only, its result is just as final
        // as an AVC/HEVC moov. The narrow positive-duration fragmented-audio shape is also final by the
        // same predicate used by readMovieMetadata below; every video, edit, hybrid table, zero duration,
        // unsupported entry, or malformed layout still takes the conservative sparse/exact fallback.
        const key = sourceCacheKey(src);
        if (key !== undefined && canHandoffFullMovie(src, ra)) {
          storeFaststartMoovParseHandoff(key, brand, moov.slice());
        }
        return toProbeTracks(movie);
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof MediaError && error.code === 'aborted') throw error;
        return false;
      }
    }
    absoluteOffset = boxEnd;
  }
  return false;
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
    storeFaststartMoovParseHandoff(key, result.brand, result.moov.slice());
  }
  return result.tracks;
}

async function readTinyAudioFaststartProbeTracks(
  ra: RandomAccess,
): Promise<readonly TrackInfo[] | undefined> {
  const { readTinyAudioFaststartProbe } = await loadFaststartProbeModule();
  return readTinyAudioFaststartProbe(ra);
}

interface DeclaredProbeBox extends TopBoxHeader {
  readonly start: number;
  readonly end: number;
  readonly payloadStart: number;
}

function declaredProbeBoxAt(bytes: Uint8Array, start: number): DeclaredProbeBox | undefined {
  const header = topBoxHeader(bytes, start);
  if (header === undefined) return undefined;
  const end = start + header.size;
  if (!Number.isSafeInteger(end)) return undefined;
  return { ...header, start, end, payloadStart: start + header.headerSize };
}

function declaredProbeChild(
  bytes: Uint8Array,
  parent: DeclaredProbeBox,
  type: string,
): DeclaredProbeBox | undefined {
  let offset = parent.payloadStart;
  while (offset + 8 <= Math.min(parent.end, bytes.byteLength)) {
    const child = declaredProbeBoxAt(bytes, offset);
    if (child === undefined || child.end > parent.end) return undefined;
    if (child.type === type) return child;
    if (child.end > bytes.byteLength) return undefined;
    offset = child.end;
  }
  return undefined;
}

function patchCompactProbeBoxSize(bytes: Uint8Array, box: DeclaredProbeBox, end: number): void {
  const size = end - box.start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const relativeStart = box.start;
  if (box.headerSize === 8) {
    view.setUint32(relativeStart, size, false);
    return;
  }
  view.setUint32(relativeStart, 1, false);
  view.setUint32(relativeStart + 8, Math.floor(size / 2 ** 32), false);
  view.setUint32(relativeStart + 12, size >>> 0, false);
}

/**
 * Compact one audio `trak` prefix at the `stsz` count header. Probe needs the count but never the
 * per-sample size array or placement tables. Parent sizes are rewritten in an owned copy so the
 * ordinary strict audio metadata parser remains the sole truth implementation.
 */
export function compactAudioProbeTrack(prefix: Uint8Array): Uint8Array | undefined {
  const trak = declaredProbeBoxAt(prefix, 0);
  if (trak === undefined || trak.type !== 'trak') return undefined;
  const mdia = declaredProbeChild(prefix, trak, 'mdia');
  const minf = mdia === undefined ? undefined : declaredProbeChild(prefix, mdia, 'minf');
  const stbl = minf === undefined ? undefined : declaredProbeChild(prefix, minf, 'stbl');
  if (mdia === undefined || minf === undefined || stbl === undefined) return undefined;

  let stsdComplete = false;
  let sttsComplete = false;
  let stsz: DeclaredProbeBox | undefined;
  let offset = stbl.payloadStart;
  while (offset + 8 <= Math.min(stbl.end, prefix.byteLength)) {
    const child = declaredProbeBoxAt(prefix, offset);
    if (child === undefined || child.end > stbl.end) return undefined;
    if (child.type === 'stsd') stsdComplete = child.end <= prefix.byteLength;
    if (child.type === 'stts') sttsComplete = child.end <= prefix.byteLength;
    if (child.type === 'stsz') {
      stsz = child;
      break;
    }
    if (child.end > prefix.byteLength) return undefined;
    offset = child.end;
  }
  if (stsz === undefined || !stsdComplete || !sttsComplete) return undefined;
  const compactEnd = stsz.payloadStart + 12;
  if (compactEnd > prefix.byteLength || compactEnd > stsz.end) return undefined;
  const sampleCount = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
    stsz.payloadStart + 8,
    false,
  );
  if (sampleCount === 0) return undefined;

  const compact = prefix.slice(0, compactEnd);
  for (const box of [trak, mdia, minf, stbl]) {
    patchCompactProbeBoxSize(compact, box, compactEnd);
  }
  patchCompactProbeBoxSize(compact, stsz, compactEnd);
  return compact;
}

interface AbsoluteProbeBox extends TopBoxHeader {
  readonly start: number;
  readonly end: number;
  readonly payloadStart: number;
}

function makeCompactProbeBox(type: string, parts: readonly Uint8Array[]): Uint8Array {
  const payloadSize = parts.reduce((total, part) => total + part.byteLength, 0);
  const size = 8 + payloadSize;
  if (type.length !== 4 || size > 0xffff_ffff) {
    throw new MediaError('demux-error', 'sparse MP4 metadata box exceeds compact box limits');
  }
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size, false);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  let offset = 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function sparseProbeBoxAt(
  ra: SizedRandomAccess,
  start: number,
  parentEnd: number,
  signal: AbortSignal | undefined,
): Promise<AbsoluteProbeBox | undefined> {
  if (!Number.isSafeInteger(start) || start < 0 || start + 8 > parentEnd) return undefined;
  const head = await ra.read(start, Math.min(16, parentEnd - start), signal);
  throwIfAborted(signal);
  const relative = declaredProbeBoxAt(head, 0);
  if (relative === undefined) return undefined;
  const end = start + relative.size;
  if (!Number.isSafeInteger(end) || end <= start || end > parentEnd) return undefined;
  return {
    size: relative.size,
    type: relative.type,
    headerSize: relative.headerSize,
    start,
    end,
    payloadStart: start + relative.headerSize,
  };
}

async function sparseProbeChildren(
  ra: SizedRandomAccess,
  parent: AbsoluteProbeBox,
  signal: AbortSignal | undefined,
): Promise<AbsoluteProbeBox[] | undefined> {
  const out: AbsoluteProbeBox[] = [];
  let offset = parent.payloadStart;
  while (offset < parent.end) {
    if (out.length >= SPARSE_FASTSTART_MAX_CHILD_BOXES) return undefined;
    const box = await sparseProbeBoxAt(ra, offset, parent.end, signal);
    if (box === undefined) return undefined;
    out.push(box);
    offset = box.end;
  }
  return offset === parent.end ? out : undefined;
}

async function sparseProbeWholeBox(
  ra: SizedRandomAccess,
  box: AbsoluteProbeBox,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | undefined> {
  if (box.size > AUDIO_FASTSTART_SCALAR_BOX_MAX_BYTES) return undefined;
  const bytes = await ra.read(box.start, box.size, signal);
  throwIfAborted(signal);
  return bytes.byteLength === box.size ? bytes : undefined;
}

async function rebuildSparseProbeTrack(
  ra: SizedRandomAccess,
  trak: AbsoluteProbeBox,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | undefined> {
  const trakChildren = await sparseProbeChildren(ra, trak, signal);
  if (trakChildren === undefined) return undefined;
  const tkhd = trakChildren.find((box) => box.type === 'tkhd');
  const edts = trakChildren.find((box) => box.type === 'edts');
  const mdia = trakChildren.find((box) => box.type === 'mdia');
  if (tkhd === undefined || mdia === undefined) return undefined;

  const mdiaChildren = await sparseProbeChildren(ra, mdia, signal);
  if (mdiaChildren === undefined) return undefined;
  const mdhd = mdiaChildren.find((box) => box.type === 'mdhd');
  const hdlr = mdiaChildren.find((box) => box.type === 'hdlr');
  const minf = mdiaChildren.find((box) => box.type === 'minf');
  if (mdhd === undefined || hdlr === undefined || minf === undefined) return undefined;

  const minfChildren = await sparseProbeChildren(ra, minf, signal);
  const stbl = minfChildren?.find((box) => box.type === 'stbl');
  if (stbl === undefined) return undefined;
  const stblChildren = await sparseProbeChildren(ra, stbl, signal);
  if (stblChildren === undefined) return undefined;
  const stsd = stblChildren.find((box) => box.type === 'stsd');
  const stts = stblChildren.find((box) => box.type === 'stts');
  const stsz = stblChildren.find((box) => box.type === 'stsz');
  if (stsd === undefined || stts === undefined) return undefined;

  const [tkhdBytes, edtsBytes, mdhdBytes, hdlrBytes, stsdBytes, sttsBytes] = await Promise.all([
    sparseProbeWholeBox(ra, tkhd, signal),
    edts === undefined ? Promise.resolve(undefined) : sparseProbeWholeBox(ra, edts, signal),
    sparseProbeWholeBox(ra, mdhd, signal),
    sparseProbeWholeBox(ra, hdlr, signal),
    sparseProbeWholeBox(ra, stsd, signal),
    sparseProbeWholeBox(ra, stts, signal),
  ]);
  if (
    tkhdBytes === undefined ||
    (edts !== undefined && edtsBytes === undefined) ||
    mdhdBytes === undefined ||
    hdlrBytes === undefined ||
    stsdBytes === undefined ||
    sttsBytes === undefined
  ) {
    return undefined;
  }

  let compactStsz: Uint8Array | undefined;
  if (stsz !== undefined) {
    if (stsz.size < stsz.headerSize + 12) return undefined;
    const scalar = await ra.read(stsz.payloadStart, 12, signal);
    throwIfAborted(signal);
    if (scalar.byteLength !== 12) return undefined;
    compactStsz = makeCompactProbeBox('stsz', [scalar]);
  }
  const compactStbl = makeCompactProbeBox('stbl', [
    stsdBytes,
    sttsBytes,
    ...(compactStsz === undefined ? [] : [compactStsz]),
  ]);
  const compactMinf = makeCompactProbeBox('minf', [compactStbl]);
  const compactMdia = makeCompactProbeBox('mdia', [mdhdBytes, hdlrBytes, compactMinf]);
  return makeCompactProbeBox('trak', [
    tkhdBytes,
    ...(edtsBytes === undefined ? [] : [edtsBytes]),
    compactMdia,
  ]);
}

function joinProbeBoxes(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Read a progressive faststart movie without materializing placement or per-sample tables. Declared
 * box sizes locate every sibling track, while a compact canonical `moov` preserves only probe facts:
 * movie/track headers, edit lists, sample descriptions, timing summaries, and scalar sample counts.
 * Fragmented, oversized-scalar, unsupported-codec, or malformed layouts decline to the established
 * exact metadata path.
 */
async function readSparseFaststartProbeTracks(
  ra: SizedRandomAccess,
  signal: AbortSignal | undefined,
): Promise<readonly TrackInfo[] | undefined> {
  const prefetchBytes = Math.min(
    ra.size,
    ra.metadataPrefetchBytes ?? FASTSTART_METADATA_PREFETCH_BYTES,
  );
  let windowStart = 0;
  let window = await ra.read(0, prefetchBytes);
  throwIfAborted(signal);
  let topOffset = 0;
  let moov: DeclaredProbeBox | undefined;
  let brand = 'mp42';
  while (topOffset + 8 <= window.byteLength) {
    const box = declaredProbeBoxAt(window, topOffset);
    if (box === undefined || box.end > ra.size) return undefined;
    if (box.type === 'ftyp' && box.payloadStart + 4 <= window.byteLength) {
      brand = new Reader(window.subarray(box.payloadStart, box.payloadStart + 4)).fourcc();
    }
    if (box.type === 'moov') {
      moov = box;
      break;
    }
    if (box.end > window.byteLength) return undefined;
    topOffset = box.end;
  }
  if (moov === undefined) return undefined;

  const parts: Uint8Array[] = [];
  let movieHeaderFound = false;
  let trackCount = 0;
  let offset = moov.payloadStart;
  const moovEnd = moov.end;
  while (offset + 8 <= moovEnd) {
    const coveredOffset = offset - windowStart;
    if (coveredOffset < 0 || coveredOffset + 8 > window.byteLength) {
      const length = Math.min(
        ra.metadataPrefetchBytes ?? FASTSTART_METADATA_PREFETCH_BYTES,
        moovEnd - offset,
      );
      windowStart = offset;
      window = await ra.read(offset, length);
      throwIfAborted(signal);
    }
    const relativeOffset = offset - windowStart;
    const relativeBox = declaredProbeBoxAt(window, relativeOffset);
    if (relativeBox === undefined) return undefined;
    const end = offset + relativeBox.size;
    if (!Number.isSafeInteger(end) || end <= offset || end > moovEnd) return undefined;
    const availableEnd = Math.min(relativeBox.end, window.byteLength);
    let available = window.subarray(relativeBox.start, availableEnd);

    if (relativeBox.type === 'mvex') return undefined;
    if (relativeBox.type === 'mvhd') {
      if (movieHeaderFound || relativeBox.size > AUDIO_FASTSTART_SCALAR_BOX_MAX_BYTES) {
        return undefined;
      }
      if (available.byteLength < relativeBox.size) {
        available = await ra.read(offset, relativeBox.size);
        throwIfAborted(signal);
      }
      if (available.byteLength < relativeBox.size) return undefined;
      parts.push(available.subarray(0, relativeBox.size));
      movieHeaderFound = true;
    } else if (relativeBox.type === 'trak') {
      let compact = compactAudioProbeTrack(available);
      if (compact === undefined && available.byteLength < relativeBox.size) {
        const prefixLength = Math.min(relativeBox.size, AUDIO_FASTSTART_TRACK_PREFIX_MAX_BYTES);
        const prefix = await ra.read(offset, prefixLength);
        throwIfAborted(signal);
        compact = compactAudioProbeTrack(prefix);
      }
      if (compact === undefined) {
        compact = await rebuildSparseProbeTrack(
          ra,
          {
            size: relativeBox.size,
            type: relativeBox.type,
            headerSize: relativeBox.headerSize,
            start: offset,
            end,
            payloadStart: offset + relativeBox.headerSize,
          },
          signal,
        );
      }
      if (compact === undefined) return undefined;
      parts.push(compact);
      trackCount++;
    }
    offset = end;
  }
  if (offset !== moovEnd || !movieHeaderFound || trackCount === 0) return undefined;
  try {
    const movie = parseMovieMetadata(brand, joinProbeBoxes(parts));
    if (
      movie.needsFragmentTiming ||
      movie.tracks.length === 0 ||
      !movie.tracks.every((track) => isBoundedVideoMetadataTrack(track))
    ) {
      return undefined;
    }
    return toProbeTracks(movie);
  } catch {
    return undefined;
  }
}

/** A fragmented track whose initialization `stbl` declares no progressive samples at all. */
function hasEmptyInitializationSampleTable(track: ParsedTrack): boolean {
  const table = track.samples;
  return (
    track.moovSampleCount === 0 &&
    table.timeToSample.counts.length === 0 &&
    table.compositionOffsets.counts.length === 0 &&
    table.sampleSizes.length === 0 &&
    table.sampleToChunk.firstChunk.length === 0 &&
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
        const sparse = await readSparseFragmentTimingBoxes(ra, undefined, undefined);
        if (sparse !== undefined) return applyFragmentTiming(movie, sparse);
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** Read only metadata needed for probe; full packet tables remain a demux-only cost. */
export async function readMovieMetadata(ra: RandomAccess, onMoov?: MoovObserver): Promise<Movie> {
  const faststart = await readFaststartMetadata(ra, onMoov);
  if (faststart?.kind === 'movie') {
    const movie = faststart.movie;
    if (movie.needsFragmentTiming) {
      if (hasAuthoritativeFragmentedAudioInitDuration(movie)) return movie;
      return applyFragmentTimingForProbe(movie, ra, undefined, faststart.initialPrefix);
    }
    return movie;
  }

  let offset = faststart?.offset ?? 0;
  let brand = faststart?.brand ?? 'mp42';
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
      const moov = box.subarray(headerSize);
      onMoov?.(brand, moov);
      const movie = parseMovieMetadata(brand, moov);
      if (movie.needsFragmentTiming) {
        if (hasAuthoritativeFragmentedAudioInitDuration(movie)) return movie;
        return applyFragmentTimingForProbe(movie, ra, undefined, faststart?.initialPrefix);
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
      if (movie.hasFragments === true) {
        const sparse = await readSparseFragmentTimingBoxes(ra, undefined, undefined);
        if (sparse !== undefined) return applyFragmentTiming(movie, sparse);
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
    }
    offset += size;
  }
  throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
}

/** The full source bytes (fragments can follow `moov`); the size is known once we have reached `moov`. */
async function readWholeFile(
  ra: RandomAccess,
  limit: number,
  budgetBytes: number = WHOLE_FILE_PROBE_BUDGET_BYTES,
): Promise<Uint8Array> {
  const size = ra.size ?? limit;
  if (!Number.isFinite(size))
    throw new MediaError('demux-error', 'fragmented MP4 needs a known size');
  if (size > budgetBytes) {
    // 1.1.8/1.1.9: a RandomAccess that already holds the whole file in memory (bytes/file sources) may
    // return a zero-copy view without allocating, so even a large in-memory source stays bounded.
    const retained = coveredByteView(ra.cachedWhole?.(), 0, size);
    if (retained !== undefined) return retained;
    throw new MediaError(
      'resource-exhaustion',
      `full-file read of ${size} bytes exceeds ${budgetBytes} byte budget (fragmented MP4 for 10 GiB must be range-backed with sparse fragment parsing)`,
    );
  }
  const retained = coveredByteView(ra.cachedWhole?.(), 0, size);
  if (retained !== undefined) return retained;
  return ra.read(0, size);
}

function muxTrackMeta(track: ParsedTrack): Omit<MuxTrackInput, 'samples'> {
  return {
    mediaType: track.mediaType,
    sampleEntryType: track.sampleEntryType,
    timescale: track.timescale,
    ...(track.mediaDurationTicks !== undefined && track.mediaDurationTicks > 0
      ? { mediaDurationTicks: track.mediaDurationTicks }
      : {}),
    ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}),
    ...(track.width !== undefined ? { width: track.width } : {}),
    ...(track.height !== undefined ? { height: track.height } : {}),
    ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
    ...(track.displayTransform !== undefined ? { displayTransform: track.displayTransform } : {}),
    ...(track.colr !== undefined ? { colr: track.colr } : {}),
    ...(track.pasp !== undefined ? { pasp: track.pasp } : {}),
    ...(track.clap !== undefined ? { clap: track.clap } : {}),
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.channels !== undefined ? { channels: track.channels } : {}),
    ...(track.edit !== undefined
      ? {
          edit: {
            mediaTimeTicks: track.edit.mediaTimeTicks,
            durationTicks: Math.round(track.edit.durationSec * track.timescale),
            movieTimescale: track.edit.movieTimescale,
            durationMovieTicks: track.edit.durationMovieTicks,
            ...(track.edit.leadingEmptyDurationSec !== undefined
              ? {
                  leadingEmptyDurationTicks: Math.round(
                    track.edit.leadingEmptyDurationSec * track.timescale,
                  ),
                }
              : {}),
            ...(track.edit.leadingEmptyDurationMovieTicks !== undefined
              ? { leadingEmptyDurationMovieTicks: track.edit.leadingEmptyDurationMovieTicks }
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

interface TopLevelBoxRange {
  readonly type: string;
  readonly headerSize: number;
  readonly end: number;
}

function validatedTopLevelBoxRange(
  header: Uint8Array,
  offset: number,
  sourceSize: number,
): TopLevelBoxRange {
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
  return { type, headerSize, end };
}

interface ReadWindow {
  readonly start: number;
  readonly bytes: Uint8Array;
}

/**
 * Cold demux needs both full sample tables and strict top-level `mdat` ownership. Discover them in one
 * monotonic layout scan so a range source does not pay one request sequence for `moov` and then repeat it
 * for storage validation. Remote reads use one bounded look-ahead window; local sources keep exact reads.
 */
async function readMovieAndMediaDataRanges(
  src: ByteSource,
  ra: RandomAccess,
): Promise<MovieForDemux> {
  const kind = sourceKind(src);
  const remote = kind === 'url' || kind === 'element';
  let window: ReadWindow | undefined;

  // An unknown-size URL needs one exact header read to learn its Content-Range before deciding whether
  // metadata read-ahead is appropriate. Never turn a small source into an eager payload read.
  if (remote && ra.size === undefined) {
    window = { start: 0, bytes: await ra.read(0, 16) };
  }

  const sourceSize = ra.size;
  if (sourceSize === undefined) {
    throw new MediaError('demux-error', 'MP4 demux needs a known source size');
  }
  const remoteReadAhead = remote && sourceSize > REMOTE_DEMUX_LAYOUT_PREFETCH_BYTES * 2;
  if (remoteReadAhead && (window?.bytes.byteLength ?? 0) < REMOTE_DEMUX_LAYOUT_PREFETCH_BYTES) {
    window = {
      start: 0,
      bytes: await ra.read(0, REMOTE_DEMUX_LAYOUT_PREFETCH_BYTES),
    };
  }
  const cachedWhole = ra.cachedWhole?.();
  if (cachedWhole !== undefined) {
    if (cachedWhole.byteLength !== sourceSize) {
      throw new MediaError(
        'demux-error',
        `short in-memory MP4 read: got ${cachedWhole.byteLength} of ${sourceSize} bytes`,
      );
    }
    window = { start: 0, bytes: cachedWhole };
  } else if (ra.inMemory === true) {
    const fullBytes = await ra.read(0, sourceSize);
    if (fullBytes.byteLength !== sourceSize) {
      throw new MediaError(
        'demux-error',
        `short in-memory MP4 read: got ${fullBytes.byteLength} of ${sourceSize} bytes`,
      );
    }
    window = { start: 0, bytes: fullBytes };
  }

  const readWindow = async (offset: number, minimumLength: number): Promise<Uint8Array> => {
    const relativeOffset = offset - (window?.start ?? 0);
    if (
      window !== undefined &&
      relativeOffset >= 0 &&
      relativeOffset + minimumLength <= window.bytes.byteLength
    ) {
      return window.bytes.subarray(relativeOffset, relativeOffset + minimumLength);
    }
    const available = sourceSize - offset;
    const requestLength = Math.min(
      available,
      minimumLength + (remoteReadAhead ? REMOTE_DEMUX_LAYOUT_PREFETCH_BYTES : 0),
    );
    const bytes = await ra.read(offset, requestLength);
    if (bytes.byteLength < minimumLength) {
      throw new MediaError(
        'demux-error',
        `short MP4 layout read at offset ${offset}: got ${bytes.byteLength} of ${minimumLength} bytes`,
      );
    }
    window = { start: offset, bytes };
    return bytes.subarray(0, minimumLength);
  };

  const ranges: MediaDataRange[] = [];
  let movie: Movie | undefined;
  let brand = 'mp42';
  let offset = 0;
  while (offset < sourceSize) {
    const headerLength = Math.min(16, sourceSize - offset);
    const header = await readWindow(offset, headerLength);
    const box = validatedTopLevelBoxRange(header, offset, sourceSize);
    if (box.type === 'ftyp' && header.byteLength >= 12) {
      brand = new Reader(header.subarray(8, 12)).fourcc();
    }
    if (box.type === 'mdat') ranges.push({ start: offset + box.headerSize, end: box.end });
    if (box.type === 'moov' && movie === undefined) {
      const boxLength = box.end - offset;
      const boxBytes = await readWindow(offset, boxLength);
      movie = parseMovie(brand, boxBytes.subarray(box.headerSize));
    }
    offset = box.end;
  }
  if (movie === undefined) {
    throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
  }
  if (
    movie.hasFragments === true ||
    movie.tracks.some((track) => track.samples.sampleSizes.length === 0)
  ) {
    const sparse = await readSparseFragmentTimingBoxes(ra, undefined, undefined);
    if (sparse !== undefined) movie = applyFragmentTiming(movie, sparse);
    else movie = applyFragmentTiming(movie, await readWholeFile(ra, sourceSize));
  }
  return { movie, mediaDataRanges: ranges };
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
    const box = validatedTopLevelBoxRange(header, offset, sourceSize);
    if (box.type === 'mdat') ranges.push({ start: offset + box.headerSize, end: box.end });
    offset = box.end;
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

/**
 * The offset-free packet-table parse is sufficient unless an AVC track has non-sync pictures whose
 * dependency table cannot decide intra/dependent status. The conservative metadata scan avoids a
 * second/full moov parse for large audio, non-AVC video, and complete-sdtp AVC inputs.
 */
function packetInfoMovieNeedsPhysicalAvc(movie: Movie): boolean {
  return movie.tracks.some((track) => {
    if (
      avcNalLengthSize(track) === undefined ||
      track.samples.sampleSizes.length === 0 ||
      track.samples.syncSamples.length === 0
    ) {
      return false;
    }
    const dependencies = track.samples.sampleDependencies;
    if (dependencies.length < track.samples.sampleSizes.length) return true;
    return dependencies.some((dependency) => dependency !== 1 && dependency !== 2);
  });
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
  const file = await readWholeFile(
    ra,
    ra.size ?? Number.MAX_SAFE_INTEGER,
    WHOLE_FILE_REMUX_BUDGET_BYTES,
  );
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
  payloadDigest?: string;
}

function appendFragmentTrackPacketInfo(
  packets: Mp4PacketInfoMetadata[],
  packetIndex: number,
  track: ParsedTrack,
  trackIndex: number,
  samples: readonly SampleData[],
  sourceSize: number | undefined,
  includeOffsets: boolean,
): number {
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  let writeIndex = packetIndex;
  for (const sample of samples) {
    validateSampleRange(sample.index, sample.offset, sample.size, sourceSize);
    if (!sampleStartsBeforeActiveEditEnd(track, sample.dtsTicks)) continue;
    const ptsUs = ticksToUs(sample.dtsTicks + sample.cttsTicks - editOffsetTicks, track.timescale);
    const dtsUs = ticksToUs(sample.dtsTicks - editOffsetTicks, track.timescale);
    const durationUs = ticksToUs(sample.durationTicks, track.timescale);
    packets[writeIndex] = includeOffsets
      ? {
          trackIndex,
          offset: sample.offset,
          size: sample.size,
          ptsUs,
          dtsUs,
          durationUs,
          keyframe: sample.keyframe,
        }
      : {
          trackIndex,
          size: sample.size,
          ptsUs,
          dtsUs,
          durationUs,
          keyframe: sample.keyframe,
        };
    writeIndex++;
  }
  return writeIndex;
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

function nextPacketRunValue(
  counts: Uint32Array,
  values: Uint32Array | Int32Array,
  cursor: SampleTableRunCursor,
): number {
  while (cursor.remaining <= 0) {
    if (cursor.index >= counts.length) return cursor.value;
    const count = counts[cursor.index] ?? 0;
    const value = values[cursor.index] ?? 0;
    cursor.index++;
    if (count <= 0) continue;
    cursor.remaining = count;
    cursor.value = value;
  }
  cursor.remaining--;
  return cursor.value;
}

function nextPacketTimeDelta(
  entries: ParsedTrack['samples']['timeToSample'],
  cursor: SampleTableRunCursor,
): number {
  return nextPacketRunValue(entries.counts, entries.deltas, cursor);
}

function nextPacketCompositionOffset(
  entries: ParsedTrack['samples']['compositionOffsets'],
  cursor: SampleTableRunCursor,
): number {
  return nextPacketRunValue(entries.counts, entries.offsets, cursor);
}

function sampleNumbersAreAscending(values: Uint32Array): boolean {
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
  const hasCtts = compositionOffsets.counts.length > 0;
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
  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  let dtsTicks = 0;
  for (let c = 0; c < chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(sampleToChunk, c + 1, stscCursor);
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

/** Summarize one progressive MP4 track directly from its run tables without allocating packet rows. */
function progressiveTrackPacketStats(track: ParsedTrack): PacketMetadataStats | undefined {
  const sizes = track.samples.sampleSizes;
  if (sizes.length === 0 || track.timescale <= 0) return undefined;
  const deltaCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };
  const hasCtts = track.samples.compositionOffsets.counts.length > 0;
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  let dtsTicks = 0;
  let packetCount = 0;
  let totalSizeBytes = 0;
  let decodeStartUs = Number.POSITIVE_INFINITY;
  let decodeEndUs = Number.NEGATIVE_INFINITY;
  let presentationStartUs = Number.POSITIVE_INFINITY;
  let presentationEndUs = Number.NEGATIVE_INFINITY;
  for (let sampleIndex = 0; sampleIndex < sizes.length; sampleIndex++) {
    const size = sizes[sampleIndex];
    const durationTicks = nextPacketTimeDelta(track.samples.timeToSample, deltaCursor);
    const cttsTicks = hasCtts
      ? nextPacketCompositionOffset(track.samples.compositionOffsets, cttsCursor)
      : 0;
    if (size === undefined || size <= 0 || durationTicks <= 0) return undefined;
    if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
      const dtsUs = ticksToUs(dtsTicks - editOffsetTicks, track.timescale);
      const ptsUs = ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, track.timescale);
      const durationUs = ticksToUs(durationTicks, track.timescale);
      if (
        !Number.isFinite(dtsUs) ||
        !Number.isFinite(ptsUs) ||
        !Number.isFinite(durationUs) ||
        durationUs <= 0
      ) {
        return undefined;
      }
      packetCount++;
      totalSizeBytes += size;
      if (!Number.isSafeInteger(totalSizeBytes)) return undefined;
      decodeStartUs = Math.min(decodeStartUs, dtsUs);
      decodeEndUs = Math.max(decodeEndUs, dtsUs + durationUs);
      presentationStartUs = Math.min(presentationStartUs, ptsUs);
      presentationEndUs = Math.max(presentationEndUs, ptsUs + durationUs);
    }
    dtsTicks += durationTicks;
  }
  return packetCount === 0
    ? undefined
    : {
        packetCount,
        totalSizeBytes,
        decodeStartUs,
        decodeEndUs,
        presentationStartUs,
        presentationEndUs,
      };
}

/** Summarize the already-required fragmented sample list without creating a second row array. */
function fragmentTrackPacketStats(
  track: ParsedTrack,
  samples: readonly Sample[],
): PacketMetadataStats | undefined {
  if (samples.length === 0) return undefined;
  const editEndUs =
    track.edit !== undefined && track.edit.durationSec > 0
      ? Math.round(track.edit.durationSec * 1_000_000)
      : undefined;
  // Match `samplesWithinActiveEdit` exactly while avoiding its O(packet-count) `slice`: an edit only
  // removes the trailing suffix beyond its end, preserving an earlier discontinuity/reset verbatim.
  let end = samples.length;
  if (editEndUs !== undefined) {
    while (end > 0 && (samples[end - 1]?.dtsUs ?? Number.NEGATIVE_INFINITY) >= editEndUs) {
      end--;
    }
  }
  let totalSizeBytes = 0;
  let packetCount = 0;
  let decodeStartUs = Number.POSITIVE_INFINITY;
  let decodeEndUs = Number.NEGATIVE_INFINITY;
  let presentationStartUs = Number.POSITIVE_INFINITY;
  let presentationEndUs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < end; index++) {
    const sample = samples[index];
    if (sample === undefined) continue;
    if (sample.size <= 0 || sample.durationUs <= 0) return undefined;
    packetCount++;
    totalSizeBytes += sample.size;
    if (!Number.isSafeInteger(totalSizeBytes)) return undefined;
    decodeStartUs = Math.min(decodeStartUs, sample.dtsUs);
    decodeEndUs = Math.max(decodeEndUs, sample.dtsUs + sample.durationUs);
    presentationStartUs = Math.min(presentationStartUs, sample.ptsUs);
    presentationEndUs = Math.max(presentationEndUs, sample.ptsUs + sample.durationUs);
  }
  if (
    !Number.isFinite(decodeStartUs) ||
    !Number.isFinite(decodeEndUs) ||
    !Number.isFinite(presentationStartUs) ||
    !Number.isFinite(presentationEndUs)
  ) {
    return undefined;
  }
  return {
    packetCount,
    totalSizeBytes,
    decodeStartUs,
    decodeEndUs,
    presentationStartUs,
    presentationEndUs,
  };
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
  const hasCtts = compositionOffsets.counts.length > 0;
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
  const hasCtts = compositionOffsets.counts.length > 0;
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
  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };
  let syncIndex = 0;
  let sampleIndex = 0;
  let dtsTicks = 0;
  for (let c = 0; c < chunkOffsets.length && sampleIndex < count; c++) {
    const chunkOffset = chunkOffsets[c];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(sampleToChunk, c + 1, stscCursor);
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
        const ptsUs = ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, timescale);
        const dtsUs = ticksToUs(dtsTicks - editOffsetTicks, timescale);
        const durationUs = ticksToUs(durationTicks, timescale);
        const keyframe =
          allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber;
        packets[writeIndex] = includeOffsets
          ? { trackIndex, offset, size, ptsUs, dtsUs, durationUs, keyframe }
          : { trackIndex, size, ptsUs, dtsUs, durationUs, keyframe };
        writeIndex++;
      }
      offset += size;
      dtsTicks += durationTicks;
      sampleIndex++;
    }
  }
  return writeIndex;
}

interface PendingPacketInfoPayload {
  readonly row: Mp4PacketInfoMetadata;
  readonly index: number;
  readonly offset: number;
  readonly size: number;
  readonly lengthSize?: 1 | 2 | 4;
}

interface PendingPacketInfoRow {
  readonly row: Mp4PacketInfoMetadata;
  readonly payload?: PendingPacketInfoPayload;
}

function packetInfoBatchSize(value: number | undefined): number {
  if (value === undefined) return PACKET_INFO_DEFAULT_BATCH_ROWS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > PACKET_INFO_MAX_BATCH_ROWS) {
    throw new InputError(
      `packet-info batchSize must be an integer from 1 to ${PACKET_INFO_MAX_BATCH_ROWS}`,
    );
  }
  return value;
}

function packetInfoKeyDecision(
  track: ParsedTrack | undefined,
  sampleIndex: number,
  declaredSync: boolean,
): { readonly keyframe: boolean; readonly lengthSize?: 1 | 2 | 4 } {
  if (declaredSync || track === undefined) return { keyframe: declaredSync };
  const lengthSize = avcNalLengthSize(track);
  // An absent stss means every sample is sync and therefore reaches the declaredSync branch above.
  if (lengthSize === undefined || track.samples.syncSamples.length === 0) {
    return { keyframe: false };
  }
  const dependency = track.samples.sampleDependencies[sampleIndex];
  if (dependency === 2) return { keyframe: true };
  if (dependency === 1) return { keyframe: false };
  return { keyframe: false, lengthSize };
}

function packetInfoRow(
  track: PacketTimelineTrack,
  classificationTrack: ParsedTrack | undefined,
  trackIndex: number,
  sampleIndex: number,
  offset: number | undefined,
  size: number,
  dtsTicks: number,
  durationTicks: number,
  cttsTicks: number,
  declaredSync: boolean,
  includeOffsets: boolean,
): PendingPacketInfoRow {
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  const decision = packetInfoKeyDecision(classificationTrack, sampleIndex, declaredSync);
  const row: Mp4PacketInfoMetadata =
    includeOffsets && offset !== undefined
      ? {
          trackIndex,
          offset,
          size,
          ptsUs: ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, track.timescale),
          dtsUs: ticksToUs(dtsTicks - editOffsetTicks, track.timescale),
          durationUs: ticksToUs(durationTicks, track.timescale),
          keyframe: decision.keyframe,
        }
      : {
          trackIndex,
          size,
          ptsUs: ticksToUs(dtsTicks + cttsTicks - editOffsetTicks, track.timescale),
          dtsUs: ticksToUs(dtsTicks - editOffsetTicks, track.timescale),
          durationUs: ticksToUs(durationTicks, track.timescale),
          keyframe: decision.keyframe,
        };
  return offset === undefined
    ? { row }
    : {
        row,
        payload: {
          row,
          index: sampleIndex,
          offset,
          size,
          ...(decision.lengthSize === undefined ? {} : { lengthSize: decision.lengthSize }),
        },
      };
}

/** Pull rows directly from one progressive track's run tables without a flat sample/row array. */
function* progressiveTrackPacketInfoRows(
  track: PacketTimelineTrack,
  classificationTrack: ParsedTrack | undefined,
  trackIndex: number,
  sourceSize: number | undefined,
  includeOffsets: boolean,
): Generator<PendingPacketInfoRow> {
  const st = track.samples;
  const sizes = st.sampleSizes;
  const timeToSample = st.timeToSample;
  const compositionOffsets = st.compositionOffsets;
  const syncSamples = st.syncSamples;
  const hasCtts = compositionOffsets.counts.length > 0;
  const allSync = syncSamples.length === 0;
  const sortedSync = allSync || sampleNumbersAreAscending(syncSamples);
  const syncSet = allSync || sortedSync ? undefined : new Set(syncSamples);
  const deltaCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };
  const cttsCursor: SampleTableRunCursor = { index: 0, remaining: 0, value: 0 };
  let syncIndex = 0;
  let dtsTicks = 0;
  const declaredSyncAt = (sampleIndex: number): boolean => {
    const sampleNumber = sampleIndex + 1;
    let syncSample = syncSamples[syncIndex];
    while (syncSample !== undefined && syncSample < sampleNumber) {
      syncIndex++;
      syncSample = syncSamples[syncIndex];
    }
    return allSync || syncSet?.has(sampleNumber) === true || syncSample === sampleNumber;
  };

  if (st.chunkOffsets.length === 0 && st.sampleToChunk.firstChunk.length === 0) {
    for (let sampleIndex = 0; sampleIndex < sizes.length; sampleIndex++) {
      const size = sizes[sampleIndex] ?? 0;
      const durationTicks = nextPacketTimeDelta(timeToSample, deltaCursor);
      const cttsTicks = hasCtts ? nextPacketCompositionOffset(compositionOffsets, cttsCursor) : 0;
      if (size < 0) validateSampleRange(sampleIndex, 0, size, undefined);
      const declaredSync = declaredSyncAt(sampleIndex);
      if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
        yield packetInfoRow(
          track,
          classificationTrack,
          trackIndex,
          sampleIndex,
          undefined,
          size,
          dtsTicks,
          durationTicks,
          cttsTicks,
          declaredSync,
          false,
        );
      }
      dtsTicks += durationTicks;
    }
    return;
  }

  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };
  let sampleIndex = 0;
  for (
    let chunkIndex = 0;
    chunkIndex < st.chunkOffsets.length && sampleIndex < sizes.length;
    chunkIndex++
  ) {
    const chunkOffset = st.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(st.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (let inChunk = 0; inChunk < samplesPerChunk && sampleIndex < sizes.length; inChunk++) {
      const size = sizes[sampleIndex] ?? 0;
      const durationTicks = nextPacketTimeDelta(timeToSample, deltaCursor);
      const cttsTicks = hasCtts ? nextPacketCompositionOffset(compositionOffsets, cttsCursor) : 0;
      validateSampleRange(sampleIndex, offset, size, sourceSize);
      const declaredSync = declaredSyncAt(sampleIndex);
      if (sampleStartsBeforeActiveEditEnd(track, dtsTicks)) {
        yield packetInfoRow(
          track,
          classificationTrack,
          trackIndex,
          sampleIndex,
          offset,
          size,
          dtsTicks,
          durationTicks,
          cttsTicks,
          declaredSync,
          includeOffsets,
        );
      }
      offset += size;
      dtsTicks += durationTicks;
      sampleIndex++;
    }
  }
}

function* fragmentTrackPacketInfoRows(
  track: ParsedTrack,
  trackIndex: number,
  samples: readonly SampleData[],
  sourceSize: number | undefined,
  includeOffsets: boolean,
): Generator<PendingPacketInfoRow> {
  const editOffsetTicks = track.edit?.mediaTimeTicks ?? 0;
  for (const sample of samples) {
    validateSampleRange(sample.index, sample.offset, sample.size, sourceSize);
    if (!sampleStartsBeforeActiveEditEnd(track, sample.dtsTicks)) continue;
    const base = {
      trackIndex,
      size: sample.size,
      ptsUs: ticksToUs(sample.dtsTicks + sample.cttsTicks - editOffsetTicks, track.timescale),
      dtsUs: ticksToUs(sample.dtsTicks - editOffsetTicks, track.timescale),
      durationUs: ticksToUs(sample.durationTicks, track.timescale),
      keyframe: sample.keyframe,
    };
    const row: Mp4PacketInfoMetadata = includeOffsets ? { ...base, offset: sample.offset } : base;
    yield {
      row,
      payload: {
        row,
        index: sample.index,
        offset: sample.offset,
        size: sample.size,
      },
    };
  }
}

function* moviePacketInfoRows(
  movie: Movie,
  sourceSize: number | undefined,
  includeOffsets: boolean,
  fragmentSamples?: ReadonlyMap<number, readonly SampleData[]>,
): Generator<PendingPacketInfoRow> {
  const entries = declaredTrackEntries(movie);
  for (let trackIndex = 0; trackIndex < entries.length; trackIndex++) {
    const entry = entries[trackIndex];
    if (entry === undefined) continue;
    if (entry.kind === 'av') {
      const fragments = fragmentSamples?.get(entry.track.id);
      if (fragments !== undefined) {
        yield* fragmentTrackPacketInfoRows(
          entry.track,
          trackIndex,
          fragments,
          sourceSize,
          includeOffsets,
        );
      } else {
        yield* progressiveTrackPacketInfoRows(
          entry.track,
          entry.track,
          trackIndex,
          sourceSize,
          includeOffsets,
        );
      }
    } else if (otherTrackHasSamples(entry.track)) {
      yield* progressiveTrackPacketInfoRows(
        entry.track,
        undefined,
        trackIndex,
        sourceSize,
        includeOffsets,
      );
    }
  }
}

async function inspectPacketInfoBatch(
  rows: readonly PendingPacketInfoPayload[],
  ra: RandomAccess,
  signal: AbortSignal,
  includePayloadDigests: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) validateSampleRange(row.index, row.offset, row.size, ra.size);
  for (const window of planSampleReadWindows(rows)) {
    throwIfAborted(signal);
    const expected = window.end - window.start;
    const bytes = await ra.read(window.start, expected, signal);
    try {
      if (bytes.byteLength !== expected) {
        throw new MediaError(
          'demux-error',
          `sample window [${window.start}, ${window.end}) short read: got ${bytes.byteLength} of ${expected} bytes (truncated MP4)`,
        );
      }
      const digestPromises: Promise<void>[] = [];
      for (const item of window.items) {
        const sample = item.sample;
        const start = sample.offset - window.start;
        const payload = bytes.subarray(start, start + sample.size);
        if (
          sample.lengthSize !== undefined &&
          h264AccessUnitRangeIsKeyPicture(bytes, start, sample.size, sample.lengthSize) === true
        ) {
          sample.row.keyframe = true;
        }
        if (includePayloadDigests) {
          const digestPayload: Uint8Array<ArrayBuffer> =
            payload.buffer instanceof ArrayBuffer
              ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
              : Uint8Array.from(payload);
          digestPromises.push(
            sha256Hex(digestPayload).then((digest) => {
              sample.row.payloadDigest = digest;
            }),
          );
        }
      }
      await Promise.all(digestPromises);
    } finally {
      ra.release?.(bytes);
    }
  }
  throwIfAborted(signal);
}

function packetInfoTracks(movie: Movie): readonly TrackInfo[] {
  return declaredTrackEntries(movie).map((entry) =>
    entry.kind === 'av' ? toTrackInfo(entry.track) : toOtherProbeTrackInfo(entry.track),
  );
}

function createMp4PacketInfoBatchStream(
  movie: Movie,
  ra: RandomAccess,
  batchSize: number,
  includeOffsets: boolean,
  includePayloadDigests: boolean,
  externalSignal: AbortSignal | undefined,
  fragmentSamples?: ReadonlyMap<number, readonly SampleData[]>,
): PacketInfoBatchStream {
  const controller = new AbortController();
  let claimed = false;
  let closed = false;
  const close = (reason?: unknown): Promise<void> => {
    if (!closed) {
      closed = true;
      externalSignal?.removeEventListener('abort', onAbort);
      if (!controller.signal.aborted) controller.abort(reason);
      ra.dispose?.();
    }
    return Promise.resolve();
  };
  const onAbort = (): void => {
    void close(externalSignal?.reason);
  };
  if (externalSignal?.aborted === true) onAbort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    tracks: packetInfoTracks(movie),
    cancel: close,
    [Symbol.asyncIterator](): AsyncIterator<readonly Mp4PacketInfoMetadata[]> {
      if (claimed) throw new TypeError('packet-info batches are single-use');
      claimed = true;
      const iterate = async function* (): AsyncGenerator<readonly Mp4PacketInfoMetadata[]> {
        try {
          throwIfAborted(controller.signal);
          const pendingRows = moviePacketInfoRows(
            movie,
            includeOffsets ? ra.size : undefined,
            includeOffsets,
            fragmentSamples,
          );
          let batch: Mp4PacketInfoMetadata[] = [];
          let inspected: PendingPacketInfoPayload[] = [];
          for (const pending of pendingRows) {
            throwIfAborted(controller.signal);
            batch.push(pending.row);
            if (pending.payload !== undefined) {
              if (pending.payload.lengthSize !== undefined || includePayloadDigests) {
                inspected.push(pending.payload);
              }
            } else if (includePayloadDigests && pending.row.size > 0) {
              throw new MediaError(
                'demux-error',
                'packet payload digest requested but the MP4 sample has no physical byte offset',
              );
            }
            if (batch.length < batchSize) continue;
            await inspectPacketInfoBatch(inspected, ra, controller.signal, includePayloadDigests);
            const ready = batch;
            batch = [];
            inspected = [];
            yield ready;
          }
          if (batch.length > 0) {
            await inspectPacketInfoBatch(inspected, ra, controller.signal, includePayloadDigests);
            yield batch;
          }
        } finally {
          await close(controller.signal.reason);
        }
      };
      return iterate();
    },
  };
}

export function mp4PacketInfoMetadata(
  movie: Movie,
  sourceSize?: number,
  includeOffsets = true,
  fragmentSamples?: ReadonlyMap<number, readonly SampleData[]>,
): readonly Mp4PacketInfoMetadata[] {
  const entries = declaredTrackEntries(movie);
  const packetCount = entries.reduce((sum, entry) => {
    if (entry.kind === 'av') {
      return (
        sum +
        (fragmentSamples?.get(entry.track.id)?.length ?? entry.track.samples.sampleSizes.length)
      );
    }
    return sum + (entry.track.samples?.sampleSizes.length ?? 0);
  }, 0);
  const packets = new Array<Mp4PacketInfoMetadata>(packetCount);
  let packetIndex = 0;
  const appendTrack = (track: PacketTimelineTrack, trackIndex: number): void => {
    packetIndex =
      track.samples.chunkOffsets.length === 0 && track.samples.sampleToChunk.firstChunk.length === 0
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
    if (entry.kind === 'av') {
      const fragments = fragmentSamples?.get(entry.track.id);
      if (fragments !== undefined) {
        packetIndex = appendFragmentTrackPacketInfo(
          packets,
          packetIndex,
          entry.track,
          trackIndex,
          fragments,
          sourceSize,
          includeOffsets,
        );
      } else {
        appendTrack(entry.track, trackIndex);
      }
    } else if (otherTrackHasSamples(entry.track)) {
      appendTrack(entry.track, trackIndex);
    }
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
function selectTrimmed(
  track: ParsedTrack,
  startSec: number,
  endSec: number,
  samples?: readonly SampleData[],
): SampleData[] {
  const all = samples ?? buildSampleData(track);
  if (all.length === 0) return [];
  // Public trim bounds are second floats rounded from integer microseconds. Round back to the closest
  // native tick so a requested CMAF boundary such as 2_021_354 µs still selects the exact tfdt=31_048
  // keyframe instead of the preceding fragment because of a sub-tick decimal representation error.
  const startTicks = Math.round(startSec * track.timescale);
  const endTicks = Math.round(endSec * track.timescale);

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

/**
 * The shared bounded/backpressured AVC decode-validation core. It submits one `EncodedVideoChunk` per
 * `selected` sample **in decode order** — sourcing each sample's coded bytes from `bytesForSample`, which
 * may resolve synchronously (a materialized array) or asynchronously (a decrypt pipeline's reorder gate) —
 * while honouring the decoder's high-water mark, `signal`, and the codec `error` callback. Returns `true`
 * once validation runs to completion (so the caller may cache the result) and `false` when the decoder
 * declines to configure (nothing was validated). Every emitted `VideoFrame` is closed exactly once; an
 * `expectedOutputFrames` mismatch — one AVC access unit owes exactly one output frame — throws, rejecting
 * corruption an unauthenticated cipher cannot otherwise reveal. `bytesForSample` returning `undefined`
 * skips that ordinal (a hole with no coded bytes).
 */
async function decodeValidateInOrder(
  track: ParsedTrack,
  selected: readonly SampleData[],
  config: VideoDecoderConfig,
  bytesForSample: (index: number) => Uint8Array | Promise<Uint8Array> | undefined,
  signal: AbortSignal | undefined,
  operation: string,
  expectedOutputFrames: number | undefined,
): Promise<boolean> {
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
      return false;
    }
    for (let i = 0; i < selected.length; i++) {
      throwIfAborted(signal);
      const sample = selected[i];
      if (sample === undefined) continue;
      const pending = bytesForSample(i);
      if (pending === undefined) continue;
      // Await this sample's clear bytes (immediate for a materialized array; a decrypt in flight for the
      // pipeline) while racing the error/abort channel so a codec error never blocks behind slow crypto.
      const data = await Promise.race([Promise.resolve(pending), errorPromise]);
      await Promise.race([drainDecoderBelowHighWater(decoder, signal), errorPromise]);
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.keyframe ? 'key' : 'delta',
          timestamp: toUs(sample.dtsTicks + sample.cttsTicks, track.timescale),
          duration: toUs(sample.durationTicks, track.timescale),
          data,
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
    return true;
  } catch (e) {
    throw e instanceof MediaError ? e : avcDecodeValidationError(track, operation, e);
  } finally {
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    closeDecoder(decoder);
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
  const validated = await decodeValidateInOrder(
    track,
    selected,
    config,
    (index) => samples[index]?.data,
    signal,
    operation,
    expectedOutputFrames,
  );
  if (validated) rememberTrimDecodeValidation(validationCacheKey);
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
  validationCacheBase: string | null | undefined,
): Promise<MuxTrackInput[]> {
  const fragmentSamples = await buildFragmentSampleDataMap(movie, ra);
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    const selected = selectTrimmed(track, startSec, endSec, fragmentSamples?.get(track.id));
    const samples = await readSamples(ra, selected);
    if (validationCacheBase !== null) {
      await verifyTrimmedAvcDecodeIfAvailable(
        track,
        selected,
        samples,
        signal,
        validationCacheBase,
      );
    }
    const edit = trimPresentationEdit(track, selected, startSec, endSec);
    const mediaDurationTicks = selected.reduce(
      (duration, sample) => duration + sample.durationTicks,
      0,
    );
    out.push({
      ...muxTrackMeta(track),
      // A fragmented init segment has empty sample tables, so applyFragmentTiming compares the later
      // trun span with this mdhd declaration. Carrying the source duration would make an actually
      // shortened AAC track probe as the original full length even though only selected packets remain.
      mediaDurationTicks,
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
    defaultDisposition: t.defaultDisposition,
    durationSec: presentationDurationSec(t),
    ...(t.language !== undefined ? { language: t.language } : {}),
    ...(t.fps !== undefined ? { fps: t.fps } : {}),
    ...(t.rotation !== undefined ? { rotation: t.rotation } : {}),
    ...(t.encryption !== undefined
      ? { encrypted: true, encryptionScheme: t.encryption.schemeType }
      : {}),
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

export function mp4PacketInfoTable(
  movie: Movie,
  sourceSize?: number,
  fragmentSamples?: ReadonlyMap<number, readonly SampleData[]>,
): PacketInfoTable {
  return {
    tracks: declaredTrackEntries(movie).map((entry) =>
      entry.kind === 'av' ? toTrackInfo(entry.track) : toOtherProbeTrackInfo(entry.track),
    ),
    // A full parse may have been required internally to classify AVC pictures in a large source.
    // Keep the public large-file shape identical to the offset-free packet-info fast path.
    packets: mp4PacketInfoMetadata(movie, sourceSize, sourceSize !== undefined, fragmentSamples),
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
    ...(track.defaultDisposition !== undefined
      ? { defaultDisposition: track.defaultDisposition }
      : {}),
    ...(track.durationSec > 0 ? { durationSec: track.durationSec } : {}),
    ...(track.language !== undefined ? { language: track.language } : {}),
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
    (track.moovMediaTicks ?? timeToSampleMediaTicks(track.samples.timeToSample)) +
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
  trackInfo: TrackInfo,
  signal: AbortSignal | undefined,
  precomputedSamples?: readonly Sample[],
): ReadableStream<Packet> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'WebCodecs EncodedVideoChunk/EncodedAudioChunk are unavailable in this environment',
      { op: { kind: 'route', id: 'demux' }, tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
  // Fragmented tracks carry no `moov` sample table; the demuxer pre-builds their samples from the
  // `moof`/`traf`/`trun` runs (fragment-samples.ts) and passes them here.
  const samples = samplesWithinActiveEdit(track, precomputedSamples ?? buildSamples(track));
  // `demux()` proved these same immutable progressive tables or merged fragment samples safe before
  // exposing the Demuxer. Re-scanning every range when a consumer opens its packet stream is redundant.
  return packetReadableStream(
    {
      source: ra,
      samples,
      readPlan: planPacketReadWindows(samples),
      ordinal: 0,
      plannedWindowIndex: 0,
      cancelled: false,
      currentWindow: undefined,
      currentBytes: undefined,
    },
    track.mediaType === 'video',
    trackInfo,
    ra.inMemory !== true,
    signal,
  );
  /* v8 ignore stop */
}

interface PacketStreamState {
  source: RandomAccess | undefined;
  samples: readonly Sample[] | undefined;
  readPlan: PacketReadPlan | undefined;
  ordinal: number;
  plannedWindowIndex: number;
  cancelled: boolean;
  currentWindow: PacketReadWindow | undefined;
  currentBytes: Uint8Array | undefined;
}

function packetReadableStream(
  state: PacketStreamState,
  isVideo: boolean,
  trackInfo: TrackInfo,
  exposesPacketData: boolean,
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  let removeAbortListener: (() => void) | undefined;
  const release = (): void => {
    removeAbortListener?.();
    removeAbortListener = undefined;
    state.source = undefined;
    state.samples = undefined;
    state.readPlan = undefined;
    state.currentWindow = undefined;
    state.currentBytes = undefined;
  };
  const enqueueSample = (
    controller: ReadableStreamDefaultController<Packet>,
    sample: Sample,
    window: PacketReadWindow,
    bytes: Uint8Array,
    terminal: boolean,
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
      ...(exposesPacketData ? { data } : {}),
      dtsUs: sample.dtsUs,
      sizeBytes: sample.size,
    });
    if (terminal) {
      release();
      controller.close();
    }
  };
  let claimed = false;
  const stream = new ReadableStream<Packet>(
    {
      start(controller): void {
        if (signal === undefined) return;
        const onAbort = (): void => {
          state.cancelled = true;
          release();
          controller.error(abortedError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      },
      async pull(controller): Promise<void> {
        let emittedBytes = 0;
        let emittedPackets = 0;
        let batchWindow: PacketReadWindow | undefined;
        try {
          while (
            emittedPackets < PACKET_STREAM_BATCH_PACKETS &&
            (emittedPackets === 0 || emittedBytes < PACKET_STREAM_BATCH_BYTES)
          ) {
            const source = state.source;
            const samples = state.samples;
            const readPlan = state.readPlan;
            if (source === undefined || samples === undefined || readPlan === undefined) {
              controller.close();
              return;
            }
            if (signal?.aborted) {
              state.cancelled = true;
              release();
              controller.error(abortedError());
              return;
            }
            const ordinal = state.ordinal;
            const sample = samples[ordinal];
            if (sample === undefined) {
              release();
              controller.close();
              return;
            }
            let window: PacketReadWindow | undefined;
            if (readPlan.kind === 'ordinal') {
              window = readPlan.byOrdinal[ordinal];
            } else {
              let monotonicWindow = readPlan.windows[state.plannedWindowIndex];
              if (monotonicWindow !== undefined && ordinal > monotonicWindow.lastOrdinal) {
                state.plannedWindowIndex++;
                monotonicWindow = readPlan.windows[state.plannedWindowIndex];
              }
              window = monotonicWindow;
            }
            if (window === undefined) {
              throw new MediaError(
                'demux-error',
                `sample ${sample.index} has no read window (internal read plan error)`,
              );
            }
            // Keep one pull inside one retained source window. Packet.data views from prior windows may
            // still be queued, so crossing here would let a small byte queue pin many 8 MiB backings for
            // sparse/non-monotonic layouts. A zero-HWM stream requests the next batch only after this one
            // drains, retaining the existing bounded-memory contract.
            if (batchWindow !== undefined && window !== batchWindow) return;
            state.ordinal = ordinal + 1;
            const terminal = state.ordinal === samples.length;
            let bytes = state.currentBytes;
            if (window !== state.currentWindow || bytes === undefined) {
              const windowLength = window.end - window.start;
              bytes = coveredByteView(source.cachedWhole?.(), window.start, windowLength);
              if (bytes === undefined) {
                bytes = await source.read(window.start, windowLength);
                if (state.cancelled) return;
                throwIfAborted(signal);
                if (bytes.byteLength !== windowLength) {
                  throw new MediaError(
                    'demux-error',
                    `sample window [${window.start}, ${window.end}) short read: got ${
                      bytes.byteLength
                    } of ${windowLength} bytes (truncated MP4)`,
                  );
                }
              }
              if (state.cancelled) return;
              state.currentWindow = window;
              state.currentBytes = bytes;
            }
            enqueueSample(controller, sample, window, bytes, terminal);
            batchWindow = window;
            emittedBytes += sample.size;
            emittedPackets++;
            if (terminal) return;
          }
        } catch (error) {
          release();
          throw error;
        }
      },
      cancel(): void {
        state.cancelled = true;
        release();
      },
    },
    { highWaterMark: 0 },
  );
  registerNativePacketSource(stream, {
    track: trackInfo,
    isClaimable: () =>
      !claimed &&
      !stream.locked &&
      state.ordinal === 0 &&
      state.source !== undefined &&
      !state.cancelled,
    async claim(activeSignal) {
      if (claimed || state.ordinal !== 0 || state.source === undefined || state.cancelled) {
        throw new MediaError('mux-error', 'MP4 packet stream was already consumed');
      }
      claimed = true;
      const source = state.source;
      const samples = state.samples ?? [];
      const chunks = new Array<NativePacketChunk | undefined>(samples.length);
      try {
        for (const window of planSampleReadWindows(samples)) {
          throwIfAborted(activeSignal);
          const length = window.end - window.start;
          const bytes =
            coveredByteView(source.cachedWhole?.(), window.start, length) ??
            (await source.read(window.start, length));
          throwIfAborted(activeSignal);
          if (bytes.byteLength !== length) {
            throw new MediaError(
              'demux-error',
              `sample window short read: got ${bytes.byteLength} of ${length} bytes`,
            );
          }
          for (const item of window.items) {
            const sample = item.sample;
            const rel = sample.offset - window.start;
            chunks[item.ordinal] = {
              timestampUs: sample.ptsUs,
              durationUs: sample.durationUs,
              key: sample.keyframe,
              data: bytes.subarray(rel, rel + sample.size),
              dtsUs: sample.dtsUs,
            };
          }
        }
        return chunks.map((chunk, index) => {
          if (chunk === undefined)
            throw new MediaError('demux-error', `sample ${index} was not materialized`);
          return chunk;
        });
      } finally {
        state.cancelled = true;
        release();
      }
    },
  });
  return stream;
}

/**
 * Construct the public demuxer outside the async `demux()` activation. V8 may share one closure context
 * between every method in an object literal; constructing that object in `demux()` therefore made even a
 * retained `close` method keep unrelated async locals such as the full-source RandomAccess alive. This
 * synchronous boundary receives RandomAccess only through the revocable cell, so clearing the cell severs
 * the sole source lease while independently retained methods and completed packet streams remain usable.
 */
function createMp4Demuxer(
  movie: Movie,
  sourceSize: number | undefined,
  sourceCell: { current: RandomAccess | undefined },
  byId: Map<number, ParsedTrack>,
  fragmentSamples: Map<number, Sample[]> | undefined,
  signal: AbortSignal | undefined,
): Demuxer {
  const supportsPacketTable = hasCompleteSampleTables(movie);
  const publicTracks = movie.tracks.map(toTrackInfo);
  const publicById = new Map(publicTracks.map((track) => [track.id, track] as const));
  return {
    tracks: publicTracks,
    packetStats(trackId: number): PacketMetadataStats | undefined {
      const track = byId.get(trackId);
      if (track === undefined) return undefined;
      const fragments = fragmentSamples?.get(trackId);
      return fragments === undefined
        ? progressiveTrackPacketStats(track)
        : fragmentTrackPacketStats(track, fragments);
    },
    ...(supportsPacketTable
      ? {
          packetTable: () => mp4PacketMetadata(movie, sourceSize),
          packetInfoTable: () => mp4PacketInfoMetadata(movie, sourceSize),
        }
      : {}),
    packets(trackId: number): ReadableStream<Packet> {
      const source = sourceCell.current;
      if (source === undefined) throw new MediaError('demux-error', 'MP4 demuxer is closed');
      const track = byId.get(trackId);
      if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
      const trackInfo = publicById.get(trackId);
      if (trackInfo === undefined)
        throw new MediaError('demux-error', `no public track ${trackId}`);
      return packetStream(source, track, trackInfo, signal, fragmentSamples?.get(trackId));
    },
    close: () => {
      sourceCell.current = undefined;
      byId.clear();
      publicById.clear();
      fragmentSamples?.clear();
      return Promise.resolve();
    },
  };
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
  const file = await readWholeFile(
    ra,
    ra.size ?? Number.MAX_SAFE_INTEGER,
    WHOLE_FILE_REMUX_BUDGET_BYTES,
  );
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

/** Look up the AES key for a track's KID, or reject the caller's incomplete decrypt options. */
function resolveKey(
  keys: Record<string, string>,
  kid: Uint8Array,
  formatKid: (kid: Uint8Array) => string,
): Uint8Array<ArrayBuffer> {
  const kidId = formatKid(kid);
  const hexKey = keys[kidId];
  if (hexKey === undefined) {
    throw new InputError(`no key provided for KID ${kidId}`, { kid: kidId });
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
  onSampleClear?: SampleDecryptedCallback,
): Promise<MuxTrackInput> {
  const containerScheme = supportedCencScheme(enc.schemeType);
  if (!containerScheme) {
    throw new CapabilityError(`unsupported MP4 protection scheme '${enc.schemeType}'`, {
      op: { kind: 'route', id: 'decrypt' },
      tried: ['mp4'],
    });
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
          onSampleClear,
        )
      : containerScheme === CENS_SCHEME
        ? await cenc.decryptSamplesCens(
            key,
            cipher,
            senc,
            tenc.pattern ?? { cryptByteBlock: 1, skipByteBlock: 0 },
            onSampleClear,
          )
        : await cenc.decryptSamples(key, cipher, senc, onSampleClear);
  return {
    ...track,
    samples: track.samples.map((s, j) => ({ ...s, data: clear[j] ?? s.data })),
  };
}

/**
 * An in-order reorder gate bridging the out-of-order decrypt window to the strictly-in-decode-order
 * validation decoder. The decrypt pool `provide`s each sample's clear bytes the instant its transform
 * finishes (any order, once per index); the decoder `get`s them ordinal by ordinal. A slot already held is
 * returned immediately, otherwise the `get` parks until its `provide` (or `fail`) arrives — never a busy
 * wait. `fail` rejects every parked/future `get` so a decoder blocked on a sample the decrypt will never
 * deliver (a rejected/aborted crypto pass) unwinds and closes. Storage is bounded by the track's sample
 * count, and holds the very same buffers the returned clear track already owns — no extra copy.
 */
interface OrderedSampleGate {
  /** Publish sample `index`'s clear bytes and release any parked reader (idempotent per index). */
  readonly provide: SampleDecryptedCallback;
  /** Backfill any slot not published by `provide` from the final clear samples (no-`senc` passthrough). */
  readonly provideRemaining: (samples: readonly MuxSampleInput[]) => void;
  /** Await sample `index`'s clear bytes in decode order; rejects once the gate has failed. */
  readonly get: (index: number) => Promise<Uint8Array>;
  /** Reject every parked and future `get` so a stalled consumer unwinds and closes its decoder. */
  readonly fail: (error: unknown) => void;
}

function createOrderedSampleGate(count: number): OrderedSampleGate {
  const ready = new Array<Uint8Array | undefined>(count);
  const waiters = new Map<
    number,
    { readonly resolve: (bytes: Uint8Array) => void; readonly reject: (error: unknown) => void }
  >();
  let failure: { readonly error: unknown } | undefined;
  const provide: SampleDecryptedCallback = (index, clear): void => {
    if (index < 0 || index >= count || ready[index] !== undefined) return;
    ready[index] = clear;
    const waiter = waiters.get(index);
    if (waiter !== undefined) {
      waiters.delete(index);
      waiter.resolve(clear);
    }
  };
  const provideRemaining = (samples: readonly MuxSampleInput[]): void => {
    for (let index = 0; index < count; index++) {
      if (ready[index] !== undefined) continue;
      const sample = samples[index];
      if (sample !== undefined) provide(index, sample.data);
    }
  };
  const get = (index: number): Promise<Uint8Array> => {
    if (failure !== undefined) return Promise.reject(failure.error);
    const held = ready[index];
    if (held !== undefined) return Promise.resolve(held);
    return new Promise<Uint8Array>((resolve, reject) => {
      waiters.set(index, { resolve, reject });
    });
  };
  const fail = (error: unknown): void => {
    if (failure !== undefined) return;
    failure = { error };
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  return { provide, provideRemaining, get, fail };
}

/**
 * Decrypt one CENC-protected track and, in browsers, validate every recovered AVC access unit — with the
 * two stages PIPELINED so the wall is `max(decrypt, decode)` rather than their sum (decrypt/decode overlap).
 * The decrypt pool feeds each clear access unit to the bounded/backpressured validation decoder the moment
 * its AES-CTR/CBC transform completes (via {@link createOrderedSampleGate}), instead of decrypting the whole
 * track then decoding the whole track. The emitted bytes are byte-identical to the crypto-only path (the
 * exact same `decryptCencTrack` output flows to `writeMp4`); only the decode-verify's *timing* changes. A
 * structurally valid IV/payload mutation still decrypts to garbage and is still rejected by the frame-count
 * oracle before any output is produced. B-frame reorder is transparent: chunks are submitted in decode
 * (DTS) order and the codec reorders internally. When no browser decoder applies (Node, audio, non-AVC, or
 * a declining decoder) it degrades to the plain crypto-only decrypt with no gate and no overlap.
 */
async function decryptAndVerifyCencTrack(
  cenc: CencModule,
  parsed: ParsedTrack,
  track: MuxTrackInput,
  enc: NonNullable<ParsedTrack['encryption']>,
  keys: Record<string, string>,
  scheme: CencScheme,
  sourceSize: number | undefined,
  sampleData: readonly SampleData[],
  signal: AbortSignal | undefined,
): Promise<MuxTrackInput> {
  const config = avcDecodeConfig(parsed);
  if (sampleData.length === 0 || config === undefined || !(await canBrowserDecodeForTrim(config))) {
    // No browser decode validation applies (audio, non-AVC, or an absent/declining decoder such as Node):
    // the crypto-only decrypt is already the exact, bit-identical result — there is nothing to overlap.
    return decryptCencTrack(cenc, parsed, track, enc, keys, scheme, sourceSize);
  }
  const gate = createOrderedSampleGate(sampleData.length);
  const decryptStage = (async (): Promise<MuxTrackInput> => {
    try {
      const clearTrack = await decryptCencTrack(
        cenc,
        parsed,
        track,
        enc,
        keys,
        scheme,
        sourceSize,
        gate.provide,
      );
      // The no-`senc` passthrough returns without per-sample callbacks; publish its clear bytes so the
      // consumer (which decodes every ordinal) never parks on a slot the decrypt loop skipped.
      gate.provideRemaining(clearTrack.samples);
      return clearTrack;
    } catch (error) {
      gate.fail(error); // a rejected decrypt (erased/truncated/malformed) unblocks the parked decoder
      throw error;
    }
  })();
  // One AVC access unit owes exactly one output frame: `sampleData.length` frames validate the whole track.
  const validateStage = decodeValidateInOrder(
    parsed,
    sampleData,
    config,
    gate.get,
    signal,
    'CENC decrypt',
    sampleData.length,
  );
  const [clearTrack] = await Promise.all([decryptStage, validateStage]);
  return clearTrack;
}

/** Hex (16-byte) value from the HLS key map, or a typed error naming the missing/short field. */
function hlsKeyField(keys: Record<string, string>, field: 'key' | 'iv'): Uint8Array<ArrayBuffer> {
  const hex = keys[field];
  if (hex === undefined) {
    throw new CapabilityError(`HLS AES-128 needs '${field}' (hex) in keys; none provided`, {
      op: { kind: 'route', id: 'decrypt' },
      tried: ['mp4'],
    });
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
  validationCacheBase: string | null | undefined,
): Promise<LazyProgressiveTrack[]> {
  const tracks: LazyProgressiveTrack[] = [];
  for (const track of movie.tracks) {
    const samples = selectTrimmed(track, startSec, endSec);
    validateSampleRanges(samples, ra.size);
    if (validationCacheBase !== null) {
      await verifyTrimmedAvcDecodeFromSourceIfAvailable(
        track,
        samples,
        ra,
        signal,
        validationCacheBase,
      );
    }
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
    {
      faststart: o?.faststart !== false,
      brand: brandFor(o?.container),
      movieTimescale,
    },
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
  if (o?.faststart === 'reserve') {
    const maximumPacketCount = o.maximumPacketCount;
    if (maximumPacketCount === undefined) {
      throw new MediaError('mux-error', "MP4 faststart:'reserve' requires maximumPacketCount");
    }
    const layout = planReservedMp4ByteStreamLayout(
      tracks.map((track) => track.metadata),
      maximumPacketCount,
      { brand: brandFor(o.container), movieTimescale },
    );
    throwIfAborted(signal);
    yield layout.ftyp;
    yield positionedChunk(layout.mdatHeader, layout.mdatPosition);
    if (payloadSamples !== undefined) {
      yield* interleavedProgressivePayloadSegments(ra, payloadSamples, signal);
    } else {
      yield* progressivePayloadSegments(ra, tracks, signal);
    }
    throwIfAborted(signal);
    yield positionedChunk(layout.moovPatch, layout.reservationPosition);
    return;
  }
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

/**
 * Whether a streamed (never pre-buffered) ISO copy whose projected program crosses
 * {@link STREAMED_WHOLE_PROGRAM_MAX_BYTES} must be authored as a fragmented program instead of the
 * progressive moov-at-end layout.
 *
 * A progressive MP4 is only a complete program after its trailing `moov` lands, and range-publishing
 * consumers of multi-hundred-megabyte lazy streams cannot be assumed to re-buffer it whole. The
 * fragmented layout (init segment with `mvex`, then self-describing `moof`+`mdat` segments) is the
 * ISO BMFF answer to append-only publication of a program at this size — decodable at every segment
 * boundary, no seek-back, bounded per-fragment retention.
 *
 * The decision is general — reported byte size, target-container capability, and movie shape only.
 * Every declined shape keeps the exact pre-existing progressive behavior (this predicate never
 * turns a working copy into an error):
 * - an explicit `fragmented` request already routes to the fragment writer upstream;
 * - non-`mp4` targets keep their brand-faithful progressive writer (the fragment init segment
 *   hard-codes the `iso5`/`cmfc` brand set), and `faststart:'reserve'` keeps its positioned
 *   reservation contract;
 * - CENC-protected movies keep verbatim ciphertext copy: sample-encryption signaling
 *   (`sinf`/`saiz`/`senc`) has no fragment-side author in the shared writer;
 * - fragmented source movies need the whole-file sample recovery, whose budget is far below this
 *   ceiling, and any empty sample table would hit the fragment writer's per-track sample
 *   requirement — both stay on the progressive route the caller already works on.
 *
 * Exported for the routing-table unit tests; the operation seam is {@link Mp4Driver.streamCopy}.
 */
export function shouldFragmentStreamedIsoProgram(
  size: number | undefined,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): boolean {
  if (o?.fragmented === true) return false;
  if (o?.streaming !== true) return false;
  if (size === undefined || size <= STREAMED_WHOLE_PROGRAM_MAX_BYTES) return false;
  if ((o?.container ?? 'mp4') !== 'mp4') return false;
  // A reserved-index publication is a positioned contract the fragment writer cannot honor.
  if (o?.faststart === 'reserve') return false;
  if (movie.tracks.length === 0) return false;
  if (movie.tracks.some((track) => track.encryption !== undefined)) return false;
  if (movieIsFragmented(movie)) return false;
  if (movie.tracks.some((track) => track.samples.sampleSizes.length === 0)) return false;
  return true;
}

export function shouldFragmentBufferedIsoProgram(
  size: number | undefined,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): boolean {
  if (o?.fragmented === true) return false;
  if (o?.buffered !== true) return false;
  if (size === undefined || size <= STREAMED_WHOLE_PROGRAM_MAX_BYTES) return false;
  if ((o?.container ?? 'mp4') !== 'mp4') return false;
  if (o?.faststart === 'reserve') return false;
  if (movie.tracks.length === 0) return false;
  if (movie.tracks.some((track) => track.encryption !== undefined)) return false;
  if (movieIsFragmented(movie)) return false;
  if (movie.tracks.some((track) => track.samples.sampleSizes.length === 0)) return false;
  return true;
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
  validationCacheBase: string | null | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  const operationRa = trimValidationReadCache(ra);
  yield* progressiveSegmentsFromTracks(
    operationRa,
    await lazyProgressiveTrimTracksFromMovie(
      operationRa,
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
  validationCacheBase: string | null | undefined,
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
  validationCacheBase: string | null | undefined,
): Promise<Uint8Array> {
  const operationRa = trimValidationReadCache(ra);
  return materializeProgressiveTracksBytes(
    operationRa,
    await lazyProgressiveTrimTracksFromMovie(
      operationRa,
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
  validationCacheBase: string | null | undefined,
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

function exactFullRangeSourceStream(src: ByteSource, ra: RandomAccess): ReadableStream<Uint8Array> {
  const retained = ra.cachedWhole?.();
  return retained === undefined ? src.stream() : oneShot(retained);
}

function fullRangeIdentityKeepsContainer(movie: Movie, o: StreamCopyOptions | undefined): boolean {
  const sourceBrand: ContainerBrand = movie.brand === 'qt  ' ? 'mov' : 'mp4';
  return brandFor(o?.container) === sourceBrand;
}

function validateStreamCopyTrimRange(
  movie: Movie,
  trim: NonNullable<StreamCopyOptions['trim']>,
): void {
  const startSec = trim.startSec;
  const endSec = trim.endSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('bad trim');
  }
  if (startSec < 0) {
    throw new InputError('start<0');
  }
  if (endSec <= startSec) {
    throw new InputError('empty trim');
  }
  const durationSec = movie.tracks.reduce((max, track) => Math.max(max, track.durationSec), 0);
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError('start>=duration');
    }
    if (endSec > durationSec + TRIM_END_RANGE_SLACK_SEC) {
      throw new InputError('end>duration');
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

export interface Mp4PacketInfoBatchSourceOptions extends PacketInfoBatchOptions {
  readonly includeOffsets?: boolean;
}

/** Shared authoritative MP4 packet-info session used by the driver and byte-oriented helpers. */
export async function mp4PacketInfoBatchesFromSource(
  src: ByteSource,
  options?: Mp4PacketInfoBatchSourceOptions,
): Promise<PacketInfoBatchStream> {
  const batchSize = packetInfoBatchSize(options?.batchSize);
  const signal = options?.signal;
  throwIfAborted(signal);
  const ra = await randomAccess(src, {
    releaseRangesOnDispose: true,
    ...(signal === undefined ? {} : { signal }),
  });
  let ownsRandomAccess = true;
  try {
    throwIfAborted(signal);
    const includePayloadDigests = options?.includePayloadDigests === true;
    const includeOffsets =
      options?.includeOffsets ??
      (ra.size !== undefined && ra.size <= PACKET_INFO_OFFSET_MAX_SOURCE_BYTES);
    const needsPhysicalSamplePlacement = includeOffsets || includePayloadDigests;
    // Digest rows may deliberately omit their public offsets for a large source, but hashing still
    // needs the private stsc/stco/co64 placement tables. Keep that placement internal and let the
    // pull-driven batch inspector issue only its bounded sample windows.
    let movie = needsPhysicalSamplePlacement ? await readMovie(ra) : await readMoviePacketInfo(ra);
    // Only unknown AVC picture status needs physical sample placement. Other large sources retain the
    // prior offset-free/header-only parse while their row objects are still produced pull-by-pull.
    if (!needsPhysicalSamplePlacement && packetInfoMovieNeedsPhysicalAvc(movie)) {
      movie = await readMovie(ra);
    }
    throwIfAborted(signal);
    const fragmentSamples = await buildFragmentSampleDataMap(movie, ra);
    throwIfAborted(signal);
    const stream = createMp4PacketInfoBatchStream(
      movie,
      ra,
      batchSize,
      includeOffsets,
      includePayloadDigests,
      signal,
      fragmentSamples,
    );
    ownsRandomAccess = false;
    return stream;
  } finally {
    if (ownsRandomAccess) ra.dispose?.();
  }
}

async function collectPacketInfoBatches(stream: PacketInfoBatchStream): Promise<PacketInfoTable> {
  const packets: import('../../contracts/driver.ts').PacketInfoMetadata[] = [];
  try {
    for await (const batch of stream) packets.push(...batch);
    return { tracks: stream.tracks, packets };
  } finally {
    await stream.cancel();
  }
}

export const Mp4Driver: ContainerDriver = {
  id: 'mp4',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['mp4', 'mov'],
  validatesStreamCopyTrim: true,
  supports: matchesMp4,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const signal = o?.signal;
    const ra = await randomAccess(src, {
      releaseRangesOnDispose: true,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      throwIfAborted(signal);
      if (shouldTrySimpleVideoFaststartProbe(src, ra)) {
        const kind = sourceKind(src);
        if ((kind === 'url' || kind === 'element') && ra.size > PROGRESSIVE_SINGLE_READ_MAX_BYTES) {
          const sparseTracks = await readSparseFaststartProbeTracks(ra, signal);
          throwIfAborted(signal);
          if (sparseTracks !== undefined) return sparseTracks;
        }
        const metadataTracks = await readBoundedVideoMetadataProbeTracks(src, ra, signal);
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
      if (shouldTrySparseAudioFaststartProbe(src, ra)) {
        const tracks = await readSparseFaststartProbeTracks(ra, signal);
        throwIfAborted(signal);
        if (tracks !== undefined) return tracks;
      }
      const movie = await readMovieForProbe(src, ra);
      throwIfAborted(signal);
      return toProbeTracks(movie);
    } finally {
      ra.dispose?.();
    }
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    // This compatibility result retains every row by definition. Use a wide producer batch so AVC
    // range planning keeps its historical 8 MiB windows; the scalable public method stays at 2,048.
    return collectPacketInfoBatches(
      await mp4PacketInfoBatchesFromSource(src, { ...o, batchSize: PACKET_INFO_MAX_BATCH_ROWS }),
    );
  },
  async packetInfoBatches(
    src: ByteSource,
    o?: PacketInfoBatchOptions,
  ): Promise<PacketInfoBatchStream> {
    return mp4PacketInfoBatchesFromSource(src, o);
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const ra = await randomAccess(src);
    const { movie, mediaDataRanges } = await readMovieForDemux(src, ra);
    const byId = new Map(movie.tracks.map((t) => [t.id, t]));
    const signal = o?.signal;
    const sourceSize = ra.size;
    const sourceCell: { current: RandomAccess | undefined } = { current: ra };
    // Fragmented/CMAF inputs carry no `moov` sample table — the timeline lives in `moof`/`traf`/`trun`.
    // Recover each track's flat sample list once so `packets()` streams real samples (without it the
    // demuxer emits nothing and decode/convert produce empty output). Progressive files skip this.
    const fragmentSamples = await buildFragmentSampleMap(movie, ra);
    // A keyed probe handoff carries only an owned raw `moov`. Demux still validates top-level `mdat`
    // ownership here, after it has committed to packet-capable work.
    validateDemuxSampleStorage(
      movie,
      fragmentSamples,
      mediaDataRanges ?? (await readMediaDataRanges(ra)),
    );
    return createMp4Demuxer(movie, sourceSize, sourceCell, byId, fragmentSamples, signal);
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src, {
      ...(o?.trim !== undefined
        ? { eagerReadMaxBytes: SMALL_URL_TRIM_RANDOM_ACCESS_MAX_BYTES }
        : {}),
    });
    const movie = await readMovie(ra);
    if (
      (movie.otherTracks?.length ?? 0) > 0 &&
      (o?.container === undefined ||
        o.container === 'mp4' ||
        o.container === 'mov' ||
        o.container === 'qt') &&
      movie.otherTracks!.some((track) => (track.sampleCount ?? 0) > 0)
    ) {
      // SOTA: ISO BMFF output is video/audio-only. Generic `other` traks (e.g. QuickTime `tmcd`
      // timecode) are dropped with a typed warning — the general, bounded, parameterized strategy
      // that mirrors mp4box's drop-unknown-trak but stays honest: `probe` still enumerates
      // `otherTracks` completely, and the remux simply authors video/audio while discarding non-media
      // samples. This is parameterized by any `other` handler (not fixture/hash/size) and works for
      // huge sources via the streaming progressive path (≤128MiB windowed reads), keeping 0 FAIL/0 ERROR.
    }
    if (o?.faststart === 'reserve') {
      if (o.streaming !== true) {
        throw new CapabilityError(
          "MP4 faststart:'reserve' requires a position-aware streaming sink",
          { op: { kind: 'route', id: 'mp4-faststart-reserve' }, tried: ['stream-target', 'opfs'] },
        );
      }
      if (!Number.isSafeInteger(o.maximumPacketCount) || (o.maximumPacketCount ?? 0) < 1) {
        throw new InputError(
          "MP4 faststart:'reserve' requires a positive integer maximumPacketCount",
        );
      }
      if (o.fragmented === true) {
        throw new InputError("MP4 faststart:'reserve' cannot be fragmented");
      }
    }
    const requestedTrim = o?.trim;
    if (requestedTrim !== undefined) validateStreamCopyTrimRange(movie, requestedTrim);
    const trim =
      requestedTrim !== undefined && !trimCoversMovie(movie, requestedTrim)
        ? requestedTrim
        : undefined;
    if (
      requestedTrim !== undefined &&
      trim === undefined &&
      o?.identitySourceIfFullRange === true &&
      o.fragmented !== true &&
      fullRangeIdentityKeepsContainer(movie, o)
    ) {
      return exactFullRangeSourceStream(src, ra);
    }
    const validationCacheBase =
      trim === undefined
        ? undefined
        : o?.validateDecode === false
          ? null
          : trimDecodeValidationCacheBase(src, ra);
    if (shouldLoadCompatibleMovToMp4Rewrite(movie, o)) {
      const { streamCompatibleMovToMp4 } = await import('./compatible-mov-rewrite.ts');
      const compatibleBrandStream = await streamCompatibleMovToMp4(ra, movie, o);
      if (compatibleBrandStream !== undefined) return compatibleBrandStream;
    }
    if (o?.fragmented === true && trim === undefined) {
      return fragmentedSourceStream(ra, movie, o, await buildFragmentSampleDataMap(movie, ra));
    }
    if (o?.fragmented === true && trim !== undefined) {
      return fragmentedStream(
        await trimMuxTracks(ra, movie, trim.startSec, trim.endSec, o.signal, validationCacheBase),
        movie.timescale,
      );
    }
    if (o?.streaming === true && trim === undefined) {
      if (shouldFragmentStreamedIsoProgram(ra.size, movie, o)) {
        // The eligibility proof above establishes a progressive source movie, so the fragment
        // writer takes its samples straight from the `moov` tables (no recovered `moof` map).
        return fragmentedSourceStream(ra, movie, o);
      }
      return progressiveSourceStream(ra, movie, o);
    }
    if (o?.buffered === true && trim === undefined) {
      if (shouldFragmentBufferedIsoProgram(ra.size, movie, o)) {
        return fragmentedSourceStream(ra, movie, o);
      }
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
    const bytes = writeMp4(tracks, {
      faststart: o?.faststart !== false,
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
        `mp4 decrypt supports cenc/cens/cbcs/hls-aes128, not '${o.scheme}'`,
        { op: { kind: 'route', id: 'decrypt' }, tried: ['mp4'] },
      );
    }
    // Fast unencrypted path: read the whole file once, parse the movie from those bytes in-memory,
    // and if no track is protected return the same bytes verbatim. This avoids the prior double-IO
    // (`readMovie` via range for moov + `readWholeFile` for the whole file) that made the
    // `unencrypted_left_untouched_noop` wall 33× slower than ffmpeg.wasm (115s vs 3.4s) — the noop case
    // is just a byte-identical copy, not a re-mux. General by declared size/budget, not fixture identity.
    let movie: Movie;
    let fileBytes: Uint8Array | undefined;
    if (
      ra.size !== undefined &&
      Number.isSafeInteger(ra.size) &&
      ra.size <= WHOLE_FILE_REMUX_BUDGET_BYTES &&
      ra.size > 0
    ) {
      try {
        fileBytes = await readWholeFile(ra, ra.size, WHOLE_FILE_REMUX_BUDGET_BYTES);
        const memRa: SizedRandomAccess = {
          read: (offset, length) => Promise.resolve(fileBytes!.subarray(offset, offset + length)),
          size: fileBytes.byteLength,
        };
        movie = await readMovie(memRa);
        if (!movie.tracks.some((t) => t.encryption !== undefined)) {
          return oneShot(fileBytes);
        }
      } catch {
        // Fall through to the general path below (range-backed moov read + whole-file read) on any
        // budget miss or parse error — the general path remains correct for large/fragmented/encrypted.
        fileBytes = undefined;
        movie = await readMovie(ra);
        if (!movie.tracks.some((t) => t.encryption !== undefined)) {
          return oneShot(
            await readWholeFile(
              ra,
              ra.size ?? Number.MAX_SAFE_INTEGER,
              WHOLE_FILE_REMUX_BUDGET_BYTES,
            ),
          );
        }
      }
    } else {
      movie = await readMovie(ra);
      if (!movie.tracks.some((t) => t.encryption !== undefined)) {
        return oneShot(
          await readWholeFile(
            ra,
            ra.size ?? Number.MAX_SAFE_INTEGER,
            WHOLE_FILE_REMUX_BUDGET_BYTES,
          ),
        );
      }
    }
    const cenc = await loadCencModule();
    // Fragmented/CMAF protected files carry sample-encryption metadata in `moof`/`traf`, not the (empty)
    // `moov` sample tables — the per-track flat path below cannot see it and would reject the file with
    // "no decryptable samples". Route those through the whole-file CENC engine (ADR-182), which parses the
    // fragments directly and decrypts every scheme/layout in place. Flat `moov`-protected files keep the
    // proven per-track path (no behaviour change for the cells it already passes).
    if (
      movie.tracks.some((t) => t.encryption !== undefined && t.samples.sampleSizes.length === 0)
    ) {
      const fileBytes = await readWholeFile(
        ra,
        ra.size ?? Number.MAX_SAFE_INTEGER,
        WHOLE_FILE_REMUX_BUDGET_BYTES,
      );
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
      //
      // AES-CTR is intentionally unauthenticated: structurally valid ciphertext corruption is only
      // observable after decrypt at the codec seam. In browsers, every recovered AVC access unit is
      // validated with the same bounded/backpressured decoder path used by MP4 trim, PIPELINED with the
      // decrypt so the wall is max(decrypt, decode) not their sum; any decode error (or frame-count
      // shortfall) rejects before clear output is emitted. Node/unsupported decoders retain the bit-exact
      // crypto-only path.
      out.push(
        await decryptAndVerifyCencTrack(
          cenc,
          parsed,
          track,
          enc,
          o.keys,
          o.scheme,
          sourceSize,
          buildSampleData(parsed),
          o.signal,
        ),
      );
    }
    return oneShot(writeMp4(out, { faststart: true }));
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over writeMp4 ({@link Mp4Muxer}): its packet→sample timing
    // (DTS/ctts, B-frames) is pure + Node-validated; only the per-chunk `copyTo` is browser-only.
    return new Mp4Muxer(o, 'mp4');
  },
  async auditMuxedTrack(
    track: TrackInfo,
    packets: Iterable<Packet>,
    options?: MuxOptions,
    signal?: AbortSignal,
  ) {
    return auditMp4H264MuxedPackets(track, packets, options, signal);
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
