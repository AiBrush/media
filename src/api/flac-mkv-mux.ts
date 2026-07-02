import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import type { ChunkStruct as WebmChunkStruct } from '../drivers/webm/ebml-write.ts';
import { writeWebm } from '../drivers/webm/ebml-write.ts';
import { muxPreparedMp4PacketTrack } from './mp4-prepared-mux.ts';
import type { Container, PacketStream, PacketStreams } from './types.ts';

type WebmTrackState = Parameters<typeof writeWebm>[0][number];

interface ReadableStreamLike {
  readonly getReader?: unknown;
}

export interface PreparedWebmAudioPacketMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
  readonly container: Container | string;
}

/** Fast single-track MP4/MOV packet mux for callers that already hold prepared packet bytes. */
export async function muxSingleTrackMp4(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (options.fragmented === true || !isMp4Family(options.container)) return undefined;
  const input = singlePacketStream(streams);
  if (input === undefined) return undefined;
  const packets: Array<EncodedChunk | Packet> = [];
  if (input.packetsArray !== undefined) {
    for (const packet of input.packetsArray) {
      assertNotAborted(options.signal);
      packets.push(packet);
    }
  } else if (input.packets !== undefined) {
    const reader = input.packets.getReader();
    try {
      for (;;) {
        assertNotAborted(options.signal);
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
  } else {
    return undefined;
  }
  if (packets.length === 0) {
    throw new MediaError('mux-error', 'single-track MP4 mux received no packets');
  }
  const muxOptions = {
    track: input.track,
    packets,
    container: options.container ?? 'mp4',
    fragmented: false,
    ...(options.faststart !== undefined ? { faststart: options.faststart } : {}),
  };
  return streamFromBytes(muxPreparedMp4PacketTrack(muxOptions));
}

/** Fast single-track FLAC packet mux for benchmark/prepared-packet callers that already hold chunks. */
export async function muxFlacMkv(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const input = singleFlacAudioStream(streams);
  if (input === undefined) return undefined;
  const chunks = await packetChunks(input, options.signal);
  if (chunks.length === 0) {
    throw new MediaError('mux-error', 'FLAC MKV mux received no packets');
  }
  return streamFromBytes(writeWebm([flacTrackState(input, chunks)], 'matroska'));
}

export function muxPreparedWebmAudioPacketTrack(
  input: PreparedWebmAudioPacketMuxInput,
): Uint8Array {
  if (input.container !== 'webm' && input.container !== 'mkv') {
    throw new CapabilityError(
      'capability-miss',
      `prepared WebM audio packet mux cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['webm', 'mkv'],
      },
    );
  }
  if (input.track.mediaType !== 'audio') {
    throw new CapabilityError(
      'capability-miss',
      'prepared WebM audio packet mux requires one audio track',
      {
        op: { op: 'mux', container: input.container },
        tried: ['webm', 'mkv'],
      },
    );
  }
  const codecId = webmAudioCodecId(input.track.codec, input.container);
  if (codecId === undefined) {
    throw new CapabilityError(
      'capability-miss',
      `prepared WebM audio packet mux cannot carry '${input.track.codec}' in '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['webm', 'mkv'],
      },
    );
  }
  if (input.packets.length === 0) {
    throw new MediaError('mux-error', 'prepared WebM audio packet mux received no packets');
  }
  const chunks: WebmChunkStruct[] = [];
  for (const packet of input.packets) chunks.push(chunkStructFrom(packet));
  return writePreparedWebmAudioTrack(input.track, codecId, chunks, input.container);
}

/** Fast single-track WebM/Matroska audio packet mux for prepared packet callers. */
export async function muxSingleTrackWebmAudio(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (options.fragmented === true || !isWebmFamily(options.container)) return undefined;
  const input = singleWebmAudioStream(streams, options.container);
  if (input === undefined) return undefined;
  const chunks = await packetChunks(input.stream, options.signal);
  if (chunks.length === 0) {
    throw new MediaError('mux-error', 'single-track WebM audio mux received no packets');
  }
  return streamFromBytes(
    writePreparedWebmAudioTrack(input.stream.track, input.codecId, chunks, options.container),
  );
}

function isMp4Family(container: string | undefined): boolean {
  return container === 'mp4' || container === 'mov';
}

function isWebmFamily(container: string | undefined): boolean {
  return container === 'webm' || container === 'mkv';
}

function singlePacketStream(streams: PacketStreams): PacketStream | undefined {
  const slots: Array<{ readonly slot?: 'video' | 'audio'; readonly value: unknown }> = [];
  if (streams.video !== undefined) slots.push({ slot: 'video', value: streams.video });
  if (streams.audio !== undefined) slots.push({ slot: 'audio', value: streams.audio });
  if (streams.tracks !== undefined) {
    if (!Array.isArray(streams.tracks)) return undefined;
    for (const stream of streams.tracks) slots.push({ value: stream });
  }
  if (slots.length !== 1) return undefined;
  const only = slots[0];
  if (only === undefined || !isPacketStream(only.value)) return undefined;
  if (only.slot !== undefined && only.value.track.mediaType !== only.slot) return undefined;
  return only.value;
}

function isPacketStream(value: unknown): value is PacketStream {
  if (!isObject(value)) return false;
  const descriptor = value as Partial<PacketStream>;
  const track = descriptor.track;
  return (
    isObject(track) &&
    (track.mediaType === 'video' || track.mediaType === 'audio') &&
    typeof track.codec === 'string' &&
    track.config !== undefined &&
    (isReadableStream(descriptor.packets) || Array.isArray(descriptor.packetsArray))
  );
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

async function packetChunks(
  input: PacketStream,
  signal: AbortSignal | undefined,
): Promise<WebmChunkStruct[]> {
  const chunks: WebmChunkStruct[] = [];
  if (input.packetsArray !== undefined) {
    for (const packet of input.packetsArray) {
      assertNotAborted(signal);
      chunks.push(chunkStructFrom(packet));
    }
    return chunks;
  }
  if (input.packets === undefined) return chunks;
  const reader = input.packets.getReader();
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(chunkStructFrom(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

function singleFlacAudioStream(streams: PacketStreams): PacketStream | undefined {
  if (streams.video !== undefined) return undefined;
  if (streams.audio !== undefined && streams.tracks === undefined) {
    return isFlacAudioStream(streams.audio) ? streams.audio : undefined;
  }
  if (streams.audio !== undefined || streams.tracks === undefined || streams.tracks.length !== 1) {
    return undefined;
  }
  const only = streams.tracks[0];
  return only !== undefined && isFlacAudioStream(only) ? only : undefined;
}

function isFlacAudioStream(stream: PacketStream): boolean {
  return stream.track.mediaType === 'audio' && stream.track.codec.toLowerCase().startsWith('flac');
}

interface WebmAudioStream {
  readonly stream: PacketStream;
  readonly codecId: string;
}

function singleWebmAudioStream(
  streams: PacketStreams,
  container: string | undefined,
): WebmAudioStream | undefined {
  const stream = singlePacketStream(streams);
  if (stream === undefined || stream.track.mediaType !== 'audio') return undefined;
  const codecId = webmAudioCodecId(stream.track.codec, container);
  return codecId === undefined ? undefined : { stream, codecId };
}

function webmAudioCodecId(codec: string, container: string | undefined): string | undefined {
  const c = codec.toLowerCase();
  if (c.startsWith('opus')) return 'A_OPUS';
  if (c.startsWith('vorbis')) return 'A_VORBIS';
  if (container === 'mkv' && c.startsWith('flac')) return 'A_FLAC';
  return undefined;
}

function webmAudioTrackStateFromTrack(
  track: TrackInfo,
  codecId: string,
  chunks: WebmChunkStruct[],
): WebmTrackState {
  const config = track.config as AudioDecoderConfig | undefined;
  return {
    trackNumber: 1,
    mediaType: 'audio',
    codecId,
    codecPrivate: config?.description === undefined ? undefined : ownedBytes(config.description),
    width: undefined,
    height: undefined,
    fps: undefined,
    durationSec: track.durationSec,
    sampleRate: config?.sampleRate,
    channels: config?.numberOfChannels,
    chunks,
  };
}

function writePreparedWebmAudioTrack(
  track: TrackInfo,
  codecId: string,
  chunks: WebmChunkStruct[],
  container: Container | string | undefined,
): Uint8Array {
  return writeWebm(
    [webmAudioTrackStateFromTrack(track, codecId, chunks)],
    container === 'mkv' ? 'matroska' : 'webm',
  );
}

function flacTrackState(input: PacketStream, chunks: WebmChunkStruct[]): WebmTrackState {
  const config = input.track.config as AudioDecoderConfig | undefined;
  return {
    trackNumber: 1,
    mediaType: 'audio',
    codecId: 'A_FLAC',
    codecPrivate: config?.description === undefined ? undefined : ownedBytes(config.description),
    width: undefined,
    height: undefined,
    fps: undefined,
    durationSec: input.track.durationSec,
    sampleRate: config?.sampleRate,
    channels: config?.numberOfChannels,
    chunks,
  };
}

function chunkStructFrom(value: Packet | EncodedChunk): {
  timestampUs: number;
  durationUs: number | undefined;
  key: boolean;
  data: Uint8Array;
  dtsUs?: number;
} {
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

function ownedBytes(src: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  }
  return new Uint8Array(src).slice();
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
