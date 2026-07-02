import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  PacketInfoTable,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { type ChunkStruct, writeMp4PacketTrack } from '../drivers/mp4/mux.ts';
import { fromBytes } from '../sources/source.ts';
import type { Container } from './types.ts';

export interface PreparedMp4PacketMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
  readonly container: Container | string;
  readonly faststart?: boolean;
  readonly fragmented?: boolean;
}

export function muxPreparedMp4PacketTrack(input: PreparedMp4PacketMuxInput): Uint8Array {
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
  if (input.packets.length === 0) {
    throw new MediaError('mux-error', 'prepared MP4 packet mux received no packets');
  }
  const chunks: ChunkStruct[] = [];
  for (const packet of input.packets) chunks.push(chunkStructFrom(packet));
  const options: MuxOptions = {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  };
  return writeMp4PacketTrack(input.track, chunks, options);
}

export async function mp4PacketInfoFromBytes(bytes: Uint8Array): Promise<PacketInfoTable> {
  const packetInfo = Mp4Driver.packetInfo;
  if (packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'MP4 packet-info is not available', {
      op: { op: 'demux', container: 'mp4' },
      tried: ['mp4'],
    });
  }
  return packetInfo.call(Mp4Driver, fromBytes(bytes, { mime: 'video/mp4' }));
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
