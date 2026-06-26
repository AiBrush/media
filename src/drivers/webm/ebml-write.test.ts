/**
 * Validation for the WebM/Matroska `Muxer` ({@link WebmMuxer}) — a real round-trip oracle that can fail.
 *
 * Plain chunk-structs (NOT WebCodecs `Encoded*Chunk`s) are fed through the pure ingest
 * ({@link WebmMuxer.addChunkStruct}, the same path `write()` uses after its browser-only `copyTo`), the
 * muxer serializes the WebM on `finalize`, and the bytes are re-parsed two ways:
 *   - the high-level {@link parseWebm} (container/DocType, TimecodeScale-derived duration, per-track
 *     codec + geometry), and
 *   - an INDEPENDENT `SimpleBlock` scan built from the low-level {@link ebml} readers (not the writer) —
 *     decoding each block's TrackNumber + absolute presentation timecode + keyframe flag + frame size.
 * We assert track count, codecs, geometry, per-track sample count, timestamps, keyframe flags, and frame
 * sizes all match the inputs — covering multitrack, B-frame (PTS-ordered) reorder, and a long stream that
 * forces a Cluster split at the int16 relative-timecode boundary. The pure {@link buildBlockTimeline} is
 * also unit-tested directly.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { writeToStreamTarget } from '../../sinks/stream-target.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { readMovie } from '../mp4/mp4-driver.ts';
import { buildSamples } from '../mp4/samples.ts';
import {
  type ChunkStruct,
  type TimelineBlock,
  WebmMuxer,
  buildBlockTimeline,
  planWebmFragments,
} from './ebml-write.ts';
import { type EbmlElement, elements, findChild, readUint, readVint } from './ebml.ts';
import { WebmDriver, type WebmFrame, demuxWebm, parseWebm } from './webm-driver.ts';

const ID = {
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
} as const;

interface ScannedBlock {
  trackNumber: number;
  timeMs: number;
  key: boolean;
  size: number;
}

/** Independently scan every Cluster's SimpleBlocks (low-level EBML only — not the writer under test). */
function scanBlocks(bytes: Uint8Array): ScannedBlock[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) throw new Error('no Segment');
  const out: ScannedBlock[] = [];
  for (const el of elements(dv, segment.dataStart, segment.dataEnd)) {
    if (el.id !== ID.Cluster) continue;
    let clusterTime = 0;
    for (const c of elements(dv, el.dataStart, el.dataEnd)) {
      if (c.id === ID.Timecode) {
        clusterTime = readUint(dv, c);
      } else if (c.id === ID.SimpleBlock) {
        const tn = readVint(dv, c.dataStart, false);
        if (!tn) continue;
        const rel = dv.getInt16(c.dataStart + tn.length, false);
        const flags = dv.getUint8(c.dataStart + tn.length + 2);
        const dataStart = c.dataStart + tn.length + 3;
        out.push({
          trackNumber: tn.value,
          timeMs: clusterTime + rel,
          key: (flags & 0x80) !== 0,
          size: c.dataEnd - dataStart,
        });
      }
    }
  }
  return out;
}

/** Locate a TrackEntry by TrackNumber and read its CodecPrivate bytes (or undefined). */
function codecPrivateOf(bytes: Uint8Array, trackNumber: number): Uint8Array | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) return undefined;
  const tracks = findChild(dv, segment.dataStart, segment.dataEnd, ID.Tracks);
  if (!tracks) return undefined;
  for (const te of elements(dv, tracks.dataStart, tracks.dataEnd)) {
    if (te.id !== ID.TrackEntry) continue;
    const num = findChild(dv, te.dataStart, te.dataEnd, ID.TrackNumber);
    if (!num || readUint(dv, num) !== trackNumber) continue;
    const cp: EbmlElement | undefined = findChild(dv, te.dataStart, te.dataEnd, ID.CodecPrivate);
    return cp ? bytes.slice(cp.dataStart, cp.dataEnd) : undefined;
  }
  return undefined;
}

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

/** A minimal OpusHead (the bytes a real Opus `description` carries) — round-tripped as CodecPrivate. */
const OPUS_HEAD = new Uint8Array([
  0x4f,
  0x70,
  0x75,
  0x73,
  0x48,
  0x65,
  0x61,
  0x64, // "OpusHead"
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

function chunk(timestampUs: number, durationUs: number, key: boolean, n: number): ChunkStruct {
  return { timestampUs, durationUs, key, data: new Uint8Array(n).fill(key ? 0x6b : 0x42) };
}

const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

async function mediaTestFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

describe('buildBlockTimeline — presentation-time ordering (pure)', () => {
  it('rebases to t=0, ms ticks, sorted by time; reports the end time', () => {
    const { blocks, endMs } = buildBlockTimeline([
      {
        trackNumber: 1,
        chunks: [chunk(500_000, 40_000, true, 3), chunk(540_000, 40_000, false, 3)],
      },
    ]);
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 40]); // rebased + ms
    expect(blocks.map((b) => b.key)).toEqual([true, false]);
    expect(endMs).toBe(80); // last PTS (540ms rebased=40) + 40ms duration
  });

  it('interleaves two tracks in time order, each block keeping its own track number', () => {
    const { blocks } = buildBlockTimeline([
      { trackNumber: 1, chunks: [chunk(0, 33_000, true, 1), chunk(33_000, 33_000, false, 1)] },
      { trackNumber: 2, chunks: [chunk(0, 21_000, true, 1), chunk(21_000, 21_000, true, 1)] },
    ]);
    // Sorted by (timeMs, trackNumber): t0 v(1) & a(2); t21 a(2); t33 v(1).
    expect(blocks.map((b) => [b.timeMs, b.trackNumber])).toEqual([
      [0, 1],
      [0, 2],
      [21, 2],
      [33, 1],
    ]);
  });

  it('recovers the final chunk duration from the prior gap when omitted (Duration ≠ 0)', () => {
    const mk = (us: number): ChunkStruct => ({
      timestampUs: us,
      durationUs: undefined,
      key: true,
      data: new Uint8Array([1]),
    });
    const { endMs } = buildBlockTimeline([
      { trackNumber: 1, chunks: [mk(0), mk(40_000), mk(80_000)] },
    ]);
    expect(endMs).toBe(120); // last PTS 80ms + recovered 40ms gap
  });

  it('prefers a declared remux duration over packet-tail padding', () => {
    const { endMs } = buildBlockTimeline([
      {
        trackNumber: 1,
        durationSec: 1,
        chunks: [
          { timestampUs: 66_667, durationUs: 33_333, key: true, data: new Uint8Array([1]) },
          { timestampUs: 1_033_333, durationUs: 33_333, key: false, data: new Uint8Array([2]) },
        ],
      },
    ]);
    expect(endMs).toBe(1000);
  });

  it('stores B-frame blocks in DECODE order (by dtsUs), keeping each SimpleBlock timecode at its PTS', () => {
    // Decode order I,P,B,B fed with the source DTS; PTS is reordered (display order I,B,B,P). Matroska
    // reads a Cluster front-to-back into the decoder, so storage MUST be decode order even though each
    // block's timecode is the PTS (ADR-045). The OLD presentation-order layout would scramble decode.
    const dtsChunk = (pts: number, dts: number, key: boolean): ChunkStruct => ({
      timestampUs: pts,
      durationUs: 100_000,
      key,
      data: new Uint8Array([1]),
      dtsUs: dts,
    });
    const { blocks } = buildBlockTimeline([
      {
        trackNumber: 1,
        chunks: [
          dtsChunk(0, 0, true), // I
          dtsChunk(300_000, 100_000, false), // P (displayed last)
          dtsChunk(100_000, 200_000, false), // B
          dtsChunk(200_000, 300_000, false), // B
        ],
      },
    ]);
    // Storage stays in DECODE order: PTS timecodes are [0, 300, 100, 200] ms (NOT sorted), DTS monotonic.
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 300, 100, 200]);
    expect(blocks.map((b) => b.dtsMs)).toEqual([0, 100, 200, 300]);
    expect(blocks.map((b) => b.key)).toEqual([true, false, false, false]);
  });

  it('uses edit-list-adjusted packet timestamps for a real B-frame MP4 fallback end', async () => {
    const file = await loadFixture('bear-hevc-10bit-hdr10.mp4');
    const movie = await readMovie({
      read: (o, l) => Promise.resolve(file.subarray(o, o + l)),
      size: file.byteLength,
    });
    const { endMs } = buildBlockTimeline(
      movie.tracks.map((track, index) => ({
        trackNumber: index + 1,
        chunks: buildSamples(track).map(
          (sample): ChunkStruct => ({
            timestampUs: sample.ptsUs,
            durationUs: sample.durationUs,
            dtsUs: sample.dtsUs,
            key: sample.keyframe,
            data: new Uint8Array([1]),
          }),
        ),
      })),
    );

    expect(endMs).toBe(2763);
  });

  it('keeps MP4 AAC priming from extending a real cross-container WebM duration', async () => {
    const file = await mediaTestFixture('h264_1080p_30s.mp4');
    const movie = await readMovie({
      read: (o, l) => Promise.resolve(file.subarray(o, o + l)),
      size: file.byteLength,
    });
    const video = movie.tracks.find((track) => track.mediaType === 'video');
    const audio = movie.tracks.find((track) => track.mediaType === 'audio');
    if (video === undefined || audio === undefined) {
      throw new Error('expected h264_1080p_30s.mp4 to carry one video and one audio track');
    }

    const { blocks, endMs } = buildBlockTimeline([
      {
        trackNumber: 1,
        mediaType: 'video',
        durationSec: video.durationSec,
        chunks: buildSamples(video).map(
          (sample): ChunkStruct => ({
            timestampUs: sample.ptsUs,
            durationUs: sample.durationUs,
            dtsUs: sample.dtsUs,
            key: sample.keyframe,
            data: new Uint8Array([1]),
          }),
        ),
      },
      {
        trackNumber: 2,
        mediaType: 'audio',
        durationSec: audio.durationSec,
        chunks: buildSamples(audio).map(
          (sample): ChunkStruct => ({
            timestampUs: sample.ptsUs,
            durationUs: sample.durationUs,
            dtsUs: sample.dtsUs,
            key: sample.keyframe,
            data: new Uint8Array([2]),
          }),
        ),
      },
    ]);

    expect(video.durationSec).toBe(30);
    expect(audio.durationSec).toBeGreaterThan(video.durationSec);
    expect(blocks.find((block) => block.trackNumber === 1)?.timeMs).toBe(0);
    expect(endMs).toBe(30_000);
  });

  it('empty input → no blocks, end 0', () => {
    expect(buildBlockTimeline([])).toEqual({ blocks: [], endMs: 0 });
  });
});

describe('WebmMuxer — round-trip on synthesized packets (parseWebm + independent block scan)', () => {
  it('video-only VP9: re-parses to the right codec/geometry; blocks match count/time/key/size', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    const inputs = [
      chunk(0, 33_333, true, 120),
      chunk(33_333, 33_333, false, 40),
      chunk(66_666, 33_333, false, 55),
      chunk(99_999, 33_333, false, 33),
    ];
    for (const c of inputs) muxer.addChunkStruct(vid, c);
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const info = parseWebm(bytes);
    expect(info.container).toBe('webm');
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]?.codec).toBe('vp9');
    expect(info.tracks[0]?.mediaType).toBe('video');
    expect(info.tracks[0]?.width).toBe(64);
    expect(info.tracks[0]?.height).toBe(48);
    // Duration = last PTS (99.999 ms) + its 33.333 ms duration = 133 ms (TimecodeScale-derived).
    expect(info.durationSec).toBeCloseTo(0.133, 3);

    // The file is a valid EBML stream (starts with the 1A45DFA3 magic).
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    const blocks = scanBlocks(bytes);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => b.trackNumber)).toEqual([1, 1, 1, 1]);
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 33, 67, 100]); // round(PTS µs / 1000)
    expect(blocks.map((b) => b.key)).toEqual([true, false, false, false]);
    expect(blocks.map((b) => b.size)).toEqual([120, 40, 55, 33]);
  });

  it('B-frame remux: SimpleBlocks are stored in decode order with PTS timecodes, all relative ≥ 0', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    // Decode order I,P,B,B with reordered PTS (display I,B,B,P) — carries the source DTS through the seam.
    const dtsChunk = (pts: number, dts: number, key: boolean, n: number): ChunkStruct => ({
      timestampUs: pts,
      durationUs: 100_000,
      key,
      data: new Uint8Array(n).fill(key ? 0x6b : 0x42),
      dtsUs: dts,
    });
    muxer.addChunkStruct(vid, dtsChunk(0, 0, true, 50));
    muxer.addChunkStruct(vid, dtsChunk(300_000, 100_000, false, 40));
    muxer.addChunkStruct(vid, dtsChunk(100_000, 200_000, false, 30));
    muxer.addChunkStruct(vid, dtsChunk(200_000, 300_000, false, 20));
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const blocks = scanBlocks(bytes);
    // Storage (file) order == DECODE order; the recovered ABSOLUTE timecodes are the PTS (not re-sorted).
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 300, 100, 200]);
    expect(blocks.map((b) => b.key)).toEqual([true, false, false, false]);
    expect(blocks.map((b) => b.size)).toEqual([50, 40, 30, 20]);
    // The single Cluster's Timecode is the minimum PTS (0), so every block's relative timecode is ≥ 0.
    expect(blocks.every((b) => b.timeMs >= 0)).toBe(true);
    // It re-demuxes as a valid WebM whose duration spans the full presentation timeline (300ms + 100ms).
    expect(parseWebm(bytes).durationSec).toBeCloseTo(0.4, 3);
  });

  it('writes a declared remux duration into the Segment Info Duration', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 1,
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    muxer.addChunkStruct(vid, {
      timestampUs: 66_667,
      durationUs: 33_333,
      key: true,
      data: new Uint8Array([1]),
      dtsUs: 0,
    });
    muxer.addChunkStruct(vid, {
      timestampUs: 1_033_333,
      durationUs: 33_333,
      key: false,
      data: new Uint8Array([2]),
      dtsUs: 33_333,
    });
    await muxer.finalize();

    expect(parseWebm(await collect(muxer.output)).durationSec).toBeCloseTo(1, 5);
  });

  it('materializes the real h264_1080p_30s MP4 packet table as a 30s WebM, not AAC padding', async () => {
    const file = await mediaTestFixture('h264_1080p_30s.mp4');
    const movie = await readMovie({
      read: (o, l) => Promise.resolve(file.subarray(o, o + l)),
      size: file.byteLength,
    });
    const video = movie.tracks.find((track) => track.mediaType === 'video');
    const audio = movie.tracks.find((track) => track.mediaType === 'audio');
    if (video === undefined || audio === undefined) {
      throw new Error('expected h264_1080p_30s.mp4 to carry one video and one audio track');
    }

    const muxer = new WebmMuxer();
    const videoTrack = muxer.addTrack({
      id: video.id,
      mediaType: 'video',
      codec: video.codec,
      durationSec: video.durationSec,
      ...(video.fps !== undefined ? { fps: video.fps } : {}),
      config: video.config,
    });
    const audioTrack = muxer.addTrack({
      id: audio.id,
      mediaType: 'audio',
      codec: audio.codec,
      durationSec: audio.durationSec,
      config: audio.config,
    });
    for (const sample of buildSamples(video)) {
      muxer.addChunkStruct(videoTrack, {
        timestampUs: sample.ptsUs,
        durationUs: sample.durationUs,
        dtsUs: sample.dtsUs,
        key: sample.keyframe,
        data: new Uint8Array([1]),
      });
    }
    for (const sample of buildSamples(audio)) {
      muxer.addChunkStruct(audioTrack, {
        timestampUs: sample.ptsUs,
        durationUs: sample.durationUs,
        dtsUs: sample.dtsUs,
        key: sample.keyframe,
        data: new Uint8Array([2]),
      });
    }
    await muxer.finalize();

    const bytes = await collect(muxer.output);
    expect(parseWebm(bytes).durationSec).toBeCloseTo(30, 6);
    expect(scanBlocks(bytes).find((block) => block.trackNumber === videoTrack)?.timeMs).toBe(0);
  });

  it('multitrack VP9 + Opus: both re-parse; Opus CodecPrivate survives; per-track blocks correct', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 25,
      config: { codec: 'vp09.00.10.08', codedWidth: 32, codedHeight: 18 },
    });
    const aud = muxer.addTrack({
      id: 2,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, description: OPUS_HEAD },
    });
    muxer.addChunkStruct(vid, chunk(0, 40_000, true, 80));
    muxer.addChunkStruct(vid, chunk(40_000, 40_000, false, 30));
    muxer.addChunkStruct(aud, chunk(0, 20_000, true, 17));
    muxer.addChunkStruct(aud, chunk(20_000, 20_000, true, 17));
    muxer.addChunkStruct(aud, chunk(40_000, 20_000, true, 17));
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const info = parseWebm(bytes);
    expect(info.tracks).toHaveLength(2);
    const v = info.tracks.find((t) => t.mediaType === 'video');
    const a = info.tracks.find((t) => t.mediaType === 'audio');
    expect(v?.codec).toBe('vp9');
    expect(v?.width).toBe(32);
    expect(v?.height).toBe(18);
    expect(a?.codec).toBe('opus');
    expect(a?.sampleRate).toBe(48_000);
    expect(a?.channels).toBe(2);

    // The audio track's CodecPrivate round-trips the OpusHead bit-exact (track number 2).
    expect(codecPrivateOf(bytes, 2)).toEqual(OPUS_HEAD);

    const blocks = scanBlocks(bytes);
    const v1 = blocks.filter((b) => b.trackNumber === 1);
    const a2 = blocks.filter((b) => b.trackNumber === 2);
    expect(v1.map((b) => b.timeMs)).toEqual([0, 40]);
    expect(v1.map((b) => b.size)).toEqual([80, 30]);
    expect(a2.map((b) => b.timeMs)).toEqual([0, 20, 40]);
    expect(a2.map((b) => b.key)).toEqual([true, true, true]);
  });

  it('B-frame reorder (decode-order PTS [0,3,1,2]): blocks carry presentation times (sorted)', async () => {
    const muxer = new WebmMuxer();
    const frame = 40_000;
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 25,
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    });
    // Arrival (decode) order I,P,B,B with presentation times 0,3,1,2 frames + distinct sizes.
    muxer.addChunkStruct(vid, chunk(0 * frame, frame, true, 50));
    muxer.addChunkStruct(vid, chunk(3 * frame, frame, false, 20));
    muxer.addChunkStruct(vid, chunk(1 * frame, frame, false, 15));
    muxer.addChunkStruct(vid, chunk(2 * frame, frame, false, 12));
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const blocks = scanBlocks(bytes);
    // WebM SimpleBlocks are written in presentation order with presentation timecodes (0,40,80,120 ms).
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 40, 80, 120]);
    // Sizes follow presentation order: PTS 0→50(key), 1f→15, 2f→12, 3f→20.
    expect(blocks.map((b) => b.size)).toEqual([50, 15, 12, 20]);
    expect(blocks.map((b) => b.key)).toEqual([true, false, false, false]);
  });

  it('long stream forces a Cluster split (int16 boundary) yet all timestamps recover exactly', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 1,
      config: { codec: 'vp09.00.10.08', codedWidth: 4, codedHeight: 4 },
    });
    // 50 frames at 1 fps = 0..49 s. With MAX_CLUSTER_REL_MS=30000 this must span ≥ 2 clusters.
    const expectedMs: number[] = [];
    for (let i = 0; i < 50; i++) {
      muxer.addChunkStruct(vid, chunk(i * 1_000_000, 1_000_000, i === 0, 8));
      expectedMs.push(i * 1000);
    }
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    // Count clusters directly (must be > 1 — proves the split actually happened).
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seg = findChild(dv, 0, dv.byteLength, ID.Segment);
    let clusterCount = 0;
    if (seg)
      for (const el of elements(dv, seg.dataStart, seg.dataEnd))
        if (el.id === ID.Cluster) clusterCount++;
    expect(clusterCount).toBeGreaterThan(1);

    const blocks = scanBlocks(bytes);
    expect(blocks).toHaveLength(50);
    expect(blocks.map((b) => b.timeMs)).toEqual(expectedMs); // every absolute time intact across clusters
  });
});

describe('WebmMuxer — typed misuse + capability misses', () => {
  const vp9 = {
    id: 1,
    mediaType: 'video' as const,
    codec: 'vp09.00.10.08',
    config: { codec: 'vp09.00.10.08', codedWidth: 4, codedHeight: 4 },
  };

  it('write to an unknown track id throws mux-error', () => {
    const muxer = new WebmMuxer();
    expect(() => muxer.addChunkStruct(99, chunk(0, 1000, true, 1))).toThrowError(
      /unknown track 99/,
    );
  });

  it('addTrack / write after finalize throws mux-error', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack(vp9);
    muxer.addChunkStruct(vid, chunk(0, 1000, true, 2));
    await muxer.finalize();
    expect(() => muxer.addTrack(vp9)).toThrowError(/already finalized/);
    expect(() => muxer.addChunkStruct(vid, chunk(1000, 1000, false, 2))).toThrowError(
      /already finalized/,
    );
  });

  it('a second finalize throws mux-error', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack(vp9);
    muxer.addChunkStruct(vid, chunk(0, 1000, true, 2));
    await muxer.finalize();
    await expect(muxer.finalize()).rejects.toThrowError(/already finalized/);
  });

  it('finalize with zero tracks rejects and errors the output stream', async () => {
    const muxer = new WebmMuxer();
    await expect(muxer.finalize()).rejects.toThrowError(/no tracks/);
    await expect(collect(muxer.output)).rejects.toThrowError(/no tracks/);
  });

  it('finalize with a track that received no packets rejects', async () => {
    const muxer = new WebmMuxer();
    muxer.addTrack(vp9);
    await expect(muxer.finalize()).rejects.toThrowError(/received no packets/);
  });

  it('an unsupported codec is a typed capability miss at addTrack', () => {
    const muxer = new WebmMuxer();
    expect(() =>
      muxer.addTrack({ id: 1, mediaType: 'video', codec: 'theora', config: { codec: 'theora' } }),
    ).toThrowError(/cannot write video codec 'theora'/);
    expect(() =>
      muxer.addTrack({ id: 1, mediaType: 'video', codec: 'theora', config: { codec: 'theora' } }),
    ).toThrow(CapabilityError);
  });

  it('fragmented mux constructs (streamable WebM, ADR-091) — not a capability miss', () => {
    // Fragmented/CMAF WebM output IS supported (streaming init segment + live Clusters); constructing the
    // muxer with `{ fragmented: true }` must succeed rather than throw the old capability miss.
    expect(() => new WebmMuxer({ fragmented: true })).not.toThrow();
  });
});

describe('WebmDriver.createMuxer — wired to WebmMuxer', () => {
  it('returns a WebmMuxer whose output round-trips (the real write() copyTo path is browser-only)', async () => {
    const muxer = WebmDriver.createMuxer();
    expect(muxer).toBeInstanceOf(WebmMuxer);
    if (muxer instanceof WebmMuxer) {
      const vid = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        fps: 24,
        config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      });
      muxer.addChunkStruct(vid, chunk(0, 41_667, true, 100));
      muxer.addChunkStruct(vid, chunk(41_667, 41_667, false, 25));
    }
    await muxer.finalize();
    const info = parseWebm(await collect(muxer.output));
    expect(info.tracks[0]?.codec).toBe('vp9');
    expect(info.tracks[0]?.width).toBe(16);
  });

  it('uses the Matroska DocType for mkv targets', async () => {
    const muxer = WebmDriver.createMuxer({ container: 'mkv' });
    expect(muxer).toBeInstanceOf(WebmMuxer);
    if (muxer instanceof WebmMuxer) {
      const vid = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        fps: 24,
        config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      });
      muxer.addChunkStruct(vid, chunk(0, 41_667, true, 100));
    }
    await muxer.finalize();

    expect(parseWebm(await collect(muxer.output)).container).toBe('mkv');
  });

  it('createMuxer({ fragmented: true }) reaches the streaming Cluster path (driver wiring)', async () => {
    const muxer = WebmDriver.createMuxer({ fragmented: true });
    expect(muxer).toBeInstanceOf(WebmMuxer);
    if (muxer instanceof WebmMuxer) {
      const vid = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        fps: 30,
        config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      });
      for (let i = 0; i < 6; i++)
        muxer.addChunkStruct(vid, chunk(i * 33_333, 33_333, i % 3 === 0, 20));
    }
    await muxer.finalize();
    const parts = await collectChunks(muxer.output);
    // The driver-created muxer honours the streaming layout: an init chunk + ≥2 live Cluster chunks.
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const bytes = concatBytes(parts);
    expect(segmentSizeValue(bytes)).toBe(-1); // unknown-size Segment (streaming)
    expect(parseWebm(bytes).tracks[0]?.codec).toBe('vp9');
  });

  it('mkv + fragmented streams a Matroska DocType init segment then Clusters', async () => {
    const muxer = WebmDriver.createMuxer({ container: 'mkv', fragmented: true });
    expect(muxer).toBeInstanceOf(WebmMuxer);
    if (muxer instanceof WebmMuxer) {
      const vid = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec: 'vp09.00.10.08',
        fps: 30,
        config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      });
      muxer.addChunkStruct(vid, chunk(0, 33_333, true, 20));
      muxer.addChunkStruct(vid, chunk(33_333, 33_333, true, 20)); // second keyframe → second fragment
    }
    await muxer.finalize();
    const parts = await collectChunks(muxer.output);
    expect(parts.length).toBe(3); // init + 2 clusters
    const bytes = concatBytes(parts);
    expect(parseWebm(bytes).container).toBe('mkv');
    expect(segmentSizeValue(bytes)).toBe(-1);
  });

  it('rejects a MediaError (not throwing strings) is impossible here — sanity that errors are typed', () => {
    const muxer = new WebmMuxer();
    try {
      muxer.addChunkStruct(1, chunk(0, 1, true, 1));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
    }
  });
});

/** Read a TrackEntry's CodecID (0x86) ASCII string, located by TrackNumber — independent of the writer. */
function codecIdOf(bytes: Uint8Array, trackNumber: number): string | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) return undefined;
  const tracks = findChild(dv, segment.dataStart, segment.dataEnd, ID.Tracks);
  if (!tracks) return undefined;
  for (const te of elements(dv, tracks.dataStart, tracks.dataEnd)) {
    if (te.id !== ID.TrackEntry) continue;
    const num = findChild(dv, te.dataStart, te.dataEnd, ID.TrackNumber);
    if (!num || readUint(dv, num) !== trackNumber) continue;
    const cid = findChild(dv, te.dataStart, te.dataEnd, ID.CodecID);
    if (!cid) return undefined;
    let s = '';
    for (let i = cid.dataStart; i < cid.dataEnd; i++) s += String.fromCharCode(dv.getUint8(i));
    return s;
  }
  return undefined;
}

describe('WebmMuxer — CodecID mapping (every supported codec → its Matroska CodecID)', () => {
  const VIDEO: ReadonlyArray<[string, string]> = [
    ['vp8', 'V_VP8'],
    ['vp09.00.10.08', 'V_VP9'],
    ['av01.0.04M.08', 'V_AV1'],
    ['avc1.42E01E', 'V_MPEG4/ISO/AVC'],
    ['hvc1.1.6.L93.B0', 'V_MPEGH/ISO/HEVC'],
  ];
  const AUDIO: ReadonlyArray<[string, string]> = [
    ['opus', 'A_OPUS'],
    ['vorbis', 'A_VORBIS'],
    ['mp4a.40.2', 'A_AAC'],
    ['flac', 'A_FLAC'],
    ['mp3', 'A_MPEG/L3'],
  ];

  for (const [codec, codecId] of VIDEO) {
    it(`video '${codec}' → ${codecId}`, async () => {
      const muxer = new WebmMuxer();
      const vid = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec,
        config: { codec, codedWidth: 8, codedHeight: 8 }, // no description ⇒ no CodecPrivate path
      });
      muxer.addChunkStruct(vid, chunk(0, 33_333, true, 16));
      await muxer.finalize();
      expect(codecIdOf(await collect(muxer.output), 1)).toBe(codecId);
    });
  }

  for (const [codec, codecId] of AUDIO) {
    it(`audio '${codec}' → ${codecId}`, async () => {
      const muxer = new WebmMuxer();
      const aud = muxer.addTrack({
        id: 1,
        mediaType: 'audio',
        codec,
        config: { codec, sampleRate: 48_000, numberOfChannels: 2 },
      });
      muxer.addChunkStruct(aud, chunk(0, 20_000, true, 32));
      await muxer.finalize();
      expect(codecIdOf(await collect(muxer.output), 1)).toBe(codecId);
    });
  }
});

describe('WebmMuxer — track-entry edge cases', () => {
  it('a video track WITHOUT fps omits DefaultDuration but still round-trips', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08', // no `fps` field → the DefaultDuration branch is skipped
      config: { codec: 'vp09.00.10.08', codedWidth: 20, codedHeight: 10 },
    });
    muxer.addChunkStruct(vid, chunk(0, 40_000, true, 24));
    muxer.addChunkStruct(vid, chunk(40_000, 40_000, false, 12));
    await muxer.finalize();
    const info = parseWebm(await collect(muxer.output));
    expect(info.tracks[0]?.codec).toBe('vp9');
    expect(info.tracks[0]?.width).toBe(20);
    expect(info.tracks[0]?.height).toBe(10);
  });

  it('accepts a description supplied as a raw ArrayBuffer (not a typed-array view)', async () => {
    const muxer = new WebmMuxer();
    const buf = OPUS_HEAD.slice().buffer; // a bare ArrayBuffer description
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, description: buf },
    });
    muxer.addChunkStruct(aud, chunk(0, 20_000, true, 16));
    await muxer.finalize();
    expect(codecPrivateOf(await collect(muxer.output), 1)).toEqual(OPUS_HEAD);
  });

  it('an unsupported AUDIO codec is a typed capability miss at addTrack', () => {
    const muxer = new WebmMuxer();
    expect(() =>
      muxer.addTrack({ id: 1, mediaType: 'audio', codec: 'speex', config: { codec: 'speex' } }),
    ).toThrow(CapabilityError);
  });

  it('a video track with no coded dimensions writes 0×0 geometry (the ?? 0 fallbacks)', async () => {
    const muxer = new WebmMuxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp8',
      config: { codec: 'vp8' },
    });
    muxer.addChunkStruct(vid, chunk(0, 33_333, true, 8));
    await muxer.finalize();
    const info = parseWebm(await collect(muxer.output));
    expect(info.tracks[0]?.codec).toBe('vp8');
    expect(info.tracks[0]?.width ?? 0).toBe(0);
    expect(info.tracks[0]?.height ?? 0).toBe(0);
  });

  it('an audio track with no sampleRate/channels writes 0 defaults', async () => {
    const muxer = new WebmMuxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus' },
    });
    muxer.addChunkStruct(aud, chunk(0, 20_000, true, 16));
    await muxer.finalize();
    const info = parseWebm(await collect(muxer.output));
    expect(info.tracks[0]?.codec).toBe('opus');
    expect(info.tracks[0]?.sampleRate ?? 0).toBe(0);
  });

  it('an empty (zero-byte) description writes no CodecPrivate element', async () => {
    const muxer = new WebmMuxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: {
        codec: 'opus',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: new Uint8Array(0),
      },
    });
    muxer.addChunkStruct(aud, chunk(0, 20_000, true, 16));
    await muxer.finalize();
    // A zero-length description ⇒ the CodecPrivate branch is skipped (no element emitted).
    expect(codecPrivateOf(await collect(muxer.output), 1)).toBeUndefined();
  });
});

// ── fragmented / CMAF WebM mux (streaming output, ADR-091) ────────────────────────────────────────

/**
 * Collect a stream into the **ordered list of chunks** (not concatenated), so a test can assert the
 * streaming-output contract: bytes arrive progressively (an init chunk, then one chunk per Cluster) rather
 * than as one final blob. Each entry is exactly what the producer enqueued.
 */
async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** The Segment element's size vint as decoded by the reader: `-1` ⇒ unknown size (the streaming form). */
function segmentSizeValue(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk top level to find the Segment ID, then read the size vint right after it.
  for (const el of elements(dv, 0, dv.byteLength)) {
    if (el.id !== ID.Segment) continue;
    // el.dataStart is past ID+size; recompute the size vint position by reading the ID width at the Segment.
    // Find the Segment ID offset by scanning for the 4-byte ID 0x18538067.
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

/** Count the **top-level** Clusters (siblings of Info/Tracks inside the Segment). */
function topLevelClusterCount(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(dv, 0, dv.byteLength, ID.Segment);
  if (!segment) return 0;
  let count = 0;
  for (const el of elements(dv, segment.dataStart, segment.dataEnd)) {
    if (el.id === ID.Cluster) count++;
  }
  return count;
}

const FFPROBE = 'ffprobe';

/** Whether ffprobe is on PATH (the reference-reimport oracle is skipped, loudly, when it is not). */
function ffprobeAvailable(): boolean {
  try {
    return spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  nb_read_packets?: string;
}

/** Run ffprobe over a file and return its parsed streams (codec name/type + read-packet count). */
function ffprobeStreams(path: string): FfprobeStream[] {
  const res = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=index,codec_name,codec_type,nb_read_packets',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`ffprobe failed on ${path}: ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout) as { streams?: FfprobeStream[] };
  return parsed.streams ?? [];
}

/** The WebCodecs config for a demuxed track (carries CodecPrivate as `description` where present). */
function configFor(track: {
  mediaType: 'video' | 'audio';
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  description?: Uint8Array;
}): VideoDecoderConfig | AudioDecoderConfig {
  if (track.mediaType === 'video') {
    return {
      codec: track.codec,
      codedWidth: track.width ?? 0,
      codedHeight: track.height ?? 0,
      ...(track.description !== undefined ? { description: track.description } : {}),
    };
  }
  return {
    codec: track.codec,
    sampleRate: track.sampleRate ?? 48_000,
    numberOfChannels: track.channels ?? 2,
    ...(track.description !== undefined ? { description: track.description } : {}),
  };
}

/** A WebCodecs codec string the WebM muxer can write (skip theora/PCM tracks that have no CodecID). */
function muxableCodecString(codec: string): string | undefined {
  switch (codec) {
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return 'vp09.00.10.08';
    case 'av1':
      return 'av01.0.04M.08';
    case 'h264':
      return 'avc1.42E01E';
    case 'hevc':
      return 'hvc1.1.6.L93.B0';
    case 'opus':
      return 'opus';
    case 'vorbis':
      return 'vorbis';
    case 'aac':
      return 'mp4a.40.2';
    case 'flac':
      return 'flac';
    case 'mp3':
      return 'mp3';
    default:
      return undefined; // e.g. v_theora / pcm-s16 — not a WebM-muxable codec
  }
}

describe('WebmMuxer — fragmented/CMAF streaming output (synthesized)', () => {
  it('emits a streamable WebM: separate init chunk + ≥2 Cluster chunks, unknown-size Segment', async () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
    });
    // Two GOPs (keyframe at 0 and at frame 4) → the second keyframe forces a new fragment/Cluster.
    const frames: ChunkStruct[] = [];
    for (let i = 0; i < 8; i++) {
      frames.push(chunk(i * 33_333, 33_333, i % 4 === 0, 20 + i));
    }
    for (const c of frames) muxer.addChunkStruct(vid, c);
    await muxer.finalize();

    const parts = await collectChunks(muxer.output);
    // Streaming-output contract: more than one enqueue — an init segment then ≥1 Cluster, never one blob.
    expect(parts.length).toBeGreaterThanOrEqual(3); // init + ≥2 clusters
    const bytes = concatBytes(parts);

    // The first chunk is the init segment: EBML magic + an unknown-size Segment header (NO Cluster yet).
    const init = parts[0];
    expect(init).toBeDefined();
    if (!init) return;
    expect([...init.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(topLevelClusterCount(init)).toBe(0); // init carries Info+Tracks only
    // Every subsequent chunk is exactly one top-level Cluster.
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      expect(part).toBeDefined();
      if (!part) continue;
      // A Cluster chunk begins with the Cluster ID 0x1F43B675.
      expect([...part.subarray(0, 4)]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    }

    // The whole stream is a valid streamable WebM: unknown-size Segment + ≥2 Clusters, re-demuxable.
    expect(segmentSizeValue(bytes)).toBe(-1); // unknown size (streaming)
    expect(topLevelClusterCount(bytes)).toBeGreaterThanOrEqual(2);

    // The blocks reconstruct via the independent low-level scan: count/time/key/size all intact.
    const blocks = scanBlocks(bytes);
    expect(blocks.map((b) => b.timeMs)).toEqual(
      frames.map((_, i) => Math.round((i * 33_333) / 1000)),
    );
    expect(blocks.map((b) => b.key)).toEqual(frames.map((_, i) => i % 4 === 0));
    expect(blocks.map((b) => b.size)).toEqual(frames.map((_, i) => 20 + i));

    // It re-demuxes as a WebM whose track metadata is intact.
    const info = parseWebm(bytes);
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]?.codec).toBe('vp9');
    expect(info.tracks[0]?.width).toBe(64);
  });

  it('every fragment after the first begins at a video keyframe (the CMAF decodable-segment rule)', () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    });
    // 3 GOPs of 3 frames each (keyframes at 0,3,6).
    const isKey = (i: number): boolean => i % 3 === 0;
    for (let i = 0; i < 9; i++) muxer.addChunkStruct(vid, chunk(i * 33_333, 33_333, isKey(i), 10));

    // Drive the pure planner directly via the muxer's serialization, then re-scan per Cluster.
    return (async (): Promise<void> => {
      await muxer.finalize();
      const parts = await collectChunks(muxer.output);
      // First chunk is init; each later chunk is one Cluster. Its FIRST SimpleBlock must be a keyframe.
      const clusters = parts.slice(1);
      expect(clusters.length).toBe(3); // one per GOP
      for (const cl of clusters) {
        const first = scanBlocks(concatWithSegmentShell(cl))[0];
        expect(first?.key).toBe(true);
      }
    })();
  });

  it('audio-only (no keyframe boundaries) splits by the per-fragment block cap', async () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, description: OPUS_HEAD },
    });
    // 200 audio frames @ 20ms — every Opus frame is a keyframe, so only the cap can split fragments.
    const N = 200;
    for (let i = 0; i < N; i++) muxer.addChunkStruct(aud, chunk(i * 20_000, 20_000, true, 17));
    await muxer.finalize();

    const parts = await collectChunks(muxer.output);
    expect(parts.length).toBeGreaterThanOrEqual(3); // init + ≥2 clusters (cap forced a split)
    const bytes = concatBytes(parts);
    expect(topLevelClusterCount(bytes)).toBeGreaterThanOrEqual(2);
    const blocks = scanBlocks(bytes);
    expect(blocks).toHaveLength(N);
    expect(blocks.map((b) => b.timeMs)).toEqual(Array.from({ length: N }, (_, i) => i * 20));
  });

  it('a single short fragment still yields a valid stream (init + exactly one Cluster)', async () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    });
    muxer.addChunkStruct(vid, chunk(0, 33_333, true, 12));
    muxer.addChunkStruct(vid, chunk(33_333, 33_333, false, 8));
    await muxer.finalize();

    const parts = await collectChunks(muxer.output);
    expect(parts.length).toBe(2); // init + one Cluster
    const bytes = concatBytes(parts);
    expect(segmentSizeValue(bytes)).toBe(-1);
    expect(topLevelClusterCount(bytes)).toBe(1);
    expect(scanBlocks(bytes).map((b) => b.size)).toEqual([12, 8]);
  });

  it('B-frame fragmented remux keeps decode order within Clusters, PTS timecodes intact', async () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    });
    const dtsChunk = (pts: number, dts: number, key: boolean, n: number): ChunkStruct => ({
      timestampUs: pts,
      durationUs: 100_000,
      key,
      data: new Uint8Array(n).fill(key ? 0x6b : 0x42),
      dtsUs: dts,
    });
    // Two GOPs, each I,P,B,B in decode order with reordered PTS.
    muxer.addChunkStruct(vid, dtsChunk(0, 0, true, 50));
    muxer.addChunkStruct(vid, dtsChunk(300_000, 100_000, false, 40));
    muxer.addChunkStruct(vid, dtsChunk(100_000, 200_000, false, 30));
    muxer.addChunkStruct(vid, dtsChunk(200_000, 300_000, false, 20));
    muxer.addChunkStruct(vid, dtsChunk(400_000, 400_000, true, 48));
    muxer.addChunkStruct(vid, dtsChunk(500_000, 500_000, false, 22));
    await muxer.finalize();

    const bytes = concatBytes(await collectChunks(muxer.output));
    const blocks = scanBlocks(bytes);
    // File (decode) order preserved; PTS timecodes recovered (cluster-relative), all relative ≥ 0.
    expect(blocks.map((b) => b.timeMs)).toEqual([0, 300, 100, 200, 400, 500]);
    expect(blocks.map((b) => b.key)).toEqual([true, false, false, false, true, false]);
    expect(topLevelClusterCount(bytes)).toBe(2); // the second keyframe started a new fragment
  });
});

/** Wrap a bare Cluster chunk in a minimal Segment shell so {@link scanBlocks} can walk it standalone. */
function concatWithSegmentShell(cluster: Uint8Array): Uint8Array {
  // Segment ID (4) + 1-byte unknown size (0xFF) + the cluster bytes. scanBlocks finds the Segment then
  // iterates its children, so a single Cluster is enough to recover its blocks for a per-fragment assert.
  const shell = new Uint8Array(5 + cluster.byteLength);
  shell.set([0x18, 0x53, 0x80, 0x67, 0xff], 0);
  shell.set(cluster, 5);
  return shell;
}

describe('planWebmFragments — decode-ordered partitioning (pure)', () => {
  const blk = (trackNumber: number, ms: number, key: boolean): TimelineBlock => ({
    trackNumber,
    timeMs: ms,
    dtsMs: ms,
    key,
    data: new Uint8Array([1]),
  });

  it('splits at each video keyframe (every fragment after the first is decodable)', () => {
    const blocks = [
      blk(1, 0, true),
      blk(1, 33, false),
      blk(1, 67, false),
      blk(1, 100, true), // new GOP → new fragment
      blk(1, 133, false),
    ];
    const ranges = planWebmFragments(blocks, new Set([1]));
    expect(ranges).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it('does NOT split on an audio sync frame (else every audio packet would be its own Cluster)', () => {
    // Track 2 is audio (not in the video-key set); every block is a sync frame but stays one fragment.
    const blocks = Array.from({ length: 5 }, (_, i) => blk(2, i * 20, true));
    const ranges = planWebmFragments(blocks, new Set([1]));
    expect(ranges).toEqual([{ start: 0, end: 5 }]);
  });

  it('forces a new fragment once the per-fragment block cap is hit (keyframe-sparse / audio-only)', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => blk(2, i * 20, true));
    const ranges = planWebmFragments(blocks, new Set([1]), { maxBlocksPerFragment: 2 });
    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it('splits before the PTS span would overflow the int16 SimpleBlock relative timecode', () => {
    // Two blocks 40 s apart (> MAX_CLUSTER_REL_MS 30 s) cannot share a Cluster.
    const blocks = [blk(2, 0, true), blk(2, 40_000, true)];
    const ranges = planWebmFragments(blocks, new Set([1]), { maxBlocksPerFragment: 1000 });
    expect(ranges).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it('covers every block exactly once across all split reasons (no drop/dup)', () => {
    const blocks: TimelineBlock[] = [];
    for (let i = 0; i < 31; i++) blocks.push(blk(1, i * 100, i % 7 === 0));
    const ranges = planWebmFragments(blocks, new Set([1]), { maxBlocksPerFragment: 4 });
    const covered = ranges.flatMap((r) =>
      Array.from({ length: r.end - r.start }, (_, k) => r.start + k),
    );
    expect(covered).toEqual(Array.from({ length: 31 }, (_, i) => i)); // contiguous 0..30
    // Ranges are contiguous (each starts where the previous ended).
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]?.start).toBe(ranges[i - 1]?.end);
    }
  });

  it('empty input → no fragments', () => {
    expect(planWebmFragments([], new Set([1]))).toEqual([]);
  });
});

// ── incremental write through a StreamTarget-style positioned-write sink ───────────────────────────

/** Build the fixed, deterministic golden fragmented stream (the same input the committed golden pins). */
function goldenFragmentedMuxer(): WebmMuxer {
  const muxer = new WebmMuxer({ fragmented: true });
  const vid = muxer.addTrack({
    id: 1,
    mediaType: 'video',
    codec: 'vp09.00.10.08',
    fps: 30,
    config: { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 48 },
  });
  // 8 frames, 2 GOPs (keyframes at 0 and 4); frame i is fully determined: ts=i·33333µs, size=20+i.
  for (let i = 0; i < 8; i++) {
    muxer.addChunkStruct(vid, {
      timestampUs: i * 33_333,
      durationUs: 33_333,
      key: i % 4 === 0,
      data: new Uint8Array(20 + i).fill(i % 4 === 0 ? 0x6b : 0x42),
    });
  }
  return muxer;
}

describe('WebmMuxer — fragmented output drives a StreamTarget incrementally (positioned writes)', () => {
  it('emits multiple monotonic, contiguous positioned writes whose assembly equals the stream', async () => {
    const muxer = new WebmMuxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      fps: 30,
      config: { codec: 'vp09.00.10.08', codedWidth: 32, codedHeight: 24 },
    });
    // 4 GOPs → an init segment then 4 Clusters: more than one write must reach the sink.
    for (let i = 0; i < 12; i++)
      muxer.addChunkStruct(vid, chunk(i * 33_333, 33_333, i % 3 === 0, 10 + i));
    await muxer.finalize();

    // The StreamTarget positioned-write callback: each call receives (chunk, position) with chunks in
    // order, contiguous, starting at 0 (the doc-09 streaming-output sink contract). Record every write.
    const writes: { position: number; bytes: Uint8Array }[] = [];
    const result = await writeToStreamTarget(
      {
        kind: 'stream-target',
        destination: (b, position) => void writes.push({ position, bytes: b.slice() }),
      },
      muxer.output,
    );
    expect(result).toBeUndefined(); // a target sink returns no value (it wrote to the destination)

    // Streaming, not one blob: an init write plus ≥2 cluster writes (this input has 4 fragments).
    expect(writes.length).toBeGreaterThanOrEqual(3);

    // Positions are strictly monotonic and exactly contiguous (position N = sum of all prior byte lengths).
    let expectedPos = 0;
    for (const w of writes) {
      expect(w.position).toBe(expectedPos);
      expect(w.bytes.byteLength).toBeGreaterThan(0);
      expectedPos += w.bytes.byteLength;
    }

    // The first write is the init segment (EBML magic, no Cluster); each later write is exactly one Cluster.
    const first = writes[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect([...first.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(topLevelClusterCount(first.bytes)).toBe(0);
    for (let i = 1; i < writes.length; i++) {
      expect([...(writes[i]?.bytes.subarray(0, 4) ?? [])]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    }

    // Assembling the positioned writes byte-for-byte reproduces a valid, complete fragmented WebM whose
    // blocks all survive — i.e. the streamed bytes ARE the output (no buffering, no reordering, no loss).
    const assembled = new Uint8Array(expectedPos);
    for (const w of writes) assembled.set(w.bytes, w.position);
    expect(segmentSizeValue(assembled)).toBe(-1);
    expect(topLevelClusterCount(assembled)).toBe(writes.length - 1);
    expect(scanBlocks(assembled)).toHaveLength(12);
    expect(scanBlocks(assembled).map((b) => b.size)).toEqual(
      Array.from({ length: 12 }, (_, i) => 10 + i),
    );
  });

  it('applies backpressure: an async sink that awaits still receives every chunk in order', async () => {
    const muxer = goldenFragmentedMuxer();
    await muxer.finalize();

    const order: number[] = [];
    let n = 0;
    await writeToStreamTarget(
      {
        kind: 'stream-target',
        destination: async (_b, position) => {
          // Yield a macrotask each write; the producer must wait (the callback's promise is the backpressure).
          await new Promise((r) => setTimeout(r, 0));
          order.push(position);
          n++;
        },
      },
      muxer.output,
    );
    expect(n).toBe(3); // init + 2 clusters (the golden input)
    // Positions arrive strictly increasing despite the awaited sink (in-order, contiguous delivery).
    for (let i = 1; i < order.length; i++) expect(order[i] ?? 0).toBeGreaterThan(order[i - 1] ?? 0);
  });
});

// ── committed byte-exact golden + the oracle's can-fail proof ──────────────────────────────────────

interface FragmentedGolden {
  chunkCount: number;
  chunkSizes: number[];
  totalBytes: number;
  sha256: string;
  chunkSha256: string[];
}

const GOLDEN_DIR = new URL('../../../fixtures/golden/', import.meta.url).pathname;

async function loadFragmentedGolden(): Promise<FragmentedGolden> {
  return JSON.parse(
    await readFile(`${GOLDEN_DIR}mux/webm-fragmented.json`, 'utf8'),
  ) as FragmentedGolden;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('WebmMuxer — fragmented WebM byte-exact golden', () => {
  it('a fixed synthesized input serializes to the committed canonical bytes (sha256 + per-chunk)', async () => {
    const muxer = goldenFragmentedMuxer();
    await muxer.finalize();
    const parts = await collectChunks(muxer.output);
    const bytes = concatBytes(parts);

    const golden = await loadFragmentedGolden();
    // Chunk shape: an init segment + one Cluster per GOP, the exact sizes the golden pins.
    expect(parts.length).toBe(golden.chunkCount);
    expect(parts.map((p) => p.byteLength)).toEqual(golden.chunkSizes);
    expect(bytes.byteLength).toBe(golden.totalBytes);
    // Byte-exact: the whole stream and every individual chunk hash to the committed digests.
    expect(sha256Hex(bytes)).toBe(golden.sha256);
    expect(parts.map((p) => sha256Hex(p))).toEqual(golden.chunkSha256);
  });
});

describe('WebmMuxer — fragmented reference-reimport oracle rejects a WRONG output (can-fail proof)', () => {
  const haveFfprobe = ffprobeAvailable();

  it('dropping one Cluster changes the ffprobe packet count, so the reimport assertion would fail', async () => {
    if (!haveFfprobe) {
      console.warn('[ebml-write.test] ffprobe not found — skipping the can-fail reimport proof');
      return;
    }
    // A real source → fragmented re-mux → drop the LAST Cluster chunk → re-probe. The correct (full)
    // output reports the source frame count; the mutated one must report FEWER — proving the oracle in
    // the corpus suite above can actually fail on a lossy mux (it is not a tautology). `white.webm` is a
    // long vp8 clip (300 frames across 5 GOPs ⇒ 5 Clusters), so there is always a Cluster to drop.
    const demux = demuxWebm(await loadFixture('white.webm'));
    const frames = demux.framesByIndex[0];
    const track = demux.info.tracks[0];
    expect(track).toBeDefined();
    expect(frames).toBeDefined();
    if (!track || !frames) return;

    const muxer = new WebmMuxer({ fragmented: true });
    const trackId = muxer.addTrack({
      id: track.trackNumber ?? 1,
      mediaType: track.mediaType,
      codec: 'vp8',
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      config: configFor({ ...track, codec: 'vp8' }),
    });
    for (const frame of frames) {
      muxer.addChunkStruct(trackId, {
        timestampUs: frame.timestampUs,
        durationUs: undefined,
        key: frame.keyframe,
        data: frame.data,
      });
    }
    await muxer.finalize();
    const parts = await collectChunks(muxer.output);
    expect(parts.length).toBeGreaterThanOrEqual(3); // init + ≥2 clusters → there IS a cluster to drop

    const full = concatBytes(parts);
    const mutated = concatBytes(parts.slice(0, -1)); // identical init + Clusters, MINUS the final Cluster

    const dir = mkdtempSync(join(tmpdir(), 'aibrush-webm-canfail-'));
    try {
      const fullPath = join(dir, 'full.webm');
      const mutatedPath = join(dir, 'mutated.webm');
      writeFileSync(fullPath, full);
      writeFileSync(mutatedPath, mutated);

      const fullCount = Number(ffprobeStreams(fullPath)[0]?.nb_read_packets ?? '0');
      const mutatedCount = Number(ffprobeStreams(mutatedPath)[0]?.nb_read_packets ?? '0');

      expect(fullCount).toBe(frames.length); // the honest output matches the source exactly
      expect(mutatedCount).toBeLessThan(fullCount); // the dropped Cluster is observable → oracle can fail
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WebmMuxer — fragmented remux of real WebM corpus (reference-reimport oracle)', () => {
  // Diverse real WebM: vp9+opus, vp8 (long, multi-GOP), vp9-alpha, opus audio-only, tiny vp8+opus,
  // headerless recorder output. bear-multitrack carries a theora + PCM track too — those are not
  // WebM-muxable codecs, so this oracle re-muxes only that file's WebM-native tracks (vp8 + vorbis).
  const CORPUS = [
    'movie_5.webm',
    'white.webm',
    'bear-vp9-alpha.webm',
    'bear-opus.webm',
    '2x2-green.webm',
    'recorder_headerless.webm',
    'bear-multitrack.webm',
  ] as const;

  const haveFfprobe = ffprobeAvailable();

  for (const id of CORPUS) {
    it(`${id}: demux → fragmented re-mux → ffprobe matches tracks/codecs/frame counts`, async () => {
      if (!haveFfprobe) {
        // The corpus oracle's structural assertions still run without ffprobe; only the reimport is gated.
        console.warn(`[ebml-write.test] ffprobe not found — running structure-only for ${id}`);
      }
      const sourceBytes = await loadFixture(id);
      const demux = demuxWebm(sourceBytes);

      // Project each WebM-muxable track + its decoded frames into the muxer (skip theora/PCM tracks).
      const muxer = new WebmMuxer({ fragmented: true });
      const muxed: { codec: string; mediaType: 'video' | 'audio'; frames: WebmFrame[] }[] = [];
      demux.info.tracks.forEach((track, index) => {
        const codecString = muxableCodecString(track.codec);
        const frames = demux.framesByIndex[index];
        if (codecString === undefined || frames === undefined || frames.length === 0) return;
        const trackId = muxer.addTrack({
          id: track.trackNumber ?? index + 1,
          mediaType: track.mediaType,
          codec: codecString,
          ...(track.fps !== undefined ? { fps: track.fps } : {}),
          config: configFor({ ...track, codec: codecString }),
        });
        for (const frame of frames) {
          muxer.addChunkStruct(trackId, {
            timestampUs: frame.timestampUs,
            durationUs: undefined,
            key: frame.keyframe,
            data: frame.data,
          });
        }
        muxed.push({ codec: track.codec, mediaType: track.mediaType, frames: [...frames] });
      });
      expect(muxed.length).toBeGreaterThan(0);

      await muxer.finalize();
      const parts = await collectChunks(muxer.output);

      // (a) Streamable structure: init chunk separate from the live Clusters; ≥2 Clusters as separate
      //     chunks for any file with >1 fragment; unknown-size Segment throughout.
      expect(parts.length).toBeGreaterThanOrEqual(2); // init + ≥1 cluster
      const out = concatBytes(parts);
      expect([...out.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(segmentSizeValue(out)).toBe(-1);
      const clusterCount = topLevelClusterCount(out);
      expect(clusterCount).toBe(parts.length - 1); // each non-init chunk is exactly one Cluster
      expect(clusterCount).toBeGreaterThanOrEqual(1);

      // (b) Block-faithful via the independent scan: total block count == total muxed frame count, and
      //     per-track block counts match (proves no drop/dup across fragment boundaries).
      const blocks = scanBlocks(out);
      const totalFrames = muxed.reduce((sum, t) => sum + t.frames.length, 0);
      expect(blocks.length).toBe(totalFrames);

      // (c) Reference reimport: ffprobe must read the SAME track count + codecs + per-stream packet count.
      if (haveFfprobe) {
        const dir = mkdtempSync(join(tmpdir(), 'aibrush-webm-frag-'));
        const path = join(dir, `${id}.frag.webm`);
        try {
          writeFileSync(path, out);
          const streams = ffprobeStreams(path);
          // Same number of tracks ffmpeg can see as we muxed.
          expect(streams.length).toBe(muxed.length);
          // Codecs (order-independent multiset) match what we muxed.
          const probedCodecs = streams.map((s) => s.codec_name).sort();
          const expectedCodecs = muxed.map((t) => t.codec).sort();
          expect(probedCodecs).toEqual(expectedCodecs);
          // Per-codec packet counts match the per-track frame counts (multiset by codec).
          const probedByCodec = new Map<string, number>();
          for (const s of streams) {
            const c = s.codec_name ?? '?';
            probedByCodec.set(c, (probedByCodec.get(c) ?? 0) + Number(s.nb_read_packets ?? '0'));
          }
          const expectedByCodec = new Map<string, number>();
          for (const t of muxed) {
            expectedByCodec.set(t.codec, (expectedByCodec.get(t.codec) ?? 0) + t.frames.length);
          }
          for (const [codec, expected] of expectedByCodec) {
            expect(probedByCodec.get(codec)).toBe(expected);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
});
