import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import {
  type MpegTsChunk,
  type MpegTsPacketTrackInput,
  writeMpegTsPacketTracks,
} from '../drivers/mpegts/ts-write.ts';
import type { Container, PacketStream, PacketStreams } from './types.ts';

interface ReadableStreamLike {
  readonly getReader?: unknown;
}

export interface PreparedMpegTsPacketTrackInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
}

export interface PreparedMpegTsPacketMuxInput {
  readonly tracks: readonly PreparedMpegTsPacketTrackInput[];
  readonly container: Container | string;
  readonly fragmented?: boolean;
}

export function muxPreparedMpegTsPacketTracks(input: PreparedMpegTsPacketMuxInput): Uint8Array {
  if (input.fragmented === true) {
    throw new CapabilityError(
      'capability-miss',
      'prepared MPEG-TS packet mux does not author fragmented output',
      {
        op: { op: 'mux', container: input.container },
        tried: ['ts'],
      },
    );
  }
  if (input.container !== 'ts') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MPEG-TS packet mux cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['ts'],
      },
    );
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', 'prepared MPEG-TS packet mux received no tracks');
  }

  const tracks: MpegTsPacketTrackInput[] = [];
  for (let index = 0; index < input.tracks.length; index += 1) {
    const entry = input.tracks[index];
    if (entry === undefined) continue;
    const chunks = mpegTsChunksFromPackets(entry.packets);
    if (chunks.length === 0) {
      throw new MediaError(
        'mux-error',
        `prepared MPEG-TS packet mux track ${index + 1} received no packets`,
      );
    }
    tracks.push({ track: entry.track, chunks });
  }
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'prepared MPEG-TS packet mux received no tracks');
  }
  return writeMpegTsPacketTracks(tracks);
}

/** Fast MPEG-TS mux for packet-array callers. Stream callers can still use it after materialization. */
export async function muxPreparedMpegTsPacketStreams(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (options.fragmented === true || options.container !== 'ts') return undefined;
  const packetStreams = preparedPacketStreams(streams);
  if (packetStreams === undefined) return undefined;
  const tracks: PreparedMpegTsPacketTrackInput[] = [];
  for (const stream of packetStreams) {
    const packets = await packetValues(stream, options.signal);
    if (packets.length === 0) {
      throw new MediaError('mux-error', 'MPEG-TS mux received no packets');
    }
    tracks.push({ track: stream.track, packets });
  }
  return streamFromBytes(muxPreparedMpegTsPacketTracks({ tracks, container: 'ts' }));
}

function preparedPacketStreams(streams: PacketStreams): PacketStream[] | undefined {
  const out: PacketStream[] = [];
  if (streams.video !== undefined) {
    if (!isPreparedPacketStream(streams.video, 'video')) return undefined;
    out.push(streams.video);
  }
  if (streams.audio !== undefined) {
    if (!isPreparedPacketStream(streams.audio, 'audio')) return undefined;
    out.push(streams.audio);
  }
  if (streams.tracks !== undefined) {
    if (!Array.isArray(streams.tracks)) return undefined;
    for (const stream of streams.tracks) {
      if (!isPreparedPacketStream(stream, undefined)) return undefined;
      out.push(stream);
    }
  }
  return out.length === 0 ? undefined : out;
}

function isPreparedPacketStream(
  value: unknown,
  slot: 'video' | 'audio' | undefined,
): value is PacketStream {
  if (!isObject(value)) return false;
  const descriptor = value as Partial<PacketStream>;
  const track = descriptor.track;
  if (
    !isObject(track) ||
    (track.mediaType !== 'video' && track.mediaType !== 'audio') ||
    typeof track.codec !== 'string' ||
    track.config === undefined ||
    (slot !== undefined && track.mediaType !== slot)
  ) {
    return false;
  }
  return Array.isArray(descriptor.packetsArray) || isReadableStream(descriptor.packets);
}

async function packetValues(
  input: PacketStream,
  signal: AbortSignal | undefined,
): Promise<Array<EncodedChunk | Packet>> {
  const packets: Array<EncodedChunk | Packet> = [];
  if (input.packetsArray !== undefined) {
    for (const packet of input.packetsArray) {
      assertNotAborted(signal);
      packets.push(packet);
    }
    return packets;
  }
  if (input.packets === undefined) return packets;
  const reader = input.packets.getReader();
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      packets.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return packets;
}

function mpegTsChunksFromPackets(packets: readonly (EncodedChunk | Packet)[]): MpegTsChunk[] {
  const chunks: MpegTsChunk[] = [];
  for (const packet of packets) chunks.push(mpegTsChunkFrom(packet));
  return chunks;
}

function mpegTsChunkFrom(value: EncodedChunk | Packet): MpegTsChunk {
  if (isPacket(value)) {
    return {
      timestampUs: value.chunk.timestamp,
      key: value.chunk.type === 'key',
      data: packetBytes(value),
      ...(value.chunk.duration !== null && value.chunk.duration !== undefined
        ? { durationUs: value.chunk.duration }
        : {}),
      ...(value.dtsUs !== undefined ? { dtsUs: value.dtsUs } : {}),
    };
  }
  return {
    timestampUs: value.timestamp,
    key: value.type === 'key',
    data: encodedChunkBytes(value),
    ...(value.duration !== null && value.duration !== undefined
      ? { durationUs: value.duration }
      : {}),
  };
}

function isPacket(value: EncodedChunk | Packet): value is Packet {
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

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  if (!isObject(value)) return false;
  const stream = value as ReadableStreamLike;
  return typeof stream.getReader === 'function';
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
