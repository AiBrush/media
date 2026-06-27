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
  PacketMetadata,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { aesCbcPkcs7, hexToBytes } from '../../crypto/aes.ts';
import {
  CBCS_SCHEME,
  CENC_SCHEME,
  type CencScheme,
  type SencSample,
  decryptSamples,
  decryptSamplesCbcs,
  kidHex,
  parseSenc,
  parseTenc,
} from './cenc.ts';
import {
  type FragmentInitTrackInput,
  buildMediaSegment,
  fragmentMp4,
  fragmentMp4InitSegment,
} from './fragment.ts';
import { Mp4Muxer } from './mux.ts';
import { type Movie, type ParsedTrack, applyFragmentTiming, parseMovie } from './parse.ts';
import { Reader } from './reader.ts';
import { type Sample, type SampleData, buildSampleData, buildSamples } from './samples.ts';
import {
  type ContainerBrand,
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
const LAZY_FRAGMENT_TARGET_SAMPLES = 900;
const LAZY_FRAGMENT_HARD_VIDEO_SAMPLES = LAZY_FRAGMENT_TARGET_SAMPLES * 4;

/** Target container token → the `ftyp` brand writeMp4 emits ('mov'/'qt' ⇒ QuickTime; else ISO mp4). */
function brandFor(container: string | undefined): ContainerBrand {
  return container === 'mov' || container === 'qt' ? 'mov' : 'mp4';
}

/** A random-access view over a source: range reads when available, else a one-time buffer. */
interface RandomAccess {
  read(offset: number, length: number): Promise<Uint8Array>;
  size?: number;
}

async function randomAccess(src: ByteSource): Promise<RandomAccess> {
  const range = src.range;
  if (range) {
    return {
      read: (offset, length) => range.call(src, offset, offset + length),
      ...(src.size !== undefined ? { size: src.size } : {}),
    };
  }
  const buffered = await readAll(src.stream());
  return {
    read: (o, l) => Promise.resolve(buffered.subarray(o, o + l)),
    size: buffered.byteLength,
  };
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
      // Fragmented/CMAF: the `moov` sample tables are empty and the real timing lives in `moof`/`sidx`
      // (top-level siblings of `moov`). Recover per-track duration + sample count from the fragments so
      // probe reports a correct `durationSec`/`fps` instead of 0.
      if (movie.tracks.some((t) => t.samples.sampleSizes.length === 0)) {
        return applyFragmentTiming(movie, await readWholeFile(ra, limit));
      }
      return movie;
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
    ...(track.sampleRate !== undefined ? { sampleRate: track.sampleRate } : {}),
    ...(track.channels !== undefined ? { channels: track.channels } : {}),
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

function validateSampleRanges(
  samples: readonly SampleRange[],
  sourceSize: number | undefined,
): void {
  for (const s of samples) {
    // A sample whose byte range escapes the source (truncated/corrupt mdat, or a bit-flipped
    // stsz/stco/co64 entry) would otherwise be read as a silently clamped short buffer and copied as
    // garbage. Reject it as corrupt input rather than emit a wrong file (graceful-failure, doc 11 §6.3).
    if (
      s.offset < 0 ||
      s.size < 0 ||
      (sourceSize !== undefined && s.offset + s.size > sourceSize)
    ) {
      const sizeNote = sourceSize !== undefined ? ` size ${sourceSize}` : '';
      throw new MediaError(
        'demux-error',
        `sample ${s.index} byte range [${s.offset}, ${s.offset + s.size}) is outside the source${sizeNote} (truncated or corrupt MP4)`,
      );
    }
  }
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

/** Turn a parsed movie + its bytes into mux-ready tracks (lossless stream-copy), for `remux`. */
export async function muxTracksFromMovie(ra: RandomAccess, movie: Movie): Promise<MuxTrackInput[]> {
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    out.push({ ...muxTrackMeta(track), samples: await readSamples(ra, buildSampleData(track)) });
  }
  return out;
}

function hasCompleteSampleTables(movie: Movie): boolean {
  return movie.tracks.every((track) => {
    if (track.samples.sampleSizes.length > 0) return true;
    return track.fragmentSampleCount === undefined && track.durationSec === 0;
  });
}

export function mp4PacketMetadata(movie: Movie, sourceSize?: number): readonly PacketMetadata[] {
  const packets: PacketMetadata[] = [];
  for (const track of movie.tracks) {
    const samples = buildSamples(track);
    validateSampleRanges(samples, sourceSize);
    for (const sample of samples) {
      packets.push({
        trackId: track.id,
        sizeBytes: sample.size,
        ptsUs: sample.ptsUs,
        dtsUs: sample.dtsUs,
        durationUs: sample.durationUs,
        keyframe: sample.keyframe,
      });
    }
  }
  return packets;
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

function toUs(ticks: number, timescale: number): number {
  return timescale > 0 ? Math.round((ticks * 1_000_000) / timescale) : 0;
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function describeUnknownError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    return `${e.name}: ${e.message}`;
  }
  return String(e);
}

function trimDecodeValidationError(track: ParsedTrack, e: unknown): MediaError {
  return new MediaError(
    'demux-error',
    `track ${track.id} failed browser decode validation during MP4 trim (${describeUnknownError(e)})`,
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
): Promise<void> {
  const config = avcDecodeConfig(track);
  if (!config || !(await canBrowserDecodeForTrim(config))) return;

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
      error: (e: DOMException): void => fail(trimDecodeValidationError(track, e)),
    });
    try {
      decoder.configure(config);
    } catch {
      return;
    }
    for (let i = 0; i < selected.length; i++) {
      if (signal?.aborted) throw abortedError();
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
  } catch (e) {
    throw e instanceof MediaError ? e : trimDecodeValidationError(track, e);
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
): Promise<MuxTrackInput[]> {
  const out: MuxTrackInput[] = [];
  for (const track of movie.tracks) {
    const selected = selectTrimmed(track, startSec, endSec);
    const samples = await readSamples(ra, selected);
    await verifyTrimmedAvcDecodeIfAvailable(track, selected, samples, signal);
    out.push({
      ...muxTrackMeta(track),
      samples,
    });
  }
  return out;
}

function toTrackInfo(t: ParsedTrack): TrackInfo {
  return {
    id: t.id,
    mediaType: t.mediaType,
    codec: t.codec,
    durationSec: t.durationSec,
    ...(t.fps !== undefined ? { fps: t.fps } : {}),
    ...(t.rotation !== undefined ? { rotation: t.rotation } : {}),
    ...(t.encryption !== undefined ? { encrypted: true } : {}),
    config: t.config,
  };
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
): ReadableStream<Packet> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'WebCodecs EncodedVideoChunk/EncodedAudioChunk are unavailable in this environment',
      { op: 'demux', tried: [] },
    );
  }
  /* v8 ignore start -- requires WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
  const samples = buildSamples(track);
  validateSampleRanges(samples, ra.size);
  const windows = planSampleReadWindows(samples);
  const windowByOrdinal = new Array<SampleReadWindow<Sample> | undefined>(samples.length);
  for (const window of windows) {
    for (const item of window.items) windowByOrdinal[item.ordinal] = window;
  }
  const isVideo = track.mediaType === 'video';
  let i = 0;
  let currentWindow: SampleReadWindow<Sample> | undefined;
  let currentBytes: Uint8Array | undefined;
  return new ReadableStream<Packet>({
    async pull(controller): Promise<void> {
      if (signal?.aborted) {
        controller.error(abortedError());
        return;
      }
      const sample = samples[i];
      if (sample === undefined) {
        controller.close();
        return;
      }
      i++;
      const window = windowByOrdinal[sample.index];
      if (window === undefined) {
        throw new MediaError(
          'demux-error',
          `sample ${sample.index} has no read window (internal read plan error)`,
        );
      }
      if (window !== currentWindow) {
        currentBytes = await ra.read(window.start, window.end - window.start);
        if (signal?.aborted) throw abortedError();
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
      const bytes = currentBytes;
      if (bytes === undefined) {
        throw new MediaError(
          'demux-error',
          'sample window bytes are missing (internal read error)',
        );
      }
      const rel = sample.offset - window.start;
      const data = bytes.subarray(rel, rel + sample.size);
      const init = {
        type: (sample.keyframe ? 'key' : 'delta') as EncodedVideoChunkType,
        timestamp: sample.ptsUs,
        duration: sample.durationUs,
        data,
      };
      const chunk = isVideo ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init);
      controller.enqueue({ chunk, dtsUs: sample.dtsUs });
    },
  });
  /* v8 ignore stop */
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
function resolveKey(keys: Record<string, string>, kid: Uint8Array): Uint8Array<ArrayBuffer> {
  const hexKey = keys[kidHex(kid)];
  if (hexKey === undefined) {
    throw new CapabilityError('capability-miss', `no key provided for KID ${kidHex(kid)}`, {
      op: 'decrypt',
      tried: ['mp4'],
    });
  }
  return hexToBytes(hexKey);
}

function cencSamplesForTrack(
  enc: NonNullable<ParsedTrack['encryption']>,
  tenc: ReturnType<typeof parseTenc>,
  containerScheme: CencScheme,
  trackId: number,
): SencSample[] | undefined {
  if (enc.senc) return parseSenc(enc.senc, tenc.perSampleIvSize, containerScheme);
  if (
    containerScheme === CBCS_SCHEME &&
    tenc.perSampleIvSize === 0 &&
    tenc.constantIv !== undefined
  ) {
    return undefined;
  }
  throw new MediaError(
    'demux-error',
    `${containerScheme}-protected track ${trackId} is not decryptable by this path: per-sample encryption data (senc) is absent and no cbcs default_constant_IV fallback applies (malformed protection metadata)`,
  );
}

/**
 * Decrypt one CENC-protected track (`cenc` AES-CTR or `cbcs` AES-CBC-pattern) into a cleartext
 * {@link MuxTrackInput}. The scheme is the container's own (`enc.schemeType` from `schm`); the caller's
 * declared `scheme` must match it (a mismatch is corrupt/contradictory input). A protected track with an
 * empty sample table (e.g. fragmented/CMAF metadata in `moof/traf`, which this `moov` path does not read)
 * cannot be honestly decrypted here, so it rejects rather than emit a sample-less blob. `senc` is required
 * for byte decryption; if a cbcs track has a `tenc` default_constant_IV but no sample auxiliary encryption
 * data at all, Bento4's `mp4decrypt` leaves the samples unchanged, so this path strips the protection
 * wrapper after key resolution rather than corrupting already-clear samples.
 */
async function decryptCencTrack(
  parsed: ParsedTrack,
  track: MuxTrackInput,
  enc: NonNullable<ParsedTrack['encryption']>,
  keys: Record<string, string>,
  declaredScheme: CencScheme,
  sourceSize: number | undefined,
): Promise<MuxTrackInput> {
  const containerScheme: CencScheme = enc.schemeType === CBCS_SCHEME ? CBCS_SCHEME : CENC_SCHEME;
  if (containerScheme !== declaredScheme) {
    throw new MediaError(
      'demux-error',
      `track ${parsed.id} is '${containerScheme}'-protected but decrypt was asked for '${declaredScheme}' (scheme mismatch)`,
    );
  }
  if (parsed.samples.sampleSizes.length === 0) {
    throw new MediaError(
      'demux-error',
      `${containerScheme}-protected track ${parsed.id} is not decryptable by this path: the sample table is empty (malformed or fragmented protection metadata)`,
    );
  }
  const tenc = parseTenc(enc.tenc, containerScheme);
  const key = resolveKey(keys, tenc.kid);
  const senc = cencSamplesForTrack(enc, tenc, containerScheme, parsed.id);
  if (senc === undefined) return track;
  // A protected track's ciphertext must lie entirely within the file; a truncated mdat (sample bytes
  // promised by the index but missing) is rejected rather than decrypted from a clamped short buffer.
  if (sourceSize !== undefined) assertSampleRangesInBounds(parsed, sourceSize);
  if (senc.length !== track.samples.length) {
    throw new MediaError(
      'demux-error',
      `senc describes ${senc.length} samples but the track has ${track.samples.length} (corrupt sample-encryption metadata)`,
    );
  }
  const cipher = track.samples.map((s) => s.data);
  const clear =
    containerScheme === CBCS_SCHEME
      ? await decryptSamplesCbcs(
          key,
          cipher,
          senc,
          tenc.pattern ?? { cryptByteBlock: 1, skipByteBlock: 0 }, // version-0 cbcs ⇒ full CBC, no pattern
          tenc.constantIv,
        )
      : await decryptSamples(key, cipher, senc);
  return { ...track, samples: track.samples.map((s, j) => ({ ...s, data: clear[j] ?? s.data })) };
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
function fragmentedStream(tracks: readonly MuxTrackInput[]): ReadableStream<Uint8Array> {
  const segments = fragmentMp4(tracks);
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

function lazyFragmentTracksFromMovie(ra: RandomAccess, movie: Movie): LazyFragmentTrack[] {
  const tracks = movie.tracks.map((track): LazyFragmentTrack => {
    const samples = buildSampleData(track);
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

function lazyProgressiveTracksFromMovie(ra: RandomAccess, movie: Movie): LazyProgressiveTrack[] {
  const tracks = movie.tracks.map((track): LazyProgressiveTrack => {
    const samples = buildSampleData(track);
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
  window: SampleReadWindow,
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

async function* progressiveSourceSegments(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  const signal = o?.signal;
  const tracks = lazyProgressiveTracksFromMovie(ra, movie);
  const layout = planMp4ByteStreamLayout(
    tracks.map((track) => track.metadata),
    { faststart: o?.faststart ?? true, brand: brandFor(o?.container) },
  );
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw abortedError();
  };
  const yieldPayloads = async function* (): AsyncGenerator<Uint8Array, void, undefined> {
    for (const track of tracks) {
      for (const window of planOrderedSampleReadWindows(track.samples)) {
        throwIfAborted();
        const chunk = await readProgressivePayloadChunk(ra, window);
        throwIfAborted();
        yield chunk;
      }
    }
  };

  throwIfAborted();
  yield layout.ftyp;
  if (layout.mdatBeforeMoov) {
    yield layout.mdatHeader;
    yield* yieldPayloads();
    yield layout.moov;
    return;
  }
  yield layout.moov;
  yield layout.mdatHeader;
  yield* yieldPayloads();
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

async function materializeProgressiveSourceBytes(
  ra: RandomAccess,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): Promise<Uint8Array> {
  const signal = o?.signal;
  const tracks = lazyProgressiveTracksFromMovie(ra, movie);
  const layout = planMp4ByteStreamLayout(
    tracks.map((track) => track.metadata),
    { faststart: o?.faststart ?? true, brand: brandFor(o?.container) },
  );
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw abortedError();
  };

  throwIfAborted();
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

  for (const track of tracks) {
    for (const window of planOrderedSampleReadWindows(track.samples)) {
      throwIfAborted();
      const span = await ra.read(window.start, window.end - window.start);
      if (span.byteLength !== window.end - window.start) {
        throw new MediaError(
          'demux-error',
          `sample window [${window.start}, ${window.end}) short read: got ${span.byteLength} of ${
            window.end - window.start
          } bytes (truncated MP4)`,
        );
      }
      throwIfAborted();
      for (const item of window.items) {
        const rel = item.sample.offset - window.start;
        out.set(span.subarray(rel, rel + item.sample.size), p);
        p += item.sample.size;
      }
    }
  }

  const payloadEnd = payloadStart + layout.mdatPayloadLen;
  if (p !== payloadEnd) {
    throw new MediaError(
      'mux-error',
      `internal MP4 layout mismatch: wrote ${p - payloadStart} payload bytes, expected ${layout.mdatPayloadLen}`,
    );
  }
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

/**
 * Same-container MP4/MOV streaming copy, lazy on both output and sample payload reads. The init segment is
 * emitted before any mdat bytes are read; each later pull reads only that fragment's source sample windows
 * and serializes one `moof`+`mdat`.
 */
function fragmentedSourceStream(
  ra: RandomAccess,
  movie: Movie,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const tracks = lazyFragmentTracksFromMovie(ra, movie);
  const plans = tracks.map((track) =>
    planLazySampleDataFragmentRuns(
      track.samples,
      LAZY_FRAGMENT_TARGET_SAMPLES,
      track.metadata.mediaType === 'video',
      LAZY_FRAGMENT_HARD_VIDEO_SAMPLES,
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
          controller.enqueue(fragmentMp4InitSegment(tracks.map((track) => track.metadata)));
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
            runSpecs.push({ trackId: ti + 1, samples: run, baseDecodeTime: base });
            let duration = 0;
            for (const sample of run) duration += sample.durationTicks;
            baseDts[ti] = base + duration;
          }
          step++;
          if (runSpecs.length === 0) continue;
          const runs = [];
          for (const run of runSpecs) {
            if (signal?.aborted) throw abortedError();
            runs.push({
              trackId: run.trackId,
              samples: await readSamples(ra, run.samples),
              baseDecodeTime: run.baseDecodeTime,
            });
          }
          if (signal?.aborted) throw abortedError();
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
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const ra = await randomAccess(src);
    const movie = await readMovie(ra);
    const byId = new Map(movie.tracks.map((t) => [t.id, t]));
    const signal = o?.signal;
    const supportsPacketTable = hasCompleteSampleTables(movie);
    return {
      tracks: movie.tracks.map(toTrackInfo),
      ...(supportsPacketTable ? { packetTable: () => mp4PacketMetadata(movie, ra.size) } : {}),
      packets(trackId: number): ReadableStream<Packet> {
        const track = byId.get(trackId);
        if (!track) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(ra, track, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    const ra = await randomAccess(src);
    const movie = await readMovie(ra);
    const trim = o?.trim;
    if (o?.fragmented === true && trim === undefined) {
      return fragmentedSourceStream(ra, movie, o?.signal);
    }
    if (o?.streaming === true && trim === undefined) {
      return progressiveSourceStream(ra, movie, o);
    }
    if (o?.buffered === true && trim === undefined) {
      return progressiveSourceBufferStream(ra, movie, o);
    }
    const tracks = trim
      ? await trimMuxTracks(ra, movie, trim.startSec, trim.endSec, o?.signal)
      : await muxTracksFromMovie(ra, movie);
    // Fragmented/CMAF output (ADR-034): a sequence of self-describing `moof`+`mdat` segments after the
    // init segment, streamed one at a time so a StreamTarget never buffers the whole movie. The lossless
    // sample copy (DTS/ctts/codec-private preserved) is identical; only the on-disk box layout differs.
    if (o?.fragmented === true) return fragmentedStream(tracks);
    const bytes = writeMp4(tracks, {
      faststart: o?.faststart ?? true,
      brand: brandFor(o?.container),
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

    // CENC sample decryption: 'cenc' (AES-CTR) or 'cbcs' (AES-CBC pattern). Anything else is unsupported.
    if (o.scheme !== CENC_SCHEME && o.scheme !== CBCS_SCHEME) {
      throw new CapabilityError(
        'capability-miss',
        `the mp4 driver decrypts CENC ('cenc'/'cbcs') and HLS ('hls-aes128'); '${o.scheme}' is not supported`,
        { op: 'decrypt', tried: ['mp4'] },
      );
    }
    const movie = await readMovie(ra);
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
      out.push(await decryptCencTrack(parsed, track, enc, o.keys, o.scheme, sourceSize));
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
