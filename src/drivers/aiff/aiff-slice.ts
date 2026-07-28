import type { PcmTransform } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import type { SampleFormat } from '../../dsp/pcm.ts';
import { bytesPerSample } from '../../dsp/pcm.ts';
import { aiffPcmSampleBytes, locate, writeExtendedFloat80 } from './aiff.ts';

const AIFF_HEADER_BYTES = 54;
const AIFF_COMM_SIZE = 18;
const AIFF_SSND_PREFIX_BYTES = 8;
const TRIM_END_SLACK_SEC = 1;

type SliceFormat = 's16' | 's24' | 's32';

function hasOtherPcmWork(o: PcmTransform): boolean {
  return (
    o.gainDb !== undefined ||
    o.fade !== undefined ||
    o.mixMatrix !== undefined ||
    o.dynamics !== undefined ||
    o.biquad !== undefined
  );
}

function sliceFormat(format: SampleFormat): SliceFormat | undefined {
  switch (format) {
    case 's16':
    case 's24':
    case 's32':
      return format;
    default:
      return undefined;
  }
}

function writeFourCC(dv: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) dv.setUint8(offset + i, tag.charCodeAt(i));
}

function validateBounds(
  bounds: { readonly startSec: number; readonly endSec: number },
  totalFrames: number,
  sampleRate: number,
): { readonly startFrame: number; readonly endFrame: number } {
  if (!Number.isFinite(bounds.startSec) || !Number.isFinite(bounds.endSec)) {
    throw new InputError('bad trim');
  }
  if (bounds.startSec < 0) {
    throw new InputError('start<0');
  }
  if (bounds.endSec <= bounds.startSec) {
    throw new InputError('empty trim');
  }
  const durationSec = sampleRate > 0 ? totalFrames / sampleRate : 0;
  if (durationSec > 0) {
    if (bounds.startSec >= durationSec) {
      throw new InputError('start>=duration');
    }
    if (bounds.endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError('end>duration');
    }
  }
  const startFrame = Math.min(totalFrames, Math.max(0, Math.round(bounds.startSec * sampleRate)));
  const endFrame = Math.min(
    totalFrames,
    Math.max(startFrame, Math.round(bounds.endSec * sampleRate)),
  );
  return { startFrame, endFrame };
}

function writePlainAiffHeader(
  out: Uint8Array,
  dataBytes: number,
  channels: number,
  sampleRate: number,
  format: SliceFormat,
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

export function trySliceAiffPcm(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  const bounds = opts.timeBounds;
  if (bounds === undefined) return undefined;
  if ((opts.container ?? 'aiff') !== 'aiff') return undefined;
  if (hasOtherPcmWork(opts)) return undefined;

  const { layout, ssndSampleOffset, ssndSampleBytes } = locate(bytes);
  if (layout.kind !== 'aiff' || layout.endian !== 'be') return undefined;
  const format = sliceFormat(layout.format);
  if (format === undefined) return undefined;
  if (opts.sampleFormat !== undefined && opts.sampleFormat !== format) return undefined;
  if (opts.endian !== undefined && opts.endian !== 'be') return undefined;
  const sampleRate = Math.round(layout.sampleRate);
  if (layout.channels <= 0 || sampleRate <= 0) return undefined;
  if (opts.channels !== undefined && opts.channels !== layout.channels) return undefined;
  if (opts.sampleRate !== undefined && opts.sampleRate !== sampleRate) return undefined;
  aiffPcmSampleBytes(layout, ssndSampleOffset, ssndSampleBytes);
  if (ssndSampleOffset < 0) return undefined;

  const frameBytes = layout.channels * bytesPerSample(format);
  const realFrames = layout.frames;
  const { startFrame, endFrame } = validateBounds(bounds, realFrames, sampleRate);
  const startByte = ssndSampleOffset + startFrame * frameBytes;
  const endByte = ssndSampleOffset + endFrame * frameBytes;
  if (startByte > endByte || endByte > bytes.byteLength) return undefined;
  if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');

  const data = bytes.subarray(startByte, endByte);
  const out = new Uint8Array(AIFF_HEADER_BYTES + data.byteLength);
  writePlainAiffHeader(out, data.byteLength, layout.channels, sampleRate, format);
  out.set(data, AIFF_HEADER_BYTES);
  if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  return out;
}
