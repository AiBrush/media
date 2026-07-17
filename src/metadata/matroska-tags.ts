import { InputError, MediaError } from '../contracts/errors.ts';
import { readVint } from '../drivers/webm/ebml.ts';
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
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekId: 0x53ab,
  SeekPosition: 0x53ac,
  Tags: 0x1254c367,
  Tag: 0x7373,
  Targets: 0x63c0,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  TagLanguage: 0x447a,
  TagDefault: 0x4484,
  Crc32: 0xbf,
  Void: 0xec,
} as const;

interface ElementSpan {
  readonly id: number;
  readonly start: number;
  readonly sizeOffset: number;
  readonly sizeLength: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly unknownSize: boolean;
}

interface TagSeekEntry {
  readonly seekHead: ElementSpan;
  readonly seekHeadCrc?: ElementSpan;
  readonly seek: ElementSpan;
  readonly position: ElementSpan;
  readonly currentPosition: number;
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
  if (!Number.isSafeInteger(value) || value < 0 || value >= capacity) {
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

function tagsElement(tags: MetadataTags): Uint8Array | undefined {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return undefined;
  const simpleTags = normalized.map((tag) =>
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

function invalidStructure(message: string): InputError {
  return new InputError(`invalid Matroska structure: ${message}`);
}

function parseElement(
  dv: DataView,
  start: number,
  parentEnd: number,
  context: string,
  allowUnknownSize: boolean,
): ElementSpan {
  const id = readVint(dv, start, true);
  if (id === undefined || id.length > 4) {
    throw invalidStructure(`${context} has a truncated or invalid element ID at byte ${start}`);
  }
  const sizeOffset = start + id.length;
  const size = readVint(dv, sizeOffset, false);
  if (size === undefined) {
    throw invalidStructure(`${context} element 0x${id.value.toString(16)} has a truncated size`);
  }
  const dataStart = sizeOffset + size.length;
  if (dataStart > parentEnd) {
    throw invalidStructure(`${context} element 0x${id.value.toString(16)} has no payload boundary`);
  }
  if (size.value < 0) {
    if (!allowUnknownSize) {
      throw invalidStructure(
        `${context} element 0x${id.value.toString(16)} has an ambiguous unknown size`,
      );
    }
    return {
      id: id.value,
      start,
      sizeOffset,
      sizeLength: size.length,
      dataStart,
      dataEnd: parentEnd,
      unknownSize: true,
    };
  }
  if (!Number.isSafeInteger(size.value) || size.value > parentEnd - dataStart) {
    throw invalidStructure(`${context} element 0x${id.value.toString(16)} extends past its parent`);
  }
  return {
    id: id.value,
    start,
    sizeOffset,
    sizeLength: size.length,
    dataStart,
    dataEnd: dataStart + size.value,
    unknownSize: false,
  };
}

function childrenOf(dv: DataView, start: number, end: number, context: string): ElementSpan[] {
  const children: ElementSpan[] = [];
  let offset = start;
  while (offset < end) {
    const child = parseElement(dv, offset, end, context, false);
    children.push(child);
    offset = child.dataEnd;
  }
  if (offset !== end) throw invalidStructure(`${context} has malformed trailing bytes`);
  return children;
}

function findSegment(bytes: Uint8Array): ElementSpan {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const root = parseElement(dv, offset, bytes.byteLength, 'document', true);
    if (root.id === ID.Segment) return root;
    if (root.unknownSize) {
      throw invalidStructure(
        `unknown-size root 0x${root.id.toString(16)} appears before the Segment`,
      );
    }
    offset = root.dataEnd;
  }
  throw new InputError('not a Matroska/WebM file (no Segment)');
}

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateParentCrc(
  bytes: Uint8Array,
  parent: ElementSpan,
  children: readonly ElementSpan[],
  context: string,
): ElementSpan | undefined {
  const crcElements = children.filter((child) => child.id === ID.Crc32);
  if (crcElements.length === 0) return undefined;
  if (crcElements.length !== 1 || crcElements[0] !== children[0]) {
    throw invalidStructure(`${context} CRC-32 must be its single first child`);
  }
  const crc = crcElements[0];
  if (crc === undefined || crc.dataEnd - crc.dataStart !== 4) {
    throw invalidStructure(`${context} CRC-32 must contain exactly four bytes`);
  }
  const actual = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    crc.dataStart,
    true,
  );
  const expected = crc32([
    bytes.subarray(parent.dataStart, crc.start),
    bytes.subarray(crc.dataEnd, parent.dataEnd),
  ]);
  if (actual !== expected) throw invalidStructure(`${context} CRC-32 does not validate`);
  return crc;
}

function bytesEqual(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: readonly number[],
): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (bytes[start + index] !== expected[index]) return false;
  }
  return true;
}

function readSafeUint(bytes: Uint8Array, span: ElementSpan, context: string): number {
  const length = span.dataEnd - span.dataStart;
  if (length < 1 || length > 8) {
    throw invalidStructure(`${context} unsigned integer has invalid width ${length}`);
  }
  let value = 0;
  for (let offset = span.dataStart; offset < span.dataEnd; offset++) {
    value = value * 256 + (bytes[offset] ?? 0);
    if (!Number.isSafeInteger(value)) {
      throw invalidStructure(`${context} unsigned integer exceeds the safe byte range`);
    }
  }
  return value;
}

function tagSeekEntries(
  bytes: Uint8Array,
  dv: DataView,
  segmentChildren: readonly ElementSpan[],
): TagSeekEntry[] {
  const entries: TagSeekEntry[] = [];
  const tagId = idBytes(ID.Tags);
  for (const seekHead of segmentChildren) {
    if (seekHead.id !== ID.SeekHead) continue;
    const children = childrenOf(dv, seekHead.dataStart, seekHead.dataEnd, 'SeekHead');
    const seekHeadCrc = validateParentCrc(bytes, seekHead, children, 'SeekHead');
    for (const seek of children) {
      if (seek.id !== ID.Seek) continue;
      const seekChildren = childrenOf(dv, seek.dataStart, seek.dataEnd, 'Seek');
      const ids = seekChildren.filter((child) => child.id === ID.SeekId);
      const positions = seekChildren.filter((child) => child.id === ID.SeekPosition);
      if (ids.length !== 1 || positions.length !== 1) {
        throw invalidStructure('Seek must contain exactly one SeekID and SeekPosition');
      }
      const seekId = ids[0];
      const position = positions[0];
      if (seekId === undefined || position === undefined) {
        throw invalidStructure('Seek is missing its required children');
      }
      if (!bytesEqual(bytes, seekId.dataStart, seekId.dataEnd, tagId)) continue;
      entries.push({
        seekHead,
        ...(seekHeadCrc !== undefined ? { seekHeadCrc } : {}),
        seek,
        position,
        currentPosition: readSafeUint(bytes, position, 'Tags SeekPosition'),
      });
    }
  }
  return entries;
}

interface VoidLayout {
  readonly sizeLength: number;
  readonly payloadLength: number;
}

function voidLayout(totalLength: number): VoidLayout | undefined {
  if (!Number.isSafeInteger(totalLength) || totalLength < 2) return undefined;
  for (let sizeLength = 1; sizeLength <= 8; sizeLength++) {
    const payloadLength = totalLength - 1 - sizeLength;
    if (payloadLength < 0 || payloadLength >= 2 ** (7 * sizeLength) - 1) continue;
    return { sizeLength, payloadLength };
  }
  return undefined;
}

function canPadTags(tagLength: number, totalLength: number): boolean {
  const remainder = totalLength - tagLength;
  return remainder === 0 || voidLayout(remainder) !== undefined;
}

function writeExactVoid(output: Uint8Array, start: number, totalLength: number): boolean {
  const layout = voidLayout(totalLength);
  if (layout === undefined) return false;
  output.fill(0, start, start + totalLength);
  output[start] = ID.Void;
  output.set(sizedVint(layout.payloadLength, layout.sizeLength), start + 1);
  return true;
}

function segmentSizeBytes(
  bytes: Uint8Array,
  segment: ElementSpan,
  payloadLength: number,
): Uint8Array {
  if (segment.unknownSize) return bytes.subarray(segment.sizeOffset, segment.dataStart);
  for (let length = segment.sizeLength; length <= 8; length++) {
    if (payloadLength < 2 ** (7 * length) - 1) {
      return Uint8Array.from(sizedVint(payloadLength, length));
    }
  }
  throw new MediaError('mux-error', `Matroska Segment size ${payloadLength} exceeds EBML limits`);
}

function allocateOutput(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new MediaError('mux-error', `invalid Matroska metadata output size ${length}`);
  }
  try {
    return new Uint8Array(length);
  } catch (error) {
    throw new MediaError(
      'mux-error',
      `could not allocate ${length} Matroska metadata bytes`,
      error,
    );
  }
}

function writeFixedUint(bytes: Uint8Array, start: number, end: number, value: number): boolean {
  let remaining = value;
  for (let offset = end - 1; offset >= start; offset--) {
    bytes[offset] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return remaining === 0;
}

function mappedOffset(
  inputOffset: number,
  inputDataStart: number,
  outputDataStart: number,
): number {
  return outputDataStart + inputOffset - inputDataStart;
}

function refreshMappedCrc(
  output: Uint8Array,
  inputParent: ElementSpan,
  inputCrc: ElementSpan,
  inputDataStart: number,
  outputDataStart: number,
): void {
  const parentDataStart = mappedOffset(inputParent.dataStart, inputDataStart, outputDataStart);
  const parentDataEnd = mappedOffset(inputParent.dataEnd, inputDataStart, outputDataStart);
  const crcStart = mappedOffset(inputCrc.start, inputDataStart, outputDataStart);
  const crcDataStart = mappedOffset(inputCrc.dataStart, inputDataStart, outputDataStart);
  const crcDataEnd = mappedOffset(inputCrc.dataEnd, inputDataStart, outputDataStart);
  const value = crc32([
    output.subarray(parentDataStart, crcStart),
    output.subarray(crcDataEnd, parentDataEnd),
  ]);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    crcDataStart,
    value,
    true,
  );
}

export function writeMkvTags(bytes: Uint8Array, tags: MetadataTags): Uint8Array {
  const segment = findSegment(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const children = childrenOf(dv, segment.dataStart, segment.dataEnd, 'Segment');
  const segmentCrc = validateParentCrc(bytes, segment, children, 'Segment');
  const seeks = tagSeekEntries(bytes, dv, children);
  const tagBytes = tagsElement(tags);
  const tagSpans = children.filter((child) => child.id === ID.Tags);
  const availableSpans = [
    ...tagSpans.filter((span) =>
      seeks.some((seek) => seek.currentPosition === span.start - segment.dataStart),
    ),
    ...tagSpans.filter(
      (span) => !seeks.some((seek) => seek.currentPosition === span.start - segment.dataStart),
    ),
    ...children.filter((child) => child.id === ID.Void),
  ];
  const host =
    tagBytes === undefined
      ? undefined
      : availableSpans.find((span) => canPadTags(tagBytes.byteLength, span.dataEnd - span.start));
  const append = tagBytes !== undefined && host === undefined ? tagBytes : undefined;
  const originalPayloadLength = segment.dataEnd - segment.dataStart;
  const newPayloadLength = originalPayloadLength + (append?.byteLength ?? 0);
  const sizeBytes = segmentSizeBytes(bytes, segment, newPayloadLength);
  const headerDelta = sizeBytes.byteLength - segment.sizeLength;
  const output = allocateOutput(bytes.byteLength + headerDelta + (append?.byteLength ?? 0));
  output.set(bytes.subarray(0, segment.sizeOffset), 0);
  output.set(sizeBytes, segment.sizeOffset);
  const outputDataStart = segment.sizeOffset + sizeBytes.byteLength;
  output.set(bytes.subarray(segment.dataStart, segment.dataEnd), outputDataStart);
  const outputOriginalEnd = outputDataStart + originalPayloadLength;
  if (append !== undefined) output.set(append, outputOriginalEnd);
  const outputSegmentEnd = outputOriginalEnd + (append?.byteLength ?? 0);
  output.set(bytes.subarray(segment.dataEnd), outputSegmentEnd);

  for (const span of tagSpans) {
    const start = mappedOffset(span.start, segment.dataStart, outputDataStart);
    if (!writeExactVoid(output, start, span.dataEnd - span.start)) {
      throw invalidStructure('Tags element is too short to replace with a valid Void');
    }
  }
  if (host !== undefined && tagBytes !== undefined) {
    const start = mappedOffset(host.start, segment.dataStart, outputDataStart);
    const remainder = host.dataEnd - host.start - tagBytes.byteLength;
    output.set(tagBytes, start);
    if (remainder !== 0 && !writeExactVoid(output, start + tagBytes.byteLength, remainder)) {
      throw new MediaError('mux-error', 'planned Matroska tag span no longer fits');
    }
  }

  const tagPosition =
    tagBytes === undefined
      ? undefined
      : host === undefined
        ? originalPayloadLength
        : host.start - segment.dataStart;
  const modifiedSeekHeads = new Map<number, { parent: ElementSpan; crc?: ElementSpan }>();
  for (const seek of seeks) {
    const seekStart = mappedOffset(seek.seek.start, segment.dataStart, outputDataStart);
    const positionStart = mappedOffset(seek.position.dataStart, segment.dataStart, outputDataStart);
    const positionEnd = mappedOffset(seek.position.dataEnd, segment.dataStart, outputDataStart);
    if (
      tagPosition === undefined ||
      !writeFixedUint(output, positionStart, positionEnd, tagPosition)
    ) {
      if (!writeExactVoid(output, seekStart, seek.seek.dataEnd - seek.seek.start)) {
        throw invalidStructure('Tags Seek is too short to replace with a valid Void');
      }
    }
    modifiedSeekHeads.set(seek.seekHead.start, {
      parent: seek.seekHead,
      ...(seek.seekHeadCrc !== undefined ? { crc: seek.seekHeadCrc } : {}),
    });
  }
  for (const { parent, crc } of modifiedSeekHeads.values()) {
    if (crc !== undefined) {
      refreshMappedCrc(output, parent, crc, segment.dataStart, outputDataStart);
    }
  }
  if (segmentCrc !== undefined) {
    const crcStart = mappedOffset(segmentCrc.start, segment.dataStart, outputDataStart);
    const crcDataStart = mappedOffset(segmentCrc.dataStart, segment.dataStart, outputDataStart);
    const crcDataEnd = mappedOffset(segmentCrc.dataEnd, segment.dataStart, outputDataStart);
    const value = crc32([
      output.subarray(outputDataStart, crcStart),
      output.subarray(crcDataEnd, outputSegmentEnd),
    ]);
    new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
      crcDataStart,
      value,
      true,
    );
  }
  return output;
}

function readUtf8(dv: DataView, start: number, end: number): string {
  return utf8String(new Uint8Array(dv.buffer, dv.byteOffset + start, end - start));
}

export function readMkvTags(bytes: Uint8Array): Record<string, string> {
  const segment = findSegment(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentChildren = childrenOf(dv, segment.dataStart, segment.dataEnd, 'Segment');
  validateParentCrc(bytes, segment, segmentChildren, 'Segment');
  const out: Record<string, string> = {};
  const readSimple = (simple: ElementSpan): void => {
    let name: string | undefined;
    let value: string | undefined;
    const children = childrenOf(dv, simple.dataStart, simple.dataEnd, 'SimpleTag');
    for (const child of children) {
      if (child.id === ID.TagName) name = readUtf8(dv, child.dataStart, child.dataEnd);
      else if (child.id === ID.TagString) value = readUtf8(dv, child.dataStart, child.dataEnd);
    }
    if (name !== undefined && value !== undefined) out[publicKeyFromVorbis(name)] = value;
    for (const child of children) {
      if (child.id === ID.SimpleTag) readSimple(child);
    }
  };
  for (const top of segmentChildren) {
    if (top.id !== ID.Tags) continue;
    for (const tag of childrenOf(dv, top.dataStart, top.dataEnd, 'Tags')) {
      if (tag.id !== ID.Tag) continue;
      for (const simple of childrenOf(dv, tag.dataStart, tag.dataEnd, 'Tag')) {
        if (simple.id === ID.SimpleTag) readSimple(simple);
      }
    }
  }
  return out;
}
