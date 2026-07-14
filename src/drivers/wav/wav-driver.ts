/**
 * The WAV (RIFF/WAVE) container driver — hand-written TS. WAV is **little-endian** (unlike MP4) and
 * carries raw PCM (or IEEE float), so demux is a chunk walk: parse `fmt ` for the layout and the
 * `data` chunk header for duration. PCM is not a WebCodecs codec — it flows to the TS audio-dsp path —
 * so the codec token is `pcm-u8` / `pcm-s16` / `pcm-s24` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MuxOptions,
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
  type SampleFormat,
  decodePcm,
  decodePcmToInterleavedF32,
} from '../../dsp/pcm.ts';
import { fromURL } from '../../sources/source.ts';
import { matchesWav } from '../audio-container-sniff.ts';
import { planWavPcmCopy } from './pcm.ts';
import { streamWavPcmCopy } from './wav-copy-stream.ts';
import { WavMuxer } from './wav-mux.ts';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface WavInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export interface WavPacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

interface ParsedWavHeader {
  info: WavInfo;
  format: WavFormat;
  dataOffset: number;
  dataBytes: number;
  bytesPerFrame: number;
  dataFound: boolean;
}

interface SequentialWavDecode {
  readonly parsed: ParsedWavHeader;
  readonly chunks: PcmChunkReader;
}

const WAV_PROBE_HEAD_BYTES = 128;
const WAV_REMOTE_PROBE_HEAD_BYTES = 16 * 1024;
const WAV_PROBE_MAX_SPARSE_WINDOWS = 8;
const WAV_DEMUX_HEAD_BYTES = 65536;
const WAV_PACKET_FRAMES = 4096;
const WAV_DECODE_RANGE_BYTES = 1024 * 1024;
const WAV_PACKET_INFO_PREFIX_TTL_MS = 60_000;
const WAV_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES = 64;
const OPERATION_ABORTED = 'operation aborted';

interface WavPacketInfoPrefixCacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

const wavPacketInfoPrefixCache = new Map<string, WavPacketInfoPrefixCacheEntry>();

/** PCM/float codec token per WebCodecs/harness vocabulary (LE; WAV BE variants are out of scope). */
function pcmCodec(fmt: WavFormat): string {
  if (fmt.formatTag === 3) return fmt.bitsPerSample === 64 ? 'pcm-f64' : 'pcm-f32';
  if (fmt.bitsPerSample === 8) return 'pcm-u8'; // 8-bit WAV PCM is unsigned (offset binary)
  return `pcm-s${fmt.bitsPerSample}`;
}

function pcmSampleFormat(fmt: WavFormat): SampleFormat {
  if (fmt.formatTag === 1) {
    if (fmt.bitsPerSample === 8) return 'u8';
    if (fmt.bitsPerSample === 16) return 's16';
    if (fmt.bitsPerSample === 24) return 's24';
    if (fmt.bitsPerSample === 32) return 's32';
  } else if (fmt.formatTag === 3) {
    if (fmt.bitsPerSample === 32) return 'f32';
    if (fmt.bitsPerSample === 64) return 'f64';
  }
  throw new InputError(
    'unsupported-input',
    `unsupported WAV PCM layout (tag ${fmt.formatTag}, ${fmt.bitsPerSample}-bit)`,
  );
}

function parseFormat(dv: DataView, body: number, size: number): WavFormat {
  let formatTag = dv.getUint16(body, true);
  // WAVE_FORMAT_EXTENSIBLE: the effective tag is the first 2 bytes of the SubFormat GUID (+24), so
  // float-extensible (tag 3) is not mislabeled as PCM. Fall back to PCM if the chunk is too short.
  if (formatTag === 0xfffe) formatTag = size >= 40 ? dv.getUint16(body + 24, true) : 1;
  return {
    formatTag,
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    byteRate: dv.getUint32(body + 8, true),
    blockAlign: dv.getUint16(body + 12, true),
    bitsPerSample: dv.getUint16(body + 14, true),
  };
}

function parseWavHeader(bytes: Uint8Array, totalSize?: number): ParsedWavHeader {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let dataSize = 0;
  let dataFound = false;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      if (body + 16 > bytes.byteLength) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      format = parseFormat(dv, body, size);
    } else if (id === 'data') {
      // Trust the declared size for duration, but never exceed the real file length.
      dataSize = totalSize !== undefined ? Math.min(size, Math.max(0, totalSize - body)) : size;
      dataFound = true;
      break;
    }
    pos = body + size + (size & 1); // chunks are padded to an even size
  }
  if (!format) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');

  return parsedWavHeader(format, dataFound ? pos + 8 : 0, dataSize, dataFound);
}

interface WavProbeWindow {
  readonly start: number;
  readonly bytes: Uint8Array;
}

function wavProbeHeadBytes(src: ByteSource): number {
  const kind = (src as ByteSource & { readonly kind?: string }).kind;
  // One remote round trip costs more than copying a modest RIFF metadata prelude. Local byte/blob
  // sources retain the minimum 128-byte window; URL/element sources amortize ordinary LIST/JUNK/PAD
  // chunks without changing the sparse declared-offset walk or its fallback bound.
  return kind === 'url' || kind === 'element' ? WAV_REMOTE_PROBE_HEAD_BYTES : WAV_PROBE_HEAD_BYTES;
}

/**
 * Read RIFF metadata without materializing skipped chunk bodies. A small window handles ordinary WAV
 * headers in one request; declared JUNK/LIST/PAD bodies are crossed by offset and cost only one more
 * bounded window. An unusually fragmented metadata prelude falls back to the established 64 KiB parser
 * after a fixed number of sparse requests, so adversarial chunk tables cannot amplify round trips.
 */
async function readSparseWavProbeHeader(
  src: ByteSource,
  range: NonNullable<ByteSource['range']>,
  size: number,
  windowBytes: number,
  signal: AbortSignal | undefined,
  initialBytes: Uint8Array,
): Promise<ParsedWavHeader | undefined> {
  let windows = 1;
  let window: WavProbeWindow = { start: 0, bytes: initialBytes };
  const readAt = async (start: number, length: number): Promise<Uint8Array | undefined> => {
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
    if (
      start >= window.start &&
      start + length <= window.start + window.bytes.byteLength
    ) {
      return window.bytes.subarray(start - window.start, start - window.start + length);
    }
    if (windows >= WAV_PROBE_MAX_SPARSE_WINDOWS) return undefined;
    const end = Math.min(size, start + Math.max(windowBytes, length));
    const bytes = await range.call(src, start, end);
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
    windows++;
    window = { start, bytes };
    return bytes.subarray(0, Math.min(length, bytes.byteLength));
  };

  const riff = await readAt(0, 12);
  if (riff === undefined) return undefined;
  if (riff.byteLength < 12 || ascii(riff, 0, 4) !== 'RIFF' || ascii(riff, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }

  let format: WavFormat | undefined;
  let dataOffset = 0;
  let dataBytes = 0;
  let dataFound = false;
  let pos = 12;
  let chunks = 0;
  while (pos + 8 <= size && chunks < 8192) {
    const header = await readAt(pos, 8);
    if (header === undefined) return undefined;
    if (header.byteLength < 8) break;
    const id = ascii(header, 0, 4);
    const chunkSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
      4,
      true,
    );
    const body = pos + 8;
    if (id === 'fmt ' && chunkSize >= 16) {
      const needed = chunkSize >= 40 ? 26 : 16;
      const bodyBytes = await readAt(body, needed);
      if (bodyBytes === undefined) return undefined;
      if (bodyBytes.byteLength < needed) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      const bodyView = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength);
      format = parseFormat(bodyView, 0, chunkSize);
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(chunkSize, Math.max(0, size - body));
      dataFound = true;
      break;
    }
    const next = body + chunkSize + (chunkSize & 1);
    pos = next;
    chunks++;
  }
  if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
  return parsedWavHeader(format, dataOffset, dataBytes, dataFound);
}

function parsedWavHeader(
  format: WavFormat,
  dataOffset: number,
  dataBytes: number,
  dataFound: boolean,
): ParsedWavHeader {
  const bytesPerFrame =
    format.blockAlign > 0 ? format.blockAlign : (format.bitsPerSample >> 3) * format.channels;
  const byteRate = format.byteRate > 0 ? format.byteRate : bytesPerFrame * format.sampleRate;
  return {
    info: {
      codec: pcmCodec(format),
      sampleRate: format.sampleRate,
      channels: format.channels,
      durationSec: byteRate > 0 ? dataBytes / byteRate : 0,
    },
    format,
    dataOffset,
    dataBytes,
    bytesPerFrame,
    dataFound,
  };
}

/** Parse a RIFF/WAVE header into the audio layout + duration. Pure; little-endian. */
export function parseWav(bytes: Uint8Array, totalSize?: number): WavInfo {
  return parseWavHeader(bytes, totalSize).info;
}

function wavTrackInfo(info: WavInfo): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

function wavPacketInfoFromHeader(parsed: ParsedWavHeader): PacketInfoTable {
  const track = wavTrackInfo(parsed.info);
  const packets: PacketInfoMetadata[] = [];
  const { bytesPerFrame, dataBytes } = parsed;
  if (parsed.dataFound && bytesPerFrame > 0 && parsed.info.sampleRate > 0 && dataBytes > 0) {
    const totalFrames = Math.floor(dataBytes / bytesPerFrame);
    for (let frame = 0; frame < totalFrames; frame += WAV_PACKET_FRAMES) {
      const frames = Math.min(WAV_PACKET_FRAMES, totalFrames - frame);
      const ptsUs = Math.round((frame / parsed.info.sampleRate) * 1_000_000);
      packets.push({
        trackIndex: 0,
        offset: parsed.dataOffset + frame * bytesPerFrame,
        size: frames * bytesPerFrame,
        ptsUs,
        dtsUs: ptsUs,
        durationUs: Math.round((frames / parsed.info.sampleRate) * 1_000_000),
        keyframe: true,
      });
    }
  }
  return { tracks: [track], packets };
}

export function wavPacketInfoFromBytes(bytes: Uint8Array): PacketInfoTable {
  return wavPacketInfoFromHeader(parseWavHeader(bytes, bytes.byteLength));
}

function wavPacketInfoUrlCacheKey(url: string | URL, opts: WavPacketInfoFromUrlOptions): string {
  const href = typeof url === 'string' ? url : url.href;
  return `${href}#${opts.size ?? 'unknown'}`;
}

function cachedWavPacketInfoPrefix(
  key: string,
  totalSize: number | undefined,
): PacketInfoTable | undefined {
  const entry = wavPacketInfoPrefixCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    wavPacketInfoPrefixCache.delete(key);
    return undefined;
  }
  try {
    const parsed = parseWavHeader(entry.bytes, totalSize);
    return parsed.dataFound ? wavPacketInfoFromHeader(parsed) : undefined;
  } catch {
    wavPacketInfoPrefixCache.delete(key);
    return undefined;
  }
}

function storeWavPacketInfoPrefix(key: string, bytes: Uint8Array): void {
  const now = Date.now();
  for (const [entryKey, entry] of wavPacketInfoPrefixCache) {
    if (entry.expiresAtMs <= now) wavPacketInfoPrefixCache.delete(entryKey);
  }
  while (wavPacketInfoPrefixCache.size >= WAV_PACKET_INFO_PREFIX_CACHE_MAX_ENTRIES) {
    const oldest = wavPacketInfoPrefixCache.keys().next().value;
    if (oldest === undefined) break;
    wavPacketInfoPrefixCache.delete(oldest);
  }
  wavPacketInfoPrefixCache.set(key, {
    bytes: bytes.slice(),
    expiresAtMs: now + WAV_PACKET_INFO_PREFIX_TTL_MS,
  });
}

export async function wavPacketInfoFromUrl(
  url: string | URL,
  opts: WavPacketInfoFromUrlOptions = {},
): Promise<PacketInfoTable> {
  const packetInfo = WavDriver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'WAV packet-info is not available', {
      op: { op: 'demux', container: 'wav' },
      tried: ['wav'],
    });
  }
  const key = wavPacketInfoUrlCacheKey(url, opts);
  const cached = cachedWavPacketInfoPrefix(key, opts.size);
  if (cached !== undefined) return cached;
  const src = fromURL(url, {
    mime: opts.mime ?? 'audio/wav',
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  });
  if (src.range !== undefined) {
    const prefix = await src.range(
      0,
      opts.size !== undefined ? Math.min(opts.size, WAV_PROBE_HEAD_BYTES) : WAV_PROBE_HEAD_BYTES,
    );
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const parsed = parseWavHeader(prefix, opts.size);
    if (parsed.dataFound) {
      storeWavPacketInfoPrefix(key, prefix);
      return wavPacketInfoFromHeader(parsed);
    }
  }
  return packetInfo.call(
    WavDriver,
    src,
    opts.signal !== undefined ? { signal: opts.signal } : undefined,
  );
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  const reader = src.stream().getReader();
  try {
    const { value } = await reader.read();
    return value ?? new Uint8Array(0);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read the whole source into one buffer — PCM transforms need every sample (bounded by file size). */
async function readAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      if (done) {
        completed = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return out;
  } catch (error) {
    if (!completed && signal?.aborted !== true) await reader.cancel(error).catch(() => {});
    if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

interface PcmChunkReader {
  read(start: number, end: number): Promise<Uint8Array>;
  release(reason?: unknown): void | Promise<void>;
}

const EMPTY_BYTES = new Uint8Array(0);

function rangeBackedPcmChunkReader(
  source: ByteSource,
  sourceRange: NonNullable<ByteSource['range']>,
  prefix: Uint8Array,
  dataEnd: number,
  signal?: AbortSignal,
): PcmChunkReader {
  let windowStart = 0;
  let window = prefix;
  let activeSource: ByteSource | undefined = source;
  let activeRange: NonNullable<ByteSource['range']> | undefined = sourceRange;
  return {
    async read(start, end): Promise<Uint8Array> {
      if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const readSource = activeSource;
      const readRange = activeRange;
      if (readSource === undefined || readRange === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      const windowEnd = windowStart + window.byteLength;
      if (start >= windowStart && end <= windowEnd) {
        return window.subarray(start - windowStart, end - windowStart);
      }
      const overlapBytes = start >= windowStart && start < windowEnd ? windowEnd - start : 0;
      const requestStart = overlapBytes > 0 ? windowEnd : start;
      const requestEnd = Math.min(dataEnd, Math.max(end, requestStart + WAV_DECODE_RANGE_BYTES));
      const previousWindow = window;
      const previousWindowStart = windowStart;
      const nextWindow = await readRange.call(readSource, requestStart, requestEnd);
      if (signal?.aborted || activeSource === undefined) {
        throw new MediaError('aborted', OPERATION_ABORTED);
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
    release(): void {
      activeSource = undefined;
      activeRange = undefined;
      window = EMPTY_BYTES;
      windowStart = 0;
    },
  };
}

interface SequentialByteCursor {
  readonly position: number;
  read(length: number): Promise<Uint8Array>;
  skip(length: number): Promise<boolean>;
  release(reason?: unknown): Promise<void>;
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
      if (released || signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const next = await reader.read().catch((error: unknown): never => {
        if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED, signal.reason);
        if (error instanceof MediaError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new MediaError('demux-error', `WAV source read failed: ${message}`, error);
      });
      if (released || signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      if (next.done) return false;
      if (next.value.byteLength === 0) continue;
      chunk = next.value;
      chunkOffset = 0;
      return true;
    }
  };

  const read = async (length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new MediaError('demux-error', `invalid WAV sequential read length ${length}`);
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
      throw new MediaError('demux-error', `invalid WAV sequential skip length ${length}`);
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

async function sequentialWavDecode(
  src: ByteSource,
  signal?: AbortSignal,
): Promise<SequentialWavDecode> {
  const cursor = sequentialByteCursor(src, signal);
  try {
    const riff = await cursor.read(12);
    if (riff.byteLength < 12 || ascii(riff, 0, 4) !== 'RIFF' || ascii(riff, 8, 4) !== 'WAVE') {
      throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
    }
    let format: WavFormat | undefined;
    for (;;) {
      const header = await cursor.read(8);
      if (header.byteLength === 0) {
        if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
        const parsed = parsedWavHeader(format, 0, 0, false);
        return { parsed, chunks: sequentialPcmChunkReader(cursor, 0) };
      }
      if (header.byteLength < 8)
        throw new MediaError('demux-error', 'WAVE: truncated chunk header');
      const size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
        4,
        true,
      );
      const id = ascii(header, 0, 4);
      if (id === 'data') {
        if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
        const dataOffset = cursor.position;
        const dataBytes =
          src.size === undefined ? size : Math.min(size, Math.max(0, src.size - dataOffset));
        const parsed = parsedWavHeader(format, dataOffset, dataBytes, true);
        return { parsed, chunks: sequentialPcmChunkReader(cursor, dataOffset) };
      }

      const inspected = Math.min(size, id === 'fmt ' && size >= 16 ? 40 : 0);
      if (inspected > 0) {
        const body = await cursor.read(inspected);
        if (body.byteLength < inspected)
          throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
        format = parseFormat(new DataView(body.buffer, body.byteOffset, body.byteLength), 0, size);
      }
      const remaining = size - inspected + (size & 1);
      if (!(await cursor.skip(remaining))) {
        throw new MediaError('demux-error', `WAVE: truncated ${id || 'unknown'} chunk`);
      }
    }
  } catch (error) {
    await cursor.release(error);
    throw error;
  }
}

function sequentialPcmChunkReader(
  cursor: SequentialByteCursor,
  dataOffset: number,
): PcmChunkReader {
  let position = dataOffset;
  let active: SequentialByteCursor | undefined = cursor;
  return {
    async read(start, end): Promise<Uint8Array> {
      const current = active;
      if (current === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
      if (start !== position || end < start) {
        throw new MediaError(
          'demux-error',
          'WAV sequential PCM read moved outside its ordered payload',
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

function prefersSequentialPcmDecode(src: ByteSource): boolean {
  return src.range === undefined;
}

function wavDecodedChunkStream<T extends { readonly frames: number }>(
  parsed: ParsedWavHeader,
  readChunk: PcmChunkReader,
  decodeChunk: (bytes: Uint8Array) => T,
  signal?: AbortSignal,
): ReadableStream<T> {
  const totalFrames =
    parsed.bytesPerFrame > 0 ? Math.floor(parsed.dataBytes / parsed.bytesPerFrame) : 0;
  const rangeBoundFrames =
    parsed.bytesPerFrame > 0
      ? Math.max(1, Math.floor(WAV_DECODE_RANGE_BYTES / parsed.bytesPerFrame))
      : 1;
  const framesPerChunk = Math.min(WAV_PACKET_FRAMES, rangeBoundFrames);
  let frame = 0;
  let chunkReader: PcmChunkReader | undefined = readChunk;
  const releaseChunkReader = async (reason?: unknown): Promise<void> => {
    const active = chunkReader;
    chunkReader = undefined;
    await active?.release(reason);
  };
  return new ReadableStream<T>(
    {
      async pull(controller): Promise<void> {
        try {
          if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
          if (frame >= totalFrames) {
            await releaseChunkReader('WAV PCM data complete');
            controller.close();
            return;
          }
          const active = chunkReader;
          if (active === undefined) throw new MediaError('aborted', OPERATION_ABORTED);
          const frameCount = Math.min(framesPerChunk, totalFrames - frame);
          const start = parsed.dataOffset + frame * parsed.bytesPerFrame;
          const end = start + frameCount * parsed.bytesPerFrame;
          const bytes = await active.read(start, end);
          if (signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
          const audio = decodeChunk(bytes);
          if (audio.frames !== frameCount) {
            throw new MediaError(
              'demux-error',
              'WAV PCM range ended before the declared data payload',
            );
          }
          controller.enqueue(audio);
          frame += frameCount;
          if (frame >= totalFrames) {
            await releaseChunkReader('WAV PCM data complete');
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

function wavPcmChunkStream(
  parsed: ParsedWavHeader,
  format: SampleFormat,
  readChunk: PcmChunkReader,
  signal?: AbortSignal,
): ReadableStream<PcmAudio> {
  return wavDecodedChunkStream(
    parsed,
    readChunk,
    (bytes) => decodePcm(bytes, format, parsed.format.channels, parsed.format.sampleRate),
    signal,
  );
}

function wavInterleavedPcmChunkStream(
  parsed: ParsedWavHeader,
  format: SampleFormat,
  readChunk: PcmChunkReader,
  signal?: AbortSignal,
): ReadableStream<InterleavedPcmF32> {
  return wavDecodedChunkStream(
    parsed,
    readChunk,
    (bytes) =>
      decodePcmToInterleavedF32(bytes, format, parsed.format.channels, parsed.format.sampleRate),
    signal,
  );
}

export const WavDriver: ContainerDriver = {
  id: 'wav',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['wav'],
  supports: matchesWav,
  validatesPcmTrim: true,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    const range = src.range;
    const size = src.size;
    let retainedHead: Uint8Array | undefined;
    if (range !== undefined && size !== undefined) {
      const windowBytes = wavProbeHeadBytes(src);
      if (o?.signal?.aborted) {
        throw new MediaError('aborted', OPERATION_ABORTED, o.signal.reason);
      }
      const head = await range.call(src, 0, Math.min(size, windowBytes));
      retainedHead = head;
      if (o?.signal?.aborted) {
        throw new MediaError('aborted', OPERATION_ABORTED, o.signal.reason);
      }
      // Canonical RIFF/WAVE places `fmt ` and `data` in the first transport window. Parse that owned
      // window synchronously so cached chunk headers do not cross additional async/microtask boundaries.
      // Unusual legal preludes reuse the same bytes in the sparse declared-offset walker below.
      try {
        const common = parseWavHeader(head, size);
        if (common.dataFound) return [wavTrackInfo(common.info)];
      } catch {
        // The sparse parser below replays the same bytes and preserves the exact typed invalid/truncation
        // error while retaining recovery for a `fmt ` chunk beyond the initial bounded window.
      }
      const parsed = await readSparseWavProbeHeader(src, range, size, windowBytes, o?.signal, head);
      if (parsed !== undefined) return [wavTrackInfo(parsed.info)];
    }
    let head = retainedHead ?? (await readHead(src, WAV_PROBE_HEAD_BYTES));
    const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
    let parsed: ParsedWavHeader;
    try {
      parsed = parseWavHeader(head, src.size);
    } catch (error) {
      if (head.byteLength >= maxFallback) throw error;
      head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
      parsed = parseWavHeader(head, src.size);
    }
    if (!parsed.dataFound && head.byteLength < maxFallback) {
      head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
      parsed = parseWavHeader(head, src.size);
    }
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return [wavTrackInfo(parsed.info)];
  },
  async demux(src: ByteSource): Promise<Demuxer> {
    const head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
    const info = parseWav(head, src.size);
    const track = wavTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'capability-miss',
          'WAV PCM packets flow through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    let head = await readHead(src, WAV_PROBE_HEAD_BYTES);
    let parsed = parseWavHeader(head, src.size);
    const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
    if (!parsed.dataFound && head.byteLength < maxFallback) {
      head = await readHead(src, WAV_DEMUX_HEAD_BYTES);
      parsed = parseWavHeader(head, src.size);
    }
    if (!parsed.dataFound && src.size !== undefined) {
      head = await readAll(src, o?.signal);
      parsed = parseWavHeader(head, src.size);
    }
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return wavPacketInfoFromHeader(parsed);
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const opts: PcmTransform = o ?? {};
    const container = opts.container ?? 'wav';
    let bytes: Uint8Array | undefined;
    let transformDependencies: Promise<typeof import('./transform-dependencies.ts')> | undefined;
    const loadTransformDependencies = (): Promise<typeof import('./transform-dependencies.ts')> => {
      transformDependencies ??= import('./transform-dependencies.ts');
      return transformDependencies;
    };
    if (
      container === 'wav' &&
      opts.gainDb === undefined &&
      opts.fade === undefined &&
      opts.dynamics === undefined &&
      opts.biquad === undefined
    ) {
      if (opts.timeBounds !== undefined) {
        const { tryTimeSlice } = await import('./pcm-range-slice.ts');
        const sliced = await tryTimeSlice(src, opts);
        if (sliced !== undefined) return sliced;
      } else {
        bytes = await readAll(src, opts.signal);
        if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
        const copyPlan = planWavPcmCopy(
          bytes,
          opts.sampleFormat,
          opts.endian,
          opts.channels,
          opts.sampleRate,
        );
        if (copyPlan !== undefined) {
          return streamWavPcmCopy(copyPlan, opts.signal);
        }
        const { tryResampleWavS16ToS16Wav } = await import('./s16-resample.ts');
        const resampled = tryResampleWavS16ToS16Wav(bytes, opts);
        if (resampled !== undefined) {
          return byteStream(resampled);
        }
        const loaded = await loadTransformDependencies();
        const converted = loaded.tryConvertWavPcmFormatToWav(bytes, opts);
        if (converted !== undefined) {
          return byteStream(converted);
        }
      }
    }
    let loaded: typeof import('./transform-dependencies.ts');
    if (bytes === undefined) {
      [bytes, loaded] = await Promise.all([readAll(src, opts.signal), loadTransformDependencies()]);
    } else {
      loaded = await loadTransformDependencies();
    }
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const aiff = loaded.tryRewriteWavPcmToAiffBe(bytes, opts);
    if (aiff !== undefined) {
      return byteStream(aiff);
    }
    const gained = loaded.tryGainWavF32ToF32Wav(bytes, opts);
    if (gained !== undefined) {
      return byteStream(gained);
    }
    const wav = loaded.readWavPcm(bytes);
    if (opts.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    const audio = loaded.applyPcmTransform(wav, opts);
    const out = loaded.writePcmContainer(
      audio,
      container,
      loaded.resolvePcmSampleFormat(container, wav.format, opts.sampleFormat),
      opts.endian ?? 'le',
    );
    return byteStream(out);
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const [{ readWavPcm }, bytes] = await Promise.all([
      import('./pcm.ts'),
      readAll(src, o?.signal),
    ]);
    const wav = readWavPcm(bytes);
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    return wav;
  },
  async decodePcmAudioStream(src: ByteSource, o?: StageOptions): Promise<ReadableStream<PcmAudio>> {
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    if (prefersSequentialPcmDecode(src)) {
      const { parsed, chunks } = await sequentialWavDecode(src, o?.signal);
      if (o?.signal?.aborted) {
        await chunks.release(o.signal.reason);
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      return wavPcmChunkStream(parsed, pcmSampleFormat(parsed.format), chunks, o?.signal);
    }
    if (src.range !== undefined) {
      const maxHead = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
      const prefix = await src.range(0, maxHead);
      if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const parsed = parseWavHeader(prefix, src.size);
      if (parsed.dataFound) {
        const format = pcmSampleFormat(parsed.format);
        const range = src.range;
        return wavPcmChunkStream(
          parsed,
          format,
          rangeBackedPcmChunkReader(
            src,
            range,
            prefix,
            parsed.dataOffset + parsed.dataBytes,
            o?.signal,
          ),
          o?.signal,
        );
      }
    }
    throw new MediaError('demux-error', 'WAV PCM source has no readable byte path');
  },
  async decodePcmInterleavedStream(
    src: ByteSource,
    o?: StageOptions,
  ): Promise<ReadableStream<InterleavedPcmF32>> {
    if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
    if (prefersSequentialPcmDecode(src)) {
      const { parsed, chunks } = await sequentialWavDecode(src, o?.signal);
      if (o?.signal?.aborted) {
        await chunks.release(o.signal.reason);
        throw new MediaError('aborted', OPERATION_ABORTED);
      }
      return wavInterleavedPcmChunkStream(
        parsed,
        pcmSampleFormat(parsed.format),
        chunks,
        o?.signal,
      );
    }
    if (src.range !== undefined) {
      const maxHead = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
      const prefix = await src.range(0, maxHead);
      if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
      const parsed = parseWavHeader(prefix, src.size);
      if (parsed.dataFound) {
        const format = pcmSampleFormat(parsed.format);
        const range = src.range;
        return wavInterleavedPcmChunkStream(
          parsed,
          format,
          rangeBackedPcmChunkReader(
            src,
            range,
            prefix,
            parsed.dataOffset + parsed.dataBytes,
            o?.signal,
          ),
          o?.signal,
        );
      }
    }
    throw new MediaError('demux-error', 'WAV PCM source has no readable byte path');
  },
  createMuxer(o?: MuxOptions): Muxer {
    return new WavMuxer(o);
  },
};

export const WavModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(WavDriver);
  },
};

export default WavModule;
