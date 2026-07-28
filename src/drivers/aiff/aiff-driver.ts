/**
 * The AIFF / AIFF-C container driver — hand-written TS. AIFF is **big-endian** IFF (`FORM…AIFF`/`AIFC`)
 * carrying raw PCM (or, in AIFF-C, big-endian float or byte-swapped `sowt` little-endian PCM), so demux
 * is a chunk walk: `COMM` for the layout, `SSND` for the samples. PCM is not a WebCodecs codec — it flows
 * to the TS audio-dsp path — so the packet seam raises a typed {@link CapabilityError} and the codec
 * token is `pcm-s8` / `pcm-s16be` / `pcm-s24be` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type Muxer,
  type Packet,
  type PacketInfoMetadata,
  type PacketInfoTable,
  type PcmTransform,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type InterleavedPcmF32,
  type PcmAudio,
  bytesPerSample,
  decodePcmToInterleavedF32,
} from '../../dsp/pcm.ts';
import { fromURL } from '../../sources/source.ts';
import { rejectRawPcmChunkMux } from '../audio-container-mux-validation.ts';
import { matchesAiff } from '../audio-container-sniff.ts';
import { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { trySliceAiffPcm } from './aiff-slice.ts';
import {
  type AiffKind,
  type AiffLayout,
  aiffPcmSampleBytes,
  locate,
  parseAiff,
  parseAiffCommBody,
  readAiffPcm,
} from './aiff.ts';

const AIFF_PROBE_HEAD_BYTES = 64;
const AIFF_PACKET_INFO_HEAD_BYTES = 65536;
const AIFF_PACKET_TARGET_BYTES = 4096;
const AIFF_PACKET_INFO_PREFIX_TTL_MS = 60_000;
const AIFF_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES = 64;
const AIFF_DECODE_CHUNK_FRAMES = 4096;
const AIFF_DECODE_RANGE_BYTES = 1024 * 1024;
const AIFF_DECODE_SPOOL_SEGMENT_BYTES = 1024 * 1024;
const AIFF_DECODE_MAX_SPOOL_BYTES = 16 * 1024 * 1024;
const AIFF_DECODE_MAX_CHUNKS = 8192;
const OPERATION_ABORTED = 'operation aborted';

export interface AiffPacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface AiffPacketInfoPrefixCacheEntry {
  readonly bytes: Uint8Array;
  readonly totalSize?: number;
  readonly expiresAtMs: number;
}

const aiffPacketInfoPrefixCache = new Map<string, AiffPacketInfoPrefixCacheEntry>();

async function readRange(
  src: ByteSource,
  range: NonNullable<ByteSource['range']>,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertNotAborted(signal);
  try {
    const bytes = await range.call(src, start, end, signal);
    assertNotAborted(signal);
    return bytes;
  } catch (error) {
    assertNotAborted(signal);
    throw error;
  }
}

async function readHead(src: ByteSource, n: number, signal?: AbortSignal): Promise<Uint8Array> {
  assertNotAborted(signal);
  if (src.range) {
    return readRange(src, src.range, 0, Math.min(n, src.size ?? n), signal);
  }
  const reader = src.stream().getReader();
  const abortReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    const { value } = await reader.read();
    assertNotAborted(signal);
    return value ?? new Uint8Array(0);
  } finally {
    signal?.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read the whole source — PCM transforms need every sample (bounded by file size). */
async function readAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  assertNotAborted(signal);
  if (src.range && src.size !== undefined) {
    return readRange(src, src.range, 0, src.size, signal);
  }
  const reader = src.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      assertNotAborted(signal);
      if (done) {
        completed = true;
        break;
      }
      parts.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of parts) {
      out.set(c, off);
      off += c.byteLength;
    }
    assertNotAborted(signal);
    return out;
  } catch (error) {
    if (!completed && signal?.aborted !== true) await reader.cancel(error).catch(() => {});
    assertNotAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

function aiffTrackInfo(info: ReturnType<typeof parseAiff>): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

function aiffPacketInfoFromLocatedBytes(
  bytes: Uint8Array,
  totalSize = bytes.byteLength,
): PacketInfoTable {
  const { layout, ssndSampleOffset, ssndSampleBytes } = locate(bytes, totalSize);
  const codec =
    layout.format === 'f32'
      ? 'pcm-f32'
      : layout.format === 'f64'
        ? 'pcm-f64'
        : layout.format === 's8'
          ? 'pcm-s8'
          : layout.endian === 'be'
            ? `pcm-${layout.format}be`
            : `pcm-${layout.format}`;
  const sampleRate = Math.round(layout.sampleRate);
  const track: TrackInfo = {
    id: 0,
    mediaType: 'audio',
    codec,
    durationSec: layout.sampleRate > 0 ? layout.frames / layout.sampleRate : 0,
    config: { codec, sampleRate, numberOfChannels: layout.channels },
  };
  const packets: PacketInfoMetadata[] = [];
  const bytesPerFrame = bytesPerSample(layout.format) * layout.channels;
  const sampleBytes =
    ssndSampleOffset < 0 && bytes.byteLength < totalSize
      ? 0
      : aiffPcmSampleBytes(layout, ssndSampleOffset, ssndSampleBytes);
  if (ssndSampleOffset >= 0 && bytesPerFrame > 0 && sampleRate > 0 && sampleBytes > 0) {
    const totalFrames = layout.frames;
    // FFmpeg's PCM demuxers target a 4 KiB packet payload, rounded down to a complete interleaved
    // sample frame. Keeping the policy byte-oriented is important: mono s16 is 2,048 frames/packet,
    // stereo s16 is 1,024, and mono s24 is 1,365 (4,095 bytes). A frame-oriented constant gives the
    // wrong packet table for every layout except stereo s16.
    const packetFrames = Math.max(1, Math.floor(AIFF_PACKET_TARGET_BYTES / bytesPerFrame));
    for (let frame = 0; frame < totalFrames; frame += packetFrames) {
      const frames = Math.min(packetFrames, totalFrames - frame);
      const ptsUs = Math.round((frame / sampleRate) * 1_000_000);
      packets.push({
        trackIndex: 0,
        offset: ssndSampleOffset + frame * bytesPerFrame,
        size: frames * bytesPerFrame,
        ptsUs,
        dtsUs: ptsUs,
        durationUs: Math.round((frames / sampleRate) * 1_000_000),
        keyframe: true,
      });
    }
  }
  return { tracks: [track], packets };
}

export function aiffPacketInfoFromBytes(bytes: Uint8Array): PacketInfoTable {
  return aiffPacketInfoFromLocatedBytes(bytes);
}

function aiffPacketInfoUrlCacheKey(url: string | URL, opts: AiffPacketInfoFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function cachedAiffPacketInfoPrefix(
  key: string,
  totalSize: number | undefined,
): PacketInfoTable | undefined {
  const entry = aiffPacketInfoPrefixCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    aiffPacketInfoPrefixCache.delete(key);
    return undefined;
  }
  const table = aiffPacketInfoFromLocatedBytes(
    entry.bytes,
    totalSize ?? entry.totalSize ?? entry.bytes.byteLength,
  );
  return table.packets.length > 0 ? table : undefined;
}

function storeAiffPacketInfoPrefix(
  key: string,
  bytes: Uint8Array,
  totalSize: number | undefined,
): void {
  const now = Date.now();
  for (const [entryKey, entry] of aiffPacketInfoPrefixCache) {
    if (entry.expiresAtMs <= now) aiffPacketInfoPrefixCache.delete(entryKey);
  }
  while (aiffPacketInfoPrefixCache.size >= AIFF_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES) {
    const oldest = aiffPacketInfoPrefixCache.keys().next().value as string;
    aiffPacketInfoPrefixCache.delete(oldest);
  }
  aiffPacketInfoPrefixCache.set(key, {
    bytes: bytes.slice(),
    ...(totalSize !== undefined ? { totalSize } : {}),
    expiresAtMs: now + AIFF_PACKET_INFO_PREFIX_TTL_MS,
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

interface ParsedAiffPcmDecode {
  readonly layout: AiffLayout;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly bytesPerFrame: number;
}

interface AiffPcmChunkReader {
  read(start: number, end: number): Promise<Uint8Array>;
  release(reason?: unknown): void | Promise<void>;
}

interface SequentialByteCursor {
  readonly position: number;
  read(length: number): Promise<Uint8Array>;
  skip(length: number): Promise<boolean>;
  release(reason?: unknown): Promise<void>;
}

interface SequentialAiffDecode {
  readonly parsed: ParsedAiffPcmDecode;
  readonly chunks: AiffPcmChunkReader;
}

const EMPTY_BYTES = new Uint8Array(0);

function parsedAiffPcmDecode(
  layout: AiffLayout,
  dataOffset: number,
  dataBytes: number,
): ParsedAiffPcmDecode {
  const bytesPerFrame = bytesPerSample(layout.format) * layout.channels;
  if (!Number.isSafeInteger(bytesPerFrame) || bytesPerFrame <= 0) {
    throw new MediaError('demux-error', `AIFF: invalid PCM frame size ${bytesPerFrame}`);
  }
  const sampleBytes = aiffPcmSampleBytes(layout, dataOffset, dataBytes);
  return {
    layout,
    dataOffset: Math.max(0, dataOffset),
    dataBytes: sampleBytes,
    bytesPerFrame,
  };
}

function aiffKindAndEnd(
  bytes: Uint8Array,
  totalSize: number | undefined,
): { readonly kind: AiffKind; readonly formEnd: number } {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0, 4) !== 'FORM' ||
    (ascii(bytes, 8, 4) !== 'AIFF' && ascii(bytes, 8, 4) !== 'AIFC')
  ) {
    throw new InputError('not an AIFF/AIFF-C (FORM…AIFF/AIFC) file');
  }
  const declaredEnd =
    8 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  const formEnd = Math.min(declaredEnd, totalSize ?? declaredEnd);
  if (formEnd < 12) throw new MediaError('demux-error', 'AIFF: truncated FORM header');
  return {
    kind: ascii(bytes, 8, 4) === 'AIFC' ? 'aifc' : 'aiff',
    formEnd,
  };
}

async function rangeBackedAiffDecode(
  source: ByteSource,
  sourceRange: NonNullable<ByteSource['range']>,
  signal?: AbortSignal,
): Promise<{ readonly parsed: ParsedAiffPcmDecode; readonly prefix: Uint8Array }> {
  assertNotAborted(signal);
  const initialEnd = Math.min(
    source.size ?? AIFF_PACKET_INFO_HEAD_BYTES,
    AIFF_PACKET_INFO_HEAD_BYTES,
  );
  const prefix = await readRange(source, sourceRange, 0, initialEnd, signal);
  const { kind, formEnd } = aiffKindAndEnd(prefix, source.size);
  let windowStart = 0;
  let window = prefix;

  const readAt = async (start: number, length: number): Promise<Uint8Array> => {
    assertNotAborted(signal);
    const windowEnd = windowStart + window.byteLength;
    if (start >= windowStart && start + length <= windowEnd) {
      return window.subarray(start - windowStart, start - windowStart + length);
    }
    const requestEnd = Math.min(formEnd, start + Math.max(AIFF_PACKET_INFO_HEAD_BYTES, length));
    if (requestEnd <= start) return EMPTY_BYTES;
    const bytes = await readRange(source, sourceRange, start, requestEnd, signal);
    windowStart = start;
    window = bytes;
    return bytes.subarray(0, Math.min(length, bytes.byteLength));
  };

  let comm: Omit<AiffLayout, 'kind'> | undefined;
  let sound:
    | {
        readonly offset: number;
        readonly bytes: number;
      }
    | undefined;
  let pos = 12;
  let chunkCount = 0;
  while (pos + 8 <= formEnd && chunkCount < AIFF_DECODE_MAX_CHUNKS) {
    const header = await readAt(pos, 8);
    if (header.byteLength < 8) {
      throw new MediaError('demux-error', 'AIFF: truncated chunk header');
    }
    const id = ascii(header, 0, 4);
    const size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4);
    const body = pos + 8;
    if (id === 'COMM' && comm === undefined) {
      const needed = kind === 'aifc' ? 22 : 18;
      if (size < needed) throw new MediaError('demux-error', 'AIFF: truncated COMM chunk');
      const commBody = await readAt(body, needed);
      comm = parseAiffCommBody(commBody, kind);
    } else if (id === 'SSND' && sound === undefined) {
      if (size < 8) throw new MediaError('demux-error', 'AIFF: truncated SSND chunk');
      const prefixBytes = await readAt(body, 8);
      if (prefixBytes.byteLength < 8) {
        throw new MediaError('demux-error', 'AIFF: truncated SSND chunk');
      }
      const dataOffset = new DataView(
        prefixBytes.buffer,
        prefixBytes.byteOffset,
        prefixBytes.byteLength,
      ).getUint32(0);
      if (dataOffset > size - 8) {
        throw new MediaError('demux-error', 'AIFF: invalid SSND sample offset');
      }
      const offset = body + 8 + dataOffset;
      const declaredBytes = size - 8 - dataOffset;
      sound = {
        offset,
        bytes: Math.max(0, Math.min(declaredBytes, formEnd - offset)),
      };
    }
    if (comm !== undefined && sound !== undefined) break;
    const next = body + size + (size & 1);
    if (!Number.isSafeInteger(next) || next <= pos) {
      throw new MediaError('demux-error', 'AIFF: invalid chunk size');
    }
    pos = next;
    chunkCount++;
  }
  if (chunkCount >= AIFF_DECODE_MAX_CHUNKS) {
    throw new MediaError('demux-error', 'AIFF: chunk table exceeds safety limit');
  }
  if (comm === undefined) throw new MediaError('demux-error', 'AIFF: no COMM chunk');
  const layout: AiffLayout = { kind, ...comm };
  return {
    parsed: parsedAiffPcmDecode(layout, sound?.offset ?? -1, sound?.bytes ?? 0),
    prefix,
  };
}

function rangeBackedAiffChunkReader(
  source: ByteSource,
  sourceRange: NonNullable<ByteSource['range']>,
  prefix: Uint8Array,
  dataEnd: number,
  signal?: AbortSignal,
): AiffPcmChunkReader {
  let windowStart = 0;
  let window = prefix;
  let activeSource: ByteSource | undefined = source;
  let activeRange: NonNullable<ByteSource['range']> | undefined = sourceRange;
  const rangeAbort = new AbortController();
  const forwardAbort = (): void => {
    if (!rangeAbort.signal.aborted) rangeAbort.abort(signal?.reason);
  };
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  return {
    async read(start, end): Promise<Uint8Array> {
      assertNotAborted(signal);
      const readSource = activeSource;
      const sourceReadRange = activeRange;
      if (readSource === undefined || sourceReadRange === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      const windowEnd = windowStart + window.byteLength;
      if (start >= windowStart && end <= windowEnd) {
        return window.subarray(start - windowStart, end - windowStart);
      }
      const overlapBytes = start >= windowStart && start < windowEnd ? windowEnd - start : 0;
      const requestStart = overlapBytes > 0 ? windowEnd : start;
      const requestEnd = Math.min(dataEnd, Math.max(end, requestStart + AIFF_DECODE_RANGE_BYTES));
      const previousWindow = window;
      const previousWindowStart = windowStart;
      const nextWindow = await readRange(
        readSource,
        sourceReadRange,
        requestStart,
        requestEnd,
        rangeAbort.signal,
      );
      if (signal?.aborted || activeSource === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED, signal?.reason);
      }
      window = nextWindow;
      windowStart = requestStart;
      if (overlapBytes > 0) {
        const suffixBytes = Math.min(end - requestStart, window.byteLength);
        const bytes = new Uint8Array(overlapBytes + suffixBytes);
        bytes.set(
          previousWindow.subarray(
            start - previousWindowStart,
            start - previousWindowStart + overlapBytes,
          ),
        );
        bytes.set(window.subarray(0, suffixBytes), overlapBytes);
        return bytes;
      }
      return window.subarray(0, Math.min(end - start, window.byteLength));
    },
    release(reason): void {
      signal?.removeEventListener('abort', forwardAbort);
      if (!rangeAbort.signal.aborted) rangeAbort.abort(reason);
      activeSource = undefined;
      activeRange = undefined;
      window = EMPTY_BYTES;
      windowStart = 0;
    },
  };
}

function sequentialByteCursor(src: ByteSource, signal?: AbortSignal): SequentialByteCursor {
  const reader = src.stream().getReader();
  let chunk: Uint8Array = EMPTY_BYTES;
  let chunkOffset = 0;
  let position = 0;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const abortReader = (): void => {
    void release(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });

  const release = (reason?: unknown): Promise<void> => {
    releasePromise ??= (async () => {
      released = true;
      chunk = EMPTY_BYTES;
      chunkOffset = 0;
      signal?.removeEventListener('abort', abortReader);
      try {
        await reader.cancel(reason).catch(() => {});
      } finally {
        reader.releaseLock();
      }
    })();
    return releasePromise;
  };

  const nextChunk = async (): Promise<boolean> => {
    for (;;) {
      if (released || signal?.aborted) {
        throw new MediaError('aborted', OPERATION_ABORTED, signal?.reason);
      }
      const next = await reader.read().catch((error: unknown): never => {
        if (signal?.aborted) {
          throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
        }
        if (error instanceof MediaError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new MediaError('demux-error', `AIFF source read failed: ${message}`, error);
      });
      if (released || signal?.aborted) {
        throw new MediaError('aborted', OPERATION_ABORTED, signal?.reason);
      }
      if (next.done) return false;
      if (next.value.byteLength === 0) continue;
      chunk = next.value;
      chunkOffset = 0;
      return true;
    }
  };

  const read = async (length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MediaError('demux-error', `invalid AIFF sequential read length ${length}`);
    }
    if (length === 0) return EMPTY_BYTES;
    let available = chunk.byteLength - chunkOffset;
    if (available === 0 && !(await nextChunk())) return EMPTY_BYTES;
    available = chunk.byteLength - chunkOffset;
    if (available >= length) {
      const bytes = chunk.subarray(chunkOffset, chunkOffset + length);
      chunkOffset += length;
      position += length;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
      return bytes;
    }

    const bytes = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      available = chunk.byteLength - chunkOffset;
      if (available === 0) {
        if (!(await nextChunk())) break;
        continue;
      }
      const count = Math.min(available, length - written);
      bytes.set(chunk.subarray(chunkOffset, chunkOffset + count), written);
      chunkOffset += count;
      written += count;
      position += count;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
    }
    return written === length ? bytes : bytes.subarray(0, written);
  };

  const skip = async (length: number): Promise<boolean> => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MediaError('demux-error', `invalid AIFF sequential skip length ${length}`);
    }
    let remaining = length;
    while (remaining > 0) {
      let available = chunk.byteLength - chunkOffset;
      if (available === 0) {
        if (!(await nextChunk())) return false;
        available = chunk.byteLength - chunkOffset;
      }
      const count = Math.min(available, remaining);
      chunkOffset += count;
      position += count;
      remaining -= count;
      if (chunkOffset === chunk.byteLength) {
        chunk = EMPTY_BYTES;
        chunkOffset = 0;
      }
    }
    return true;
  };

  return {
    get position(): number {
      return position;
    },
    read,
    skip,
    release,
  };
}

function sequentialAiffChunkReader(
  cursor: SequentialByteCursor,
  dataOffset: number,
): AiffPcmChunkReader {
  let position = dataOffset;
  let active: SequentialByteCursor | undefined = cursor;
  return {
    async read(start, end): Promise<Uint8Array> {
      const current = active;
      if (current === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
      if (start !== position || end < start) {
        throw new MediaError(
          'demux-error',
          'AIFF sequential PCM read moved outside its ordered payload',
        );
      }
      const bytes = await current.read(end - start);
      position += bytes.byteLength;
      return bytes;
    },
    release(reason): Promise<void> {
      const current = active;
      active = undefined;
      return current?.release(reason) ?? Promise.resolve();
    },
  };
}

function blobBackedAiffChunkReader(blob: Blob, signal?: AbortSignal): AiffPcmChunkReader {
  let activeBlob: Blob | undefined = blob;
  return {
    async read(start, end): Promise<Uint8Array> {
      assertNotAborted(signal);
      const sourceBlob = activeBlob;
      if (sourceBlob === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new MediaError('demux-error', 'AIFF spool read moved outside its payload');
      }
      const bytes = new Uint8Array(await sourceBlob.slice(start, end).arrayBuffer());
      assertNotAborted(signal);
      if (activeBlob === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
      return bytes;
    },
    release(): void {
      activeBlob = undefined;
    },
  };
}

async function spoolSequentialAiffBytes(
  cursor: SequentialByteCursor,
  byteLength: number,
  parts: Blob[],
  signal?: AbortSignal,
): Promise<void> {
  let remaining = byteLength;
  while (remaining > 0) {
    assertNotAborted(signal);
    const count = Math.min(remaining, AIFF_DECODE_SPOOL_SEGMENT_BYTES);
    const bytes = await cursor.read(count);
    assertNotAborted(signal);
    if (bytes.byteLength !== count) {
      throw new MediaError('demux-error', 'AIFF: SSND payload ended before its chunk boundary');
    }
    parts.push(new Blob([bytes.slice()]));
    remaining -= count;
  }
}

async function finishSpooledAiffDecode(
  cursor: SequentialByteCursor,
  layout: AiffLayout,
  parts: Blob[],
  availableSampleBytes: number,
  signal?: AbortSignal,
): Promise<SequentialAiffDecode> {
  const parsed = parsedAiffPcmDecode(layout, 0, availableSampleBytes);
  let blob: Blob;
  try {
    blob = new Blob(parts);
  } catch (error) {
    throw new MediaError('demux-error', 'AIFF: unable to finalize the bounded SSND spool', error);
  }
  parts.length = 0;
  await cursor.release('AIFF SSND spool complete');
  assertNotAborted(signal);
  return { parsed, chunks: blobBackedAiffChunkReader(blob, signal) };
}

async function sequentialAiffDecode(
  src: ByteSource,
  signal?: AbortSignal,
): Promise<SequentialAiffDecode> {
  const cursor = sequentialByteCursor(src, signal);
  try {
    const form = await cursor.read(12);
    const { kind, formEnd } = aiffKindAndEnd(form, src.size);
    let comm: Omit<AiffLayout, 'kind'> | undefined;
    let spooledSound:
      | {
          readonly parts: Blob[];
          readonly bytes: number;
        }
      | undefined;
    let chunks = 0;
    while (cursor.position < formEnd) {
      if (chunks >= AIFF_DECODE_MAX_CHUNKS) {
        throw new MediaError('demux-error', 'AIFF: chunk table exceeds safety limit');
      }
      if (formEnd - cursor.position < 8) {
        throw new MediaError('demux-error', 'AIFF: truncated chunk header inside FORM');
      }
      const header = await cursor.read(8);
      if (header.byteLength < 8) {
        throw new MediaError('demux-error', 'AIFF: truncated chunk header');
      }
      const id = ascii(header, 0, 4);
      const size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4);
      const paddedChunkEnd = cursor.position + size + (size & 1);
      if (!Number.isSafeInteger(paddedChunkEnd) || paddedChunkEnd > formEnd) {
        throw new MediaError('demux-error', `AIFF: ${id || 'unknown'} chunk exceeds FORM bounds`);
      }
      if (id === 'COMM' && comm === undefined) {
        const needed = kind === 'aifc' ? 22 : 18;
        if (size < needed) throw new MediaError('demux-error', 'AIFF: truncated COMM chunk');
        const body = await cursor.read(needed);
        comm = parseAiffCommBody(body, kind);
        if (!(await cursor.skip(size - needed + (size & 1)))) {
          throw new MediaError('demux-error', 'AIFF: truncated COMM chunk');
        }
        if (spooledSound !== undefined) {
          return finishSpooledAiffDecode(
            cursor,
            { kind, ...comm },
            spooledSound.parts,
            spooledSound.bytes,
            signal,
          );
        }
      } else if (id === 'SSND') {
        if (spooledSound !== undefined) {
          throw new MediaError('demux-error', 'AIFF: multiple SSND chunks are unsupported');
        }
        if (size < 8) throw new MediaError('demux-error', 'AIFF: truncated SSND chunk');
        const soundHeader = await cursor.read(8);
        if (soundHeader.byteLength < 8) {
          throw new MediaError('demux-error', 'AIFF: truncated SSND chunk');
        }
        const dataOffset = new DataView(
          soundHeader.buffer,
          soundHeader.byteOffset,
          soundHeader.byteLength,
        ).getUint32(0);
        if (dataOffset > size - 8) {
          throw new MediaError('demux-error', 'AIFF: invalid SSND sample offset');
        }
        if (!(await cursor.skip(dataOffset))) {
          throw new MediaError('demux-error', 'AIFF: truncated SSND alignment bytes');
        }
        const sampleOffset = cursor.position;
        const declaredBytes = size - 8 - dataOffset;
        if (comm !== undefined) {
          const parsed = parsedAiffPcmDecode({ kind, ...comm }, sampleOffset, declaredBytes);
          if (parsed.dataBytes === 0) {
            await cursor.release('AIFF contains no declared sample frames');
            return { parsed, chunks: blobBackedAiffChunkReader(new Blob(), signal) };
          }
          return { parsed, chunks: sequentialAiffChunkReader(cursor, sampleOffset) };
        }
        const parts: Blob[] = [];
        if (declaredBytes > AIFF_DECODE_MAX_SPOOL_BYTES) {
          throw new CapabilityError(
            `range-less AIFF places ${declaredBytes} SSND bytes before COMM, exceeding the ${AIFF_DECODE_MAX_SPOOL_BYTES}-byte bounded spool; use a range-capable source`,
            { op: { kind: 'route', id: 'decode' }, tried: ['aiff'] },
          );
        }
        await spoolSequentialAiffBytes(cursor, declaredBytes, parts, signal);
        if ((size & 1) !== 0 && !(await cursor.skip(1))) {
          throw new MediaError('demux-error', 'AIFF: truncated SSND pad byte');
        }
        spooledSound = { parts, bytes: declaredBytes };
      } else if (!(await cursor.skip(size + (size & 1)))) {
        throw new MediaError('demux-error', `AIFF: truncated ${id || 'unknown'} chunk`);
      }
      chunks++;
    }
    if (comm === undefined) throw new MediaError('demux-error', 'AIFF: no COMM chunk');
    const parsed = parsedAiffPcmDecode({ kind, ...comm }, -1, 0);
    await cursor.release('AIFF FORM complete');
    return { parsed, chunks: blobBackedAiffChunkReader(new Blob(), signal) };
  } catch (error) {
    await cursor.release(error);
    throw error;
  }
}

function aiffInterleavedPcmChunkStream(
  parsed: ParsedAiffPcmDecode,
  readChunk: AiffPcmChunkReader,
  signal?: AbortSignal,
): ReadableStream<InterleavedPcmF32> {
  const totalFrames = Math.floor(parsed.dataBytes / parsed.bytesPerFrame);
  const rangeBoundFrames = Math.max(1, Math.floor(AIFF_DECODE_RANGE_BYTES / parsed.bytesPerFrame));
  const framesPerChunk = Math.min(AIFF_DECODE_CHUNK_FRAMES, rangeBoundFrames);
  const sampleRate = Math.round(parsed.layout.sampleRate);
  let frame = 0;
  let chunkReader: AiffPcmChunkReader | undefined = readChunk;
  const releaseChunkReader = async (reason?: unknown): Promise<void> => {
    const active = chunkReader;
    chunkReader = undefined;
    await active?.release(reason);
  };
  return new ReadableStream<InterleavedPcmF32>(
    {
      async pull(controller): Promise<void> {
        try {
          assertNotAborted(signal);
          if (frame >= totalFrames) {
            await releaseChunkReader('AIFF PCM data complete');
            controller.close();
            return;
          }
          const active = chunkReader;
          if (active === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
          const frameCount = Math.min(framesPerChunk, totalFrames - frame);
          const start = parsed.dataOffset + frame * parsed.bytesPerFrame;
          const end = start + frameCount * parsed.bytesPerFrame;
          const bytes = await active.read(start, end);
          assertNotAborted(signal);
          const audio = decodePcmToInterleavedF32(
            bytes,
            parsed.layout.format,
            parsed.layout.channels,
            sampleRate,
            parsed.layout.endian,
          );
          if (audio.frames !== frameCount) {
            throw new MediaError(
              'demux-error',
              'AIFF PCM source ended before the declared SSND payload',
            );
          }
          controller.enqueue(audio);
          frame += frameCount;
          if (frame >= totalFrames) {
            await releaseChunkReader('AIFF PCM data complete');
            controller.close();
          }
        } catch (error) {
          await releaseChunkReader(error);
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        frame = totalFrames;
        await releaseChunkReader(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export async function aiffPacketInfoFromUrl(
  url: string | URL,
  opts: AiffPacketInfoFromUrlOptions = {},
): Promise<PacketInfoTable> {
  assertNotAborted(opts.signal);
  const packetInfo = AiffDriver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('AIFF packet-info is not available', {
      op: { kind: 'route', id: 'demux', facts: { container: 'aiff' } },
      tried: ['aiff'],
    });
  }
  const key = aiffPacketInfoUrlCacheKey(url, opts);
  const cached = cachedAiffPacketInfoPrefix(key, opts.size);
  if (cached !== undefined) return cached;
  const src = fromURL(url, {
    mime: opts.mime ?? 'audio/aiff',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  if (src.range !== undefined) {
    const prefix = await readRange(
      src,
      src.range,
      0,
      opts.size !== undefined
        ? Math.min(opts.size, AIFF_PACKET_INFO_HEAD_BYTES)
        : AIFF_PACKET_INFO_HEAD_BYTES,
      opts.signal,
    );
    const totalSize = src.size ?? opts.size;
    try {
      const table = aiffPacketInfoFromLocatedBytes(prefix, totalSize ?? prefix.byteLength);
      if (table.packets.length > 0 && totalSize !== undefined) {
        storeAiffPacketInfoPrefix(key, prefix, totalSize);
        return table;
      }
    } catch (error) {
      if (totalSize !== undefined) throw error;
    }
  }
  return packetInfo.call(
    AiffDriver,
    src,
    opts.signal !== undefined ? { signal: opts.signal } : undefined,
  );
}

export const AiffDriver: ContainerDriver = {
  id: 'aiff',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['aiff'],
  supports: matchesAiff,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    assertNotAborted(o?.signal);
    let head = await readHead(src, AIFF_PROBE_HEAD_BYTES, o?.signal);
    assertNotAborted(o?.signal);
    try {
      return [aiffTrackInfo(parseAiff(head))];
    } catch (error) {
      const maxFallback = Math.min(
        src.size ?? AIFF_PACKET_INFO_HEAD_BYTES,
        AIFF_PACKET_INFO_HEAD_BYTES,
      );
      if (src.range === undefined || head.byteLength >= maxFallback) throw error;
      head = await readHead(src, AIFF_PACKET_INFO_HEAD_BYTES, o?.signal);
      assertNotAborted(o?.signal);
      return [aiffTrackInfo(parseAiff(head))];
    }
  },
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseAiff(await readHead(src, 65536));
    const track = aiffTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'AIFF PCM flows through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: { kind: 'route', id: 'demux' }, tried: ['aiff'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const head = await readHead(src, 65536, o?.signal);
    assertNotAborted(o?.signal);
    try {
      const table = aiffPacketInfoFromLocatedBytes(head, src.size ?? head.byteLength);
      if (table.packets.length > 0 || (src.size !== undefined && head.byteLength >= src.size)) {
        return table;
      }
    } catch (error) {
      if (src.size !== undefined) throw error;
    }
    const bytes = await readAll(src, o?.signal);
    assertNotAborted(o?.signal);
    return aiffPacketInfoFromLocatedBytes(bytes);
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const bytes = await readAll(src, o?.signal);
    assertNotAborted(o?.signal);
    const container = o?.container ?? 'aiff';
    const sliced = trySliceAiffPcm(bytes, o ?? {});
    if (sliced !== undefined) {
      return new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(sliced);
          c.close();
        },
      });
    }
    const aiff = readAiffPcm(bytes);
    assertNotAborted(o?.signal);
    const audio = applyPcmTransform(aiff, o);
    const out = writePcmContainer(
      audio,
      container,
      resolvePcmSampleFormat(container, aiff.format, o?.sampleFormat),
      o?.endian ?? aiff.endian,
      aiff.kind,
    );
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const aiff = readAiffPcm(await readAll(src, o?.signal));
    assertNotAborted(o?.signal);
    return aiff;
  },
  async decodePcmInterleavedStream(
    src: ByteSource,
    o?: StageOptions,
  ): Promise<ReadableStream<InterleavedPcmF32>> {
    assertNotAborted(o?.signal);
    if (src.range === undefined) {
      const { parsed, chunks } = await sequentialAiffDecode(src, o?.signal);
      if (o?.signal?.aborted) {
        await chunks.release(o.signal.reason);
        assertNotAborted(o.signal);
      }
      return aiffInterleavedPcmChunkStream(parsed, chunks, o?.signal);
    }
    const range = src.range;
    const { parsed, prefix } = await rangeBackedAiffDecode(src, range, o?.signal);
    assertNotAborted(o?.signal);
    return aiffInterleavedPcmChunkStream(
      parsed,
      rangeBackedAiffChunkReader(
        src,
        range,
        prefix,
        parsed.dataOffset + parsed.dataBytes,
        o?.signal,
      ),
      o?.signal,
    );
  },
  createMuxer(): Muxer {
    // AIFF carries raw PCM, not WebCodecs EncodedChunks, so the seam Muxer doesn't map; PCM output is
    // produced by `transformPcm` (writeAiff) — the audio-dsp path (ADR-022), exactly like WAV.
    return rejectRawPcmChunkMux('aiff');
  },
};

export const AiffModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AiffDriver);
  },
};

export default AiffModule;
