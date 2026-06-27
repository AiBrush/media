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

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { enumerateMp3Packets, parseMp3 } from '../mp3/mp3-driver.ts';
import { demuxWebm } from '../webm/webm-driver.ts';
import { Mp4Driver, readMovie } from './mp4-driver.ts';
import { type ChunkStruct, Mp4Muxer, buildMuxSamples } from './mux.ts';
import { buildSampleData } from './samples.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

async function bytesFromMediaTest(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
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

/** A minimal AVCDecoderConfigurationRecord (avcC) — the muxer synthesizes the `avcC` box from it. */
const AVCC = new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]);
const H264_SPS = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80]);
const H264_PPS = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
/** A minimal AudioSpecificConfig (AAC-LC, 48 kHz, stereo) — the muxer synthesizes `esds` from it. */
const ASC = new Uint8Array([0x11, 0x90]);
/** WebKit AudioEncoder may publish an ES_Descriptor wrapper instead of the bare ASC. */
const WEBKIT_AAC_ES_DESCRIPTOR = new Uint8Array([
  0x03, 0x80, 0x80, 0x80, 0x22, 0x00, 0x00, 0x00, 0x04, 0x80, 0x80, 0x80, 0x14, 0x40, 0x14, 0x00,
  0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x80, 0x80, 0x80, 0x02, 0x11,
  0x90, 0x06, 0x80, 0x80, 0x80, 0x01, 0x02,
]);
/** Real h265.mp4 hvcC prefix: Main, 8-bit, low tier, level 60, constraint 0x90. */
const HVCC_MAIN_8 = Uint8Array.from([0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x3c]);
/** Real bear-hevc-10bit-hdr10 hvcC shape: Main10, low tier, level 93, constraint 0x90. */
const HVCC_MAIN10 = Uint8Array.from([0x01, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d]);

function videoChunk(timestampUs: number, durationUs: number, key: boolean, n: number): ChunkStruct {
  return { timestampUs, durationUs, key, data: new Uint8Array(n).fill(key ? 0x65 : 0x41) };
}

function avcCWithParameterSets(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return new Uint8Array([
    1,
    sps[1] ?? 0,
    sps[2] ?? 0,
    sps[3] ?? 0,
    0xff,
    0xe1,
    (sps.byteLength >>> 8) & 0xff,
    sps.byteLength & 0xff,
    ...sps,
    1,
    (pps.byteLength >>> 8) & 0xff,
    pps.byteLength & 0xff,
    ...pps,
  ]);
}

function annexB(...nalus: Uint8Array[]): Uint8Array {
  const total = nalus.reduce((n, nal) => n + 4 + nal.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nalus) {
    out.set([0, 0, 0, 1], offset);
    offset += 4;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

function lengthPrefixed(...nalus: Uint8Array[]): Uint8Array {
  const total = nalus.reduce((n, nal) => n + 4 + nal.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nalus) {
    out[offset] = (nal.byteLength >>> 24) & 0xff;
    out[offset + 1] = (nal.byteLength >>> 16) & 0xff;
    out[offset + 2] = (nal.byteLength >>> 8) & 0xff;
    out[offset + 3] = nal.byteLength & 0xff;
    offset += 4;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

function adtsFrame(
  payload: Uint8Array,
  freqIndex = 4,
  channelConfig = 2,
  profile = 1,
  protectionAbsent = true,
): Uint8Array {
  const headerBytes = protectionAbsent ? 7 : 9;
  const frameLength = headerBytes + payload.byteLength;
  const out = new Uint8Array(frameLength);
  out[0] = 0xff;
  out[1] = protectionAbsent ? 0xf1 : 0xf0;
  out[2] = (profile << 6) | (freqIndex << 2) | ((channelConfig >> 2) & 0x01);
  out[3] = ((channelConfig & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  out[4] = (frameLength >> 3) & 0xff;
  out[5] = ((frameLength & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  out.set(payload, headerBytes);
  return out;
}

function fullEsdsBoxFromDescriptor(descriptorBytes: Uint8Array): Uint8Array {
  const size = 12 + descriptorBytes.byteLength;
  const out = new Uint8Array(size);
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  out.set(new TextEncoder().encode('esds'), 4);
  out.set(descriptorBytes, 12);
  return out;
}

function topLevelBoxes(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off + 8 <= bytes.byteLength; ) {
    const size = dv.getUint32(off);
    out.push(String.fromCharCode(...bytes.subarray(off + 4, off + 8)));
    if (size <= 0) break;
    off += size;
  }
  return out;
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
  it('bare h264 with Annex-B samples synthesizes avcC and writes length-prefixed AVC samples', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      fps: 30,
      config: { codec: 'h264', codedWidth: 16, codedHeight: 8 },
    });
    const key = annexB(H264_SPS, H264_PPS, new Uint8Array([0x65, 0x88, 0x84]));
    const delta = annexB(new Uint8Array([0x41, 0x9a]));
    muxer.addChunkStruct(vid, { timestampUs: 0, durationUs: 33_333, key: true, data: key });
    muxer.addChunkStruct(vid, { timestampUs: 33_333, durationUs: 33_333, key: false, data: delta });
    await muxer.finalize();

    const movie = await readMovie(ra(await collect(muxer.output)));
    const track = movie.tracks[0];
    expect(track?.codec).toBe('avc1.42C01E');
    expect(track?.width).toBe(16);
    expect(track?.height).toBe(8);
    expect(track?.codecPrivate?.boxType).toBe('avcC');
    const samples = track ? buildSampleData(track) : [];
    expect(samples.map((s) => s.size)).toEqual([
      lengthPrefixed(H264_SPS, H264_PPS, new Uint8Array([0x65, 0x88, 0x84])).byteLength,
      lengthPrefixed(new Uint8Array([0x41, 0x9a])).byteLength,
    ]);
    expect(samples.map((s) => s.keyframe)).toEqual([true, false]);
  });

  it('bare h264 with an avcC description preserves already length-prefixed samples', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      fps: 30,
      config: {
        codec: 'h264',
        codedWidth: 32,
        codedHeight: 18,
        description: avcCWithParameterSets(H264_SPS, H264_PPS),
      },
    });
    const key = lengthPrefixed(new Uint8Array([0x65, 0xaa, 0xbb]));
    const delta = lengthPrefixed(new Uint8Array([0x41, 0xcc]));
    muxer.addChunkStruct(vid, { timestampUs: 0, durationUs: 33_333, key: true, data: key });
    muxer.addChunkStruct(vid, { timestampUs: 33_333, durationUs: 33_333, key: false, data: delta });
    await muxer.finalize();

    const movie = await readMovie(ra(await collect(muxer.output)));
    const track = movie.tracks[0];
    expect(track?.codec).toBe('avc1.42C01E');
    expect(track?.width).toBe(32);
    expect(track?.height).toBe(18);
    expect(track ? buildSampleData(track).map((s) => s.size) : []).toEqual([
      key.byteLength,
      delta.byteLength,
    ]);
  });

  it('accepts sliced description views without leaking prefix/suffix bytes into avcC', async () => {
    const avcc = avcCWithParameterSets(H264_SPS, H264_PPS);
    const backing = new Uint8Array(avcc.byteLength + 4);
    backing.set([0xde, 0xad], 0);
    backing.set(avcc, 2);
    backing.set([0xbe, 0xef], 2 + avcc.byteLength);
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: {
        codec: 'avc1.42C01E',
        codedWidth: 16,
        codedHeight: 16,
        description: new DataView(backing.buffer, backing.byteOffset + 2, avcc.byteLength),
      },
    });
    muxer.addChunkStruct(vid, {
      timestampUs: 0,
      durationUs: 33_333,
      key: true,
      data: lengthPrefixed(new Uint8Array([0x65, 0xaa])),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.config.description).toEqual(avcc);
  });

  it('normalizes 3-byte Annex-B start codes, trailing zeros, and duplicate parameter sets', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      fps: 24,
      config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
    });
    const idr = new Uint8Array([0x65, 0x88]);
    const key = Uint8Array.from([
      0,
      0,
      1,
      ...H264_SPS,
      0,
      0,
      0,
      1,
      ...H264_SPS,
      0,
      0,
      1,
      ...H264_PPS,
      0,
      0,
      0,
      1,
      ...idr,
      0,
      0,
    ]);
    muxer.addChunkStruct(vid, { timestampUs: 0, durationUs: 41_667, key: true, data: key });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.codecPrivate?.boxType).toBe('avcC');
    expect(track ? buildSampleData(track).map((sample) => sample.size) : []).toEqual([
      lengthPrefixed(H264_SPS, H264_SPS, H264_PPS, idr).byteLength,
    ]);
  });

  it('bare aac with an ASC description preserves raw AAC access units', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2, description: ASC },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array([1, 2, 3, 4, 5]),
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 21_333,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array([6, 7, 8, 9, 10, 11]),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.codec).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(48_000);
    expect(track?.channels).toBe(2);
    expect(track?.config?.description).toEqual(ASC);
    expect(track ? buildSampleData(track).map((s) => s.size) : []).toEqual([5, 6]);
  });

  it('uses the documented 48 kHz audio clock fallback when config omits sampleRate', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', description: ASC },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 24_000,
      key: true,
      data: new Uint8Array([1, 2, 3, 4]),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.sampleRate).toBe(48_000);
    expect(track ? buildSampleData(track).map((s) => s.durationTicks) : []).toEqual([1152]);
  });

  it('bare aac unwraps WebKit ES_Descriptor metadata to the ASC before writing esds', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: {
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: WEBKIT_AAC_ES_DESCRIPTOR,
      },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array([1, 2, 3, 4, 5]),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.codec).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(48_000);
    expect(track?.channels).toBe(2);
    expect(track?.config?.description).toEqual(ASC);
  });

  it('bare aac unwraps a full esds box to the ASC before writing esds', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: {
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: fullEsdsBoxFromDescriptor(WEBKIT_AAC_ES_DESCRIPTOR),
      },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array([1, 2, 3]),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.config?.description).toEqual(ASC);
  });

  it('bare aac with ADTS samples synthesizes ASC and strips ADTS headers for MP4', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 44_100, numberOfChannels: 2 },
    });
    const firstPayload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01, 0x02, 0x03]);
    const secondPayload = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 23_220,
      key: true,
      data: adtsFrame(firstPayload),
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 23_220,
      durationUs: 23_220,
      key: true,
      data: adtsFrame(secondPayload, 4, 2, 1, false),
    });
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.codec).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(44_100);
    expect(track?.channels).toBe(2);
    expect(track?.config?.description).toEqual(new Uint8Array([0x12, 0x10]));
    expect(track ? buildSampleData(track).map((s) => s.size) : []).toEqual([
      firstPayload.byteLength,
      secondPayload.byteLength,
    ]);
  });

  it('muxes synthesized raw-box codec records when AV1/VP9/Opus descriptions are absent', async () => {
    const cases = [
      {
        codec: 'av01.0.08H.10.0.110',
        mediaType: 'video' as const,
        boxType: 'av1C',
        config: { codec: 'av01.0.08H.10.0.110', codedWidth: 16, codedHeight: 16 },
      },
      {
        codec: 'vp9',
        mediaType: 'video' as const,
        boxType: 'vpcC',
        config: { codec: 'vp9', codedWidth: 16, codedHeight: 16 },
      },
      {
        codec: 'vp09.03.10.12.03',
        mediaType: 'video' as const,
        boxType: 'vpcC',
        config: { codec: 'vp09.03.10.12.03', codedWidth: 16, codedHeight: 16 },
      },
      {
        codec: 'opus',
        mediaType: 'audio' as const,
        boxType: 'dOps',
        config: { codec: 'opus', sampleRate: 16_000, numberOfChannels: 1 },
      },
    ];

    for (const item of cases) {
      const muxer = new Mp4Muxer();
      const id = muxer.addTrack({
        id: 1,
        mediaType: item.mediaType,
        codec: item.codec,
        config: item.config,
      } satisfies TrackInfo);
      muxer.addChunkStruct(id, {
        timestampUs: 0,
        durationUs: item.mediaType === 'video' ? 33_333 : 20_000,
        key: true,
        data: new Uint8Array([1, 2, 3, 4]),
      });
      await muxer.finalize();

      const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
      expect(track?.codecPrivate?.boxType).toBe(item.boxType);
      expect(track?.config.description?.byteLength ?? 0).toBeGreaterThan(0);
    }
  });

  it.each([
    {
      fixture: 'vp9_1080p_10s.webm',
      videoPrefix: 'vp09.',
      videoBox: 'vpcC',
    },
    {
      fixture: 'av1_720p_5s.webm',
      videoPrefix: 'av01.',
      videoBox: 'av1C',
    },
  ])('$fixture — WebM video+Opus muxes to MP4 with synthesized ISO codec records', async (c) => {
    const { info, framesByIndex } = demuxWebm(await bytesFromMediaTest(c.fixture));
    const muxer = new Mp4Muxer();
    const trackIds = info.tracks.map((track, index) => {
      const config =
        track.mediaType === 'video'
          ? {
              codec: track.codec,
              codedWidth: track.width ?? 0,
              codedHeight: track.height ?? 0,
              ...(track.description !== undefined ? { description: track.description } : {}),
            }
          : {
              codec: track.codec,
              sampleRate: track.sampleRate ?? 48_000,
              numberOfChannels: track.channels ?? 2,
              ...(track.description !== undefined ? { description: track.description } : {}),
            };
      return muxer.addTrack({
        id: index,
        mediaType: track.mediaType,
        codec: track.codec,
        ...(track.fps !== undefined ? { fps: track.fps } : {}),
        config,
      } satisfies TrackInfo);
    });

    for (let trackIndex = 0; trackIndex < trackIds.length; trackIndex++) {
      const trackId = trackIds[trackIndex] as number;
      for (const frame of (framesByIndex[trackIndex] ?? []).slice(0, 8)) {
        muxer.addChunkStruct(trackId, {
          timestampUs: frame.timestampUs,
          durationUs: undefined,
          key: frame.keyframe,
          data: frame.data.slice(),
        });
      }
    }
    await muxer.finalize();

    const movie = await readMovie(ra(await collect(muxer.output)));
    const video = movie.tracks.find((track) => track.mediaType === 'video');
    const audio = movie.tracks.find((track) => track.mediaType === 'audio');
    expect(video?.codec.startsWith(c.videoPrefix)).toBe(true);
    expect(video?.codecPrivate?.boxType).toBe(c.videoBox);
    expect(video ? buildSampleData(video).length : 0).toBeGreaterThanOrEqual(5);
    expect(audio?.codec).toBe('opus');
    expect(audio?.codecPrivate?.boxType).toBe('dOps');
    expect(audio ? buildSampleData(audio).length : 0).toBeGreaterThanOrEqual(5);
  });

  it('real MP3 frame packets mux to MP4 as an mp4a.6b sample table without AAC rewriting', async () => {
    const source = await loadFixture('sound_5.mp3');
    const info = parseMp3(source, source.byteLength);
    const packets = enumerateMp3Packets(source).slice(0, 8);
    const muxer = new Mp4Muxer();
    const audio = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'mp3',
      config: { codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels },
    });
    for (const packet of packets) {
      muxer.addChunkStruct(audio, {
        timestampUs: packet.ptsUs,
        durationUs: packet.durationUs,
        key: true,
        data: source.subarray(packet.offset, packet.offset + packet.size).slice(),
      });
    }
    await muxer.finalize();

    const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
    expect(track?.codec).toBe('mp4a.6b');
    expect(track?.codecPrivate?.boxType).toBe('esds');
    expect(track?.sampleRate).toBe(info.sampleRate);
    expect(track?.channels).toBe(info.channels);
    expect(track ? buildSampleData(track).map((sample) => sample.size) : []).toEqual(
      packets.map((packet) => packet.size),
    );
  });

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

  it('maps legal raw-box codec families without rewriting their codec-private bytes', async () => {
    const cases = [
      {
        mediaType: 'video' as const,
        codec: 'hev1.1.6.L93.B0',
        config: {
          codec: 'hev1.1.6.L93.B0',
          codedWidth: 8,
          codedHeight: 8,
          description: new Uint8Array([1, 2, 3, 4]),
        },
      },
      {
        mediaType: 'video' as const,
        codec: 'hvc1.1.6.L93.B0',
        config: {
          codec: 'hvc1.1.6.L93.B0',
          codedWidth: 8,
          codedHeight: 8,
          description: new Uint8Array([5, 6, 7, 8]),
        },
      },
      {
        mediaType: 'video' as const,
        codec: 'av01.0.04M.08',
        config: {
          codec: 'av01.0.04M.08',
          codedWidth: 8,
          codedHeight: 8,
          description: new Uint8Array([0x81, 0x00, 0x0c, 0x00]),
        },
      },
      {
        mediaType: 'video' as const,
        codec: 'vp9',
        config: {
          codec: 'vp9',
          codedWidth: 8,
          codedHeight: 8,
          description: new Uint8Array([1, 1, 0, 0]),
        },
      },
      {
        mediaType: 'audio' as const,
        codec: 'opus',
        config: {
          codec: 'opus',
          sampleRate: 48_000,
          numberOfChannels: 2,
          description: new Uint8Array([0x00, 0x02, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00]),
        },
      },
      {
        mediaType: 'audio' as const,
        codec: 'flac',
        config: {
          codec: 'flac',
          sampleRate: 48_000,
          numberOfChannels: 2,
          description: new Uint8Array([0x00, 0x00, 0x00, 0x22, ...new Array<number>(34).fill(0)]),
        },
      },
    ];

    for (const item of cases) {
      const muxer = new Mp4Muxer();
      const trackId = muxer.addTrack({
        id: 1,
        mediaType: item.mediaType,
        codec: item.codec,
        config: item.config,
      });
      muxer.addChunkStruct(trackId, {
        timestampUs: 0,
        durationUs: item.mediaType === 'video' ? 33_333 : 21_333,
        key: true,
        data: new Uint8Array([1, 2, 3, 4]),
      });
      await muxer.finalize();
      const bytes = await collect(muxer.output);
      expect(bytes.byteLength).toBeGreaterThan(32);
      expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('ftyp');
    }
  });

  it('HEVC raw-box muxing preserves hvcC bytes and 8/10-bit codec strings exactly', async () => {
    const cases = [
      {
        codec: 'hvc1.1.6.L60.90',
        sampleEntryType: 'hvc1',
        description: HVCC_MAIN_8,
      },
      {
        codec: 'hev1.2.4.L93.90',
        sampleEntryType: 'hev1',
        description: HVCC_MAIN10,
      },
    ] as const;

    for (const item of cases) {
      const muxer = new Mp4Muxer();
      const trackId = muxer.addTrack({
        id: 1,
        mediaType: 'video',
        codec: item.codec,
        config: {
          codec: item.codec,
          codedWidth: 16,
          codedHeight: 16,
          description: item.description,
        },
      });
      muxer.addChunkStruct(trackId, videoChunk(0, 33_333, true, 4));
      await muxer.finalize();

      const track = (await readMovie(ra(await collect(muxer.output)))).tracks[0];
      expect(track?.sampleEntryType).toBe(item.sampleEntryType);
      expect(track?.codec).toBe(item.codec);
      expect(track?.config.description).toEqual(item.description);
      expect(track?.codecPrivate).toEqual({ boxType: 'hvcC', data: item.description });
    }
  });

  it('HEVC raw-box muxing rejects a missing hvcC description as a typed capability miss', async () => {
    const muxer = new Mp4Muxer();
    const trackId = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'hvc1.1.6.L60.90',
      config: { codec: 'hvc1.1.6.L60.90', codedWidth: 16, codedHeight: 16 },
    });
    muxer.addChunkStruct(trackId, videoChunk(0, 33_333, true, 4));

    const error = await muxer.finalize().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CapabilityError);
    if (!(error instanceof CapabilityError)) throw new Error('expected CapabilityError');
    expect(error.code).toBe('capability-miss');
    expect(error.message).toContain('hvcC description');
    expect(error.detail).toEqual({
      op: { op: 'mux', mediaType: 'video', codec: 'hvc1' },
      tried: ['mp4'],
    });
  });

  it('bare aac without ASC or ADTS framing rejects instead of guessing AAC-LC', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 21_333,
      key: true,
      data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/AAC MP4 muxing requires/);
  });

  it('bare aac rejects malformed ADTS-looking samples instead of guessing AAC geometry', async () => {
    const validAdts = adtsFrame(new Uint8Array([1, 2, 3]));
    const invalidAdtsSamples = [
      new Uint8Array(6),
      Uint8Array.of(0xff, 0xe0, 0x50, 0x80, 0, 0xe0, 0xfc),
      Uint8Array.of(0xff, 0xf7, 0x50, 0x80, 0, 0xe0, 0xfc),
      adtsFrame(new Uint8Array([1, 2, 3]), 15, 2),
      adtsFrame(new Uint8Array([1, 2, 3]), 4, 0),
      validAdts.subarray(0, validAdts.byteLength - 1),
      Uint8Array.of(0xff, 0xf0, 0x50, 0x80, 0x00, 0xff, 0xfc),
    ];

    for (const data of invalidAdtsSamples) {
      const muxer = new Mp4Muxer();
      const aud = muxer.addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
      });
      muxer.addChunkStruct(aud, { timestampUs: 0, durationUs: 21_333, key: true, data });
      await expect(muxer.finalize()).rejects.toThrowError(/AAC MP4 muxing requires/);
    }
  });

  it('bare aac rejects invalid AudioSpecificConfig descriptions before writing esds', async () => {
    const invalidDescriptions = [
      new Uint8Array([0x03, 0x01, 0x00]),
      new Uint8Array([0, 0, 0, 0, 0x05]),
      Uint8Array.from([0, 0, 0, 16, ...new TextEncoder().encode('esds'), 0, 0, 0, 0]),
      new Uint8Array([0xff, 0xff]),
    ];

    for (const description of invalidDescriptions) {
      const muxer = new Mp4Muxer();
      const aud = muxer.addTrack({
        id: 1,
        mediaType: 'audio',
        codec: 'aac',
        config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2, description },
      });
      muxer.addChunkStruct(aud, {
        timestampUs: 0,
        durationUs: 21_333,
        key: true,
        data: new Uint8Array([1, 2, 3]),
      });
      await expect(muxer.finalize()).rejects.toThrowError(/invalid AudioSpecificConfig|MP4 box/);
    }
  });

  it('bare h264 without avcC or Annex-B SPS/PPS rejects instead of guessing parameter sets', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
    });
    muxer.addChunkStruct(vid, {
      timestampUs: 0,
      durationUs: 33_333,
      key: true,
      data: lengthPrefixed(new Uint8Array([0x65, 0x88, 0x84])),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/requires avcC description/);
  });

  it('bare h264 rejects Annex-B parameter sets that cannot synthesize a legal avcC', async () => {
    const muxer = new Mp4Muxer();
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
    });
    muxer.addChunkStruct(vid, {
      timestampUs: 0,
      durationUs: 33_333,
      key: true,
      data: annexB(new Uint8Array([0x67, 0x42, 0xc0]), H264_PPS, new Uint8Array([0x65])),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/SPS is too short/);
  });

  it('Opus MP4 muxing rejects unsupported channel-family layouts without a dOps description', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 3 },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 20_000,
      key: true,
      data: new Uint8Array([1, 2, 3]),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/family-0 mono\/stereo/);
  });

  it('bare aac rejects mixed raw and ADTS samples in one MP4 track', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 44_100, numberOfChannels: 2 },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 23_220,
      key: true,
      data: adtsFrame(new Uint8Array([1, 2, 3])),
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 23_220,
      durationUs: 23_220,
      key: true,
      data: new Uint8Array([4, 5, 6]),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/cannot mix ADTS-framed and raw/);
  });

  it('bare aac rejects ADTS samples whose geometry contradicts the ASC description', async () => {
    const muxer = new Mp4Muxer();
    const aud = muxer.addTrack({
      id: 1,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2, description: ASC },
    });
    muxer.addChunkStruct(aud, {
      timestampUs: 0,
      durationUs: 23_220,
      key: true,
      data: adtsFrame(new Uint8Array([1, 2, 3]), 4, 2),
    });
    await expect(muxer.finalize()).rejects.toThrowError(/does not match/);
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

  it('can emit a QuickTime-branded non-faststart file', async () => {
    const muxer = new Mp4Muxer({ faststart: false, container: 'mov' });
    const vid = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 8, codedHeight: 8, description: AVCC },
    });
    muxer.addChunkStruct(vid, videoChunk(0, 33_333, true, 4));
    await muxer.finalize();

    const bytes = await collect(muxer.output);
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('qt  ');
    expect(topLevelBoxes(bytes)).toEqual(['ftyp', 'mdat', 'moov']);
    expect((await readMovie(ra(bytes))).brand).toBe('qt  ');
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
