import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { dbToLinear } from '../../dsp/gain.ts';
import type { Endianness, SampleFormat } from '../../dsp/pcm.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const F32_BYTES_PER_SAMPLE = 4;
const RIFF_HEADER_REMAINDER_BYTES = 36;
const ABORT_CHECK_INTERVAL = 16_384;

const nativeLittleEndian = new Uint8Array(new Uint16Array([0x00ff]).buffer)[0] === 0xff;

export interface WavF32GainOptions {
  readonly gainDb: number;
  readonly sampleFormat?: SampleFormat;
  readonly endian?: Endianness;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function hasOtherPcmWork(o: PcmTransform): boolean {
  return (
    o.fade !== undefined ||
    o.mixMatrix !== undefined ||
    o.dynamics !== undefined ||
    o.biquad !== undefined ||
    o.timeBounds !== undefined
  );
}

function scaleF32Array(
  input: Float32Array,
  output: Float32Array,
  factor: number,
  signal: AbortSignal | undefined,
): void {
  throwIfAborted(signal);
  const unrolled = input.length - (input.length & 3);
  let i = 0;
  for (; i < unrolled; i += 4) {
    if ((i & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    output[i] = (input[i] as number) * factor;
    output[i + 1] = (input[i + 1] as number) * factor;
    output[i + 2] = (input[i + 2] as number) * factor;
    output[i + 3] = (input[i + 3] as number) * factor;
  }
  for (; i < input.length; i++) {
    if ((i & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    output[i] = (input[i] as number) * factor;
  }
}

function scaleF32View(
  bytes: Uint8Array,
  dataOffset: number,
  output: Uint8Array,
  sampleCount: number,
  factor: number,
  signal: AbortSignal | undefined,
): void {
  const inputView = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, sampleCount * 4);
  const outputView = new DataView(output.buffer, WAV_HEADER_BYTES, sampleCount * 4);
  throwIfAborted(signal);
  for (let i = 0; i < sampleCount; i++) {
    if ((i & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    outputView.setFloat32(i * 4, inputView.getFloat32(i * 4, true) * factor, true);
  }
}

export function tryGainWavF32ToF32Wav(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  if ((opts.container ?? 'wav') !== 'wav') return undefined;
  if (opts.sampleFormat !== undefined && opts.sampleFormat !== 'f32') return undefined;
  if (opts.endian !== undefined && opts.endian !== 'le') return undefined;
  if (opts.gainDb === undefined || opts.gainDb === 0 || !Number.isFinite(opts.gainDb)) {
    return undefined;
  }
  if (hasOtherPcmWork(opts)) return undefined;

  const parsed = parseWavPcmData(bytes);
  const { fmt } = parsed;
  if (parsed.format !== 'f32') return undefined;
  if (fmt.channels <= 0 || !Number.isInteger(fmt.channels)) return undefined;
  if (fmt.sampleRate <= 0 || !Number.isInteger(fmt.sampleRate)) return undefined;
  if (opts.channels !== undefined && opts.channels !== fmt.channels) return undefined;
  if (opts.sampleRate !== undefined && opts.sampleRate !== fmt.sampleRate) return undefined;

  const inputFrameBytes = fmt.channels * F32_BYTES_PER_SAMPLE;
  const inputFrames = Math.floor(parsed.dataSize / inputFrameBytes);
  const sampleCount = inputFrames * fmt.channels;
  const outputDataBytes = sampleCount * F32_BYTES_PER_SAMPLE;
  if (
    !Number.isSafeInteger(outputDataBytes) ||
    outputDataBytes > 0xffff_ffff - RIFF_HEADER_REMAINDER_BYTES
  ) {
    return undefined;
  }

  throwIfAborted(opts.signal);
  const factor = dbToLinear(opts.gainDb);
  const out = new Uint8Array(WAV_HEADER_BYTES + outputDataBytes);
  const inputOffset = bytes.byteOffset + parsed.dataOffset;
  if (nativeLittleEndian && (inputOffset & 3) === 0) {
    const input = new Float32Array(bytes.buffer, inputOffset, sampleCount);
    const output = new Float32Array(out.buffer, WAV_HEADER_BYTES, sampleCount);
    scaleF32Array(input, output, factor, opts.signal);
  } else {
    scaleF32View(bytes, parsed.dataOffset, out, sampleCount, factor, opts.signal);
  }
  writeWavHeader(out, outputDataBytes, fmt.channels, fmt.sampleRate, 'f32');
  throwIfAborted(opts.signal);
  return out;
}

export function wavF32GainToWavFromBytes(
  bytes: Uint8Array,
  opts: WavF32GainOptions,
): Uint8Array<ArrayBuffer> | undefined {
  return tryGainWavF32ToF32Wav(bytes, { container: 'wav', ...opts });
}
