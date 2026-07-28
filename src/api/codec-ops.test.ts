/**
 * Engine-level routing tests for the codec-tier ops (decode/encode/convert/seek), exercised in Node where
 * WebCodecs/GPU are ABSENT. They pin the parts of the wiring that are Node-reachable: the convert
 * stream-copy auto-route (a pure container change still works losslessly), the honest `CapabilityError`
 * when a re-encode/decode is genuinely needed but no codec substrate exists (NEVER a fake passthrough),
 * the lazy `decode` frame-stream contract, and the input-validation guards. The full decode/encode/
 * transcode/seek round-trips with real WebCodecs are validated by the parent in the browser harness.
 *
 * Subject media are REAL corpus MP4s (never synthetic) so the routing tracks the real demuxer output.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, PacketInfoMetadata, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { parseAdts } from '../drivers/adts/adts-driver.ts';
import { FlacDriver, enumerateFlacFrames, parseFlac } from '../drivers/flac/flac-driver.ts';
import { parseMp3 } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { parseTs } from '../drivers/mpegts/ts-parse.ts';
import {
  OggDriver,
  oggAudioPackets,
  oggPacketBytes,
  oggPacketInfoFromBytes,
  parseOgg,
} from '../drivers/ogg/ogg-driver.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { demuxWebm, parseWebm } from '../drivers/webm/webm-driver.ts';
import { channelAt } from '../dsp/pcm.ts';
import { readOggVorbisComment } from '../metadata/ogg-vorbis-comment.ts';
import { fromBytes } from '../sources/source.ts';
import { encryptCenc } from '../test-support/cenc-encrypt.ts';
import { fixtureSource, loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';
import { deferredStream } from './engine.ts';
import {
  muxFlacMkv,
  muxPreparedWebmAudioPacketTrack,
  muxPreparedWebmChunkTracks,
  muxPreparedWebmPacketStreams,
  muxPreparedWebmPacketTracks,
  muxSingleTrackMp4,
  muxSingleTrackWebmAudio,
} from './flac-mkv-mux.ts';
import type { PreparedWebmChunk } from './flac-mkv-mux.ts';
import type { PacketStreams } from './types.ts';

/** Real, stream-copyable MP4s (h264 + aac), ≥3 distinct files of varied duration/tracks. */
const MP4_FIXTURES = ['movie_5.mp4', 'test.mp4', 'h264.mp4'] as const;
const FLAC_OGG_FIXTURES = [
  'sfx.flac',
  'flac-08bit.flac',
  'flac-12bit.flac',
  'flac-24bit-hires.flac',
  'flac-5_1ch.flac',
] as const;
const CENC_KEY = '000102030405060708090a0b0c0d0e0f';
const CENC_KID = '00112233445566778899aabbccddeeff';
const DERIVED_DIR = new URL('../../fixtures/media-derived/aiff-caf/', import.meta.url);

const media = () => createMedia();

function peak(ch: Float64Array): number {
  let out = 0;
  for (const sample of ch) out = Math.max(out, Math.abs(sample));
  return out;
}

async function derivedSource(id: string, mime: string) {
  return fromBytes(new Uint8Array(await readFile(new URL(id, DERIVED_DIR))), { mime });
}

async function readFirstFrame<T>(stream: ReadableStream<T> | undefined): Promise<void> {
  if (!stream) throw new Error('expected a frame stream');
  const reader = stream.getReader();
  try {
    await reader.read();
  } finally {
    reader.releaseLock();
  }
}

type TestChunkInit = {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly data: AllowSharedBufferSource;
};

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

class TestEncodedChunk {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: TestChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = copyBufferSource(init.data);
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

function testChunk(
  data: Uint8Array = new Uint8Array([0xf8, 0xff, 0xfe]),
  init: Partial<TestChunkInit> = {},
): EncodedChunk {
  return new TestEncodedChunk({
    type: init.type ?? 'key',
    timestamp: init.timestamp ?? 0,
    duration: init.duration ?? 20_000,
    data,
  }) as EncodedChunk;
}

function testPacket(
  data: Uint8Array = new Uint8Array([0xf8, 0xff, 0xfe]),
  init: Partial<TestChunkInit> & {
    readonly dtsUs?: number;
    readonly dataOverride?: Uint8Array;
  } = {},
): Packet {
  return {
    chunk: testChunk(data, init),
    data: init.dataOverride ?? data,
    ...(init.dtsUs !== undefined ? { dtsUs: init.dtsUs } : {}),
    sizeBytes: data.byteLength,
  };
}

function audioTrack(
  codec: string,
  description: AllowSharedBufferSource | undefined = new Uint8Array([1, 2, 3]),
): TrackInfo {
  return {
    id: 1,
    mediaType: 'audio',
    codec,
    durationSec: 0.02,
    config: {
      codec,
      sampleRate: 48_000,
      numberOfChannels: 2,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

function videoTrack(codec = 'avc1.42E01E'): TrackInfo {
  return {
    id: 2,
    mediaType: 'video',
    codec,
    durationSec: 0.02,
    config: {
      codec,
      codedWidth: 16,
      codedHeight: 16,
      description: new Uint8Array([1, 100, 0, 30]),
    },
  };
}

function packetStream(packets: readonly Packet[]): ReadableStream<Packet> {
  return new ReadableStream<Packet>({
    start(controller): void {
      for (const packet of packets) controller.enqueue(packet);
      controller.close();
    },
  });
}

async function streamBytes(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (stream === undefined) throw new Error('expected byte stream');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function packetPayloads(stream: ReadableStream<Packet>): Promise<readonly Uint8Array[]> {
  const reader = stream.getReader();
  const payloads: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return payloads;
      const payload = new Uint8Array(value.chunk.byteLength);
      value.chunk.copyTo(payload);
      payloads.push(payload);
    }
  } finally {
    reader.releaseLock();
  }
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.byteLength, `${label}: byte length`).toBe(expected.byteLength);
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${label}: byte ${index} differs (${actual[index] ?? 'missing'} !== ${expected[index] ?? 'missing'})`,
      );
    }
  }
}

function encodedChunkFromPacketInfo(row: PacketInfoMetadata, data: Uint8Array): EncodedChunk {
  return testChunk(data, {
    type: row.keyframe ? 'key' : 'delta',
    timestamp: row.ptsUs,
    duration: row.durationUs ?? null,
  });
}

function packetFromPacketInfo(row: PacketInfoMetadata, bytes: Uint8Array): Packet | undefined {
  if (row.offset === undefined) return undefined;
  const end = row.offset + row.size;
  if (row.offset < 0 || row.size <= 0 || end > bytes.byteLength) return undefined;
  const data = bytes.slice(row.offset, end);
  return {
    chunk: encodedChunkFromPacketInfo(row, data),
    data,
    dtsUs: row.dtsUs,
    sizeBytes: row.size,
  };
}

async function preparedMp4PacketTracks(fixture: string): Promise<{
  readonly tracks: Array<{ readonly track: TrackInfo; readonly packets: readonly Packet[] }>;
}> {
  const bytes = await loadFixture(fixture);
  if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
  const table = await Mp4Driver.packetInfo(fromBytes(bytes, { mime: 'video/mp4' }));
  const tracks: Array<{ readonly track: TrackInfo; readonly packets: readonly Packet[] }> = [];
  for (let trackIndex = 0; trackIndex < table.tracks.length; trackIndex++) {
    const track = table.tracks[trackIndex];
    if (track === undefined) continue;
    const packets: Packet[] = [];
    for (const row of table.packets) {
      if (row.trackIndex !== trackIndex) continue;
      const packet = packetFromPacketInfo(row, bytes);
      if (packet !== undefined) packets.push(packet);
    }
    if (packets.length > 0) tracks.push({ track, packets });
  }
  return { tracks };
}

async function preparedMp4ChunkTracks(fixture: string): Promise<{
  readonly tracks: Array<{
    readonly track: TrackInfo;
    readonly chunks: readonly PreparedWebmChunk[];
  }>;
}> {
  const bytes = await loadFixture(fixture);
  if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
  const table = await Mp4Driver.packetInfo(fromBytes(bytes, { mime: 'video/mp4' }));
  const tracks: Array<{ readonly track: TrackInfo; readonly chunks: PreparedWebmChunk[] }> = [];
  for (let trackIndex = 0; trackIndex < table.tracks.length; trackIndex++) {
    const track = table.tracks[trackIndex];
    if (track === undefined) continue;
    const chunks: PreparedWebmChunk[] = [];
    for (const row of table.packets) {
      if (row.trackIndex !== trackIndex || row.offset === undefined) continue;
      const end = row.offset + row.size;
      if (row.offset < 0 || row.size <= 0 || end > bytes.byteLength) continue;
      chunks.push({
        timestampUs: row.ptsUs,
        key: row.keyframe,
        data: bytes.subarray(row.offset, end),
        ...(row.durationUs !== undefined ? { durationUs: row.durationUs } : {}),
        ...(row.dtsUs !== undefined ? { dtsUs: row.dtsUs } : {}),
      });
    }
    if (chunks.length > 0) tracks.push({ track, chunks });
  }
  return { tracks };
}

function installEncodedChunkConstructors(
  videoConstructor: typeof EncodedVideoChunk,
  audioConstructor: typeof EncodedAudioChunk,
): () => void {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: videoConstructor,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: audioConstructor,
  });
  return () => {
    if (originalVideo === undefined) {
      Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    } else {
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        writable: true,
        value: originalVideo,
      });
    }
    if (originalAudio === undefined) {
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    } else {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        writable: true,
        value: originalAudio,
      });
    }
  };
}

function installEncodedChunkShims(): () => void {
  const chunkConstructor = TestEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  return installEncodedChunkConstructors(chunkConstructor, chunkConstructor);
}

function installThrowingEncodedChunkConstructors(message: string): () => void {
  class ThrowingEncodedChunk {
    constructor() {
      throw new Error(message);
    }
  }

  const chunkConstructor = ThrowingEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  return installEncodedChunkConstructors(chunkConstructor, chunkConstructor);
}

async function outputBytes(output: Blob | File | ReadableStream<Uint8Array> | undefined) {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

async function expectNativeFlacOggCopy(input: Uint8Array, out: Uint8Array): Promise<void> {
  const sourceInfo = parseFlac(input);
  const sourceFrames = enumerateFlacFrames(input);
  expect(out.byteLength).toBeGreaterThan(0);
  expect(
    out.byteLength === input.byteLength && out.every((byte, index) => byte === input[index]),
  ).toBe(false);

  const info = parseOgg(out);
  expect(info.codec).toBe('flac');
  expect(info.sampleRate).toBe(sourceInfo.sampleRate);
  expect(info.channels).toBe(sourceInfo.channels);
  expect(info.durationSec * info.sampleRate).toBe(sourceInfo.totalSamples);

  const demuxed = await OggDriver.demux(fromBytes(out, { mime: 'audio/ogg' }));
  try {
    const description = demuxed.tracks[0]?.config?.description;
    if (description === undefined) throw new Error('Ogg-FLAC track must expose STREAMINFO');
    const reparsedStreamInfo = parseFlac(copyBufferSource(description));
    expect(reparsedStreamInfo.totalSamples).toBe(sourceInfo.totalSamples);
    expect(reparsedStreamInfo.bitsPerSample).toBe(sourceInfo.bitsPerSample);
  } finally {
    await demuxed.close();
  }

  const packets = oggAudioPackets(out);
  expect(packets).toHaveLength(sourceFrames.length);
  expect(packets.map((packet) => [...oggPacketBytes(out, packet)])).toEqual(
    sourceFrames.map((frame) => [...frame.data]),
  );
  expect(sourceFrames.reduce((total, frame) => total + frame.samples, 0)).toBe(
    sourceInfo.totalSamples,
  );
}

describe('convert — stream-copy auto-route (no re-encode needed)', () => {
  it('a pure container-preserving convert (mp4 → mp4, no targets) stream-copies to a non-empty Blob', async () => {
    for (const id of MP4_FIXTURES) {
      const out = await media().convert(await fixtureSource(id), { to: 'mp4' });
      expect(out).toBeInstanceOf(Blob);
      if (out instanceof Blob) expect(out.size).toBeGreaterThan(0);
    }
  });

  it('a copy convert re-lays-out the container (not an input→output passthrough)', async () => {
    const id = 'movie_5.mp4';
    const src = await fixtureSource(id);
    const input = src.range ? await src.range(0, src.size ?? 0) : new Uint8Array();
    const out = await media().convert(await fixtureSource(id), { to: 'mp4' });
    expect(out).toBeInstanceOf(Blob);
    if (out instanceof Blob) {
      const bytes = new Uint8Array(await out.arrayBuffer());
      // A genuine remux changes the byte layout (faststart moov-before-mdat); never the same bytes back.
      expect(bytes.byteLength === input.byteLength && bytes.every((b, i) => b === input[i])).toBe(
        false,
      );
    }
  });

  it('routes an explicit PCM sample-format target (pcm-s16) through the audio-dsp WAV path, not the codec seam', async () => {
    // gap #5: a canonical PCM token (pcm-s16/-s24/-f32, what the harness passes) must be recognized as
    // PCM so convert(wav→wav) flows through transformPcm (a Blob) instead of falling through to the
    // codec seam. The Session 8 WAV packet muxer is for raw packet assembly, not PCM AudioData encoding.
    const out = await media().convert(await fixtureSource('speech.wav'), {
      to: 'wav',
      audio: { codec: 'pcm-s16' as never },
    });
    expect(out).toBeInstanceOf(Blob);
    if (out instanceof Blob) expect(out.size).toBeGreaterThan(0);
  });

  it('routes public PCM dynamics and biquad options through convert(), not the codec seam', async () => {
    const out = await media().convert(await fixtureSource('speech.wav'), {
      to: 'wav',
      audio: {
        codec: 'pcm-f32' as never,
        biquad: { type: 'highpass', frequency: 300, q: Math.SQRT1_2 },
        dynamics: {
          normalize: { mode: 'peak', targetDbfs: -6 },
          limit: { ceilingDbfs: -1, mode: 'hard' },
        },
      },
    });
    const pcm = readWavPcm(await outputBytes(out));
    expect(pcm.format).toBe('f32');
    expect(pcm.frames).toBeGreaterThan(0);
    expect(peak(channelAt(pcm.planar, 0))).toBeCloseTo(10 ** (-6 / 20), 5);
  });
});

describe('convert — codec seam reached and fails honestly without WebCodecs', () => {
  it('a re-encode request (video codec change) raises a typed CapabilityError in Node (no fake output)', async () => {
    for (const id of MP4_FIXTURES) {
      await expect(
        media().convert(await fixtureSource(id), { video: { codec: 'vp9' } }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });

  it('a resize request raises a typed CapabilityError in Node (decode needed, WebCodecs absent)', async () => {
    await expect(
      media().convert(await fixtureSource('movie_5.mp4'), { video: { width: 320, height: 240 } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('a cross-container copy raises a typed CapabilityError in Node (packet seam needs WebCodecs)', async () => {
    // mp4 → webm is not a same-container stream-copy; webm HAS a chunk muxer, so it routes through the
    // demux→muxer packet seam — which needs WebCodecs EncodedChunk (absent in Node) → typed miss, not fake.
    await expect(
      media().convert(await fixtureSource('movie_5.mp4'), { to: 'webm' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('trim — compressed audio packet-copy path', () => {
  it('rejects fragmented output for a non-MP4 trim before packet-copy work starts', async () => {
    await expect(
      media().trim(await fixtureSource('sfx-opus.ogg'), {
        start: 0.04,
        end: 0.16,
        fragmented: true,
      }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('trims MP3, ADTS, and Ogg/Opus as real shortened packet streams', async () => {
    const restore = installEncodedChunkShims();
    try {
      const mp3 = await outputBytes(
        await media().trim(await fixtureSource('sound_5.mp3'), { start: 1, end: 3 }),
      );
      // Packet-copy trimming selects complete MPEG frames. The real 22.05 kHz corpus fixture selects
      // 77 × 576-sample frames; the output intentionally has no source Xing/LAME tuple after the
      // window changes, so this is the exact coded duration rather than a loose two-second check.
      expect(parseMp3(mp3, mp3.byteLength).durationSec).toBeCloseTo((77 * 576) / 22_050, 12);

      const adts = await outputBytes(
        await media().trim(await fixtureSource('sfx.adts'), { start: 0.04, end: 0.16 }),
      );
      expect(parseAdts(adts, adts.byteLength).durationSec).toBeCloseTo(0.12, 1);

      const ogg = await outputBytes(
        await media().trim(await fixtureSource('sfx-opus.ogg'), { start: 0.04, end: 0.16 }),
      );
      expect(parseOgg(ogg, ogg).durationSec).toBeCloseTo(0.12, 1);
    } finally {
      restore();
    }
  });
});

describe('remux — generalized container routing (ADR-021/012)', () => {
  it('same-container stream-copy (mp4 → mp4) re-lays-out a real container in Node (pure TS)', async () => {
    const out = await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mp4' });
    const blob = out as Blob;
    expect(blob.size).toBeGreaterThan(0);
    // The output re-probes as a real MP4 with the source's codecs (a genuine remux, not a passthrough).
    const info = await media().probe(blob);
    expect(info.container).toBe('mp4');
    expect(info.tracks.length).toBeGreaterThan(0);
  });

  it('cross-family same-driver stream-copy (mp4 → mov) writes a real container in Node', async () => {
    const out = await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mov' });
    const blob = out as Blob;
    expect(blob.size).toBeGreaterThan(0);
    // The MP4 driver writes both mp4 and mov (its `formats`) → a pure-TS stream-copy (no seam). probe
    // canonicalizes the ISO-BMFF family to 'mp4' (the QuickTime ftyp-brand distinction is covered by
    // mov-brand.test.ts); here we assert it is a valid re-importable container with the source tracks.
    const info = await media().probe(blob);
    expect(info.container).toBe('mp4');
    expect(info.tracks.length).toBeGreaterThan(0);
  });

  it('cross-container remux (mp4 → mkv) writes directly from packet offsets without host chunks', async () => {
    const input = await loadFixture('movie_5.mp4');
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('expected MP4 packet-info');
    const sourceTable = await packetInfo.call(Mp4Driver, fromBytes(input, { mime: 'video/mp4' }));
    const out = await outputBytes(
      await media().remux(fromBytes(input, { mime: 'video/mp4' }), { to: 'mkv' }),
    );
    const parsed = await demuxWebm(out);

    expect(parsed.info.container).toBe('mkv');
    expect(sourceTable.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    expect(parsed.info.tracks.map((track) => track.codec)).toEqual(['h264', 'aac']);
    expect(parsed.framesByIndex.reduce((total, frames) => total + frames.length, 0)).toBe(
      sourceTable.packets.length,
    );
  });

  it('cross-container remux (mp4 → ts) accepts foreign H.264/AAC packets through the muxer seam', async () => {
    const restore = installEncodedChunkShims();
    try {
      for (const id of ['h264.mp4', 'movie_5.mp4', 'test.mp4'] as const) {
        const input = await loadFixture(id);
        const out = await outputBytes(await media().remux(await fixtureSource(id), { to: 'ts' }));
        expect(out.byteLength).toBeGreaterThan(0);
        expect(out.byteLength % 188).toBe(0);
        expect(
          out.byteLength === input.byteLength && out.every((b, index) => b === input[index]),
        ).toBe(false);

        const parsed = parseTs(out);
        expect(parsed.tracks.find((track) => track.stream.codec === 'h264')).toBeDefined();
        for (const track of parsed.tracks) {
          expect(track.units.length).toBeGreaterThan(0);
          if (track.stream.codec === 'h264') {
            const first = track.units[0]?.data ?? new Uint8Array();
            const annexBStart =
              first[0] === 0x00 &&
              first[1] === 0x00 &&
              (first[2] === 0x01 || (first[2] === 0x00 && first[3] === 0x01));
            expect(annexBStart).toBe(true);
          }
          if (track.stream.codec === 'aac') {
            // The muxed TS carries ADTS-framed AAC, but ts-parse de-frames each PES to a bare raw
            // access unit (ADR-184) — so assert the framing at the stream layer and rawness at the AU.
            const streamHasAdts = out.some(
              (b, k) => b === 0xff && k + 1 < out.length && ((out[k + 1] ?? 0) & 0xf6) === 0xf0,
            );
            expect(streamHasAdts).toBe(true);
            const au = track.units[0]?.data ?? new Uint8Array();
            expect(au.byteLength).toBeGreaterThan(0);
            expect(au[0] === 0xff && ((au[1] ?? 0) & 0xf0) === 0xf0).toBe(false);
          }
        }
      }
    } finally {
      restore();
    }
  });

  it('cross-container remux (mp4 → ts) can feed MPEG-TS directly from MP4 packet-info offsets', async () => {
    const restore = installThrowingEncodedChunkConstructors(
      'mp4-to-ts packet-info remux must not construct EncodedChunk objects',
    );
    try {
      const input = await loadFixture('movie_5.mp4');
      const out = await outputBytes(
        await media().remux(await fixtureSource('movie_5.mp4'), { to: 'ts' }),
      );
      expect(out.byteLength).toBeGreaterThan(0);
      expect(out.byteLength % 188).toBe(0);
      expect(
        out.byteLength === input.byteLength && out.every((b, index) => b === input[index]),
      ).toBe(false);

      const parsed = parseTs(out);
      expect(parsed.tracks.find((track) => track.stream.codec === 'h264')).toBeDefined();
      expect(parsed.tracks.find((track) => track.stream.codec === 'aac')).toBeDefined();
      for (const track of parsed.tracks) expect(track.units.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('cross-container remux (flac → ogg) uses native frame copy without host chunk constructors', async () => {
    const restore = installThrowingEncodedChunkConstructors(
      'native FLAC-to-Ogg remux must not construct EncodedChunk objects',
    );
    try {
      const input = await loadFixture('sfx.flac');
      const out = await outputBytes(
        await media().remux(await fixtureSource('sfx.flac'), { to: 'ogg' }),
      );
      await expectNativeFlacOggCopy(input, out);
    } finally {
      restore();
    }
  });

  it('cross-container remux (Ogg audio → MKV) uses native packet views without host chunks', async () => {
    const restore = installThrowingEncodedChunkConstructors(
      'native Ogg-to-MKV remux must not construct EncodedChunk objects',
    );
    try {
      for (const id of ['sfx-opus.ogg', 'sound_5.oga'] as const) {
        const input = await loadFixture(id);
        const sourcePackets = oggAudioPackets(input);
        const sourceTable = oggPacketInfoFromBytes(input);
        const description = sourceTable.tracks[0]?.config?.description;
        const codecDelayUs =
          sourceTable.tracks[0]?.codec === 'opus' &&
          description instanceof Uint8Array &&
          description.byteLength >= 12
            ? Math.round(
                (new DataView(
                  description.buffer,
                  description.byteOffset,
                  description.byteLength,
                ).getUint16(10, true) /
                  48_000) *
                  1_000_000,
              )
            : 0;
        const out = await outputBytes(await media().remux(await fixtureSource(id), { to: 'mkv' }));
        const reparsed = demuxWebm(out);
        expect(reparsed.info.container).toBe('mkv');
        expect(reparsed.info.tracks[0]?.codec).toBe(parseOgg(input).codec);
        const frames = reparsed.framesByIndex[0] ?? [];
        expect(frames).toHaveLength(sourcePackets.length);
        for (let index = 0; index < frames.length; index++) {
          const sourcePacket = sourcePackets[index];
          const frame = frames[index];
          if (sourcePacket === undefined || frame === undefined) {
            throw new Error(`${id}: missing packet ${index}`);
          }
          expect(frame.data).toEqual(oggPacketBytes(input, sourcePacket));
          expect(
            Math.abs(frame.timestampUs - (sourcePacket.ptsUs - codecDelayUs)),
          ).toBeLessThanOrEqual(1_000);
        }
      }
    } finally {
      restore();
    }
  });

  it('pure convert (flac → ogg) uses native frame copy without host chunk constructors', async () => {
    const restore = installThrowingEncodedChunkConstructors(
      'native FLAC-to-Ogg convert must not construct EncodedChunk objects',
    );
    try {
      const input = await loadFixture('sfx.flac');
      const out = await outputBytes(
        await media().convert(await fixtureSource('sfx.flac'), { to: 'ogg' }),
      );
      await expectNativeFlacOggCopy(input, out);
    } finally {
      restore();
    }
  });

  it('public Ogg demux reassembles cross-page native FLAC packets byte-exactly', async () => {
    const restore = installEncodedChunkShims();
    try {
      let sawDiscontiguousPacket = false;
      for (const id of FLAC_OGG_FIXTURES) {
        const input = await loadFixture(id);
        const sourceFrames = enumerateFlacFrames(input);
        const ogg = await outputBytes(await media().remux(await fixtureSource(id), { to: 'ogg' }));
        const demuxed = await media().demux(fromBytes(ogg, { mime: 'audio/ogg' }));
        try {
          const track = demuxed.tracks.find((candidate) => candidate.codec === 'flac');
          if (track === undefined) throw new Error(`${id}: public Ogg demux found no FLAC track`);
          const rows = (
            demuxed as typeof demuxed & {
              packetInfoTable?: () => readonly PacketInfoMetadata[];
            }
          ).packetInfoTable?.();
          sawDiscontiguousPacket ||= rows?.some((row) => row.offset === undefined) === true;

          const payloads = await packetPayloads(demuxed.packets(track.id));
          expect(payloads, `${id}: packet count`).toHaveLength(sourceFrames.length);
          for (let index = 0; index < sourceFrames.length; index += 1) {
            const frame = sourceFrames[index];
            const payload = payloads[index];
            if (frame === undefined || payload === undefined) {
              throw new Error(`${id}: missing FLAC packet ${index}`);
            }
            assertBytesEqual(payload, frame.data, `${id}: FLAC packet ${index}`);
          }
        } finally {
          await demuxed.close();
        }
      }
      expect(
        sawDiscontiguousPacket,
        'real corpus must exercise at least one cross-page packet',
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it('public mux (flac packets → mkv) authors Matroska through the single-audio fast path', async () => {
    const restore = installEncodedChunkShims();
    try {
      const demuxed = await FlacDriver.demux(await fixtureSource('sfx.flac'));
      try {
        const track = demuxed.tracks[0];
        if (track === undefined) throw new Error('expected FLAC track');
        const out = await outputBytes(
          await media().mux(
            { audio: { track, packets: demuxed.packets(track.id) } },
            { container: 'mkv' },
          ),
        );
        const info = parseWebm(out);
        expect(info.container).toBe('mkv');
        expect(info.tracks[0]?.codec).toBe('flac');
        expect(info.tracks[0]?.description?.byteLength).toBeGreaterThan(0);
      } finally {
        await demuxed.close();
      }
    } finally {
      restore();
    }
  });

  it('public mux (opus packet array → webm) authors WebM through the single-audio fast path', async () => {
    const restore = installEncodedChunkShims();
    try {
      const demuxed = await OggDriver.demux(await fixtureSource('sfx-opus.ogg'));
      try {
        const track = demuxed.tracks[0];
        if (track === undefined) throw new Error('expected Opus track');
        const reader = demuxed.packets(track.id).getReader();
        const packets: Packet[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            packets.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const out = await outputBytes(
          await media().mux({ audio: { track, packetsArray: packets } }, { container: 'webm' }),
        );
        const info = parseWebm(out);
        expect(info.container).toBe('webm');
        expect(info.tracks[0]?.codec).toBe('opus');
        expect(info.durationSec).toBeGreaterThan(0);
      } finally {
        await demuxed.close();
      }
    } finally {
      restore();
    }
  });

  it('public mux accepts prepared Opus packet arrays through the generic Ogg mux seam', async () => {
    const restore = installEncodedChunkShims();
    try {
      const sourceInfo = parseOgg(await loadFixture('sfx-opus.ogg'));
      const demuxed = await OggDriver.demux(await fixtureSource('sfx-opus.ogg'));
      try {
        const track = demuxed.tracks[0];
        if (track === undefined) throw new Error('expected Opus track');
        const reader = demuxed.packets(track.id).getReader();
        const packets: Packet[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            packets.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        const out = await outputBytes(
          await media().mux({ audio: { track, packetsArray: packets } }, { container: 'ogg' }),
        );
        const info = parseOgg(out);
        expect(info.codec).toBe('opus');
        expect(info.durationSec).toBeCloseTo(sourceInfo.durationSec, 5);
      } finally {
        await demuxed.close();
      }
    } finally {
      restore();
    }
  });

  it('prepared WebM audio packet mux authors Opus WebM directly', async () => {
    const restore = installEncodedChunkShims();
    try {
      const demuxed = await OggDriver.demux(await fixtureSource('sfx-opus.ogg'));
      try {
        const track = demuxed.tracks[0];
        if (track === undefined) throw new Error('expected Opus track');
        const reader = demuxed.packets(track.id).getReader();
        const packets: Packet[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            packets.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const out = muxPreparedWebmAudioPacketTrack({ track, packets, container: 'webm' });
        const info = parseWebm(out);
        expect(info.container).toBe('webm');
        expect(info.tracks[0]?.codec).toBe('opus');
        expect(info.durationSec).toBeGreaterThan(0);
      } finally {
        await demuxed.close();
      }
    } finally {
      restore();
    }
  });

  it('prepared WebM audio packet mux validates target, media type, codec, and packet presence', () => {
    const track = audioTrack('opus');
    expect(() =>
      muxPreparedWebmAudioPacketTrack({
        track,
        packets: [testChunk()],
        container: 'mp4',
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedWebmAudioPacketTrack({
        track: videoTrack(),
        packets: [testChunk()],
        container: 'webm',
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedWebmAudioPacketTrack({
        track: audioTrack('aac'),
        packets: [testChunk()],
        container: 'webm',
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedWebmAudioPacketTrack({
        track,
        packets: [],
        container: 'webm',
      }),
    ).toThrow(MediaError);
  });

  it('prepared WebM audio packet mux authors WebM/MKV codec variants from encoded chunks and packets', () => {
    const opus = muxPreparedWebmAudioPacketTrack({
      track: audioTrack('opus', new Uint8Array([9, 8]).buffer),
      packets: [testChunk(new Uint8Array([0xf8, 0xff, 0xfe]), { duration: null })],
      container: 'webm',
    });
    expect(parseWebm(opus).tracks[0]?.codec).toBe('opus');

    const vorbisData = new Uint8Array([1, 2, 3, 4]);
    const vorbis = muxPreparedWebmAudioPacketTrack({
      track: audioTrack('vorbis'),
      packets: [
        testPacket(vorbisData, {
          dtsUs: 0,
          dataOverride: vorbisData.subarray(0, vorbisData.byteLength - 1),
        }),
      ],
      container: 'webm',
    });
    expect(parseWebm(vorbis).tracks[0]?.codec).toBe('vorbis');

    const flac = muxPreparedWebmAudioPacketTrack({
      track: audioTrack('flac', new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer),
      packets: [testPacket(new Uint8Array([0xff, 0xf8, 0, 0]))],
      container: 'mkv',
    });
    const info = parseWebm(flac);
    expect(info.container).toBe('mkv');
    expect(info.tracks[0]?.codec).toBe('flac');
  });

  it('prepared WebM packet mux authors real MP4 H.264/AAC packet tables as Matroska', async () => {
    const prepared = await preparedMp4PacketTracks('movie_5.mp4');
    expect(prepared.tracks.length).toBeGreaterThan(1);
    const out = muxPreparedWebmPacketTracks({ tracks: prepared.tracks, container: 'mkv' });
    const info = parseWebm(out);
    const codecs = new Set(info.tracks.map((track) => track.codec));
    const declaredDurationSec = prepared.tracks.reduce(
      (duration, entry) => Math.max(duration, entry.track.durationSec ?? 0),
      0,
    );

    expect(info.container).toBe('mkv');
    expect(codecs.has('h264')).toBe(true);
    expect(codecs.has('aac')).toBe(true);
    // Matroska Duration covers the full declared presentation. This real source's AAC track is
    // 5.15483 s while video is 5.00000 s (independently confirmed by ffprobe), so truncating to video
    // would lose genuine declared audio rather than remove explicitly signalled gapless padding.
    expect(info.durationSec).toBeCloseTo(declaredDurationSec, 2);
  });

  it('prepared WebM chunk mux authors real MP4 H.264/AAC packet tables without packet facades', async () => {
    const prepared = await preparedMp4ChunkTracks('movie_5.mp4');
    expect(prepared.tracks.length).toBeGreaterThan(1);
    const out = muxPreparedWebmChunkTracks({ tracks: prepared.tracks, container: 'mkv' });
    const info = parseWebm(out);
    const codecs = new Set(info.tracks.map((track) => track.codec));
    const declaredDurationSec = prepared.tracks.reduce(
      (duration, entry) => Math.max(duration, entry.track.durationSec ?? 0),
      0,
    );

    expect(info.container).toBe('mkv');
    expect(codecs.has('h264')).toBe(true);
    expect(codecs.has('aac')).toBe(true);
    expect(info.durationSec).toBeCloseTo(declaredDurationSec, 2);
  });

  it('prepared WebM chunk mux carries declared alpha into Video/AlphaMode', () => {
    const alpha = new Uint8Array([0x11, 0x22, 0x33]);
    const color = new Uint8Array([0x44, 0x55, 0x66]);
    const out = muxPreparedWebmChunkTracks({
      container: 'webm',
      tracks: [
        {
          track: {
            id: 0,
            mediaType: 'video',
            codec: 'vp8',
            alpha: true,
            durationSec: 1 / 30,
            fps: 30,
            config: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
          },
          chunks: [
            {
              timestampUs: 0,
              durationUs: 33_333,
              key: true,
              data: color,
              alpha,
            },
          ],
        },
      ],
    });
    const parsed = demuxWebm(out);
    expect(parsed.info.tracks[0]?.alpha).toBe(true);
    expect(parsed.framesByIndex[0]?.[0]?.data).toEqual(color);
    expect(parsed.framesByIndex[0]?.[0]?.alpha).toEqual(alpha);
  });

  it('prepared WebM chunk mux rejects unsupported containers and empty inputs', () => {
    const track = videoTrack();
    const chunk: PreparedWebmChunk = {
      timestampUs: 0,
      durationUs: 33_333,
      key: true,
      data: new Uint8Array([1, 2, 3]),
      dtsUs: 0,
    };

    expect(() =>
      muxPreparedWebmChunkTracks({
        tracks: [{ track, chunks: [chunk] }],
        container: 'mp4',
      }),
    ).toThrow(CapabilityError);
    expect(() => muxPreparedWebmChunkTracks({ tracks: [], container: 'mkv' })).toThrow(MediaError);
    expect(() =>
      muxPreparedWebmChunkTracks({ tracks: [{ track, chunks: [] }], container: 'mkv' }),
    ).toThrow(MediaError);
    expect(() =>
      muxPreparedWebmChunkTracks({
        tracks: [{ track, chunks: [{ ...chunk, data: new Uint8Array() }] }],
        container: 'mkv',
      }),
    ).toThrow(MediaError);
    for (const invalidChunk of [
      { ...chunk, timestampUs: Number.NaN },
      { ...chunk, durationUs: Number.NaN },
      { ...chunk, durationUs: -1 },
      { ...chunk, dtsUs: Number.NaN },
    ]) {
      expect(() =>
        muxPreparedWebmChunkTracks({
          tracks: [{ track, chunks: [invalidChunk] }],
          container: 'mkv',
        }),
      ).toThrow(MediaError);
    }
  });

  it('public mux uses the prepared WebM packet-array path for real MP4 packet tables', async () => {
    const prepared = await preparedMp4PacketTracks('movie_5.mp4');
    const streams = {
      tracks: prepared.tracks.map((entry) => ({
        track: entry.track,
        packetsArray: entry.packets,
      })),
    };
    const direct = await streamBytes(
      await muxPreparedWebmPacketStreams(streams, { container: 'mkv' }),
    );
    const routed = await outputBytes(await media().mux(streams, { container: 'mkv' }));

    expect(routed).toEqual(direct);
    expect(parseWebm(routed).tracks.map((track) => track.codec)).toEqual(['h264', 'aac']);
  });

  it('single-track WebM audio mux handles arrays, streams, misses, abort, and stream errors', async () => {
    const opusTrack = audioTrack('opus');
    const opusPacket = testPacket();
    await expect(
      muxSingleTrackWebmAudio(
        { audio: { track: opusTrack, packetsArray: [opusPacket] } },
        {
          container: 'mp4',
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackWebmAudio(
        { audio: { track: opusTrack, packetsArray: [opusPacket] } },
        {
          container: 'webm',
          fragmented: true,
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackWebmAudio({ tracks: {} } as unknown as PacketStreams, { container: 'webm' }),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackWebmAudio(
        { video: { track: opusTrack, packetsArray: [opusPacket] } },
        {
          container: 'webm',
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackWebmAudio(
        {
          audio: { track: opusTrack, packetsArray: [opusPacket] },
          video: { track: videoTrack(), packetsArray: [opusPacket] },
        },
        { container: 'webm' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackWebmAudio(
        { audio: { track: audioTrack('aac'), packetsArray: [opusPacket] } },
        {
          container: 'webm',
        },
      ),
    ).resolves.toBeUndefined();

    const webm = await streamBytes(
      await muxSingleTrackWebmAudio(
        { audio: { track: opusTrack, packetsArray: [opusPacket] } },
        { container: 'webm' },
      ),
    );
    expect(parseWebm(webm).tracks[0]?.codec).toBe('opus');

    const vorbis = await streamBytes(
      await muxSingleTrackWebmAudio(
        {
          tracks: [
            {
              track: audioTrack('vorbis'),
              packets: packetStream([testPacket(new Uint8Array([1, 2, 3]))]),
            },
          ],
        },
        { container: 'webm' },
      ),
    );
    expect(parseWebm(vorbis).tracks[0]?.codec).toBe('vorbis');

    await expect(
      muxSingleTrackWebmAudio(
        { audio: { track: opusTrack, packetsArray: [] } },
        {
          container: 'webm',
        },
      ),
    ).rejects.toThrow(MediaError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      muxSingleTrackWebmAudio(
        { audio: { track: opusTrack, packetsArray: [opusPacket] } },
        {
          container: 'webm',
          signal: aborted.signal,
        },
      ),
    ).rejects.toThrow(MediaError);

    const boom = new Error('packet stream failed');
    await expect(
      muxSingleTrackWebmAudio(
        {
          audio: {
            track: opusTrack,
            packets: new ReadableStream<Packet>({
              pull(): void {
                throw boom;
              },
            }),
          },
        },
        { container: 'webm' },
      ),
    ).rejects.toThrow(boom);
  });

  it('single-track FLAC MKV mux handles stream forms and rejects unsupported shapes honestly', async () => {
    const flacTrack = audioTrack('flac', new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer);
    const packet = testPacket(new Uint8Array([0xff, 0xf8, 0, 0]));
    await expect(
      muxFlacMkv({ video: { track: videoTrack(), packetsArray: [packet] } }, { container: 'mkv' }),
    ).resolves.toBeUndefined();
    await expect(
      muxFlacMkv(
        { audio: { track: audioTrack('opus'), packetsArray: [packet] } },
        {
          container: 'mkv',
        },
      ),
    ).resolves.toBeUndefined();
    await expect(muxFlacMkv({ tracks: [] }, { container: 'mkv' })).resolves.toBeUndefined();

    const fromAudioSlot = await streamBytes(
      await muxFlacMkv(
        { audio: { track: flacTrack, packetsArray: [packet] } },
        {
          container: 'mkv',
        },
      ),
    );
    expect(parseWebm(fromAudioSlot).tracks[0]?.codec).toBe('flac');

    const fromTrackList = await streamBytes(
      await muxFlacMkv(
        { tracks: [{ track: flacTrack, packets: packetStream([packet]) }] },
        { container: 'mkv' },
      ),
    );
    expect(parseWebm(fromTrackList).tracks[0]?.codec).toBe('flac');

    await expect(
      muxFlacMkv({ tracks: [{ track: flacTrack, packetsArray: [] }] }, { container: 'mkv' }),
    ).rejects.toThrow(MediaError);
  });

  it('single-track MP4 packet mux handles real offset packets plus miss, empty, abort, and stream errors', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await loadFixture('movie_5.mp4');
    const table = await Mp4Driver.packetInfo(fromBytes(input, { mime: 'video/mp4' }));
    const track = table.tracks[0];
    if (track === undefined) throw new Error('expected a source track');
    const packets = table.packets
      .filter((row) => row.trackIndex === 0)
      .slice(0, 1)
      .map((row) => packetFromPacketInfo(row, input))
      .filter((packet): packet is Packet => packet !== undefined);
    expect(packets).toHaveLength(1);

    await expect(
      muxSingleTrackMp4({ tracks: [{ track, packetsArray: packets }] }, { container: 'webm' }),
    ).resolves.toBeUndefined();
    await expect(
      muxSingleTrackMp4(
        { tracks: [{ track, packetsArray: packets }] },
        {
          container: 'mp4',
          fragmented: true,
        },
      ),
    ).resolves.toBeUndefined();

    const streamOutput = await streamBytes(
      await muxSingleTrackMp4(
        { tracks: [{ track, packets: packetStream(packets) }] },
        { container: 'mp4', faststart: false },
      ),
    );
    const reparsed = await Mp4Driver.packetInfo(fromBytes(streamOutput, { mime: 'video/mp4' }));
    expect(reparsed.tracks[0]?.codec).toBe(track.codec);
    expect(reparsed.packets).toHaveLength(1);

    await expect(
      muxSingleTrackMp4({ tracks: [{ track, packetsArray: [] }] }, { container: 'mp4' }),
    ).rejects.toThrow(MediaError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      muxSingleTrackMp4(
        { tracks: [{ track, packetsArray: packets }] },
        {
          container: 'mp4',
          signal: aborted.signal,
        },
      ),
    ).rejects.toThrow(MediaError);

    const boom = new Error('mp4 packet stream failed');
    await expect(
      muxSingleTrackMp4(
        {
          tracks: [
            {
              track,
              packets: new ReadableStream<Packet>({
                pull(): void {
                  throw boom;
                },
              }),
            },
          ],
        },
        { container: 'mp4' },
      ),
    ).rejects.toThrow(boom);
  });

  it('cross-container remux (webm vorbis → ogg) preserves declared duration despite laced packet cadence', async () => {
    const restore = installEncodedChunkShims();
    try {
      const sourceInfo = await media().probe(await fixtureSource('bear-multitrack.webm'));
      expect(sourceInfo.tracks.some((track) => track.codec === 'vorbis')).toBe(true);

      const out = await outputBytes(
        await media().remux(await fixtureSource('bear-multitrack.webm'), {
          to: 'ogg',
          trackSelect: ['audio:0'],
        }),
      );
      const info = parseOgg(out);
      expect(info.codec).toBe('vorbis');
      expect(Math.abs(info.durationSec - sourceInfo.durationSec)).toBeLessThanOrEqual(1 / 44_100);
    } finally {
      restore();
    }
  });

  it('combines real multitrack selection with target-native metadata rewrite', async () => {
    const restore = installEncodedChunkShims();
    try {
      const sourceInfo = await media().probe(await fixtureSource('bear-multitrack.webm'));
      const progress: Array<{
        readonly done: number;
        readonly total?: number;
        readonly stage: string;
      }> = [];
      const output = await outputBytes(
        await media().remux(
          await fixtureSource('bear-multitrack.webm'),
          {
            to: 'ogg',
            trackSelect: ['audio:0'],
            tags: { title: 'Selected Vorbis track' },
          },
          { onProgress: (event) => progress.push(event) },
        ),
      );
      const info = parseOgg(output);
      const { title } = readOggVorbisComment(output);
      expect(info.codec).toBe('vorbis');
      expect(Math.abs(info.durationSec - sourceInfo.durationSec)).toBeLessThanOrEqual(1 / 44_100);
      expect(title).toBe('Selected Vorbis track');
      expect(progress.at(-1)).toMatchObject({ done: 2, total: 2, stage: 'metadata:metadata' });
      expect(
        progress.every(
          (event, index) => index === 0 || event.done >= (progress[index - 1]?.done ?? 0),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it('cross-container remux keeps illegal codec/container pairs as typed capability misses', async () => {
    const restore = installEncodedChunkShims();
    try {
      await expect(
        media().remux(await fixtureSource('h265.mp4'), { to: 'ts' }),
      ).rejects.toBeInstanceOf(CapabilityError);
      await expect(
        media().remux(await fixtureSource('h264.mp4'), { to: 'ogg' }),
      ).rejects.toBeInstanceOf(CapabilityError);
    } finally {
      restore();
    }
  });

  it('remux to a container with no muxer (mp4 → mp3 / → aiff) is an honest typed miss', async () => {
    for (const to of ['mp3', 'aiff'] as const) {
      await expect(
        media().remux(await fixtureSource('movie_5.mp4'), { to }),
      ).rejects.toBeInstanceOf(CapabilityError);
    }
  });
});

describe('mux — caller packet streams (public packet seam)', () => {
  const videoTrack: TrackInfo = {
    id: 1,
    mediaType: 'video',
    codec: 'h264',
    config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
  };

  function trackOf(
    tracks: readonly TrackInfo[],
    mediaType: 'video' | 'audio',
  ): TrackInfo | undefined {
    return tracks.find((track) => track.mediaType === mediaType && track.config !== undefined);
  }

  function cancellablePacketStream(onCancel: () => void): ReadableStream<EncodedChunk> {
    return new ReadableStream<EncodedChunk>({
      cancel(): void {
        onCancel();
      },
    });
  }

  it('muxes caller-supplied demux packets into MPEG-TS without re-encoding', async () => {
    const restore = installEncodedChunkShims();
    try {
      for (const id of [
        'h264.mp4',
        'movie_5.mp4',
        'test.mp4',
        'bear-1280x720.mp4',
        'obs-remux-variable-aac.mp4',
      ] as const) {
        const input = await loadFixture(id);
        const demuxed = await media().demux(await fixtureSource(id));
        try {
          const video = trackOf(demuxed.tracks, 'video');
          const audio = trackOf(demuxed.tracks, 'audio');
          const streams: PacketStreams = {
            ...(video ? { video: { track: video, packets: demuxed.packets(video.id) } } : {}),
            ...(audio ? { audio: { track: audio, packets: demuxed.packets(audio.id) } } : {}),
          };

          const out = await outputBytes(await media().mux(streams, { container: 'ts' }));
          expect(out.byteLength).toBeGreaterThan(0);
          expect(out.byteLength % 188).toBe(0);
          expect(
            out.byteLength === input.byteLength && out.every((b, index) => b === input[index]),
          ).toBe(false);

          const parsed = parseTs(out);
          expect(parsed.tracks.find((track) => track.stream.codec === 'h264')).toBeDefined();
          if (audio !== undefined) {
            expect(parsed.tracks.find((track) => track.stream.codec === 'aac')).toBeDefined();
          }
          for (const track of parsed.tracks) {
            expect(track.units.length).toBeGreaterThan(0);
          }
        } finally {
          await demuxed.close();
        }
      }
    } finally {
      restore();
    }
  });

  it('rejects bare packet streams because mux needs TrackInfo, and cancels the unread stream', async () => {
    let cancelled = false;
    const bare = new ReadableStream<EncodedChunk>({
      cancel(): void {
        cancelled = true;
      },
    });
    await expect(
      media().mux({ video: bare } as never, { container: 'mp4' }),
    ).rejects.toBeInstanceOf(InputError);
    expect(cancelled).toBe(true);
  });

  it('rejects malformed packet descriptors before muxing and cancels unread packet streams', async () => {
    let cancelled = 0;
    const packetStream = (): ReadableStream<EncodedChunk> =>
      cancellablePacketStream(() => {
        cancelled++;
      });
    const invalidTrack = { id: 'bad', mediaType: 'video', codec: 'h264' };
    const audioInVideoSlot: TrackInfo = {
      id: 2,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const configlessVideo: TrackInfo = { id: 3, mediaType: 'video', codec: 'h264' };

    for (const streams of [
      { video: 7 as never },
      { video: { track: null, packets: packetStream() } as never },
      { video: { track: invalidTrack, packets: packetStream() } as never },
      { video: { track: audioInVideoSlot, packets: packetStream() } },
      { video: { track: configlessVideo, packets: packetStream() } },
      { video: { track: videoTrack } as never },
    ] satisfies readonly PacketStreams[]) {
      await expect(media().mux(streams, { container: 'mp4' })).rejects.toBeInstanceOf(InputError);
    }
    expect(cancelled).toBe(4);
  });

  it('rejects non-chunk-muxable targets before consuming packet streams', async () => {
    // ADTS/AAC and MP3 now have real EncodedChunk-seam muxers. AIFF remains a raw-PCM DSP target, so it
    // is the honest example here: explicit packet assembly must decline before pulling the input stream.
    await expect(
      media().mux(
        { video: { track: videoTrack, packets: cancellablePacketStream(() => {}) } },
        { container: 'aiff' },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('preflights known tracks and cancels a locked sibling when one target pairing is illegal', async () => {
    let validPulls = 0;
    let validCancels = 0;
    let invalidPulls = 0;
    let invalidCancels = 0;
    const pendingPackets = (
      onPull: () => void,
      onCancel: () => void,
    ): ReadableStream<EncodedChunk> =>
      new ReadableStream<EncodedChunk>(
        {
          pull(): void {
            onPull();
          },
          cancel(): void {
            onCancel();
          },
        },
        { highWaterMark: 0 },
      );
    const opus: TrackInfo = {
      id: 11,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const h264: TrackInfo = {
      id: 12,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'avc1.42E01E', codedWidth: 16, codedHeight: 16 },
    };

    await expect(
      media().mux(
        {
          tracks: [
            {
              track: opus,
              packets: pendingPackets(
                () => validPulls++,
                () => validCancels++,
              ),
            },
            {
              track: h264,
              packets: pendingPackets(
                () => invalidPulls++,
                () => invalidCancels++,
              ),
            },
          ],
        },
        { container: 'ogg' },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(validPulls).toBe(1);
    expect(validCancels).toBe(1);
    expect(invalidPulls).toBe(0);
    expect(invalidCancels).toBe(1);
  });

  // Multi-source / multi-track assembly (PacketStreams.tracks): tracks demuxed from DIFFERENT sources, or
  // ≥2 of one media type, packed into ONE container via the chunk seam. This is the engine op that backs
  // the harness's `video_a_plus_audio_b`, `three_track_assembly`, and `swap_audio_video` mux cases.
  it('assembles video from source A + audio from source B into one MKV (multi-source mux)', async () => {
    const restore = installEncodedChunkShims();
    try {
      const aId = 'bear-1280x720.mp4';
      const bId = 'movie_5.mp4';
      const demuxA = await media().demux(await fixtureSource(aId));
      const demuxB = await media().demux(await fixtureSource(bId));
      try {
        const videoA = trackOf(demuxA.tracks, 'video');
        const audioB = trackOf(demuxB.tracks, 'audio');
        expect(videoA).toBeDefined();
        expect(audioB).toBeDefined();
        if (!videoA || !audioB) return;

        // No `video`/`audio` slot — purely the `tracks[]` arm, with the two tracks from two distinct files.
        const out = await outputBytes(
          await media().mux(
            {
              tracks: [
                { track: videoA, packets: demuxA.packets(videoA.id) },
                { track: audioB, packets: demuxB.packets(audioB.id) },
              ],
            },
            { container: 'mkv' },
          ),
        );
        expect(out.byteLength).toBeGreaterThan(0);
        // The assembled bytes re-demux to exactly the two assembled tracks (video then audio) with blocks.
        const reparsed = parseWebm(out);
        expect(reparsed.tracks.map((t) => t.mediaType)).toEqual(['video', 'audio']);
        expect(reparsed.tracks.find((t) => t.mediaType === 'video')?.codec).toBe('h264');
        expect(reparsed.tracks.find((t) => t.mediaType === 'audio')?.codec).toBe('aac');
        const { framesByIndex } = demuxWebm(out);
        expect(framesByIndex).toHaveLength(2);
        for (const frames of framesByIndex) expect(frames.length).toBeGreaterThan(0);
      } finally {
        await demuxA.close();
        await demuxB.close();
      }
    } finally {
      restore();
    }
  });

  it('assembles three tracks (video + two audio) from multiple sources into one MKV', async () => {
    const restore = installEncodedChunkShims();
    try {
      const demuxA = await media().demux(await fixtureSource('bear-1280x720.mp4'));
      const demuxB = await media().demux(await fixtureSource('movie_5.mp4'));
      const demuxC = await media().demux(await fixtureSource('test.mp4'));
      try {
        const videoA = trackOf(demuxA.tracks, 'video');
        const audioB = trackOf(demuxB.tracks, 'audio');
        const audioC = trackOf(demuxC.tracks, 'audio');
        expect(videoA && audioB && audioC).toBeTruthy();
        if (!videoA || !audioB || !audioC) return;

        const out = await outputBytes(
          await media().mux(
            {
              tracks: [
                { track: videoA, packets: demuxA.packets(videoA.id) },
                { track: audioB, packets: demuxB.packets(audioB.id) },
                { track: audioC, packets: demuxC.packets(audioC.id) },
              ],
            },
            { container: 'mkv' },
          ),
        );
        const { info, framesByIndex } = demuxWebm(out);
        // Three output tracks, in list order: one video + two audio, each with real blocks (no drop).
        expect(info.tracks.map((t) => t.mediaType)).toEqual(['video', 'audio', 'audio']);
        expect(framesByIndex).toHaveLength(3);
        for (const frames of framesByIndex) expect(frames.length).toBeGreaterThan(0);
      } finally {
        await demuxA.close();
        await demuxB.close();
        await demuxC.close();
      }
    } finally {
      restore();
    }
  });

  it('rejects a malformed tracks[] descriptor and cancels the already-supplied streams', async () => {
    let cancelled = 0;
    const ps = (): ReadableStream<EncodedChunk> =>
      cancellablePacketStream(() => {
        cancelled++;
      });
    const goodVideo: TrackInfo = {
      id: 1,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'h264', codedWidth: 16, codedHeight: 16 },
    };
    // First entry is valid; the second is config-less → the whole mux rejects, and BOTH supplied streams
    // (the valid one was never drained) are cancelled so no producer leaks.
    const configless: TrackInfo = { id: 2, mediaType: 'audio', codec: 'aac' };
    await expect(
      media().mux(
        {
          tracks: [
            { track: goodVideo, packets: ps() },
            { track: configless, packets: ps() },
          ],
        },
        { container: 'mkv' },
      ),
    ).rejects.toBeInstanceOf(InputError);
    expect(cancelled).toBe(2);
  });
});

describe('decode — lazy frame streams (contract)', () => {
  it('releases the produced stream lock immediately after EOF', async () => {
    const inner = new ReadableStream<number>({
      start(controller): void {
        controller.enqueue(7);
        controller.close();
      },
    });
    const outer = deferredStream(() => Promise.resolve(inner));
    const reader = outer.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: 7 });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });

    expect(inner.locked).toBe(false);
    reader.releaseLock();
  });

  it('releases the produced stream lock when its reader errors', async () => {
    const failure = new Error('inner-read-failed');
    const inner = new ReadableStream<number>({
      start(controller): void {
        controller.error(failure);
      },
    });
    const outer = deferredStream(() => Promise.resolve(inner));
    const reader = outer.getReader();

    await expect(reader.read()).rejects.toBe(failure);
    expect(inner.locked).toBe(false);
    reader.releaseLock();
  });

  it('cancels and unlocks an inner stream that resolves after downstream cancellation', async () => {
    let resolveInner: ((stream: ReadableStream<number>) => void) | undefined;
    let innerCancelled = 0;
    let markInnerCancelled: (() => void) | undefined;
    const innerCancelledDone = new Promise<void>((resolve) => {
      markInnerCancelled = resolve;
    });
    const inner = new ReadableStream<number>({
      cancel(reason): void {
        expect(reason).toBe('stop-before-route-resolved');
        innerCancelled++;
        markInnerCancelled?.();
      },
    });
    const outer = deferredStream(
      () =>
        new Promise<ReadableStream<number>>((resolve) => {
          resolveInner = resolve;
        }),
    );
    const reader = outer.getReader();
    const pending = reader.read();
    while (resolveInner === undefined) await Promise.resolve();

    const cancelled = reader.cancel('stop-before-route-resolved');
    resolveInner(inner);
    await cancelled;
    await pending;
    await innerCancelledDone;
    while (inner.locked) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(innerCancelled).toBe(1);
    expect(inner.locked).toBe(false);
  });

  it('returns a MediaStreams shape synchronously', () => {
    const streams = media().decode(new Uint8Array([1, 2, 3, 4]));
    expect(streams.video).toBeInstanceOf(ReadableStream);
    expect(streams.audio).toBeInstanceOf(ReadableStream);
  });

  it('rejects when pulled in Node (no WebCodecs decoder), surfacing a typed CapabilityError', async () => {
    const streams = media().decode(await fixtureSource('movie_5.mp4'));
    await expect(readFirstFrame(streams.video)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects an unnormalizable input synchronously (bad input shape)', () => {
    expect(() => media().decode(123 as never)).toThrowError(InputError);
  });

  it('yields an empty stream for a media type the source lacks (no decodable video in a WAV)', async () => {
    // speech.wav has audio only; decode(...).video has no track to route, so its stream closes empty
    // (no error, no frames) rather than raising — the absence of a track is not a capability miss.
    const streams = media().decode(await fixtureSource('speech.wav'));
    const reader = streams.video?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    }
  });

  it('validates video pulls instead of trusting a misleading raw-audio MIME hint', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const streams = media().decode(fromBytes(bytes, { mime: 'audio/wav' }));
    await expect(readFirstFrame(streams.video)).rejects.toBeInstanceOf(MediaError);
  });

  it('routes raw PCM audio decode through the PCM-native path before the WebCodecs codec ladder', async () => {
    // Node has no `AudioData`, so the PCM route must still reject here; the important assertion is that
    // WAV/AIFF/CAF reject at the raw-PCM AudioData bridge, not later as bogus WebCodecs `pcm-*` misses.
    const sources = [
      await fixtureSource('speech.wav'),
      await derivedSource('sfx.aiff', 'audio/aiff'),
      await derivedSource('sfx.caf', 'audio/x-caf'),
    ];
    for (const source of sources) {
      const streams = media().decode(source);
      await expect(readFirstFrame(streams.audio)).rejects.toThrow(
        /AudioData missing for PCM decode/,
      );
    }
  });

  it('routes real s24 WAV decode through exact-owned interleaved transfer chunks', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
    class CapturingAudioData {
      readonly init: AudioDataInit;
      closeCount = 0;

      constructor(init: AudioDataInit) {
        this.init = init;
      }

      close(): void {
        this.closeCount++;
      }
    }
    Object.defineProperty(globalThis, 'AudioData', {
      configurable: true,
      value: CapturingAudioData as unknown as typeof AudioData,
    });
    try {
      const bytes = await loadFixture('sfx-pcm-s24.wav');
      const canonical = readWavPcm(bytes);
      const streams = media().decode(fromBytes(bytes, { mime: 'audio/wav' }));
      const reader = streams.audio?.getReader();
      if (reader === undefined) throw new Error('expected WAV audio frame stream');
      const next = await reader.read();
      expect(next.done).toBe(false);
      const frame = next.value as unknown as CapturingAudioData;
      const frames = Math.min(4096, canonical.frames);
      const expected = new Float32Array(frames * canonical.channels);
      for (let sample = 0; sample < frames; sample++) {
        for (let channel = 0; channel < canonical.channels; channel++) {
          expected[sample * canonical.channels + channel] =
            canonical.planar[channel]?.[sample] ?? 0;
        }
      }
      expect(frame.init).toMatchObject({
        format: 'f32',
        numberOfChannels: canonical.channels,
        numberOfFrames: frames,
        sampleRate: canonical.sampleRate,
        timestamp: 0,
      });
      expect(frame.init.transfer).toEqual([frame.init.data]);
      expect(new Uint32Array(frame.init.data as ArrayBuffer)).toEqual(
        new Uint32Array(expected.buffer),
      );
      frame.close();
      await reader.cancel('first exact chunk is sufficient');
      expect(frame.closeCount).toBe(1);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
      else Object.defineProperty(globalThis, 'AudioData', original);
    }
  });

  it('rejects protected MP4 ciphertext before explicit decrypt', async () => {
    const encrypted = await encryptCenc(await loadFixture('movie_5.mp4'), {
      keyHex: CENC_KEY,
      kidHex: CENC_KID,
      mediaType: 'video',
    });
    const streams = media().decode(fromBytes(encrypted, { mime: 'video/mp4' }));
    await expect(readFirstFrame(streams.video)).rejects.toBeInstanceOf(MediaError);
  });
});

describe('encode — input validation', () => {
  it('rejects empty frame streams with a typed InputError', async () => {
    await expect(media().encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(InputError);
  });

  it('validates WAV frame targets before choosing its PCM-only encode path', async () => {
    const streams = media().decode(await fixtureSource('movie_5.mp4'));
    // The decoded result contains video and audio but the request declares neither target. Shape
    // validation wins before WAV's PCM-only audio route and cancels both deferred streams. Positive
    // PCM WAV frame encode plus video/compressed no-pull declines are covered by wav-frame-encode.test.
    await expect(media().encode(streams, { to: 'wav' })).rejects.toBeInstanceOf(InputError);
  });

  it('rejects a video stream with no video target (InputError) and a video target with no encoder (CapabilityError)', async () => {
    // A frame stream that is never pulled (so no frames are produced) — the engine must cancel it.
    const neverPulled = new ReadableStream<VideoFrame>({ pull() {} });
    await expect(media().encode({ video: neverPulled }, { to: 'mp4' })).rejects.toBeInstanceOf(
      InputError,
    );
    // With a video target, the encode builds the config and routes the encoder, which misses in Node.
    const v2 = new ReadableStream<VideoFrame>({ pull() {} });
    await expect(
      media().encode(
        { video: v2 },
        { to: 'mp4', video: { codec: 'h264', width: 320, height: 240 } },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('routes an audio encoder for an audio stream + target (CapabilityError in Node)', async () => {
    const audio = new ReadableStream<AudioData>({ pull() {} });
    await expect(
      media().encode(
        { audio },
        { to: 'mp4', audio: { codec: 'aac', sampleRate: 48000, channels: 2 } },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('seek — routing + guards', () => {
  it('routes to the video decoder and raises a typed CapabilityError in Node (no WebCodecs)', async () => {
    for (const id of MP4_FIXTURES) {
      await expect(media().seek(await fixtureSource(id), 0)).rejects.toBeInstanceOf(
        CapabilityError,
      );
    }
  });

  it('rejects protected MP4 video seek before explicit decrypt', async () => {
    const encrypted = await encryptCenc(await loadFixture('movie_5.mp4'), {
      keyHex: CENC_KEY,
      kidHex: CENC_KID,
      mediaType: 'video',
    });
    await expect(
      media().seek(fromBytes(encrypted, { mime: 'video/mp4' }), 0),
    ).rejects.toBeInstanceOf(MediaError);
  });

  it('rejects a negative or non-finite seek time with a typed InputError', async () => {
    await expect(media().seek(await fixtureSource('movie_5.mp4'), -1)).rejects.toBeInstanceOf(
      InputError,
    );
    await expect(
      media().seek(await fixtureSource('movie_5.mp4'), Number.NaN),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('exposes .cancel() on the seek handle', async () => {
    const handle = media().seek(await fixtureSource('test.mp4'), 1_000_000);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});
