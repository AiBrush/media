/**
 * WAV ⇄ PCM bridge — extract real PCM from a RIFF/WAVE file into the canonical planar buffer, and write
 * canonical WAV bytes back (the WAV muxer doc 09 defers to audio-dsp). Little-endian RIFF chunk walk;
 * `fmt ` gives the layout, `data` the samples. This is the Node-validatable seam for the audio-dsp
 * oracle: `writeWav(readWavPcm(file), sameFormat)` reproduces the source PCM **bit-exact**.
 */

import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type Endianness,
  type InterleavedPcmF32,
  type PcmAudio,
  type SampleFormat,
  bytesPerSample,
  decodePcm,
  decodePcmToInterleavedF32,
  encodePcm,
} from '../../dsp/pcm.ts';

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
  if (formatTag === 1) {
    if (bits === 8) return 'u8';
    if (bits === 16) return 's16';
    if (bits === 24) return 's24';
    if (bits === 32) return 's32';
  } else if (formatTag === 3) {
    if (bits === 32) return 'f32';
    if (bits === 64) return 'f64';
  }
  throw new InputError(`unsupported WAV PCM layout (tag ${formatTag}, ${bits}-bit)`);
}

export interface WavFmt {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bits: number;
}

export interface WavPcmData {
  readonly fmt: WavFmt;
  readonly format: SampleFormat;
  readonly data: Uint8Array;
  readonly dataOffset: number;
  readonly dataSize: number;
}

/** A bounded, exact-owned interleaved Float32 prefix decoded from a WAV PCM payload. */
export interface WavPcmInterleavedPrefix extends InterleavedPcmF32 {
  readonly format: SampleFormat;
}

/** A fresh canonical WAV header plus the validated immutable PCM payload view it describes. */
export interface WavPcmCopyPlan {
  readonly header: Uint8Array<ArrayBuffer>;
  readonly payload: Uint8Array;
}

function parseFmt(dv: DataView, body: number, size: number): WavFmt {
  let formatTag = dv.getUint16(body, true);
  const bits = dv.getUint16(body + 14, true);
  // WAVE_FORMAT_EXTENSIBLE: the effective tag is the first 2 bytes of the SubFormat GUID (offset +24).
  if (formatTag === 0xfffe && size >= 40) formatTag = dv.getUint16(body + 24, true);
  return {
    formatTag,
    channels: dv.getUint16(body + 2, true),
    sampleRate: dv.getUint32(body + 4, true),
    bits,
  };
}

export function parseWavPcmData(bytes: Uint8Array, totalSize = bytes.byteLength): WavPcmData {
  if (bytes.byteLength < 12 || !tagEquals(bytes, 0, 'RIFF') || !tagEquals(bytes, 8, 'WAVE')) {
    throw new InputError('not a RIFF/WAVE file');
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
      const needed = size >= 40 ? 26 : 16;
      if (body + needed > bytes.byteLength) {
        throw new MediaError('demux-error', 'WAVE: truncated fmt chunk');
      }
      fmt = parseFmt(dv, body, size);
    } else if (tagEquals(bytes, pos, 'data')) {
      dataOffset = body;
      dataSize = Math.min(size, Math.max(0, totalSize - body));
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

/**
 * Decode at most `maxFrames` sample-frames from the beginning of a RIFF/WAVE PCM payload. This is the
 * bounded inspection/decode seam for callers that need a small prefix: it validates the real container
 * and format, reads no samples beyond the requested prefix, and never constructs the full media engine.
 */
export function decodeWavPcmInterleavedPrefix(
  bytes: Uint8Array,
  maxFrames: number,
): WavPcmInterleavedPrefix {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 0) {
    throw new InputError(`invalid WAV PCM prefix frame count ${maxFrames}`);
  }
  const parsed = parseWavPcmData(bytes);
  if (
    !Number.isSafeInteger(parsed.fmt.channels) ||
    parsed.fmt.channels <= 0 ||
    !Number.isSafeInteger(parsed.fmt.sampleRate) ||
    parsed.fmt.sampleRate <= 0
  ) {
    throw new InputError(
      `invalid WAV PCM shape (${parsed.fmt.channels} channel(s), ${parsed.fmt.sampleRate}Hz)`,
    );
  }
  const frameBytes = bytesPerSample(parsed.format) * parsed.fmt.channels;
  const availableFrames = Math.floor(parsed.data.byteLength / frameBytes);
  const frames = Math.min(maxFrames, availableFrames);
  const prefix = parsed.data.subarray(0, frames * frameBytes);
  return {
    ...decodePcmToInterleavedF32(prefix, parsed.format, parsed.fmt.channels, parsed.fmt.sampleRate),
    format: parsed.format,
  };
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

export function writeWavHeader(
  out: Uint8Array,
  dataBytes: number,
  channels: number,
  sampleRate: number,
  format: SampleFormat,
): void {
  const sampleBytes = bytesPerSample(format);
  const blockAlign = channels * sampleBytes;
  const byteRate = sampleRate * blockAlign;
  const formatTag = format === 'f32' || format === 'f64' ? 3 : 1;
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

function validatedWavPcmCopy(
  bytes: Uint8Array,
  requestedFormat: SampleFormat | undefined,
  endian: Endianness,
  requestedChannels: number | undefined,
  requestedSampleRate: number | undefined,
): WavPcmData | undefined {
  if (endian !== 'le') return undefined;
  const parsed = parseWavPcmData(bytes);
  const { fmt, format } = parsed;
  if (requestedFormat !== undefined && requestedFormat !== format) return undefined;
  if (requestedChannels !== undefined && requestedChannels !== fmt.channels) return undefined;
  if (requestedSampleRate !== undefined && requestedSampleRate !== fmt.sampleRate) return undefined;
  return parsed;
}

/**
 * Plan a fresh canonical WAV envelope without copying its already-validated immutable PCM payload. The
 * caller must either snapshot the payload (Blob/File), stream it under backpressure, or materialize a new
 * contiguous output; the input container itself is never returned.
 */
export function planWavPcmCopy(
  bytes: Uint8Array,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
): WavPcmCopyPlan | undefined {
  const parsed = validatedWavPcmCopy(
    bytes,
    requestedFormat,
    endian,
    requestedChannels,
    requestedSampleRate,
  );
  if (parsed === undefined) return undefined;
  const header = new Uint8Array(44);
  writeWavHeader(
    header,
    parsed.data.byteLength,
    parsed.fmt.channels,
    parsed.fmt.sampleRate,
    parsed.format,
  );
  return { header, payload: parsed.data };
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
  requestedChannels?: number,
  requestedSampleRate?: number,
): Uint8Array<ArrayBuffer> | undefined {
  const parsed = validatedWavPcmCopy(
    bytes,
    requestedFormat,
    endian,
    requestedChannels,
    requestedSampleRate,
  );
  if (parsed === undefined) return undefined;
  const { fmt, format, data } = parsed;
  if (isCanonicalWavPcmEnvelope(bytes, parsed)) {
    const out = bytes.slice() as Uint8Array<ArrayBuffer>;
    writeWavHeader(out, data.byteLength, fmt.channels, fmt.sampleRate, format);
    return out;
  }
  return writeWavContainer(data, fmt.channels, fmt.sampleRate, format);
}

/**
 * Re-author an exclusively owned WAV snapshot without a second full-file copy when its envelope is
 * already canonical. The caller transfers ownership of `bytes`: on success this function may normalize
 * its RIFF/data declarations in place and return the same object. Shared or caller-retained inputs must
 * use {@link rewriteWavPcmCopy} instead.
 */
export function rewriteOwnedWavPcmCopy(
  bytes: Uint8Array<ArrayBuffer>,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
): Uint8Array<ArrayBuffer> | undefined {
  const parsed = validatedWavPcmCopy(
    bytes,
    requestedFormat,
    endian,
    requestedChannels,
    requestedSampleRate,
  );
  if (parsed === undefined) return undefined;
  const { fmt, format, data } = parsed;
  if (isCanonicalWavPcmEnvelope(bytes, parsed)) {
    writeWavHeader(bytes, data.byteLength, fmt.channels, fmt.sampleRate, format);
    return bytes;
  }
  return writeWavContainer(data, fmt.channels, fmt.sampleRate, format);
}

/**
 * Re-author a structurally valid zero-frame WAV with a different PCM declaration. With no sample
 * payload there is no resampling, channel mapping, or quantization work to perform; only the canonical
 * RIFF/WAVE envelope changes. Non-empty or truncated payloads deliberately decline this fast path.
 */
export function rewriteEmptyWavPcm(
  bytes: Uint8Array,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (endian !== 'le') return undefined;
  const parsed = parseWavPcmData(bytes);
  if (parsed.dataOffset < 8 || parsed.dataSize !== 0) return undefined;
  const declaredDataSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    parsed.dataOffset - 4,
    true,
  );
  if (declaredDataSize !== 0) return undefined;

  const format = requestedFormat ?? parsed.format;
  // WAV's 8-bit integer PCM representation is unsigned.
  if (format === 's8') return undefined;
  const channels = requestedChannels ?? parsed.fmt.channels;
  const sampleRate = requestedSampleRate ?? parsed.fmt.sampleRate;
  if (
    !Number.isSafeInteger(channels) ||
    channels <= 0 ||
    channels > 0xffff ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 0xffffffff ||
    sampleRate * channels * bytesPerSample(format) > 0xffffffff
  ) {
    return undefined;
  }
  return writeWavContainer(new Uint8Array(0), channels, sampleRate, format);
}

/** Serialize canonical audio to a canonical 44-byte-header RIFF/WAVE file (little-endian). */
export function writeWav(
  audio: PcmAudio,
  format: SampleFormat,
  endian: Endianness = 'le',
): Uint8Array<ArrayBuffer> {
  if (format === 's8') {
    throw new CapabilityError('WAV 8-bit PCM is unsigned; use pcm-u8', {
      op: { kind: 'route', id: 'pcm-write', facts: { container: 'wav', sampleFormat: format } },
      tried: ['wav'],
    });
  }
  const data = encodePcm(audio, format, endian);
  return writeWavContainer(data, audio.channels, audio.sampleRate, format);
}
