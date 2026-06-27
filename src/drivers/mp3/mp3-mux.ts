/**
 * MP3 elementary-stream `Muxer` (mirrors {@link FlacMuxer}) — assembles a standards-valid `.mp3` byte
 * stream from one audio track's MPEG-1/2 Layer III frames. MP3 is a framed elementary stream: each audio
 * frame carries its own MPEG header, and VBR duration is conventionally preserved by a leading Xing/Info
 * metadata frame with exact frame/byte counts. This muxer therefore writes one synthesized Xing frame
 * followed by the original audio frames back-to-back, verbatim. No re-encode happens here: a remux
 * (MP3-in-MP4/ADTS/Matroska → `.mp3`) is byte-lossless for audio frames, and the MP3 **encoder** drives
 * `media.encode` by emitting frames as chunks that flow straight through.
 *
 * Single-shot, single-track (MP3 carries one audio stream). Each written chunk MUST be a valid MPEG Layer
 * III audio frame (validated by reusing the driver's {@link parseFrameHeader}); a non-frame, a second
 * track, a non-audio/non-`mp3` track, writes/`addTrack` after `finalize`, or a double `finalize` are typed
 * misuse — never a silently-corrupt `.mp3`. Mirrors {@link FlacMuxer}: the only browser-only step is
 * `copyTo` on a real WebCodecs `EncodedChunk` in {@link write}; the pure {@link addChunkStruct} is the
 * Node-validated ingest path.
 */

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { ChunkStruct } from '../ogg/ogg-write.ts';

const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};
const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const UINT32_MAX = 0xffffffff;

interface Mp3FrameHeader {
  readonly version: number;
  readonly sampleRateIndex: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelByte: number;
  readonly bitrateIndex: number;
  readonly bitrateKbps: number;
  readonly frameLength: number;
  readonly sideInfoBytes: number;
}

interface Mp3FrameRun {
  readonly frames: number;
  readonly bytes: number;
  readonly firstHeader: Mp3FrameHeader;
}

interface Mp3MuxTrack {
  readonly id: number;
  readonly chunks: ChunkStruct[];
  frameCount: number;
  audioBytes: number;
  firstHeader: Mp3FrameHeader | undefined;
}

/** `Muxer` that serializes one MP3 track to a complete `.mp3` elementary stream on {@link finalize}. */
export class Mp3Muxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: Mp3MuxTrack | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'MP3 has no fragmented/segmented mux form', {
        op: { op: 'mux', fragmented: true },
        tried: ['mp3'],
      });
    }
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    if (this.#track !== undefined) {
      throw new CapabilityError('capability-miss', 'the MP3 muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['mp3'],
      });
    }
    if (info.mediaType !== 'audio' || info.codec !== 'mp3') {
      throw new CapabilityError(
        'capability-miss',
        `MP3 container carries a single MP3 audio track, not ${info.mediaType}/${info.codec}`,
        { op: { op: 'mux' }, tried: ['mp3'] },
      );
    }
    const id = 0;
    this.#track = { id, chunks: [], frameCount: 0, audioBytes: 0, firstHeader: undefined };
    return id;
  }

  /**
   * Buffer one encoded packet. Extracting bytes from a real WebCodecs `EncodedChunk` (`copyTo`) is the
   * only browser-only step (guarded); the struct flows through the pure {@link addChunkStruct}. MP3 audio
   * is never reordered, so the packet's `dtsUs` is irrelevant.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /**
   * Pure packet ingest (the path the Node tests drive directly): validate + buffer one MPEG Layer III
   * audio frame. The frame must start with a real MP3 sync header, or it is rejected — the muxer never
   * concatenates non-frame bytes into the `.mp3` (which would desync every downstream parser).
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    if (this.#track === undefined || this.#track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    const run = parseMp3FrameRun(chunk.data);
    if (run === undefined) {
      throw new MediaError('mux-error', 'MP3 mux: chunk is not a valid MPEG Layer III audio frame');
    }
    this.#track.frameCount += run.frames;
    this.#track.audioBytes += run.bytes;
    this.#track.firstHeader ??= run.firstHeader;
    this.#track.chunks.push(chunk);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready;
    const controller = this.#controller;
    if (controller === undefined) {
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    try {
      const track = this.#track;
      if (track === undefined) {
        throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
      }
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${track.id} received no packets`);
      }
      controller.enqueue(assembleMp3(track));
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}

function parseFrameHeader(bytes: Uint8Array, at: number): Mp3FrameHeader | undefined {
  if (at + 4 > bytes.byteLength) return undefined;
  const b0 = bytes[at];
  const b1 = bytes[at + 1];
  const b2 = bytes[at + 2];
  const b3 = bytes[at + 3];
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || b3 === undefined) return undefined;
  if ((b1 & 0xe0) !== 0xe0) return undefined;

  const version = (b1 >> 3) & 0x3;
  const layer = (b1 >> 1) & 0x3;
  if (version === 1 || layer !== 0x1) return undefined;

  const bitrateIndex = (b2 >> 4) & 0xf;
  const sampleRateIndex = (b2 >> 2) & 0x3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;

  const bitrateTable = version === 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  const bitrateKbps = bitrateTable[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex] ?? 0;
  if (bitrateKbps <= 0 || sampleRate <= 0) return undefined;

  const channels = ((b3 >> 6) & 0x3) === 3 ? 1 : 2;
  const sideInfoBytes = version === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
  const padding = (b2 >> 1) & 0x1;
  const coeff = version === 3 ? 144 : 72;
  const frameLength = Math.floor((coeff * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLength < 4) return undefined;

  return {
    version,
    sampleRateIndex,
    sampleRate,
    channels,
    channelByte: b3,
    bitrateIndex,
    bitrateKbps,
    frameLength,
    sideInfoBytes,
  };
}

function asciiAt(bytes: Uint8Array, at: number, length: number): string {
  if (at + length > bytes.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

function isInfoFrame(bytes: Uint8Array, offset: number, header: Mp3FrameHeader): boolean {
  const tag = asciiAt(bytes, offset + 4 + header.sideInfoBytes, 4);
  return tag === 'Xing' || tag === 'Info';
}

function parseMp3FrameRun(bytes: Uint8Array): Mp3FrameRun | undefined {
  let at = 0;
  let frames = 0;
  let firstHeader: Mp3FrameHeader | undefined;
  while (at < bytes.byteLength) {
    const header = parseFrameHeader(bytes, at);
    if (header === undefined || at + header.frameLength > bytes.byteLength) return undefined;
    if (isInfoFrame(bytes, at, header)) return undefined;
    firstHeader ??= header;
    frames++;
    at += header.frameLength;
  }
  if (firstHeader === undefined || at !== bytes.byteLength) return undefined;
  return { frames, bytes: bytes.byteLength, firstHeader };
}

function frameLength(version: number, bitrateKbps: number, sampleRate: number): number {
  const coeff = version === 3 ? 144 : 72;
  return Math.floor((coeff * bitrateKbps * 1000) / sampleRate);
}

function metadataBitrateIndex(header: Mp3FrameHeader, minLength: number): number {
  if (frameLength(header.version, header.bitrateKbps, header.sampleRate) >= minLength) {
    return header.bitrateIndex;
  }
  const table = header.version === 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  for (let i = 1; i < table.length - 1; i++) {
    const bitrate = table[i] ?? 0;
    if (bitrate > 0 && frameLength(header.version, bitrate, header.sampleRate) >= minLength)
      return i;
  }
  throw new MediaError(
    'mux-error',
    'MP3 mux: cannot fit Xing metadata in a legal MPEG Layer III frame',
  );
}

function writeAscii(out: Uint8Array, at: number, value: string): void {
  for (let i = 0; i < value.length; i++) out[at + i] = value.charCodeAt(i);
}

function writeU32BE(out: Uint8Array, at: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new MediaError('mux-error', 'MP3 mux: Xing metadata count exceeds 32-bit field size');
  }
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function buildXingFrame(track: Mp3MuxTrack): Uint8Array {
  const header = track.firstHeader;
  if (header === undefined)
    throw new MediaError('mux-error', 'MP3 mux: cannot write metadata without frames');
  const tagAt = 4 + header.sideInfoBytes;
  const minLength = tagAt + 16;
  const bitrateIndex = metadataBitrateIndex(header, minLength);
  const bitrateTable = header.version === 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  const bitrateKbps = bitrateTable[bitrateIndex] ?? 0;
  const length = frameLength(header.version, bitrateKbps, header.sampleRate);
  const out = new Uint8Array(length);
  out[0] = 0xff;
  out[1] = 0xe0 | (header.version << 3) | (0x1 << 1) | 0x1;
  out[2] = (bitrateIndex << 4) | (header.sampleRateIndex << 2);
  out[3] = header.channelByte;
  writeAscii(out, tagAt, 'Xing');
  writeU32BE(out, tagAt + 4, 0x00000003);
  writeU32BE(out, tagAt + 8, track.frameCount);
  writeU32BE(out, tagAt + 12, length + track.audioBytes);
  return out;
}

/** Concatenate a Xing metadata frame and every MPEG Layer III audio frame into one `.mp3` byte buffer. */
function assembleMp3(track: Mp3MuxTrack): Uint8Array<ArrayBuffer> {
  const xing = buildXingFrame(track);
  let total = xing.byteLength;
  for (const chunk of track.chunks) total += chunk.data.byteLength;
  const out = new Uint8Array(total);
  out.set(xing, 0);
  let offset = xing.byteLength;
  for (const chunk of track.chunks) {
    out.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return out;
}
