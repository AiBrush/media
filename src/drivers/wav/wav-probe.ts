/**
 * Lightweight RIFF/WAVE header parsing and bounded probe path.
 *
 * This module intentionally has no DSP, mux, transform, codec, or source-acquisition runtime edges:
 * zero-config metadata probing can reject or describe WAV bytes without loading the full WAV driver.
 */

import type { ByteSource, StageOptions, TrackInfo } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';

export interface WavFormat {
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
}

export interface WavInfo {
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationSec: number;
}

export interface ParsedWavHeader {
  readonly info: WavInfo;
  readonly format: WavFormat;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly bytesPerFrame: number;
  readonly dataFound: boolean;
}

export const WAV_PROBE_HEAD_BYTES = 128;
const WAV_REMOTE_PROBE_HEAD_BYTES = 16 * 1024;
const WAV_PROBE_MAX_SPARSE_WINDOWS = 8;
export const WAV_DEMUX_HEAD_BYTES = 65536;
export const MAX_WAV_CHUNKS_PER_FILE = 2048;
const OPERATION_ABORTED = 'operation aborted';

export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** PCM/float codec token per WebCodecs/harness vocabulary (LE; WAV BE variants are out of scope). */
function pcmCodec(fmt: WavFormat): string {
  if (fmt.formatTag === 3) return fmt.bitsPerSample === 64 ? 'pcm-f64' : 'pcm-f32';
  if (fmt.bitsPerSample === 8) return 'pcm-u8';
  return `pcm-s${fmt.bitsPerSample}`;
}

export function parseFormat(dv: DataView, body: number, size: number): WavFormat {
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

export function parseWavHeader(bytes: Uint8Array, totalSize?: number): ParsedWavHeader {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('not a RIFF/WAVE file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let dataSize = 0;
  let dataFound = false;
  let pos = 12;
  let chunks = 0;
  while (pos + 8 <= bytes.byteLength) {
    if (++chunks > MAX_WAV_CHUNKS_PER_FILE) {
      throw new MediaError(
        'demux-error',
        `WAV file has >${MAX_WAV_CHUNKS_PER_FILE} chunks (budget exceeded) at ${pos}`,
      );
    }
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      const needed = size >= 40 ? 26 : 16;
      if (body + needed > bytes.byteLength) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      format = parseFormat(dv, body, size);
    } else if (id === 'data') {
      dataSize = totalSize !== undefined ? Math.min(size, Math.max(0, totalSize - body)) : size;
      dataFound = true;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
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
    if (start >= window.start && start + length <= window.start + window.bytes.byteLength) {
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
    throw new InputError('not a RIFF/WAVE file');
  }

  let format: WavFormat | undefined;
  let dataOffset = 0;
  let dataBytes = 0;
  let dataFound = false;
  let pos = 12;
  let chunks = 0;
  while (pos + 8 <= size) {
    if (++chunks > MAX_WAV_CHUNKS_PER_FILE) {
      throw new MediaError(
        'demux-error',
        `WAV file has >${MAX_WAV_CHUNKS_PER_FILE} chunks (budget exceeded) at ${pos}`,
      );
    }
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
    pos = body + chunkSize + (chunkSize & 1);
  }
  if (format === undefined) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
  return parsedWavHeader(format, dataOffset, dataBytes, dataFound);
}

export function parsedWavHeader(
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

export function wavTrackInfo(info: WavInfo): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

export async function readWavHead(src: ByteSource, n: number): Promise<Uint8Array> {
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

/** Probe WAV metadata through bounded local/range reads without loading the full container driver. */
export async function probeWav(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
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
  let head = retainedHead ?? (await readWavHead(src, WAV_PROBE_HEAD_BYTES));
  const maxFallback = Math.min(src.size ?? WAV_DEMUX_HEAD_BYTES, WAV_DEMUX_HEAD_BYTES);
  let parsed: ParsedWavHeader;
  try {
    parsed = parseWavHeader(head, src.size);
  } catch (error) {
    if (head.byteLength >= maxFallback) throw error;
    head = await readWavHead(src, WAV_DEMUX_HEAD_BYTES);
    parsed = parseWavHeader(head, src.size);
  }
  if (!parsed.dataFound && head.byteLength < maxFallback) {
    head = await readWavHead(src, WAV_DEMUX_HEAD_BYTES);
    parsed = parseWavHeader(head, src.size);
  }
  if (o?.signal?.aborted) throw new MediaError('aborted', OPERATION_ABORTED);
  return [wavTrackInfo(parsed.info)];
}
