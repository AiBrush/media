import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, PacketInfoMetadata, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { mp3PacketInfoFromBytes } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { parseFragments } from '../drivers/mp4/parse.ts';
import { writeMp4 } from '../drivers/mp4/write.ts';
import { toStream } from '../sinks/sink.ts';
import { cacheSource } from '../sources/cache.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';
import { muxPreparedMp4PacketStreams } from './flac-mkv-mux.ts';
import {
  mp4PacketInfoFromBytes,
  mp4PacketInfoFromUrl,
  mp4TrimFromUrl,
  muxPreparedMp4PacketTrack,
  muxPreparedMp4PacketTracks,
  muxPreparedMp4PacketTracksStream,
  muxPreparedSparseMp4PacketTrack,
} from './mp4-prepared-mux.ts';

const MEDIA_TEST = new URL('../../../media-test/fixtures/media/', import.meta.url).pathname;

async function mediaTestBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

function rangeServer(bytes: Uint8Array): {
  readonly fetch: typeof fetch;
  readonly calls: Array<{
    readonly method: string;
    readonly range: string | null;
    readonly bytes: number;
  }>;
} {
  const calls: Array<{ method: string; range: string | null; bytes: number }> = [];
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers as { Range?: string } | undefined;
    const range = headers?.Range ?? null;
    if (method === 'HEAD') {
      calls.push({ method, range, bytes: 0 });
      return new Response(null, { status: 200, headers: { 'Content-Length': String(total) } });
    }
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) return new Response('bad range', { status: 416 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, total);
      const slice = bytes.subarray(start, Math.max(start, end));
      calls.push({ method, range, bytes: slice.byteLength });
      return new Response(slice.slice().buffer, {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${start + slice.byteLength - 1}/${total}` },
      });
    }
    calls.push({ method, range, bytes: total });
    return new Response(bytes.slice().buffer, {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function bufferSourceBytes(dst: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(dst)
    ? new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)
    : new Uint8Array(dst);
}

function encodedChunkView(row: PacketInfoMetadata, data: Uint8Array): EncodedChunk {
  return {
    byteLength: data.byteLength,
    timestamp: row.ptsUs,
    duration: row.durationUs ?? null,
    type: row.keyframe ? 'key' : 'delta',
    copyTo(dst: AllowSharedBufferSource): void {
      bufferSourceBytes(dst).set(data);
    },
  } as EncodedChunk;
}

function packetFromRow(row: PacketInfoMetadata, bytes: Uint8Array): Packet | undefined {
  if (row.offset === undefined) return undefined;
  const end = row.offset + row.size;
  if (row.offset < 0 || row.size <= 0 || end > bytes.byteLength) return undefined;
  const data = bytes.slice(row.offset, end);
  return {
    chunk: encodedChunkView(row, data),
    data,
    dtsUs: row.dtsUs,
    sizeBytes: row.size,
  };
}

function isPacket(value: Packet | undefined): value is Packet {
  return value !== undefined;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.byteLength, `${label}: byteLength`).toBe(expected.byteLength);
  for (let index = 0; index < actual.byteLength; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label}: byte ${index} got ${actual[index]} expected ${expected[index]}`);
    }
  }
}

class ObservedSparseTarget {
  size: bigint | undefined;
  readonly writes: Array<{ position: bigint; bytes: Uint8Array }> = [];

  setSize(size: bigint | string): void {
    this.size = typeof size === 'bigint' ? size : BigInt(size);
  }

  write(position: bigint | string, bytes: Uint8Array): void {
    this.writes.push({
      position: typeof position === 'bigint' ? position : BigInt(position),
      bytes: bytes.slice(),
    });
  }
}

function fourccOffset(bytes: Uint8Array, value: string): number {
  const expected = [...value].map((char) => char.charCodeAt(0));
  for (let offset = 0; offset <= bytes.byteLength - expected.length; offset++) {
    if (expected.every((byte, index) => bytes[offset + index] === byte)) return offset;
  }
  return -1;
}

async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<{
  readonly chunks: Uint8Array[];
  readonly bytes: Uint8Array;
}> {
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { chunks, bytes };
}

function packetShape(packet: PacketInfoMetadata): {
  readonly trackIndex: number;
  readonly size: number;
  readonly ptsUs: number;
  readonly dtsUs: number;
  readonly durationUs: number | undefined;
  readonly keyframe: boolean;
} {
  return {
    trackIndex: packet.trackIndex,
    size: packet.size,
    ptsUs: packet.ptsUs,
    dtsUs: packet.dtsUs,
    durationUs: packet.durationUs,
    keyframe: packet.keyframe,
  };
}

function packetInfoChecksum(packets: readonly PacketInfoMetadata[]): number {
  let checksum = 0x811c9dc5;
  const mix = (value: number): void => {
    checksum = Math.imul(checksum ^ (value >>> 0), 0x01000193) >>> 0;
  };
  for (const packet of packets) {
    mix(packet.trackIndex);
    mix(packet.size);
    mix(packet.ptsUs);
    mix(packet.dtsUs);
    mix(packet.durationUs ?? 0);
    mix(packet.keyframe ? 1 : 0);
  }
  return checksum;
}

let retainedMultiWindowAvcFixture: Uint8Array | undefined;

function multiWindowAvcFixture(): Uint8Array {
  if (retainedMultiWindowAvcFixture !== undefined) return retainedMultiWindowAvcFixture;
  const sampleBytes = 2 * 1024 * 1024;
  const sampleCount = 9;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const data = new Uint8Array(sampleBytes);
    const nalBytes = sampleBytes - 4;
    data[0] = (nalBytes >>> 24) & 0xff;
    data[1] = (nalBytes >>> 16) & 0xff;
    data[2] = (nalBytes >>> 8) & 0xff;
    data[3] = nalBytes & 0xff;
    data[4] = index === 0 ? 0x65 : 0x41;
    // first_mb_in_slice=0, then either I (2) or P (0). The payload classifier deliberately has to
    // discover the non-IDR I pictures because only sample 1 is declared in stss.
    data[5] = index % 2 === 1 ? 0xb0 : 0xc0;
    return {
      data,
      durationTicks: 3_000,
      cttsTicks: 0,
      keyframe: index === 0,
    };
  });
  retainedMultiWindowAvcFixture = writeMp4(
    [
      {
        mediaType: 'video',
        sampleEntryType: 'avc1',
        timescale: 90_000,
        width: 16,
        height: 16,
        description: Uint8Array.of(1, 100, 0, 31, 255, 225, 0, 1, 103, 1, 0, 1, 104),
        samples,
      },
    ],
    { faststart: true, brand: 'mp4' },
  );
  return retainedMultiWindowAvcFixture;
}

function topLevelBoxTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size =
      (bytes[offset] ?? 0) * 0x1000000 +
      (bytes[offset + 1] ?? 0) * 0x10000 +
      (bytes[offset + 2] ?? 0) * 0x100 +
      (bytes[offset + 3] ?? 0);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (size < 8 || offset + size > bytes.byteLength) break;
    types.push(type);
    offset += size;
  }
  return types;
}

async function expectFragmentedMp4MatchesPacketInfo(
  output: Uint8Array,
  table: Awaited<ReturnType<typeof mp4PacketInfoFromBytes>>,
): Promise<void> {
  const reparsed = await mp4PacketInfoFromBytes(output);
  expect(reparsed.tracks.map((track) => track.mediaType)).toEqual(
    table.tracks.map((track) => track.mediaType),
  );
  const fragments = parseFragments(output);
  for (let trackIndex = 0; trackIndex < table.tracks.length; trackIndex++) {
    const sourceTrack = table.tracks[trackIndex];
    const reparsedTrack = reparsed.tracks[trackIndex];
    const sourcePackets = table.packets.filter((row) => row.trackIndex === trackIndex);
    const fragment = fragments.get(trackIndex + 1);
    expect(fragment?.sampleCount).toBe(sourcePackets.length);
    if (sourceTrack?.durationSec !== undefined && reparsedTrack?.durationSec !== undefined) {
      expect(reparsedTrack.durationSec).toBeCloseTo(sourceTrack.durationSec, 3);
    }
  }
}

describe('prepared MP4 packet mux', () => {
  it('authors source packets across 0xffffffff through co64 without allocating the virtual extent', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input, { includeOffsets: true });
    const trackIndex = table.tracks.findIndex((track) => track.mediaType === 'video');
    const track = table.tracks[trackIndex];
    const packets = table.packets
      .filter((row) => row.trackIndex === trackIndex)
      .slice(0, 2)
      .map((row) => packetFromRow(row, input))
      .filter(isPacket);
    if (track === undefined || packets.length !== 2) throw new Error('expected two video packets');

    const target = new ObservedSparseTarget();
    const fileSize = 4_294_975_488n;
    const sampleOffsets = [4_096n, 4_294_967_552n];
    const prefix = muxPreparedSparseMp4PacketTrack({
      track,
      packets,
      container: 'mp4',
      target,
      fileSize,
      sampleOffsets,
    });

    expect(target.size).toBe(fileSize);
    expect(prefix.byteLength).toBeLessThan(4_096);
    expect(target.writes.map((write) => write.position)).toEqual([0n, ...sampleOffsets]);
    const firstWrite = target.writes[1];
    const secondWrite = target.writes[2];
    const firstData = packets[0]?.data;
    const secondData = packets[1]?.data;
    if (
      firstWrite === undefined ||
      secondWrite === undefined ||
      firstData === undefined ||
      secondData === undefined
    ) {
      throw new Error('expected two sparse packet writes with retained packet bytes');
    }
    expectBytesEqual(firstWrite.bytes, firstData, 'first sparse sample');
    expectBytesEqual(secondWrite.bytes, secondData, 'second sparse sample');

    const co64 = fourccOffset(prefix, 'co64');
    expect(co64).toBeGreaterThan(3);
    const co64View = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    expect(co64View.getUint32(co64 + 8)).toBe(2);
    expect(co64View.getBigUint64(co64 + 12)).toBe(sampleOffsets[0]);
    expect(co64View.getBigUint64(co64 + 20)).toBe(sampleOffsets[1]);
    expect(fourccOffset(prefix, 'stco')).toBe(-1);

    const mdat = fourccOffset(prefix, 'mdat');
    expect(mdat).toBeGreaterThan(3);
    expect(co64View.getUint32(mdat - 4)).toBe(1);
    expect(co64View.getBigUint64(mdat + 4)).toBe(fileSize - BigInt(mdat - 4));
  });

  it('rejects malformed sparse extents, offset cardinality, overlap, and decimal input', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input, { includeOffsets: true });
    const trackIndex = table.tracks.findIndex((track) => track.mediaType === 'video');
    const track = table.tracks[trackIndex];
    const packets = table.packets
      .filter((row) => row.trackIndex === trackIndex)
      .slice(0, 2)
      .map((row) => packetFromRow(row, input))
      .filter(isPacket);
    if (track === undefined || packets.length !== 2) throw new Error('expected two video packets');
    const base = {
      track,
      packets,
      container: 'mp4',
      target: new ObservedSparseTarget(),
      fileSize: 4_294_975_488n,
      sampleOffsets: [4_096n, 4_294_967_552n],
    } as const;

    expect(() => muxPreparedSparseMp4PacketTrack({ ...base, fileSize: 0xffff_ffffn })).toThrow(
      MediaError,
    );
    expect(() => muxPreparedSparseMp4PacketTrack({ ...base, sampleOffsets: [4_096n] })).toThrow(
      InputError,
    );
    expect(() =>
      muxPreparedSparseMp4PacketTrack({ ...base, sampleOffsets: [4_096n, 4_097n] }),
    ).toThrow(MediaError);
    expect(() => muxPreparedSparseMp4PacketTrack({ ...base, fileSize: '4GiB' })).toThrow(
      InputError,
    );
    expect(() => muxPreparedSparseMp4PacketTrack({ ...base, fileSize: -1n })).toThrow(InputError);
    expect(() =>
      muxPreparedSparseMp4PacketTrack({ ...base, sampleOffsets: [-1n, 4_294_967_552n] }),
    ).toThrow(InputError);

    const oversizedTarget = new ObservedSparseTarget();
    const uint64Overflow = 0x1_0000_0000_0000_0000n;
    expect(() =>
      muxPreparedSparseMp4PacketTrack({
        ...base,
        target: oversizedTarget,
        fileSize: uint64Overflow,
      }),
    ).toThrow(InputError);
    expect(() =>
      muxPreparedSparseMp4PacketTrack({
        ...base,
        target: oversizedTarget,
        fileSize: uint64Overflow.toString(),
      }),
    ).toThrow(InputError);
    expect(() =>
      muxPreparedSparseMp4PacketTrack({
        ...base,
        target: oversizedTarget,
        sampleOffsets: [4_096n, uint64Overflow],
      }),
    ).toThrow(InputError);
    expect(oversizedTarget.size).toBeUndefined();
    expect(oversizedTarget.writes).toEqual([]);
  });

  it('accepts decimal-string sparse extents and offsets without losing 64-bit precision', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input, { includeOffsets: true });
    const trackIndex = table.tracks.findIndex((track) => track.mediaType === 'video');
    const track = table.tracks[trackIndex];
    const packet = table.packets
      .filter((row) => row.trackIndex === trackIndex)
      .map((row) => packetFromRow(row, input))
      .find(isPacket);
    if (track === undefined || packet === undefined) throw new Error('expected one video packet');
    const target = new ObservedSparseTarget();

    muxPreparedSparseMp4PacketTrack({
      track,
      packets: [packet],
      container: 'mov',
      target,
      fileSize: '4294975488',
      sampleOffsets: ['4294967552'],
    });

    expect(target.size).toBe(4_294_975_488n);
    expect(target.writes.map((write) => write.position)).toEqual([0n, 4_294_967_552n]);
  });

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('authors a fresh MP4 from real packet-info offsets and preserves the single sample', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await Mp4Driver.packetInfo(fromBytes(input, { mime: 'video/mp4' }));
    const track = table.tracks[0];
    if (track === undefined) throw new Error('expected one source track');
    const packets = table.packets.map((row) => packetFromRow(row, input)).filter(isPacket);
    expect(packets).toHaveLength(table.packets.length);

    const output = muxPreparedMp4PacketTrack({
      track,
      packets,
      container: 'mp4',
      faststart: true,
    });

    expect(output.byteLength).toBeGreaterThan(0);
    expect(
      output.byteLength === input.byteLength &&
        output.every((byte, index) => byte === input[index]),
    ).toBe(false);

    const reparsed = await mp4PacketInfoFromBytes(output);
    expect(reparsed.tracks).toHaveLength(1);
    expect(reparsed.tracks[0]?.codec).toBe(track.codec);
    expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
  });

  it('accepts encoded chunks and packets whose direct byte view cannot be reused', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const track = table.tracks[0];
    const row = table.packets[0];
    if (track === undefined || row === undefined || row.offset === undefined) {
      throw new Error('expected one offset-backed source packet');
    }
    const data = input.slice(row.offset, row.offset + row.size);

    const fromChunk = muxPreparedMp4PacketTrack({
      track,
      packets: [encodedChunkView(row, data)],
      container: 'mp4',
    });
    expect(
      (await Mp4Driver.packetInfo(fromBytes(fromChunk, { mime: 'video/mp4' }))).packets,
    ).toHaveLength(1);

    const fromPacketFallback = muxPreparedMp4PacketTrack({
      track,
      packets: [
        {
          chunk: encodedChunkView(row, data),
          data: data.subarray(0, Math.max(0, data.byteLength - 1)),
          sizeBytes: row.size,
        },
      ],
      container: 'mov',
    });
    const reparsed = await Mp4Driver.packetInfo(
      fromBytes(fromPacketFallback, { mime: 'video/mp4' }),
    );
    expect(reparsed.tracks[0]?.codec).toBe(track.codec);
    expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
  });

  it('recovers prepared packet durations when WebCodecs chunks omit duration', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const track = table.tracks[0];
    const row = table.packets[0];
    if (track === undefined || row === undefined || row.offset === undefined) {
      throw new Error('expected one offset-backed source packet');
    }
    const data = input.slice(row.offset, row.offset + row.size);
    const { durationUs: _durationUs, ...rowWithoutDuration } = row;
    const first: PacketInfoMetadata = {
      ...rowWithoutDuration,
      ptsUs: 0,
      dtsUs: 0,
      keyframe: true,
    };
    const second: PacketInfoMetadata = {
      ...rowWithoutDuration,
      ptsUs: 33_333,
      dtsUs: 33_333,
      keyframe: false,
    };

    const output = muxPreparedMp4PacketTrack({
      track,
      packets: [
        encodedChunkView(first, data),
        {
          chunk: encodedChunkView(second, data),
          data,
          dtsUs: second.dtsUs,
          sizeBytes: second.size,
        },
      ],
      container: 'mp4',
      faststart: false,
    });

    const reparsed = await mp4PacketInfoFromBytes(output);
    expect(reparsed.packets).toHaveLength(2);
    expect(reparsed.packets[0]?.durationUs).toBeGreaterThan(0);
  });

  it('authors a multi-track MP4 from prepared video and audio packets', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    expect(table.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));

    const output = muxPreparedMp4PacketTracks({
      tracks,
      container: 'mp4',
      faststart: true,
    });

    const reparsed = await mp4PacketInfoFromBytes(output);
    expect(reparsed.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
  });

  it('does not turn prepared Matroska AAC priming into a leading video edit', async () => {
    const videoTrack: TrackInfo = {
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      fps: 30,
      config: {
        codec: 'avc1.42C01E',
        codedWidth: 32,
        codedHeight: 18,
        description: Uint8Array.of(1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 0),
      },
    };
    const audioTrack: TrackInfo = {
      id: 2,
      mediaType: 'audio',
      codec: 'aac',
      codecDelayNs: 42_666_667,
      config: {
        codec: 'aac',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: Uint8Array.of(0x11, 0x90),
      },
    };
    const packet = (
      ptsUs: number,
      dtsUs: number,
      durationUs: number,
      keyframe: boolean,
      data: Uint8Array,
    ): Packet => {
      const row: PacketInfoMetadata = {
        trackIndex: 0,
        size: data.byteLength,
        ptsUs,
        dtsUs,
        durationUs,
        keyframe,
      };
      return {
        chunk: encodedChunkView(row, data),
        data,
        dtsUs,
        sizeBytes: data.byteLength,
      };
    };
    const videoPackets = [
      packet(0, 0, 33_333, true, Uint8Array.of(0x12, 0x34)),
      packet(33_333, 33_333, 33_333, false, Uint8Array.of(0x56, 0x78)),
    ];
    const audioPackets = Array.from({ length: 4 }, (_, index) =>
      packet(
        Math.round(((index * 1024 - 2048) * 1_000_000) / 48_000),
        Math.round((index * 1024 * 1_000_000) / 48_000),
        Math.round((1024 * 1_000_000) / 48_000),
        true,
        Uint8Array.of(0x21, index),
      ),
    );

    const output = muxPreparedMp4PacketTracks({
      tracks: [
        { track: videoTrack, packets: videoPackets },
        { track: audioTrack, packets: audioPackets },
      ],
      container: 'mp4',
    });
    const reparsed = await mp4PacketInfoFromBytes(output);
    const firstVideo = reparsed.packets.find((row) => row.trackIndex === 0);
    const reparsedAudio = reparsed.tracks.find((track) => track.mediaType === 'audio');
    expect(firstVideo?.ptsUs).toBe(0);
    expect(reparsedAudio?.gapless?.leadingSamples).toBe(2048);
  });

  it('fuses untouched first-party MP4 and ADTS packet streams byte-identically without host chunks', async () => {
    const audioBytes = await mediaTestBytes('aac_adts.aac');
    const originalVideo = globalThis.EncodedVideoChunk;
    const originalAudio = globalThis.EncodedAudioChunk;
    let constructions = 0;
    class TestChunk {
      readonly type: EncodedVideoChunkType;
      readonly timestamp: number;
      readonly duration: number | null;
      readonly byteLength: number;
      readonly #bytes: Uint8Array;
      constructor(init: EncodedVideoChunkInit) {
        constructions++;
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? null;
        this.#bytes = Uint8Array.from(bufferSourceBytes(init.data));
        this.byteLength = this.#bytes.byteLength;
      }
      copyTo(dst: AllowSharedBufferSource): void {
        bufferSourceBytes(dst).set(this.#bytes);
      }
    }
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: TestChunk,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: TestChunk,
    });
    try {
      const media = createMedia({ worker: false });
      for (const fixture of ['h264_1080p_30s.mp4', 'h264_vfr.mp4'] as const) {
        const videoBytes = await mediaTestBytes(fixture);
        const beforeGeneric = constructions;
        const genericVideo = await media.demux(fromBytes(videoBytes, { mime: 'video/mp4' }));
        const genericAudio = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
        const videoTrack = genericVideo.tracks.find((track) => track.mediaType === 'video');
        const audioTrack = genericAudio.tracks[0];
        if (videoTrack === undefined || audioTrack === undefined)
          throw new Error('missing source tracks');
        const generic = await media.mux(
          {
            video: {
              track: videoTrack,
              packets: genericVideo.packets(videoTrack.id).pipeThrough(new TransformStream()),
            },
            audio: {
              track: audioTrack,
              packets: genericAudio.packets(audioTrack.id).pipeThrough(new TransformStream()),
            },
          },
          { container: 'mp4', faststart: true },
        );
        if (!(generic instanceof Blob)) throw new Error('expected generic MP4 Blob');
        const genericBytes = new Uint8Array(await generic.arrayBuffer());
        const afterGeneric = constructions;
        expect(afterGeneric).toBeGreaterThan(beforeGeneric);

        const fusedVideo = await media.demux(fromBytes(videoBytes, { mime: 'video/mp4' }));
        const fusedAudio = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
        const fusedVideoTrack = fusedVideo.tracks.find((track) => track.mediaType === 'video');
        const fusedAudioTrack = fusedAudio.tracks[0];
        if (fusedVideoTrack === undefined || fusedAudioTrack === undefined)
          throw new Error('missing fused tracks');
        const fused = await media.mux(
          {
            video: {
              track: { ...fusedVideoTrack },
              packets: fusedVideo.packets(fusedVideoTrack.id),
            },
            audio: {
              track: structuredClone(fusedAudioTrack),
              packets: fusedAudio.packets(fusedAudioTrack.id),
            },
          },
          { container: 'mp4', faststart: true },
        );
        if (!(fused instanceof Blob)) throw new Error('expected fused MP4 Blob');
        expect(constructions).toBe(afterGeneric);
        expectBytesEqual(
          new Uint8Array(await fused.arrayBuffer()),
          genericBytes,
          `native packet fusion ${fixture}`,
        );
      }
    } finally {
      if (originalVideo === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
      else
        Object.defineProperty(globalThis, 'EncodedVideoChunk', {
          configurable: true,
          value: originalVideo,
        });
      if (originalAudio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      else
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: originalAudio,
        });
    }
  });

  it('aborts native MP4 window materialization and tears down the ADTS sibling', async () => {
    const originalVideo = globalThis.EncodedVideoChunk;
    const originalAudio = globalThis.EncodedAudioChunk;
    class NeverConstructedChunk {}
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: NeverConstructedChunk,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: NeverConstructedChunk,
    });
    const videoBytes = await mediaTestBytes('h264_vfr.mp4');
    const audioBytes = await mediaTestBytes('aac_adts.aac');
    const controller = new AbortController();
    let abortReads = false;
    const source: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/mp4',
      size: videoBytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        if (abortReads) controller.abort('abort native sample window');
        return Promise.resolve(videoBytes.subarray(start, end));
      },
      stream: () => new Blob([Uint8Array.from(videoBytes).buffer]).stream(),
    };
    const media = createMedia({ worker: false });
    const video = await media.demux(source);
    const audio = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
    const videoTrack = video.tracks.find((track) => track.mediaType === 'video');
    const audioTrack = audio.tracks[0];
    if (videoTrack === undefined || audioTrack === undefined)
      throw new Error('missing abort tracks');
    abortReads = true;
    try {
      await expect(
        media.mux(
          {
            video: { track: videoTrack, packets: video.packets(videoTrack.id) },
            audio: { track: audioTrack, packets: audio.packets(audioTrack.id) },
          },
          { container: 'mp4', faststart: true },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'aborted' });
    } finally {
      if (originalVideo === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
      else
        Object.defineProperty(globalThis, 'EncodedVideoChunk', {
          configurable: true,
          value: originalVideo,
        });
      if (originalAudio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      else
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: originalAudio,
        });
    }
  });

  it('rejects an actual short native MP4 sample window and settles every claimed stream', async () => {
    const originalVideo = globalThis.EncodedVideoChunk;
    const originalAudio = globalThis.EncodedAudioChunk;
    let hostConstructions = 0;
    class ForbiddenChunk {
      constructor() {
        hostConstructions++;
        throw new Error('short native read fell back to host chunks');
      }
    }
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: ForbiddenChunk,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: ForbiddenChunk,
    });
    try {
      const videoBytes = await mediaTestBytes('h264_vfr.mp4');
      const audioBytes = await mediaTestBytes('aac_adts.aac');
      let shortReads = false;
      const source: Source = {
        __media: 'source',
        kind: 'url',
        mimeHint: 'video/mp4',
        size: videoBytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          const actualEnd = shortReads && end > start ? end - 1 : end;
          return Promise.resolve(videoBytes.subarray(start, actualEnd));
        },
        stream: () => new Blob([Uint8Array.from(videoBytes).buffer]).stream(),
      };
      const media = createMedia({ worker: false });
      const video = await media.demux(source);
      const audio = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
      const videoTrack = video.tracks.find((track) => track.mediaType === 'video');
      const audioTrack = audio.tracks[0];
      if (videoTrack === undefined || audioTrack === undefined)
        throw new Error('missing short-read tracks');
      const videoPackets = video.packets(videoTrack.id);
      const audioPackets = audio.packets(audioTrack.id);
      shortReads = true;
      await expect(
        media.mux(
          {
            video: { track: videoTrack, packets: videoPackets },
            audio: { track: audioTrack, packets: audioPackets },
          },
          { container: 'mp4', faststart: true },
        ),
      ).rejects.toMatchObject({
        code: 'demux-error',
        message: expect.stringContaining('short read'),
      });
      expect(hostConstructions).toBe(0);
      await expect(videoPackets.getReader().read()).resolves.toMatchObject({ done: true });
      await expect(audioPackets.getReader().read()).resolves.toMatchObject({ done: true });
    } finally {
      if (originalVideo === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
      else
        Object.defineProperty(globalThis, 'EncodedVideoChunk', {
          configurable: true,
          value: originalVideo,
        });
      if (originalAudio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      else
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: originalAudio,
        });
    }
  });

  it('routes complete multi-track packet arrays through the prepared MP4 stream byte-identically', async () => {
    const input = await mediaTestBytes('h264_1080p_30s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));
    const video = tracks.find(({ track }) => track.mediaType === 'video');
    const audio = tracks.find(({ track }) => track.mediaType === 'audio');
    if (video === undefined || audio === undefined)
      throw new Error('expected video and audio arrays');

    const expected = muxPreparedMp4PacketTracks({ tracks, container: 'mp4', faststart: true });
    const stream = await muxPreparedMp4PacketStreams(
      {
        video: { track: video.track, packetsArray: video.packets },
        audio: { track: audio.track, packetsArray: audio.packets },
      },
      { container: 'mp4', faststart: true },
    );
    if (stream === undefined) throw new Error('expected prepared multi-track MP4 route');
    const { bytes } = await collectChunks(stream);

    expectBytesEqual(bytes, expected, 'prepared multitrack stream');
    const reparsed = await mp4PacketInfoFromBytes(bytes);
    expect(reparsed.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));

    const expectedMov = muxPreparedMp4PacketTracks({
      tracks,
      container: 'mov',
      faststart: true,
    });
    const movStream = await muxPreparedMp4PacketStreams(
      {
        video: { track: video.track, packetsArray: video.packets },
        audio: { track: audio.track, packetsArray: audio.packets },
      },
      { container: 'mov', faststart: true },
    );
    if (movStream === undefined) throw new Error('expected prepared multi-track MOV route');
    const { bytes: movBytes } = await collectChunks(movStream);
    expectBytesEqual(movBytes, expectedMov, 'prepared multitrack MOV stream');
    const reparsedMov = await mp4PacketInfoFromBytes(movBytes);
    expect(reparsedMov.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
  });

  it('routes public buffered and streaming MOV array mux through exact prepared output', async () => {
    const input = await mediaTestBytes('h264_1080p_30s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));
    const streams = {
      tracks: tracks.map((entry) => ({
        track: entry.track,
        packetsArray: entry.packets,
      })),
    };
    const expected = muxPreparedMp4PacketTracks({ tracks, container: 'mov', faststart: true });
    const media = createMedia({ worker: false });

    const generic = await media.mux(
      {
        tracks: tracks.map((entry) => ({
          track: entry.track,
          packets: new ReadableStream<Packet>({
            start(controller): void {
              for (const packet of entry.packets) controller.enqueue(packet);
              controller.close();
            },
          }),
        })),
      },
      { container: 'mov', faststart: true },
    );
    if (!(generic instanceof Blob)) throw new Error('expected generic MOV Blob');
    expectBytesEqual(
      new Uint8Array(await generic.arrayBuffer()),
      expected,
      'prepared MOV vs retained generic control',
    );

    const buffered = await media.mux(streams, { container: 'mov', faststart: true });
    if (!(buffered instanceof Blob)) throw new Error('expected buffered MOV Blob');
    expectBytesEqual(new Uint8Array(await buffered.arrayBuffer()), expected, 'public buffered MOV');

    const streamed = await media.mux(streams, {
      container: 'mov',
      faststart: true,
      sink: toStream(),
    });
    if (!(streamed instanceof ReadableStream)) throw new Error('expected streaming MOV output');
    const { bytes: streamedBytes, chunks } = await collectChunks(streamed);
    expect(chunks.length).toBeGreaterThan(2);
    expectBytesEqual(streamedBytes, expected, 'public streaming MOV');

    const aborted = new AbortController();
    aborted.abort('prepared MOV cancellation');
    await expect(
      media.mux(streams, { container: 'mov' }, { signal: aborted.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('enforces the prepared multitrack MP4 crossover and leaves excluded shapes generic', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));
    const video = tracks.find(({ track }) => track.mediaType === 'video');
    const audio = tracks.find(({ track }) => track.mediaType === 'audio');
    const videoPacket = video?.packets[0];
    const audioPacket = audio?.packets[0];
    if (
      video === undefined ||
      audio === undefined ||
      videoPacket === undefined ||
      audioPacket === undefined
    ) {
      throw new Error('expected video and audio packets');
    }
    const arrays = (videoCount: number, audioCount: number) => ({
      video: {
        track: video.track,
        packetsArray: Array.from({ length: videoCount }, () => videoPacket),
      },
      audio: {
        track: audio.track,
        packetsArray: Array.from({ length: audioCount }, () => audioPacket),
      },
    });

    await expect(
      muxPreparedMp4PacketStreams(arrays(128, 127), { container: 'mp4' }),
    ).resolves.toBeUndefined();
    const selected = await muxPreparedMp4PacketStreams(arrays(128, 128), { container: 'mp4' });
    expect(selected).toBeInstanceOf(ReadableStream);
    await selected?.cancel();
    const selectedMov = await muxPreparedMp4PacketStreams(arrays(128, 128), {
      container: 'mov',
    });
    expect(selectedMov).toBeInstanceOf(ReadableStream);
    await selectedMov?.cancel();
    await expect(
      muxPreparedMp4PacketStreams(arrays(128, 128), {
        container: 'mp4',
        faststart: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      muxPreparedMp4PacketStreams(arrays(128, 128), {
        container: 'mp4',
        fragmented: true,
      }),
    ).resolves.toBeUndefined();
    const readable = new ReadableStream<Packet>({
      start(controller): void {
        controller.enqueue(audioPacket);
        controller.close();
      },
    });
    await expect(
      muxPreparedMp4PacketStreams(
        {
          video: arrays(128, 128).video,
          audio: {
            track: audio.track,
            packets: readable,
            packetsArray: Array.from({ length: 128 }, () => audioPacket),
          },
        },
        { container: 'mp4' },
      ),
    ).resolves.toBeUndefined();
    await readable.cancel();
  });

  it('stops the selected multitrack route after a packet copy aborts the operation', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const videoTrackIndex = table.tracks.findIndex((track) => track.mediaType === 'video');
    const audioTrackIndex = table.tracks.findIndex((track) => track.mediaType === 'audio');
    const videoTrack = table.tracks[videoTrackIndex];
    const audioTrack = table.tracks[audioTrackIndex];
    const videoRow = table.packets.find((row) => row.trackIndex === videoTrackIndex);
    const audioRow = table.packets.find((row) => row.trackIndex === audioTrackIndex);
    if (
      videoTrack === undefined ||
      audioTrack === undefined ||
      videoRow?.offset === undefined ||
      audioRow?.offset === undefined
    ) {
      throw new Error('expected offset-backed video and audio packets');
    }
    const videoData = input.slice(videoRow.offset, videoRow.offset + videoRow.size);
    const audioData = input.slice(audioRow.offset, audioRow.offset + audioRow.size);
    const controller = new AbortController();
    let copied = 0;
    const aborting = {
      ...encodedChunkView(videoRow, videoData),
      copyTo(destination: AllowSharedBufferSource): void {
        copied++;
        bufferSourceBytes(destination).set(videoData);
        controller.abort();
      },
    } as EncodedChunk;
    const afterAbort = {
      ...encodedChunkView(videoRow, videoData),
      copyTo(destination: AllowSharedBufferSource): void {
        copied++;
        bufferSourceBytes(destination).set(videoData);
      },
    } as EncodedChunk;

    await expect(
      muxPreparedMp4PacketStreams(
        {
          video: {
            track: videoTrack,
            packetsArray: [aborting, afterAbort, ...Array.from({ length: 126 }, () => afterAbort)],
          },
          audio: {
            track: audioTrack,
            packetsArray: Array.from({ length: 128 }, () => encodedChunkView(audioRow, audioData)),
          },
        },
        { container: 'mp4', signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(MediaError);
    expect(copied).toBe(1);
  });

  it('stops prepared packet-array conversion when a packet copy aborts the operation', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const track = table.tracks[0];
    const row = table.packets[0];
    if (track === undefined || row === undefined || row.offset === undefined) {
      throw new Error('expected one offset-backed source packet');
    }
    const data = input.slice(row.offset, row.offset + row.size);
    const controller = new AbortController();
    let copied = 0;
    const aborting = {
      ...encodedChunkView(row, data),
      copyTo(destination: AllowSharedBufferSource): void {
        copied++;
        bufferSourceBytes(destination).set(data);
        controller.abort();
      },
    } as EncodedChunk;

    expect(() =>
      muxPreparedMp4PacketTracks({
        tracks: [{ track, packets: [aborting, encodedChunkView(row, data)] }],
        container: 'mp4',
        signal: controller.signal,
      }),
    ).toThrowError(MediaError);
    expect(copied).toBe(1);
  });

  it('checks cancellation after the terminal packet copy and rejects empty prepared tracks', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const track = table.tracks[0];
    const row = table.packets[0];
    if (track === undefined || row?.offset === undefined) {
      throw new Error('expected one offset-backed source packet');
    }
    const data = input.slice(row.offset, row.offset + row.size);
    const controller = new AbortController();
    let copied = 0;
    const terminalAbortingChunk = {
      ...encodedChunkView(row, data),
      copyTo(destination: AllowSharedBufferSource): void {
        copied++;
        bufferSourceBytes(destination).set(data);
        controller.abort();
      },
    } as EncodedChunk;

    expect(() =>
      muxPreparedMp4PacketTracks({
        tracks: [{ track, packets: [terminalAbortingChunk] }],
        container: 'mp4',
        signal: controller.signal,
      }),
    ).toThrowError(MediaError);
    expect(copied).toBe(1);

    expect(() =>
      muxPreparedMp4PacketTracks({
        tracks: [{ track, packets: [] }],
        container: 'mp4',
      }),
    ).toThrowError(/track 1 received no packets/);
  });

  it('authors fragmented CMAF from prepared multi-track packets', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));

    const output = muxPreparedMp4PacketTracks({
      tracks,
      container: 'mp4',
      fragmented: true,
    });

    const boxes = topLevelBoxTypes(output);
    expect(boxes[0]).toBe('ftyp');
    expect(boxes[1]).toBe('moov');
    expect(boxes).toContain('moof');
    expect(boxes).toContain('mdat');
    await expectFragmentedMp4MatchesPacketInfo(output, table);
  });

  it('authors real MP3 frame packet-info rows into an MP4 audio sample table', async () => {
    const input = await mediaTestBytes('mp3_xing.mp3');
    const table = mp3PacketInfoFromBytes(input);
    const track = table.tracks[0];
    if (track === undefined) throw new Error('expected one MP3 source track');
    const packets = table.packets.map((row) => packetFromRow(row, input)).filter(isPacket);
    expect(packets).toHaveLength(table.packets.length);

    const output = muxPreparedMp4PacketTrack({
      track,
      packets,
      container: 'mp4',
      faststart: true,
      fragmented: false,
    });

    const reparsed = await mp4PacketInfoFromBytes(output);
    expect(reparsed.tracks).toHaveLength(1);
    expect(reparsed.tracks[0]?.mediaType).toBe('audio');
    expect(reparsed.tracks[0]?.codec).toBe('mp4a.6b');
    expect(reparsed.packets).toHaveLength(table.packets.length);
    expect(reparsed.packets.map((row) => row.size)).toEqual(table.packets.map((row) => row.size));
    const sampleRate =
      track.config !== undefined && 'sampleRate' in track.config
        ? track.config.sampleRate
        : undefined;
    const leadingSamples = track.gapless?.leadingSamples;
    if (sampleRate === undefined || leadingSamples === undefined) {
      throw new Error('expected the MP3 Xing/LAME fixture to expose audio priming metadata');
    }
    expect(reparsed.packets[0]?.ptsUs).toBe(-Math.round((leadingSamples * 1_000_000) / sampleRate));
  });

  it('exposes payload offsets for medium MP4 packet-table mux preparation', async () => {
    const input = await mediaTestBytes('h264_1080p_30s.mp4');
    const table = await mp4PacketInfoFromBytes(input);

    expect(table.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    expect(table.packets).toHaveLength(2308);
    expect(table.packets.every((row) => row.offset !== undefined)).toBe(true);
    for (const row of table.packets) {
      expect(row.offset).toBeGreaterThanOrEqual(0);
      expect((row.offset ?? 0) + row.size).toBeLessThanOrEqual(input.byteLength);
    }
  });

  it('forces payload offsets from already-loaded MP4 bytes without driver packet-info', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const originalPacketInfo = Mp4Driver.packetInfo;
    Object.defineProperty(Mp4Driver, 'packetInfo', { configurable: true, value: undefined });
    try {
      const table = await mp4PacketInfoFromBytes(input, { includeOffsets: true });
      expect(table.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
      expect(table.packets.length).toBeGreaterThan(1);
      expect(table.packets.every((row) => row.offset !== undefined)).toBe(true);

      const tracks = table.tracks.map((track, trackIndex) => ({
        track,
        packets: table.packets
          .filter((row) => row.trackIndex === trackIndex)
          .map((row) => packetFromRow(row, input))
          .filter(isPacket),
      }));

      const output = muxPreparedMp4PacketTracks({
        tracks,
        container: 'mp4',
        faststart: true,
      });
      const reparsed = await mp4PacketInfoFromBytes(output, { includeOffsets: true });
      expect(reparsed.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
      expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
    } finally {
      Object.defineProperty(Mp4Driver, 'packetInfo', {
        configurable: true,
        value: originalPacketInfo,
      });
    }
  });

  it('keeps forced-offset byte helpers on the authoritative fragmented packet path', async () => {
    const input = await loadFixture('bear-open-gop-frag.mp4');
    const direct = await mp4PacketInfoFromBytes(input, { includeOffsets: true });
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const authoritative = await packetInfo.call(Mp4Driver, fromBytes(input, { mime: 'video/mp4' }));

    expect(direct.tracks).toEqual(authoritative.tracks);
    expect(direct.packets).toEqual(authoritative.packets);
    expect(direct.packets.length).toBeGreaterThan(0);
    expect(direct.packets.every((packet) => packet.offset !== undefined)).toBe(true);
  });

  it('streams prepared multi-track MP4 payloads as incremental chunks', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));

    const { chunks, bytes } = await collectChunks(
      muxPreparedMp4PacketTracksStream({
        tracks,
        container: 'mp4',
        faststart: false,
      }),
    );

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]?.byteLength).toBeLessThan(64);
    const reparsed = await mp4PacketInfoFromBytes(bytes);
    expect(reparsed.tracks.map((track) => track.mediaType)).toEqual(['video', 'audio']);
    expect(reparsed.packets.map(packetShape)).toEqual(table.packets.map(packetShape));
  });

  it('streams prepared fragmented MP4 as init and media segments', async () => {
    const input = await mediaTestBytes('tiny_h264_360p_2s.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const tracks = table.tracks.map((track, trackIndex) => ({
      track,
      packets: table.packets
        .filter((row) => row.trackIndex === trackIndex)
        .map((row) => packetFromRow(row, input))
        .filter(isPacket),
    }));

    const { chunks, bytes } = await collectChunks(
      muxPreparedMp4PacketTracksStream({
        tracks,
        container: 'mp4',
        fragmented: true,
      }),
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(topLevelBoxTypes(chunks[0] ?? new Uint8Array())).toEqual(['ftyp', 'moov']);
    expect(topLevelBoxTypes(bytes)).toContain('moof');
    await expectFragmentedMp4MatchesPacketInfo(bytes, table);
  });

  it('rolls prepared MP4 stream payload chunks at the bounded target size', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await mp4PacketInfoFromBytes(input);
    const track = table.tracks[0];
    const row = table.packets[0];
    if (track === undefined || row === undefined || row.offset === undefined) {
      throw new Error('expected one offset-backed source packet');
    }
    const data = input.slice(row.offset, row.offset + row.size);
    const repeatedPackets = Array.from({ length: 80 }, (_, index): Packet => {
      const timestampUs = index * 33_333;
      const repeatedRow: PacketInfoMetadata = {
        ...row,
        ptsUs: timestampUs,
        dtsUs: timestampUs,
        durationUs: 33_333,
        keyframe: true,
      };
      return {
        chunk: encodedChunkView(repeatedRow, data),
        data,
        dtsUs: repeatedRow.dtsUs,
        sizeBytes: data.byteLength,
      };
    });

    const { chunks, bytes } = await collectChunks(
      muxPreparedMp4PacketTracksStream({
        tracks: [{ track, packets: repeatedPackets }],
        container: 'mp4',
      }),
    );

    const boundedPayloadBytes = data.byteLength * Math.floor((256 * 1024) / data.byteLength);
    expect(chunks.map((chunk) => chunk.byteLength)).toContain(boundedPayloadBytes);
    const reparsed = await mp4PacketInfoFromBytes(bytes);
    expect(reparsed.packets).toHaveLength(repeatedPackets.length);
    expect(reparsed.packets.map((packet) => packet.size)).toEqual(
      Array.from({ length: repeatedPackets.length }, () => data.byteLength),
    );
  });

  it('reads exact MP4 packet info from URLs through bounded byte ranges', async () => {
    const input = await mediaTestBytes('h264_vfr.mp4');
    const expected = await mp4PacketInfoFromBytes(input);
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;

    const table = await mp4PacketInfoFromUrl('https://example.test/h264_vfr.mp4', {
      mime: 'video/mp4',
      size: input.byteLength,
    });

    expect(table.tracks).toEqual(expected.tracks);
    expect(table.packets.map(packetShape)).toEqual(expected.packets.map(packetShape));
    // AVC key-picture truth requires payload inspection when dependency metadata is absent. Keep the
    // latency-friendly prefix prime, then allow one payload range; never fall back to a rangeless GET.
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.range !== null)).toBe(true);
    expect(calls[0]?.range).toBe('bytes=0-32767');
    expect(calls[1]?.range?.endsWith(`-${input.byteLength - 1}`)).toBe(true);
    expect(calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThanOrEqual(
      input.byteLength + 32 * 1024,
    );
  });

  it('copy-trims a same-family MP4 directly from bounded URL ranges', async () => {
    const input = await mediaTestBytes('h264_vfr.mp4');
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;

    const output = await mp4TrimFromUrl('https://example.test/h264_vfr.mp4', {
      mime: 'video/mp4',
      size: input.byteLength,
      startSec: 0,
      endSec: 1,
      container: 'mp4',
    });
    const source = await mp4PacketInfoFromBytes(input);
    const trimmed = await mp4PacketInfoFromBytes(output);

    expect(output.byteLength).toBeGreaterThan(0);
    expect(trimmed.tracks.map((track) => track.mediaType)).toEqual(
      source.tracks.map((track) => track.mediaType),
    );
    expect(trimmed.packets.length).toBeGreaterThan(0);
    expect(trimmed.packets.length).toBeLessThan(source.packets.length);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.range !== null)).toBe(true);
    expect(calls.reduce((total, call) => total + call.bytes, 0)).toBeLessThanOrEqual(
      input.byteLength,
    );
  });

  it('reuses only parsed facts for an exact finite blob URL and returns defensive snapshots', async () => {
    const input = await mediaTestBytes('scenarios/performance/op-sweep-demux/01.mp4');
    const expected = await mp4PacketInfoFromBytes(input);
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;
    const url = 'blob:https://example.test/immutable-packet-info';
    const opts = { mime: 'video/mp4', size: input.byteLength } as const;

    const first = await mp4PacketInfoFromUrl(url, opts);
    const firstTrack = first.tracks[0];
    if (firstTrack === undefined) throw new Error('expected first cached track');
    firstTrack.codec = 'poisoned';
    (first.packets[0] as { size: number }).size = 1;

    const second = await mp4PacketInfoFromUrl(url, opts);
    expect(second.tracks).toEqual(expected.tracks);
    expect(second.packets).toEqual(expected.packets);
    expect(second).not.toBe(first);
    expect(second.tracks).not.toBe(first.tracks);
    expect(second.packets).not.toBe(first.packets);
    expect(calls).toEqual([
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
    ]);

    const secondTrack = second.tracks[0];
    if (secondTrack === undefined) throw new Error('expected second cached track');
    secondTrack.codec = 'also-poisoned';
    (second.packets[0] as { size: number }).size = 2;
    const third = await mp4PacketInfoFromUrl(url, opts);
    expect(third.tracks).toEqual(expected.tracks);
    expect(third.packets).toEqual(expected.packets);
    expect(calls).toHaveLength(1);
  });

  it('separates finite blob MIME and packet-info provider identities', async () => {
    const input = await mediaTestBytes('scenarios/performance/op-sweep-demux/01.mp4');
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;
    const url = 'blob:https://example.test/semantic-packet-info';
    const originalPacketInfo = Mp4Driver.packetInfo;
    if (originalPacketInfo === undefined) throw new Error('expected MP4 packetInfo');

    await mp4PacketInfoFromUrl(url, { mime: 'video/mp4', size: input.byteLength });
    await mp4PacketInfoFromUrl(url, { mime: 'video/quicktime', size: input.byteLength });
    expect(calls).toHaveLength(2);

    let replacementCalls = 0;
    const replacement: NonNullable<typeof Mp4Driver.packetInfo> = async (source, options) => {
      replacementCalls++;
      return originalPacketInfo.call(Mp4Driver, source, options);
    };
    Object.defineProperty(Mp4Driver, 'packetInfo', {
      configurable: true,
      value: replacement,
    });
    try {
      await mp4PacketInfoFromUrl(url, { mime: 'video/mp4', size: input.byteLength });
      await mp4PacketInfoFromUrl(url, { mime: 'video/mp4', size: input.byteLength });
      expect(replacementCalls).toBe(1);
      expect(calls).toHaveLength(3);
    } finally {
      Object.defineProperty(Mp4Driver, 'packetInfo', {
        configurable: true,
        value: originalPacketInfo,
      });
    }
  });

  it('never publishes failed or aborted finite blob packet-table attempts', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const server = rangeServer(input);
    const originalPacketInfo = Mp4Driver.packetInfo;
    if (originalPacketInfo === undefined) throw new Error('expected MP4 packetInfo');
    let providerCalls = 0;
    const fallible: NonNullable<typeof Mp4Driver.packetInfo> = async (source, options) => {
      providerCalls++;
      if (providerCalls === 1) throw new Error('intentional packet-info failure');
      return originalPacketInfo.call(Mp4Driver, source, options);
    };
    Object.defineProperty(Mp4Driver, 'packetInfo', {
      configurable: true,
      value: fallible,
    });
    globalThis.fetch = server.fetch;
    const failedUrl = 'blob:https://example.test/fallible-packet-info';
    try {
      await expect(mp4PacketInfoFromUrl(failedUrl, { size: input.byteLength })).rejects.toThrow(
        'intentional packet-info failure',
      );
      await mp4PacketInfoFromUrl(failedUrl, { size: input.byteLength });
      await mp4PacketInfoFromUrl(failedUrl, { size: input.byteLength });
      expect(providerCalls).toBe(2);
      expect(server.calls).toHaveLength(2);
    } finally {
      Object.defineProperty(Mp4Driver, 'packetInfo', {
        configurable: true,
        value: originalPacketInfo,
      });
    }

    const abortServer = rangeServer(input);
    const controller = new AbortController();
    let abortFirstRead = true;
    globalThis.fetch = (async (request, init): Promise<Response> => {
      const response = await abortServer.fetch(request, init);
      if (abortFirstRead) {
        abortFirstRead = false;
        controller.abort(new MediaError('aborted', 'cancel packet-info miss'));
      }
      return response;
    }) as typeof fetch;
    const abortedUrl = 'blob:https://example.test/aborted-packet-info';
    await expect(
      mp4PacketInfoFromUrl(abortedUrl, {
        size: input.byteLength,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    await mp4PacketInfoFromUrl(abortedUrl, { size: input.byteLength });
    expect(abortServer.calls).toHaveLength(2);
  });

  it('bounds retained URL windows across multi-window AVC classification without changing packet truth', async () => {
    const input = multiWindowAvcFixture();
    const expected = await mp4PacketInfoFromBytes(input);
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const raw: Source = {
      __media: 'source',
      kind: 'url',
      size: input.byteLength,
      mimeHint: 'video/mp4',
      stream(): ReadableStream<Uint8Array> {
        throw new Error('multi-window AVC packet info must stay range-backed');
      },
      range(start, end, signal): Promise<Uint8Array> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        ranges.push({ start, end });
        return Promise.resolve(input.slice(start, end));
      },
    };
    const maxBytes = 8 * 1024 * 1024;
    const cached = cacheSource(raw, { maxBytes });
    await cached.prime([{ start: 0, end: 32 * 1024 }]);
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('expected MP4 packetInfo');

    const table = await packetInfo.call(Mp4Driver, cached);

    expect(table.tracks).toEqual(expected.tracks);
    expect(table.packets.map(packetShape)).toEqual(expected.packets.map(packetShape));
    expect(packetInfoChecksum(table.packets)).toBe(packetInfoChecksum(expected.packets));
    expect(table.packets.flatMap((packet, index) => (packet.keyframe ? [index] : []))).toEqual([
      0, 1, 3, 5, 7,
    ]);
    expect(ranges.filter(({ start, end }) => end - start > 32 * 1024)).toHaveLength(2);
    expect(ranges.every(({ start, end }) => end - start <= maxBytes)).toBe(true);
    expect(cached.cachedBytes).toBeLessThanOrEqual(maxBytes);
  });

  it('stops multi-window URL classification after abort without retaining past the cap', async () => {
    const input = multiWindowAvcFixture();
    const controller = new AbortController();
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const raw: Source = {
      __media: 'source',
      kind: 'url',
      size: input.byteLength,
      mimeHint: 'video/mp4',
      stream(): ReadableStream<Uint8Array> {
        throw new Error('multi-window AVC packet info must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        ranges.push({ start, end });
        if (end - start > 32 * 1024) controller.abort(new MediaError('aborted', 'stop AVC walk'));
        return Promise.resolve(input.slice(start, end));
      },
    };
    const maxBytes = 8 * 1024 * 1024;
    const cached = cacheSource(raw, { maxBytes });
    await cached.prime([{ start: 0, end: 32 * 1024 }]);
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('expected MP4 packetInfo');

    await expect(
      packetInfo.call(Mp4Driver, cached, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(ranges.filter(({ start, end }) => end - start > 32 * 1024)).toHaveLength(1);
    expect(cached.cachedBytes).toBeLessThanOrEqual(maxBytes);
  });

  it('uses complete sdtp picture dependencies without reading H.264 payload ranges', async () => {
    const input = await mediaTestBytes('scenarios/performance/op-sweep-demux/01.mp4');
    const expected = await mp4PacketInfoFromBytes(input);
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;

    const table = await mp4PacketInfoFromUrl('https://example.test/sdtp-h264.mp4', {
      mime: 'video/mp4',
      size: input.byteLength,
    });

    expect(table.tracks).toEqual(expected.tracks);
    expect(table.packets.map(packetShape)).toEqual(expected.packets.map(packetShape));
    const videoPackets = table.packets.filter((packet) => packet.trackIndex === 0);
    expect(videoPackets.flatMap((packet, index) => (packet.keyframe ? [index] : []))).toEqual([
      0, 76, 152, 228, 304,
    ]);
    expect(input.byteLength).toBeGreaterThan(32 * 1024);
    expect(calls).toEqual([
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
    ]);
  });

  it('uses a fresh bounded URL snapshot when rebuilding MP4 packet tables', async () => {
    const input = await mediaTestBytes('scenarios/performance/op-sweep-demux/01.mp4');
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;
    const url = 'https://example.test/repeated-sdtp-h264.mp4';
    const opts = { mime: 'video/mp4', size: input.byteLength } as const;

    const first = await mp4PacketInfoFromUrl(url, opts);
    const second = await mp4PacketInfoFromUrl(url, opts);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.packets).not.toBe(first.packets);
    expect(calls).toEqual([
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
    ]);
  });

  it('never reuses URL packet truth across same-href same-size replacements', async () => {
    const make = (durationTicks: number): Uint8Array =>
      writeMp4([
        {
          mediaType: 'audio',
          sampleEntryType: 'mp4a',
          timescale: 48_000,
          sampleRate: 48_000,
          channels: 2,
          description: Uint8Array.of(0x11, 0x90),
          samples: [
            {
              data: Uint8Array.of(1),
              durationTicks,
              cttsTicks: 0,
              keyframe: true,
            },
          ],
        },
      ]);
    const firstBytes = make(1_024);
    const secondBytes = make(2_048);
    expect(secondBytes).toHaveLength(firstBytes.byteLength);
    const firstServer = rangeServer(firstBytes);
    globalThis.fetch = firstServer.fetch;
    const url = 'https://example.test/replaced-in-place.mp4';
    const first = await mp4PacketInfoFromUrl(url, { size: firstBytes.byteLength });
    const secondServer = rangeServer(secondBytes);
    globalThis.fetch = secondServer.fetch;
    const second = await mp4PacketInfoFromUrl(url, { size: secondBytes.byteLength });

    expect(first.packets[0]?.durationUs).toBe(21_333);
    expect(second.packets[0]?.durationUs).toBe(42_667);
    expect(firstServer.calls).toHaveLength(1);
    expect(secondServer.calls).toHaveLength(1);
  });

  it('does not retain raw URL ranges for sources above the aggregate cache ceiling', async () => {
    const input = await mediaTestBytes('scenarios/performance/op-sweep-demux/01.mp4');
    const padded = new Uint8Array(8 * 1024 * 1024 + 1);
    padded.set(input);
    const { fetch, calls } = rangeServer(padded);
    globalThis.fetch = fetch;
    const url = 'https://example.test/oversize-sdtp-h264.mp4';
    const opts = { mime: 'video/mp4', size: padded.byteLength } as const;

    const first = await mp4PacketInfoFromUrl(url, opts);
    const second = await mp4PacketInfoFromUrl(url, opts);

    expect(second).toEqual(first);
    expect(calls).toEqual([
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
      {
        method: 'GET',
        range: 'bytes=0-32767',
        bytes: 32 * 1024,
      },
    ]);
  });

  it('reads URL packet info with default MIME, discovered size, and an explicit signal', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const expected = await mp4PacketInfoFromBytes(input);
    const { fetch, calls } = rangeServer(input);
    globalThis.fetch = fetch;
    const controller = new AbortController();

    const table = await mp4PacketInfoFromUrl(
      new URL('https://example.test/micro_h264_1frame.mp4'),
      { signal: controller.signal },
    );

    expect(table.tracks).toEqual(expected.tracks);
    expect(table.packets.map(packetShape)).toEqual(expected.packets.map(packetShape));
    // The URL path primes a single bounded prefix range (MP4_PACKET_INFO_URL_PRIME_BYTES = 32 KiB), not an
    // unbounded full-file GET — so every request is a `bytes=0-…` prefix range, never a rangeless read.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.range?.startsWith('bytes=0-') === true)).toBe(true);
  });

  it('honors aborted signals for MP4 packet-info byte reads', async () => {
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const controller = new AbortController();
    controller.abort();

    await expect(mp4PacketInfoFromBytes(input, { signal: controller.signal })).rejects.toThrow(
      MediaError,
    );
    await expect(
      mp4PacketInfoFromBytes(input, { includeOffsets: true, signal: controller.signal }),
    ).rejects.toThrow(MediaError);

    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      throw new Error('pre-aborted URL packet info must not fetch');
    }) as unknown as typeof fetch;
    await expect(
      mp4PacketInfoFromUrl('https://example.test/pre-aborted.mp4', {
        size: input.byteLength,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchCalls).toBe(0);
  });

  it('reports a typed miss when MP4 packet-info is not registered', async () => {
    const originalPacketInfo = Mp4Driver.packetInfo;
    Object.defineProperty(Mp4Driver, 'packetInfo', { configurable: true, value: undefined });
    try {
      await expect(mp4PacketInfoFromBytes(new Uint8Array([0]))).rejects.toThrow(CapabilityError);
    } finally {
      Object.defineProperty(Mp4Driver, 'packetInfo', {
        configurable: true,
        value: originalPacketInfo,
      });
    }
  });

  it('rejects unsupported prepared MP4 packet mux requests with typed errors', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await Mp4Driver.packetInfo(fromBytes(input, { mime: 'video/mp4' }));
    const track = table.tracks[0];
    const packet = table.packets.map((row) => packetFromRow(row, input)).find(isPacket);
    if (track === undefined || packet === undefined) throw new Error('expected a packet');

    expect(() =>
      muxPreparedMp4PacketTrack({
        track,
        packets: [packet],
        container: 'webm',
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedMp4PacketTrack({
        track,
        packets: [packet],
        container: 'mov',
        fragmented: true,
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedMp4PacketTrack({
        track,
        packets: [],
        container: 'mp4',
      }),
    ).toThrow(MediaError);
  });

  it('rejects unsupported prepared MP4 packet stream mux requests with typed errors', async () => {
    if (Mp4Driver.packetInfo === undefined) throw new Error('expected MP4 packetInfo');
    const input = await mediaTestBytes('micro_h264_1frame.mp4');
    const table = await Mp4Driver.packetInfo(fromBytes(input, { mime: 'video/mp4' }));
    const track = table.tracks[0];
    const packet = table.packets.map((row) => packetFromRow(row, input)).find(isPacket);
    if (track === undefined || packet === undefined) throw new Error('expected a packet');

    expect(() =>
      muxPreparedMp4PacketTracksStream({
        tracks: [{ track, packets: [packet] }],
        container: 'webm',
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedMp4PacketTracksStream({
        tracks: [{ track, packets: [packet] }],
        container: 'mov',
        fragmented: true,
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      muxPreparedMp4PacketTracksStream({
        tracks: [],
        container: 'mp4',
      }),
    ).toThrow(MediaError);
  });
});
