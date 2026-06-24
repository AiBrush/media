/**
 * The MP3 (MPEG-1/2/2.5 Audio Layer III) container driver — hand-written TS. An MP3 is a sequence of
 * frames; probe skips an optional ID3v2 tag, locks the first valid frame header for the sample
 * rate/channels/bitrate, and reads a Xing/Info VBR header for an exact frame count (else estimates a
 * CBR duration). Decode is via WebCodecs/WASM later; the container token is `mp3`.
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

const MP3_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3']);
const MP3_EXTENSIONS = new Set(['mp3']);

// version: 3=MPEG1, 2=MPEG2, 0=MPEG2.5 (1=reserved). Layer III only (the only one MP3 uses in practice).
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};
const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function asciiAt(dv: DataView, offset: number, length: number): string {
  if (offset + length > dv.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
}

interface FrameHeader {
  version: number; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  padding: number;
  samplesPerFrame: number;
  frameLength: number;
}

export interface Mp3Info {
  sampleRate: number;
  channels: number;
  durationSec: number;
}

/** Length (bytes) of the ID3v2 tag at the start, or 0 if absent. */
function id3v2Length(dv: DataView): number {
  if (dv.byteLength < 10 || asciiAt(dv, 0, 3) !== 'ID3') return 0;
  const size =
    (dv.getUint8(6) << 21) | (dv.getUint8(7) << 14) | (dv.getUint8(8) << 7) | dv.getUint8(9);
  return 10 + size;
}

function parseFrameHeader(dv: DataView, at: number): FrameHeader | undefined {
  if (at + 4 > dv.byteLength) return undefined;
  const b1 = dv.getUint8(at + 1);
  const b2 = dv.getUint8(at + 2);
  const b3 = dv.getUint8(at + 3);
  if (dv.getUint8(at) !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;

  const version = (b1 >> 3) & 0x3;
  const layer = (b1 >> 1) & 0x3;
  if (version === 1 || layer !== 0x1) return undefined; // reserved version / non-Layer-III

  const bitrateIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 0x3;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return undefined;

  const table = version === 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  const bitrateKbps = table[bitrateIdx] ?? 0;
  const sampleRate = SAMPLE_RATES[version]?.[srIdx] ?? 0;

  const padding = (b2 >> 1) & 0x1;
  const channels = ((b3 >> 6) & 0x3) === 3 ? 1 : 2;
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const coeff = version === 3 ? 144 : 72;
  const frameLength = Math.floor((coeff * bitrateKbps * 1000) / sampleRate) + padding;

  return { version, sampleRate, channels, bitrateKbps, padding, samplesPerFrame, frameLength };
}

/** Find the first valid frame at/after `start`, confirmed by the next frame's sync (avoid false locks). */
function findFirstFrame(
  dv: DataView,
  start: number,
): { offset: number; header: FrameHeader } | undefined {
  for (let i = start; i + 4 <= dv.byteLength; i++) {
    if (dv.getUint8(i) !== 0xff) continue;
    const header = parseFrameHeader(dv, i);
    if (!header || header.frameLength < 4) continue;
    const next = i + header.frameLength;
    if (next + 1 >= dv.byteLength || parseFrameHeader(dv, next)) {
      return { offset: i, header };
    }
  }
  return undefined;
}

/** Xing/Info VBR frame count, read from the tag inside the first frame (if present). */
function xingFrameCount(
  dv: DataView,
  frameOffset: number,
  header: FrameHeader,
): number | undefined {
  const sideInfo =
    header.version === 3 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
  const tagAt = frameOffset + 4 + sideInfo;
  const tag = asciiAt(dv, tagAt, 4);
  if (tag !== 'Xing' && tag !== 'Info') return undefined;
  if (tagAt + 12 > dv.byteLength) return undefined;
  const flags = dv.getUint8(tagAt + 7) & 0x1; // low bit = "frames" field present
  if (!flags) return undefined;
  return dv.getUint32(tagAt + 8, false); // big-endian frame count
}

/** Parse MP3 metadata + duration from (enough of) the file. `totalSize` enables CBR estimation. */
export function parseMp3(bytes: Uint8Array, totalSize?: number): Mp3Info {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = findFirstFrame(dv, id3v2Length(dv));
  if (!first) throw new InputError('unsupported-input', 'no valid MP3 frame header found');
  const { offset, header } = first;

  const frames = xingFrameCount(dv, offset, header);
  let durationSec: number;
  if (frames !== undefined) {
    durationSec = (frames * header.samplesPerFrame) / header.sampleRate;
  } else {
    const audioBytes = (totalSize ?? dv.byteLength) - offset;
    durationSec = (audioBytes * 8) / (header.bitrateKbps * 1000);
  }
  return { sampleRate: header.sampleRate, channels: header.channels, durationSec };
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(n, src.size ?? n));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && MP3_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && MP3_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 3) return false;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (asciiAt(dv, 0, 3) === 'ID3') return true; // ID3v2-tagged MP3
  // Raw frame sync: 0xFFE top 11 bits AND a non-zero layer field. Layer 00 is reserved for MPEG audio
  // but means ADTS/AAC — requiring layer != 00 keeps the MP3 and ADTS drivers mutually exclusive.
  const b1 = dv.getUint8(1);
  return dv.getUint8(0) === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0;
}

export const Mp3Driver: ContainerDriver = {
  id: 'mp3',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['mp3'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseMp3(await readHead(src, 1 << 16), src.size);
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: 'mp3',
      durationSec: info.durationSec,
      config: { codec: 'mp3', sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<EncodedChunk> {
        throw new CapabilityError(
          'capability-miss',
          'MP3 packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
          { op: 'demux', tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(): Muxer {
    throw new MediaError('mux-error', 'mp3 muxing is out of scope (decode/transcode only)');
  },
};

export const Mp3Module: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(Mp3Driver);
  },
};

export default Mp3Module;
