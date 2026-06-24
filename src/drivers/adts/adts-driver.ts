/**
 * The ADTS (raw AAC) container driver — hand-written TS. ADTS wraps each AAC frame in a 7- or 9-byte
 * header beginning with a 12-bit `0xFFF` syncword; the first header carries the audio object type,
 * sampling-frequency index, and channel configuration. Duration comes from walking the frames (each is
 * `frame_length` bytes and 1024 samples per raw block). AAC *decode* is a WebCodecs/WASM codec, so the
 * packet seam raises a typed {@link CapabilityError}; probe is pure TS.
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type EncodedChunk,
  type Muxer,
  type Registry,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';

const ADTS_MIMES = new Set(['audio/aac', 'audio/aacp', 'audio/x-aac']);
const ADTS_EXTENSIONS = new Set(['aac', 'adts']);

// MPEG-4 sampling-frequency-index table (Hz); index 13–15 are reserved/explicit (unsupported here).
const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
// channel_configuration → channel count (0 = AOT-specific; 7 = 7.1 → 8 channels).
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

const SAMPLES_PER_BLOCK = 1024;

export interface AdtsInfo {
  codec: string; // RFC 6381, e.g. mp4a.40.2 (AAC-LC) — matches the mp4 driver
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number;
}

/** A valid ADTS sync: byte0 = 0xFF, byte1 top nibble = 0xF, layer bits (b1 & 6) == 0. */
function isSync(b0: number, b1: number): boolean {
  return b0 === 0xff && (b1 & 0xf0) === 0xf0 && (b1 & 0x06) === 0;
}

/** Byte offset of the first ADTS frame, skipping an optional ID3v2 prefix. */
function adtsOffset(dv: DataView): number {
  if (
    dv.byteLength >= 10 &&
    dv.getUint8(0) === 0x49 &&
    dv.getUint8(1) === 0x44 &&
    dv.getUint8(2) === 0x33
  ) {
    const size =
      ((dv.getUint8(6) & 0x7f) << 21) |
      ((dv.getUint8(7) & 0x7f) << 14) |
      ((dv.getUint8(8) & 0x7f) << 7) |
      (dv.getUint8(9) & 0x7f);
    return 10 + size;
  }
  return 0;
}

/** Parse ADTS headers into the audio layout + duration. `totalSize` (full file) refines a partial head. */
export function parseAdts(bytes: Uint8Array, totalSize?: number): AdtsInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = adtsOffset(dv);
  if (bytes.byteLength < start + 7 || !isSync(dv.getUint8(start), dv.getUint8(start + 1))) {
    throw new InputError('unsupported-input', 'not an ADTS/AAC stream (no 0xFFF syncword)');
  }
  const b2 = dv.getUint8(start + 2);
  const objectType = ((b2 >> 6) & 0x3) + 1; // profile + 1 = MPEG-4 audio object type (2 = AAC-LC)
  const freqIndex = (b2 >> 2) & 0xf;
  const sampleRate = SAMPLE_RATES[freqIndex];
  if (sampleRate === undefined) {
    throw new MediaError('demux-error', `ADTS: reserved sampling-frequency index ${freqIndex}`);
  }
  const channelConfig = ((b2 & 0x1) << 2) | ((dv.getUint8(start + 3) >> 6) & 0x3);
  const channels = CHANNELS[channelConfig] ?? 0;

  // Walk frames within the available bytes to count samples (each frame_length bytes, 1024/block).
  let pos = start;
  let frames = 0;
  let samples = 0;
  while (pos + 7 <= bytes.byteLength && isSync(dv.getUint8(pos), dv.getUint8(pos + 1))) {
    const frameLen =
      ((dv.getUint8(pos + 3) & 0x3) << 11) |
      (dv.getUint8(pos + 4) << 3) |
      (dv.getUint8(pos + 5) >> 5);
    if (frameLen < 7) break; // malformed header guard
    const rawBlocks = (dv.getUint8(pos + 6) & 0x3) + 1;
    frames++;
    samples += rawBlocks * SAMPLES_PER_BLOCK;
    pos += frameLen;
  }
  // If we only saw a head of a larger file, extrapolate by the bytes-per-sample density walked so far.
  const walked = pos - start;
  const scale =
    totalSize !== undefined && walked > 0 ? Math.max(1, (totalSize - start) / walked) : 1;
  return {
    codec: `mp4a.40.${objectType}`,
    sampleRate,
    channels,
    durationSec: (samples * scale) / sampleRate,
    frames,
  };
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(n, src.size ?? n));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && ADTS_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && ADTS_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 7) return false;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const off = adtsOffset(dv);
  return off + 2 <= head.byteLength && isSync(dv.getUint8(off), dv.getUint8(off + 1));
}

export const AdtsDriver: ContainerDriver = {
  id: 'adts',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['adts'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseAdts(await readHead(src, 65536), src.size);
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: info.codec,
      durationSec: info.durationSec,
      config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<EncodedChunk> {
        throw new CapabilityError(
          'capability-miss',
          'AAC decode requires the WebCodecs/WASM codec layer (not registered in this build)',
          { op: 'demux', tried: ['adts'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(): Muxer {
    throw new MediaError('mux-error', 'AAC encode requires the WebCodecs/WASM codec layer');
  },
};

export const AdtsModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AdtsDriver);
  },
};

export default AdtsModule;
