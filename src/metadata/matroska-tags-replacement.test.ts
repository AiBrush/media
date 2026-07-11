import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { demuxWebm, webmPacketPayloadInfoFromBytes } from '../drivers/webm/webm-driver.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { readMkvTags, writeMkvTags } from './matroska-tags.ts';

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekId: 0x53ab,
  SeekPosition: 0x53ac,
  Tags: 0x1254c367,
  Tag: 0x7373,
  Targets: 0x63c0,
  TagTrackUid: 0x63c5,
  TagAttachmentUid: 0x63c6,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  Cluster: 0x1f43b675,
  Attachments: 0x1941a469,
  Crc32: 0xbf,
  Void: 0xec,
} as const;

const LICENSED_WEBM_FIXTURES = [
  'movie_5.webm',
  'bear-opus.webm',
  '2x2-green.webm',
  'white.webm',
  'bear-vp9-alpha.webm',
] as const;

const ATTACHMENT_MKV = new URL(
  '../../../media-test/fixtures/media/scenarios/metadata/write_mkv_tags/03.mkv',
  import.meta.url,
).pathname;

interface Vint {
  readonly value: number;
  readonly length: number;
  readonly unknown: boolean;
}

interface ElementSpan {
  readonly id: number;
  readonly start: number;
  readonly sizeOffset: number;
  readonly sizeLength: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly unknownSize: boolean;
}

interface SimpleTagValue {
  readonly name: string;
  readonly value: string;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength, sha256: digest(value) };
  }
  if (value instanceof ArrayBuffer) {
    return canonicalize(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return canonicalize(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function mediaSnapshot(bytes: Uint8Array): unknown {
  const demux = demuxWebm(bytes);
  const table = webmPacketPayloadInfoFromBytes(bytes);
  return canonicalize({
    info: demux.info,
    frames: demux.framesByIndex.map((frames) =>
      frames.map((frame) => ({
        timestampUs: frame.timestampUs,
        keyframe: frame.keyframe,
        discardPaddingNs: frame.discardPaddingNs,
        data: frame.data,
        alpha: frame.alpha,
      })),
    ),
    tracks: table.tracks,
    packets: table.packets.map((packet) => ({
      trackIndex: packet.trackIndex,
      size: packet.size,
      ptsUs: packet.ptsUs,
      dtsUs: packet.dtsUs,
      durationUs: packet.durationUs,
      keyframe: packet.keyframe,
      data: packet.data,
      alpha: packet.alpha,
    })),
  });
}

function readIndependentVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint {
  const first = bytes[offset];
  if (first === undefined || first === 0) throw new Error(`invalid VINT at ${offset}`);
  let length = 1;
  let marker = 0x80;
  while ((first & marker) === 0) {
    length++;
    marker >>= 1;
  }
  if (length > 8 || offset + length > bytes.byteLength) {
    throw new Error(`truncated VINT at ${offset}`);
  }
  let value = keepMarker ? first : first & (marker - 1);
  let allOnes = (first & (marker - 1)) === marker - 1;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw new Error(`truncated VINT at ${offset}`);
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function independentElement(bytes: Uint8Array, offset: number, parentEnd: number): ElementSpan {
  const id = readIndependentVint(bytes, offset, true);
  const sizeOffset = offset + id.length;
  const size = readIndependentVint(bytes, sizeOffset, false);
  const dataStart = sizeOffset + size.length;
  const dataEnd = size.unknown ? parentEnd : dataStart + size.value;
  if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > parentEnd) {
    throw new Error(`element 0x${id.value.toString(16)} exceeds its parent`);
  }
  return {
    id: id.value,
    start: offset,
    sizeOffset,
    sizeLength: size.length,
    dataStart,
    dataEnd,
    unknownSize: size.unknown,
  };
}

function independentChildren(bytes: Uint8Array, start: number, end: number): ElementSpan[] {
  const out: ElementSpan[] = [];
  let offset = start;
  while (offset < end) {
    const child = independentElement(bytes, offset, end);
    if (child.unknownSize) throw new Error('test-side walker requires finite child sizes');
    out.push(child);
    offset = child.dataEnd;
  }
  if (offset !== end) throw new Error('test-side walker did not consume the parent');
  return out;
}

function independentSegment(bytes: Uint8Array): ElementSpan {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const element = independentElement(bytes, offset, bytes.byteLength);
    if (element.id === ID.Segment) return element;
    if (element.unknownSize) throw new Error('unknown-size root before Segment');
    offset = element.dataEnd;
  }
  throw new Error('missing Segment');
}

function idBytes(id: number): Uint8Array {
  const width = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const out = new Uint8Array(width);
  for (let index = 0; index < width; index++) {
    out[index] = (id >>> ((width - index - 1) * 8)) & 0xff;
  }
  return out;
}

function sizedVint(value: number, length?: number): Uint8Array {
  let width = length ?? 1;
  if (length === undefined) {
    while (width <= 8 && value >= 2 ** (7 * width) - 1) width++;
  }
  if (width > 8 || value < 0 || value >= 2 ** (7 * width) - 1) {
    throw new Error(`value ${value} does not fit a ${width}-byte VINT`);
  }
  const out = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 1; index--) {
    out[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  out[0] = remaining | (0x80 >> (width - 1));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizedVint(payload.byteLength), payload]);
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
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

function simpleTag(name: string, value: string, nested?: Uint8Array): Uint8Array {
  return element(
    ID.SimpleTag,
    concat([
      stringElement(ID.TagName, name),
      stringElement(ID.TagString, value),
      ...(nested === undefined ? [] : [nested]),
    ]),
  );
}

function staleTagElements(): readonly Uint8Array[] {
  const targeted = element(
    ID.Tags,
    concat([
      element(
        ID.Tag,
        concat([
          element(ID.Targets, uintElement(ID.TagTrackUid, 1)),
          simpleTag('TITLE', 'stale-track-title', simpleTag('COMMENT', 'stale-nested')),
          simpleTag('ARTIST', 'stale-track-artist'),
        ]),
      ),
      element(
        ID.Tag,
        concat([
          element(ID.Targets, uintElement(ID.TagAttachmentUid, 2)),
          simpleTag('GENRE', 'stale-attachment-genre'),
        ]),
      ),
    ]),
  );
  const global = element(
    ID.Tags,
    element(
      ID.Tag,
      concat([element(ID.Targets, new Uint8Array()), simpleTag('TITLE', 'stale-global-title')]),
    ),
  );
  return [targeted, global];
}

function insertBeforeFirstCluster(bytes: Uint8Array, additions: readonly Uint8Array[]): Uint8Array {
  const segment = independentSegment(bytes);
  const children = independentChildren(bytes, segment.dataStart, segment.dataEnd);
  const insertion = children.find((child) => child.id === ID.Cluster)?.start ?? segment.dataEnd;
  const addedLength = additions.reduce((sum, addition) => sum + addition.byteLength, 0);
  const newSize = segment.dataEnd - segment.dataStart + addedLength;
  const sizeBytes = segment.unknownSize
    ? bytes.slice(segment.sizeOffset, segment.dataStart)
    : sizedVint(newSize, segment.sizeLength);
  return concat([
    bytes.subarray(0, segment.sizeOffset),
    sizeBytes,
    bytes.subarray(segment.dataStart, insertion),
    ...additions,
    bytes.subarray(insertion),
  ]);
}

function simpleTagValues(bytes: Uint8Array): SimpleTagValue[] {
  const segment = independentSegment(bytes);
  const decoder = new TextDecoder();
  const out: SimpleTagValue[] = [];
  const visitSimple = (simple: ElementSpan): void => {
    const children = independentChildren(bytes, simple.dataStart, simple.dataEnd);
    const name = children.find((child) => child.id === ID.TagName);
    const value = children.find((child) => child.id === ID.TagString);
    if (name !== undefined && value !== undefined) {
      out.push({
        name: decoder.decode(bytes.subarray(name.dataStart, name.dataEnd)),
        value: decoder.decode(bytes.subarray(value.dataStart, value.dataEnd)),
      });
    }
    for (const child of children) {
      if (child.id === ID.SimpleTag) visitSimple(child);
    }
  };
  for (const tags of independentChildren(bytes, segment.dataStart, segment.dataEnd)) {
    if (tags.id !== ID.Tags) continue;
    for (const tag of independentChildren(bytes, tags.dataStart, tags.dataEnd)) {
      if (tag.id !== ID.Tag) continue;
      for (const child of independentChildren(bytes, tag.dataStart, tag.dataEnd)) {
        if (child.id === ID.SimpleTag) visitSimple(child);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value));
}

function topLevelCount(bytes: Uint8Array, id: number): number {
  const segment = independentSegment(bytes);
  return independentChildren(bytes, segment.dataStart, segment.dataEnd).filter(
    (child) => child.id === id,
  ).length;
}

function independentUint(bytes: Uint8Array, span: ElementSpan): number {
  let value = 0;
  for (let offset = span.dataStart; offset < span.dataEnd; offset++) {
    value = value * 256 + (bytes[offset] ?? 0);
  }
  return value;
}

function tagSeekPositions(bytes: Uint8Array): number[] {
  const segment = independentSegment(bytes);
  const tagId = idBytes(ID.Tags);
  const positions: number[] = [];
  for (const seekHead of independentChildren(bytes, segment.dataStart, segment.dataEnd)) {
    if (seekHead.id !== ID.SeekHead) continue;
    for (const seek of independentChildren(bytes, seekHead.dataStart, seekHead.dataEnd)) {
      if (seek.id !== ID.Seek) continue;
      const children = independentChildren(bytes, seek.dataStart, seek.dataEnd);
      const seekId = children.find((child) => child.id === ID.SeekId);
      const position = children.find((child) => child.id === ID.SeekPosition);
      if (seekId === undefined || position === undefined) continue;
      const actualId = bytes.subarray(seekId.dataStart, seekId.dataEnd);
      if (actualId.byteLength !== tagId.byteLength) continue;
      if (!actualId.every((byte, index) => byte === tagId[index])) continue;
      positions.push(independentUint(bytes, position));
    }
  }
  return positions;
}

function assertTagSeekTargets(bytes: Uint8Array): void {
  const segment = independentSegment(bytes);
  for (const position of tagSeekPositions(bytes)) {
    expect(independentElement(bytes, segment.dataStart + position, segment.dataEnd).id).toBe(
      ID.Tags,
    );
  }
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

function withSegmentCrc(bytes: Uint8Array): Uint8Array {
  expect(crc32([new TextEncoder().encode('123456789')])).toBe(0xcbf43926);
  const withPlaceholder = insertBeforeSegmentChild(bytes, element(ID.Crc32, new Uint8Array(4)));
  const segment = independentSegment(withPlaceholder);
  const children = independentChildren(withPlaceholder, segment.dataStart, segment.dataEnd);
  const crc = children[0];
  if (crc?.id !== ID.Crc32 || crc.dataEnd - crc.dataStart !== 4) {
    throw new Error('failed to insert Segment CRC-32');
  }
  const out = withPlaceholder.slice();
  new DataView(out.buffer).setUint32(
    crc.dataStart,
    crc32([out.subarray(segment.dataStart, crc.start), out.subarray(crc.dataEnd, segment.dataEnd)]),
    true,
  );
  return out;
}

function insertBeforeSegmentChild(bytes: Uint8Array, addition: Uint8Array): Uint8Array {
  const segment = independentSegment(bytes);
  const newSize = segment.dataEnd - segment.dataStart + addition.byteLength;
  const sizeBytes = segment.unknownSize
    ? bytes.slice(segment.sizeOffset, segment.dataStart)
    : sizedVint(newSize, segment.sizeLength);
  return concat([
    bytes.subarray(0, segment.sizeOffset),
    sizeBytes,
    addition,
    bytes.subarray(segment.dataStart),
  ]);
}

function segmentCrcIsValid(bytes: Uint8Array): boolean {
  const segment = independentSegment(bytes);
  const children = independentChildren(bytes, segment.dataStart, segment.dataEnd);
  const crc = children[0];
  if (crc?.id !== ID.Crc32 || crc.dataEnd - crc.dataStart !== 4) return false;
  const actual = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    crc.dataStart,
    true,
  );
  const expected = crc32([
    bytes.subarray(segment.dataStart, crc.start),
    bytes.subarray(crc.dataEnd, segment.dataEnd),
  ]);
  return actual === expected;
}

describe('Matroska tag replacement', () => {
  it.each(LICENSED_WEBM_FIXTURES)(
    'replaces every prior tag tree idempotently and preserves exact media: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const seeded = insertBeforeFirstCluster(input, staleTagElements());
      expect(topLevelCount(seeded, ID.Tags)).toBeGreaterThanOrEqual(2);
      expect(simpleTagValues(seeded).some(({ value }) => value.startsWith('stale-'))).toBe(true);
      const before = mediaSnapshot(seeded);

      const generationA = writeMkvTags(seeded, {
        title: 'Generation A',
        comment: 'must disappear on replacement',
      });
      const generationB = writeMkvTags(generationA, {
        title: 'Generation B',
        artist: 'Only requested values',
      });
      let repeated = generationB;
      for (let iteration = 0; iteration < 12; iteration++) {
        repeated = writeMkvTags(repeated, {
          title: 'Generation B',
          artist: 'Only requested values',
        });
        expect(repeated.byteLength).toBe(generationB.byteLength);
      }

      expect(repeated).toEqual(generationB);
      expect(topLevelCount(generationB, ID.Tags)).toBe(1);
      expect(simpleTagValues(generationB)).toEqual([
        { name: 'ARTIST', value: 'Only requested values' },
        { name: 'TITLE', value: 'Generation B' },
      ]);
      expect(readMkvTags(generationB)).toEqual({
        artist: 'Only requested values',
        title: 'Generation B',
      });
      expect(tagSeekPositions(generationB).length).toBe(tagSeekPositions(seeded).length);
      assertTagSeekTargets(generationB);
      expect(mediaSnapshot(generationB)).toEqual(before);
    },
  );

  it('preserves exact real Matroska attachments, packet clocks, and codec setup', async () => {
    const input = new Uint8Array(await readFile(ATTACHMENT_MKV));
    const before = mediaSnapshot(input);
    const attachmentCount = demuxWebm(input).info.tracks.filter(
      (track) => track.attachedFilePayload !== undefined,
    ).length;
    expect(attachmentCount).toBeGreaterThan(0);

    const first = writeMkvTags(input, { title: 'Attachment-safe replacement' });
    const second = writeMkvTags(first, { title: 'Attachment-safe replacement' });

    expect(second).toEqual(first);
    expect(topLevelCount(second, ID.Attachments)).toBe(topLevelCount(input, ID.Attachments));
    expect(simpleTagValues(second)).toEqual([
      { name: 'TITLE', value: 'Attachment-safe replacement' },
    ]);
    expect(mediaSnapshot(second)).toEqual(before);
  });

  it('clears tags without leaving an empty Tag tree and widens a finite Segment size VINT', () => {
    const seeded = element(ID.Segment, concat(staleTagElements()));
    const cleared = writeMkvTags(seeded, {});
    expect(topLevelCount(cleared, ID.Tags)).toBe(0);
    expect(writeMkvTags(cleared, {})).toEqual(cleared);

    const empty = element(ID.Segment, new Uint8Array());
    expect(independentSegment(empty).sizeLength).toBe(1);
    const widened = writeMkvTags(empty, { comment: 'x'.repeat(256) });
    expect(independentSegment(widened).sizeLength).toBeGreaterThan(1);
    expect(readMkvTags(widened)).toEqual({ comment: 'x'.repeat(256) });
    expect(writeMkvTags(widened, { comment: 'x'.repeat(256) })).toEqual(widened);
  });

  it('voids an indexed Tags Seek when the requested replacement is empty', async () => {
    const input = await loadFixture('movie_5.webm');
    expect(tagSeekPositions(input).length).toBeGreaterThan(0);
    const output = writeMkvTags(input, {});
    expect(topLevelCount(output, ID.Tags)).toBe(0);
    expect(tagSeekPositions(output)).toEqual([]);
    expect(mediaSnapshot(output)).toEqual(mediaSnapshot(input));
    expect(writeMkvTags(output, {})).toEqual(output);
  });

  it('supports an unknown-size Segment but rejects ambiguous or malformed child boundaries typed', () => {
    const unknownSegment = concat([
      idBytes(ID.Segment),
      Uint8Array.of(0xff),
      element(ID.Void, Uint8Array.of(1, 2, 3)),
    ]);
    const rewritten = writeMkvTags(unknownSegment, { title: 'Unknown Segment' });
    expect(rewritten[idBytes(ID.Segment).byteLength]).toBe(0xff);
    expect(readMkvTags(rewritten)).toEqual({ title: 'Unknown Segment' });

    const unknownCluster = element(
      ID.Segment,
      concat([idBytes(ID.Cluster), Uint8Array.of(0xff), Uint8Array.of(0xe7, 0x81, 0)]),
    );
    expect(() => writeMkvTags(unknownCluster, { title: 'unsafe' })).toThrow(InputError);
    expect(() => readMkvTags(unknownCluster)).toThrow(InputError);

    const truncatedChild = element(
      ID.Segment,
      concat([idBytes(ID.Void), Uint8Array.of(0x8a), Uint8Array.of(1)]),
    );
    expect(() => writeMkvTags(truncatedChild, { title: 'unsafe' })).toThrow(InputError);
    expect(() => readMkvTags(truncatedChild)).toThrow(InputError);
  });

  it('refreshes a valid first-child Segment CRC and rejects malformed CRC placement typed', async () => {
    const input = withSegmentCrc(await loadFixture('movie_5.webm'));
    expect(segmentCrcIsValid(input)).toBe(true);
    const output = writeMkvTags(input, { title: 'CRC replacement' });
    expect(segmentCrcIsValid(output)).toBe(true);
    expect(mediaSnapshot(output)).toEqual(mediaSnapshot(input));

    const misplaced = insertBeforeFirstCluster(await loadFixture('bear-opus.webm'), [
      element(ID.Crc32, new Uint8Array(4)),
    ]);
    expect(() => writeMkvTags(misplaced, { title: 'unsafe' })).toThrow(InputError);
  });
});
