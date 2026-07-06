import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, PacketInfoMetadata, TrackInfo } from '../contracts/driver.ts';
import { parseTs } from '../drivers/mpegts/ts-parse.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';
import { mp4PacketInfoFromBytes } from './mp4-prepared-mux.ts';
import {
  muxPreparedMpegTsPacketStreams,
  muxPreparedMpegTsPacketTracks,
} from './mpegts-prepared-mux.ts';
import type { Output } from './types.ts';

interface PreparedTrack {
  readonly track: TrackInfo;
  readonly packets: readonly Packet[];
}

async function outputBytes(output: Output): Promise<Uint8Array> {
  if (output === undefined) return new Uint8Array(0);
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  const reader = output.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function throwingChunk(
  row: PacketInfoMetadata,
  data: Uint8Array,
  mediaType: TrackInfo['mediaType'],
): EncodedChunk {
  return {
    byteLength: data.byteLength,
    timestamp: row.ptsUs,
    duration: row.durationUs ?? 0,
    type: row.keyframe || mediaType === 'audio' ? 'key' : 'delta',
    copyTo(): void {
      throw new Error('prepared MPEG-TS mux must use Packet.data');
    },
  } as EncodedChunk;
}

function writableView(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function copyableChunk(
  packet: Packet,
  duration: number | null | undefined = packet.chunk.duration,
): EncodedChunk {
  const data = packet.data;
  if (data === undefined) {
    throw new Error('test fixture packet must include prepared bytes');
  }
  return {
    byteLength: data.byteLength,
    timestamp: packet.chunk.timestamp,
    duration,
    type: packet.chunk.type,
    copyTo(destination: AllowSharedBufferSource): void {
      writableView(destination).set(data);
    },
  } as EncodedChunk;
}

function firstPacket(track: PreparedTrack): Packet {
  const packet = track.packets[0];
  if (packet === undefined) {
    throw new Error('test fixture track must include packets');
  }
  return packet;
}

function packetStream(
  packets: readonly (EncodedChunk | Packet)[],
): ReadableStream<EncodedChunk | Packet> {
  return new ReadableStream<EncodedChunk | Packet>({
    start(controller): void {
      for (const packet of packets) controller.enqueue(packet);
      controller.close();
    },
  });
}

function failingPacketStream(error: Error): ReadableStream<EncodedChunk | Packet> {
  return new ReadableStream<EncodedChunk | Packet>({
    pull(): void {
      throw error;
    },
  });
}

async function preparedTracksFromMp4Fixture(id: string): Promise<readonly PreparedTrack[]> {
  const bytes = await loadFixture(id);
  const table = await mp4PacketInfoFromBytes(bytes);
  const tracks: PreparedTrack[] = [];
  for (let trackIndex = 0; trackIndex < table.tracks.length; trackIndex += 1) {
    const track = table.tracks[trackIndex];
    if (track === undefined || track.config === undefined) continue;
    const packets: Packet[] = [];
    for (const row of table.packets) {
      if (row.trackIndex !== trackIndex || row.offset === undefined) continue;
      const data = bytes.subarray(row.offset, row.offset + row.size);
      packets.push({
        chunk: throwingChunk(row, data, track.mediaType),
        data,
        dtsUs: row.dtsUs,
        sizeBytes: row.size,
      });
    }
    if (packets.length > 0) tracks.push({ track, packets });
  }
  return tracks;
}

describe('prepared MPEG-TS packet mux', () => {
  it('muxes owned packet data into TS without calling EncodedChunk.copyTo()', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    expect(tracks.length).toBeGreaterThanOrEqual(2);

    const bytes = muxPreparedMpegTsPacketTracks({ tracks, container: 'ts' });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength % 188).toBe(0);
    const parsed = parseTs(bytes);
    expect(parsed.tracks.find((track) => track.stream.codec === 'h264')).toBeDefined();
    expect(parsed.tracks.find((track) => track.stream.codec === 'aac')).toBeDefined();
  });

  it('routes public mux(packet arrays → ts) through the prepared byte path', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const direct = muxPreparedMpegTsPacketTracks({ tracks, container: 'ts' });
    const out = await outputBytes(
      await createMedia().mux(
        {
          tracks: tracks.map((track) => ({
            track: track.track,
            packetsArray: track.packets,
          })),
        },
        { container: 'ts' },
      ),
    );
    expect(out).toEqual(direct);
  });

  it('materializes readable packet streams on the public prepared TS path', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const track = tracks[0];
    if (track === undefined) throw new Error('fixture must include at least one track');
    const packet = firstPacket(track);
    const preparedTrack = { track: track.track, packets: [packet] };
    const direct = muxPreparedMpegTsPacketTracks({ tracks: [preparedTrack], container: 'ts' });

    const out = await outputBytes(
      await muxPreparedMpegTsPacketStreams(
        { tracks: [{ track: track.track, packets: packetStream([packet]) }] },
        { container: 'ts' },
      ),
    );

    expect(out).toEqual(direct);
  });

  it('falls back to EncodedChunk.copyTo() when packet-owned bytes are unavailable', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const track = tracks[0];
    if (track === undefined) throw new Error('fixture must include at least one track');
    const packet = firstPacket(track);

    const bytes = muxPreparedMpegTsPacketTracks({
      tracks: [
        {
          track: track.track,
          packets: [
            {
              chunk: copyableChunk(packet),
              ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
              ...(packet.sizeBytes !== undefined ? { sizeBytes: packet.sizeBytes } : {}),
            },
          ],
        },
      ],
      container: 'ts',
    });

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength % 188).toBe(0);
  });

  it('muxes durationless packet and bare-chunk inputs through the prepared writer', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const track = tracks[0];
    if (track === undefined) throw new Error('fixture must include at least one track');
    const packet = firstPacket(track);
    const data = packet.data;
    if (data === undefined) throw new Error('test fixture packet must include prepared bytes');

    const bytes = muxPreparedMpegTsPacketTracks({
      tracks: [
        {
          track: track.track,
          packets: [
            {
              chunk: copyableChunk(packet, null),
              data,
              ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
              ...(packet.sizeBytes !== undefined ? { sizeBytes: packet.sizeBytes } : {}),
            },
            copyableChunk(packet, undefined),
          ],
        },
      ],
      container: 'ts',
    });

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength % 188).toBe(0);
  });

  it('rejects unsupported prepared TS mux requests with typed failures', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const track = tracks[0];
    if (track === undefined) throw new Error('fixture must include at least one track');

    expect(() =>
      muxPreparedMpegTsPacketTracks({ tracks, container: 'ts', fragmented: true }),
    ).toThrow('fragmented');
    expect(() => muxPreparedMpegTsPacketTracks({ tracks, container: 'mp4' })).toThrow(
      "cannot write 'mp4'",
    );
    expect(() => muxPreparedMpegTsPacketTracks({ tracks: [], container: 'ts' })).toThrow(
      'received no tracks',
    );
    expect(() =>
      muxPreparedMpegTsPacketTracks({
        tracks: [{ track: track.track, packets: [] }],
        container: 'ts',
      }),
    ).toThrow('received no packets');

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      muxPreparedMpegTsPacketStreams(
        { tracks: [{ track: track.track, packetsArray: track.packets }] },
        { container: 'ts', signal: aborted.signal },
      ),
    ).rejects.toThrow('operation aborted');
    await expect(
      muxPreparedMpegTsPacketStreams(
        { tracks: [{ track: track.track, packets: packetStream([]) }] },
        { container: 'ts' },
      ),
    ).rejects.toThrow('received no packets');
    await expect(
      muxPreparedMpegTsPacketStreams(
        {
          tracks: [
            {
              track: track.track,
              packets: failingPacketStream(new Error('packet stream exploded')),
            },
          ],
        },
        { container: 'ts' },
      ),
    ).rejects.toThrow('packet stream exploded');
  });

  it('declines non-prepared public TS mux shapes without claiming the route', async () => {
    const tracks = await preparedTracksFromMp4Fixture('movie_5.mp4');
    const video = tracks.find((track) => track.track.mediaType === 'video');
    const audio = tracks.find((track) => track.track.mediaType === 'audio');
    if (video === undefined || audio === undefined) {
      throw new Error('fixture must include video and audio tracks');
    }

    await expect(
      muxPreparedMpegTsPacketStreams(
        { tracks: [{ track: video.track, packetsArray: video.packets }] },
        { container: 'mp4' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxPreparedMpegTsPacketStreams(
        { tracks: [{ track: video.track, packetsArray: video.packets }] },
        { container: 'ts', fragmented: true },
      ),
    ).resolves.toBeUndefined();
    await expect(
      muxPreparedMpegTsPacketStreams({ tracks: [] }, { container: 'ts' }),
    ).resolves.toBeUndefined();
    await expect(
      muxPreparedMpegTsPacketStreams({ tracks: [{ track: video.track }] }, { container: 'ts' }),
    ).resolves.toBeUndefined();
    await expect(
      muxPreparedMpegTsPacketStreams(
        { video: { track: audio.track, packetsArray: audio.packets } },
        { container: 'ts' },
      ),
    ).resolves.toBeUndefined();
  });
});
