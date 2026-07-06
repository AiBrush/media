import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { SampleFormat } from '../../dsp/pcm.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const RIFF_HEADER_REMAINDER_BYTES = 36;
const ABORT_CHECK_INTERVAL = 16_384;

type DirectInputFormat = 's16' | 's24' | 'f32';
type DirectOutputFormat = 's16' | 'f32';

const INPUT_BYTES: Record<DirectInputFormat, number> = {
  s16: 2,
  s24: 3,
  f32: 4,
};

const OUTPUT_BYTES: Record<DirectOutputFormat, number> = {
  s16: 2,
  f32: 4,
};

export interface WavPcmFormatConvertOptions {
  readonly sampleFormat: DirectOutputFormat;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
}

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

function directInputFormat(format: SampleFormat): DirectInputFormat | undefined {
  switch (format) {
    case 's16':
    case 's24':
    case 'f32':
      return format;
    default:
      return undefined;
  }
}

function directOutputFormat(format: SampleFormat | undefined): DirectOutputFormat | undefined {
  switch (format) {
    case 's16':
    case 'f32':
      return format;
    default:
      return undefined;
  }
}

function clampInt(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function readS24Le(input: DataView, offset: number): number {
  const raw =
    input.getUint8(offset) | (input.getUint8(offset + 1) << 8) | (input.getUint8(offset + 2) << 16);
  return raw & 0x80_0000 ? raw - 0x100_0000 : raw;
}

function readSample(input: DataView, offset: number, format: DirectInputFormat): number {
  switch (format) {
    case 's16':
      return input.getInt16(offset, true) / 32_768;
    case 's24':
      return readS24Le(input, offset) / 8_388_608;
    case 'f32':
      return input.getFloat32(offset, true);
  }
}

function writeSample(
  output: DataView,
  offset: number,
  value: number,
  format: DirectOutputFormat,
): void {
  switch (format) {
    case 's16':
      output.setInt16(offset, clampInt(Math.round(value * 32_768), -32_768, 32_767), true);
      return;
    case 'f32':
      output.setFloat32(offset, value, true);
      return;
  }
}

function convertSamples(
  input: DataView,
  dataOffset: number,
  inputFormat: DirectInputFormat,
  output: DataView,
  outputFormat: DirectOutputFormat,
  sampleCount: number,
  signal: AbortSignal | undefined,
): void {
  const inputBytes = INPUT_BYTES[inputFormat];
  const outputBytes = OUTPUT_BYTES[outputFormat];
  throwIfAborted(signal);
  for (let sample = 0; sample < sampleCount; sample++) {
    if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    writeSample(
      output,
      WAV_HEADER_BYTES + sample * outputBytes,
      readSample(input, dataOffset + sample * inputBytes, inputFormat),
      outputFormat,
    );
  }
}

function eligibleOutputFormat(opts: PcmTransform): DirectOutputFormat | undefined {
  if ((opts.container ?? 'wav') !== 'wav') return undefined;
  if (opts.sampleFormat === undefined) return undefined;
  if (opts.endian !== undefined && opts.endian !== 'le') return undefined;
  if (hasOtherPcmWork(opts)) return undefined;
  return directOutputFormat(opts.sampleFormat);
}

export function tryConvertWavPcmFormatToWav(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  const outputFormat = eligibleOutputFormat(opts);
  if (outputFormat === undefined) return undefined;

  const parsed = parseWavPcmData(bytes);
  const inputFormat = directInputFormat(parsed.format);
  if (inputFormat === undefined || inputFormat === outputFormat) return undefined;
  const { fmt } = parsed;
  if (fmt.channels <= 0 || !Number.isInteger(fmt.channels)) return undefined;
  if (fmt.sampleRate <= 0 || !Number.isInteger(fmt.sampleRate)) return undefined;
  if (opts.channels !== undefined && opts.channels !== fmt.channels) return undefined;
  if (opts.sampleRate !== undefined && opts.sampleRate !== fmt.sampleRate) return undefined;

  const inputFrameBytes = fmt.channels * INPUT_BYTES[inputFormat];
  const inputFrames = Math.floor(parsed.dataSize / inputFrameBytes);
  const sampleCount = inputFrames * fmt.channels;
  const outputDataBytes = sampleCount * OUTPUT_BYTES[outputFormat];
  if (
    !Number.isSafeInteger(outputDataBytes) ||
    outputDataBytes > 0xffff_ffff - RIFF_HEADER_REMAINDER_BYTES
  ) {
    return undefined;
  }

  const out = new Uint8Array(WAV_HEADER_BYTES + outputDataBytes);
  convertSamples(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    parsed.dataOffset,
    inputFormat,
    new DataView(out.buffer),
    outputFormat,
    sampleCount,
    opts.signal,
  );
  writeWavHeader(out, outputDataBytes, fmt.channels, fmt.sampleRate, outputFormat);
  throwIfAborted(opts.signal);
  return out;
}

export function wavPcmFormatToWavFromBytes(
  bytes: Uint8Array,
  opts: WavPcmFormatConvertOptions,
): Uint8Array<ArrayBuffer> | undefined {
  return tryConvertWavPcmFormatToWav(bytes, { container: 'wav', ...opts });
}
