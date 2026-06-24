/**
 * The WAV (RIFF/WAVE) container driver — hand-written TS. WAV is **little-endian** (unlike MP4) and
 * carries raw PCM (or IEEE float), so demux is a chunk walk: parse `fmt ` for the layout and the
 * `data` chunk header for duration. PCM is not a WebCodecs codec — it flows to the TS audio-dsp path —
 * so the codec token is `pcm-s16` / `pcm-s24` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
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
  type PcmTransform,
  type Registry,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { type PcmAudio, gain, remix } from '../../dsp/index.ts';
import { readWavPcm, writeWav } from './pcm.ts';

const WAV_MIMES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave']);
const WAV_EXTENSIONS = new Set(['wav', 'wave']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface WavInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

/** PCM/float codec token per WebCodecs/harness vocabulary (LE; WAV BE variants are out of scope). */
function pcmCodec(fmt: WavFormat): string {
  if (fmt.formatTag === 3) return fmt.bitsPerSample === 64 ? 'pcm-f64' : 'pcm-f32';
  if (fmt.bitsPerSample === 8) return 'pcm-u8'; // 8-bit WAV PCM is unsigned (offset binary)
  return `pcm-s${fmt.bitsPerSample}`;
}

function parseFormat(dv: DataView, body: number, size: number): WavFormat {
  let formatTag = dv.getUint16(body, true);
  // WAVE_FORMAT_EXTENSIBLE: the effective tag is the first 2 bytes of the SubFormat GUID (+24), so
  // float-extensible (tag 3) is not mislabeled as PCM. Fall back to PCM if the chunk is too short.
  if (formatTag === 0xfffe) formatTag = size >= 40 ? dv.getUint16(body + 24, true) : 1;
  return {
    formatTag,
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    byteRate: dv.getUint32(body + 8, true),
    blockAlign: dv.getUint16(body + 12, true),
    bitsPerSample: dv.getUint16(body + 14, true),
  };
}

/** Parse a RIFF/WAVE header into the audio layout + duration. Pure; little-endian. */
export function parseWav(bytes: Uint8Array, totalSize?: number): WavInfo {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      format = parseFormat(dv, body, size);
    } else if (id === 'data') {
      // Trust the declared size for duration, but never exceed the real file length.
      dataSize = totalSize !== undefined ? Math.min(size, Math.max(0, totalSize - body)) : size;
      break;
    }
    pos = body + size + (size & 1); // chunks are padded to an even size
  }
  if (!format) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');

  const bytesPerFrame =
    format.blockAlign > 0 ? format.blockAlign : (format.bitsPerSample >> 3) * format.channels;
  const byteRate = format.byteRate > 0 ? format.byteRate : bytesPerFrame * format.sampleRate;

  return {
    codec: pcmCodec(format),
    sampleRate: format.sampleRate,
    channels: format.channels,
    durationSec: byteRate > 0 ? dataSize / byteRate : 0,
  };
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** Read the whole source into one buffer — PCM transforms need every sample (bounded by file size). */
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

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && WAV_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && WAV_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  return (
    head !== undefined &&
    head.byteLength >= 12 &&
    ascii(head, 0, 4) === 'RIFF' &&
    ascii(head, 8, 4) === 'WAVE'
  );
}

export const WavDriver: ContainerDriver = {
  id: 'wav',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['wav'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const head = await readHead(src, 65536);
    const info = parseWav(head, src.size);
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
          'WAV PCM packets flow through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: [] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const wav = readWavPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    if (o?.sampleRate !== undefined && o.sampleRate !== wav.sampleRate) {
      throw new CapabilityError(
        'capability-miss',
        `audio resample ${wav.sampleRate}→${o.sampleRate} Hz needs the WASM/WebAudio tail`,
        { op: 'convert', tried: ['wav'] },
      );
    }
    let audio: PcmAudio = wav;
    if (o?.gainDb !== undefined && o.gainDb !== 0) audio = gain(audio, o.gainDb);
    if (o?.channels !== undefined && o.channels !== audio.channels)
      audio = remix(audio, o.channels);
    const out = writeWav(audio, wav.format); // source sample-format preserved (lossless)
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  createMuxer(): Muxer {
    // WAV carries raw PCM, not WebCodecs EncodedChunks, so the seam Muxer doesn't map; PCM output is
    // produced by `transformPcm` (writeWav) — the audio-dsp path (ADR-022).
    throw new MediaError(
      'mux-error',
      'wav output flows through transformPcm (PCM), not the chunk seam',
    );
  },
};

export const WavModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(WavDriver);
  },
};

export default WavModule;
