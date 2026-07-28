import type { Endianness, SampleFormat } from '../../dsp/pcm.ts';
import { bytesPerSample, roundHalfToEven } from '../../dsp/pcm.ts';
import { writeWavHeader } from '../wav/pcm.ts';
import { aiffPcmSampleBytes, locate } from './aiff.ts';

export interface AiffPcmToWavOptions {
  readonly sampleFormat?: SampleFormat;
  readonly endian?: Endianness;
  readonly channels?: number;
  readonly sampleRate?: number;
}

/**
 * Re-author unmodified AIFF/AIFF-C PCM as canonical little-endian WAV without decoding samples into the
 * planar DSP representation. This is the no-DSP cross-wrapper fast path: it parses COMM/SSND, validates
 * the requested constraints, writes a fresh RIFF/WAVE header, and copies, byte-swaps, or narrows each
 * fixed-width sample word directly. Signed 8-bit AIFF is intentionally declined because legal WAV 8-bit
 * PCM is unsigned and needs value-domain conversion.
 */
export function rewriteAiffPcmToWav(
  bytes: Uint8Array,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (endian !== 'le') return undefined;
  const { layout, ssndSampleOffset, ssndSampleBytes } = locate(bytes);
  const sampleRate = Math.round(layout.sampleRate);
  if (layout.format === 's8') return undefined;
  const outputFormat = requestedFormat ?? layout.format;
  const canNarrowS24ToS16 = layout.format === 's24' && outputFormat === 's16';
  if (outputFormat !== layout.format && !canNarrowS24ToS16) return undefined;
  if (requestedChannels !== undefined && requestedChannels !== layout.channels) return undefined;
  if (requestedSampleRate !== undefined && requestedSampleRate !== sampleRate) return undefined;

  const sourceBytesPer = bytesPerSample(layout.format);
  const sourceDataBytes = aiffPcmSampleBytes(layout, ssndSampleOffset, ssndSampleBytes);
  const frames = layout.frames;
  const outputDataBytes = frames * layout.channels * bytesPerSample(outputFormat);
  const out = new Uint8Array(44 + outputDataBytes);
  writeWavHeader(out, outputDataBytes, layout.channels, sampleRate, outputFormat);
  if (sourceDataBytes === 0) return out;

  const sampleStart = ssndSampleOffset;
  const sampleEnd = sampleStart + sourceDataBytes;
  if (canNarrowS24ToS16) {
    copyS24ToS16Samples(bytes, sampleStart, out, 44, sourceDataBytes, layout.endian);
    return out;
  }
  if (layout.endian === 'le' || sourceBytesPer === 1) {
    out.set(bytes.subarray(sampleStart, sampleEnd), 44);
    return out;
  }

  copyByteSwappedSamples(bytes, sampleStart, out, 44, sourceDataBytes, sourceBytesPer);
  return out;
}

export function aiffPcmToWavFromBytes(
  bytes: Uint8Array,
  opts: AiffPcmToWavOptions = {},
): Uint8Array<ArrayBuffer> | undefined {
  return rewriteAiffPcmToWav(bytes, opts.sampleFormat, opts.endian, opts.channels, opts.sampleRate);
}

function copyByteSwappedSamples(
  src: Uint8Array,
  srcStart: number,
  dst: Uint8Array,
  dstStart: number,
  byteLength: number,
  bytesPerSampleValue: number,
): void {
  let srcOffset = srcStart;
  let dstOffset = dstStart;
  const srcEnd = srcStart + byteLength;
  if (bytesPerSampleValue === 2) {
    while (srcOffset < srcEnd) {
      dst[dstOffset] = src[srcOffset + 1] ?? 0;
      dst[dstOffset + 1] = src[srcOffset] ?? 0;
      srcOffset += 2;
      dstOffset += 2;
    }
    return;
  }
  while (srcOffset < srcEnd) {
    for (let i = 0; i < bytesPerSampleValue; i++) {
      dst[dstOffset + i] = src[srcOffset + bytesPerSampleValue - 1 - i] ?? 0;
    }
    srcOffset += bytesPerSampleValue;
    dstOffset += bytesPerSampleValue;
  }
}

function copyS24ToS16Samples(
  src: Uint8Array,
  srcStart: number,
  dst: Uint8Array,
  dstStart: number,
  sourceByteLength: number,
  endian: Endianness,
): void {
  let srcOffset = srcStart;
  let dstOffset = dstStart;
  const srcEnd = srcStart + sourceByteLength;
  const littleEndian = endian === 'le';
  while (srcOffset + 2 < srcEnd) {
    const b0 = src[srcOffset] ?? 0;
    const b1 = src[srcOffset + 1] ?? 0;
    const b2 = src[srcOffset + 2] ?? 0;
    const raw = littleEndian ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
    const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
    const narrowed = Math.min(32767, Math.max(-32768, roundHalfToEven(signed / 256)));
    dst[dstOffset] = narrowed & 0xff;
    dst[dstOffset + 1] = (narrowed >> 8) & 0xff;
    srcOffset += 3;
    dstOffset += 2;
  }
}
