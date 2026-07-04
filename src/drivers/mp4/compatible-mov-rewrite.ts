import type { ByteSource, StreamCopyOptions } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { Movie, ParsedTrack } from './parse.ts';

interface RandomAccessView {
  readonly size?: number;
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
  const header = await ra.read(offset, Math.min(16, ra.size - offset));
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

function canReuseFullRead(src: ByteSource): boolean {
  const kind = (src as ByteSource & { readonly kind?: string }).kind;
  return kind === 'url' || kind === 'element' || kind === 'blob' || kind === 'opfs';
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
  let stscIndex = 0;
  let samplesPerChunk = 0;

  for (
    let chunkIndex = 0;
    chunkIndex < table.chunkOffsets.length && sampleIndex < sizes.length;
    chunkIndex++
  ) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const chunkNumber = chunkIndex + 1;
    for (;;) {
      const entry = table.sampleToChunk[stscIndex];
      if (entry === undefined || entry.firstChunk > chunkNumber) break;
      samplesPerChunk = entry.samplesPerChunk;
      stscIndex++;
    }
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

export async function materializeCompatibleMovToMp4Bytes(
  src: ByteSource,
  ra: RandomAccessView,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): Promise<Uint8Array | undefined> {
  if (!shouldRewrite(movie, o) || !isSized(ra)) return undefined;

  const ftyp = await readTopLevelBox(ra, 0);
  if (ftyp === undefined || ftyp.type !== 'ftyp' || ftyp.size < ftyp.headerSize + 12) {
    return undefined;
  }
  const next = await readTopLevelBox(ra, ftyp.end);
  if (next === undefined || next.type !== 'moov') return undefined;

  for (const track of movie.tracks) validateTrackRanges(track, ra.size);

  const full = await ra.read(0, ra.size);
  if (full.byteLength !== ra.size) {
    throw new MediaError(
      'demux-error',
      `MP4 compatible MOV full-source read was short: got ${full.byteLength} of ${ra.size} bytes`,
    );
  }
  const out = canReuseFullRead(src) ? full : full.slice();
  writeFourcc(out, ftyp.payloadStart, 'isom');
  writeU32(out, ftyp.payloadStart + 4, 0x200);
  writeFourcc(out, ftyp.payloadStart + 8, 'mp42');
  return out;
}
