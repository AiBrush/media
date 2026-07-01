/**
 * WAV ⇄ PCM bridge — extract real PCM from a RIFF/WAVE file into the canonical planar buffer, and write
 * canonical WAV bytes back (the WAV muxer doc 09 defers to audio-dsp). Little-endian RIFF chunk walk;
 * `fmt ` gives the layout, `data` the samples. This is the Node-validatable seam for the audio-dsp
 * oracle: `writeWav(readWavPcm(file), sameFormat)` reproduces the source PCM **bit-exact**.
 */

import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type Endianness,
  type PcmAudio,
  type SampleFormat,
  bytesPerSample,
  decodePcm,
  encodePcm,
} from '../../dsp/pcm.ts';

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** PCM audio plus the on-the-wire {@link SampleFormat} it was decoded from (for a bit-exact rewrite). */
export interface WavPcm extends PcmAudio {
  readonly format: SampleFormat;
}

function tagEquals(bytes: Uint8Array, offset: number, tag: string): boolean {
  if (offset + tag.length > bytes.byteLength) return false;
  for (let i = 0; i < tag.length; i++) {
    if (bytes[offset + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

function sampleFormat(formatTag: number, bits: number): SampleFormat {
  if (formatTag === FORMAT_PCM) {
    if (bits === 8) return 'u8';
    if (bits === 16) return 's16';
    if (bits === 24) return 's24';
    if (bits === 32) return 's32';
  } else if (formatTag === FORMAT_FLOAT) {
    if (bits === 32) return 'f32';
    if (bits === 64) return 'f64';
  }
  throw new InputError(
    'unsupported-input',
    `unsupported WAV PCM layout (tag ${formatTag}, ${bits}-bit)`,
  );
}

interface WavFmt {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bits: number;
}

interface WavPcmData {
  readonly fmt: WavFmt;
  readonly format: SampleFormat;
  readonly data: Uint8Array;
  readonly dataOffset: number;
  readonly dataSize: number;
}

function parseFmt(dv: DataView, body: number, size: number): WavFmt {
  let formatTag = dv.getUint16(body, true);
  const bits = dv.getUint16(body + 14, true);
  // WAVE_FORMAT_EXTENSIBLE: the effective tag is the first 2 bytes of the SubFormat GUID (offset +24).
  if (formatTag === FORMAT_EXTENSIBLE && size >= 40) formatTag = dv.getUint16(body + 24, true);
  return {
    formatTag,
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    bits,
  };
}

function parseWavPcmData(bytes: Uint8Array): WavPcmData {
  if (bytes.byteLength < 12 || !tagEquals(bytes, 0, 'RIFF') || !tagEquals(bytes, 8, 'WAVE')) {
    throw new InputError('unsupported-input', 'not a RIFF/WAVE file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: WavFmt | undefined;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (tagEquals(bytes, pos, 'fmt ') && size >= 16) {
      if (body + 16 > bytes.byteLength) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      fmt = parseFmt(dv, body, size);
    } else if (tagEquals(bytes, pos, 'data')) {
      dataOffset = body;
      dataSize = Math.min(size, Math.max(0, bytes.byteLength - body));
      break;
    }
    pos = body + size + (size & 1); // chunks are word-aligned (padded to even length)
  }
  if (!fmt) throw new MediaError('demux-error', 'WAVE file has no fmt chunk');
  const format = sampleFormat(fmt.formatTag, fmt.bits);
  const data =
    dataOffset < 0 ? new Uint8Array(0) : bytes.subarray(dataOffset, dataOffset + dataSize);
  return { fmt, format, data, dataOffset, dataSize };
}

/** Read a RIFF/WAVE file's PCM into canonical planar audio (little-endian wire format). */
export function readWavPcm(bytes: Uint8Array): WavPcm {
  const { fmt, format, data } = parseWavPcmData(bytes);
  const audio = decodePcm(data, format, fmt.channels, fmt.sampleRate);
  return { ...audio, format };
}

function writeFourCC(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

function writeWavHeader(
  out: Uint8Array,
  dataBytes: number,
  channels: number,
  sampleRate: number,
  format: SampleFormat,
): void {
  const sampleBytes = bytesPerSample(format);
  const blockAlign = channels * sampleBytes;
  const byteRate = sampleRate * blockAlign;
  const formatTag = format === 'f32' || format === 'f64' ? FORMAT_FLOAT : FORMAT_PCM;
  const dv = new DataView(out.buffer);
  writeFourCC(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeFourCC(dv, 8, 'WAVE');
  writeFourCC(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, formatTag, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, sampleBytes * 8, true);
  writeFourCC(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);
}

function writeWavContainer(
  data: Uint8Array,
  channels: number,
  sampleRate: number,
  format: SampleFormat,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + data.byteLength);
  writeWavHeader(out, data.byteLength, channels, sampleRate, format);
  out.set(data, 44);
  return out;
}

function isCanonicalWavPcmEnvelope(bytes: Uint8Array, parsed: WavPcmData): boolean {
  return (
    parsed.dataOffset === 44 &&
    bytes.byteLength === 44 + parsed.dataSize &&
    tagEquals(bytes, 12, 'fmt ') &&
    tagEquals(bytes, 36, 'data')
  );
}

/**
 * Re-author a WAV file by copying its raw PCM payload into a fresh canonical RIFF/WAVE envelope. This is
 * the no-DSP/no-format-change fast path: it still parses the source and writes a new header, but avoids
 * decoding every PCM sample into the planar DSP representation just to encode it back unchanged.
 */
export function rewriteWavPcmCopy(
  bytes: Uint8Array,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
): Uint8Array<ArrayBuffer> | undefined {
  if (endian !== 'le') return undefined;
  const parsed = parseWavPcmData(bytes);
  const { fmt, format, data } = parsed;
  if (requestedFormat !== undefined && requestedFormat !== format) return undefined;
  if (isCanonicalWavPcmEnvelope(bytes, parsed)) {
    const out = bytes.slice() as Uint8Array<ArrayBuffer>;
    writeWavHeader(out, data.byteLength, fmt.channels, fmt.sampleRate, format);
    return out;
  }
  return writeWavContainer(data, fmt.channels, fmt.sampleRate, format);
}

/** Serialize canonical audio to a canonical 44-byte-header RIFF/WAVE file (little-endian). */
export function writeWav(
  audio: PcmAudio,
  format: SampleFormat,
  endian: Endianness = 'le',
): Uint8Array<ArrayBuffer> {
  if (format === 's8') {
    throw new CapabilityError('capability-miss', 'WAV 8-bit PCM is unsigned; use pcm-u8', {
      op: { op: 'pcm-write', container: 'wav', sampleFormat: format },
      tried: ['wav'],
    });
  }
  const data = encodePcm(audio, format, endian);
  return writeWavContainer(data, audio.channels, audio.sampleRate, format);
}
