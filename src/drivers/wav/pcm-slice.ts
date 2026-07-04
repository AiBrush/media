/**
 * Lazy WAV PCM time-slice helper. Ordinary WAV decode/convert/probe paths stay in `pcm.ts`; the byte-slice
 * trim branch lives here so the default driver bundle does not pay for trim-only frame-window logic.
 */

import { InputError } from '../../contracts/errors.ts';
import { type Endianness, type SampleFormat, bytesPerSample } from '../../dsp/pcm.ts';
import { type WavPcmData, parseWavPcmData, writeWavHeader } from './pcm.ts';

export interface WavPcmTimeBounds {
  readonly startSec: number;
  readonly endSec: number;
}

function wavFrameWindow(
  parsed: WavPcmData,
  bounds: WavPcmTimeBounds,
): { readonly startByte: number; readonly endByte: number } | undefined {
  const { fmt, format, data } = parsed;
  if (!Number.isFinite(bounds.startSec) || !Number.isFinite(bounds.endSec)) {
    throw new InputError('unsupported-input', 'bad trim');
  }
  if (bounds.startSec < 0) {
    throw new InputError('unsupported-input', 'start<0');
  }
  if (bounds.endSec <= bounds.startSec) {
    throw new InputError('unsupported-input', 'empty trim');
  }
  if (fmt.channels <= 0 || fmt.sampleRate <= 0) return undefined;
  const frameBytes = fmt.channels * bytesPerSample(format);
  const totalFrames = Math.floor(data.byteLength / frameBytes);
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
  if (endian !== 'le') return undefined;
  const parsed = parseWavPcmData(bytes);
  const { fmt, format, data } = parsed;
  if (requestedFormat !== undefined && requestedFormat !== format) return undefined;
  if (requestedChannels !== undefined && requestedChannels !== fmt.channels) return undefined;
  if (requestedSampleRate !== undefined && requestedSampleRate !== fmt.sampleRate) return undefined;
  const window = wavFrameWindow(parsed, bounds);
  if (window === undefined) return undefined;
  return writeWavContainer(
    data.subarray(window.startByte, window.endByte),
    fmt.channels,
    fmt.sampleRate,
    format,
  );
}
