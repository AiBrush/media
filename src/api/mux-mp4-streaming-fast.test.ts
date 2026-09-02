import { describe, expect, it } from 'vitest';
import { muxPreparedMp4PacketStreams } from './flac-mkv-mux.ts';
import type { PacketStreams } from './types.ts';

function makePacketStream(trackId: number, mediaType: 'video' | 'audio', codec: string, count: number): PacketStreams {
  const track = {
    id: trackId,
    mediaType,
    codec,
    config: mediaType === 'video'
      ? { codec: 'avc1.64001F', codedWidth: 640, codedHeight: 360, description: new Uint8Array([1, 0x64, 0, 0x1f, 0xe0, 1, 0, 4, 0x67, 0x64, 0, 0x1f, 1, 0, 4, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]) }
      : { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x12, 0x10]) },
    durationSec: count * 0.02,
  } as any;
  const packetsArray = Array.from({ length: count }, (_, i) => ({
    chunk: {
      type: 'key' as const,
      timestamp: i * 20_000,
      duration: 20_000,
      byteLength: 100,
      copyTo(dst: Uint8Array) { dst.set(new Uint8Array(100).fill(i % 256)); },
    },
    dtsUs: i * 20_000,
  } as any));
  return {
    video: mediaType === 'video' ? { track, packetsArray } as any : undefined,
    audio: mediaType === 'audio' ? { track, packetsArray } as any : undefined,
  };
}

function makeTwoTrackStreams(count: number): PacketStreams {
  const video = makePacketStream(1, 'video', 'h264', count).video!;
  const audio = makePacketStream(2, 'audio', 'aac', count).audio!;
  return { tracks: [video, audio] } as any;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function topLevelBoxes(bytes: Uint8Array): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const types: string[] = [];
  let off = 0;
  while (off + 8 <= bytes.byteLength) {
    let size = dv.getUint32(off);
    const type = dec.decode(bytes.subarray(off + 4, off + 8));
    if (size === 1) size = Number(dv.getBigUint64(off + 8));
    else if (size === 0) size = bytes.byteLength - off;
    types.push(type);
    off += size;
  }
  return types;
}

describe('mux mp4 streaming target — prepared fast path', () => {
  it('unit: single-track mp4 streaming via prepared path is valid progressive (no moof)', async () => {
    const streams = makePacketStream(1, 'video', 'h264', 10);
    const stream = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4' } as any);
    expect(stream).toBeDefined();
    const bytes = await collect(stream!);
    const boxes = topLevelBoxes(bytes);
    expect(boxes).toContain('ftyp');
    expect(boxes).toContain('moov');
    expect(boxes).toContain('mdat');
    expect(boxes).not.toContain('moof');
  });

  it('property: prepared streaming vs buffered produce byte-identical moov payload', async () => {
    const streams = makeTwoTrackStreams(200);
    const s1 = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4' } as any);
    const s2 = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4', buffered: true } as any);
    const b1 = await collect(s1!);
    const b2 = await collect(s2!);
    // Both are progressive; payload sizes equal (mdat payload + moov)
    expect(b1.byteLength).toBe(b2.byteLength);
    expect(topLevelBoxes(b1)).toEqual(topLevelBoxes(b2));
  });

  it('boundary: 1 packet and 500 packets both succeed (streaming)', async () => {
    for (const count of [1, 500]) {
      const streams = count === 1 ? makePacketStream(1, 'video', 'h264', 1) : makeTwoTrackStreams(500);
      const stream = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4' } as any);
      const bytes = await collect(stream!);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(topLevelBoxes(bytes)).toContain('mdat');
    }
  });

  it('malformed: empty track list returns undefined (falls through to generic)', async () => {
    const empty: PacketStreams = {};
    const stream = await muxPreparedMp4PacketStreams(empty as any, { container: 'mp4' } as any);
    expect(stream).toBeUndefined();
    // fragmented or reserve should decline
    const frag = await muxPreparedMp4PacketStreams(makeTwoTrackStreams(5) as any, { container: 'mp4', fragmented: true } as any);
    expect(frag).toBeUndefined();
    const reserve = await muxPreparedMp4PacketStreams(makeTwoTrackStreams(5) as any, { container: 'mp4', faststart: 'reserve' } as any);
    expect(reserve).toBeUndefined();
  });

  it('randomized: 20 fuzzed track counts produce valid progressive outputs', async () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 20; i++) {
      const count = 130 + Math.floor(rand() * 50); // ensure multitrack >=256
      const streams = makeTwoTrackStreams(count);
      const stream = await muxPreparedMp4PacketStreams(streams as any, { container: 'mp4' } as any);
      const bytes = await collect(stream!);
      const boxes = topLevelBoxes(bytes);
      expect(boxes[0]).toBe('ftyp');
      expect(boxes).toContain('moov');
      // Never fragmented by this path
      expect(boxes).not.toContain('moof');
    }
  });
});
