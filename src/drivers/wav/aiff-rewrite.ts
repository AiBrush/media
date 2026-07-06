import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { SampleFormat } from '../../dsp/pcm.ts';
import { bytesPerSample } from '../../dsp/pcm.ts';
import { writeExtendedFloat80 } from '../aiff/aiff.ts';
import { parseWavPcmData } from './pcm.ts';

const AIFF_HEADER_BYTES = 54;
const AIFF_COMM_SIZE = 18;
const AIFF_SSND_PREFIX_BYTES = 8;
const ABORT_CHECK_INTERVAL = 16_384;

type SwappableFormat = 's16' | 's24';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function hasOtherPcmWork(o: PcmTransform): boolean {
  return (
    o.gainDb !== undefined ||
    o.fade !== undefined ||
    o.dynamics !== undefined ||
    o.biquad !== undefined ||
    o.timeBounds !== undefined
  );
}

function swappableFormat(format: SampleFormat): SwappableFormat | undefined {
  switch (format) {
    case 's16':
    case 's24':
      return format;
    default:
      return undefined;
  }
}

function writeFourCC(dv: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) dv.setUint8(offset + i, tag.charCodeAt(i));
}

function writePlainAiffHeader(
  out: Uint8Array,
  dataBytes: number,
  channels: number,
  sampleRate: number,
  format: SwappableFormat,
): void {
  const sampleBytes = bytesPerSample(format);
  const frames = Math.floor(dataBytes / (channels * sampleBytes));
  const ssndSize = AIFF_SSND_PREFIX_BYTES + dataBytes;
  const formBody = 4 + (8 + AIFF_COMM_SIZE) + (8 + ssndSize);
  const dv = new DataView(out.buffer);
  writeFourCC(dv, 0, 'FORM');
  dv.setUint32(4, formBody);
  writeFourCC(dv, 8, 'AIFF');
  writeFourCC(dv, 12, 'COMM');
  dv.setUint32(16, AIFF_COMM_SIZE);
  dv.setUint16(20, channels);
  dv.setUint32(22, frames);
  dv.setUint16(26, sampleBytes * 8);
  out.set(writeExtendedFloat80(sampleRate), 28);
  writeFourCC(dv, 38, 'SSND');
  dv.setUint32(42, ssndSize);
  dv.setUint32(46, 0);
  dv.setUint32(50, 0);
}

function byteSwapSamples(
  src: Uint8Array,
  srcStart: number,
  dst: Uint8Array,
  dstStart: number,
  sampleCount: number,
  bytesPerSampleValue: number,
  signal: AbortSignal | undefined,
): void {
  throwIfAborted(signal);
  let srcOffset = srcStart;
  let dstOffset = dstStart;
  if (bytesPerSampleValue === 2) {
    for (let sample = 0; sample < sampleCount; sample++) {
      if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
      dst[dstOffset] = src[srcOffset + 1] ?? 0;
      dst[dstOffset + 1] = src[srcOffset] ?? 0;
      srcOffset += 2;
      dstOffset += 2;
    }
    return;
  }
  for (let sample = 0; sample < sampleCount; sample++) {
    if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    for (let i = 0; i < bytesPerSampleValue; i++) {
      dst[dstOffset + i] = src[srcOffset + bytesPerSampleValue - 1 - i] ?? 0;
    }
    srcOffset += bytesPerSampleValue;
    dstOffset += bytesPerSampleValue;
  }
}

export function tryRewriteWavPcmToAiffBe(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  if ((opts.container ?? 'wav') !== 'aiff') return undefined;
  if (opts.endian !== 'be') return undefined;
  if (hasOtherPcmWork(opts)) return undefined;

  const parsed = parseWavPcmData(bytes);
  const format = swappableFormat(parsed.format);
  if (format === undefined) return undefined;
  if (opts.sampleFormat !== undefined && opts.sampleFormat !== format) return undefined;
  const { fmt } = parsed;
  if (fmt.channels <= 0 || !Number.isInteger(fmt.channels)) return undefined;
  if (fmt.sampleRate <= 0 || !Number.isInteger(fmt.sampleRate)) return undefined;
  if (opts.channels !== undefined && opts.channels !== fmt.channels) return undefined;
  if (opts.sampleRate !== undefined && opts.sampleRate !== fmt.sampleRate) return undefined;

  const sampleBytes = bytesPerSample(format);
  const frameBytes = fmt.channels * sampleBytes;
  const frames = Math.floor(parsed.dataSize / frameBytes);
  const sampleCount = frames * fmt.channels;
  const outputDataBytes = sampleCount * sampleBytes;
  if (!Number.isSafeInteger(outputDataBytes)) return undefined;

  const out = new Uint8Array(AIFF_HEADER_BYTES + outputDataBytes);
  writePlainAiffHeader(out, outputDataBytes, fmt.channels, fmt.sampleRate, format);
  byteSwapSamples(
    bytes,
    parsed.dataOffset,
    out,
    AIFF_HEADER_BYTES,
    sampleCount,
    sampleBytes,
    opts.signal,
  );
  throwIfAborted(opts.signal);
  return out;
}
