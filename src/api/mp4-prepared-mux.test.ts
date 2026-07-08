import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, PacketInfoMetadata } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { mp3PacketInfoFromBytes } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { parseFragments } from '../drivers/mp4/parse.ts';
import { fromBytes } from '../sources/source.ts';
import {
  mp4PacketInfoFromBytes,
  mp4PacketInfoFromUrl,
  muxPreparedMp4PacketTrack,
  muxPreparedMp4PacketTracks,
  muxPreparedMp4PacketTracksStream,
} from './mp4-prepared-mux.ts';

const MEDIA_TEST = new URL(
  '../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

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
    expect(reparsed.packets[0]?.ptsUs).toBe(0);
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

  it('reads MP4 packet info from URLs through byte ranges without fetching the whole file', async () => {
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
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.range !== null)).toBe(true);
    expect(calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(input.byteLength);
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
