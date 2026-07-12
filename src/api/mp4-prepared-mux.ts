import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  PacketInfoTable,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { fragmentMp4 } from '../drivers/mp4/fragment.ts';
import { Mp4Driver, mp4PacketInfoTable, readMovie } from '../drivers/mp4/mp4-driver.ts';
import type { ChunkStruct, Mp4PacketTrackInput } from '../drivers/mp4/mux.ts';
import {
  mp4PacketMuxTracks,
  streamMp4PacketTracks,
  writeMp4PacketTracks,
} from '../drivers/mp4/prepared-stream.ts';
import type { NativePacketChunk } from '../internal/packet-provenance.ts';
import { cacheSource } from '../sources/cache.ts';
import { fromBytes, fromURL } from '../sources/source.ts';
import type { Container } from './types.ts';

const MP4_PACKET_INFO_URL_PRIME_BYTES = 32 * 1024;

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
  readonly signal?: AbortSignal;
}

export interface PreparedMp4NativeTracksMuxInput {
  readonly tracks: readonly {
    readonly track: TrackInfo;
    readonly chunks: readonly NativePacketChunk[];
  }[];
  readonly container: Container | string;
  readonly faststart?: boolean;
  readonly signal?: AbortSignal;
}

export interface Mp4PacketInfoFromUrlOptions {
  readonly mime?: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
}

export interface Mp4PacketInfoFromBytesOptions {
  readonly includeOffsets?: boolean;
  readonly signal?: AbortSignal;
}

export function muxPreparedMp4PacketTrack(input: PreparedMp4PacketMuxInput): Uint8Array {
  return muxPreparedMp4PacketTracks({
    ...input,
    tracks: [{ track: input.track, packets: input.packets }],
  });
}

export function muxPreparedMp4PacketTracks(input: PreparedMp4PacketTracksMuxInput): Uint8Array {
  assertPreparedMp4MuxInput(input, 'mux');
  const tracks = packetTrackInputsFrom(input.tracks, input.signal);
  if (input.fragmented === true)
    return concatenateSegments(fragmentMp4(mp4PacketMuxTracks(tracks)));
  const options: MuxOptions = {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  };
  return writeMp4PacketTracks(tracks, options);
}

/** Author already-validated first-party packet structs without WebCodecs host-chunk projection. */
export function muxPreparedMp4NativeTracks(input: PreparedMp4NativeTracksMuxInput): Uint8Array {
  if (input.container !== 'mp4' && input.container !== 'mov') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MP4 native mux cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  assertNotAborted(input.signal);
  const tracks: Mp4PacketTrackInput[] = input.tracks.map(({ track, chunks }) => ({
    track,
    chunks: chunks.map((chunk) => ({
      timestampUs: chunk.timestampUs,
      durationUs: chunk.durationUs,
      key: chunk.key,
      data: chunk.data,
      ...(chunk.dtsUs !== undefined ? { dtsUs: chunk.dtsUs } : {}),
    })),
  }));
  return writeMp4PacketTracks(tracks, {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  });
}

export function muxPreparedMp4PacketTracksStream(
  input: PreparedMp4PacketTracksMuxInput,
): ReadableStream<Uint8Array> {
  assertPreparedMp4MuxInput(input, 'stream mux');
  const tracks = packetTrackInputsFrom(input.tracks, input.signal);
  if (input.fragmented === true) return streamSegments(fragmentMp4(mp4PacketMuxTracks(tracks)));
  const options: MuxOptions = {
    container: input.container,
    fragmented: false,
    ...(input.faststart !== undefined ? { faststart: input.faststart } : {}),
  };
  return streamMp4PacketTracks(tracks, options);
}

function assertPreparedMp4MuxInput(
  input: PreparedMp4PacketTracksMuxInput,
  mode: 'mux' | 'stream mux',
): void {
  if (input.container !== 'mp4' && input.container !== 'mov') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MP4 packet ${mode} cannot write '${input.container}'`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.fragmented === true && input.container !== 'mp4') {
    throw new CapabilityError(
      'capability-miss',
      `prepared MP4 packet ${mode} cannot author fragmented '${input.container}' output`,
      {
        op: { op: 'mux', container: input.container },
        tried: ['mp4'],
      },
    );
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', `prepared MP4 packet ${mode} received no tracks`);
  }
}

function concatenateSegments(segments: Iterable<Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const segment of segments) {
    chunks.push(segment);
    total += segment.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamSegments(segments: Iterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = segments[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const next = iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(): void {
      iterator.return?.();
    },
  });
}

export async function mp4PacketInfoFromBytes(
  bytes: Uint8Array,
  opts: Mp4PacketInfoFromBytesOptions = {},
): Promise<PacketInfoTable> {
  if (opts.includeOffsets === true) {
    assertNotAborted(opts.signal);
    const movie = await readMovie({
      size: bytes.byteLength,
      read: (offset, length) =>
        Promise.resolve(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))),
    });
    assertNotAborted(opts.signal);
    return mp4PacketInfoTable(movie, bytes.byteLength);
  }
  return mp4PacketInfoFromSource(fromBytes(bytes, { mime: 'video/mp4' }), opts.signal);
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
  signal?: AbortSignal,
): Mp4PacketTrackInput[] {
  const out: Mp4PacketTrackInput[] = [];
  for (const track of tracks) {
    const chunks: ChunkStruct[] = [];
    for (const packet of track.packets) {
      assertNotAborted(signal);
      chunks.push(chunkStructFrom(packet));
    }
    out.push({ track: track.track, chunks });
  }
  assertNotAborted(signal);
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}
