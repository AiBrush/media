import type { EncodedChunk, Packet, TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { ChunkStruct } from './ogg-write.ts';
import { trackStateFrom, writeOgg } from './ogg-write.ts';

export interface PreparedOggAudioPacketMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
}

/** Prepared single-track Ogg audio authoring for callers that already own packet bytes. */
export function muxPreparedOggAudioPacketTrack(input: PreparedOggAudioPacketMuxInput): Uint8Array {
  const state = trackStateFrom(input.track);
  if (input.packets.length === 0) {
    throw new MediaError('mux-error', 'Ogg mux received no packets');
  }
  for (const packet of input.packets) state.chunks.push(chunkStructFrom(packet));
  return writeOgg(state);
}

function chunkStructFrom(value: Packet | EncodedChunk): ChunkStruct {
  if (isPacket(value)) {
    const chunk = value.chunk;
    return {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data: packetBytes(value),
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

function encodedChunkBytes(chunk: EncodedChunk): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

function packetBytes(packet: Packet): Uint8Array {
  return packet.data !== undefined && packet.data.byteLength === packet.chunk.byteLength
    ? packet.data
    : encodedChunkBytes(packet.chunk);
}
