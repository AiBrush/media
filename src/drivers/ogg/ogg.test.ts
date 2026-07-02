import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import {
  OggDriver,
  OggModule,
  oggAudioPackets,
  oggPacketInfoFromBytes,
  parseOgg,
} from './ogg-driver.ts';
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
    const description = demuxed.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array)[0]).toBe(2); // Xiph-laced Vorbis id/comment/setup headers
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('carries the source OpusHead through the demux TrackInfo description', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
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
    const description = demuxed.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    const opusHead = description as Uint8Array;
    expect(String.fromCharCode(...opusHead.subarray(0, 8))).toBe('OpusHead');
    expect(
      new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true),
    ).toBe(312);
    await demuxed.close();
  });

  it('exposes Opus packet-info offsets without constructing WebCodecs chunks', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
    const table = oggPacketInfoFromBytes(bytes);
    const packets = oggAudioPackets(bytes);
    expect(table.tracks[0]?.codec).toBe('opus');
    expect(table.tracks[0]?.config?.description).toBeInstanceOf(Uint8Array);
    expect(table.packets.length).toBe(packets.length);
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const row = table.packets[i];
      if (packet === undefined || row === undefined)
        throw new Error('packet table length mismatch');
      expect(row.trackIndex).toBe(0);
      expect(row.offset).toBe(packet.offset);
      expect(row.size).toBe(packet.size);
      expect(row.ptsUs).toBe(packet.ptsUs);
      expect(row.dtsUs).toBe(packet.ptsUs);
      expect(row.durationUs).toBe(packet.durationUs);
      expect(row.keyframe).toBe(true);
    }
  });

  it('demux exposes packet tables from one full-source read', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
    const expected = oggPacketInfoFromBytes(bytes);
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable Ogg demux should use one full range read');
      },
    };

    const demuxed = await OggDriver.demux(source);
    const packetInfoRows = (
      demuxed as typeof demuxed & { packetInfoTable?: () => typeof expected.packets }
    ).packetInfoTable?.();
    const packetRows = demuxed.packetTable?.();

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(demuxed.tracks).toEqual(expected.tracks);
    expect(packetInfoRows).toEqual(expected.packets);
    expect(packetRows).toEqual(
      expected.packets.map((packet) => ({
        trackId: 0,
        sizeBytes: packet.size,
        ptsUs: packet.ptsUs,
        dtsUs: packet.dtsUs,
        durationUs: packet.durationUs,
        keyframe: packet.keyframe,
      })),
    );
    await demuxed.close();
  });

  it('createMuxer returns a working OggMuxer (round-trip validated in ogg-write.test.ts)', () => {
    expect(OggDriver.createMuxer()).toBeInstanceOf(OggMuxer);
  });

  it('probe reads head + tail via range for a large (>64 kB) source', async () => {
    const headPage = new Uint8Array(page({ bos: true, data: vorbisId(1, 44100) }));
    const tailPage = new Uint8Array(page({ granule: 44100, data: [0] }));
    const sourceSize = 300000;
    const ranges: Array<readonly [number, number]> = [];
    const fake: ByteSource = {
      size: sourceSize,
      stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(start === 0 ? headPage : tailPage);
      },
    };
    const tracks = await OggDriver.probe?.(fake);
    expect(tracks?.[0]?.durationSec).toBeCloseTo(1, 5);
    expect(ranges).toEqual([
      [0, 65536],
      [sourceSize - 65536, sourceSize],
    ]);
  });

  it('probes a small known-size source with one bounded range read', async () => {
    const headPage = new Uint8Array(page({ bos: true, data: opusId(2) }));
    const tailPage = new Uint8Array(page({ granule: 48000, data: [0] }));
    const bytes = new Uint8Array(70000);
    bytes.set(headPage, 0);
    bytes.set(tailPage, bytes.byteLength - tailPage.byteLength);
    const ranges: Array<{ start: number; end: number }> = [];
    const fake: ByteSource = {
      size: bytes.byteLength,
      stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      range: (start, end) => {
        ranges.push({ start, end });
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const tracks = await OggDriver.probe?.(fake);
    expect(tracks?.[0]?.codec).toBe('opus');
    expect(tracks?.[0]?.durationSec).toBeCloseTo(1, 5);
    expect(ranges).toEqual([{ start: 0, end: bytes.byteLength }]);
  });
});

/**
 * STRICT can-fail oracle for the pure {@link oggAudioPackets} de-lacer/framer, cross-checked against
 * ffprobe (the independent oracle). The expected constants were recorded ONCE with:
 *
 *   ffprobe -v error -show_packets -select_streams a:0 -of csv=p=0 \
 *     -show_entries packet=pts_time,size,pos fixtures/media/<file>
 *
 * and BAKED below (tests never shell out at run time). ffprobe's `size` is the de-laced **packet payload**
 * (the unit our enumeration reports). The test fails on any mis-framing: a wrong segment-table walk shifts
 * byte sizes, a wrong header-skip shifts the packet count, a wrong granule/TOC shifts PTS.
 *
 * - **Opus** is sample-exact (TOC-decoded): every (count, size, PTS µs within ±1) is asserted.
 * - **Vorbis** per-packet PTS is an *even-split* approximation (documented in oggAudioPackets), so we
 *   assert count + sizes exactly and only the **sum of durations ≈ true duration**, not per-packet PTS.
 */
describe('oggAudioPackets — pure de-lacing + framing vs ffprobe', () => {
  // ffprobe a:0 packets for sfx-opus.ogg — pts (48 kHz samples), pts_time (s), size (payload bytes):
  //   -312/-0.006500/450, 648/0.013500/268, 1608/0.033500/285, 2568/0.053500/296, 3528/0.073500/287,
  //   4488/0.093500/308, 5448/0.113500/289, 6408/0.133500/286, 7368/0.153500/296, 8328/0.173500/294
  const OPUS_EXPECTED: ReadonlyArray<{ ptsUs: number; size: number }> = [
    { ptsUs: -6500, size: 450 },
    { ptsUs: 13500, size: 268 },
    { ptsUs: 33500, size: 285 },
    { ptsUs: 53500, size: 296 },
    { ptsUs: 73500, size: 287 },
    { ptsUs: 93500, size: 308 },
    { ptsUs: 113500, size: 289 },
    { ptsUs: 133500, size: 286 },
    { ptsUs: 153500, size: 296 },
    { ptsUs: 173500, size: 294 },
  ];

  it('sfx-opus.ogg — exact count, sizes, and per-packet PTS (TOC-decoded)', async () => {
    const pkts = oggAudioPackets(await loadFixture('sfx-opus.ogg'));
    expect(pkts.length).toBe(OPUS_EXPECTED.length); // 10 audio packets; OpusHead/OpusTags skipped
    for (let i = 0; i < OPUS_EXPECTED.length; i++) {
      const exp = OPUS_EXPECTED[i];
      const got = pkts[i];
      if (exp === undefined || got === undefined) throw new Error('length mismatch');
      expect(got.size).toBe(exp.size); // de-laced payload bytes must match ffprobe exactly
      expect(Math.abs(got.ptsUs - exp.ptsUs)).toBeLessThanOrEqual(1); // PTS µs within rounding
    }
    // Every Opus frame here is 20 ms (960 @ 48 kHz); sum of durations == 10 × 20 ms = 200 ms = duration.
    const totalUs = pkts.reduce((s, p) => s + p.durationUs, 0);
    expect(totalUs).toBe(200_000);
  });

  // ffprobe a:0 audio packets for sound_5.oga (pts_time, payload size), its spurious Metadata-Update
  // duplicate of the first line dropped:
  //   0.000000/98, 0.011610/65, 0.023220/94, 0.034830/98, 0.046440/66, 0.063855/64, 0.087075/61, 0.110295/55
  //
  // CONTAINER vs DECODER accounting (the documented, *correct* offset): a demuxer must emit EVERY coded
  // audio packet, including Vorbis's first one — which by spec produces no PCM output (it only primes the
  // IMDCT overlap; output begins with the *second* packet). ffprobe lists DECODER-output packets, so it
  // omits that priming packet. Hence our container-true list == [primingPacket, ...ffprobeList]:
  //   our packets[0]  = the 100-byte priming packet (ffprobe drops it)
  //   our packets[1:] = ffprobe's list exactly (sizes 98, 65, 94, …)
  // This is why our COUNT is ffprobe's + 1 and our packets[1].size == ffprobe's first size (98).
  const VORBIS_AFTER_PRIMING_SIZES: readonly number[] = [98, 65, 94, 98, 66, 64, 61, 55];
  const VORBIS_PRIMING_SIZE = 100; // packets[0]: the no-output priming packet (container-real)
  const VORBIS_PACKET_COUNT = 231; // 234 total packets − 3 Vorbis header packets (id/comment/setup)
  const VORBIS_DURATION_SEC = 5.000227; // ffprobe stream duration (22050 Hz)

  it('sound_5.oga — exact count + sizes; per-packet PTS is an even-split approximation', async () => {
    const pkts = oggAudioPackets(await loadFixture('sound_5.oga'));
    expect(pkts.length).toBe(VORBIS_PACKET_COUNT); // 3 Vorbis header packets skipped, priming kept
    expect(pkts[0]?.size).toBe(VORBIS_PRIMING_SIZE); // container-real priming packet (ffprobe omits)
    for (let i = 0; i < VORBIS_AFTER_PRIMING_SIZES.length; i++) {
      // packets[1:] must reproduce ffprobe's de-laced payload sizes byte-exactly.
      expect(pkts[i + 1]?.size).toBe(VORBIS_AFTER_PRIMING_SIZES[i]);
    }
    expect(pkts[0]?.ptsUs).toBe(0); // first coded packet starts at the stream origin
    // Sum of (approximate) durations equals the true total to ±2 ms (the granule/rate end, not per-packet).
    const totalSec = pkts.reduce((s, p) => s + p.durationUs, 0) / 1_000_000;
    expect(totalSec).toBeCloseTo(VORBIS_DURATION_SEC, 2);
    // Monotonic, non-decreasing PTS (a sane decode timeline even under the approximation).
    for (let i = 1; i < pkts.length; i++) {
      expect(pkts[i]?.ptsUs ?? 0).toBeGreaterThanOrEqual(pkts[i - 1]?.ptsUs ?? 0);
    }
  });

  it('excludes the codec setup/header packets from the audio stream (both fixtures)', async () => {
    // The first emitted Opus packet (450 B) is real audio, never the 19-B OpusHead or the OpusTags page.
    const opus = oggAudioPackets(await loadFixture('sfx-opus.ogg'));
    expect(opus[0]?.size).toBe(450);
    // The first emitted Vorbis packet (100 B priming packet) is audio, never the id (30 B) / comment /
    // setup headers — those three header packets are skipped; audio (incl. the priming packet) is kept.
    const vorbis = oggAudioPackets(await loadFixture('sound_5.oga'));
    expect(vorbis[0]?.size).toBe(100);
  });

  it('rejects truncated / garbage input with a typed InputError', () => {
    expect(() => oggAudioPackets(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrowError(
      InputError,
    );
    expect(() => oggAudioPackets(new Uint8Array(0))).toThrowError(InputError);
  });
});
