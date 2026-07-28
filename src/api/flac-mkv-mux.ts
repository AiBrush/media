import type {
  EncodedChunk,
  MuxOptions,
  Packet,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { muxPreparedOggAudioPacketTrack } from '../drivers/ogg/ogg-prepared-mux.ts';
import type { ChunkStruct as WebmChunkStruct } from '../drivers/webm/ebml-write.ts';
import {
  WebmContainerSideData,
  matroskaAacCodecDelayNs,
  webmCodecIdForTrack,
  writeWebm,
} from '../drivers/webm/ebml-write.ts';
import {
  muxPreparedMp4PacketTrack,
  muxPreparedMp4PacketTracks,
  muxPreparedMp4PacketTracksStream,
} from './mp4-prepared-mux.ts';
import type { Container, PacketStream, PacketStreams } from './types.ts';

type WebmTrackState = Parameters<typeof writeWebm>[0][number];

interface ReadableStreamLike {
  readonly getReader?: unknown;
}

type PreparedPacketArrayStream = Omit<PacketStream, 'packetsArray'> & {
  readonly packetsArray: readonly (EncodedChunk | Packet)[];
};

type PreparedMp4StreamOptions = MuxOptions &
  StageOptions & {
    /** Whole-output sinks can adopt the writer's sole exact-owned ArrayBuffer (ADR-268). */
    readonly buffered?: boolean;
  };

// Below this measured crossover, ordinary stream draining is within noise or faster. Above it, avoiding
// one promise-backed pull per already-materialized packet is a durable general win (ADR-256).
const MP4_PREPARED_MULTITRACK_MIN_PACKETS = 256;

export interface PreparedWebmAudioPacketMuxInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
  readonly container: Container | string;
}

export interface PreparedWebmPacketTrackInput {
  readonly track: TrackInfo;
  readonly packets: readonly (EncodedChunk | Packet)[];
}

export interface PreparedWebmPacketMuxInput {
  readonly tracks: readonly PreparedWebmPacketTrackInput[];
  readonly container: Container | string;
}

export interface PreparedWebmChunk {
  readonly timestampUs: number;
  readonly durationUs?: number;
  readonly key: boolean;
  readonly data: Uint8Array;
  readonly dtsUs?: number;
  readonly alpha?: Uint8Array;
}

export interface PreparedWebmChunkTrackInput {
  readonly track: TrackInfo;
  readonly chunks: readonly PreparedWebmChunk[];
}

export interface PreparedWebmChunkMuxInput {
  readonly tracks: readonly PreparedWebmChunkTrackInput[];
  readonly container: Container | string;
}

/** Fast single-track MP4/MOV packet mux for callers that already hold prepared packet bytes. */
export async function muxSingleTrackMp4(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (
    options.fragmented === true ||
    options.faststart === 'reserve' ||
    !isMp4Family(options.container)
  )
    return undefined;
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
    throw new MediaError('mux-error', 'MP4 mux received no packets');
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

/** Prepared faststart MP4 mux for large complete packet arrays; other shapes retain existing seams. */
export async function muxPreparedMp4PacketStreams(
  streams: PacketStreams,
  options: PreparedMp4StreamOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (
    options.fragmented === true ||
    options.faststart === 'reserve' ||
    !isMp4Family(options.container)
  )
    return undefined;
  const inputs = mp4PacketArrayStreams(streams);
  if (
    inputs === undefined ||
    inputs.length < 2 ||
    options.faststart === false ||
    inputs.reduce((total, input) => total + input.packetsArray.length, 0) <
      MP4_PREPARED_MULTITRACK_MIN_PACKETS
  ) {
    return muxSingleTrackMp4(streams, options);
  }
  assertNotAborted(options.signal);
  const input = {
    tracks: inputs.map((input) => ({
      track: input.track,
      packets: input.packetsArray,
    })),
    container: options.container ?? 'mp4',
    fragmented: false,
    ...(options.faststart !== undefined ? { faststart: options.faststart } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return options.buffered === true
    ? streamFromBytes(muxPreparedMp4PacketTracks(input))
    : muxPreparedMp4PacketTracksStream(input);
}

/** Fast single-track FLAC packet mux for benchmark/prepared-packet callers that already hold chunks. */
export async function muxFlacMkv(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const input = singleFlacAudioStream(streams);
  if (input === undefined) return undefined;
  const sideData = new WebmContainerSideData('matroska');
  if (sideData.addTrack(input.track)) {
    throw new MediaError('mux-error', 'MKV mux received no media tracks');
  }
  const chunks = await packetChunks(input, options.signal);
  if (chunks.length === 0) {
    throw new MediaError('mux-error', 'MKV mux received no packets');
  }
  return streamFromBytes(
    writeWebm([flacTrackState(input, chunks)], 'matroska', sideData.attachedFilePayloads),
  );
}

/** Fast single-track Ogg audio packet mux for prepared packet callers. */
export async function muxSingleTrackOggAudio(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (options.fragmented === true || options.container !== 'ogg') return undefined;
  const input = singlePacketStream(streams);
  if (input === undefined || input.track.mediaType !== 'audio') return undefined;
  const packets = await packetValues(input, options.signal);
  if (packets.length === 0) {
    throw new MediaError('mux-error', 'Ogg mux received no packets');
  }
  return streamFromBytes(muxPreparedOggAudioPacketTrack({ track: input.track, packets }));
}

export function muxPreparedWebmAudioPacketTrack(
  input: PreparedWebmAudioPacketMuxInput,
): Uint8Array {
  if (input.container !== 'webm' && input.container !== 'mkv') {
    throw new CapabilityError(`WebM mux cannot write '${input.container}'`, {
      op: { kind: 'route', id: 'mux', facts: { container: input.container } },
      tried: ['webm', 'mkv'],
    });
  }
  if (input.track.mediaType !== 'audio') {
    throw new CapabilityError('WebM mux requires one audio track', {
      op: { kind: 'route', id: 'mux', facts: { container: input.container } },
      tried: ['webm', 'mkv'],
    });
  }
  const codecId = webmAudioCodecId(input.track.codec, input.container);
  if (codecId === undefined) {
    throw new CapabilityError(
      `WebM mux cannot carry '${input.track.codec}' in '${input.container}'`,
      {
        op: { kind: 'route', id: 'mux', facts: { container: input.container } },
        tried: ['webm', 'mkv'],
      },
    );
  }
  if (input.packets.length === 0) {
    throw new MediaError('mux-error', 'WebM mux received no packets');
  }
  const chunks: WebmChunkStruct[] = [];
  for (const packet of input.packets) chunks.push(chunkStructFrom(packet));
  return writePreparedWebmAudioTrack(input.track, codecId, chunks, input.container);
}

/** Fast WebM/Matroska packet mux for callers that already hold prepared packet bytes. */
export function muxPreparedWebmPacketTracks(input: PreparedWebmPacketMuxInput): Uint8Array {
  if (input.container !== 'webm' && input.container !== 'mkv') {
    throw new CapabilityError(`WebM mux cannot write '${input.container}'`, {
      op: { kind: 'route', id: 'mux', facts: { container: input.container } },
      tried: ['webm', 'mkv'],
    });
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', 'WebM mux received no tracks');
  }
  const states: WebmTrackState[] = [];
  const docType = input.container === 'mkv' ? 'matroska' : 'webm';
  const sideData = new WebmContainerSideData(docType);
  for (let i = 0; i < input.tracks.length; i++) {
    const entry = input.tracks[i];
    if (entry === undefined) continue;
    if (sideData.addTrack(entry.track)) continue;
    const chunks = packetStructs(entry.packets);
    if (chunks.length === 0) {
      throw new MediaError('mux-error', `WebM mux track ${i + 1} received no packets`);
    }
    states.push(webmTrackStateFromPreparedTrack(entry.track, states.length + 1, chunks));
  }
  if (states.length === 0) {
    throw new MediaError('mux-error', 'WebM mux received no tracks');
  }
  return writeWebm(states, docType, sideData.attachedFilePayloads);
}

/** Fast WebM/Matroska mux for callers that already hold timestamped packet byte views. */
export function muxPreparedWebmChunkTracks(input: PreparedWebmChunkMuxInput): Uint8Array {
  if (input.container !== 'webm' && input.container !== 'mkv') {
    throw new CapabilityError(`WebM mux cannot write '${input.container}'`, {
      op: { kind: 'route', id: 'mux', facts: { container: input.container } },
      tried: ['webm', 'mkv'],
    });
  }
  if (input.tracks.length === 0) {
    throw new MediaError('mux-error', 'WebM mux received no tracks');
  }
  const states: WebmTrackState[] = [];
  const docType = input.container === 'mkv' ? 'matroska' : 'webm';
  const sideData = new WebmContainerSideData(docType);
  for (let i = 0; i < input.tracks.length; i++) {
    const entry = input.tracks[i];
    if (entry === undefined) continue;
    if (sideData.addTrack(entry.track)) continue;
    const chunks = preparedChunkStructs(entry.chunks, states.length + 1);
    if (chunks.length === 0) {
      throw new MediaError('mux-error', `WebM mux track ${i + 1} received no packets`);
    }
    states.push(webmTrackStateFromPreparedTrack(entry.track, states.length + 1, chunks));
  }
  if (states.length === 0) {
    throw new MediaError('mux-error', 'WebM mux received no tracks');
  }
  return writeWebm(states, docType, sideData.attachedFilePayloads);
}

/** Fast WebM/Matroska mux for packet-array callers. Stream callers fall back to the general muxer. */
export async function muxPreparedWebmPacketStreams(
  streams: PacketStreams,
  options: MuxOptions & StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (options.fragmented === true || !isWebmFamily(options.container)) return undefined;
  const packetStreams = webmPreparedPacketStreams(streams, options.container);
  if (packetStreams === undefined) return undefined;
  const tracks: PreparedWebmPacketTrackInput[] = [];
  for (const stream of packetStreams) {
    const packets = await packetValues(stream, options.signal);
    if (packets.length === 0) {
      throw new MediaError('mux-error', 'WebM mux received no packets');
    }
    tracks.push({ track: stream.track, packets });
  }
  return streamFromBytes(
    muxPreparedWebmPacketTracks({ tracks, container: options.container ?? 'webm' }),
  );
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
    throw new MediaError('mux-error', 'WebM mux received no packets');
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

function mp4PacketArrayStreams(streams: PacketStreams): PreparedPacketArrayStream[] | undefined {
  const out: PreparedPacketArrayStream[] = [];
  if (streams.video !== undefined) {
    if (!isMp4PacketArrayStream(streams.video, 'video')) return undefined;
    out.push(streams.video);
  }
  if (streams.audio !== undefined) {
    if (!isMp4PacketArrayStream(streams.audio, 'audio')) return undefined;
    out.push(streams.audio);
  }
  if (streams.tracks !== undefined) {
    if (!Array.isArray(streams.tracks)) return undefined;
    for (const stream of streams.tracks) {
      if (!isMp4PacketArrayStream(stream, undefined)) return undefined;
      out.push(stream);
    }
  }
  return out.length === 0 ? undefined : out;
}

function isMp4PacketArrayStream(
  value: unknown,
  slot: 'video' | 'audio' | undefined,
): value is PreparedPacketArrayStream {
  if (!isPacketStream(value)) return false;
  if (slot !== undefined && value.track.mediaType !== slot) return false;
  if (isReadableStream(value.packets)) return false;
  return Array.isArray(value.packetsArray);
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

function webmPreparedPacketStreams(
  streams: PacketStreams,
  container: string | undefined,
): PacketStream[] | undefined {
  const out: PacketStream[] = [];
  if (streams.video !== undefined) {
    if (!isWebmPreparedPacketStream(streams.video, 'video', container)) return undefined;
    out.push(streams.video);
  }
  if (streams.audio !== undefined) {
    if (!isWebmPreparedPacketStream(streams.audio, 'audio', container)) return undefined;
    out.push(streams.audio);
  }
  if (streams.tracks !== undefined) {
    if (!Array.isArray(streams.tracks)) return undefined;
    for (const stream of streams.tracks) {
      if (!isWebmPreparedPacketStream(stream, undefined, container)) return undefined;
      out.push(stream);
    }
  }
  return out.length === 0 ? undefined : out;
}

function isWebmPreparedPacketStream(
  value: unknown,
  slot: 'video' | 'audio' | undefined,
  container: string | undefined,
): value is PacketStream {
  if (!isPacketStream(value)) return false;
  if (slot !== undefined && value.track.mediaType !== slot) return false;
  if (!Array.isArray(value.packetsArray)) return false;
  if (value.track.containerProjection?.kind === 'matroska-attachment') return true;
  return webmCodecId(value.track.mediaType, value.track.codec, container) !== undefined;
}

function webmCodecId(
  mediaType: 'video' | 'audio',
  codec: string,
  container: string | undefined,
): string | undefined {
  if (container !== 'webm' && container !== 'mkv') return undefined;
  try {
    return webmCodecIdForTrack(mediaType, codec);
  } catch (error) {
    if (error instanceof CapabilityError) return undefined;
    throw error;
  }
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
    alpha: false,
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
  const docType = container === 'mkv' ? 'matroska' : 'webm';
  const sideData = new WebmContainerSideData(docType);
  if (sideData.addTrack(track)) {
    throw new MediaError('mux-error', 'WebM mux received no media tracks');
  }
  return writeWebm(
    [webmAudioTrackStateFromTrack(track, codecId, chunks)],
    docType,
    sideData.attachedFilePayloads,
  );
}

function packetStructs(packets: readonly (EncodedChunk | Packet)[]): WebmChunkStruct[] {
  const chunks: WebmChunkStruct[] = [];
  for (const packet of packets) chunks.push(chunkStructFrom(packet));
  return chunks;
}

function preparedChunkStructs(
  chunks: readonly PreparedWebmChunk[],
  trackNumber: number,
): WebmChunkStruct[] {
  const out = new Array<WebmChunkStruct>(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) {
      throw new MediaError('mux-error', `WebM mux track ${trackNumber} has a missing packet`);
    }
    validatePreparedChunk(chunk, trackNumber, i + 1);
    out[i] = {
      timestampUs: chunk.timestampUs,
      durationUs: chunk.durationUs,
      key: chunk.key,
      data: chunk.data,
      ...(chunk.dtsUs !== undefined ? { dtsUs: chunk.dtsUs } : {}),
      ...(chunk.alpha !== undefined ? { alpha: chunk.alpha } : {}),
    };
  }
  return out;
}

function validatePreparedChunk(
  chunk: PreparedWebmChunk,
  trackNumber: number,
  packetNumber: number,
): void {
  if (!Number.isFinite(chunk.timestampUs)) {
    throw new MediaError(
      'mux-error',
      `WebM mux track ${trackNumber} packet ${packetNumber} has an invalid timestamp`,
    );
  }
  if (
    chunk.durationUs !== undefined &&
    (!Number.isFinite(chunk.durationUs) || chunk.durationUs < 0)
  ) {
    throw new MediaError(
      'mux-error',
      `WebM mux track ${trackNumber} packet ${packetNumber} has an invalid duration`,
    );
  }
  if (chunk.dtsUs !== undefined && !Number.isFinite(chunk.dtsUs)) {
    throw new MediaError(
      'mux-error',
      `WebM mux track ${trackNumber} packet ${packetNumber} has an invalid decode timestamp`,
    );
  }
  if (chunk.data.byteLength === 0) {
    throw new MediaError(
      'mux-error',
      `WebM mux track ${trackNumber} packet ${packetNumber} has no payload`,
    );
  }
}

function webmTrackStateFromPreparedTrack(
  track: TrackInfo,
  trackNumber: number,
  chunks: WebmChunkStruct[],
): WebmTrackState {
  const config = track.config;
  const codecPrivate =
    config?.description === undefined ? undefined : ownedBytes(config.description);
  if (track.mediaType === 'video') {
    const videoConfig = config as VideoDecoderConfig | undefined;
    return {
      trackNumber,
      mediaType: 'video',
      codecId: webmCodecIdForTrack(track.mediaType, track.codec),
      codecPrivate,
      ...(track.codecDelayNs !== undefined ? { codecDelayNs: track.codecDelayNs } : {}),
      ...(track.seekPreRollNs !== undefined ? { seekPreRollNs: track.seekPreRollNs } : {}),
      ...(track.codecDelayNs !== undefined ? { timestampAdjustmentNs: track.codecDelayNs } : {}),
      width: videoConfig?.codedWidth,
      height: videoConfig?.codedHeight,
      alpha: track.alpha === true,
      ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
      ...(track.color !== undefined ? { color: track.color } : {}),
      fps: track.fps,
      durationSec: track.durationSec,
      sampleRate: undefined,
      channels: undefined,
      chunks,
    };
  }
  const audioConfig = config as AudioDecoderConfig | undefined;
  const aacGaplessDelayNs = matroskaAacCodecDelayNs(track);
  const codecDelayNs = track.codecDelayNs ?? aacGaplessDelayNs;
  return {
    trackNumber,
    mediaType: 'audio',
    codecId: webmCodecIdForTrack(track.mediaType, track.codec),
    codecPrivate,
    ...(codecDelayNs !== undefined ? { codecDelayNs } : {}),
    ...(track.seekPreRollNs !== undefined ? { seekPreRollNs: track.seekPreRollNs } : {}),
    ...(codecDelayNs !== undefined ? { timestampAdjustmentNs: codecDelayNs } : {}),
    width: undefined,
    height: undefined,
    alpha: false,
    fps: undefined,
    durationSec: track.durationSec,
    ...(track.gapless !== undefined ? { gapless: track.gapless } : {}),
    sampleRate: audioConfig?.sampleRate,
    channels: audioConfig?.numberOfChannels,
    chunks,
  };
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
    alpha: false,
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
  alpha?: Uint8Array;
  dtsUs?: number;
} {
  if (isPacket(value)) {
    return {
      timestampUs: value.chunk.timestamp,
      durationUs: value.chunk.duration ?? undefined,
      key: value.chunk.type === 'key',
      data: packetBytes(value),
      ...(value.alpha !== undefined ? { alpha: encodedChunkBytes(value.alpha) } : {}),
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
