import type { EncodedChunk, Packet, TrackInfo } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import type { PacketStreams } from './types.ts';

const INVALID_MUX_PACKET_STREAM = 'invalid mux packet stream';

export interface MuxPacketStream {
  readonly track: TrackInfo;
  readonly packets: ReadableStream<EncodedChunk | Packet>;
}

type PacketStreamSlot = 'video' | 'audio';

interface MuxPacketDescriptorRecord {
  readonly track?: unknown;
  readonly packets?: unknown;
}

interface ReadableStreamLikeRecord {
  readonly getReader?: unknown;
}

interface TrackInfoLikeRecord {
  readonly id?: unknown;
  readonly mediaType?: unknown;
  readonly codec?: unknown;
}

export function muxPacketStreams(streams: PacketStreams): MuxPacketStream[] {
  const out: MuxPacketStream[] = [];
  appendMuxPacketStream(out, 'video', streams.video);
  appendMuxPacketStream(out, 'audio', streams.audio);
  // The multi-source / multi-track arm: an arbitrary ordered list, each entry its own output track. Not
  // slot-pinned (a list may carry >=2 video or >=2 audio), but each must still be a valid mediaType stream.
  if (streams.tracks !== undefined) {
    for (const track of streams.tracks) appendMuxPacketStream(out, undefined, track);
  }
  if (out.length === 0) {
    throw new InputError('unsupported-input', 'mux received no packet streams');
  }
  return out;
}

export function readablePacketStreams(streams: PacketStreams): ReadableStream<unknown>[] {
  const out: ReadableStream<unknown>[] = [];
  collectReadablePacketStream(out, streams.video);
  collectReadablePacketStream(out, streams.audio);
  if (streams.tracks !== undefined) {
    for (const track of streams.tracks) collectReadablePacketStream(out, track);
  }
  return out;
}

function appendMuxPacketStream(
  out: MuxPacketStream[],
  slot: PacketStreamSlot | undefined,
  input: unknown,
): void {
  if (input === undefined) return;
  if (isReadableStreamLike(input) || !isObject(input)) throw invalidMuxPacketStream();
  const descriptor = input as MuxPacketDescriptorRecord;
  const track = descriptor.track;
  const packets = descriptor.packets;
  // `isTrackInfoLike` already narrows mediaType to 'video'|'audio'. A slotted entry must additionally match
  // its slot; a `tracks[]` entry (slot `undefined`) accepts either, so the list may carry >=2 of one type.
  if (
    !isTrackInfoLike(track) ||
    (slot !== undefined && track.mediaType !== slot) ||
    track.config === undefined ||
    !isReadableStreamLike(packets)
  )
    throw invalidMuxPacketStream();
  out.push({ track, packets: packets as ReadableStream<EncodedChunk | Packet> });
}

function collectReadablePacketStream(out: ReadableStream<unknown>[], input: unknown): void {
  if (isReadableStreamLike(input)) {
    out.push(input);
    return;
  }
  if (!isObject(input)) return;
  const packets = (input as MuxPacketDescriptorRecord).packets;
  if (isReadableStreamLike(packets)) out.push(packets);
}

function invalidMuxPacketStream(): InputError {
  return new InputError('unsupported-input', INVALID_MUX_PACKET_STREAM);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  if (!isObject(value)) return false;
  const stream = value as ReadableStreamLikeRecord;
  return typeof stream.getReader === 'function';
}

function isTrackInfoLike(value: unknown): value is TrackInfo {
  if (!isObject(value)) return false;
  const track = value as TrackInfoLikeRecord;
  const { id, mediaType, codec } = track;
  return (
    typeof id === 'number' &&
    (mediaType === 'video' || mediaType === 'audio') &&
    typeof codec === 'string'
  );
}
