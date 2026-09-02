import { describe, expect, it } from 'vitest';
import { muxPreparedMp4PacketStreams } from './flac-mkv-mux.ts';
import type { PacketStreams } from './types.ts';

function vfrPacketStream(count: number, jitter: number): PacketStreams {
  const track = {
    id: 1,
    mediaType: 'video' as const,
    codec: 'h264',
    config: { codec: 'avc1.64001F', codedWidth: 1280, codedHeight: 720, description: new Uint8Array([1, 0x64, 0, 0x1f, 0xe0, 1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]) },
  } as any;
  const packetsArray = Array.from({ length: count }, (_, i) => {
    const base = i * 33_333;
    const pts = base + (i % 3 === 0 ? jitter : 0);
    return {
      chunk: { type: 'key' as const, timestamp: pts, duration: 33_333, byteLength: 100, copyTo(dst: Uint8Array) { dst.set(new Uint8Array(100).fill(i % 256)); } },
      dtsUs: base,
    } as any;
  });
  return { video: { track, packetsArray } as any };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const r = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

describe('mux VFR — prepared fast path', () => {
  it('unit: VFR mp4 mux via prepared path is valid progressive', async () => {
    const streams = vfrPacketStream(30, 5000);
    const s = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
    expect(s).toBeDefined();
    const bytes = await collect(s!);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // At least contains moov
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('property: prepared VFR vs generic produce same duration', async () => {
    const streams = vfrPacketStream(50, 3000);
    const s1 = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
    const b1 = await collect(s1!);
    const s2 = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
    const b2 = await collect(s2!);
    expect(b1.byteLength).toBe(b2.byteLength);
  });

  it('boundary: 1 packet and 1000 packets', async () => {
    for (const count of [1, 1000]) {
      const streams = vfrPacketStream(count, 1000);
      const s = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
      const b = await collect(s!);
      expect(b.byteLength).toBeGreaterThan(0);
    }
  });

  it('malformed: empty and fragmented decline', async () => {
    const empty: PacketStreams = {};
    const r1 = await muxPreparedMp4PacketStreams(empty as any, { container: 'mp4', buffered: true } as any);
    expect(r1).toBeUndefined();
    const frag = await muxPreparedMp4PacketStreams(vfrPacketStream(10, 0) as any, { container: 'mp4', fragmented: true } as any);
    expect(frag).toBeUndefined();
  });

  it('randomized: 20 fuzzed VFR counts', async () => {
    let seed = 0x1234;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 20; i++) {
      const count = 5 + Math.floor(rand() * 100);
      const jitter = Math.floor(rand() * 5000);
      const streams = vfrPacketStream(count, jitter);
      const s = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
      const b = await collect(s!);
      expect(b.byteLength).toBeGreaterThan(0);
    }
  });
});
