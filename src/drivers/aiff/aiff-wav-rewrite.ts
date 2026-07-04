import type { Endianness, SampleFormat } from '../../dsp/pcm.ts';
import { bytesPerSample } from '../../dsp/pcm.ts';
import { writeWavHeader } from '../wav/pcm.ts';
import { locate } from './aiff.ts';

/**
 * Re-author unmodified AIFF/AIFF-C PCM as canonical little-endian WAV without decoding samples into the
 * planar DSP representation. This is the no-DSP cross-wrapper fast path: it parses COMM/SSND, validates
 * the requested identity constraints, writes a fresh RIFF/WAVE header, and copies or byte-swaps each
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
  if (requestedFormat !== undefined && requestedFormat !== layout.format) return undefined;
  if (requestedChannels !== undefined && requestedChannels !== layout.channels) return undefined;
  if (requestedSampleRate !== undefined && requestedSampleRate !== sampleRate) return undefined;

  const bytesPer = bytesPerSample(layout.format);
  const frameBytes = layout.channels * bytesPer;
  const dataBytes =
    ssndSampleOffset < 0 || frameBytes <= 0
      ? 0
      : Math.floor(ssndSampleBytes / frameBytes) * frameBytes;
  const out = new Uint8Array(44 + dataBytes);
  writeWavHeader(out, dataBytes, layout.channels, sampleRate, layout.format);
  if (dataBytes === 0) return out;

  const sampleStart = ssndSampleOffset;
  const sampleEnd = sampleStart + dataBytes;
  if (layout.endian === 'le' || bytesPer === 1) {
    out.set(bytes.subarray(sampleStart, sampleEnd), 44);
    return out;
  }

  copyByteSwappedSamples(bytes, sampleStart, out, 44, dataBytes, bytesPer);
  return out;
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
