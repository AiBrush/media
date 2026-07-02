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
import { FlacDriver, parseFlac } from '../drivers/flac/flac-driver.ts';
import { parseMp3 } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { parseTs } from '../drivers/mpegts/ts-parse.ts';
import { OggDriver, parseOgg } from '../drivers/ogg/ogg-driver.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { demuxWebm, parseWebm } from '../drivers/webm/webm-driver.ts';
import { channelAt } from '../dsp/pcm.ts';
import { fromBytes } from '../sources/source.ts';
import { encryptCenc } from '../test-support/cenc-encrypt.ts';
import { fixtureSource, loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';
import {
  muxFlacMkv,
  muxPreparedWebmAudioPacketTrack,
  muxSingleTrackMp4,
  muxSingleTrackWebmAudio,
} from './flac-mkv-mux.ts';
import type { PacketStreams } from './types.ts';

/** Real, stream-copyable MP4s (h264 + aac), ≥3 distinct files of varied duration/tracks. */
const MP4_FIXTURES = ['movie_5.mp4', 'test.mp4', 'h264.mp4'] as const;
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

function installEncodedChunkShims(): () => void {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: TestEncodedChunk as unknown as typeof EncodedVideoChunk,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: TestEncodedChunk as unknown as typeof EncodedAudioChunk,
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

async function outputBytes(output: Blob | File | ReadableStream<Uint8Array> | undefined) {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
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
  it('trims MP3, ADTS, and Ogg/Opus as real shortened packet streams', async () => {
    const restore = installEncodedChunkShims();
    try {
      const mp3 = await outputBytes(
        await media().trim(await fixtureSource('sound_5.mp3'), { start: 1, end: 3 }),
      );
      expect(parseMp3(mp3, mp3.byteLength).durationSec).toBeCloseTo(2, 1);

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

  it('cross-container remux (mp4 → mkv) routes the packet seam → typed miss in Node (browser path)', async () => {
    // mkv now HAS a muxer, so remux proceeds to demux→muxer; the verbatim packet copy needs WebCodecs
    // EncodedChunk (absent in Node) → a typed CapabilityError, never a crash or a wrong/empty container.
    await expect(
      media().remux(await fixtureSource('movie_5.mp4'), { to: 'mkv' }),
    ).rejects.toBeInstanceOf(CapabilityError);
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
            expect(track.units[0]?.data[0]).toBe(0xff);
            expect((track.units[0]?.data[1] ?? 0) & 0xf0).toBe(0xf0);
          }
        }
      }
    } finally {
      restore();
    }
  });

  it('cross-container remux (flac → ogg) accepts foreign native FLAC packets through the muxer seam', async () => {
    const restore = installEncodedChunkShims();
    try {
      const input = await loadFixture('sfx.flac');
      const sourceInfo = parseFlac(input);
      const out = await outputBytes(
        await media().remux(await fixtureSource('sfx.flac'), { to: 'ogg' }),
      );
      expect(out.byteLength).toBeGreaterThan(0);
      expect(
        out.byteLength === input.byteLength && out.every((b, index) => b === input[index]),
      ).toBe(false);

      const info = parseOgg(out);
      expect(info.codec).toBe('flac');
      expect(info.sampleRate).toBe(sourceInfo.sampleRate);
      expect(info.channels).toBe(sourceInfo.channels);
      expect(info.durationSec).toBeCloseTo(sourceInfo.durationSec, 5);
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
    // `aac`/`adts` are still a typed mux miss (no EncodedChunk-seam muxer); `mp3` now HAS one (Mp3Muxer),
    // so it is no longer a valid example of a non-muxable target here.
    await expect(
      media().mux(
        { video: { track: videoTrack, packets: cancellablePacketStream(() => {}) } },
        { container: 'aac' },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
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

  it('rejects a frame-encode target with no encode path as a typed CapabilityError', async () => {
    const streams = media().decode(await fixtureSource('movie_5.mp4'));
    // WAV has a raw-PCM packet muxer, but encode() is the raw-frame→codec path and must not invent a
    // PCM encoder or consume the decoded streams for this unsupported target.
    await expect(media().encode(streams, { to: 'wav' })).rejects.toBeInstanceOf(CapabilityError);
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
