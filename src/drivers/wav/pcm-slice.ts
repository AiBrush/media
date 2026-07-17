/**
 * Lazy WAV PCM time-slice helper. Ordinary WAV decode/convert/probe paths stay in `pcm.ts`; the byte-slice
 * trim branch lives here so the default driver bundle does not pay for trim-only frame-window logic.
 */

import { InputError } from '../../contracts/errors.ts';
import { type Endianness, type SampleFormat, bytesPerSample } from '../../dsp/pcm.ts';
import { type WavPcmData, parseWavPcmData, writeWavHeader } from './pcm.ts';

const TRIM_END_SLACK_SEC = 1;

export interface WavPcmTimeBounds {
  readonly startSec: number;
  readonly endSec: number;
}

export interface WavPcmByteSlicePlan {
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly format: SampleFormat;
}

function wavFrameWindow(
  parsed: WavPcmData,
  bounds: WavPcmTimeBounds,
): { readonly startByte: number; readonly endByte: number } | undefined {
  const { fmt, format } = parsed;
  if (!Number.isFinite(bounds.startSec) || !Number.isFinite(bounds.endSec)) {
    throw new InputError('bad trim');
  }
  if (bounds.startSec < 0) {
    throw new InputError('start<0');
  }
  if (bounds.endSec <= bounds.startSec) {
    throw new InputError('empty trim');
  }
  if (fmt.channels <= 0 || fmt.sampleRate <= 0) return undefined;
  const frameBytes = fmt.channels * bytesPerSample(format);
  const totalFrames = Math.floor(parsed.dataSize / frameBytes);
  const durationSec = totalFrames / fmt.sampleRate;
  if (durationSec > 0) {
    if (bounds.startSec >= durationSec) {
      throw new InputError('start>=duration');
    }
    if (bounds.endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError('end>duration');
    }
  }
  const startFrame = Math.min(
    totalFrames,
    Math.max(0, Math.round(bounds.startSec * fmt.sampleRate)),
  );
  const endFrame = Math.min(
    totalFrames,
    Math.max(startFrame, Math.round(bounds.endSec * fmt.sampleRate)),
  );
  return { startByte: startFrame * frameBytes, endByte: endFrame * frameBytes };
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

/**
 * Re-author a time-sliced WAV by copying the selected interleaved PCM bytes directly from the source data
 * chunk into a fresh canonical RIFF/WAVE envelope. The frame math intentionally mirrors
 * `applyPcmTransform`'s sample-domain trim (`Math.round(sec * sampleRate)`, clamp to real frames), but this
 * path avoids the full `decodePcm`/`encodePcm` round-trip when the requested layout is otherwise identical.
 */
export function slice(
  bytes: Uint8Array,
  bounds: WavPcmTimeBounds,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
): Uint8Array<ArrayBuffer> | undefined {
  const plan = planByteSlice(
    bytes,
    bounds,
    requestedFormat,
    endian,
    requestedChannels,
    requestedSampleRate,
    bytes.byteLength,
  );
  if (plan === undefined) return undefined;
  return writePlannedSlice(bytes.subarray(plan.dataStart, plan.dataEnd), plan);
}

export function planByteSlice(
  bytes: Uint8Array,
  bounds: WavPcmTimeBounds,
  requestedFormat?: SampleFormat,
  endian: Endianness = 'le',
  requestedChannels?: number,
  requestedSampleRate?: number,
  totalSize = bytes.byteLength,
): WavPcmByteSlicePlan | undefined {
  if (endian !== 'le') return undefined;
  const parsed = parseWavPcmData(bytes, totalSize);
  const { fmt, format } = parsed;
  if (parsed.dataOffset < 0) return undefined;
  if (requestedFormat !== undefined && requestedFormat !== format) return undefined;
  if (requestedChannels !== undefined && requestedChannels !== fmt.channels) return undefined;
  if (requestedSampleRate !== undefined && requestedSampleRate !== fmt.sampleRate) return undefined;
  const window = wavFrameWindow(parsed, bounds);
  if (window === undefined) return undefined;
  return {
    dataStart: parsed.dataOffset + window.startByte,
    dataEnd: parsed.dataOffset + window.endByte,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    format,
  };
}

export function writePlannedSlice(
  data: Uint8Array,
  plan: WavPcmByteSlicePlan,
): Uint8Array<ArrayBuffer> {
  return writeWavContainer(data, plan.channels, plan.sampleRate, plan.format);
}
