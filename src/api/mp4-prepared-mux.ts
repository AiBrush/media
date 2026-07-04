import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  PacketInfoTable,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import type { ChunkStruct, Mp4PacketTrackInput } from '../drivers/mp4/mux.ts';
import { streamMp4PacketTracks, writeMp4PacketTracks } from '../drivers/mp4/prepared-stream.ts';
import { cacheSource } from '../sources/cache.ts';
import { fromBytes, fromURL } from '../sources/source.ts';
import type { Container } from './types.ts';

const MP4_PACKET_INFO_URL_PRIME_BYTES = 8 * 1024;

export interface PreparedMp4PacketMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
  readonly container: Container | string;
  readonly faststart?: boolean;
  readonly fragmented?: boolean;
}

export interface PreparedMp4PacketTrackMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
}

export interface PreparedMp4PacketTracksMuxInput {
  readonly tracks: readonly PreparedMp4PacketTrackMuxInput[];
  readonly container: Container | string;
  readonly faststart?: boolean;
  readonly fragmented?: boolean;
}

export interface Mp4PacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

export function muxPreparedMp4PacketTrack(input: PreparedMp4PacketMuxInput): Uint8Array {
  return muxPreparedMp4PacketTracks({
    ...input,
    tracks: [{ track: input.track, packets: input.packets }],
  });
}

export function muxPreparedMp4PacketTracks(input: PreparedMp4PacketTracksMuxInput): Uint8Array {
  if (input.fragmented === true) {
    throw new CapabilityError(
      'capability-miss',
      'prepared MP4 packet mux does not author fragmented output',
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.container !== 'mp4' && input.container !== 'mov') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MP4 packet mux cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', 'prepared MP4 packet mux received no tracks');
  }
  const options: MuxOptions = {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  };
  return writeMp4PacketTracks(packetTrackInputsFrom(input.tracks), options);
}

export function muxPreparedMp4PacketTracksStream(
  input: PreparedMp4PacketTracksMuxInput,
): ReadableStream<Uint8Array> {
  if (input.fragmented === true) {
    throw new CapabilityError(
      'capability-miss',
      'prepared MP4 packet stream mux does not author fragmented output',
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.container !== 'mp4' && input.container !== 'mov') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MP4 packet stream mux cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', 'prepared MP4 packet stream mux received no tracks');
  }
  const options: MuxOptions = {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  };
  return streamMp4PacketTracks(packetTrackInputsFrom(input.tracks), options);
}

export async function mp4PacketInfoFromBytes(bytes: Uint8Array): Promise<PacketInfoTable> {
  return mp4PacketInfoFromSource(fromBytes(bytes, { mime: 'video/mp4' }));
}

export async function mp4PacketInfoFromUrl(
  url: string | URL,
  opts: Mp4PacketInfoFromUrlOptions = {},
): Promise<PacketInfoTable> {
  const src = cacheSource(
    fromURL(url, {
      mime: opts.mime ?? 'video/mp4',
      ...(opts.size !== undefined ? { size: opts.size } : {}),
    }),
  );
  await src.prime([
    {
      start: 0,
      end:
        opts.size !== undefined
          ? Math.min(opts.size, MP4_PACKET_INFO_URL_PRIME_BYTES)
          : MP4_PACKET_INFO_URL_PRIME_BYTES,
    },
  ]);
  return mp4PacketInfoFromSource(src, opts.signal);
}

async function mp4PacketInfoFromSource(
  src: Parameters<NonNullable<typeof Mp4Driver.packetInfo>>[0],
  signal?: AbortSignal,
): Promise<PacketInfoTable> {
  const packetInfo = Mp4Driver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'MP4 packet-info is not available', {
      op: { op: 'demux', container: 'mp4' },
      tried: ['mp4'],
    });
  }
  return packetInfo.call(Mp4Driver, src, signal !== undefined ? { signal } : undefined);
}

function chunkStructFrom(value: Packet | EncodedChunk): ChunkStruct {
  if (isPacket(value)) {
    return {
      timestampUs: value.chunk.timestamp,
      durationUs: value.chunk.duration ?? undefined,
      key: value.chunk.type === 'key',
      data: packetBytes(value),
      ...(value.dtsUs !== undefined ? { dtsUs: value.dtsUs } : {}),
    };
  }
  return {
    timestampUs: value.timestamp,
    durationUs: value.duration ?? undefined,
    key: value.type === 'key',
    data: encodedChunkBytes(value),
  };
}

function packetTrackInputsFrom(
  tracks: readonly PreparedMp4PacketTrackMuxInput[],
): Mp4PacketTrackInput[] {
  const out: Mp4PacketTrackInput[] = [];
  for (const track of tracks) {
    const chunks: ChunkStruct[] = [];
    for (const packet of track.packets) chunks.push(chunkStructFrom(packet));
    out.push({ track: track.track, chunks });
  }
  return out;
}

function isPacket(value: Packet | EncodedChunk): value is Packet {
  return 'chunk' in value;
}

function packetBytes(packet: Packet): Uint8Array {
  return packet.data !== undefined && packet.data.byteLength === packet.chunk.byteLength
    ? packet.data
    : encodedChunkBytes(packet.chunk);
}

function encodedChunkBytes(chunk: EncodedChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}
