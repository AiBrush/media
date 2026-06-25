/**
 * Validation for the Ogg `Muxer` ({@link OggMuxer}) — a real round-trip oracle that can fail.
 *
 * Plain chunk-structs (NOT WebCodecs `Encoded*Chunk`s) are fed through the pure ingest
 * ({@link OggMuxer.addChunkStruct}, the same path `write()` uses after its browser-only `copyTo`), the
 * muxer serializes the Ogg stream on `finalize`, and the bytes are re-parsed two ways:
 *   - the high-level {@link parseOgg} (codec, sampleRate, channels, granule→duration), and
 *   - an INDEPENDENT page scan (raw `DataView` only — not the writer) that walks every page, **recomputes
 *     the Ogg CRC with a second, bit-by-bit MSB-first implementation** and checks it against the stored
 *     CRC, de-laces the segment table back into packets, and reads granule/header-type per page.
 * We assert codec id headers, page integrity, CRC correctness (+ tamper detection), monotonic granule,
 * BOS/EOS placement, and that the audio packets de-lace **byte-exact** to the inputs. Lacing is exercised
 * across 255-multiple packets, multi-page packets, and many-packets-per-page batching.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { OggDriver, parseOgg } from './ogg-driver.ts';
import { type ChunkStruct, OggMuxer, buildPages } from './ogg-write.ts';

// ── an independent Ogg-CRC (bit-by-bit MSB-first; a different implementation from the writer's table) ──
function oggCrcBitwise(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc ^ ((bytes[i] ?? 0) << 24)) >>> 0;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

interface ScannedPage {
  headerType: number;
  granule: number;
  serial: number;
  seq: number;
  storedCrc: number;
  computedCrc: number;
  lacing: number[];
  body: Uint8Array;
}

/** Walk every Ogg page (raw bytes), recomputing the CRC and capturing header + body. */
function scanPages(bytes: Uint8Array): ScannedPage[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: ScannedPage[] = [];
  let at = 0;
  while (at + 27 <= bytes.length) {
    if (
      String.fromCharCode(
        bytes[at] ?? 0,
        bytes[at + 1] ?? 0,
        bytes[at + 2] ?? 0,
        bytes[at + 3] ?? 0,
      ) !== 'OggS'
    ) {
      throw new Error(`bad capture pattern at ${at}`);
    }
    if (dv.getUint8(at + 4) !== 0) throw new Error('bad stream_structure_version');
    const segCount = dv.getUint8(at + 26);
    const lacing: number[] = [];
    let bodyLen = 0;
    for (let i = 0; i < segCount; i++) {
      const lv = dv.getUint8(at + 27 + i);
      lacing.push(lv);
      bodyLen += lv;
    }
    const bodyStart = at + 27 + segCount;
    const pageEnd = bodyStart + bodyLen;
    const storedCrc = dv.getUint32(at + 22, true);
    // Recompute the CRC over the whole page with the CRC field zeroed.
    const pageBytes = bytes.slice(at, pageEnd);
    new DataView(pageBytes.buffer).setUint32(22, 0, true);
    pages.push({
      headerType: dv.getUint8(at + 5),
      granule: readGranuleLE(dv, at + 6),
      serial: dv.getUint32(at + 14, true),
      seq: dv.getUint32(at + 18, true),
      storedCrc,
      computedCrc: oggCrcBitwise(pageBytes),
      lacing,
      body: bytes.slice(bodyStart, pageEnd),
    });
    at = pageEnd;
  }
  return pages;
}

function readGranuleLE(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (lo === 0xffffffff && hi === 0xffffffff) return -1;
  return hi * 2 ** 32 + lo;
}

/** De-lace the concatenated page bodies back into packets (a lacing value < 255 ends a packet). */
function delacePackets(pages: readonly ScannedPage[]): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let current: number[] = [];
  for (const page of pages) {
    let bodyOff = 0;
    for (const lv of page.lacing) {
      for (let i = 0; i < lv; i++) current.push(page.body[bodyOff++] ?? 0);
      if (lv < 255) {
        packets.push(Uint8Array.from(current));
        current = [];
      }
    }
  }
  return packets;
}

const HT_BOS = 0x02;
const HT_EOS = 0x04;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** A real OpusHead (stereo, 48 kHz) — the description an Opus encoder would supply. */
const OPUS_HEAD = Uint8Array.from([
  0x4f,
  0x70,
  0x75,
  0x73,
  0x48,
  0x65,
  0x61,
  0x64, // 'OpusHead'
  1,
  2,
  0x38,
  0x01,
  0x80,
  0xbb,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
]);

/** An audio chunk of `n` bytes filled with `fill`, at the given PTS, 20 ms long (= 960 samples @ 48 kHz). */
function audio(timestampUs: number, n: number, fill: number): ChunkStruct {
  return { timestampUs, durationUs: 20_000, key: true, data: new Uint8Array(n).fill(fill) };
}

const opusTrack = {
  id: 0,
  mediaType: 'audio' as const,
  codec: 'opus',
  config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, description: OPUS_HEAD },
};

describe('buildPages — lacing (pure)', () => {
  it('one small packet → one page, terminating lacing < 255, body intact', () => {
    const pages = buildPages([{ data: new Uint8Array([1, 2, 3]), granule: 10 }], HT_BOS, HT_EOS);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.lacing).toEqual([3]);
    expect([...(pages[0]?.body ?? [])]).toEqual([1, 2, 3]);
    expect(pages[0]?.granule).toBe(10);
    expect(pages[0]?.headerType).toBe(HT_BOS | HT_EOS); // first==last page
  });

  it('a 255-byte packet ends with a 0 lacing terminator; 510 → [255,255,0]', () => {
    expect(buildPages([{ data: new Uint8Array(255), granule: 1 }], 0, 0)[0]?.lacing).toEqual([
      255, 0,
    ]);
    expect(buildPages([{ data: new Uint8Array(510), granule: 1 }], 0, 0)[0]?.lacing).toEqual([
      255, 255, 0,
    ]);
    expect(buildPages([{ data: new Uint8Array(600), granule: 1 }], 0, 0)[0]?.lacing).toEqual([
      255, 255, 90,
    ]);
  });

  it('many small packets batch onto one page until the 255-segment table fills', () => {
    const packets = Array.from({ length: 300 }, (_, i) => ({
      data: new Uint8Array([i & 0xff]),
      granule: i + 1,
    }));
    const pages = buildPages(packets, 0, 0);
    // 300 one-segment packets → 255 on page 1, 45 on page 2.
    expect(pages).toHaveLength(2);
    expect(pages[0]?.lacing.length).toBe(255);
    expect(pages[1]?.lacing.length).toBe(45);
    // Page 1's granule is the 255th packet's; page 2's is the 300th's.
    expect(pages[0]?.granule).toBe(255);
    expect(pages[1]?.granule).toBe(300);
  });
});

describe('OggMuxer — Opus round-trip (parseOgg + independent page/CRC scan)', () => {
  it('re-parses as opus with the right rate/channels/duration; pages + CRC + de-lace all check out', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack(opusTrack);
    const inputs = [audio(0, 80, 0x11), audio(20_000, 120, 0x22), audio(40_000, 200, 0x33)];
    for (const c of inputs) muxer.addChunkStruct(t, c);
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const info = parseOgg(bytes);
    expect(info.codec).toBe('opus');
    expect(info.sampleRate).toBe(48_000);
    expect(info.channels).toBe(2);
    // 3 packets × 960 samples = 2880 @ 48 kHz = 0.06 s.
    expect(info.durationSec).toBeCloseTo(2880 / 48_000, 5);

    const pages = scanPages(bytes);
    // Every page's CRC matches an independent recomputation.
    for (const p of pages) expect(p.computedCrc).toBe(p.storedCrc);
    // Page sequence numbers are 0,1,2,…; serials all equal.
    expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
    // BOS on the first page, EOS on the last.
    expect((pages[0]?.headerType ?? 0) & HT_BOS).toBe(HT_BOS);
    expect((pages[pages.length - 1]?.headerType ?? 0) & HT_EOS).toBe(HT_EOS);
    // Granule is monotonic non-decreasing; the final granule is the total sample count.
    const granules = pages.map((p) => p.granule).filter((g) => g >= 0);
    expect(granules).toEqual([...granules].sort((a, b) => a - b));
    expect(Math.max(...granules)).toBe(2880);

    // De-lace: header packets are OpusHead + OpusTags; the rest are our audio packets, byte-exact.
    const packets = delacePackets(pages);
    expect([...(packets[0] ?? [])]).toEqual([...OPUS_HEAD]); // BOS packet = OpusHead
    expect(String.fromCharCode(...(packets[1] ?? []).slice(0, 8))).toBe('OpusTags');
    const audioPackets = packets.slice(2);
    expect(audioPackets.map((p) => [...p])).toEqual(inputs.map((c) => [...c.data]));
  });

  it('synthesizes an OpusHead when no description is supplied (parses with the right channels)', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 },
    });
    muxer.addChunkStruct(t, audio(0, 50, 0xaa));
    muxer.addChunkStruct(t, audio(20_000, 50, 0xbb));
    await muxer.finalize();
    const info = parseOgg(await collect(muxer.output));
    expect(info.codec).toBe('opus');
    expect(info.channels).toBe(1);
  });

  it('a large packet spans the 255-segment boundary and de-laces back byte-exact', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack(opusTrack);
    // A ~70 KB packet needs > 255 segments → it must span multiple pages (continued flag).
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    muxer.addChunkStruct(t, { timestampUs: 0, durationUs: 20_000, key: true, data: big });
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const pages = scanPages(bytes);
    for (const p of pages) expect(p.computedCrc).toBe(p.storedCrc); // CRC holds across the split
    // The audio packet is the 3rd packet (after OpusHead, OpusTags) and reassembles exactly.
    const audioPacket = delacePackets(pages)[2];
    expect(audioPacket?.byteLength).toBe(70_000);
    expect([...(audioPacket ?? [])]).toEqual([...big]);
  });

  it('CRC actually covers the data — flipping one body byte breaks the recomputed CRC', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack(opusTrack);
    muxer.addChunkStruct(t, audio(0, 64, 0x5a));
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    // Untampered: all CRCs verify.
    for (const p of scanPages(bytes)) expect(p.computedCrc).toBe(p.storedCrc);
    // Tamper with the last page's final body byte → its recomputed CRC no longer matches the stored one.
    const tampered = bytes.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const pages = scanPages(tampered);
    const mismatches = pages.filter((p) => p.computedCrc !== p.storedCrc).length;
    expect(mismatches).toBe(1);
  });
});

describe('OggMuxer — Vorbis round-trip (Xiph-laced 3 headers)', () => {
  /** Build a Xiph-laced Vorbis description: [2][len(id)][len(comment)] id comment setup. */
  function vorbisDescription(channels: number, sampleRate: number): Uint8Array {
    const id = Uint8Array.from([
      0x01,
      0x76,
      0x6f,
      0x72,
      0x62,
      0x69,
      0x73, // 'vorbis'
      0,
      0,
      0,
      0, // vorbis_version
      channels & 0xff,
      sampleRate & 0xff,
      (sampleRate >> 8) & 0xff,
      (sampleRate >> 16) & 0xff,
      (sampleRate >> 24) & 0xff,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // bitrates
      0xb8,
      0x01, // blocksizes + framing
    ]);
    const comment = Uint8Array.from([
      0x03,
      0x76,
      0x6f,
      0x72,
      0x62,
      0x69,
      0x73,
      0,
      0,
      0,
      0, // vendor length 0
      0,
      0,
      0,
      0, // comment count 0
      0x01, // framing bit
    ]);
    const setup = Uint8Array.from([0x05, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0xaa, 0xbb, 0xcc]); // stub setup
    const lace = (len: number): number[] => {
      const out: number[] = [];
      let r = len;
      while (r >= 255) {
        out.push(255);
        r -= 255;
      }
      out.push(r);
      return out;
    };
    return Uint8Array.from([
      2,
      ...lace(id.length),
      ...lace(comment.length),
      ...id,
      ...comment,
      ...setup,
    ]);
  }

  it('lays the id header on the BOS page and comment+setup next; parseOgg reads vorbis', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'vorbis',
      config: {
        codec: 'vorbis',
        sampleRate: 44_100,
        numberOfChannels: 2,
        description: vorbisDescription(2, 44_100),
      },
    });
    // Vorbis granule clock is the sample rate; 2 packets × 20 ms ≈ 882 samples each.
    muxer.addChunkStruct(t, {
      timestampUs: 0,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array(40).fill(1),
    });
    muxer.addChunkStruct(t, {
      timestampUs: 20_000,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array(40).fill(2),
    });
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const info = parseOgg(bytes);
    expect(info.codec).toBe('vorbis');
    expect(info.sampleRate).toBe(44_100);
    expect(info.channels).toBe(2);
    expect(info.durationSec).toBeGreaterThan(0);

    const pages = scanPages(bytes);
    for (const p of pages) expect(p.computedCrc).toBe(p.storedCrc);
    // BOS packet starts with 0x01 'vorbis'; the 2nd & 3rd packets are comment (0x03) + setup (0x05).
    const packets = delacePackets(pages);
    expect(packets[0]?.[0]).toBe(0x01);
    expect(packets[1]?.[0]).toBe(0x03);
    expect(packets[2]?.[0]).toBe(0x05);
  });

  it('rejects Vorbis without a setup-header description (typed CapabilityError)', () => {
    const muxer = new OggMuxer();
    expect(() =>
      muxer.addTrack({
        id: 0,
        mediaType: 'audio',
        codec: 'vorbis',
        config: { codec: 'vorbis', sampleRate: 44_100, numberOfChannels: 2 },
      }),
    ).not.toThrow(); // addTrack succeeds…
    muxer.addChunkStruct(0, {
      timestampUs: 0,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array(4),
    });
    // …the miss surfaces at finalize when the headers are needed (errored on the output too).
    return expect(muxer.finalize()).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('OggMuxer — typed misuse + capability misses', () => {
  it('write to an unknown track id throws mux-error', () => {
    const muxer = new OggMuxer();
    expect(() => muxer.addChunkStruct(99, audio(0, 4, 1))).toThrowError(/unknown track 99/);
  });

  it('addTrack / write after finalize throws mux-error', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack(opusTrack);
    muxer.addChunkStruct(t, audio(0, 4, 1));
    await muxer.finalize();
    expect(() => muxer.addTrack(opusTrack)).toThrowError(/already finalized/);
    expect(() => muxer.addChunkStruct(t, audio(20_000, 4, 1))).toThrowError(/already finalized/);
  });

  it('a second finalize throws mux-error', async () => {
    const muxer = new OggMuxer();
    const t = muxer.addTrack(opusTrack);
    muxer.addChunkStruct(t, audio(0, 4, 1));
    await muxer.finalize();
    await expect(muxer.finalize()).rejects.toThrowError(/already finalized/);
  });

  it('finalize with zero tracks rejects and errors the output stream', async () => {
    const muxer = new OggMuxer();
    await expect(muxer.finalize()).rejects.toThrowError(/no tracks/);
    await expect(collect(muxer.output)).rejects.toThrowError(/no tracks/);
  });

  it('finalize with a track that received no packets rejects', async () => {
    const muxer = new OggMuxer();
    muxer.addTrack(opusTrack);
    await expect(muxer.finalize()).rejects.toThrowError(/received no packets/);
  });

  it('a second track is a typed capability miss (single logical stream)', () => {
    const muxer = new OggMuxer();
    muxer.addTrack(opusTrack);
    expect(() => muxer.addTrack(opusTrack)).toThrow(CapabilityError);
  });

  it('an unsupported codec is a typed capability miss at addTrack', () => {
    const muxer = new OggMuxer();
    expect(() =>
      muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'aac', config: { codec: 'mp4a.40.2' } }),
    ).toThrow(CapabilityError);
  });

  it('a video track is a typed capability miss (Ogg muxer is audio-only here)', () => {
    const muxer = new OggMuxer();
    expect(() =>
      muxer.addTrack({ id: 0, mediaType: 'video', codec: 'theora', config: { codec: 'theora' } }),
    ).toThrow(CapabilityError);
  });
});

describe('OggDriver.createMuxer — wired to OggMuxer', () => {
  it('returns an OggMuxer whose output round-trips through parseOgg', async () => {
    const muxer = OggDriver.createMuxer();
    expect(muxer).toBeInstanceOf(OggMuxer);
    if (muxer instanceof OggMuxer) {
      const t = muxer.addTrack(opusTrack);
      muxer.addChunkStruct(t, audio(0, 96, 0x7e));
      muxer.addChunkStruct(t, audio(20_000, 96, 0x7f));
    }
    await muxer.finalize();
    const info = parseOgg(await collect(muxer.output));
    expect(info.codec).toBe('opus');
    expect(info.durationSec).toBeCloseTo(1920 / 48_000, 5);
  });

  it('errors raised by the muxer are typed (never thrown strings)', () => {
    const muxer = new OggMuxer();
    try {
      muxer.addChunkStruct(0, audio(0, 1, 1));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
    }
  });
});

describe('OggMuxer — Vorbis description validation + edge inputs', () => {
  /** Run a Vorbis track with the given `description` to finalize; resolve with the thrown error (if any). */
  async function finalizeVorbis(description: Uint8Array | ArrayBuffer): Promise<unknown> {
    const muxer = new OggMuxer();
    const t = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'vorbis',
      config: { codec: 'vorbis', sampleRate: 44_100, numberOfChannels: 2, description },
    });
    muxer.addChunkStruct(t, {
      timestampUs: 0,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array(8),
    });
    return muxer.finalize().then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  it('rejects a too-short / wrong-count-byte Xiph description (CapabilityError)', async () => {
    expect(await finalizeVorbis(new Uint8Array([2, 1]))).toBeInstanceOf(CapabilityError); // < 3 bytes
    expect(await finalizeVorbis(new Uint8Array([0, 1, 1, 0x01, 0x76]))).toBeInstanceOf(
      CapabilityError,
    ); // count!=2
  });

  it('rejects a Xiph description whose declared lengths overrun (setup empty) — CapabilityError', async () => {
    // count=2, len0=4, len1=4, but only 4 body bytes follow ⇒ comment/setup do not fit.
    const desc = new Uint8Array([2, 4, 4, 0x01, 0x76, 0x6f, 0x72]);
    expect(await finalizeVorbis(desc)).toBeInstanceOf(CapabilityError);
  });

  it("rejects a Xiph description whose id packet isn't 0x01 'vorbis' — CapabilityError", async () => {
    // count=2, len0=7, len1=1, id = 7 wrong bytes, comment = 1, setup = 1.
    const desc = new Uint8Array([2, 7, 1, 0xff, 1, 2, 3, 4, 5, 6, 0x03, 0x05]);
    expect(await finalizeVorbis(desc)).toBeInstanceOf(CapabilityError);
  });

  it('accepts a Vorbis description supplied as a raw ArrayBuffer (toBytes non-view path)', async () => {
    // A valid minimal 3-header description, passed as an ArrayBuffer (not a Uint8Array view).
    const id = [
      0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0xb8, 0x01,
    ];
    const comment = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];
    const setup = [0x05, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0xaa];
    const desc = Uint8Array.from([2, id.length, comment.length, ...id, ...comment, ...setup]);
    const err = await finalizeVorbis(desc.slice().buffer);
    expect(err).toBeUndefined(); // finalized cleanly
  });
});
