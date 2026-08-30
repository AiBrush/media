import type { StreamCopyOptions } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { Movie, ParsedTrack } from './parse.ts';
import { type SampleToChunkCursor, samplesPerChunkFor } from './samples.ts';

interface RandomAccessView {
  readonly size?: number | undefined;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface SizedRandomAccessView extends RandomAccessView {
  readonly size: number;
}

interface TopLevelBox {
  readonly type: string;
  readonly size: number;
  readonly headerSize: number;
  readonly payloadStart: number;
  readonly end: number;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) * 0x1_000000 +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  );
}

function u64(bytes: Uint8Array, offset: number): number {
  return u32(bytes, offset) * 0x1_0000_0000 + u32(bytes, offset + 4);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

async function readTopLevelBox(
  ra: SizedRandomAccessView,
  offset: number,
): Promise<TopLevelBox | undefined> {
  if (offset < 0 || offset + 8 > ra.size) return undefined;
  // Loop-collect the box header so a chunked range transport (≤1 B per read)
  // cannot truncate it: collect up to 16 bytes, then interpret.
  let header: Uint8Array | undefined;
  {
    const need = Math.min(16, ra.size - offset);
    const chunks: Uint8Array[] = [];
    let collected = 0;
    let at = offset;
    let remaining = need;
    while (remaining > 0) {
      const chunk = await ra.read(at, remaining);
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      at += chunk.byteLength;
      collected += chunk.byteLength;
      remaining -= chunk.byteLength;
      // Header size is unknown until we have 8 bytes; stop early if we cannot get 8.
      if (collected >= 8) {
        const probe =
          chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, collected);
        const probeSize = u32(probe, 0);
        const probeNeed = probeSize === 1 ? 16 : 8;
        if (collected >= probeNeed || collected >= need) break;
      }
    }
    if (collected < 8) return undefined;
    header = chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, collected);
  }
  if (header.byteLength < 8) return undefined;
  let size = u32(header, 0);
  const type = fourcc(header, 4);
  let headerSize = 8;
  if (size === 1) {
    if (header.byteLength < 16) return undefined;
    size = u64(header, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = ra.size - offset;
  }
  if (!Number.isFinite(size) || size < headerSize || offset + size > ra.size) {
    return undefined;
  }
  return { type, size, headerSize, payloadStart: offset + headerSize, end: offset + size };
}

function isSized(ra: RandomAccessView): ra is SizedRandomAccessView {
  return ra.size !== undefined;
}

function writeFourcc(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isCompatibleTrack(track: ParsedTrack): boolean {
  if (track.encryption !== undefined || track.samples.sampleSizes.length === 0) return false;
  if (track.mediaType === 'video') {
    return (
      (track.sampleEntryType === 'avc1' || track.sampleEntryType === 'avc3') &&
      track.codecPrivate?.boxType === 'avcC'
    );
  }
  return (
    track.mediaType === 'audio' &&
    track.sampleEntryType === 'mp4a' &&
    track.codecPrivate?.boxType === 'esds'
  );
}

function shouldRewrite(movie: Movie, o: StreamCopyOptions | undefined): boolean {
  if ((o?.container ?? 'mp4') !== 'mp4') return false;
  if (o?.trim !== undefined || o?.fragmented === true || o?.streaming === true) return false;
  if (o?.buffered !== true || o?.faststart === false) return false;
  return movie.brand === 'qt  ' && movie.tracks.length > 0 && movie.tracks.every(isCompatibleTrack);
}

function validateSampleRange(
  index: number,
  offset: number,
  size: number,
  sourceSize: number,
): void {
  if (offset >= 0 && size >= 0 && offset + size <= sourceSize) return;
  throw new MediaError(
    'demux-error',
    `sample ${index} byte range [${offset}, ${offset + size}) is outside the source size ${sourceSize} (truncated or corrupt MP4)`,
  );
}

function validateTrackRanges(track: ParsedTrack, sourceSize: number): void {
  const table = track.samples;
  const sizes = table.sampleSizes;
  let sampleIndex = 0;
  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };

  for (
    let chunkIndex = 0;
    chunkIndex < table.chunkOffsets.length && sampleIndex < sizes.length;
    chunkIndex++
  ) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(table.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (
      let sampleInChunk = 0;
      sampleInChunk < samplesPerChunk && sampleIndex < sizes.length;
      sampleInChunk++
    ) {
      const size = sizes[sampleIndex] ?? 0;
      validateSampleRange(sampleIndex, offset, size, sourceSize);
      offset += size;
      sampleIndex++;
    }
  }

  if (sampleIndex === sizes.length) return;
  throw new MediaError(
    'demux-error',
    `sample table mapped ${sampleIndex} of ${sizes.length} samples for compatible MOV->MP4 rewrite`,
  );
}

/**
 * Bytes per verbatim source window in the streamed compatible-brand rewrite. The operation patches
 * exactly twelve bytes inside `ftyp`; everything after that box is byte-identical source payload, so it
 * streams through in bounded windows and peak memory stays flat in the file size instead of holding two
 * whole-file copies on the heap (REQUIREMENTS §7.3).
 */
const COMPATIBLE_REWRITE_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * Stream a QuickTime-branded (`qt  `) MOV as an MP4-compatible container by rewriting **only** the
 * `ftyp` payload — major brand `isom`, minor version `0x200`, first compatible brand `mp42` — and
 * forwarding every remaining source byte verbatim in bounded windows. Returns `undefined` when the
 * source shape is not the exact safe shortcut (wrong brands/box order, trim/streaming requests,
 * incompatible tracks); the caller then falls through to the general re-layout path.
 */
export async function streamCompatibleMovToMp4(
  ra: RandomAccessView,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!shouldRewrite(movie, o) || !isSized(ra)) return undefined;

  const ftyp = await readTopLevelBox(ra, 0);
  if (ftyp === undefined || ftyp.type !== 'ftyp' || ftyp.size < ftyp.headerSize + 12) {
    return undefined;
  }
  const next = await readTopLevelBox(ra, ftyp.end);
  if (next === undefined || next.type !== 'moov') return undefined;

  for (const track of movie.tracks) validateTrackRanges(track, ra.size);

  // Copy before patching: for in-memory sources `ra.read` returns a view over the caller's bytes, and
  // this operation must never mutate its input. Loop until `ftyp.size` bytes are collected so a
  // short transport read (chunked range response) does not truncate the header.
  let ftypBytes: Uint8Array | undefined;
  {
    const chunks: Uint8Array[] = [];
    let remaining = ftyp.size;
    let offset = 0;
    while (remaining > 0) {
      const chunk = await ra.read(offset, remaining);
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      offset += chunk.byteLength;
      remaining -= chunk.byteLength;
    }
    if (remaining !== 0) {
      throw new MediaError(
        'demux-error',
        `MP4 compatible MOV ftyp read was short: got ${ftyp.size - remaining} of ${ftyp.size} bytes`,
      );
    }
    const collected =
      chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, ftyp.size);
    ftypBytes = collected.slice();
  }
  writeFourcc(ftypBytes, ftyp.headerSize, 'isom');
  writeU32(ftypBytes, ftyp.headerSize + 4, 0x200);
  writeFourcc(ftypBytes, ftyp.headerSize + 8, 'mp42');

  const total = ra.size;
  let cursor = ftyp.end;
  let emittedHeader = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (!emittedHeader) {
        emittedHeader = true;
        controller.enqueue(ftypBytes as Uint8Array);
        return;
      }
      if (cursor >= total) {
        controller.close();
        return;
      }
      const length = Math.min(COMPATIBLE_REWRITE_WINDOW_BYTES, total - cursor);
      const chunk = await ra.read(cursor, length);
      if (chunk.byteLength === 0) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      cursor += chunk.byteLength;
    },
  });
}
