import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, PacketInfoMetadata } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../sources/source.ts';
import { mp4PacketInfoFromBytes, muxPreparedMp4PacketTrack } from './mp4-prepared-mux.ts';

const MEDIA_TEST = new URL(
  '../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

async function mediaTestBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
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

function packetShape(packet: PacketInfoMetadata): {
  readonly size: number;
  readonly ptsUs: number;
  readonly dtsUs: number;
  readonly durationUs: number | undefined;
  readonly keyframe: boolean;
} {
  return {
    size: packet.size,
    ptsUs: packet.ptsUs,
    dtsUs: packet.dtsUs,
    durationUs: packet.durationUs,
    keyframe: packet.keyframe,
  };
}

describe('prepared MP4 packet mux', () => {
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

    const reparsed = await Mp4Driver.packetInfo(fromBytes(output, { mime: 'video/mp4' }));
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
        container: 'mp4',
        fragmented: true,
      }),
    ).toThrow(CapabilityError);
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
        packets: [],
        container: 'mp4',
      }),
    ).toThrow(MediaError);
  });
});
