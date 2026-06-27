import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import {
  Mp3Driver,
  Mp3Module,
  enumerateMp3Packets,
  isMpegLayer3Frame,
  parseMp3,
} from './mp3-driver.ts';

/** Drain a muxer's output stream into one buffer (mirrors the FLAC mux test's collectBytes). */
async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

// MPEG1 Layer III header. version 3, layer III, bitrateIdx 9 (128k), srIdx 0 (44100).
function header(
  opts: { mono?: boolean; bitrateIdx?: number; version?: number; srIdx?: number } = {},
): number[] {
  const version = opts.version ?? 3;
  const b1 = 0xe0 | (version << 3) | (0x1 << 1) | 1; // sync + version + Layer III + protection
  const b2 = ((opts.bitrateIdx ?? 9) << 4) | ((opts.srIdx ?? 0) << 2);
  const b3 = (opts.mono ? 0x3 : 0x0) << 6;
  return [0xff, b1 & 0xff, b2 & 0xff, b3 & 0xff];
}
function frameLen(version = 3, bitrateKbps = 128, sampleRate = 44100): number {
  const coeff = version === 3 ? 144 : 72;
  return Math.floor((coeff * bitrateKbps * 1000) / sampleRate);
}
function pad(head: number[], to: number): number[] {
  return [...head, ...new Array<number>(Math.max(0, to - head.length)).fill(0)];
}

describe('Mp3Driver.supports', () => {
  it('recognizes frame-sync + ID3, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sound_5.mp3')).subarray(0, 16);
    expect(Mp3Driver.supports({ direction: 'demux', head })).toBe(true);
    expect(
      Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xfb, 0, 0]) }),
    ).toBe(true);
    expect(
      Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0x49, 0x44, 0x33]) }),
    ).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', mime: 'audio/mpeg' })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', extension: 'mp3' })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0, 1]) })).toBe(false);
    expect(Mp3Driver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe MP3 on the real corpus', () => {
  it('sound_5.mp3 — sane params (invariants)', async () => {
    const info = await createMedia()
      .use(Mp3Module)
      .probe(await fixtureSource('sound_5.mp3'));
    expect(info.container).toBe('mp3');
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]?.codec).toBe('mp3');
    expect([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]).toContain(
      info.tracks[0]?.sampleRate,
    );
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it('sound_5.mp3 probe matches its committed golden exactly', async () => {
    const info = await createMedia()
      .use(Mp3Module)
      .probe(await fixtureSource('sound_5.mp3'));
    expect(info).toEqual(await loadGoldenMetadata('sound_5.mp3'));
  });
});

describe('parseMp3 — frame variants + duration', () => {
  const fl = frameLen();

  it('reads exact duration from the full frame clock when the complete stream is available', () => {
    const bytes = new Uint8Array([...pad(header(), fl), ...pad(header(), fl)]);
    const info = parseMp3(bytes, bytes.byteLength);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.durationSec).toBeCloseTo((2 * 1152) / 44100, 5);
  });

  it('falls back to CBR byte-rate estimation for a head-only probe with known total size', () => {
    const bytes = new Uint8Array([...pad(header(), fl), ...pad(header(), fl)]);
    const info = parseMp3(bytes.subarray(0, fl), bytes.byteLength);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.durationSec).toBeCloseTo((bytes.byteLength * 8) / (128 * 1000), 5);
  });

  it('reads an exact Xing VBR frame count', () => {
    const f = pad(header(), fl);
    const tagAt = 4 + 32; // MPEG1 stereo side-info
    f.splice(tagAt, 12, ...[...'Xing'].map((c) => c.charCodeAt(0)), 0, 0, 0, 1, 0, 0, 0, 100);
    const info = parseMp3(new Uint8Array([...f, ...pad(header(), fl)]));
    expect(info.durationSec).toBeCloseTo((100 * 1152) / 44100, 5);
  });

  it('skips an ID3v2 tag, and reads a mono MPEG2 frame', () => {
    const id3 = [...'ID3'].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 0, 0, 4]); // 4-byte tag body
    const fl2 = frameLen(2, 8, 22050);
    const head = header({ version: 2, bitrateIdx: 1, srIdx: 0, mono: true }); // MPEG2 8k 22050 mono
    const bytes = new Uint8Array([...id3, 0, 0, 0, 0, ...pad(head, fl2), ...pad(head, fl2)]);
    const info = parseMp3(bytes, bytes.byteLength);
    expect(info.sampleRate).toBe(22050);
    expect(info.channels).toBe(1);
  });

  it('rejects a buffer with no valid frame header', () => {
    expect(() => parseMp3(new Uint8Array([0xff, 0x00, 0x00, 0x00, 1, 2, 3, 4]))).toThrowError(
      InputError,
    );
  });

  it('skips invalid frame headers (reserved version/layer, bad bitrate/samplerate) before locking', () => {
    const invalids = [
      0xff,
      0xeb,
      0x90,
      0x00, // version reserved (1)
      0xff,
      0xf9,
      0x90,
      0x00, // layer reserved (0)
      0xff,
      0xfb,
      0xf0,
      0x00, // bitrateIdx 15
      0xff,
      0xfb,
      0x00,
      0x00, // bitrateIdx 0
      0xff,
      0xfb,
      0x9c,
      0x00, // srIdx 3
    ];
    const fl = frameLen();
    const bytes = new Uint8Array([...invalids, ...pad(header(), fl), ...pad(header(), fl)]);
    expect(parseMp3(bytes, bytes.byteLength).sampleRate).toBe(44100);
  });
});

describe('Mp3Driver — demux seam + muxer', () => {
  it('demuxes a non-seekable stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await Mp3Driver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('mp3');
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('createMuxer returns a real MP3 elementary-stream muxer (ADR pending)', async () => {
    // Two valid MPEG-1 L3 128k/44100 frames; the muxer concatenates them verbatim into a `.mp3`.
    const frame = (): Uint8Array => Uint8Array.from(pad(header(), frameLen()));
    const muxer = Mp3Driver.createMuxer();
    const id = muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    muxer.addChunkStruct(id, { timestampUs: 0, durationUs: 26_122, key: true, data: frame() });
    muxer.addChunkStruct(id, { timestampUs: 26_122, durationUs: 26_122, key: true, data: frame() });
    await muxer.finalize();

    const out = await collectBytes(muxer.output);
    // The authored stream has one Xing metadata frame plus the two original audio frames, and the parser
    // skips the metadata frame while preserving the exact audio packet count and duration.
    expect(out.byteLength).toBeGreaterThan(frame().byteLength * 2);
    expect(isMpegLayer3Frame(out)).toBe(true);
    expect(enumerateMp3Packets(out)).toHaveLength(2);
    expect(parseMp3(out).durationSec).toBeCloseTo((2 * 1152) / 44100, 5);
  });

  it('muxes MPEG-1 mono and MPEG-2 stereo frames with the right Xing side-info layout', async () => {
    const cases = [
      {
        head: header({ mono: true }),
        length: frameLen(),
        sampleRate: 44100,
      },
      {
        head: header({ version: 2, bitrateIdx: 8, srIdx: 0 }),
        length: frameLen(2, 64, 22050),
        sampleRate: 22050,
      },
    ];

    for (const item of cases) {
      const frame = Uint8Array.from(pad(item.head, item.length));
      const muxer = Mp3Driver.createMuxer();
      const id = muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
      muxer.addChunkStruct(id, { timestampUs: 0, durationUs: 0, key: true, data: frame });
      await muxer.finalize();

      const out = await collectBytes(muxer.output);
      expect(isMpegLayer3Frame(out)).toBe(true);
      expect(parseMp3(out).sampleRate).toBe(item.sampleRate);
      expect(enumerateMp3Packets(out)).toHaveLength(1);
    }
  });

  it('uses a larger legal metadata frame when the first audio frame cannot fit Xing', async () => {
    const head = header({ version: 2, bitrateIdx: 1, srIdx: 0, mono: true });
    const frame = Uint8Array.from(pad(head, frameLen(2, 8, 22050)));
    const muxer = Mp3Driver.createMuxer();
    const id = muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    muxer.addChunkStruct(id, { timestampUs: 0, durationUs: 26_122, key: true, data: frame });
    await muxer.finalize();

    const out = await collectBytes(muxer.output);
    expect(isMpegLayer3Frame(out)).toBe(true);
    expect(out.byteLength).toBeGreaterThan(frame.byteLength * 2);
    expect(enumerateMp3Packets(out).map((packet) => packet.size)).toEqual([frame.byteLength]);
    expect(parseMp3(out).sampleRate).toBe(22050);
  });

  it('the MP3 muxer rejects misuse with typed errors (non-frame, wrong track/codec, double-finalize)', async () => {
    const frame = Uint8Array.from(pad(header(), frameLen()));

    expect(() => Mp3Driver.createMuxer({ fragmented: true })).toThrowError(CapabilityError);

    // A non-frame chunk must be refused, not silently concatenated (it would desync every parser).
    const m1 = Mp3Driver.createMuxer();
    const id1 = m1.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    expect(() =>
      m1.addChunkStruct(id1 + 1, {
        timestampUs: 0,
        durationUs: 0,
        key: true,
        data: frame,
      }),
    ).toThrowError(/unknown track/);
    expect(() =>
      m1.addChunkStruct(id1, {
        timestampUs: 0,
        durationUs: 0,
        key: true,
        data: Uint8Array.of(0x00, 0x01, 0x02, 0x03),
      }),
    ).toThrowError(MediaError);

    // A non-audio / non-mp3 track is a capability miss.
    const m2 = Mp3Driver.createMuxer();
    expect(() => m2.addTrack({ id: 0, mediaType: 'audio', codec: 'aac' })).toThrowError(/MP3/);
    const m2b = Mp3Driver.createMuxer();
    m2b.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    expect(() => m2b.addTrack({ id: 1, mediaType: 'audio', codec: 'mp3' })).toThrowError(
      /single audio stream/,
    );

    await expect(Mp3Driver.createMuxer().finalize()).rejects.toThrowError(/no tracks/);
    const empty = Mp3Driver.createMuxer();
    empty.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    await expect(empty.finalize()).rejects.toThrowError(/received no packets/);

    // Double finalize and finalize-with-no-packets are typed mux errors.
    const m3 = Mp3Driver.createMuxer();
    const id3 = m3.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
    m3.addChunkStruct(id3, { timestampUs: 0, durationUs: 0, key: true, data: frame });
    await m3.finalize();
    await expect(m3.finalize()).rejects.toThrowError(MediaError);
  });

  it('rejects invalid MP3 frame variants at the mux seam', () => {
    const valid = Uint8Array.from(pad(header(), frameLen()));
    const invalids = [
      new Uint8Array(0),
      Uint8Array.of(0xff, 0xfb, 0x90),
      Uint8Array.of(0x00, 0xfb, 0x90, 0x00),
      Uint8Array.of(0xff, 0x1b, 0x90, 0x00),
      Uint8Array.of(0xff, 0xeb, 0x90, 0x00),
      Uint8Array.of(0xff, 0xf9, 0x90, 0x00),
      Uint8Array.of(0xff, 0xfb, 0x00, 0x00),
      Uint8Array.of(0xff, 0xfb, 0xf0, 0x00),
      Uint8Array.of(0xff, 0xfb, 0x9c, 0x00),
      valid.subarray(0, valid.byteLength - 1),
      (() => {
        const info = Uint8Array.from(valid);
        const tagAt = 4 + 32;
        info.set(new TextEncoder().encode('Info'), tagAt);
        return info;
      })(),
    ];

    for (const data of invalids) {
      const muxer = Mp3Driver.createMuxer();
      const id = muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'mp3' });
      expect(() =>
        muxer.addChunkStruct(id, { timestampUs: 0, durationUs: 0, key: true, data }),
      ).toThrowError(/valid MPEG Layer III/);
    }
  });
});

/**
 * MP3 framing validation. The independent oracle is ffprobe (golden pattern: run ONCE in the shell, bake
 * the numbers, never shell out at run time). `enumerateMp3Packets` must reproduce, frame-for-frame,
 * ffprobe's packet COUNT, each packet SIZE (the FULL MPEG frame incl. its 4-byte header — what
 * `packet=size` reports for MP3), and each PTS in µs (±1 µs for rounding). It can fail: mis-framing (wrong
 * skip of the Xing/Info frame, wrong VBR stride, off-by-one length) diverges sizes/PTS immediately.
 *
 * Oracle command (run once per fixture; col 1 pts_time → µs, col 2 size — ffprobe already omits the Xing
 * frame from its packet timeline, so its packet[0] is our emitted frame[0]):
 *   ffprobe -v error -show_packets -select_streams a:0 -of csv=p=0 \
 *     -show_entries packet=pts_time,size <fixture>
 *
 * Coverage: BOTH a CBR-ish fixture (sound_5.mp3 — MPEG-2 L3, 22.05 kHz mono, 576 spf) and a VBR fixture
 * (bear-vbr-toc.mp3 — MPEG-1 L3, 44.1 kHz stereo, 1152 spf, per-frame bitrate varies).
 */
interface OracleFrame {
  ptsUs: number;
  size: number;
}
interface Oracle {
  fixture: string;
  count: number;
  head: readonly OracleFrame[];
}

const SOUND5: Oracle = {
  fixture: 'sound_5.mp3',
  count: 194,
  head: [
    { ptsUs: 0, size: 52 },
    { ptsUs: 26122, size: 313 },
    { ptsUs: 52245, size: 365 },
    { ptsUs: 78367, size: 104 },
    { ptsUs: 104490, size: 104 },
    { ptsUs: 130612, size: 104 },
    { ptsUs: 156735, size: 104 },
    { ptsUs: 182857, size: 104 },
  ],
};

const BEAR: Oracle = {
  fixture: 'bear-vbr-toc.mp3',
  count: 384,
  head: [
    { ptsUs: 0, size: 626 },
    { ptsUs: 26122, size: 365 },
    { ptsUs: 52245, size: 261 },
    { ptsUs: 78367, size: 208 },
    { ptsUs: 104490, size: 313 },
    { ptsUs: 130612, size: 208 },
    { ptsUs: 156735, size: 208 },
    { ptsUs: 182857, size: 208 },
  ],
};

describe.each([SOUND5, BEAR])('enumerateMp3Packets — framing vs ffprobe ($fixture)', (oracle) => {
  it('reproduces ffprobe packet count, sizes, and PTS (±1 µs)', async () => {
    const packets = enumerateMp3Packets(await loadFixture(oracle.fixture));

    // COUNT must match exactly — the Xing/Info header frame is skipped, just as ffprobe omits it.
    expect(packets.length).toBe(oracle.count);

    oracle.head.forEach((expected, i) => {
      const frame = packets[i];
      expect(frame, `packet ${i} present`).toBeDefined();
      if (!frame) return;
      // SIZE is the full MPEG frame length (4-byte header included) — the unit ffprobe reports.
      expect(frame.size, `packet ${i} size`).toBe(expected.size);
      // PTS from cumulative samples ÷ sampleRate; ±1 µs for the integer rounding both sides do.
      expect(Math.abs(frame.ptsUs - expected.ptsUs), `packet ${i} pts`).toBeLessThanOrEqual(1);
    });
  });

  it('PTS is strictly monotonic and every frame stays inside the file', async () => {
    const bytes = await loadFixture(oracle.fixture);
    const packets = enumerateMp3Packets(bytes);
    let prev = -1;
    for (const p of packets) {
      expect(p.ptsUs).toBeGreaterThan(prev);
      prev = p.ptsUs;
      expect(p.offset).toBeGreaterThanOrEqual(0);
      expect(p.offset + p.size).toBeLessThanOrEqual(bytes.byteLength);
      expect(p.durationUs).toBeGreaterThan(0);
    }
  });
});

describe('enumerateMp3Packets — robustness', () => {
  it('rejects truncated/garbage input with a typed InputError', () => {
    expect(() => enumerateMp3Packets(new Uint8Array(16))).toThrowError(InputError);
    expect(() => enumerateMp3Packets(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrowError(
      InputError,
    );
  });
});
