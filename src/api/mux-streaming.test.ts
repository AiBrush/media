/**
 * Stream-sink MP4 muxing keeps the progressive contract (doc 09 streaming-output, ADR-013).
 *
 * `mp4` + a lazy `toStream()` sink is authored through the prepared byte-stream writer: the program
 * is a real progressive ISO BMFF layout (a `moov` whose chunk offsets match the payload the writer
 * is about to emit), never a silent fragmentation. A silent `moof` promotion would violate the
 * caller's declared representation (`fragmented` left false) and poison every downstream consumer
 * that asserts progressive output — which is exactly what the harness's `verifyRequestedIsoShape`
 * gate caught after the promotion experiment. Fragment framing is emitted ONLY when the caller
 * explicitly asks for `fragmented: true`; that control is asserted here too, so the progressive
 * tests above are a meaningful absence, not an accident of the writer.
 */

import { describe, expect, it } from 'vitest';
import { fragmentMp4 } from '../drivers/mp4/fragment.ts';
import { streamMp4PacketTracks } from '../drivers/mp4/prepared-stream.ts';

function makeTrack(samples: number, bytesPerSample: number) {
  const track: any = {
    mediaType: 'audio',
    codec: 'opus',
    config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]) },
  };
  return {
    track,
    chunks: Array.from({ length: samples }, (_, i) => ({
      timestampUs: i * 20_000,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array(bytesPerSample).fill(i % 256),
    })),
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{
  readonly chunks: readonly Uint8Array[];
  readonly bytes: Uint8Array;
}> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { chunks, bytes };
}

interface TopBox {
  readonly type: string;
  readonly start: number;
  readonly size: number;
}

function topLevelBoxes(bytes: Uint8Array): TopBox[] {
  const boxes: TopBox[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let size = dv.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (size === 1) {
      size = Number(dv.getBigUint64(offset + 8));
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

/** stsz sample sizes of the program's first (only) track, read from the moov box. */
function stszSampleSizes(bytes: Uint8Array, moov: TopBox): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const target = 0x7374737a; // 'stsz'
  for (let i = moov.start; i + 8 <= moov.start + moov.size; i++) {
    if (dv.getUint32(i + 4) === target) {
      const uniform = dv.getUint32(i + 12);
      const count = dv.getUint32(i + 16);
      const sizes: number[] = [];
      for (let s = 0; s < count; s++) sizes.push(uniform !== 0 ? uniform : dv.getUint32(i + 20 + s * 4));
      return sizes;
    }
  }
  throw new Error('no stsz inside moov');
}

describe('mux streaming target (progressive contract)', () => {
  it('unit: stream-sink mp4 mux is a progressive program — never a moof, exact box coverage', async () => {
    const { chunks, bytes } = await drain(
      streamMp4PacketTracks([makeTrack(10, 1024)], { container: 'mp4', faststart: false }),
    );
    // 10 * 1KiB = 10KiB < 256KiB ⇒ one aggregated payload chunk + ftyp/mdatHeader/moov = 4.
    expect(chunks.length).toBe(4);
    const boxes = topLevelBoxes(bytes);
    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(boxes[boxes.length - 1]!.start + boxes[boxes.length - 1]!.size).toBe(bytes.byteLength);
  });

  it('unit: the explicit fragmented writer does emit moof (absence above is a real contract)', async () => {
    const track: any = makeTrack(4, 256);
    const samples = track.chunks.map((chunk: any) => ({
      data: chunk.data,
      durationTicks: 20,
      cttsTicks: 0,
      keyframe: true,
    }));
    let moofSeen = 0;
    for (const segment of fragmentMp4(
      [{ ...track.track, sampleEntryType: 'mp4a', timescale: 1000, samples }],
      { movieTimescale: 1000 },
    )) {
      if (topLevelBoxes(segment).some((box) => box.type === 'moof')) moofSeen++;
    }
    expect(moofSeen).toBeGreaterThan(0);
  });

  it('property: sample table sizes equal chunk sizes and the byte totals agree, any shape', async () => {
    for (const [samples, size] of [
      [1, 1],
      [7, 33],
      [40, 9_000],
      [3, 300_000],
    ] as const) {
      const track = makeTrack(samples, size);
      const { bytes } = await drain(
        streamMp4PacketTracks([track], { container: 'mp4', faststart: false }),
      );
      const boxes = topLevelBoxes(bytes);
      expect(boxes.some((box) => box.type === 'moof'), `${samples}x${size}`).toBe(false);
      const mdat = boxes.find((box) => box.type === 'mdat')!;
      const moov = boxes.find((box) => box.type === 'moov')!;
      const sizes = stszSampleSizes(bytes, moov);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(samples * size);
      expect(mdat.size - 8).toBe(samples * size);
    }
  });

  it('boundary: faststart stream orders ftyp → moov → mdat; single sample closes exactly', async () => {
    const head = await drain(streamMp4PacketTracks([makeTrack(1, 1)], { container: 'mp4', faststart: true }));
    expect(topLevelBoxes(head.bytes).map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat']);
    const tail = await drain(streamMp4PacketTracks([makeTrack(1, 1)], { container: 'mp4', faststart: false }));
    const boxes = topLevelBoxes(tail.bytes);
    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const last = boxes[boxes.length - 1]!;
    expect(last.start + last.size).toBe(tail.bytes.byteLength);
  });

  it('malformed: empty track list is rejected, not silently fragmented', () => {
    expect(() =>
      streamMp4PacketTracks(
        [{ track: { codec: 'avc1.64001f', width: 640, height: 360 } as any, chunks: [] }],
        { container: 'mp4' },
      ),
    ).toThrow();
  });

  it('randomized: any shape streams progressive — no moof ever, coverage exact', async () => {
    let seed = 0x1234_5678;
    const rand = (n: number) => {
      seed ^= (seed << 13) | 0;
      seed ^= seed >>> 17;
      seed ^= (seed << 5) | 0;
      return Math.abs(seed >>> 0) % n;
    };
    for (let i = 0; i < 12; i++) {
      const samples = 1 + rand(9);
      const size = 1 + rand(70_000);
      const { bytes } = await drain(
        streamMp4PacketTracks([makeTrack(samples, size)], {
          container: 'mp4',
          faststart: i % 2 === 0,
        }),
      );
      const boxes = topLevelBoxes(bytes);
      expect(boxes.some((box) => box.type === 'moof')).toBe(false);
      const last = boxes[boxes.length - 1]!;
      expect(last.start + last.size).toBe(bytes.byteLength);
      const mdatPayload =
        boxes.filter((box) => box.type === 'mdat').reduce((total, box) => total + box.size - 8, 0);
      expect(mdatPayload).toBe(samples * size);
    }
  });
});
