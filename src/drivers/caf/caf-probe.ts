/**
 * Bounded CAF metadata probe.
 *
 * CAF chunk sizes are signed 64-bit values, and a final `data` chunk may use `-1` to mean "through
 * EOF". When both random access and the total size are available, duration therefore needs only the
 * `desc` body, the `data` header, and the source size: skipped chunk bodies and the complete PCM payload
 * are never materialized. Range count and transferred metadata are capped so a hostile chunk table
 * cannot turn one probe into unbounded request amplification.
 *
 * A range-less or unknown-size source cannot determine a `-1` data length from headers alone. That
 * path deliberately retains the exact full parser through the canonical abort-aware whole read.
 */

import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../../sources/abort.ts';
import { readAllBytes } from '../../sources/read-all.ts';
import {
  type CafAsbd,
  type CafInfo,
  cafInfoFromAsbd,
  parseCaf,
  parseCafAsbd,
  parseCafChunkSize,
} from './caf.ts';

const CAF_HEADER_BYTES = 8;
const CAF_CHUNK_HEADER_BYTES = 12;
const CAF_DESC_BYTES = 32;
const CAF_EDIT_COUNT_BYTES = 4;
const CAF_PROBE_WINDOW_BYTES = 4096;
const CAF_PROBE_MAX_WINDOWS = 16;
const CAF_PROBE_MAX_CHUNKS = 8192;

interface CafProbeWindow {
  readonly start: number;
  readonly bytes: Uint8Array;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

function demuxError(message: string): MediaError {
  return new MediaError('demux-error', message);
}

function sourceSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InputError('CAF: source size must be a non-negative safe integer');
  }
  return value;
}

function chunkSize(header: Uint8Array, type: string): number {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return parseCafChunkSize(view.getBigInt64(4), type);
}

function dataSampleBytes(totalSize: number, body: number, declaredSize: number): number {
  const availableBodyBytes = totalSize - body;
  if (availableBodyBytes < CAF_EDIT_COUNT_BYTES) {
    throw demuxError('CAF: truncated data chunk edit count');
  }
  if (declaredSize !== -1 && declaredSize < CAF_EDIT_COUNT_BYTES) {
    throw demuxError('CAF: data chunk is smaller than its edit count');
  }
  const availableSamples = availableBodyBytes - CAF_EDIT_COUNT_BYTES;
  return declaredSize === -1
    ? availableSamples
    : Math.min(declaredSize - CAF_EDIT_COUNT_BYTES, availableSamples);
}

async function probeSeekableCaf(
  src: ByteSource,
  range: NonNullable<ByteSource['range']>,
  totalSize: number,
  signal?: AbortSignal,
): Promise<CafInfo> {
  let windowCount = 0;
  let window: CafProbeWindow | undefined;
  const readAt = async (start: number, length: number): Promise<Uint8Array> => {
    throwIfSourceAborted(signal);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new InputError('CAF: invalid probe byte range');
    }
    const relative = window === undefined ? -1 : start - window.start;
    if (window !== undefined && relative >= 0 && relative + length <= window.bytes.byteLength) {
      return window.bytes.subarray(relative, relative + length);
    }
    if (windowCount >= CAF_PROBE_MAX_WINDOWS) {
      throw demuxError('CAF: metadata exceeds the bounded probe range budget');
    }
    if (start >= totalSize) return new Uint8Array(0);
    const requestBytes = Math.max(length, CAF_PROBE_WINDOW_BYTES);
    const end =
      requestBytes >= totalSize - start ? totalSize : Math.min(totalSize, start + requestBytes);
    const requested = range.call(src, start, end, signal);
    const bytes = await raceAbort(requested, signal);
    throwIfSourceAborted(signal);
    windowCount++;
    window = { start, bytes: bytes.subarray(0, end - start) };
    return window.bytes.subarray(0, Math.min(length, window.bytes.byteLength));
  };

  const header = await readAt(0, CAF_HEADER_BYTES);
  if (header.byteLength < CAF_HEADER_BYTES || ascii(header, 0, 4) !== 'caff') {
    throw new InputError('not a CAF (caff) file');
  }

  let asbd: CafAsbd | undefined;
  let samples: number | undefined;
  let position = CAF_HEADER_BYTES;
  let chunks = 0;
  while (position < totalSize) {
    if (chunks >= CAF_PROBE_MAX_CHUNKS) {
      throw demuxError('CAF: chunk table exceeds the bounded probe chunk limit');
    }
    const headerBytes = await readAt(position, CAF_CHUNK_HEADER_BYTES);
    if (headerBytes.byteLength < CAF_CHUNK_HEADER_BYTES) {
      throw demuxError('CAF: truncated chunk header');
    }
    const type = ascii(headerBytes, 0, 4);
    const declaredSize = chunkSize(headerBytes, type);
    const body = position + CAF_CHUNK_HEADER_BYTES;
    const availableBodyBytes = totalSize - body;
    if (declaredSize !== -1 && declaredSize > availableBodyBytes) {
      throw demuxError(`CAF: truncated '${type}' chunk`);
    }

    if (type === 'desc' && asbd === undefined) {
      if (declaredSize < CAF_DESC_BYTES || availableBodyBytes < CAF_DESC_BYTES) {
        throw demuxError('CAF: truncated Audio Description (desc) chunk');
      }
      asbd = parseCafAsbd(await readAt(body, CAF_DESC_BYTES));
    } else if (type === 'data' && samples === undefined) {
      samples = dataSampleBytes(totalSize, body, declaredSize);
    }

    if (declaredSize === -1) break;
    position = body + declaredSize;
    chunks++;
  }

  if (asbd === undefined) {
    throw demuxError('CAF: no Audio Description (desc) chunk');
  }
  return cafInfoFromAsbd(asbd, samples ?? 0);
}

/** Probe CAF metadata without materializing the PCM payload when the source exposes size + ranges. */
export async function probeCaf(src: ByteSource, signal?: AbortSignal): Promise<CafInfo> {
  throwIfSourceAborted(signal);
  if (src.range !== undefined && src.size !== undefined) {
    return probeSeekableCaf(src, src.range, sourceSize(src.size), signal);
  }
  const bytes = await raceAbort(readAllBytes(src, signal), signal);
  throwIfSourceAborted(signal);
  return parseCaf(bytes);
}
