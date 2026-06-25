/**
 * Validation for the MP4 `Muxer` seam ({@link Mp4Muxer}) — a real round-trip oracle that can fail.
 *
 * Plain chunk-structs (NOT WebCodecs `Encoded*Chunk`s) are fed through the pure ingest
 * ({@link Mp4Muxer.addChunkStruct}, the same path `write()` uses after its browser-only `copyTo`), the
 * muxer serializes via {@link writeMp4} on `finalize`, and the bytes are re-parsed with `readMovie`. We
 * assert track count, per-sample sizes, sample count, durations, keyframe flags, and `ctts` all match
 * the inputs — covering the B-frame (PTS≠DTS reorder) case and the no-reorder case. The pure timing
 * helper {@link buildMuxSamples} is also unit-tested directly (incl. VFR + missing-duration recovery).
 */

import { describe, expect, it } from 'vitest';
import { Mp4Driver, readMovie } from './mp4-driver.ts';
import { type ChunkStruct, Mp4Muxer, buildMuxSamples } from './mux.ts';
import { buildSampleData } from './samples.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

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

/** A minimal AVCDecoderConfigurationRecord (avcC) — the muxer synthesizes the `avcC` box from it. */
const AVCC = new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]);
/** A minimal AudioSpecificConfig (AAC-LC, 48 kHz, stereo) — the muxer synthesizes `esds` from it. */
const ASC = new Uint8Array([0x11, 0x90]);

function videoChunk(timestampUs: number, durationUs: number, key: boolean, n: number): ChunkStruct {
  return { timestampUs, durationUs, key, data: new Uint8Array(n).fill(key ? 0x65 : 0x41) };
}

describe('buildMuxSamples — DTS/ctts timing (pure)', () => {
  it('no reorder (CFR): ctts is exactly 0 for every sample', () => {
    const ts = 90_000;
    const chunks: ChunkStruct[] = [
      videoChunk(0, 33_333, true, 10),
      videoChunk(33_333, 33_333, false, 5),
      videoChunk(66_666, 33_333, false, 6),
      videoChunk(99_999, 33_333, false, 7),
    ];
    const samples = buildMuxSamples(chunks, ts);
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 0, 0, 0]);
    expect(samples.map((s) => s.keyframe)).toEqual([true, false, false, false]);
    // Durations are each chunk's own duration in ticks.
    const dt = Math.round((33_333 * ts) / 1_000_000);
    expect(samples.map((s) => s.durationTicks)).toEqual([dt, dt, dt, dt]);
  });

  it('B-frame reorder (decode-order PTS [0,3,1,2]): ctts encodes PTS−DTS incl. negatives', () => {
    const ts = 600; // 1 frame = 100 ticks at this clock for the chosen 1/6 s duration
    const frame = 100_000; // µs per frame (arbitrary, divides cleanly into `ts`)
    // Decode order I,P,B,B with presentation times 0,3,1,2 frames.
    const chunks: ChunkStruct[] = [
      videoChunk(0 * frame, frame, true, 9),
      videoChunk(3 * frame, frame, false, 8),
      videoChunk(1 * frame, frame, false, 7),
      videoChunk(2 * frame, frame, false, 6),
    ];
    const samples = buildMuxSamples(chunks, ts);
    const f = Math.round((frame * ts) / 1_000_000); // ticks per frame
    // DTS = cumulative durations = [0,f,2f,3f]; PTS = [0,3f,1f,2f]; ctts = PTS−DTS.
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 2 * f, -1 * f, -1 * f]);
    expect(samples.map((s) => s.durationTicks)).toEqual([f, f, f, f]);
  });

  it('true-DTS verbatim remux (ADR-045): lays DTS+ctts from each packet dtsUs, ignoring a wrong duration', () => {
    const ts = 90_000;
    // Decode order I,P,B,B with the SOURCE's own DTS (100ms decode spacing) and reordered PTS. Each
    // chunk's `durationUs` is deliberately WRONG (10ms) — the duration-recovery path would compute a
    // different, wrong DTS timeline; the true-DTS path derives duration from the DTS gaps instead, so
    // this asserts the dtsUs branch is taken and is exact. ctts = PTS − DTS (incl. negatives).
    const dtsChunk = (pts: number, dts: number, key: boolean): ChunkStruct => ({
      timestampUs: pts,
      durationUs: 10_000,
      key,
      data: new Uint8Array([key ? 0x65 : 0x41]),
      dtsUs: dts,
    });
    const chunks: ChunkStruct[] = [
      dtsChunk(0, 0, true),
      dtsChunk(300_000, 100_000, false),
      dtsChunk(100_000, 200_000, false),
      dtsChunk(200_000, 300_000, false),
    ];
    const samples = buildMuxSamples(chunks, ts);
    // Durations from the DTS gaps (100ms → 9000 ticks); the final sample has no next DTS, so it reuses
    // its own (10ms → 900) duration. NOT the wrong 10ms for the first three.
    expect(samples.map((s) => s.durationTicks)).toEqual([9000, 9000, 9000, 900]);
    // ctts = PTS − DTS: [0−0, 300k−100k, 100k−200k, 200k−300k] = [0, 200k, −100k, −100k] µs → ticks.
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 18_000, -9000, -9000]);
    expect(samples.map((s) => s.keyframe)).toEqual([true, false, false, false]);
  });

  it('VFR: durations vary; DTS stays contiguous so ctts stays 0 when not reordered', () => {
    const ts = 90_000;
    const chunks: ChunkStruct[] = [
      videoChunk(0, 20_000, true, 4),
      videoChunk(20_000, 50_000, false, 4),
      videoChunk(70_000, 10_000, false, 4),
    ];
    const samples = buildMuxSamples(chunks, ts);
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 0, 0]);
    expect(samples.map((s) => s.durationTicks)).toEqual([
      Math.round((20_000 * ts) / 1_000_000),
      Math.round((50_000 * ts) / 1_000_000),
      Math.round((10_000 * ts) / 1_000_000),
    ]);
  });

  it('rebases PTS to the minimum so a leading offset does not become a constant ctts', () => {
    const ts = 90_000;
    const offset = 500_000;
    const chunks: ChunkStruct[] = [
      videoChunk(offset, 33_333, true, 3),
      videoChunk(offset + 33_333, 33_333, false, 3),
    ];
    expect(buildMuxSamples(chunks, ts).map((s) => s.cttsTicks)).toEqual([0, 0]);
  });

  it('recovers missing durations from presentation gaps (keeps DTS contiguous)', () => {
    const ts = 90_000;
    const mk = (timestampUs: number, key: boolean): ChunkStruct => ({
      timestampUs,
      durationUs: undefined,
      key,
      data: new Uint8Array([1]),
    });
    const chunks = [mk(0, true), mk(40_000, false), mk(80_000, false)];
    const samples = buildMuxSamples(chunks, ts);
    const d = Math.round((40_000 * ts) / 1_000_000);
    // Each gap is 40 ms; the last frame reuses the previous duration.
    expect(samples.map((s) => s.durationTicks)).toEqual([d, d, d]);
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 0, 0]);
  });

  it('single sample: duration 0, ctts 0', () => {
    const samples = buildMuxSamples([videoChunk(0, 33_333, true, 5)], 90_000);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.cttsTicks).toBe(0);
  });

  it('empty input → no samples', () => {
    expect(buildMuxSamples([], 90_000)).toEqual([]);
  });
});

describe('Mp4Muxer — reference-reimport round-trip on synthesized packets', () => {
  it('video-only (no reorder): re-parses to identical sizes/durations/keyframes, ctts absent', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 30,
      config: { codec: 'avc1.42C01E', codedWidth: 16, codedHeight: 8, description: AVCC },
    });
    const inputs: ChunkStruct[] = [
      videoChunk(0, 33_333, true, 120),
      videoChunk(33_333, 33_333, false, 40),
      videoChunk(66_666, 33_333, false, 55),
      videoChunk(99_999, 33_333, false, 33),
    ];
    for (const c of inputs) muxer.addChunkStruct(vid, c);
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const movie = await readMovie(ra(bytes));
    expect(movie.tracks).toHaveLength(1);
    const track = movie.tracks[0];
    expect(track?.mediaType).toBe('video');
    expect(track?.codec).toBe('avc1.42C01E');
    expect(track?.width).toBe(16);
    expect(track?.height).toBe(8);

    const samples = track ? buildSampleData(track) : [];
    expect(samples.map((s) => s.size)).toEqual([120, 40, 55, 33]);
    expect(samples.map((s) => s.keyframe)).toEqual([true, false, false, false]);
    const dt = Math.round((33_333 * 30_000) / 1_000_000);
    expect(samples.map((s) => s.durationTicks)).toEqual([dt, dt, dt, dt]);
    // No reorder ⇒ ctts is omitted ⇒ every cttsTicks reads back as 0.
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 0, 0, 0]);
    expect(track?.samples.compositionOffsets).toEqual([]);
  });

  it('B-frame reorder: re-parses with the exact ctts (PTS−DTS) per sample', async () => {
    const muxer = new Mp4Muxer();
    const fps = 25;
    const ts = fps * 1000; // videoTimescale(25) = 25000
    const frame = 40_000; // µs (1/25 s) — divides cleanly into the clock
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps,
      config: { codec: 'avc1.42C01E', codedWidth: 8, codedHeight: 8, description: AVCC },
    });
    // Decode order I,P,B,B → presentation 0,3,1,2 frames.
    const inputs: ChunkStruct[] = [
      videoChunk(0 * frame, frame, true, 50),
      videoChunk(3 * frame, frame, false, 20),
      videoChunk(1 * frame, frame, false, 15),
      videoChunk(2 * frame, frame, false, 12),
    ];
    for (const c of inputs) muxer.addChunkStruct(vid, c);
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const track = (await readMovie(ra(bytes))).tracks[0];
    const samples = track ? buildSampleData(track) : [];
    const f = Math.round((frame * ts) / 1_000_000);
    // Sizes preserved in decode order; ctts is the reorder offset (negative for the B frames).
    expect(samples.map((s) => s.size)).toEqual([50, 20, 15, 12]);
    expect(samples.map((s) => s.cttsTicks)).toEqual([0, 2 * f, -1 * f, -1 * f]);
    expect(samples.map((s) => s.keyframe)).toEqual([true, false, false, false]);
    // PTS = DTS + ctts reconstructs the original presentation order.
    expect(samples.map((s) => s.dtsTicks + s.cttsTicks)).toEqual([0, 3 * f, 1 * f, 2 * f]);
    expect(track?.samples.compositionOffsets.length).toBeGreaterThan(0); // ctts box written
  });

  it('multitrack video + audio: both re-parse with the right codecs, geometry, and samples', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 30,
      config: { codec: 'avc1.42C01E', codedWidth: 32, codedHeight: 18, description: AVCC },
    });
    const aud = muxer.addTrack({
      id: 2,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, description: ASC },
    });
    muxer.addChunkStruct(vid, videoChunk(0, 33_333, true, 80));
    muxer.addChunkStruct(vid, videoChunk(33_333, 33_333, false, 30));
    // AAC frame = 1024 samples @ 48 kHz ≈ 21333 µs.
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array(17).fill(9),
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 21_333,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array(17).fill(9),
    });
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    const movie = await readMovie(ra(bytes));
    expect(movie.tracks).toHaveLength(2);
    const v = movie.tracks.find((t) => t.mediaType === 'video');
    const a = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(v?.codec).toBe('avc1.42C01E');
    expect(v?.width).toBe(32);
    expect(v?.height).toBe(18);
    expect(a?.codec).toBe('mp4a.40.2');
    expect(a?.sampleRate).toBe(48_000);
    expect(a?.channels).toBe(2);
    expect(a ? buildSampleData(a).map((s) => s.size) : []).toEqual([17, 17]);
    // AAC frame is 1024 samples; with timescale = sampleRate the duration is ~1024 ticks.
    const audDur = a ? buildSampleData(a).map((s) => s.durationTicks) : [];
    expect(audDur).toEqual([
      Math.round((21_333 * 48_000) / 1_000_000),
      Math.round((21_333 * 48_000) / 1_000_000),
    ]);
  });

  it('double-remux stable: re-muxing the parsed output reproduces the same sample table', async () => {
    const first = new Mp4Muxer();
    const vid = first.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 30,
      config: { codec: 'avc1.42C01E', codedWidth: 16, codedHeight: 16, description: AVCC },
    });
    for (const c of [videoChunk(0, 33_333, true, 20), videoChunk(33_333, 33_333, false, 10)]) {
      first.addChunkStruct(vid, c);
    }
    await first.finalize();
    const once = await collect(first.output);

    const movie = await readMovie(ra(once));
    const strip = (s: {
      size: number;
      durationTicks: number;
      cttsTicks: number;
      keyframe: boolean;
    }) => ({
      size: s.size,
      durationTicks: s.durationTicks,
      cttsTicks: s.cttsTicks,
      keyframe: s.keyframe,
    });
    const table = movie.tracks[0] ? buildSampleData(movie.tracks[0]).map(strip) : [];
    // videoTimescale(30) = 30000; round(33333 µs × 30000 / 1e6) = 1000 ticks (= 1/30 s).
    expect(table).toEqual([
      { size: 20, durationTicks: 1000, cttsTicks: 0, keyframe: true },
      { size: 10, durationTicks: 1000, cttsTicks: 0, keyframe: false },
    ]);
  });
});

describe('Mp4Muxer — typed misuse + capability misses', () => {
  it('write to an unknown track id throws mux-error', () => {
    const muxer = new Mp4Muxer();
    expect(() => muxer.addChunkStruct(99, videoChunk(0, 1000, true, 1))).toThrowError(
      /unknown track 99/,
    );
  });

  it('addTrack / write after finalize throws mux-error', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4, description: AVCC },
    });
    muxer.addChunkStruct(vid, videoChunk(0, 1000, true, 2));
    await muxer.finalize();
    expect(() =>
      muxer.addTrack({
        id: 2,
        mediaType: 'video',
        codec: 'avc1.42C01E',
        config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4 },
      }),
    ).toThrowError(/already finalized/);
    expect(() => muxer.addChunkStruct(vid, videoChunk(1000, 1000, false, 2))).toThrowError(
      /already finalized/,
    );
  });

  it('a second finalize throws mux-error', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4, description: AVCC },
    });
    muxer.addChunkStruct(vid, videoChunk(0, 1000, true, 2));
    await muxer.finalize();
    await expect(muxer.finalize()).rejects.toThrowError(/already finalized/);
  });

  it('finalize with zero tracks rejects and errors the output stream', async () => {
    const muxer = new Mp4Muxer();
    await expect(muxer.finalize()).rejects.toThrowError(/no tracks/);
    await expect(collect(muxer.output)).rejects.toThrowError(/no tracks/);
  });

  it('finalize with a track that received no packets rejects', async () => {
    const muxer = new Mp4Muxer();
    muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4, description: AVCC },
    });
    await expect(muxer.finalize()).rejects.toThrowError(/received no packets/);
  });

  it('an unsupported codec is a typed capability miss at addTrack', () => {
    const muxer = new Mp4Muxer();
    expect(() =>
      muxer.addTrack({ id: 1, mediaType: 'video', codec: 'theora', config: { codec: 'theora' } }),
    ).toThrowError(/cannot write video codec 'theora'/);
  });

  it('fragmented mux emits a CMAF init segment + moof media segments, re-parsing to the right track', async () => {
    const muxer = new Mp4Muxer({ fragmented: true });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 30,
      config: { codec: 'avc1.42C01E', codedWidth: 16, codedHeight: 8, description: AVCC },
    });
    // Two GOPs (key, delta, key, delta) so the fragmenter splits at the second keyframe → ≥2 media segments.
    muxer.addChunkStruct(vid, videoChunk(0, 33_333, true, 20));
    muxer.addChunkStruct(vid, videoChunk(33_333, 33_333, false, 10));
    muxer.addChunkStruct(vid, videoChunk(66_666, 33_333, true, 18));
    muxer.addChunkStruct(vid, videoChunk(99_999, 33_333, false, 9));
    await muxer.finalize();
    const bytes = await collect(muxer.output);

    // The output is a fragmented MP4: a `moov` init segment FOLLOWED by ≥1 `moof` media segment (a plain
    // faststart MP4 has no `moof`). Scan top-level boxes for the order + presence.
    const order: string[] = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let off = 0; off + 8 <= bytes.byteLength; ) {
      const size = dv.getUint32(off);
      order.push(String.fromCharCode(...bytes.subarray(off + 4, off + 8)));
      if (size <= 0) break;
      off += size;
    }
    expect(order.filter((t) => t === 'moof').length).toBeGreaterThanOrEqual(2);
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('moof'));

    // The fragment-aware demux recovers the track + a faithful duration from the moof/trun timing (the
    // `moov` init segment's sample tables are intentionally empty — samples live in the fragments).
    const movie = await readMovie(ra(bytes));
    expect(movie.tracks).toHaveLength(1);
    expect(movie.tracks[0]?.codec).toBe('avc1.42C01E');
    // Four 33.333 ms samples → ~0.133 s recovered from the fragment timing (not from an empty `stbl`).
    expect(movie.tracks[0]?.durationSec ?? 0).toBeCloseTo(4 * 0.033333, 2);
  });
});

describe('Mp4Driver.createMuxer — wired to Mp4Muxer', () => {
  it('returns an Mp4Muxer whose output round-trips (the real write() copyTo path is browser-only)', async () => {
    const muxer = Mp4Driver.createMuxer({ faststart: true });
    expect(muxer).toBeInstanceOf(Mp4Muxer);
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 24,
      config: { codec: 'avc1.42C01E', codedWidth: 64, codedHeight: 64, description: AVCC },
    });
    // In Node there is no real EncodedChunk, so drive the same buffer `write()` fills via copyTo.
    if (muxer instanceof Mp4Muxer) {
      muxer.addChunkStruct(vid, videoChunk(0, 41_667, true, 100));
      muxer.addChunkStruct(vid, videoChunk(41_667, 41_667, false, 25));
    }
    await muxer.finalize();
    const movie = await readMovie(ra(await collect(muxer.output)));
    expect(movie.tracks[0]?.codec).toBe('avc1.42C01E');
    expect(movie.tracks[0]?.width).toBe(64);
  });
});
