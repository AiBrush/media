/**
 * WebM progressive cluster emission — finite vs streaming bounded-memory equivalence (REQUIREMENTS §5.6 — 1.4.2).
 */
import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import {
  type ChunkStruct,
  WebmMuxer,
  WebmStreamingMuxer,
  buildBlockTimeline,
} from './ebml-write.ts';
import { elements, findChild, readUint, readVint } from './ebml.ts';

const ID = {
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  BlockDuration: 0x9b,
} as const;

function chunk(ts: number, dur: number, key: boolean, size: number): ChunkStruct {
  return {
    timestampUs: ts,
    durationUs: dur,
    key,
    data: new Uint8Array(size).fill(key ? 0x6b : 0x42),
  };
}

async function collectChunks(output: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = output.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return parts;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function segmentSizeValue(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const el of elements(dv, 0, dv.byteLength)) {
    if (el.id !== ID.Segment) continue;
    for (let p = 0; p + 4 <= dv.byteLength; p++) {
      if (
        dv.getUint8(p) === 0x18 &&
        dv.getUint8(p + 1) === 0x53 &&
        dv.getUint8(p + 2) === 0x80 &&
        dv.getUint8(p + 3) === 0x67
      ) {
        const size = readVint(dv, p + 4, false);
        return size ? size.value : Number.NaN;
      }
    }
  }
  return Number.NaN;
}

function topLevelClusterCount(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seg = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!seg) return 0;
  let count = 0;
  for (const el of elements(dv, seg.dataStart, seg.dataEnd)) if (el.id === ID.Cluster) count++;
  return count;
}

interface ScannedBlock {
  timeMs: number;
  key: boolean;
  size: number;
}
function scanBlocks(bytes: Uint8Array): ScannedBlock[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seg = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!seg) throw new Error('no Segment');
  const out: ScannedBlock[] = [];
  for (const el of elements(dv, seg.dataStart, seg.dataEnd)) {
    if (el.id !== ID.Cluster) continue;
    let clusterTime = 0;
    for (const c of elements(dv, el.dataStart, el.dataEnd)) {
      if (c.id === ID.Timecode) clusterTime = readUint(dv, c);
      else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
        const block = c.id === ID.SimpleBlock ? c : findChild(dv, c.dataStart, c.dataEnd, ID.Block);
        if (!block) continue;
        const tn = readVint(dv, block.dataStart, false);
        if (!tn) continue;
        const rel = dv.getInt16(block.dataStart + tn.length, false);
        const flags = dv.getUint8(block.dataStart + tn.length + 2);
        const dataStart = block.dataStart + tn.length + 3;
        out.push({
          timeMs: clusterTime + rel,
          key:
            c.id === ID.SimpleBlock
              ? (flags & 0x80) !== 0
              : findChild(dv, c.dataStart, c.dataEnd, ID.ReferenceBlock) === undefined,
          size: block.dataEnd - dataStart,
        });
      }
    }
  }
  return out;
}

describe('WebM progressive cluster emission bounded (1.4.2)', () => {
  it('finite emits definite-size Segment; streaming emits unknown-size Segment', async () => {
    const finite = new WebmMuxer();
    const fvid = finite.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    });
    finite.addChunkStruct(fvid, chunk(0, 33_333, true, 10));
    finite.addChunkStruct(fvid, chunk(33_333, 33_333, false, 11));
    await finite.finalize();
    const finiteBytes = concat(await collectChunks(finite.output));
    expect(segmentSizeValue(finiteBytes)).toBeGreaterThan(0);

    const streaming = new WebmStreamingMuxer({ timelineBaseUs: 0 });
    const svid = streaming.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    });
    const p = collectChunks(streaming.output);
    await streaming.addChunkStruct(svid, chunk(0, 33_333, true, 10));
    await streaming.addChunkStruct(svid, chunk(33_333, 33_333, false, 11));
    await streaming.finalize();
    const streamingBytes = concat(await p);
    expect(segmentSizeValue(streamingBytes)).toBe(-1);
  });

  it('streaming emits Cluster incrementally without buffering whole timeline', async () => {
    const muxer = new WebmStreamingMuxer({ timelineBaseUs: 0 });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 32, codedHeight: 24 },
    });
    const reader = muxer.output.getReader();
    await muxer.addChunkStruct(vid, chunk(0, 33_333, true, 20));
    const init = await reader.read();
    expect(init.done).toBe(false);
    expect(topLevelClusterCount(init.value!)).toBe(0);
    await muxer.addChunkStruct(vid, chunk(33_333, 33_333, false, 21));
    await muxer.addChunkStruct(vid, chunk(66_666, 33_333, true, 22));
    const firstCluster = await reader.read();
    expect(firstCluster.done).toBe(false);
    expect(firstCluster.value!.subarray(0, 4)).toEqual(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]));
    await muxer.finalize();
    const tail: Uint8Array[] = [];
    for (;;) {
      const n = await reader.read();
      if (n.done) break;
      tail.push(n.value!);
    }
    reader.releaseLock();
    const all = concat([init.value!, firstCluster.value!, ...tail]);
    expect(topLevelClusterCount(all)).toBe(2);
    expect(scanBlocks(all).map((b) => b.size)).toEqual([20, 21, 22]);
  });

  it('finite vs streaming preserve identical block timeline', async () => {
    const frames: ChunkStruct[] = [];
    for (let i = 0; i < 8; i++) frames.push(chunk(i * 33_333, 33_333, i % 4 === 0, 20 + i));
    const finite = new WebmMuxer({ fragmented: false });
    const fvid = finite.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    for (const c of frames) finite.addChunkStruct(fvid, c);
    await finite.finalize();
    const finiteBlocks = scanBlocks(concat(await collectChunks(finite.output)));

    const streaming = new WebmStreamingMuxer({ timelineBaseUs: 0 });
    const svid = streaming.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    const sp = collectChunks(streaming.output);
    for (const c of frames) await streaming.addChunkStruct(svid, c);
    await streaming.finalize();
    const streamingBlocks = scanBlocks(concat(await sp));
    expect(streamingBlocks.map((b) => b.size)).toEqual(finiteBlocks.map((b) => b.size));
    expect(streamingBlocks.map((b) => b.timeMs)).toEqual(finiteBlocks.map((b) => b.timeMs));
  });

  it('malformed: adding track after streaming started and unknown track throw typed error', async () => {
    const muxer = new WebmStreamingMuxer({ timelineBaseUs: 0 });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    });
    await muxer.addChunkStruct(vid, chunk(0, 33_333, true, 5));
    const reader = muxer.output.getReader();
    await reader.read();
    expect(() =>
      muxer.addTrack({
        id: 2,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
      }),
    ).toThrow(MediaError);
    await expect(muxer.addChunkStruct(99, chunk(0, 33_333, true, 5))).rejects.toThrow(MediaError);
    await muxer.finalize();
    for (;;) {
      const n = await reader.read();
      if (n.done) break;
    }
    reader.releaseLock();
  });

  it('20× randomized: finite vs streaming block-equivalent across varying GOP and sizes', async () => {
    for (let trial = 0; trial < 20; trial++) {
      const n = 3 + (trial % 7);
      const gop = 2 + (trial % 4);
      const frames: ChunkStruct[] = [];
      for (let i = 0; i < n; i++)
        frames.push(
          chunk(i * 20_000 + ((trial * 13) % 7), 20_000, i % gop === 0, 10 + ((trial + i) % 20)),
        );
      const finite = new WebmMuxer();
      const fvid = finite.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        config: { codec: 'vp09.00.10.08', codedWidth: 16 + trial, codedHeight: 16 + trial },
      });
      for (const c of frames) finite.addChunkStruct(fvid, c);
      await finite.finalize();
      const fBlocks = scanBlocks(concat(await collectChunks(finite.output)));
      const streaming = new WebmStreamingMuxer({ timelineBaseUs: frames[0]?.timestampUs ?? 0 });
      const svid = streaming.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        config: { codec: 'vp09.00.10.08', codedWidth: 16 + trial, codedHeight: 16 + trial },
      });
      const sp = collectChunks(streaming.output);
      for (const c of frames) await streaming.addChunkStruct(svid, c);
      await streaming.finalize();
      const sBlocks = scanBlocks(concat(await sp));
      expect(sBlocks.map((b) => b.size)).toEqual(fBlocks.map((b) => b.size));
      expect(sBlocks.length).toBe(n);
      const tl = buildBlockTimeline([{ trackNumber: 1, chunks: frames }]);
      expect(tl.blocks.length).toBe(n);
    }
  });
});
