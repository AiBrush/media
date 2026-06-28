import { describe, expect, it } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { readMp3Id3Tags, writeMp3Id3Tags } from './id3.ts';
import { readMkvTags, writeMkvTags } from './matroska-tags.ts';
import { readMp4Tags, writeMp4Tags } from './mp4-tags.ts';
import { readOggVorbisComment, writeOggVorbisComment } from './ogg-vorbis-comment.ts';
import {
  mergeStringTags,
  normalizePublicKey,
  normalizeTags,
  publicKeyFromVorbis,
  readU32le,
  u32le,
  utf8Bytes,
  vorbisKeyFor,
} from './tag-map.ts';
import {
  buildVorbisCommentBody,
  readFlacVorbisComment,
  readVorbisCommentBody,
  writeFlacVorbisComment,
} from './vorbis-comment.ts';

function synchsafe(value: number): number[] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64be(value: number): number[] {
  return [
    Math.floor(value / 2 ** 56) & 0xff,
    Math.floor(value / 2 ** 48) & 0xff,
    Math.floor(value / 2 ** 40) & 0xff,
    Math.floor(value / 2 ** 32) & 0xff,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function id3Frame(id: string, payload: Uint8Array, version = 4): Uint8Array {
  const size = version === 4 ? synchsafe(payload.byteLength) : u32be(payload.byteLength);
  return Uint8Array.from([...utf8Bytes(id), ...size, 0, 0, ...payload]);
}

function id3Tag(frames: readonly Uint8Array[], version = 4): Uint8Array {
  const payload = concat(frames);
  return Uint8Array.from([
    0x49,
    0x44,
    0x33,
    version,
    0,
    0,
    ...synchsafe(payload.byteLength),
    ...payload,
  ]);
}

function textPayload(value: string, encoding = 0x03): Uint8Array {
  return Uint8Array.from([encoding, ...utf8Bytes(value)]);
}

function utf16lePayload(value: string): Uint8Array {
  const bytes: number[] = [0x01, 0xff, 0xfe];
  for (const char of value) {
    const code = char.charCodeAt(0);
    bytes.push(code & 0xff, (code >>> 8) & 0xff);
  }
  bytes.push(0, 0);
  return Uint8Array.from(bytes);
}

function commentPayload(value: string, encoding = 0x03): Uint8Array {
  if (encoding === 0x01) {
    return Uint8Array.from([0x01, 0x65, 0x6e, 0x67, ...utf16lePayload(value).subarray(1)]);
  }
  return Uint8Array.from([encoding, 0x65, 0x6e, 0x67, 0, ...utf8Bytes(value)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function flacWithBlocks(
  blocks: readonly { type: number; body: Uint8Array; last?: boolean }[],
): Uint8Array {
  const encoded = blocks.map((block, index) =>
    Uint8Array.from([
      block.type | (block.last === true || index === blocks.length - 1 ? 0x80 : 0),
      (block.body.byteLength >>> 16) & 0xff,
      (block.body.byteLength >>> 8) & 0xff,
      block.body.byteLength & 0xff,
      ...block.body,
    ]),
  );
  return concat([utf8Bytes('fLaC'), ...encoded, Uint8Array.from([0xff, 0xf8])]);
}

function oggPage(opts: {
  headerType: number;
  serial?: number;
  sequence?: number;
  packets?: readonly Uint8Array[];
}): Uint8Array {
  const serial = opts.serial ?? 1;
  const sequence = opts.sequence ?? 0;
  const packets = opts.packets ?? [];
  const lacing = packets.map((packet) => packet.byteLength);
  const body = concat(packets);
  return Uint8Array.from([
    0x4f,
    0x67,
    0x67,
    0x53,
    0,
    opts.headerType,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    ...u32le(serial),
    ...u32le(sequence),
    0,
    0,
    0,
    0,
    lacing.length,
    ...lacing,
    ...body,
  ]);
}

function oggHeader(
  version: number,
  segmentCount: number,
  segments: readonly number[] = [],
): Uint8Array {
  return Uint8Array.from([
    0x4f,
    0x67,
    0x67,
    0x53,
    version,
    0,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    ...u32le(1),
    ...u32le(0),
    0,
    0,
    0,
    0,
    segmentCount,
    ...segments,
  ]);
}

function ebmlId(id: number): Uint8Array {
  if (id > 0xffffff)
    return Uint8Array.from([(id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  if (id > 0xffff) return Uint8Array.from([(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  if (id > 0xff) return Uint8Array.from([(id >>> 8) & 0xff, id & 0xff]);
  return Uint8Array.from([id & 0xff]);
}

function ebmlElement(id: number, body: Uint8Array, unknownSize = false): Uint8Array {
  return concat([ebmlId(id), Uint8Array.from([unknownSize ? 0xff : 0x80 | body.byteLength]), body]);
}

function mp4Box(type: string, body: Uint8Array): Uint8Array {
  return Uint8Array.from([...u32be(8 + body.byteLength), ...utf8Bytes(type), ...body]);
}

function mp4FullBox(type: string, body: Uint8Array): Uint8Array {
  return mp4Box(type, Uint8Array.from([0, 0, 0, 0, ...body]));
}

function mp4DataBox(value: string): Uint8Array {
  return mp4Box('data', Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, ...utf8Bytes(value)]));
}

describe('metadata helpers — branch/error coverage', () => {
  it('normalizes custom tags, rejects NULs, and merges Vorbis-style entries deterministically', () => {
    expect(normalizePublicKey('Album Artist')).toBe('albumArtist');
    expect(normalizePublicKey(' custom-key ')).toBe('custom_key');
    expect(normalizeTags({ '   ': 'ignored', title: 'Kept' })).toEqual([
      { key: 'title', value: 'Kept' },
    ]);
    expect(() => normalizeTags({ 'bad\0key': 'x' })).toThrow(MediaError);
    expect(() => normalizeTags({ title: 'bad\0value' })).toThrow(MediaError);
    expect(vorbisKeyFor('!')).toBe('_');
    expect(vorbisKeyFor('   ')).toBe('TAG');
    expect(publicKeyFromVorbis('X-CUSTOM')).toBe('x-custom');
    expect(readU32le(Uint8Array.of(1, 2), 0)).toBeUndefined();
    expect(mergeStringTags(['TITLE=old', 'BROKEN', '=bad', 'KEEP=yes'], { title: 'new' })).toEqual([
      'KEEP=yes',
      'TITLE=new',
    ]);
  });

  it('reads ID3v2.3/v2.4 text, comment, custom, padding, and malformed branches', () => {
    const tag = id3Tag(
      [
        id3Frame('TYER', textPayload('1999'), 3),
        id3Frame('TPE1', utf16lePayload('Artist'), 3),
        id3Frame('TXXX', textPayload('RATING=Five'), 3),
        id3Frame('TXXX', textPayload('no-equals'), 3),
        id3Frame('COMM', commentPayload('hello', 0x01), 3),
        id3Frame('COMM', Uint8Array.of(0x03, 0x65, 0x6e, 0x67, ...utf8Bytes('plain')), 3),
        id3Frame('COMM', new Uint8Array(), 3),
        id3Frame('TALB', textPayload('raw', 0x09), 3),
        Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ],
      3,
    );

    const parsedId3 = readMp3Id3Tags(tag) as { readonly comment?: string } & Record<string, string>;
    expect(parsedId3).toMatchObject({
      date: '1999',
      artist: 'Artist',
      rating: 'Five',
      album: '\traw',
    });
    expect(parsedId3.comment).toBe('');
    expect(readMp3Id3Tags(Uint8Array.of(0xff, 0xfb))).toEqual({});
    expect(() =>
      readMp3Id3Tags(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0])),
    ).toThrow(InputError);
    expect(
      readMp3Id3Tags(
        Uint8Array.from([
          0x49,
          0x44,
          0x33,
          4,
          0,
          0,
          0,
          0,
          0,
          10,
          ...utf8Bytes('TIT2'),
          0x80,
          0,
          0,
          0,
          0,
          0,
        ]),
      ),
    ).toEqual({});
  });

  it('writes ID3 custom/private frames and replaces an old tag before audio bytes', () => {
    const old = id3Tag([id3Frame('TIT2', textPayload('old'))]);
    const audio = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
    const output = writeMp3Id3Tags(concat([old, audio]), {
      title: 'new',
      'Disc Label': 'A',
      description: 'spoken',
    });

    expect(readMp3Id3Tags(output)).toMatchObject({
      title: 'new',
      disc_label: 'A',
      comment: 'spoken',
    });
    expect([...output.slice(output.byteLength - audio.byteLength)]).toEqual([...audio]);
  });

  it('covers VorbisComment body and native-FLAC insertion/error branches', () => {
    const body = buildVorbisCommentBody(
      { title: 'Fresh', custom: 'Value' },
      concat([
        Uint8Array.from(u32le(0)),
        Uint8Array.from(u32le(1)),
        Uint8Array.from(u32le(9)),
        utf8Bytes('TITLE=Old'),
      ]),
    );
    expect(readVorbisCommentBody(body)).toMatchObject({ title: 'Fresh', custom: 'Value' });
    expect(
      buildVorbisCommentBody({ title: 'Fallback' }, Uint8Array.of(1, 2, 3)).byteLength,
    ).toBeGreaterThan(0);
    expect(() => readVorbisCommentBody(Uint8Array.of(1, 0, 0))).toThrow(MediaError);
    expect(() =>
      readVorbisCommentBody(concat([Uint8Array.from(u32le(1)), utf8Bytes('v')])),
    ).toThrow(MediaError);
    expect(() =>
      readVorbisCommentBody(concat([Uint8Array.from(u32le(0)), Uint8Array.from(u32le(1))])),
    ).toThrow(MediaError);
    expect(
      readVorbisCommentBody(
        concat([
          Uint8Array.from(u32le(1)),
          utf8Bytes('v'),
          Uint8Array.from(u32le(1)),
          Uint8Array.from(u32le(6)),
          utf8Bytes('BROKEN'),
        ]),
      ),
    ).toEqual({});

    const streamInfoOnly = flacWithBlocks([{ type: 0, body: new Uint8Array(34) }]);
    expect(readFlacVorbisComment(streamInfoOnly)).toEqual({});
    const tagged = writeFlacVorbisComment(streamInfoOnly, { title: 'Inserted' });
    expect(readFlacVorbisComment(tagged)).toEqual({ title: 'Inserted' });
    const withComments = flacWithBlocks([
      { type: 0, body: new Uint8Array(34), last: false },
      { type: 4, body: buildVorbisCommentBody({ title: 'Old' }), last: false },
      { type: 4, body: buildVorbisCommentBody({ artist: 'Drop' }) },
    ]);
    expect(
      readFlacVorbisComment(writeFlacVorbisComment(withComments, { title: 'Replaced' })),
    ).toEqual({
      title: 'Replaced',
    });
    expect(() => readFlacVorbisComment(Uint8Array.of(0))).toThrow(InputError);
    expect(() =>
      readFlacVorbisComment(Uint8Array.from([...utf8Bytes('fLaC'), 0x80, 0, 0, 4, 1])),
    ).toThrow(MediaError);
    expect(() => readFlacVorbisComment(flacWithBlocks([{ type: 4, body }]))).toThrow(MediaError);
  });

  it('covers Ogg comment reader/writer graceful and unsupported-header branches', () => {
    const opusHead = utf8Bytes('OpusHead');
    const opusTags = concat([utf8Bytes('OpusTags'), buildVorbisCommentBody({ title: 'Old' })]);
    const ogg = concat([
      oggPage({ headerType: 0x02, sequence: 0, packets: [opusHead] }),
      oggPage({ headerType: 0, sequence: 1, packets: [opusTags] }),
    ]);

    expect(readOggVorbisComment(ogg)).toEqual({ title: 'Old' });
    expect(readOggVorbisComment(writeOggVorbisComment(ogg, { title: 'New' }))).toEqual({
      title: 'New',
    });
    expect(() => readOggVorbisComment(Uint8Array.of(1, 2, 3))).toThrow(InputError);
    expect(readOggVorbisComment(oggPage({ headerType: 0, packets: [opusHead] }))).toEqual({});
    expect(readOggVorbisComment(oggPage({ headerType: 0x02 }))).toEqual({});
    expect(() =>
      writeOggVorbisComment(oggPage({ headerType: 0, packets: [opusHead] }), { title: 'x' }),
    ).toThrow(InputError);
    expect(() => writeOggVorbisComment(oggPage({ headerType: 0x02 }), { title: 'x' })).toThrow(
      InputError,
    );
    expect(() =>
      writeOggVorbisComment(oggPage({ headerType: 0x02, packets: [utf8Bytes('unknown')] }), {
        title: 'x',
      }),
    ).toThrow(MediaError);
    expect(() =>
      writeOggVorbisComment(oggPage({ headerType: 0x02, packets: [opusHead] }), { title: 'x' }),
    ).toThrow(MediaError);
    expect(() => readOggVorbisComment(oggHeader(1, 0))).toThrow(InputError);
    expect(() => readOggVorbisComment(oggHeader(0, 1))).toThrow(InputError);
    expect(() => readOggVorbisComment(oggHeader(0, 1, [10]))).toThrow(InputError);

    const vorbisId = Uint8Array.from([0x01, ...utf8Bytes('vorbis')]);
    const vorbisComment = Uint8Array.from([
      0x03,
      ...utf8Bytes('vorbis'),
      ...buildVorbisCommentBody({ title: 'Vorbis' }),
      0x01,
    ]);
    const vorbisSetup = Uint8Array.from([0x05, ...utf8Bytes('vorbis'), 0x01]);
    const vorbisOgg = concat([
      Uint8Array.of(0),
      oggPage({ headerType: 0, serial: 99, sequence: 0, packets: [utf8Bytes('ignored')] }),
      oggPage({ headerType: 0x02, serial: 7, sequence: 0, packets: [vorbisId] }),
      oggPage({ headerType: 0, serial: 7, sequence: 1, packets: [vorbisComment] }),
      oggPage({ headerType: 0, serial: 7, sequence: 2, packets: [vorbisSetup] }),
      oggPage({ headerType: 0, serial: 7, sequence: 3, packets: [Uint8Array.of(1, 2, 3)] }),
    ]);
    expect(readOggVorbisComment(vorbisOgg)).toEqual({ title: 'Vorbis' });
    expect(readOggVorbisComment(writeOggVorbisComment(vorbisOgg, { artist: 'New' }))).toMatchObject(
      {
        artist: 'New',
        title: 'Vorbis',
      },
    );
    const longOggTags = readOggVorbisComment(
      writeOggVorbisComment(vorbisOgg, { comment: 'x'.repeat(66_000) }),
    ) as { readonly comment?: string } & Record<string, string>;
    expect(longOggTags.comment?.length).toBe(66_000);
  });

  it('covers Matroska known-size, unknown-size, missing-segment, and incomplete-tag branches', () => {
    const emptySegment = ebmlElement(0x18538067, new Uint8Array());
    const tagged = writeMkvTags(emptySegment, { title: 'Known' });
    expect(readMkvTags(tagged)).toEqual({ title: 'Known' });

    const unknown = ebmlElement(0x18538067, new Uint8Array(), true);
    const taggedUnknown = writeMkvTags(unknown, { artist: 'Unknown' });
    expect(readMkvTags(taggedUnknown)).toEqual({ artist: 'Unknown' });
    expect(() => readMkvTags(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x80))).toThrow(InputError);

    const simpleNameOnly = ebmlElement(
      0x18538067,
      ebmlElement(
        0x1254c367,
        ebmlElement(0x7373, ebmlElement(0x67c8, ebmlElement(0x45a3, utf8Bytes('TITLE')))),
      ),
    );
    expect(readMkvTags(simpleNameOnly)).toEqual({});
  });

  it('covers MP4 freeform and malformed-container branches', async () => {
    const input = await loadFixture('h264.mp4');
    const tagged = writeMp4Tags(input, { 'Project Code': 'P-42', trackNumber: '65599' });
    expect(readMp4Tags(tagged)).toMatchObject({ project_code: 'P-42', trackNumber: '65535' });
    expect(() => readMp4Tags(Uint8Array.of(1, 2, 3))).toThrow(InputError);
    expect(() => writeMp4Tags(Uint8Array.of(1, 2, 3), { title: 'x' })).toThrow(InputError);

    expect(readMp4Tags(mp4Box('moov', new Uint8Array()))).toEqual({});
    expect(readMp4Tags(mp4Box('moov', mp4Box('udta', new Uint8Array())))).toEqual({});
    expect(
      readMp4Tags(mp4Box('moov', mp4Box('udta', mp4FullBox('meta', new Uint8Array())))),
    ).toEqual({});
    const ilst = mp4Box(
      'ilst',
      concat([
        mp4Box('zzzz', mp4DataBox('ignored')),
        mp4Box('trkn', new Uint8Array()),
        mp4Box('trkn', mp4Box('data', Uint8Array.of(0))),
        mp4Box('desc', mp4Box('data', Uint8Array.of(0))),
        mp4Box('----', mp4Box('name', Uint8Array.of(0, 0, 0))),
      ]),
    );
    expect(readMp4Tags(mp4Box('moov', mp4Box('udta', mp4FullBox('meta', ilst))))).toEqual({
      description: '',
      trackNumber: '',
    });

    const stco = mp4FullBox('stco', Uint8Array.from([...u32be(1), ...u32be(16)]));
    const co64 = mp4FullBox('co64', Uint8Array.from([...u32be(1), ...u64be(24)]));
    const emptyStco = mp4FullBox('stco', new Uint8Array());
    const stbl = mp4Box('stbl', concat([stco, co64, emptyStco]));
    const patched = writeMp4Tags(
      concat([
        mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('minf', stbl)))),
        mp4Box('mdat', Uint8Array.of(1)),
      ]),
      { title: 'Offsets' },
    );
    expect(readMp4Tags(patched)).toEqual({ title: 'Offsets' });

    const overflowStco = mp4FullBox('stco', Uint8Array.from([...u32be(1), ...u32be(0xffffffff)]));
    expect(() =>
      writeMp4Tags(
        concat([mp4Box('moov', mp4Box('trak', overflowStco)), mp4Box('mdat', Uint8Array.of(1))]),
        { title: 'Overflow' },
      ),
    ).toThrow(MediaError);
  });
});
