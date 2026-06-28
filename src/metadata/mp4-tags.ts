import { InputError, MediaError } from '../contracts/errors.ts';
import {
  type MetadataTags,
  concatBytes,
  normalizeTags,
  publicKeyFromVorbis,
  utf8Bytes,
  utf8String,
  vorbisKeyFor,
} from './tag-map.ts';

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  readonly payloadStart: number;
  readonly end: number;
}

const TEXT_ATOMS = new Map<string, string>([
  ['album', '\u00a9alb'],
  ['albumArtist', 'aART'],
  ['artist', '\u00a9ART'],
  ['comment', '\u00a9cmt'],
  ['date', '\u00a9day'],
  ['description', 'desc'],
  ['genre', '\u00a9gen'],
  ['title', '\u00a9nam'],
]);

const ATOM_TO_PUBLIC = new Map<string, string>([
  ['\u00a9alb', 'album'],
  ['aART', 'albumArtist'],
  ['\u00a9ART', 'artist'],
  ['\u00a9cmt', 'comment'],
  ['\u00a9day', 'date'],
  ['desc', 'description'],
  ['\u00a9gen', 'genre'],
  ['\u00a9nam', 'title'],
]);

function readU32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readU64(bytes: Uint8Array, offset: number): number | undefined {
  const hi = readU32(bytes, offset);
  const lo = readU32(bytes, offset + 4);
  if (hi === undefined || lo === undefined) return undefined;
  return hi * 2 ** 32 + lo;
}

function writeU64(bytes: Uint8Array, offset: number, value: number): void {
  const hi = Math.floor(value / 2 ** 32);
  const lo = value >>> 0;
  writeU32(bytes, offset, hi);
  writeU32(bytes, offset + 4, lo);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.byteLength) return '';
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

function fourccBytes(type: string): Uint8Array {
  if ([...type].length !== 4) throw new MediaError('mux-error', `invalid MP4 box type '${type}'`);
  return Uint8Array.from([...type].map((c) => c.charCodeAt(0) & 0xff));
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  writeU32(out, 0, out.byteLength);
  out.set(fourccBytes(type), 4);
  out.set(payload, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  return box(
    type,
    Uint8Array.from([
      version & 0xff,
      (flags >>> 16) & 0xff,
      (flags >>> 8) & 0xff,
      flags & 0xff,
      ...payload,
    ]),
  );
}

function boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] {
  const out: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = readU32(bytes, offset);
    if (size32 === undefined) break;
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      const large = readU64(bytes, offset + 8);
      if (large === undefined) break;
      size = large;
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    const next = offset + size;
    if (size < headerSize || next <= offset || next > end) break;
    out.push({
      type: fourcc(bytes, offset + 4),
      start: offset,
      headerSize,
      payloadStart: offset + headerSize,
      end: next,
    });
    offset = next;
  }
  return out;
}

function replaceBoxSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > 0xffffffff) {
    throw new MediaError(
      'mux-error',
      'metadata rewrite produced an MP4 box over the 32-bit size limit',
    );
  }
  const out = bytes.slice();
  writeU32(out, 0, out.byteLength);
  return out;
}

function dataAtom(value: string): Uint8Array {
  return box('data', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, ...utf8Bytes(value)]));
}

function trknAtom(value: string): Uint8Array {
  const track = Math.max(0, Math.min(0xffff, Number.parseInt(value, 10) || 0));
  return box(
    'data',
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (track >>> 8) & 0xff, track & 0xff, 0, 0, 0, 0]),
  );
}

function freeformAtom(key: string, value: string): Uint8Array {
  return box(
    '----',
    concatBytes([
      box('mean', Uint8Array.from([0, 0, 0, 0, ...utf8Bytes('com.aibrush.media')])),
      box('name', Uint8Array.from([0, 0, 0, 0, ...utf8Bytes(vorbisKeyFor(key))])),
      dataAtom(value),
    ]),
  );
}

function ilstAtom(tags: MetadataTags): Uint8Array {
  const items: Uint8Array[] = [];
  for (const tag of normalizeTags(tags)) {
    if (tag.key === 'trackNumber') {
      items.push(box('trkn', trknAtom(tag.value)));
      continue;
    }
    const atom = TEXT_ATOMS.get(tag.key);
    items.push(
      atom === undefined ? freeformAtom(tag.key, tag.value) : box(atom, dataAtom(tag.value)),
    );
  }
  return box('ilst', concatBytes(items));
}

function metaAtom(tags: MetadataTags): Uint8Array {
  const handler = fullBox(
    'hdlr',
    0,
    0,
    Uint8Array.from([0, 0, 0, 0, ...fourccBytes('mdir'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
  return fullBox('meta', 0, 0, concatBytes([handler, ilstAtom(tags)]));
}

function updateUdta(udta: Uint8Array, tags: MetadataTags): Uint8Array {
  const children = boxes(udta, 8, udta.byteLength)
    .filter((child) => child.type !== 'meta')
    .map((child) => udta.slice(child.start, child.end));
  return box('udta', concatBytes([...children, metaAtom(tags)]));
}

function updateMoov(moov: Uint8Array, tags: MetadataTags): Uint8Array {
  const children = boxes(moov, 8, moov.byteLength);
  const parts: Uint8Array[] = [];
  let foundUdta = false;
  for (const child of children) {
    const childBytes = moov.slice(child.start, child.end);
    if (child.type === 'udta') {
      parts.push(updateUdta(childBytes, tags));
      foundUdta = true;
    } else {
      parts.push(childBytes);
    }
  }
  if (!foundUdta) parts.push(box('udta', metaAtom(tags)));
  return box('moov', concatBytes(parts));
}

function patchChunkOffsets(bytes: Uint8Array, start: number, end: number, delta: number): void {
  for (const child of boxes(bytes, start, end)) {
    if (child.type === 'stco') {
      const count = readU32(bytes, child.payloadStart + 4);
      if (count === undefined) continue;
      let offset = child.payloadStart + 8;
      for (let i = 0; i < count && offset + 4 <= child.end; i++) {
        const value = readU32(bytes, offset);
        if (value !== undefined) {
          const next = value + delta;
          if (next > 0xffffffff) {
            throw new MediaError('mux-error', 'MP4 stco offset overflowed during metadata rewrite');
          }
          writeU32(bytes, offset, next);
        }
        offset += 4;
      }
    } else if (child.type === 'co64') {
      const count = readU32(bytes, child.payloadStart + 4);
      if (count === undefined) continue;
      let offset = child.payloadStart + 8;
      for (let i = 0; i < count && offset + 8 <= child.end; i++) {
        const value = readU64(bytes, offset);
        if (value !== undefined) writeU64(bytes, offset, value + delta);
        offset += 8;
      }
    } else {
      const childPayloadStart = child.type === 'meta' ? child.payloadStart + 4 : child.payloadStart;
      if (childPayloadStart < child.end)
        patchChunkOffsets(bytes, childPayloadStart, child.end, delta);
    }
  }
}

function textDataValue(payload: Uint8Array): string {
  if (payload.byteLength < 8) return '';
  return utf8String(payload.subarray(8));
}

function fullBoxTextValue(payload: Uint8Array): string {
  if (payload.byteLength < 4) return '';
  return utf8String(payload.subarray(4));
}

function trknDataValue(payload: Uint8Array): string {
  if (payload.byteLength < 12) return '';
  return String(((payload[10] as number) << 8) | (payload[11] as number));
}

function topLevelMoov(bytes: Uint8Array): Mp4Box {
  const moov = boxes(bytes, 0, bytes.byteLength).find((child) => child.type === 'moov');
  if (moov === undefined)
    throw new InputError('unsupported-input', 'not an MP4/MOV file (no moov)');
  return moov;
}

export function writeMp4Tags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const top = boxes(bytes, 0, bytes.byteLength);
  const moov = top.find((child) => child.type === 'moov');
  if (moov === undefined)
    throw new InputError('unsupported-input', 'not an MP4/MOV file (no moov)');
  const oldMoov = bytes.slice(moov.start, moov.end);
  const newMoov = updateMoov(oldMoov, tags);
  const delta = newMoov.byteLength - oldMoov.byteLength;
  const patchedMoov = replaceBoxSize(newMoov);
  const mediaAfterMoov = top.some((child) => child.type === 'mdat' && child.start >= moov.end);
  if (delta !== 0 && mediaAfterMoov)
    patchChunkOffsets(patchedMoov, 8, patchedMoov.byteLength, delta);
  return concatBytes([bytes.slice(0, moov.start), patchedMoov, bytes.slice(moov.end)]);
}

export function readMp4Tags(bytes: Uint8Array): Record<string, string> {
  const moov = topLevelMoov(bytes);
  const out: Record<string, string> = {};
  const moovBytes = bytes.slice(moov.start, moov.end);
  const udta = boxes(moovBytes, 8, moovBytes.byteLength).find((child) => child.type === 'udta');
  if (udta === undefined) return out;
  const meta = boxes(moovBytes, udta.payloadStart, udta.end).find((child) => child.type === 'meta');
  if (meta === undefined) return out;
  const ilst = boxes(moovBytes, meta.payloadStart + 4, meta.end).find(
    (child) => child.type === 'ilst',
  );
  if (ilst === undefined) return out;
  for (const item of boxes(moovBytes, ilst.payloadStart, ilst.end)) {
    if (item.type === '----') {
      let name: string | undefined;
      let value: string | undefined;
      for (const child of boxes(moovBytes, item.payloadStart, item.end)) {
        const payload = moovBytes.subarray(child.payloadStart, child.end);
        if (child.type === 'name') name = fullBoxTextValue(payload);
        else if (child.type === 'data') value = textDataValue(payload);
      }
      if (name !== undefined && value !== undefined) out[publicKeyFromVorbis(name)] = value;
      continue;
    }
    const publicKey = item.type === 'trkn' ? 'trackNumber' : ATOM_TO_PUBLIC.get(item.type);
    if (publicKey === undefined) continue;
    const data = boxes(moovBytes, item.payloadStart, item.end).find(
      (child) => child.type === 'data',
    );
    if (data === undefined) continue;
    const payload = moovBytes.subarray(data.payloadStart, data.end);
    out[publicKey] = item.type === 'trkn' ? trknDataValue(payload) : textDataValue(payload);
  }
  return out;
}
