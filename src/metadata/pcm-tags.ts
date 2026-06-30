import { InputError, MediaError } from '../contracts/errors.ts';
import { buildId3v24Tag, readMp3Id3Tags } from './id3.ts';
import {
  type MetadataTags,
  concatBytes,
  normalizeTags,
  publicKeyFromVorbis,
  utf8Bytes,
  utf8String,
  vorbisKeyFor,
} from './tag-map.ts';

interface Chunk {
  readonly id: string;
  readonly start: number;
  readonly body: number;
  readonly size: number;
  readonly end: number;
  readonly paddedEnd: number;
}

interface CafChunk {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly size: number;
  readonly end: number;
}

const WAV_INFO_TO_PUBLIC = new Map<string, string>([
  ['IART', 'artist'],
  ['ICMT', 'comment'],
  ['ICRD', 'date'],
  ['IGNR', 'genre'],
  ['INAM', 'title'],
  ['IPRD', 'album'],
  ['ITRK', 'trackNumber'],
]);

const WAV_PUBLIC_TO_INFO = new Map<string, string>([
  ['album', 'IPRD'],
  ['artist', 'IART'],
  ['comment', 'ICMT'],
  ['date', 'ICRD'],
  ['description', 'ICMT'],
  ['genre', 'IGNR'],
  ['title', 'INAM'],
  ['trackNumber', 'ITRK'],
]);

const AIFF_TEXT_TO_PUBLIC = new Map<string, string>([
  ['NAME', 'title'],
  ['AUTH', 'artist'],
  ['ANNO', 'comment'],
  ['(c) ', 'date'],
]);

const AIFF_PUBLIC_TO_TEXT = new Map<string, string>([
  ['artist', 'AUTH'],
  ['comment', 'ANNO'],
  ['date', '(c) '],
  ['description', 'ANNO'],
  ['title', 'NAME'],
]);

const AIFF_TAG_CHUNKS = new Set(['NAME', 'AUTH', 'ANNO', '(c) ', 'ID3 ']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

function fourccBytes(id: string): Uint8Array {
  if (id.length !== 4) throw new MediaError('mux-error', `invalid metadata chunk id '${id}'`);
  return Uint8Array.from([...id].map((c) => c.charCodeAt(0) & 0xff));
}

function readU32le(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

function readU32be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function writeU32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeI64be(bytes: Uint8Array, offset: number, value: number): void {
  const signed = BigInt(value);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setBigInt64(offset, signed);
}

function riffChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  out.set(fourccBytes(id), 0);
  writeU32le(out, 4, body.byteLength);
  out.set(body, 8);
  return out;
}

function iffChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  out.set(fourccBytes(id), 0);
  writeU32be(out, 4, body.byteLength);
  out.set(body, 8);
  return out;
}

function cafChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  out.set(fourccBytes(id), 0);
  writeI64be(out, 4, body.byteLength);
  out.set(body, 12);
  return out;
}

function riffChunks(bytes: Uint8Array, start = 12): readonly Chunk[] {
  const chunks: Chunk[] = [];
  let pos = start;
  while (pos + 8 <= bytes.byteLength) {
    const size = readU32le(bytes, pos + 4);
    if (size === undefined) break;
    const body = pos + 8;
    const end = body + size;
    const paddedEnd = end + (size & 1);
    if (end > bytes.byteLength || paddedEnd > bytes.byteLength) {
      throw new MediaError('mux-error', 'RIFF metadata rewrite saw a truncated chunk');
    }
    chunks.push({ id: ascii(bytes, pos, 4), start: pos, body, size, end, paddedEnd });
    pos = paddedEnd;
  }
  return chunks;
}

function iffChunks(bytes: Uint8Array, start = 12): readonly Chunk[] {
  const chunks: Chunk[] = [];
  let pos = start;
  while (pos + 8 <= bytes.byteLength) {
    const size = readU32be(bytes, pos + 4);
    if (size === undefined) break;
    const body = pos + 8;
    const end = body + size;
    const paddedEnd = end + (size & 1);
    if (end > bytes.byteLength || paddedEnd > bytes.byteLength) {
      throw new MediaError('mux-error', 'AIFF metadata rewrite saw a truncated chunk');
    }
    chunks.push({ id: ascii(bytes, pos, 4), start: pos, body, size, end, paddedEnd });
    pos = paddedEnd;
  }
  return chunks;
}

function cafChunks(bytes: Uint8Array): readonly CafChunk[] {
  const chunks: CafChunk[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 12 <= bytes.byteLength) {
    const rawSize = Number(dv.getBigInt64(pos + 4));
    const body = pos + 12;
    const end = rawSize < 0 ? bytes.byteLength : body + rawSize;
    if (end > bytes.byteLength) {
      throw new MediaError('mux-error', 'CAF metadata rewrite saw a truncated chunk');
    }
    chunks.push({ type: ascii(bytes, pos, 4), start: pos, body, size: rawSize, end });
    if (rawSize < 0) break;
    pos = end;
  }
  return chunks;
}

function stringChunkBody(value: string, nulTerminated: boolean): Uint8Array {
  const text = utf8Bytes(value);
  if (!nulTerminated) return text;
  const out = new Uint8Array(text.byteLength + 1);
  out.set(text, 0);
  return out;
}

function wavInfoChunkBody(tags: MetadataTags): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const tag of normalizeTags(tags)) {
    const infoId = WAV_PUBLIC_TO_INFO.get(tag.key);
    if (infoId !== undefined) {
      chunks.push(riffChunk(infoId, stringChunkBody(tag.value, true)));
    } else {
      chunks.push(
        riffChunk('TXXX', stringChunkBody(`${vorbisKeyFor(tag.key)}=${tag.value}`, true)),
      );
    }
  }
  return concatBytes([fourccBytes('INFO'), ...chunks]);
}

function wavBextChunkBody(tags: MetadataTags): Uint8Array {
  const normalized = new Map(normalizeTags(tags).map((tag) => [tag.key, tag.value]));
  const out = new Uint8Array(602);
  writeFixedUtf8(out, 0, 256, normalized.get('description') ?? normalized.get('comment') ?? '');
  writeFixedUtf8(out, 256, 32, normalized.get('artist') ?? '');
  writeFixedUtf8(out, 288, 32, 'aibrush-media');
  writeFixedUtf8(out, 320, 10, (normalized.get('date') ?? '').slice(0, 10));
  writeFixedUtf8(out, 330, 8, '00:00:00');
  return out;
}

function writeFixedUtf8(out: Uint8Array, offset: number, length: number, value: string): void {
  const text = utf8Bytes(value);
  out.set(text.subarray(0, length), offset);
}

function chunkText(bytes: Uint8Array): string {
  let end = bytes.byteLength;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return utf8String(bytes.subarray(0, end));
}

function isInfoList(bytes: Uint8Array, chunk: Chunk): boolean {
  return chunk.id === 'LIST' && chunk.size >= 4 && ascii(bytes, chunk.body, 4) === 'INFO';
}

export function writeWavTags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const kept = riffChunks(bytes)
    .filter((chunk) => chunk.id !== 'bext' && !isInfoList(bytes, chunk))
    .map((chunk) => bytes.slice(chunk.start, chunk.paddedEnd));
  const body = concatBytes([
    fourccBytes('WAVE'),
    ...kept,
    riffChunk('LIST', wavInfoChunkBody(tags)),
    riffChunk('bext', wavBextChunkBody(tags)),
  ]);
  if (body.byteLength > 0xffffffff) {
    throw new MediaError('mux-error', 'WAV metadata rewrite exceeded RIFF size limit');
  }
  const out = new Uint8Array(8 + body.byteLength);
  out.set(fourccBytes('RIFF'), 0);
  writeU32le(out, 4, body.byteLength);
  out.set(body, 8);
  return out;
}

export function readWavTags(bytes: Uint8Array): Record<string, string> {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const out: Record<string, string> = {};
  for (const chunk of riffChunks(bytes)) {
    if (!isInfoList(bytes, chunk)) continue;
    const info = bytes.subarray(chunk.body + 4, chunk.end);
    for (const item of riffChunks(info, 0)) {
      const value = chunkText(info.subarray(item.body, item.end));
      if (item.id === 'TXXX') {
        const eq = value.indexOf('=');
        if (eq > 0) out[publicKeyFromVorbis(value.slice(0, eq))] = value.slice(eq + 1);
        continue;
      }
      const key = WAV_INFO_TO_PUBLIC.get(item.id);
      if (key !== undefined) out[key] = value;
    }
  }
  return out;
}

function aiffTagChunks(tags: MetadataTags): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const writtenText = new Set<string>();
  for (const tag of normalizeTags(tags)) {
    const id = AIFF_PUBLIC_TO_TEXT.get(tag.key);
    if (id !== undefined && !writtenText.has(id)) {
      chunks.push(iffChunk(id, stringChunkBody(tag.value, false)));
      writtenText.add(id);
    }
  }
  chunks.push(iffChunk('ID3 ', buildId3v24Tag(tags)));
  return chunks;
}

export function writeAiffTags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0, 4) !== 'FORM' ||
    (ascii(bytes, 8, 4) !== 'AIFF' && ascii(bytes, 8, 4) !== 'AIFC')
  ) {
    throw new InputError('unsupported-input', 'not an AIFF/AIFF-C file');
  }
  const formType = ascii(bytes, 8, 4);
  const kept = iffChunks(bytes)
    .filter((chunk) => !AIFF_TAG_CHUNKS.has(chunk.id))
    .map((chunk) => bytes.slice(chunk.start, chunk.paddedEnd));
  const body = concatBytes([fourccBytes(formType), ...kept, ...aiffTagChunks(tags)]);
  if (body.byteLength > 0xffffffff) {
    throw new MediaError('mux-error', 'AIFF metadata rewrite exceeded FORM size limit');
  }
  const out = new Uint8Array(8 + body.byteLength);
  out.set(fourccBytes('FORM'), 0);
  writeU32be(out, 4, body.byteLength);
  out.set(body, 8);
  return out;
}

export function readAiffTags(bytes: Uint8Array): Record<string, string> {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0, 4) !== 'FORM' ||
    (ascii(bytes, 8, 4) !== 'AIFF' && ascii(bytes, 8, 4) !== 'AIFC')
  ) {
    throw new InputError('unsupported-input', 'not an AIFF/AIFF-C file');
  }
  const out: Record<string, string> = {};
  for (const chunk of iffChunks(bytes)) {
    if (chunk.id === 'ID3 ')
      Object.assign(out, readMp3Id3Tags(bytes.subarray(chunk.body, chunk.end)));
    const key = AIFF_TEXT_TO_PUBLIC.get(chunk.id);
    if (key !== undefined && out[key] === undefined) {
      out[key] = chunkText(bytes.subarray(chunk.body, chunk.end));
    }
  }
  return out;
}

function cafInfoBody(tags: MetadataTags): Uint8Array {
  const normalized = normalizeTags(tags);
  const parts: Uint8Array[] = [new Uint8Array(4)];
  writeU32be(parts[0] as Uint8Array, 0, normalized.length);
  for (const tag of normalized) {
    parts.push(stringChunkBody(tag.key, true), stringChunkBody(tag.value, true));
  }
  return concatBytes(parts);
}

function readCafInfoBody(body: Uint8Array): Record<string, string> {
  const count = readU32be(body, 0);
  if (count === undefined) throw new MediaError('mux-error', 'CAF info chunk is truncated');
  const out: Record<string, string> = {};
  let offset = 4;
  for (let i = 0; i < count; i++) {
    const keyEnd = body.indexOf(0, offset);
    if (keyEnd < 0) throw new MediaError('mux-error', 'CAF info key is truncated');
    const valueStart = keyEnd + 1;
    const valueEnd = body.indexOf(0, valueStart);
    if (valueEnd < 0) throw new MediaError('mux-error', 'CAF info value is truncated');
    const key = utf8String(body.subarray(offset, keyEnd));
    if (key.length > 0) out[key] = utf8String(body.subarray(valueStart, valueEnd));
    offset = valueEnd + 1;
  }
  return out;
}

export function writeCafTags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  if (bytes.byteLength < 8 || ascii(bytes, 0, 4) !== 'caff') {
    throw new InputError('unsupported-input', 'not a CAF (caff) file');
  }
  const info = cafChunk('info', cafInfoBody(tags));
  const chunks: Uint8Array[] = [];
  let inserted = false;
  for (const chunk of cafChunks(bytes)) {
    if (chunk.type === 'info') continue;
    if (!inserted && chunk.type === 'data' && chunk.size < 0) {
      chunks.push(info);
      inserted = true;
    }
    chunks.push(bytes.slice(chunk.start, chunk.end));
  }
  if (!inserted) chunks.push(info);
  return concatBytes([bytes.slice(0, 8), ...chunks]);
}

export function readCafTags(bytes: Uint8Array): Record<string, string> {
  if (bytes.byteLength < 8 || ascii(bytes, 0, 4) !== 'caff') {
    throw new InputError('unsupported-input', 'not a CAF (caff) file');
  }
  const out: Record<string, string> = {};
  for (const chunk of cafChunks(bytes)) {
    if (chunk.type === 'info')
      Object.assign(out, readCafInfoBody(bytes.subarray(chunk.body, chunk.end)));
  }
  return out;
}
