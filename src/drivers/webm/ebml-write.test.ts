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

import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type ChunkStruct, WebmMuxer, buildBlockTimeline } from './ebml-write.ts';
import { type EbmlElement, elements, findChild, readUint, readVint } from './ebml.ts';
import { WebmDriver, parseWebm } from './webm-driver.ts';

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

  it('fragmented mux is a typed capability miss at construction', () => {
    expect(() => new WebmMuxer({ fragmented: true })).toThrowError(/fragmented/);
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
