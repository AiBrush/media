/**
 * Fused WAV sample-domain transform for the overwhelmingly common interleaved s16/f32 layouts.
 *
 * The canonical DSP path intentionally uses planar Float64 buffers, which is the right general
 * representation for arbitrary filter chains. For a simple gain/fade/remix, however, decoding the
 * whole file to N planar buffers, allocating again for each stage, and interleaving it once more is
 * avoidable. This path applies the same operations directly while writing the canonical WAV output.
 */

import type { PcmTransform } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { dbToLinear } from '../../dsp/gain.ts';
import { roundHalfToEven } from '../../dsp/pcm.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const RIFF_HEADER_REMAINDER_BYTES = 36;
const ABORT_CHECK_INTERVAL = 16_384;
const S16_SCALE = 32_768;
const nativeLittleEndian = new Uint8Array(new Uint16Array([0x00ff]).buffer)[0] === 0xff;

type DirectFormat = 's16' | 'f32';
type FadeShape = 'linear' | 'equal-power';

interface FadePlan {
  readonly inFrames: number;
  readonly outFrames: number;
  readonly shape: FadeShape;
}

interface DirectMatrixRow {
  readonly sources: Int32Array;
  readonly coefficients: Float64Array;
}

interface DirectPlan {
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly frames: number;
  readonly sampleRate: number;
  readonly gainFactor: number | undefined;
  readonly fade: FadePlan | undefined;
  readonly matrix: readonly (readonly number[])[] | undefined;
  readonly matrixRows: readonly DirectMatrixRow[] | undefined;
  readonly signal: AbortSignal | undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function finiteFadeFrames(value: unknown, sampleRate: number, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InputError(`${label} must be a finite non-negative duration`);
  }
  const frames = Math.round(value * sampleRate);
  if (!Number.isSafeInteger(frames))
    throw new InputError(`${label} is too large for a safe frame count`);
  return frames;
}

function fadePlan(value: unknown, sampleRate: number): FadePlan | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new InputError('audio fade must be an object');
  }
  const input = value as {
    readonly inSec?: unknown;
    readonly outSec?: unknown;
    readonly curve?: unknown;
  };
  const shape =
    input.curve === undefined || input.curve === 'linear'
      ? 'linear'
      : input.curve === 'equal-power'
        ? 'equal-power'
        : undefined;
  if (shape === undefined)
    throw new InputError(`unsupported audio fade curve '${String(input.curve)}'`);
  return {
    inFrames: finiteFadeFrames(input.inSec, sampleRate, 'fade-in duration'),
    outFrames: finiteFadeFrames(input.outSec, sampleRate, 'fade-out duration'),
    shape,
  };
}

function validateMatrix(
  matrix: readonly (readonly number[])[] | undefined,
  inputChannels: number,
  outputChannels: number,
): readonly (readonly number[])[] | undefined {
  if (matrix === undefined) return undefined;
  if (matrix.length !== outputChannels) {
    throw new InputError(
      `audio mix matrix has ${matrix.length} output row(s), expected ${outputChannels}`,
    );
  }
  for (let output = 0; output < matrix.length; output++) {
    const row = matrix[output];
    if (row === undefined || row.length !== inputChannels) {
      throw new InputError(
        `audio mix matrix row ${output} has ${row?.length ?? 0} coefficient(s), expected ${inputChannels}`,
      );
    }
    for (const coefficient of row) {
      if (!Number.isFinite(coefficient)) {
        throw new InputError('audio mix matrix coefficients must be finite numbers');
      }
    }
  }
  return matrix;
}

function compileMatrix(
  matrix: readonly (readonly number[])[] | undefined,
): readonly DirectMatrixRow[] | undefined {
  if (matrix === undefined) return undefined;
  return matrix.map((row) => {
    const sources: number[] = [];
    const coefficients: number[] = [];
    for (let source = 0; source < row.length; source++) {
      const coefficient = row[source] as number;
      if (coefficient === 0) continue;
      sources.push(source);
      coefficients.push(coefficient);
    }
    return {
      sources: Int32Array.from(sources),
      coefficients: Float64Array.from(coefficients),
    };
  });
}

function supportsDefaultRemix(inputChannels: number, outputChannels: number): boolean {
  return (
    inputChannels === outputChannels ||
    (inputChannels === 1 && outputChannels === 2) ||
    (inputChannels === 2 && (outputChannels === 1 || outputChannels === 6)) ||
    (inputChannels === 6 && (outputChannels === 1 || outputChannels === 2))
  );
}

function gainAt(
  frame: number,
  frames: number,
  fade: FadePlan | undefined,
): {
  readonly inGain: number | undefined;
  readonly outGain: number | undefined;
} {
  if (fade === undefined) return { inGain: undefined, outGain: undefined };
  const inFrames = Math.min(fade.inFrames, frames);
  const outFrames = Math.min(fade.outFrames, frames);
  let inGain: number | undefined;
  let outGain: number | undefined;
  if (inFrames > 0 && frame < inFrames) {
    const t = frame / (inFrames > 1 ? inFrames - 1 : 1);
    inGain = fade.shape === 'linear' ? t : Math.sin((t * Math.PI) / 2);
  }
  const outStart = frames - outFrames;
  if (outFrames > 0 && frame >= outStart) {
    const t = (frame - outStart) / (outFrames > 1 ? outFrames - 1 : 1);
    outGain = fade.shape === 'linear' ? 1 - t : Math.cos((t * Math.PI) / 2);
  }
  return { inGain, outGain };
}

function applyGains(
  value: number,
  gainFactor: number | undefined,
  inGain: number | undefined,
  outGain: number | undefined,
): number {
  let result = value;
  if (gainFactor !== undefined) result *= gainFactor;
  if (inGain !== undefined) result *= inGain;
  if (outGain !== undefined) result *= outGain;
  return result;
}

function clampS16(value: number): number {
  const rounded = roundHalfToEven(value * S16_SCALE);
  if (rounded < -32_768) return -32_768;
  if (rounded > 32_767) return 32_767;
  return rounded;
}

function clampRawS16(value: number): number {
  const rounded = roundHalfToEven(value);
  if (rounded < -32_768) return -32_768;
  if (rounded > 32_767) return 32_767;
  return rounded;
}

/** No-envelope/no-matrix channel remix in the integer domain (scaling by 2^15 is exact). */
function transformPlainS16(input: Int16Array, output: Int16Array, plan: DirectPlan): void {
  const from = plan.inputChannels;
  const to = plan.outputChannels;
  throwIfAborted(plan.signal);
  if (from === 2 && to === 1) {
    for (let frame = 0, source = 0; frame < plan.frames; frame++, source += 2) {
      if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
      output[frame] = roundHalfToEven(
        0.5 * ((input[source] as number) + (input[source + 1] as number)),
      );
    }
    return;
  }
  if (from === 1 && to === 2) {
    for (let frame = 0, target = 0; frame < plan.frames; frame++, target += 2) {
      if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
      const mono = input[frame] as number;
      output[target] = mono;
      output[target + 1] = mono;
    }
    return;
  }
  if (from === 2 && to === 6) {
    for (
      let frame = 0, source = 0, target = 0;
      frame < plan.frames;
      frame++, source += 2, target += 6
    ) {
      if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
      output[target] = input[source] as number;
      output[target + 1] = input[source + 1] as number;
    }
    return;
  }
  if (from === 6 && to === 2) {
    for (
      let frame = 0, source = 0, target = 0;
      frame < plan.frames;
      frame++, source += 6, target += 2
    ) {
      if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
      const center = Math.SQRT1_2 * (input[source + 2] as number);
      output[target] = clampRawS16(
        (input[source] as number) + center + Math.SQRT1_2 * (input[source + 4] as number),
      );
      output[target + 1] = clampRawS16(
        (input[source + 1] as number) + center + Math.SQRT1_2 * (input[source + 5] as number),
      );
    }
    return;
  }
  if (from === 6 && to === 1) {
    for (let frame = 0, source = 0; frame < plan.frames; frame++, source += 6) {
      if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
      const center = Math.SQRT1_2 * (input[source + 2] as number);
      const left =
        (input[source] as number) + center + Math.SQRT1_2 * (input[source + 4] as number);
      const right =
        (input[source + 1] as number) + center + Math.SQRT1_2 * (input[source + 5] as number);
      output[frame] = clampRawS16(0.5 * (left + right));
    }
    return;
  }
  output.set(input);
}

function transformSameLayoutS16(input: Int16Array, output: Int16Array, plan: DirectPlan): void {
  throwIfAborted(plan.signal);
  const channels = plan.inputChannels;
  const fade = plan.fade;
  const inFrames = Math.min(fade?.inFrames ?? 0, plan.frames);
  const outFrames = Math.min(fade?.outFrames ?? 0, plan.frames);
  const inDenom = inFrames > 1 ? inFrames - 1 : 1;
  const outDenom = outFrames > 1 ? outFrames - 1 : 1;
  const outStart = plan.frames - outFrames;
  for (let frame = 0, offset = 0; frame < plan.frames; frame++, offset += channels) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
    let inGain: number | undefined;
    let outGain: number | undefined;
    if (frame < inFrames) {
      const t = frame / inDenom;
      inGain = fade?.shape === 'equal-power' ? Math.sin((t * Math.PI) / 2) : t;
    }
    if (frame >= outStart && outFrames > 0) {
      const t = (frame - outStart) / outDenom;
      outGain = fade?.shape === 'equal-power' ? Math.cos((t * Math.PI) / 2) : 1 - t;
    }
    for (let channel = 0; channel < channels; channel++) {
      let sample = input[offset + channel] as number;
      if (plan.gainFactor !== undefined) sample *= plan.gainFactor;
      if (inGain !== undefined) sample *= inGain;
      if (outGain !== undefined) sample *= outGain;
      output[offset + channel] = clampRawS16(sample);
    }
  }
}

function writeMatrixS16(
  input: Int16Array,
  output: Int16Array,
  plan: DirectPlan,
  frame: number,
  inGain: number | undefined,
  outGain: number | undefined,
  transformed: Float64Array,
): void {
  const inputOffset = frame * plan.inputChannels;
  const outputOffset = frame * plan.outputChannels;
  const rows = plan.matrixRows as readonly DirectMatrixRow[];
  const noEnvelope = plan.gainFactor === undefined && inGain === undefined && outGain === undefined;
  if (!noEnvelope) {
    for (let source = 0; source < plan.inputChannels; source++) {
      transformed[source] = applyGains(
        (input[inputOffset + source] as number) / S16_SCALE,
        plan.gainFactor,
        inGain,
        outGain,
      );
    }
  }
  for (let target = 0; target < plan.outputChannels; target++) {
    const row = rows[target] as DirectMatrixRow;
    const { sources, coefficients } = row;
    let mixed = 0;
    if (noEnvelope) {
      for (let term = 0; term < sources.length; term++) {
        mixed +=
          ((input[inputOffset + (sources[term] as number)] as number) / S16_SCALE) *
          (coefficients[term] as number);
      }
    } else {
      for (let term = 0; term < sources.length; term++) {
        mixed += (transformed[sources[term] as number] as number) * (coefficients[term] as number);
      }
    }
    output[outputOffset + target] = clampS16(mixed);
  }
}

function writeDefaultS16(
  input: Int16Array,
  output: Int16Array,
  plan: DirectPlan,
  frame: number,
  inGain: number | undefined,
  outGain: number | undefined,
): void {
  const from = plan.inputChannels;
  const to = plan.outputChannels;
  const inputOffset = frame * from;
  const outputOffset = frame * to;
  const sample = (channel: number): number =>
    applyGains(
      (input[inputOffset + channel] as number) / S16_SCALE,
      plan.gainFactor,
      inGain,
      outGain,
    );

  if (from === to) {
    for (let channel = 0; channel < from; channel++) {
      output[outputOffset + channel] = clampS16(sample(channel));
    }
    return;
  }
  if (from === 1 && to === 2) {
    const mono = clampS16(sample(0));
    output[outputOffset] = mono;
    output[outputOffset + 1] = mono;
    return;
  }
  if (from === 2 && to === 1) {
    output[outputOffset] = clampS16(0.5 * (sample(0) + sample(1)));
    return;
  }
  if (from === 2 && to === 6) {
    output[outputOffset] = clampS16(sample(0));
    output[outputOffset + 1] = clampS16(sample(1));
    output[outputOffset + 2] = 0;
    output[outputOffset + 3] = 0;
    output[outputOffset + 4] = 0;
    output[outputOffset + 5] = 0;
    return;
  }
  if (from === 6 && to === 2) {
    const center = Math.SQRT1_2 * sample(2);
    output[outputOffset] = clampS16(sample(0) + center + Math.SQRT1_2 * sample(4));
    output[outputOffset + 1] = clampS16(sample(1) + center + Math.SQRT1_2 * sample(5));
    return;
  }
  if (from === 6 && to === 1) {
    const center = Math.SQRT1_2 * sample(2);
    const left = sample(0) + center + Math.SQRT1_2 * sample(4);
    const right = sample(1) + center + Math.SQRT1_2 * sample(5);
    output[outputOffset] = clampS16(0.5 * (left + right));
  }
}

function transformS16(input: Int16Array, output: Int16Array, plan: DirectPlan): void {
  throwIfAborted(plan.signal);
  const matrixInput = plan.matrix === undefined ? undefined : new Float64Array(plan.inputChannels);
  for (let frame = 0; frame < plan.frames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
    const { inGain, outGain } = gainAt(frame, plan.frames, plan.fade);
    if (plan.matrix === undefined) {
      writeDefaultS16(input, output, plan, frame, inGain, outGain);
    } else {
      writeMatrixS16(input, output, plan, frame, inGain, outGain, matrixInput as Float64Array);
    }
  }
}

function writeMatrixF32(
  input: Float32Array,
  output: Float32Array,
  plan: DirectPlan,
  frame: number,
  inGain: number | undefined,
  outGain: number | undefined,
  transformed: Float64Array,
): void {
  const inputOffset = frame * plan.inputChannels;
  const outputOffset = frame * plan.outputChannels;
  const rows = plan.matrixRows as readonly DirectMatrixRow[];
  const noEnvelope = plan.gainFactor === undefined && inGain === undefined && outGain === undefined;
  if (!noEnvelope) {
    for (let source = 0; source < plan.inputChannels; source++) {
      transformed[source] = applyGains(
        input[inputOffset + source] as number,
        plan.gainFactor,
        inGain,
        outGain,
      );
    }
  }
  for (let target = 0; target < plan.outputChannels; target++) {
    const row = rows[target] as DirectMatrixRow;
    const { sources, coefficients } = row;
    let mixed = 0;
    if (noEnvelope) {
      for (let term = 0; term < sources.length; term++) {
        mixed +=
          (input[inputOffset + (sources[term] as number)] as number) *
          (coefficients[term] as number);
      }
    } else {
      for (let term = 0; term < sources.length; term++) {
        mixed += (transformed[sources[term] as number] as number) * (coefficients[term] as number);
      }
    }
    output[outputOffset + target] = mixed;
  }
}

function writeDefaultF32(
  input: Float32Array,
  output: Float32Array,
  plan: DirectPlan,
  frame: number,
  inGain: number | undefined,
  outGain: number | undefined,
): void {
  const from = plan.inputChannels;
  const to = plan.outputChannels;
  const inputOffset = frame * from;
  const outputOffset = frame * to;
  const sample = (channel: number): number =>
    applyGains(input[inputOffset + channel] as number, plan.gainFactor, inGain, outGain);

  if (from === to) {
    for (let channel = 0; channel < from; channel++)
      output[outputOffset + channel] = sample(channel);
    return;
  }
  if (from === 1 && to === 2) {
    const mono = sample(0);
    output[outputOffset] = mono;
    output[outputOffset + 1] = mono;
    return;
  }
  if (from === 2 && to === 1) {
    output[outputOffset] = 0.5 * (sample(0) + sample(1));
    return;
  }
  if (from === 2 && to === 6) {
    output[outputOffset] = sample(0);
    output[outputOffset + 1] = sample(1);
    output[outputOffset + 2] = 0;
    output[outputOffset + 3] = 0;
    output[outputOffset + 4] = 0;
    output[outputOffset + 5] = 0;
    return;
  }
  if (from === 6 && to === 2) {
    const center = Math.SQRT1_2 * sample(2);
    output[outputOffset] = sample(0) + center + Math.SQRT1_2 * sample(4);
    output[outputOffset + 1] = sample(1) + center + Math.SQRT1_2 * sample(5);
    return;
  }
  if (from === 6 && to === 1) {
    const center = Math.SQRT1_2 * sample(2);
    const left = sample(0) + center + Math.SQRT1_2 * sample(4);
    const right = sample(1) + center + Math.SQRT1_2 * sample(5);
    output[outputOffset] = 0.5 * (left + right);
  }
}

function transformF32(input: Float32Array, output: Float32Array, plan: DirectPlan): void {
  throwIfAborted(plan.signal);
  const matrixInput = plan.matrix === undefined ? undefined : new Float64Array(plan.inputChannels);
  for (let frame = 0; frame < plan.frames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
    const { inGain, outGain } = gainAt(frame, plan.frames, plan.fade);
    if (plan.matrix === undefined) {
      writeDefaultF32(input, output, plan, frame, inGain, outGain);
    } else {
      writeMatrixF32(input, output, plan, frame, inGain, outGain, matrixInput as Float64Array);
    }
  }
}

function transformGainOnlyF32(
  input: Float32Array,
  output: Float32Array,
  factor: number,
  signal: AbortSignal | undefined,
): void {
  throwIfAborted(signal);
  const unrolled = input.length - (input.length & 3);
  let sample = 0;
  for (; sample < unrolled; sample += 4) {
    if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    output[sample] = (input[sample] as number) * factor;
    output[sample + 1] = (input[sample + 1] as number) * factor;
    output[sample + 2] = (input[sample + 2] as number) * factor;
    output[sample + 3] = (input[sample + 3] as number) * factor;
  }
  for (; sample < input.length; sample++) {
    if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    output[sample] = (input[sample] as number) * factor;
  }
}

function transformGainOnlyF32View(
  input: DataView,
  output: Float32Array,
  factor: number,
  signal: AbortSignal | undefined,
): void {
  throwIfAborted(signal);
  for (let sample = 0; sample < output.length; sample++) {
    if ((sample & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    output[sample] = input.getFloat32(sample * 4, true) * factor;
  }
}

function transformSameLayoutF32(
  read: (sample: number) => number,
  output: Float32Array,
  plan: DirectPlan,
): void {
  throwIfAborted(plan.signal);
  const channels = plan.inputChannels;
  const fade = plan.fade;
  const inFrames = Math.min(fade?.inFrames ?? 0, plan.frames);
  const outFrames = Math.min(fade?.outFrames ?? 0, plan.frames);
  const inDenom = inFrames > 1 ? inFrames - 1 : 1;
  const outDenom = outFrames > 1 ? outFrames - 1 : 1;
  const outStart = plan.frames - outFrames;
  for (let frame = 0, offset = 0; frame < plan.frames; frame++, offset += channels) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(plan.signal);
    let inGain: number | undefined;
    let outGain: number | undefined;
    if (frame < inFrames) {
      const t = frame / inDenom;
      inGain = fade?.shape === 'equal-power' ? Math.sin((t * Math.PI) / 2) : t;
    }
    if (frame >= outStart && outFrames > 0) {
      const t = (frame - outStart) / outDenom;
      outGain = fade?.shape === 'equal-power' ? Math.cos((t * Math.PI) / 2) : 1 - t;
    }
    for (let channel = 0; channel < channels; channel++) {
      let sample = read(offset + channel);
      if (plan.gainFactor !== undefined) sample *= plan.gainFactor;
      if (inGain !== undefined) sample *= inGain;
      if (outGain !== undefined) sample *= outGain;
      output[offset + channel] = sample;
    }
  }
}

function directFormat(value: string): DirectFormat | undefined {
  return value === 's16' || value === 'f32' ? value : undefined;
}

function hasUnsupportedWork(opts: PcmTransform): boolean {
  return (
    opts.dynamics !== undefined ||
    opts.biquad !== undefined ||
    opts.timeBounds !== undefined ||
    (opts.endian !== undefined && opts.endian !== 'le')
  );
}

/**
 * Apply gain/fade/remix directly to interleaved WAV s16/f32 samples.
 * Returns `undefined` when a different layout or a general DSP stage is required.
 */
export function tryTransformWavSamplesToWav(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  if (!nativeLittleEndian || (opts.container ?? 'wav') !== 'wav' || hasUnsupportedWork(opts)) {
    return undefined;
  }
  const parsed = parseWavPcmData(bytes);
  const format = directFormat(parsed.format);
  if (format === undefined) return undefined;
  if (opts.sampleFormat !== undefined && opts.sampleFormat !== format) return undefined;
  const { fmt } = parsed;
  if (!Number.isInteger(fmt.channels) || fmt.channels <= 0) return undefined;
  if (!Number.isInteger(fmt.sampleRate) || fmt.sampleRate <= 0) return undefined;
  if (opts.sampleRate !== undefined && opts.sampleRate !== fmt.sampleRate) return undefined;

  const outputChannels = opts.channels ?? opts.mixMatrix?.length ?? fmt.channels;
  if (!Number.isInteger(outputChannels) || outputChannels <= 0) {
    throw new CapabilityError(`invalid target channel count ${outputChannels}`, {
      op: { kind: 'route', id: 'filter' },
      tried: [],
    });
  }
  if (
    opts.channels !== undefined &&
    opts.mixMatrix !== undefined &&
    opts.mixMatrix.length !== opts.channels
  ) {
    throw new InputError(
      `audio mix matrix has ${opts.mixMatrix.length} output row(s), expected ${opts.channels}`,
    );
  }
  const matrix = validateMatrix(opts.mixMatrix, fmt.channels, outputChannels);
  const matrixRows = compileMatrix(matrix);
  if (matrix === undefined && !supportsDefaultRemix(fmt.channels, outputChannels)) return undefined;

  const gainFactor =
    opts.gainDb !== undefined && opts.gainDb !== 0 ? dbToLinear(opts.gainDb) : undefined;
  if (gainFactor !== undefined && !Number.isFinite(gainFactor)) return undefined;
  const fade = fadePlan(opts.fade, fmt.sampleRate);
  if (
    gainFactor === undefined &&
    fade === undefined &&
    matrix === undefined &&
    outputChannels === fmt.channels
  ) {
    return undefined;
  }

  const bytesPerSample = format === 's16' ? 2 : 4;
  const inputFrameBytes = fmt.channels * bytesPerSample;
  const frames = Math.floor(parsed.dataSize / inputFrameBytes);
  const outputDataBytes = frames * outputChannels * bytesPerSample;
  if (
    !Number.isSafeInteger(outputDataBytes) ||
    outputDataBytes > 0xffff_ffff - RIFF_HEADER_REMAINDER_BYTES
  ) {
    return undefined;
  }
  const inputOffset = bytes.byteOffset + parsed.dataOffset;
  if (format === 's16' && inputOffset % bytesPerSample !== 0) return undefined;

  const out = new Uint8Array(WAV_HEADER_BYTES + outputDataBytes);
  const plan: DirectPlan = {
    inputChannels: fmt.channels,
    outputChannels,
    frames,
    sampleRate: fmt.sampleRate,
    gainFactor,
    fade,
    matrix,
    matrixRows,
    signal: opts.signal,
  };
  if (format === 's16') {
    const input = new Int16Array(bytes.buffer, inputOffset, frames * fmt.channels);
    const output = new Int16Array(out.buffer, WAV_HEADER_BYTES, frames * outputChannels);
    if (matrix === undefined && gainFactor === undefined && fade === undefined) {
      transformPlainS16(input, output, plan);
    } else if (matrix === undefined && outputChannels === fmt.channels) {
      transformSameLayoutS16(input, output, plan);
    } else {
      transformS16(input, output, plan);
    }
  } else {
    const output = new Float32Array(out.buffer, WAV_HEADER_BYTES, frames * outputChannels);
    if (matrix === undefined && outputChannels === fmt.channels) {
      if (inputOffset % bytesPerSample === 0) {
        const input = new Float32Array(bytes.buffer, inputOffset, frames * fmt.channels);
        if (fade === undefined && gainFactor !== undefined) {
          transformGainOnlyF32(input, output, gainFactor, opts.signal);
        } else {
          transformSameLayoutF32((sample) => input[sample] as number, output, plan);
        }
      } else {
        const input = new DataView(
          bytes.buffer,
          inputOffset,
          frames * fmt.channels * bytesPerSample,
        );
        if (fade === undefined && gainFactor !== undefined) {
          transformGainOnlyF32View(input, output, gainFactor, opts.signal);
        } else {
          transformSameLayoutF32(
            (sample) => input.getFloat32(sample * bytesPerSample, true),
            output,
            plan,
          );
        }
      }
    } else {
      if (inputOffset % bytesPerSample !== 0) return undefined;
      transformF32(
        new Float32Array(bytes.buffer, inputOffset, frames * fmt.channels),
        output,
        plan,
      );
    }
  }
  writeWavHeader(out, outputDataBytes, outputChannels, fmt.sampleRate, format);
  throwIfAborted(opts.signal);
  return out;
}
