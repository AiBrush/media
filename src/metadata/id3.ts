import { InputError, MediaError } from '../contracts/errors.ts';
import {
  type MetadataTags,
  normalizeTags,
  publicKeyFromVorbis,
  utf8Bytes,
  utf8String,
  vorbisKeyFor,
} from './tag-map.ts';

const ID3_HEADER_LEN = 10;

const TEXT_FRAME_IDS = new Map<string, string>([
  ['album', 'TALB'],
  ['albumArtist', 'TPE2'],
  ['artist', 'TPE1'],
  ['date', 'TDRC'],
  ['genre', 'TCON'],
  ['title', 'TIT2'],
  ['trackNumber', 'TRCK'],
]);

const FRAME_TO_PUBLIC = new Map<string, string>([
  ['TALB', 'album'],
  ['TPE2', 'albumArtist'],
  ['TPE1', 'artist'],
  ['TDRC', 'date'],
  ['TYER', 'date'],
  ['TCON', 'genre'],
  ['TIT2', 'title'],
  ['TRCK', 'trackNumber'],
]);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

function synchsafe(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new MediaError('mux-error', `ID3 synchsafe size out of range: ${value}`);
  }
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function readSynchsafe(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  const b0 = bytes[offset] as number;
  const b1 = bytes[offset + 1] as number;
  const b2 = bytes[offset + 2] as number;
  const b3 = bytes[offset + 3] as number;
  if ((b0 | b1 | b2 | b3) & 0x80) return undefined;
  return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
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

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.byteLength < ID3_HEADER_LEN || ascii(bytes, 0, 3) !== 'ID3') return 0;
  const size = readSynchsafe(bytes, 6);
  if (size === undefined || ID3_HEADER_LEN + size > bytes.byteLength) {
    throw new InputError('unsupported-input', 'truncated or malformed ID3v2 header');
  }
  return ID3_HEADER_LEN + size;
}

function frame(id: string, payload: Uint8Array): Uint8Array {
  if (id.length !== 4) throw new MediaError('mux-error', `invalid ID3 frame id '${id}'`);
  return Uint8Array.from([
    ...[...id].map((c) => c.charCodeAt(0)),
    ...synchsafe(payload.byteLength),
    0,
    0,
    ...payload,
  ]);
}

function textPayload(value: string): Uint8Array {
  return Uint8Array.from([0x03, ...utf8Bytes(value)]);
}

function commentPayload(value: string): Uint8Array {
  return Uint8Array.from([
    0x03, // UTF-8
    0x65,
    0x6e,
    0x67, // language = eng
    0x00, // empty short description terminator
    ...utf8Bytes(value),
  ]);
}

function privatePayload(key: string, value: string): Uint8Array {
  return Uint8Array.from([...utf8Bytes(`aibrush:${vorbisKeyFor(key)}`), 0x00, ...utf8Bytes(value)]);
}

function buildId3Payload(tags: MetadataTags): Uint8Array {
  const frames: Uint8Array[] = [];
  for (const tag of normalizeTags(tags)) {
    if (tag.key === 'comment' || tag.key === 'description') {
      frames.push(frame('COMM', commentPayload(tag.value)));
      continue;
    }
    const textId = TEXT_FRAME_IDS.get(tag.key);
    if (textId !== undefined) {
      frames.push(frame(textId, textPayload(tag.value)));
    } else {
      frames.push(frame('TXXX', textPayload(`${vorbisKeyFor(tag.key)}=${tag.value}`)));
      frames.push(frame('PRIV', privatePayload(tag.key, tag.value)));
    }
  }
  let total = 0;
  for (const item of frames) total += item.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of frames) {
    out.set(item, offset);
    offset += item.byteLength;
  }
  return out;
}

export function buildId3v24Tag(tags: MetadataTags): Uint8Array {
  const payload = buildId3Payload(tags);
  return Uint8Array.from([
    0x49,
    0x44,
    0x33, // ID3
    4,
    0,
    0,
    ...synchsafe(payload.byteLength),
    ...payload,
  ]);
}

export function writeMp3Id3Tags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const oldTagLength = id3v2Length(bytes);
  const tag = buildId3v24Tag(tags);
  const audio = bytes.subarray(oldTagLength);
  const out = new Uint8Array(tag.byteLength + audio.byteLength);
  out.set(tag, 0);
  out.set(audio, tag.byteLength);
  return out;
}

function decodeTextFrame(payload: Uint8Array): string {
  const encoding = payload[0];
  if (encoding === 0x03 || encoding === 0x00)
    return utf8String(payload.subarray(1)).replace(/\0+$/g, '');
  if (encoding === 0x01 || encoding === 0x02) {
    return new TextDecoder('utf-16', { fatal: false })
      .decode(payload.subarray(1))
      .replace(/\0+$/g, '');
  }
  return utf8String(payload).replace(/\0+$/g, '');
}

function decodeCommentFrame(payload: Uint8Array): string {
  if (payload.byteLength < 5) return '';
  const encoding = payload[0];
  const text = payload.subarray(4);
  if (encoding === 0x03 || encoding === 0x00) {
    const nul = text.indexOf(0);
    return utf8String(nul >= 0 ? text.subarray(nul + 1) : text).replace(/\0+$/g, '');
  }
  return decodeTextFrame(payload.subarray(4));
}

function frameSize(bytes: Uint8Array, version: number, offset: number): number | undefined {
  return version === 4 ? readSynchsafe(bytes, offset) : readU32be(bytes, offset);
}

export function readMp3Id3Tags(bytes: Uint8Array): Record<string, string> {
  const tagLength = id3v2Length(bytes);
  if (tagLength === 0) return {};
  const version = bytes[3] as number;
  const out: { comment?: string } & Record<string, string> = {};
  let offset = ID3_HEADER_LEN;
  while (offset + 10 <= tagLength) {
    const id = ascii(bytes, offset, 4);
    if (/^\0{4}$/.test(id)) break;
    const size = frameSize(bytes, version, offset + 4);
    if (size === undefined || size < 0 || offset + 10 + size > tagLength) break;
    const payload = bytes.subarray(offset + 10, offset + 10 + size);
    if (id === 'COMM') {
      out.comment = decodeCommentFrame(payload);
    } else if (id === 'TXXX') {
      const text = decodeTextFrame(payload);
      const eq = text.indexOf('=');
      if (eq > 0) out[publicKeyFromVorbis(text.slice(0, eq))] = text.slice(eq + 1);
    } else if (id.startsWith('T')) {
      const key = FRAME_TO_PUBLIC.get(id);
      if (key !== undefined) out[key] = decodeTextFrame(payload);
    }
    offset += 10 + size;
  }
  return out;
}
