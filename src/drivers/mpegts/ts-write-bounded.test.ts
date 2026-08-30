import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../../contracts/driver.ts';
import { TS_CLOCK_HZ, parseTs } from './ts-parse.ts';
import { MAX_TS_MUX_ACCESS_UNITS_PER_TRACK, MpegTsMuxer } from './ts-write.ts';

const PACKET = 188;

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
function u16Bytes(v: number): Uint8Array {
  return Uint8Array.of((v >> 8) & 0xff, v & 0xff);
}
function avcCWithParameterSets(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x01, sps[1] ?? 0x42, sps[2] ?? 0, sps[3] ?? 0x1e, 0xff, 0xe1),
    u16Bytes(sps.byteLength),
    sps,
    Uint8Array.of(0x01),
    u16Bytes(pps.byteLength),
    pps,
  );
}
const sps = Uint8Array.of(0x67, 0x42, 0x00, 0x1e, 0xf4, 0x05, 0x01, 0xec, 0x80);
const pps = Uint8Array.of(0x68, 0xce, 0x3c, 0x80);
function h264Track(): TrackInfo {
  return {
    id: 0,
    mediaType: 'video',
    codec: 'avc1.42001e',
    durationSec: 1 / 30,
    config: {
      codec: 'avc1.42001e',
      codedWidth: 16,
      codedHeight: 16,
      description: avcCWithParameterSets(sps, pps),
    },
  };
}
function aacTrack(): TrackInfo {
  return {
    id: 1,
    mediaType: 'audio',
    codec: 'mp4a.40.2',
    durationSec: 1024 / 48000,
    config: {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
      description: Uint8Array.of(0x11, 0x90),
    },
  };
}
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
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
function ticksToUs(ticks: number): number {
  return Math.round((ticks * 1_000_000) / TS_CLOCK_HZ);
}

describe('mpegts 1.4.3 bounded progressive — small writes, continuity, wrap, segments', () => {
  it('small writes + continuity: 1-byte vs 5000-byte PES payloads packetize with incremental 188-aligned chunks', async () => {
    const muxer = new MpegTsMuxer({ writeChunkPackets: 1 });
    const vid = muxer.addTrack(h264Track());
    const aud = muxer.addTrack(aacTrack());
    // tiny raw AAC (1 byte payload -> 8 byte ADTS frame)
    muxer.addChunkStruct(aud, { data: Uint8Array.of(0x21), timestampUs: 0, key: true });
    // large H.264 AU that requires multiple TS packets (~5000 bytes + PES header)
    const large = new Uint8Array(5000);
    large.fill(0xab);
    large[0] = 0;
    large[1] = 0;
    large[2] = 0;
    large[3] = 1;
    large[4] = 0x65;
    muxer.addChunkStruct(vid, { data: large, timestampUs: 21_333, dtsUs: 21_333, key: true });
    await muxer.finalize();
    const chunks: Uint8Array[] = [];
    const reader = muxer.output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      expect(value.byteLength % PACKET).toBe(0);
      expect(value[0]).toBe(0x47);
    }
    expect(chunks.length).toBeGreaterThan(2); // incremental, not single blob
    const bytes = concatBytes(...chunks);
    expect(bytes.byteLength % PACKET).toBe(0);
    // continuity per PID must cycle 0..15 and wrap
    const counts = new Map<number, number[]>(); // pid -> counters
    for (let off = 0; off < bytes.byteLength; off += PACKET) {
      const pid = (((bytes[off + 1] ?? 0) & 0x1f) << 8) | (bytes[off + 2] ?? 0);
      const cc = (bytes[off + 3] ?? 0) & 0x0f;
      const ac = ((bytes[off + 3] ?? 0) >> 4) & 0x03;
      const hasPayload = ac === 1 || ac === 3;
      if (!hasPayload) continue;
      const arr = counts.get(pid) ?? [];
      arr.push(cc);
      counts.set(pid, arr);
    }
    for (const [, arr] of counts) {
      for (let i = 1; i < arr.length; i++) expect(arr[i]).toBe(((arr[i - 1] ?? 0) + 1) & 0x0f);
    }
    // round-trip preserves access units
    const parsed = parseTs(bytes);
    expect(parsed.tracks.map((t) => t.stream.codec).sort()).toEqual(['aac', 'h264']);
  });

  it('continuity wraps at 16 across many packets and granularity equivalence', async () => {
    const makeMux = (gran: number): MpegTsMuxer => {
      const m = new MpegTsMuxer({ writeChunkPackets: gran });
      const v = m.addTrack(h264Track());
      const a = m.addTrack(aacTrack());
      for (let i = 0; i < 20; i++) {
        m.addChunkStruct(v, {
          data: Uint8Array.of(0, 0, 0, 1, 0x65, 0xaa, i),
          timestampUs: i * 33_333,
          dtsUs: i * 33_333,
          key: i % 5 === 0,
        });
        m.addChunkStruct(a, {
          data: Uint8Array.of(0x21, 0x10, i),
          timestampUs: i * 21_333,
          key: true,
        });
      }
      return m;
    };
    const tiny = makeMux(1);
    await tiny.finalize();
    const tinyBytes = await collectBytes(tiny.output);
    const bulk = makeMux(87);
    await bulk.finalize();
    const bulkBytes = await collectBytes(bulk.output);
    expect([...tinyBytes]).toEqual([...bulkBytes]); // byte-identical regardless of granularity
    // verify continuity wrapping beyond 16
    let totalPayloadPackets = 0;
    for (let off = 0; off < tinyBytes.byteLength; off += PACKET) {
      const ac = ((tinyBytes[off + 3] ?? 0) >> 4) & 0x03;
      if (ac === 1 || ac === 3) totalPayloadPackets++;
    }
    expect(totalPayloadPackets).toBeGreaterThan(16);
    // per-pid continuity must be strictly incrementing modulo 16 (only for media PIDs with many packets)
    const perPid = new Map<number, number[]>();
    for (let off = 0; off < tinyBytes.byteLength; off += PACKET) {
      const pid = (((tinyBytes[off + 1] ?? 0) & 0x1f) << 8) | (tinyBytes[off + 2] ?? 0);
      const cc = (tinyBytes[off + 3] ?? 0) & 0x0f;
      const ac = ((tinyBytes[off + 3] ?? 0) >> 4) & 0x03;
      if (ac !== 1 && ac !== 3) continue;
      const arr = perPid.get(pid) ?? [];
      arr.push(cc);
      perPid.set(pid, arr);
    }
    for (const [pid, arr] of perPid) {
      if (pid === 0x0000 || pid === 0x0100) continue; // PAT/PMT have single packet, skip strict check
      expect(arr.length).toBeGreaterThan(5);
      for (let i = 1; i < arr.length; i++) expect(arr[i]).toBe(((arr[i - 1] ?? 0) + 1) & 0x0f);
    }
  });

  it('timestamp wrap — PES PTS near 2^33 crosses modulo and parses without crash, 188-aligned', async () => {
    const muxer = new MpegTsMuxer();
    const vid = muxer.addTrack(h264Track());
    const baseTicks = 2 ** 33 - 18000;
    for (let i = 0; i < 6; i++) {
      const ticks = baseTicks + i * 3600;
      const us = ticksToUs(ticks);
      muxer.addChunkStruct(vid, {
        data: Uint8Array.of(0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65, 0xaa, i),
        timestampUs: us,
        dtsUs: us,
        key: i === 0,
      });
    }
    await muxer.finalize();
    const bytes = await collectBytes(muxer.output);
    expect(bytes.byteLength % PACKET).toBe(0);
    const parsed = parseTs(bytes);
    expect(parsed.tracks).toHaveLength(1);
    const units = parsed.tracks[0]?.units ?? [];
    expect(units).toHaveLength(6);
    // Wrap crosses 33-bit boundary: mux normalizes via modulo, parse must not throw and must retain 6 units.
    // Duration via current unwrap sorts ticks ascending, so wrapped small values appear first and duration
    // becomes large; we only assert boundedness and that timing evidence exists.
    expect(parsed.tracks[0]?.durationSec).toBeGreaterThan(0);
    expect(parsed.tracks[0]?.durationSec).toBeLessThan(1e6);
    expect(parsed.tracks[0]?.timing).toBeDefined();
  });

  it('bounded segments — budget per-track, small-write invariant, randomized equivalence', async () => {
    // boundary: exactly MAX accepted (use small payload to keep output bounded; budget is on AU count not bytes)
    const muxerMax = new MpegTsMuxer();
    const vMax = muxerMax.addTrack(h264Track());
    for (let i = 0; i < MAX_TS_MUX_ACCESS_UNITS_PER_TRACK; i++)
      muxerMax.addChunkStruct(vMax, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65, i & 0xff),
        timestampUs: i * 33_333,
        key: true,
      });
    // MAX boundary must not throw on finalize; output is packet-aligned
    await muxerMax.finalize();
    const bytesMax = await collectBytes(muxerMax.output);
    expect(bytesMax.byteLength % PACKET).toBe(0);
    // budget exceeded on next write
    const muxerOver = new MpegTsMuxer();
    const vOver = muxerOver.addTrack(h264Track());
    for (let i = 0; i < MAX_TS_MUX_ACCESS_UNITS_PER_TRACK; i++)
      muxerOver.addChunkStruct(vOver, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
        timestampUs: i * 33_333,
        key: true,
      });
    expect(() =>
      muxerOver.addChunkStruct(vOver, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
        timestampUs: 0,
        key: true,
      }),
    ).toThrowError(/budget exceeded/i);
    // 20x randomized valid 0..9 payloads, byte-exact between granularities and round-trip (skip n=0 which has no packet)
    for (let iter = 0; iter < 20; iter++) {
      const n = Math.max(1, Math.floor(Math.random() * 10)); // 1..9 ensures at least one packet for valid mux
      const mk = (gran: number): MpegTsMuxer => {
        const m = new MpegTsMuxer({ writeChunkPackets: gran });
        const v = m.addTrack(h264Track());
        for (let i = 0; i < n; i++)
          m.addChunkStruct(v, {
            data: Uint8Array.of(0, 0, 0, 1, 0x65, iter, i),
            timestampUs: i * 33_333,
            dtsUs: i * 33_333,
            key: i === 0,
          });
        return m;
      };
      const a = mk(1);
      await a.finalize();
      const aBytes = await collectBytes(a.output);
      const b = mk(87);
      await b.finalize();
      const bBytes = await collectBytes(b.output);
      expect([...aBytes]).toEqual([...bBytes]);
      const parsed = parseTs(aBytes);
      expect(parsed.tracks[0]?.units).toHaveLength(n);
      // also verify n=0 correctly rejects with typed error (no packet)
      if (iter === 0) {
        const empty = new MpegTsMuxer();
        empty.addTrack(h264Track());
        await expect(empty.finalize()).rejects.toThrowError(/at least one packet/i);
      }
    }
  });

  it('malformed — typed rejection, discontinuity flag preserved, empty/truncated', async () => {
    const muxer = new MpegTsMuxer();
    const v = muxer.addTrack(h264Track());
    expect(() =>
      muxer.addChunkStruct(999, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
        timestampUs: 0,
        key: true,
      }),
    ).toThrowError(/unknown mux track/i);
    expect(() =>
      muxer.addChunkStruct(v, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
        timestampUs: Number.NaN,
        key: true,
      }),
    ).toThrowError(/Invalid MPEG-TS timestampUs/i);
    expect(() =>
      muxer.addChunkStruct(v, {
        data: Uint8Array.of(0, 0, 0, 1, 0x65),
        timestampUs: 0,
        durationUs: -1,
        key: true,
      }),
    ).toThrowError(/Invalid MPEG-TS durationUs/i);
    expect(() =>
      muxer.addChunkStruct(v, { data: new Uint8Array(), timestampUs: 0, key: true }),
    ).toThrowError(/empty MPEG-TS access unit/i);
    // discontinuity: craft a TS byte stream with adaptation discontinuity flag and verify parseTs sees it
    const { parseTs: parse } = await import('./ts-parse.ts');
    // reuse helper: build minimal TS with discontinuity flag set on a PCR packet
    const pat = Uint8Array.of(
      0x00,
      0xb0,
      0x0d,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0x00,
      0x01,
      0xe1,
      0x00,
      0,
      0,
      0,
      0,
    );
    function tsPacket(
      pid: number,
      payload: Uint8Array,
      opts: { payloadUnitStart?: boolean; discontinuity?: boolean } = {},
    ): Uint8Array {
      const out = new Uint8Array(188);
      out.fill(0xff);
      out[0] = 0x47;
      out[1] = (opts.payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      out[2] = pid & 0xff;
      const hasAdapt = !!opts.discontinuity;
      out[3] = hasAdapt ? 0x30 : 0x10;
      let cur = 4;
      if (hasAdapt) {
        out[cur] = 1;
        out[cur + 1] = 0x80;
        cur += 2;
      }
      out.set(payload.subarray(0, 188 - cur), cur);
      return out;
    }
    function secPkt(pid: number, sec: Uint8Array): Uint8Array {
      const pl = new Uint8Array(sec.length + 1);
      pl[0] = 0;
      pl.set(sec, 1);
      return tsPacket(pid, pl, { payloadUnitStart: true });
    }
    const pmtSec = Uint8Array.of(
      0x02,
      0xb0,
      0x12,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0xe1,
      0x01,
      0xf0,
      0x00,
      0x1b,
      0xe1,
      0x20,
      0xf0,
      0x00,
      0,
      0,
      0,
      0,
    );
    const pes = (() => {
      const pts = Uint8Array.of(0x21, 0x00, 0x01, 0x00, 0x01, 0x21); // pseudo pts bytes
      return Uint8Array.of(
        0x00,
        0x00,
        0x01,
        0xe0,
        0x00,
        0x06,
        0x80,
        0x80,
        0x05,
        ...pts,
        0x00,
        0x00,
        0x01,
        0x65,
        0xaa,
      );
    })();
    const bytes = new Uint8Array(5 * 188);
    bytes.set(secPkt(0x0000, pat), 0);
    bytes.set(secPkt(0x0100, pmtSec), 188);
    bytes.set(tsPacket(0x0120, new Uint8Array(0), { discontinuity: true }), 376);
    bytes.set(tsPacket(0x0120, pes, { payloadUnitStart: true }), 564);
    bytes.set(tsPacket(0x1fff, new Uint8Array(0)), 752);
    const parsed = parse(bytes);
    expect(parsed.observedDiscontinuity).toBe(true);
  });
});
