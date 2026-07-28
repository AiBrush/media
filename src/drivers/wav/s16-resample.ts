import type { ByteSource, PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { roundHalfToEven } from '../../dsp/pcm.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const S16_BYTES_PER_SAMPLE = 2;
const S16_MIN = -32768;
const S16_MAX = 32767;
const FAST_ZERO_CROSSINGS = 6;
const FAST_KAISER_BETA = 8.6;
const MAX_FAST_POLYPHASE_PHASES = 4096;
const ABORT_CHECK_INTERVAL = 4096;
const MAX_FAST_KERNEL_TAPS = 262_144;
const MAX_FAST_BANK_BYTES = 8 * 1024 * 1024;
const FAST_BANK_CACHE_MAX_ENTRIES = 32;
const FAST_BANK_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const FAST_KERNEL_ACCOUNTING_BYTES = 48;
const RANGE_PROBE_BYTES = 64 * 1024;
const RANGE_OUTPUT_CHUNK_BYTES = 2 * 1024 * 1024;
const OPERATION_ABORTED = 'operation aborted';

interface FastKernel {
  readonly firstOffset: number;
  readonly coeffs: Float32Array;
}

interface FastBank {
  readonly kernels: readonly FastKernel[];
  readonly baseIncrements: Int32Array;
  readonly nextPhases: Int32Array;
  readonly phaseCount: number;
  readonly step: number;
  readonly minimumFirstOffset: number;
  readonly maximumEndOffset: number;
  readonly byteSize: number;
}

export interface WavS16ResampleOptions {
  readonly sampleRate: number;
  readonly channels?: number;
  readonly signal?: AbortSignal;
}

interface SizedCacheEntry<T> {
  readonly value: T;
  readonly byteSize: number;
}

/** Deterministic byte-bounded LRU for immutable polyphase banks. */
export class BoundedFastBankCache<T> {
  private readonly entries = new Map<string, SizedCacheEntry<T>>();
  private retainedByteSize = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxByteSize: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      !Number.isSafeInteger(maxByteSize) ||
      maxByteSize < 0
    ) {
      throw new RangeError('cache bounds must be non-negative safe integers');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.retainedByteSize;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, byteSize: number): boolean {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new RangeError('cache entry size must be a non-negative safe integer');
    }
    if (this.maxEntries === 0 || byteSize > this.maxByteSize) return false;

    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.retainedByteSize -= previous.byteSize;
    }

    while (
      this.entries.size >= this.maxEntries ||
      this.retainedByteSize + byteSize > this.maxByteSize
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.retainedByteSize -= oldest?.byteSize ?? 0;
    }

    this.entries.set(key, { value, byteSize });
    this.retainedByteSize += byteSize;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.retainedByteSize = 0;
  }
}

const FAST_BANK_CACHE = new BoundedFastBankCache<FastBank>(
  FAST_BANK_CACHE_MAX_ENTRIES,
  FAST_BANK_CACHE_MAX_BYTES,
);

const nativeLittleEndian = new Uint8Array(new Uint16Array([0x00ff]).buffer)[0] === 0xff;

function hasPcmDomainWork(o: PcmTransform): boolean {
  return (
    o.gainDb !== undefined ||
    o.fade !== undefined ||
    o.mixMatrix !== undefined ||
    o.dynamics !== undefined ||
    o.biquad !== undefined ||
    o.timeBounds !== undefined
  );
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfXSq = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= halfXSq / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function buildKernel(phase: number, phaseCount: number, cutoff: number): FastKernel | undefined {
  const frac = phase / phaseCount;
  const halfSupport = FAST_ZERO_CROSSINGS / cutoff;
  const firstOffset = Math.ceil(frac - halfSupport);
  const lastOffset = Math.floor(frac + halfSupport);
  const tapCount = Math.max(0, lastOffset - firstOffset + 1);
  if (!Number.isSafeInteger(tapCount) || tapCount > MAX_FAST_KERNEL_TAPS) return undefined;
  const coeffs = new Float32Array(tapCount);
  const i0Beta = besselI0(FAST_KAISER_BETA);
  let sum = 0;
  for (let i = 0; i < tapCount; i++) {
    const offset = firstOffset + i;
    const pos = Math.abs((frac - offset) * cutoff);
    let coeff = 0;
    if (pos <= FAST_ZERO_CROSSINGS) {
      const t = pos / FAST_ZERO_CROSSINGS;
      const window = besselI0(FAST_KAISER_BETA * Math.sqrt(Math.max(0, 1 - t * t))) / i0Beta;
      coeff = sinc(pos) * window * cutoff;
    }
    coeffs[i] = coeff;
    sum += coeff;
  }
  if (sum !== 0) {
    for (let i = 0; i < coeffs.length; i++) coeffs[i] = (coeffs[i] as number) / sum;
  }
  return { firstOffset, coeffs };
}

function buildFastBank(inRate: number, outRate: number): FastBank | undefined {
  if (
    !Number.isSafeInteger(inRate) ||
    !Number.isSafeInteger(outRate) ||
    inRate <= 0 ||
    outRate <= 0
  ) {
    return undefined;
  }
  const divisor = gcd(inRate, outRate);
  const phaseCount = outRate / divisor;
  if (phaseCount > MAX_FAST_POLYPHASE_PHASES) return undefined;
  const key = `${inRate}:${outRate}`;
  const cached = FAST_BANK_CACHE.get(key);
  if (cached !== undefined) return cached;

  const step = inRate / divisor;
  const cutoff = Math.min(1, outRate / inRate);
  const maximumTapCount = Math.ceil((FAST_ZERO_CROSSINGS * 2) / cutoff) + 1;
  if (!Number.isSafeInteger(maximumTapCount) || maximumTapCount > MAX_FAST_KERNEL_TAPS) {
    return undefined;
  }
  const estimatedByteSize =
    phaseCount * (maximumTapCount * Float32Array.BYTES_PER_ELEMENT) +
    phaseCount * (Int32Array.BYTES_PER_ELEMENT * 2 + FAST_KERNEL_ACCOUNTING_BYTES);
  if (!Number.isSafeInteger(estimatedByteSize) || estimatedByteSize > MAX_FAST_BANK_BYTES) {
    return undefined;
  }

  const kernels: FastKernel[] = [];
  let coefficientByteSize = 0;
  let minimumFirstOffset = Number.POSITIVE_INFINITY;
  let maximumEndOffset = Number.NEGATIVE_INFINITY;
  for (let phase = 0; phase < phaseCount; phase++) {
    const kernel = buildKernel(phase, phaseCount, cutoff);
    if (kernel === undefined) return undefined;
    kernels.push(kernel);
    coefficientByteSize += kernel.coeffs.byteLength;
    minimumFirstOffset = Math.min(minimumFirstOffset, kernel.firstOffset);
    maximumEndOffset = Math.max(maximumEndOffset, kernel.firstOffset + kernel.coeffs.length);
  }
  const baseIncrements = new Int32Array(phaseCount);
  const nextPhases = new Int32Array(phaseCount);
  for (let phase = 0; phase < phaseCount; phase++) {
    const next = phase + step;
    const increment = Math.floor(next / phaseCount);
    baseIncrements[phase] = increment;
    nextPhases[phase] = next - increment * phaseCount;
  }
  const byteSize =
    coefficientByteSize +
    baseIncrements.byteLength +
    nextPhases.byteLength +
    kernels.length * FAST_KERNEL_ACCOUNTING_BYTES;
  if (!Number.isSafeInteger(byteSize) || byteSize > MAX_FAST_BANK_BYTES) return undefined;
  const bank = {
    kernels,
    baseIncrements,
    nextPhases,
    phaseCount,
    step,
    minimumFirstOffset,
    maximumEndOffset,
    byteSize,
  };
  FAST_BANK_CACHE.set(key, bank, byteSize);
  return bank;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function clampS16(x: number): number {
  const rounded = roundHalfToEven(x);
  if (rounded < S16_MIN) return S16_MIN;
  if (rounded > S16_MAX) return S16_MAX;
  return rounded;
}

function convolveMonoS16(
  input: Int16Array,
  inputFrames: number,
  start: number,
  coeffs: Float32Array,
): number {
  const tapCount = coeffs.length;
  let acc = 0;
  if (start >= 0 && start + tapCount <= inputFrames) {
    let tap = 0;
    let inputIndex = start;
    const unrolled = tapCount - (tapCount & 3);
    for (; tap < unrolled; tap += 4, inputIndex += 4) {
      acc +=
        (input[inputIndex] as number) * (coeffs[tap] as number) +
        (input[inputIndex + 1] as number) * (coeffs[tap + 1] as number) +
        (input[inputIndex + 2] as number) * (coeffs[tap + 2] as number) +
        (input[inputIndex + 3] as number) * (coeffs[tap + 3] as number);
    }
    for (; tap < tapCount; tap++, inputIndex++) {
      acc += (input[inputIndex] as number) * (coeffs[tap] as number);
    }
  } else {
    for (let tap = 0, inputIndex = start; tap < tapCount; tap++, inputIndex++) {
      if (inputIndex >= 0 && inputIndex < inputFrames) {
        acc += (input[inputIndex] as number) * (coeffs[tap] as number);
      }
    }
  }
  return acc;
}

/**
 * Pairs adjacent interior outputs so V8 can keep two independent FIR accumulators in flight. Each
 * accumulator retains the scalar kernel's four-tap grouping and tail order, making this byte-exact
 * rather than a quality tradeoff. Boundary frames, odd tails, and abort-poll boundaries remain scalar.
 */
function resampleMonoS16(
  input: Int16Array,
  inputFrames: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
): void {
  const { kernels, baseIncrements, nextPhases } = bank;
  let base = 0;
  let phase = 0;
  let frame = 0;
  throwIfAborted(signal);
  while (frame < outFrames) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const firstKernel = kernels[phase] as FastKernel;
    const firstStart = base + firstKernel.firstOffset;
    const secondBase = base + (baseIncrements[phase] as number);
    const secondPhase = nextPhases[phase] as number;

    if (frame + 1 < outFrames && ((frame + 1) & (ABORT_CHECK_INTERVAL - 1)) !== 0) {
      const secondKernel = kernels[secondPhase] as FastKernel;
      const secondStart = secondBase + secondKernel.firstOffset;
      const firstTapCount = firstKernel.coeffs.length;
      const secondTapCount = secondKernel.coeffs.length;
      if (
        firstStart >= 0 &&
        firstStart + firstTapCount <= inputFrames &&
        secondStart >= 0 &&
        secondStart + secondTapCount <= inputFrames
      ) {
        const firstCoeffs = firstKernel.coeffs;
        const secondCoeffs = secondKernel.coeffs;
        const firstUnrolled = firstTapCount - (firstTapCount & 3);
        const secondUnrolled = secondTapCount - (secondTapCount & 3);
        const pairedUnrolled = Math.min(firstUnrolled, secondUnrolled);
        let firstAcc = 0;
        let secondAcc = 0;
        let tap = 0;
        let firstInput = firstStart;
        let secondInput = secondStart;
        for (; tap < pairedUnrolled; tap += 4, firstInput += 4, secondInput += 4) {
          firstAcc +=
            (input[firstInput] as number) * (firstCoeffs[tap] as number) +
            (input[firstInput + 1] as number) * (firstCoeffs[tap + 1] as number) +
            (input[firstInput + 2] as number) * (firstCoeffs[tap + 2] as number) +
            (input[firstInput + 3] as number) * (firstCoeffs[tap + 3] as number);
          secondAcc +=
            (input[secondInput] as number) * (secondCoeffs[tap] as number) +
            (input[secondInput + 1] as number) * (secondCoeffs[tap + 1] as number) +
            (input[secondInput + 2] as number) * (secondCoeffs[tap + 2] as number) +
            (input[secondInput + 3] as number) * (secondCoeffs[tap + 3] as number);
        }

        let firstTap = tap;
        for (; firstTap < firstUnrolled; firstTap += 4, firstInput += 4) {
          firstAcc +=
            (input[firstInput] as number) * (firstCoeffs[firstTap] as number) +
            (input[firstInput + 1] as number) * (firstCoeffs[firstTap + 1] as number) +
            (input[firstInput + 2] as number) * (firstCoeffs[firstTap + 2] as number) +
            (input[firstInput + 3] as number) * (firstCoeffs[firstTap + 3] as number);
        }
        for (; firstTap < firstTapCount; firstTap++, firstInput++) {
          firstAcc += (input[firstInput] as number) * (firstCoeffs[firstTap] as number);
        }

        let secondTap = tap;
        for (; secondTap < secondUnrolled; secondTap += 4, secondInput += 4) {
          secondAcc +=
            (input[secondInput] as number) * (secondCoeffs[secondTap] as number) +
            (input[secondInput + 1] as number) * (secondCoeffs[secondTap + 1] as number) +
            (input[secondInput + 2] as number) * (secondCoeffs[secondTap + 2] as number) +
            (input[secondInput + 3] as number) * (secondCoeffs[secondTap + 3] as number);
        }
        for (; secondTap < secondTapCount; secondTap++, secondInput++) {
          secondAcc += (input[secondInput] as number) * (secondCoeffs[secondTap] as number);
        }

        output[frame] = clampS16(firstAcc);
        output[frame + 1] = clampS16(secondAcc);
        base = secondBase + (baseIncrements[secondPhase] as number);
        phase = nextPhases[secondPhase] as number;
        frame += 2;
        continue;
      }
    }

    output[frame] = clampS16(convolveMonoS16(input, inputFrames, firstStart, firstKernel.coeffs));
    base = secondBase;
    phase = secondPhase;
    frame++;
  }
}

/**
 * Stereo specialization of the interleaved kernel. Both channels have the same phase/tap schedule, so
 * one traversal can reuse every coefficient while retaining the exact per-channel accumulation order.
 */
function resampleStereoS16(
  input: Int16Array,
  inputFrames: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
): void {
  const { kernels, baseIncrements, nextPhases } = bank;
  let base = 0;
  let phase = 0;
  throwIfAborted(signal);
  for (let frame = 0; frame < outFrames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[phase] as FastKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = base + kernel.firstOffset;
    let leftAcc = 0;
    let rightAcc = 0;
    if (start >= 0 && start + tapCount <= inputFrames) {
      let tap = 0;
      let inputOffset = start * 2;
      const unrolled = tapCount - (tapCount & 3);
      for (; tap < unrolled; tap += 4, inputOffset += 8) {
        leftAcc +=
          (input[inputOffset] as number) * (coeffs[tap] as number) +
          (input[inputOffset + 2] as number) * (coeffs[tap + 1] as number) +
          (input[inputOffset + 4] as number) * (coeffs[tap + 2] as number) +
          (input[inputOffset + 6] as number) * (coeffs[tap + 3] as number);
        rightAcc +=
          (input[inputOffset + 1] as number) * (coeffs[tap] as number) +
          (input[inputOffset + 3] as number) * (coeffs[tap + 1] as number) +
          (input[inputOffset + 5] as number) * (coeffs[tap + 2] as number) +
          (input[inputOffset + 7] as number) * (coeffs[tap + 3] as number);
      }
      for (; tap < tapCount; tap++, inputOffset += 2) {
        const coefficient = coeffs[tap] as number;
        leftAcc += (input[inputOffset] as number) * coefficient;
        rightAcc += (input[inputOffset + 1] as number) * coefficient;
      }
    } else {
      for (let tap = 0, inputFrame = start; tap < tapCount; tap++, inputFrame++) {
        if (inputFrame >= 0 && inputFrame < inputFrames) {
          const inputOffset = inputFrame * 2;
          const coefficient = coeffs[tap] as number;
          leftAcc += (input[inputOffset] as number) * coefficient;
          rightAcc += (input[inputOffset + 1] as number) * coefficient;
        }
      }
    }
    const outputOffset = frame * 2;
    output[outputOffset] = clampS16(leftAcc);
    output[outputOffset + 1] = clampS16(rightAcc);
    base += baseIncrements[phase] as number;
    phase = nextPhases[phase] as number;
  }
}

function resampleInterleavedS16(
  input: Int16Array,
  channels: number,
  inputFrames: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
): void {
  if (channels === 1) {
    resampleMonoS16(input, inputFrames, output, outFrames, bank, signal);
    return;
  }
  if (channels === 2) {
    resampleStereoS16(input, inputFrames, output, outFrames, bank, signal);
    return;
  }

  const { kernels, baseIncrements, nextPhases } = bank;
  let base = 0;
  let phase = 0;
  throwIfAborted(signal);
  for (let frame = 0; frame < outFrames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[phase] as FastKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = base + kernel.firstOffset;
    const outOffset = frame * channels;
    for (let channel = 0; channel < channels; channel++) {
      let acc = 0;
      if (start >= 0 && start + tapCount <= inputFrames) {
        let i = 0;
        let idx = start * channels + channel;
        const unrolled = tapCount - (tapCount & 3);
        for (; i < unrolled; i += 4, idx += channels * 4) {
          acc +=
            (input[idx] as number) * (coeffs[i] as number) +
            (input[idx + channels] as number) * (coeffs[i + 1] as number) +
            (input[idx + channels * 2] as number) * (coeffs[i + 2] as number) +
            (input[idx + channels * 3] as number) * (coeffs[i + 3] as number);
        }
        for (; i < tapCount; i++, idx += channels) {
          acc += (input[idx] as number) * (coeffs[i] as number);
        }
      } else {
        for (let i = 0, idxFrame = start; i < tapCount; i++, idxFrame++) {
          if (idxFrame >= 0 && idxFrame < inputFrames) {
            acc += (input[idxFrame * channels + channel] as number) * (coeffs[i] as number);
          }
        }
      }
      output[outOffset + channel] = clampS16(acc);
    }
    base += baseIncrements[phase] as number;
    phase = nextPhases[phase] as number;
  }
}

interface FastResampleCursor {
  base: number;
  phase: number;
  outputFrame: number;
}

function resampleMonoS16Range(
  input: Int16Array,
  inputStartFrame: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
  cursor: FastResampleCursor,
): void {
  const { kernels, baseIncrements, nextPhases } = bank;
  let outputFrame = 0;
  throwIfAborted(signal);
  while (outputFrame < outFrames) {
    if ((cursor.outputFrame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const firstKernel = kernels[cursor.phase] as FastKernel;
    const firstStart = cursor.base + firstKernel.firstOffset - inputStartFrame;
    const secondBase = cursor.base + (baseIncrements[cursor.phase] as number);
    const secondPhase = nextPhases[cursor.phase] as number;

    if (
      outputFrame + 1 < outFrames &&
      ((cursor.outputFrame + 1) & (ABORT_CHECK_INTERVAL - 1)) !== 0
    ) {
      const secondKernel = kernels[secondPhase] as FastKernel;
      const secondStart = secondBase + secondKernel.firstOffset - inputStartFrame;
      const firstTapCount = firstKernel.coeffs.length;
      const secondTapCount = secondKernel.coeffs.length;
      if (
        firstStart >= 0 &&
        firstStart + firstTapCount <= input.length &&
        secondStart >= 0 &&
        secondStart + secondTapCount <= input.length
      ) {
        const firstCoeffs = firstKernel.coeffs;
        const secondCoeffs = secondKernel.coeffs;
        const firstUnrolled = firstTapCount - (firstTapCount & 3);
        const secondUnrolled = secondTapCount - (secondTapCount & 3);
        const pairedUnrolled = Math.min(firstUnrolled, secondUnrolled);
        let firstAcc = 0;
        let secondAcc = 0;
        let tap = 0;
        let firstInput = firstStart;
        let secondInput = secondStart;
        for (; tap < pairedUnrolled; tap += 4, firstInput += 4, secondInput += 4) {
          firstAcc +=
            (input[firstInput] as number) * (firstCoeffs[tap] as number) +
            (input[firstInput + 1] as number) * (firstCoeffs[tap + 1] as number) +
            (input[firstInput + 2] as number) * (firstCoeffs[tap + 2] as number) +
            (input[firstInput + 3] as number) * (firstCoeffs[tap + 3] as number);
          secondAcc +=
            (input[secondInput] as number) * (secondCoeffs[tap] as number) +
            (input[secondInput + 1] as number) * (secondCoeffs[tap + 1] as number) +
            (input[secondInput + 2] as number) * (secondCoeffs[tap + 2] as number) +
            (input[secondInput + 3] as number) * (secondCoeffs[tap + 3] as number);
        }

        let firstTap = tap;
        for (; firstTap < firstUnrolled; firstTap += 4, firstInput += 4) {
          firstAcc +=
            (input[firstInput] as number) * (firstCoeffs[firstTap] as number) +
            (input[firstInput + 1] as number) * (firstCoeffs[firstTap + 1] as number) +
            (input[firstInput + 2] as number) * (firstCoeffs[firstTap + 2] as number) +
            (input[firstInput + 3] as number) * (firstCoeffs[firstTap + 3] as number);
        }
        for (; firstTap < firstTapCount; firstTap++, firstInput++) {
          firstAcc += (input[firstInput] as number) * (firstCoeffs[firstTap] as number);
        }

        let secondTap = tap;
        for (; secondTap < secondUnrolled; secondTap += 4, secondInput += 4) {
          secondAcc +=
            (input[secondInput] as number) * (secondCoeffs[secondTap] as number) +
            (input[secondInput + 1] as number) * (secondCoeffs[secondTap + 1] as number) +
            (input[secondInput + 2] as number) * (secondCoeffs[secondTap + 2] as number) +
            (input[secondInput + 3] as number) * (secondCoeffs[secondTap + 3] as number);
        }
        for (; secondTap < secondTapCount; secondTap++, secondInput++) {
          secondAcc += (input[secondInput] as number) * (secondCoeffs[secondTap] as number);
        }

        output[outputFrame] = clampS16(firstAcc);
        output[outputFrame + 1] = clampS16(secondAcc);
        cursor.base = secondBase + (baseIncrements[secondPhase] as number);
        cursor.phase = nextPhases[secondPhase] as number;
        cursor.outputFrame += 2;
        outputFrame += 2;
        continue;
      }
    }

    output[outputFrame] = clampS16(
      convolveMonoS16(input, input.length, firstStart, firstKernel.coeffs),
    );
    cursor.base = secondBase;
    cursor.phase = secondPhase;
    cursor.outputFrame++;
    outputFrame++;
  }
}

function resampleStereoS16Range(
  input: Int16Array,
  inputStartFrame: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
  cursor: FastResampleCursor,
): void {
  const { kernels, baseIncrements, nextPhases } = bank;
  throwIfAborted(signal);
  for (let outputFrame = 0; outputFrame < outFrames; outputFrame++) {
    if ((cursor.outputFrame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[cursor.phase] as FastKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = cursor.base + kernel.firstOffset - inputStartFrame;
    let leftAcc = 0;
    let rightAcc = 0;
    if (start >= 0 && start + tapCount <= input.length / 2) {
      let tap = 0;
      let inputOffset = start * 2;
      const unrolled = tapCount - (tapCount & 3);
      for (; tap < unrolled; tap += 4, inputOffset += 8) {
        leftAcc +=
          (input[inputOffset] as number) * (coeffs[tap] as number) +
          (input[inputOffset + 2] as number) * (coeffs[tap + 1] as number) +
          (input[inputOffset + 4] as number) * (coeffs[tap + 2] as number) +
          (input[inputOffset + 6] as number) * (coeffs[tap + 3] as number);
        rightAcc +=
          (input[inputOffset + 1] as number) * (coeffs[tap] as number) +
          (input[inputOffset + 3] as number) * (coeffs[tap + 1] as number) +
          (input[inputOffset + 5] as number) * (coeffs[tap + 2] as number) +
          (input[inputOffset + 7] as number) * (coeffs[tap + 3] as number);
      }
      for (; tap < tapCount; tap++, inputOffset += 2) {
        const coefficient = coeffs[tap] as number;
        leftAcc += (input[inputOffset] as number) * coefficient;
        rightAcc += (input[inputOffset + 1] as number) * coefficient;
      }
    } else {
      const inputFrames = input.length / 2;
      for (let tap = 0, inputFrame = start; tap < tapCount; tap++, inputFrame++) {
        if (inputFrame >= 0 && inputFrame < inputFrames) {
          const inputOffset = inputFrame * 2;
          const coefficient = coeffs[tap] as number;
          leftAcc += (input[inputOffset] as number) * coefficient;
          rightAcc += (input[inputOffset + 1] as number) * coefficient;
        }
      }
    }
    const outputOffset = outputFrame * 2;
    output[outputOffset] = clampS16(leftAcc);
    output[outputOffset + 1] = clampS16(rightAcc);
    cursor.base += baseIncrements[cursor.phase] as number;
    cursor.phase = nextPhases[cursor.phase] as number;
    cursor.outputFrame++;
  }
}

function resampleManyChannelS16Range(
  input: Int16Array,
  inputStartFrame: number,
  channels: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
  cursor: FastResampleCursor,
): void {
  const { kernels, baseIncrements, nextPhases } = bank;
  const inputFrames = input.length / channels;
  throwIfAborted(signal);
  for (let outputFrame = 0; outputFrame < outFrames; outputFrame++) {
    if ((cursor.outputFrame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[cursor.phase] as FastKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = cursor.base + kernel.firstOffset - inputStartFrame;
    const outOffset = outputFrame * channels;
    for (let channel = 0; channel < channels; channel++) {
      let acc = 0;
      if (start >= 0 && start + tapCount <= inputFrames) {
        let tap = 0;
        let inputOffset = start * channels + channel;
        const unrolled = tapCount - (tapCount & 3);
        for (; tap < unrolled; tap += 4, inputOffset += channels * 4) {
          acc +=
            (input[inputOffset] as number) * (coeffs[tap] as number) +
            (input[inputOffset + channels] as number) * (coeffs[tap + 1] as number) +
            (input[inputOffset + channels * 2] as number) * (coeffs[tap + 2] as number) +
            (input[inputOffset + channels * 3] as number) * (coeffs[tap + 3] as number);
        }
        for (; tap < tapCount; tap++, inputOffset += channels) {
          acc += (input[inputOffset] as number) * (coeffs[tap] as number);
        }
      } else {
        for (let tap = 0, inputFrame = start; tap < tapCount; tap++, inputFrame++) {
          if (inputFrame >= 0 && inputFrame < inputFrames) {
            acc += (input[inputFrame * channels + channel] as number) * (coeffs[tap] as number);
          }
        }
      }
      output[outOffset + channel] = clampS16(acc);
    }
    cursor.base += baseIncrements[cursor.phase] as number;
    cursor.phase = nextPhases[cursor.phase] as number;
    cursor.outputFrame++;
  }
}

function resampleInterleavedS16Range(
  input: Int16Array,
  inputStartFrame: number,
  channels: number,
  output: Int16Array,
  outFrames: number,
  bank: FastBank,
  signal: AbortSignal | undefined,
  cursor: FastResampleCursor,
): void {
  if (channels === 1) {
    resampleMonoS16Range(input, inputStartFrame, output, outFrames, bank, signal, cursor);
    return;
  }
  if (channels === 2) {
    resampleStereoS16Range(input, inputStartFrame, output, outFrames, bank, signal, cursor);
    return;
  }
  resampleManyChannelS16Range(
    input,
    inputStartFrame,
    channels,
    output,
    outFrames,
    bank,
    signal,
    cursor,
  );
}

function directS16ResampleShape(opts: PcmTransform): boolean {
  return (
    nativeLittleEndian &&
    (opts.container ?? 'wav') === 'wav' &&
    (opts.sampleFormat === undefined || opts.sampleFormat === 's16') &&
    (opts.endian === undefined || opts.endian === 'le') &&
    opts.sampleRate !== undefined &&
    !hasPcmDomainWork(opts)
  );
}

/**
 * Build a pull-driven, bounded-memory WAV s16 resample from a known-size random-access source.
 *
 * The stream emits a canonical header, then at most one 2 MiB PCM output window per pull. Every source
 * range covers only that output window's exact polyphase support (plus the filter halo), so output bytes
 * are identical to {@link tryResampleWavS16ToS16Wav} without retaining either complete file.
 */
export async function tryStreamResampleWavS16ToS16Wav(
  src: ByteSource,
  opts: PcmTransform,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const sourceSize = src.size;
  if (
    !directS16ResampleShape(opts) ||
    src.range === undefined ||
    sourceSize === undefined ||
    !Number.isSafeInteger(sourceSize) ||
    sourceSize < 0
  ) {
    return undefined;
  }
  throwIfAborted(opts.signal);

  const prefix = await src.range(0, Math.min(sourceSize, RANGE_PROBE_BYTES), opts.signal);
  throwIfAborted(opts.signal);
  let parsed: ReturnType<typeof parseWavPcmData>;
  try {
    parsed = parseWavPcmData(prefix, sourceSize);
  } catch {
    return undefined;
  }

  const { fmt } = parsed;
  if (
    parsed.format !== 's16' ||
    parsed.dataOffset < 0 ||
    (parsed.dataOffset & 1) !== 0 ||
    fmt.channels <= 0 ||
    !Number.isInteger(fmt.channels) ||
    fmt.sampleRate <= 0 ||
    !Number.isInteger(fmt.sampleRate) ||
    (opts.channels !== undefined && opts.channels !== fmt.channels) ||
    opts.sampleRate === fmt.sampleRate
  ) {
    return undefined;
  }

  const outRate = opts.sampleRate;
  if (outRate === undefined || !Number.isSafeInteger(outRate) || outRate <= 0) return undefined;
  const inputFrameBytes = fmt.channels * S16_BYTES_PER_SAMPLE;
  const inputFrames = Math.floor(parsed.dataSize / inputFrameBytes);
  const outFrames = Math.round((inputFrames * outRate) / fmt.sampleRate);
  const outputSampleCount = outFrames * fmt.channels;
  const outputDataBytes = outputSampleCount * S16_BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(outputDataBytes) || outputDataBytes > 0xffff_ffff - 36) {
    return undefined;
  }
  throwIfAborted(opts.signal);

  const header = new Uint8Array(WAV_HEADER_BYTES);
  writeWavHeader(header, outputDataBytes, fmt.channels, outRate, 's16');
  if (outFrames === 0) {
    return new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          throwIfAborted(opts.signal);
          controller.enqueue(header);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  }

  const bank = buildFastBank(fmt.sampleRate, outRate);
  if (bank === undefined) return undefined;
  const cancelController = new AbortController();
  const rangeSignal =
    opts.signal === undefined
      ? cancelController.signal
      : AbortSignal.any([opts.signal, cancelController.signal]);
  const cursor: FastResampleCursor = { base: 0, phase: 0, outputFrame: 0 };
  const outputChunkFrames = Math.max(
    2,
    Math.floor(RANGE_OUTPUT_CHUNK_BYTES / inputFrameBytes) & ~1,
  );
  let nextHeader: Uint8Array | undefined = header;
  let activeSource: ByteSource | undefined = src;

  const release = (): void => {
    activeSource = undefined;
    nextHeader = undefined;
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        throwIfAborted(rangeSignal);
        if (nextHeader !== undefined) {
          const value = nextHeader;
          nextHeader = undefined;
          controller.enqueue(value);
          return;
        }
        const source = activeSource;
        if (source === undefined || cursor.outputFrame >= outFrames) {
          release();
          controller.close();
          return;
        }
        const sourceRange = source.range;
        if (sourceRange === undefined) {
          release();
          throw new MediaError('demux-error', 'WAVE: seekable source lost range support');
        }

        const chunkFrames = Math.min(outputChunkFrames, outFrames - cursor.outputFrame);
        const lastBase =
          cursor.base +
          Math.floor((cursor.phase + (chunkFrames - 1) * bank.step) / bank.phaseCount);
        const inputStartFrame = Math.max(0, cursor.base + bank.minimumFirstOffset);
        const inputEndFrame = Math.min(inputFrames, lastBase + bank.maximumEndOffset);
        const byteStart = parsed.dataOffset + inputStartFrame * inputFrameBytes;
        const byteEnd = parsed.dataOffset + inputEndFrame * inputFrameBytes;
        try {
          const sourceBytes = await sourceRange.call(source, byteStart, byteEnd, rangeSignal);
          throwIfAborted(rangeSignal);
          if (sourceBytes.byteLength !== byteEnd - byteStart) {
            throw new MediaError('demux-error', 'WAVE: truncated PCM range');
          }
          const alignedBytes =
            (sourceBytes.byteOffset & 1) === 0 ? sourceBytes : sourceBytes.slice();
          const input = new Int16Array(
            alignedBytes.buffer,
            alignedBytes.byteOffset,
            alignedBytes.byteLength / S16_BYTES_PER_SAMPLE,
          );
          const outputBytes = new Uint8Array(chunkFrames * inputFrameBytes);
          const output = new Int16Array(
            outputBytes.buffer,
            outputBytes.byteOffset,
            outputBytes.byteLength / S16_BYTES_PER_SAMPLE,
          );
          resampleInterleavedS16Range(
            input,
            inputStartFrame,
            fmt.channels,
            output,
            chunkFrames,
            bank,
            rangeSignal,
            cursor,
          );
          throwIfAborted(rangeSignal);
          controller.enqueue(outputBytes);
          if (cursor.outputFrame >= outFrames) {
            release();
            controller.close();
          }
        } catch (error) {
          release();
          if (rangeSignal.aborted) {
            throw new MediaError('aborted', OPERATION_ABORTED);
          }
          throw error;
        }
      },
      cancel(reason): void {
        cancelController.abort(reason);
        release();
      },
    },
    { highWaterMark: 0 },
  );
}

export function tryResampleWavS16ToS16Wav(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  if (!directS16ResampleShape(opts)) return undefined;

  const parsed = parseWavPcmData(bytes);
  const { fmt } = parsed;
  if (parsed.format !== 's16') return undefined;
  if (fmt.channels <= 0 || !Number.isInteger(fmt.channels)) return undefined;
  if (fmt.sampleRate <= 0 || !Number.isInteger(fmt.sampleRate)) return undefined;
  if (opts.channels !== undefined && opts.channels !== fmt.channels) return undefined;
  if (opts.sampleRate === fmt.sampleRate) return undefined;

  const inRate = fmt.sampleRate;
  const outRate = opts.sampleRate;
  if (outRate === undefined || !Number.isSafeInteger(outRate) || outRate <= 0) return undefined;

  const inputFrameBytes = fmt.channels * S16_BYTES_PER_SAMPLE;
  const inputFrames = Math.floor(parsed.dataSize / inputFrameBytes);
  const outFrames = Math.round((inputFrames * outRate) / inRate);
  const outputSampleCount = outFrames * fmt.channels;
  const outputDataBytes = outputSampleCount * S16_BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(outputDataBytes) || outputDataBytes > 0xffff_ffff - 36) {
    return undefined;
  }
  throwIfAborted(opts.signal);

  if (outFrames === 0) {
    const out = new Uint8Array(WAV_HEADER_BYTES);
    writeWavHeader(out, 0, fmt.channels, outRate, 's16');
    return out;
  }

  const inputOffset = bytes.byteOffset + parsed.dataOffset;
  if ((inputOffset & 1) !== 0) return undefined;
  const bank = buildFastBank(inRate, outRate);
  if (bank === undefined) return undefined;

  const input = new Int16Array(bytes.buffer, inputOffset, inputFrames * fmt.channels);
  const out = new Uint8Array(WAV_HEADER_BYTES + outputDataBytes);
  const output = new Int16Array(out.buffer, WAV_HEADER_BYTES, outputSampleCount);
  resampleInterleavedS16(input, fmt.channels, inputFrames, output, outFrames, bank, opts.signal);
  writeWavHeader(out, outputDataBytes, fmt.channels, outRate, 's16');
  throwIfAborted(opts.signal);
  return out;
}

export function wavS16ResampleToWavFromBytes(
  bytes: Uint8Array,
  opts: WavS16ResampleOptions,
): Uint8Array<ArrayBuffer> | undefined {
  return tryResampleWavS16ToS16Wav(bytes, {
    container: 'wav',
    sampleFormat: 's16',
    endian: 'le',
    ...opts,
  });
}
