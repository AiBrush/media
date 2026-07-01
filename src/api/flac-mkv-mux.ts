import type { EncodedChunk, MuxOptions, Packet, StageOptions } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import type { ChunkStruct } from '../drivers/webm/ebml-write.ts';
import { writeWebm } from '../drivers/webm/ebml-write.ts';
import type { PacketStream, PacketStreams } from './types.ts';

type WebmTrackState = Parameters<typeof writeWebm>[0][number];

/** Fast single-track FLAC packet mux for benchmark/prepared-packet callers that already hold chunks. */
export async function muxFlacMkv(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const input = singleFlacAudioStream(streams);
  if (input === undefined) return undefined;
  const reader = input.packets.getReader();
  const chunks: ChunkStruct[] = [];
  try {
    for (;;) {
      assertNotAborted(options.signal);
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
  if (chunks.length === 0) {
    throw new MediaError('mux-error', 'FLAC MKV mux received no packets');
  }
  return streamFromBytes(writeWebm([flacTrackState(input, chunks)], 'matroska'));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
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

function flacTrackState(input: PacketStream, chunks: ChunkStruct[]): WebmTrackState {
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
      data: encodedChunkBytes(value.chunk),
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
