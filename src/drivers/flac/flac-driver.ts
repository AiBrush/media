/**
 * The native FLAC container driver — hand-written TS. A FLAC stream is `fLaC` magic followed by
 * metadata blocks; the first is always `STREAMINFO`, which carries sample rate, channel count, bit
 * depth, and total sample count (→ duration). FLAC *decode* is implemented in **pure TS** (ADR-024,
 * `codecs/flac`) and exposed via `decodePcm` (FLAC → WAV) — both probe and decode are browser-free; only
 * the WebCodecs `EncodedChunk` packet seam stays browser-side.
 *
 * STREAMINFO packs `sampleRate:20 | channels-1:3 | bitsPerSample-1:5 | totalSamples:36` big-endian.
 */

import { decodeFlac } from '../../codecs/flac/decode.ts';
import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type Muxer,
  type Packet,
  type PcmTransform,
  type Registry,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { type PcmAudio, type SampleFormat, gain, remix } from '../../dsp/index.ts';
import { writeWav } from '../wav/pcm.ts';

const FLAC_MIMES = new Set(['audio/flac', 'audio/x-flac']);
const FLAC_EXTENSIONS = new Set(['flac']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

export interface FlacInfo {
  codec: 'flac';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  durationSec: number;
}

/** Byte offset of the `fLaC` marker, skipping a (legal but rare) ID3v2 prefix. */
function flacOffset(bytes: Uint8Array): number {
  if (bytes.byteLength >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const b6 = dv.getUint8(6);
    const b7 = dv.getUint8(7);
    const b8 = dv.getUint8(8);
    const b9 = dv.getUint8(9);
    const size = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
    return 10 + size; // ID3v2 header (10) + synchsafe tag size
  }
  return 0;
}

/** Parse the `STREAMINFO` block into the audio layout + duration. Pure; big-endian. */
export function parseFlac(bytes: Uint8Array): FlacInfo {
  const start = flacOffset(bytes);
  if (bytes.byteLength < start + 8 || ascii(bytes, start, 4) !== 'fLaC') {
    throw new InputError('unsupported-input', 'not a native FLAC stream (no fLaC marker)');
  }
  const blockHeader = start + 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockType = dv.getUint8(blockHeader) & 0x7f;
  if (blockType !== 0) {
    throw new MediaError('demux-error', 'FLAC: first metadata block is not STREAMINFO');
  }
  const body = blockHeader + 4; // block header is type(1) + length(3)
  if (bytes.byteLength < body + 18) {
    throw new MediaError('demux-error', 'FLAC: truncated STREAMINFO block');
  }
  // The 64-bit packed field begins after min/max block size (2+2) and min/max frame size (3+3).
  const hi = dv.getUint32(body + 10); // big-endian: sampleRate:20 | channels-1:3 | bps-1:5 | samples[35:32]
  const lo = dv.getUint32(body + 14); // samples[31:0]
  const sampleRate = hi >>> 12;
  const channels = ((hi >>> 9) & 0x7) + 1;
  const bitsPerSample = ((hi >>> 4) & 0x1f) + 1;
  const totalSamples = (hi & 0xf) * 2 ** 32 + lo;
  if (sampleRate === 0)
    throw new MediaError('demux-error', 'FLAC: STREAMINFO has zero sample rate');
  return {
    codec: 'flac',
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
    durationSec: totalSamples / sampleRate,
  };
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** Read the whole source — FLAC decode needs every frame (bounded by file size). */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// FLAC bit depth → the WAV sample format that stores it (non-byte-aligned depths use the next wider).
const DEPTH_FORMAT: Record<number, SampleFormat> = {
  8: 'u8',
  12: 's16',
  16: 's16',
  20: 's24',
  24: 's24',
  32: 's32',
};
const FORMAT_DIVISOR: Record<string, number> = {
  u8: 128,
  s16: 32768,
  s24: 8388608,
  s32: 2147483648,
};

/** Decode FLAC bytes to canonical planar audio normalized for the chosen WAV output format. */
function flacToPcm(bytes: Uint8Array): { audio: PcmAudio; format: SampleFormat } {
  const decoded = decodeFlac(bytes);
  const format = DEPTH_FORMAT[decoded.bitsPerSample] ?? 's32';
  const divisor = FORMAT_DIVISOR[format] ?? 2147483648;
  const planar = decoded.samples.map((ch) => {
    const out = new Float64Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = (ch[i] ?? 0) / divisor;
    return out;
  });
  const audio: PcmAudio = {
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    frames: decoded.totalSamples,
    planar,
  };
  return { audio, format };
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && FLAC_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && FLAC_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  return head !== undefined && head.byteLength >= 4 && ascii(head, flacOffset(head), 4) === 'fLaC';
}

export const FlacDriver: ContainerDriver = {
  id: 'flac',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['flac'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const head = await readHead(src, 65536);
    const info = parseFlac(head);
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: info.codec,
      durationSec: info.durationSec,
      config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'capability-miss',
          'FLAC flows through the pure-TS decodePcm path (decode → PCM), not the WebCodecs chunk seam',
          { op: 'demux', tried: ['flac'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const { audio, format } = flacToPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    if (o?.sampleRate !== undefined && o.sampleRate !== audio.sampleRate) {
      throw new CapabilityError(
        'capability-miss',
        `audio resample ${audio.sampleRate}→${o.sampleRate} Hz needs the WASM/WebAudio tail`,
        { op: 'convert', tried: ['flac'] },
      );
    }
    let result: PcmAudio = audio;
    if (o?.gainDb !== undefined && o.gainDb !== 0) result = gain(result, o.gainDb);
    if (o?.channels !== undefined && o.channels !== result.channels)
      result = remix(result, o.channels);
    const out = writeWav(result, format);
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  createMuxer(): Muxer {
    throw new MediaError(
      'mux-error',
      'FLAC encode is a WASM-tail codec (not provided by this driver)',
    );
  },
};

export const FlacModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(FlacDriver);
  },
};

export default FlacModule;
