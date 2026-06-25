import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { OggDriver, OggModule, parseOgg } from './ogg-driver.ts';
import { OggMuxer } from './ogg-write.ts';

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u64 = (n: number): number[] => [...u32(n >>> 0), ...u32(Math.floor(n / 2 ** 32))];

function page(opts: {
  bos?: boolean;
  granule?: number;
  serial?: number;
  version?: number;
  data: number[];
}): number[] {
  const data = opts.data;
  const segs: number[] = [];
  let rem = data.length;
  while (rem >= 255) {
    segs.push(255);
    rem -= 255;
  }
  segs.push(rem);
  const granule =
    opts.granule === -1 ? [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : u64(opts.granule ?? 0);
  return [
    ...str('OggS'),
    opts.version ?? 0,
    opts.bos ? 0x02 : 0x00,
    ...granule,
    ...u32(opts.serial ?? 1),
    ...u32(0),
    0,
    0,
    0,
    0, // serial + seq + crc
    segs.length,
    ...segs,
    ...data,
  ];
}
const vorbisId = (ch: number, sr: number): number[] => [
  0x01,
  ...str('vorbis'),
  ...u32(0),
  ch,
  ...u32(sr),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  0xb8,
  0x01,
];
const opusId = (ch: number): number[] => [
  ...str('OpusHead'),
  1,
  ch,
  ...u16(312),
  ...u32(48000),
  ...u16(0),
  0,
];

describe('OggDriver.supports', () => {
  it('recognizes OggS magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sound_5.oga')).subarray(0, 16);
    expect(OggDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', mime: 'audio/ogg' })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', extension: 'oga' })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(OggDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe Ogg on the real corpus (Vorbis)', () => {
  it('sound_5.oga — vorbis audio with sane params (invariants)', async () => {
    const info = await createMedia()
      .use(OggModule)
      .probe(await fixtureSource('sound_5.oga'));
    expect(info.container).toBe('ogg');
    expect(info.tracks[0]?.codec).toBe('vorbis');
    expect([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]).toContain(
      info.tracks[0]?.sampleRate,
    );
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it('sound_5.oga probe matches its committed golden exactly', async () => {
    const info = await createMedia()
      .use(OggModule)
      .probe(await fixtureSource('sound_5.oga'));
    expect(info).toEqual(await loadGoldenMetadata('sound_5.oga'));
  });
});

describe('parseOgg — page + codec parsing', () => {
  it('parses a Vorbis stream and derives duration from the granule', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: vorbisId(2, 44100) }),
      ...page({ granule: 88200, data: [0, 0] }),
    ]);
    const info = parseOgg(bytes);
    expect(info.codec).toBe('vorbis');
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(44100);
    expect(info.durationSec).toBeCloseTo(2, 5); // 88200 / 44100
  });

  it('parses an Opus stream (granule clock is 48 kHz)', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: opusId(2) }),
      ...page({ granule: 96000, data: [0] }),
    ]);
    const info = parseOgg(bytes);
    expect(info.codec).toBe('opus');
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(48000);
    expect(info.durationSec).toBeCloseTo(2, 5); // 96000 / 48000
  });

  it('ignores "no granule" (-1) pages and a wrong-serial page; takes the max valid granule', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: vorbisId(1, 48000) }),
      ...page({ granule: -1, data: [0] }),
      ...page({ granule: 99999, serial: 7, data: [0] }), // different stream → ignored
      ...page({ granule: 48000, data: [0] }),
    ]);
    expect(parseOgg(bytes).durationSec).toBeCloseTo(1, 5); // 48000 / 48000, not 99999
  });

  it('reads the last granule from the tail buffer (head+tail probe)', () => {
    const head = new Uint8Array(page({ bos: true, data: vorbisId(1, 44100) }));
    const tail = new Uint8Array(page({ granule: 44100, data: [0] }));
    expect(parseOgg(head, tail).durationSec).toBeCloseTo(1, 5);
  });

  it('skips junk bytes before the first page (scan resync)', () => {
    const bytes = new Uint8Array([
      0x00,
      0x01,
      0x02,
      ...page({ bos: true, data: vorbisId(1, 44100) }),
      ...page({ granule: 44100, data: [0] }),
    ]);
    expect(parseOgg(bytes).durationSec).toBeCloseTo(1, 5);
  });

  it('skips invalid pages (bad version) and rejects an unrecognized codec', () => {
    expect(() =>
      parseOgg(new Uint8Array(page({ bos: true, version: 1, data: vorbisId(1, 44100) }))),
    ).toThrowError(InputError);
    expect(() =>
      parseOgg(new Uint8Array(page({ bos: true, data: str('unknown!!') }))),
    ).toThrowError(InputError);
  });
});

describe('OggDriver — demux seam + muxer', () => {
  it('demuxes a stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('sound_5.oga');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await OggDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('vorbis');
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('createMuxer returns a working OggMuxer (round-trip validated in ogg-write.test.ts)', () => {
    expect(OggDriver.createMuxer()).toBeInstanceOf(OggMuxer);
  });

  it('reads head + tail via range for a large (>64 kB) source', async () => {
    const headPage = new Uint8Array(page({ bos: true, data: vorbisId(1, 44100) }));
    const tailPage = new Uint8Array(page({ granule: 44100, data: [0] }));
    const fake: ByteSource = {
      size: 70000,
      stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      range: (start) => Promise.resolve(start === 0 ? headPage : tailPage),
    };
    const demuxed = await OggDriver.demux(fake);
    expect(demuxed.tracks[0]?.durationSec).toBeCloseTo(1, 5);
  });
});
