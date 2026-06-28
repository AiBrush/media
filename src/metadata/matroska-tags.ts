import { InputError, MediaError } from '../contracts/errors.ts';
import { elements, readVint } from '../drivers/webm/ebml.ts';
import {
  type MetadataTags,
  concatBytes,
  normalizeTags,
  publicKeyFromVorbis,
  utf8Bytes,
  utf8String,
  vorbisKeyFor,
} from './tag-map.ts';

const ID = {
  Segment: 0x18538067,
  Tags: 0x1254c367,
  Tag: 0x7373,
  Targets: 0x63c0,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  TagLanguage: 0x447a,
  TagDefault: 0x4484,
} as const;

interface SegmentHeader {
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
  readonly sizeOffset: number;
  readonly sizeLength: number;
  readonly unknownSize: boolean;
}

function idBytes(id: number): number[] {
  if (id > 0xffffff) return [(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
  if (id > 0xffff) return [(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff];
  if (id > 0xff) return [(id >>> 8) & 0xff, id & 0xff];
  return [id & 0xff];
}

function vint(value: number): number[] {
  for (let length = 1; length <= 8; length++) {
    const capacity = 2 ** (7 * length) - 1;
    if (value < capacity) return sizedVint(value, length);
  }
  throw new MediaError('mux-error', `EBML size ${value} does not fit in 8 bytes`);
}

function sizedVint(value: number, length: number): number[] {
  const capacity = 2 ** (7 * length) - 1;
  if (!Number.isInteger(value) || value < 0 || value >= capacity) {
    throw new MediaError('mux-error', `EBML size ${value} does not fit in ${length} bytes`);
  }
  const out = new Array<number>(length).fill(0);
  let remaining = value;
  for (let i = length - 1; i >= 1; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  out[0] = (remaining & 0xff) | (0x80 >> (length - 1));
  return out;
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concatBytes([
    Uint8Array.from(idBytes(id)),
    Uint8Array.from(vint(payload.byteLength)),
    payload,
  ]);
}

function uintElement(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return element(id, Uint8Array.from(bytes));
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, utf8Bytes(value));
}

function tagsElement(tags: MetadataTags): Uint8Array {
  const simpleTags = normalizeTags(tags).map((tag) =>
    element(
      ID.SimpleTag,
      concatBytes([
        stringElement(ID.TagName, vorbisKeyFor(tag.key)),
        stringElement(ID.TagString, tag.value),
        stringElement(ID.TagLanguage, 'und'),
        uintElement(ID.TagDefault, 1),
      ]),
    ),
  );
  const tag = element(ID.Tag, concatBytes([element(ID.Targets, new Uint8Array()), ...simpleTags]));
  return element(ID.Tags, tag);
}

function findSegment(bytes: Uint8Array): SegmentHeader {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const id = readVint(dv, offset, true);
    if (id === undefined) break;
    const size = readVint(dv, offset + id.length, false);
    if (size === undefined) break;
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.value < 0 ? bytes.byteLength : dataStart + size.value;
    if (dataEnd < dataStart || dataEnd > bytes.byteLength) break;
    if (id.value === ID.Segment) {
      return {
        start: offset,
        dataStart,
        end: dataEnd,
        sizeOffset: offset + id.length,
        sizeLength: size.length,
        unknownSize: size.value < 0,
      };
    }
    offset = dataEnd;
  }
  throw new InputError('unsupported-input', 'not a Matroska/WebM file (no Segment)');
}

export function writeMkvTags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const segment = findSegment(bytes);
  const tagBytes = tagsElement(tags);
  const payloadLen = segment.end - segment.dataStart + tagBytes.byteLength;
  const newHeader = bytes.slice(segment.start, segment.dataStart);
  if (!segment.unknownSize) {
    newHeader.set(sizedVint(payloadLen, segment.sizeLength), segment.sizeOffset - segment.start);
  }
  return concatBytes([
    bytes.slice(0, segment.start),
    newHeader,
    bytes.slice(segment.dataStart, segment.end),
    tagBytes,
    bytes.slice(segment.end),
  ]);
}

function readUtf8(dv: DataView, start: number, end: number): string {
  return utf8String(new Uint8Array(dv.buffer, dv.byteOffset + start, end - start));
}

export function readMkvTags(bytes: Uint8Array): Record<string, string> {
  const segment = findSegment(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  for (const top of elements(dv, segment.dataStart, segment.end)) {
    if (top.id !== ID.Tags) continue;
    for (const tag of elements(dv, top.dataStart, top.dataEnd)) {
      if (tag.id !== ID.Tag) continue;
      for (const simple of elements(dv, tag.dataStart, tag.dataEnd)) {
        if (simple.id !== ID.SimpleTag) continue;
        let name: string | undefined;
        let value: string | undefined;
        for (const child of elements(dv, simple.dataStart, simple.dataEnd)) {
          if (child.id === ID.TagName) name = readUtf8(dv, child.dataStart, child.dataEnd);
          else if (child.id === ID.TagString) value = readUtf8(dv, child.dataStart, child.dataEnd);
        }
        if (name !== undefined && value !== undefined) out[publicKeyFromVorbis(name)] = value;
      }
    }
  }
  return out;
}
