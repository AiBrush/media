import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { type SampleFormat, roundHalfToEven } from '../../dsp/pcm.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const RIFF_HEADER_REMAINDER_BYTES = 36;
const ABORT_CHECK_INTERVAL = 16_384;
const nativeLittleEndian = new Uint8Array(new Uint16Array([0x00ff]).buffer)[0] === 0xff;

type DirectInputFormat = 's16' | 's24' | 'f32';
type DirectOutputFormat = 's16' | 's24' | 'f32';

const INPUT_BYTES: Record<DirectInputFormat, number> = {
  s16: 2,
  s24: 3,
  f32: 4,
};

const OUTPUT_BYTES: Record<DirectOutputFormat, number> = {
  s16: 2,
  s24: 3,
  f32: 4,
};

export interface WavPcmFormatConvertOptions {
  readonly sampleFormat: DirectOutputFormat;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly quantization?: WavPcmQuantizationOptions;
  readonly signal?: AbortSignal;
}

export interface WavPcmQuantizationOptions {
  readonly dither: 'none';
  readonly rounding: 'identity' | 'nearest-even' | 'truncate-toward-negative-infinity';
  readonly clipping: 'saturate';
}

type DirectRounding = WavPcmQuantizationOptions['rounding'];

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function hasOtherPcmWork(o: PcmTransform): boolean {
  return (
    o.gainDb !== undefined ||
    o.fade !== undefined ||
    o.mixMatrix !== undefined ||
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
    case 's24':
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

function readS24Le(input: Uint8Array, offset: number): number {
  const raw =
    (input[offset] as number) |
    ((input[offset + 1] as number) << 8) |
    ((input[offset + 2] as number) << 16);
  return raw & 0x80_0000 ? raw - 0x100_0000 : raw;
}

function writeS24Le(output: Uint8Array, offset: number, signed: number): void {
  const raw = signed < 0 ? signed + 0x100_0000 : signed;
  output[offset] = raw & 0xff;
  output[offset + 1] = (raw >> 8) & 0xff;
  output[offset + 2] = (raw >> 16) & 0xff;
}

function convertSamples(
  input: Uint8Array,
  dataOffset: number,
  inputFormat: DirectInputFormat,
  output: Uint8Array<ArrayBuffer>,
  outputFormat: DirectOutputFormat,
  sampleCount: number,
  signal: AbortSignal | undefined,
  hostLittleEndian: boolean,
  rounding: DirectRounding,
): void {
  throwIfAborted(signal);

  if (inputFormat === 's16' && outputFormat === 'f32') {
    const absoluteOffset = input.byteOffset + dataOffset;
    if (hostLittleEndian) {
      const target = new Float32Array(output.buffer, WAV_HEADER_BYTES, sampleCount);
      if ((absoluteOffset & 1) === 0) {
        const source = new Int16Array(input.buffer, absoluteOffset, sampleCount);
        for (let sample = 0; sample < sampleCount; sample++) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target[sample] = (source[sample] as number) / 32_768;
        }
      } else {
        const source = new DataView(input.buffer, absoluteOffset, sampleCount * 2);
        for (let sample = 0; sample < sampleCount; sample++) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target[sample] = source.getInt16(sample * 2, true) / 32_768;
        }
      }
    } else {
      const source = new DataView(input.buffer, absoluteOffset, sampleCount * 2);
      const target = new DataView(output.buffer, WAV_HEADER_BYTES, sampleCount * 4);
      for (let sample = 0; sample < sampleCount; sample++) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        target.setFloat32(sample * 4, source.getInt16(sample * 2, true) / 32_768, true);
      }
    }
    return;
  }

  if (inputFormat === 's16' && outputFormat === 's24') {
    const absoluteOffset = input.byteOffset + dataOffset;
    if (hostLittleEndian && (absoluteOffset & 1) === 0) {
      const source = new Int16Array(input.buffer, absoluteOffset, sampleCount);
      for (
        let sample = 0, outputOffset = WAV_HEADER_BYTES;
        sample < sampleCount;
        sample++, outputOffset += 3
      ) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        writeS24Le(output, outputOffset, (source[sample] as number) * 256);
      }
    } else {
      const source = new DataView(input.buffer, absoluteOffset, sampleCount * 2);
      for (
        let sample = 0, outputOffset = WAV_HEADER_BYTES;
        sample < sampleCount;
        sample++, outputOffset += 3
      ) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        writeS24Le(output, outputOffset, source.getInt16(sample * 2, true) * 256);
      }
    }
    return;
  }

  if (inputFormat === 's24') {
    if (outputFormat === 'f32') {
      if (hostLittleEndian) {
        const target = new Float32Array(output.buffer, WAV_HEADER_BYTES, sampleCount);
        for (let sample = 0, offset = dataOffset; sample < sampleCount; sample++, offset += 3) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target[sample] = readS24Le(input, offset) / 8_388_608;
        }
      } else {
        const target = new DataView(output.buffer, WAV_HEADER_BYTES, sampleCount * 4);
        for (let sample = 0, offset = dataOffset; sample < sampleCount; sample++, offset += 3) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target.setFloat32(sample * 4, readS24Le(input, offset) / 8_388_608, true);
        }
      }
      return;
    }
    if (rounding === 'truncate-toward-negative-infinity') {
      // Arithmetic s24 >> 8 is exactly the source sample's middle/high bytes in little-endian
      // two's-complement form. Copying those bytes avoids sign extension, division, rounding, and
      // host-endian branches while preserving floor semantics for negative residuals.
      for (
        let sample = 0, inputOffset = dataOffset, outputOffset = WAV_HEADER_BYTES;
        sample < sampleCount;
        sample++, inputOffset += 3, outputOffset += 2
      ) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        output[outputOffset] = input[inputOffset + 1] as number;
        output[outputOffset + 1] = input[inputOffset + 2] as number;
      }
      return;
    }
    if (hostLittleEndian) {
      const target = new Int16Array(output.buffer, WAV_HEADER_BYTES, sampleCount);
      for (let sample = 0, offset = dataOffset; sample < sampleCount; sample++, offset += 3) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        target[sample] = clampInt(roundHalfToEven(readS24Le(input, offset) / 256), -32_768, 32_767);
      }
    } else {
      const target = new DataView(output.buffer, WAV_HEADER_BYTES, sampleCount * 2);
      for (let sample = 0, offset = dataOffset; sample < sampleCount; sample++, offset += 3) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        target.setInt16(
          sample * 2,
          clampInt(roundHalfToEven(readS24Le(input, offset) / 256), -32_768, 32_767),
          true,
        );
      }
    }
    return;
  }

  if (inputFormat === 'f32' && outputFormat === 's16') {
    const absoluteOffset = input.byteOffset + dataOffset;
    if (hostLittleEndian) {
      const target = new Int16Array(output.buffer, WAV_HEADER_BYTES, sampleCount);
      if ((absoluteOffset & 3) === 0) {
        const source = new Float32Array(input.buffer, absoluteOffset, sampleCount);
        for (let sample = 0; sample < sampleCount; sample++) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target[sample] = clampInt(
            roundHalfToEven((source[sample] as number) * 32_768),
            -32_768,
            32_767,
          );
        }
      } else {
        const source = new DataView(input.buffer, absoluteOffset, sampleCount * 4);
        for (let sample = 0; sample < sampleCount; sample++) {
          if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
          target[sample] = clampInt(
            roundHalfToEven(source.getFloat32(sample * 4, true) * 32_768),
            -32_768,
            32_767,
          );
        }
      }
    } else {
      const source = new DataView(input.buffer, absoluteOffset, sampleCount * 4);
      const target = new DataView(output.buffer, WAV_HEADER_BYTES, sampleCount * 2);
      for (let sample = 0; sample < sampleCount; sample++) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        target.setInt16(
          sample * 2,
          clampInt(roundHalfToEven(source.getFloat32(sample * 4, true) * 32_768), -32_768, 32_767),
          true,
        );
      }
    }
    return;
  }

  if (inputFormat === 'f32' && outputFormat === 's24') {
    const absoluteOffset = input.byteOffset + dataOffset;
    if (hostLittleEndian && (absoluteOffset & 3) === 0) {
      const source = new Float32Array(input.buffer, absoluteOffset, sampleCount);
      for (
        let sample = 0, outputOffset = WAV_HEADER_BYTES;
        sample < sampleCount;
        sample++, outputOffset += 3
      ) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        let signed = roundHalfToEven((source[sample] as number) * 8_388_608);
        if (signed < -8_388_608) signed = -8_388_608;
        else if (signed > 8_388_607) signed = 8_388_607;
        const raw = signed < 0 ? signed + 0x100_0000 : signed;
        output[outputOffset] = raw & 0xff;
        output[outputOffset + 1] = (raw >> 8) & 0xff;
        output[outputOffset + 2] = (raw >> 16) & 0xff;
      }
    } else {
      const source = new DataView(input.buffer, absoluteOffset, sampleCount * 4);
      for (
        let sample = 0, outputOffset = WAV_HEADER_BYTES;
        sample < sampleCount;
        sample++, outputOffset += 3
      ) {
        if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
        let signed = roundHalfToEven(source.getFloat32(sample * 4, true) * 8_388_608);
        if (signed < -8_388_608) signed = -8_388_608;
        else if (signed > 8_388_607) signed = 8_388_607;
        const raw = signed < 0 ? signed + 0x100_0000 : signed;
        output[outputOffset] = raw & 0xff;
        output[outputOffset + 1] = (raw >> 8) & 0xff;
        output[outputOffset + 2] = (raw >> 16) & 0xff;
      }
    }
    return;
  }

  throw new Error(`unreachable direct PCM conversion ${inputFormat}→${outputFormat}`);
}

function eligibleOutputFormat(opts: PcmTransform): DirectOutputFormat | undefined {
  if ((opts.container ?? 'wav') !== 'wav') return undefined;
  if (opts.sampleFormat === undefined) return undefined;
  if (opts.endian !== undefined && opts.endian !== 'le') return undefined;
  if (hasOtherPcmWork(opts)) return undefined;
  return directOutputFormat(opts.sampleFormat);
}

function requestedRounding(
  inputFormat: DirectInputFormat,
  outputFormat: DirectOutputFormat,
  quantization: WavPcmQuantizationOptions | undefined,
): DirectRounding | undefined {
  if (quantization === undefined) return 'nearest-even';
  if (quantization.dither !== 'none' || quantization.clipping !== 'saturate') return undefined;
  const rounding = quantization.rounding;
  if (outputFormat === 'f32') return rounding === 'identity' ? rounding : undefined;
  if (inputFormat === 's16' && outputFormat === 's24') {
    return rounding === 'identity' || rounding === 'nearest-even' ? rounding : undefined;
  }
  if (inputFormat === 's24' && outputFormat === 's16') {
    return rounding === 'nearest-even' || rounding === 'truncate-toward-negative-infinity'
      ? rounding
      : undefined;
  }
  return rounding === 'nearest-even' ? rounding : undefined;
}

function convertWavPcmFormatToWav(
  bytes: Uint8Array,
  opts: PcmTransform,
  hostLittleEndian: boolean,
  quantization: WavPcmQuantizationOptions | undefined,
): Uint8Array<ArrayBuffer> | undefined {
  const outputFormat = eligibleOutputFormat(opts);
  if (outputFormat === undefined) return undefined;

  const parsed = parseWavPcmData(bytes);
  const inputFormat = directInputFormat(parsed.format);
  if (inputFormat === undefined || inputFormat === outputFormat) return undefined;
  const rounding = requestedRounding(inputFormat, outputFormat, quantization);
  if (rounding === undefined) return undefined;
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
    bytes,
    parsed.dataOffset,
    inputFormat,
    out,
    outputFormat,
    sampleCount,
    opts.signal,
    hostLittleEndian,
    rounding,
  );
  writeWavHeader(out, outputDataBytes, fmt.channels, fmt.sampleRate, outputFormat);
  throwIfAborted(opts.signal);
  return out;
}

/**
 * Try the bounded direct conversion. `hostLittleEndian` is injectable so portability tests can exercise
 * the DataView-only path that a big-endian JS host must use; production callers leave it at the native
 * default.
 */
export function tryConvertWavPcmFormatToWav(
  bytes: Uint8Array,
  opts: PcmTransform,
  hostLittleEndian = nativeLittleEndian,
): Uint8Array<ArrayBuffer> | undefined {
  return convertWavPcmFormatToWav(bytes, opts, hostLittleEndian, undefined);
}

export function wavPcmFormatToWavFromBytes(
  bytes: Uint8Array,
  opts: WavPcmFormatConvertOptions,
): Uint8Array<ArrayBuffer> | undefined {
  const { quantization, ...transform } = opts;
  return convertWavPcmFormatToWav(
    bytes,
    { container: 'wav', ...transform },
    nativeLittleEndian,
    quantization,
  );
}
