import type {
  ByteSource,
  PacketInfoMetadata,
  PacketInfoTable,
  TrackInfo,
} from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { ascii, flacOffset } from './flac-match.ts';
export { ascii, flacOffset, matchesFlac } from './flac-match.ts';

export interface FlacStreamInfo {
  codec: 'flac';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  durationSec: number;
}

export interface FlacMetadataLayout {
  readonly start: number;
  readonly audioStart: number;
  readonly streamInfoBody: Uint8Array<ArrayBuffer>;
  readonly info: FlacStreamInfo;
}

export interface FastFlacFrameSpan {
  readonly offset: number;
  readonly size: number;
  readonly blockSize: number;
  readonly samples: number;
  readonly ptsSamples: number;
  readonly ptsUs: number;
  readonly durationUs: number;
}

interface ParsedFlacFrameHeader {
  readonly offset: number;
  readonly headerBytes: number;
  readonly blockSize: number;
}

/** Parse the mandatory STREAMINFO block without importing the full FLAC codec stack. */
export function parseFlacStreamInfo(bytes: Uint8Array): FlacStreamInfo {
  const start = flacOffset(bytes);
  if (bytes.byteLength < start + 8 || ascii(bytes, start, 4) !== 'fLaC') {
    throw new InputError('not a native FLAC stream (no fLaC marker)');
  }
  const blockHeader = start + 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockType = dv.getUint8(blockHeader) & 0x7f;
  if (blockType !== 0) {
    throw new MediaError('demux-error', 'FLAC: first metadata block is not STREAMINFO');
  }
  const body = blockHeader + 4;
  if (bytes.byteLength < body + 18) {
    throw new MediaError('demux-error', 'FLAC: truncated STREAMINFO block');
  }
  const hi = dv.getUint32(body + 10);
  const lo = dv.getUint32(body + 14);
  const sampleRate = hi >>> 12;
  const channels = ((hi >>> 9) & 0x7) + 1;
  const bitsPerSample = ((hi >>> 4) & 0x1f) + 1;
  const totalSamplesBig = (BigInt(hi & 0xf) << 32n) | BigInt(lo);
  if (totalSamplesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MediaError(
      'demux-error',
      `FLAC totalSamples ${totalSamplesBig} exceeds safe integer range`,
    );
  }
  const totalSamples = Number(totalSamplesBig);
  if (sampleRate === 0) {
    throw new MediaError('demux-error', 'FLAC: STREAMINFO has zero sample rate');
  }
  return {
    codec: 'flac',
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
    durationSec: totalSamples / sampleRate,
  };
}

const FLAC_PROBE_INITIAL_BYTES = 64;
const FLAC_STREAMINFO_PREFIX_BYTES = 42;

function throwIfFlacProbeAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MediaError('aborted', 'operation aborted', signal.reason);
  }
}

/**
 * Parse seekable FLAC probe truth from the mandatory STREAMINFO prefix only. A legal leading ID3v2 tag
 * is crossed by its declared synchsafe length, so arbitrary tag payloads are neither transferred nor
 * allocated. `undefined` means the source is not seekable and the caller must retain its stream path.
 */
export async function readSeekableFlacStreamInfo(
  src: ByteSource,
  signal?: AbortSignal,
): Promise<FlacStreamInfo | undefined> {
  const range = src.range;
  if (range === undefined) return undefined;
  throwIfFlacProbeAborted(signal);
  const head = await range.call(src, 0, FLAC_PROBE_INITIAL_BYTES);
  throwIfFlacProbeAborted(signal);
  const start = flacOffset(head);
  const end = start + FLAC_STREAMINFO_PREFIX_BYTES;
  if (head.byteLength >= end) return parseFlacStreamInfo(head);

  // flacOffset is non-zero only after a complete ten-byte ID3 header, so this jump is structural. Parse
  // the returned native-FLAC prefix at offset zero rather than materializing the skipped tag body.
  if (start > 0) {
    const prefix = await range.call(src, start, end);
    throwIfFlacProbeAborted(signal);
    return parseFlacStreamInfo(prefix);
  }

  const prefix = await range.call(src, 0, FLAC_STREAMINFO_PREFIX_BYTES);
  throwIfFlacProbeAborted(signal);
  return parseFlacStreamInfo(prefix);
}

export function flacMetadataLayout(bytes: Uint8Array): FlacMetadataLayout {
  const start = flacOffset(bytes);
  if (bytes.byteLength < start + 8 || ascii(bytes, start, 4) !== 'fLaC') {
    throw new InputError('not a native FLAC stream (no fLaC marker)');
  }
  const info = parseFlacStreamInfo(bytes);
  let at = start + 4;
  let streamInfoBody: Uint8Array<ArrayBuffer> | undefined;
  for (;;) {
    if (at + 4 > bytes.byteLength) {
      throw new MediaError('demux-error', 'FLAC: truncated metadata block');
    }
    const header = bytes[at] as number;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len =
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number);
    const body = at + 4;
    const next = body + len;
    if (next > bytes.byteLength) {
      throw new MediaError('demux-error', 'FLAC: truncated metadata block');
    }
    if (type === 0) {
      if (len < 34) throw new MediaError('demux-error', 'FLAC: truncated STREAMINFO block');
      streamInfoBody = bytes.slice(body, body + 34) as Uint8Array<ArrayBuffer>;
    }
    at = next;
    if (last) break;
  }
  if (streamInfoBody === undefined) throw new MediaError('demux-error', 'FLAC: no STREAMINFO');
  return { start, audioStart: at, streamInfoBody, info };
}

/** Malformed-input guard: per-stream FLAC frame budget (REQUIREMENTS §8.4). */
export const MAX_FLAC_FRAMES_PER_STREAM = 100_000;

export function fastFlacFrames(bytes: Uint8Array, layout: FlacMetadataLayout): FastFlacFrameSpan[] {
  const frames: FastFlacFrameSpan[] = [];
  let offset = layout.audioStart;
  let produced = 0;
  let header: ParsedFlacFrameHeader | undefined;
  while (produced < layout.info.totalSamples) {
    header ??= parseFastFlacFrameHeader(bytes, offset);
    if (header === undefined) {
      throw new MediaError('demux-error', `FLAC: lost frame sync at byte ${offset}`);
    }
    const next = findNextFastFlacFrame(bytes, offset + header.headerBytes);
    const end = next?.offset ?? bytes.byteLength;
    if (end <= offset) {
      throw new MediaError('demux-error', `FLAC: invalid frame span at byte ${offset}`);
    }
    const samples = Math.min(header.blockSize, layout.info.totalSamples - produced);
    frames.push({
      offset,
      size: end - offset,
      blockSize: header.blockSize,
      samples,
      ptsSamples: produced,
      ptsUs: Math.round((produced / layout.info.sampleRate) * 1_000_000),
      durationUs: Math.round((samples / layout.info.sampleRate) * 1_000_000),
    });
    if (frames.length > MAX_FLAC_FRAMES_PER_STREAM) {
      throw new MediaError(
        'demux-error',
        `FLAC stream has >${MAX_FLAC_FRAMES_PER_STREAM} frames (budget exceeded) at ${offset}`,
      );
    }
    produced += samples;
    offset = end;
    header = next;
  }
  return frames;
}

export function flacTrackInfo(info: FlacStreamInfo, metadata?: Uint8Array): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: {
      codec: info.codec,
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      ...(metadata !== undefined ? { description: metadata } : {}),
    },
  };
}

export function flacPacketInfoRows(
  frames: readonly FastFlacFrameSpan[],
): readonly PacketInfoMetadata[] {
  return frames.map((frame) => ({
    trackIndex: 0,
    offset: frame.offset,
    size: frame.size,
    ptsUs: frame.ptsUs,
    dtsUs: frame.ptsUs,
    durationUs: frame.durationUs,
    keyframe: true,
  }));
}

export function flacPacketInfoTable(bytes: Uint8Array): PacketInfoTable {
  const layout = flacMetadataLayout(bytes);
  const metadata = bytes.slice(layout.start, layout.audioStart);
  const packets: PacketInfoMetadata[] = [];
  let offset = layout.audioStart;
  let produced = 0;
  let header: ParsedFlacFrameHeader | undefined;
  while (produced < layout.info.totalSamples) {
    header ??= parseFastFlacFrameHeader(bytes, offset);
    if (header === undefined) {
      throw new MediaError('demux-error', `FLAC: lost frame sync at byte ${offset}`);
    }
    const next = findNextFastFlacFrame(bytes, offset + header.headerBytes);
    const end = next?.offset ?? bytes.byteLength;
    if (end <= offset) {
      throw new MediaError('demux-error', `FLAC: invalid frame span at byte ${offset}`);
    }
    const samples = Math.min(header.blockSize, layout.info.totalSamples - produced);
    const ptsUs = Math.round((produced / layout.info.sampleRate) * 1_000_000);
    packets.push({
      trackIndex: 0,
      offset,
      size: end - offset,
      ptsUs,
      dtsUs: ptsUs,
      durationUs: Math.round((samples / layout.info.sampleRate) * 1_000_000),
      keyframe: true,
    });
    if (packets.length > MAX_FLAC_FRAMES_PER_STREAM) {
      throw new MediaError(
        'demux-error',
        `FLAC stream has >${MAX_FLAC_FRAMES_PER_STREAM} frames (budget exceeded) at ${offset}`,
      );
    }
    produced += samples;
    offset = end;
    header = next;
  }
  return {
    tracks: [flacTrackInfo(layout.info, metadata)],
    packets,
  };
}

function parseFastFlacFrameHeader(
  bytes: Uint8Array,
  offset: number,
): ParsedFlacFrameHeader | undefined {
  if (offset + 6 > bytes.byteLength) return undefined;
  if (bytes[offset] !== 0xff || ((bytes[offset + 1] as number) & 0xfe) !== 0xf8) return undefined;
  const blockSizeCode = ((bytes[offset + 2] as number) >> 4) & 0xf;
  const sampleRateCode = (bytes[offset + 2] as number) & 0xf;
  const channelAssignment = ((bytes[offset + 3] as number) >> 4) & 0xf;
  const sampleSizeCode = ((bytes[offset + 3] as number) >> 1) & 0x7;
  if (blockSizeCode === 0 || sampleRateCode === 15 || channelAssignment > 10) return undefined;
  if (sampleSizeCode === 3 || sampleSizeCode === 7) return undefined;
  if (((bytes[offset + 3] as number) & 0x1) !== 0) return undefined;

  let at = offset + 4;
  const numberBytes = flacUtf8NumberBytes(bytes, at);
  if (numberBytes === undefined) return undefined;
  at += numberBytes;

  let blockSize = FLAC_BLOCK_SIZE_TABLE[blockSizeCode] ?? 0;
  if (blockSizeCode === 6) {
    if (at >= bytes.byteLength) return undefined;
    blockSize = (bytes[at] as number) + 1;
    at++;
  } else if (blockSizeCode === 7) {
    if (at + 1 >= bytes.byteLength) return undefined;
    blockSize = (((bytes[at] as number) << 8) | (bytes[at + 1] as number)) + 1;
    at += 2;
  }
  if (blockSize <= 0) return undefined;

  if (sampleRateCode === 12) {
    if (at >= bytes.byteLength) return undefined;
    at++;
  } else if (sampleRateCode === 13 || sampleRateCode === 14) {
    if (at + 1 >= bytes.byteLength) return undefined;
    at += 2;
  }

  if (at >= bytes.byteLength) return undefined;
  if ((bytes[at] as number) !== flacCrc8(bytes, offset, at)) return undefined;
  return { offset, headerBytes: at + 1 - offset, blockSize };
}

function flacUtf8NumberBytes(bytes: Uint8Array, offset: number): number | undefined {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  if ((first & 0x80) === 0) return 1;
  let length = 0;
  for (let mask = 0x80; (first & mask) !== 0; mask >>= 1) length++;
  if (length < 2 || length > 7 || offset + length > bytes.byteLength) return undefined;
  for (let i = 1; i < length; i++) {
    if (((bytes[offset + i] as number) & 0xc0) !== 0x80) return undefined;
  }
  return length;
}

function findNextFastFlacFrame(bytes: Uint8Array, from: number): ParsedFlacFrameHeader | undefined {
  let at = bytes.indexOf(0xff, Math.max(0, from));
  while (at >= 0 && at + 6 <= bytes.byteLength) {
    if (((bytes[at + 1] as number) & 0xfe) !== 0xf8) {
      at = bytes.indexOf(0xff, at + 1);
      continue;
    }
    const header = parseFastFlacFrameHeader(bytes, at);
    if (header !== undefined) return header;
    at = bytes.indexOf(0xff, at + 1);
  }
  return undefined;
}

function flacCrc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] as number;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

const FLAC_BLOCK_SIZE_TABLE = [
  0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
] as const;
