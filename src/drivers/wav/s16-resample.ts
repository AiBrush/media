import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { parseWavPcmData, writeWavHeader } from './pcm.ts';

const WAV_HEADER_BYTES = 44;
const S16_BYTES_PER_SAMPLE = 2;
const S16_MIN = -32768;
const S16_MAX = 32767;
const FAST_ZERO_CROSSINGS = 6;
const FAST_KAISER_BETA = 8.6;
const MAX_FAST_POLYPHASE_PHASES = 4096;
const ABORT_CHECK_INTERVAL = 4096;

interface FastKernel {
  readonly firstOffset: number;
  readonly coeffs: Float32Array;
}

interface FastBank {
  readonly kernels: readonly FastKernel[];
  readonly baseIncrements: Int32Array;
  readonly nextPhases: Int32Array;
}

const FAST_BANK_CACHE = new Map<string, FastBank>();

const nativeLittleEndian = new Uint8Array(new Uint16Array([0x00ff]).buffer)[0] === 0xff;

function hasPcmDomainWork(o: PcmTransform): boolean {
  return (
    o.gainDb !== undefined ||
    o.fade !== undefined ||
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

function buildKernel(phase: number, phaseCount: number, cutoff: number): FastKernel {
  const frac = phase / phaseCount;
  const halfSupport = FAST_ZERO_CROSSINGS / cutoff;
  const firstOffset = Math.ceil(frac - halfSupport);
  const lastOffset = Math.floor(frac + halfSupport);
  const tapCount = Math.max(0, lastOffset - firstOffset + 1);
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
  if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0) {
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
  const kernels: FastKernel[] = [];
  for (let phase = 0; phase < phaseCount; phase++) {
    kernels.push(buildKernel(phase, phaseCount, cutoff));
  }
  const baseIncrements = new Int32Array(phaseCount);
  const nextPhases = new Int32Array(phaseCount);
  for (let phase = 0; phase < phaseCount; phase++) {
    const next = phase + step;
    const increment = Math.floor(next / phaseCount);
    baseIncrements[phase] = increment;
    nextPhases[phase] = next - increment * phaseCount;
  }
  const bank = { kernels, baseIncrements, nextPhases };
  FAST_BANK_CACHE.set(key, bank);
  return bank;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function clampS16(x: number): number {
  const rounded = Math.round(x);
  if (rounded < S16_MIN) return S16_MIN;
  if (rounded > S16_MAX) return S16_MAX;
  return rounded;
}

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
  throwIfAborted(signal);
  for (let frame = 0; frame < outFrames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[phase] as FastKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = base + kernel.firstOffset;
    let acc = 0;
    if (start >= 0 && start + tapCount <= inputFrames) {
      let i = 0;
      let idx = start;
      const unrolled = tapCount - (tapCount & 3);
      for (; i < unrolled; i += 4, idx += 4) {
        acc +=
          (input[idx] as number) * (coeffs[i] as number) +
          (input[idx + 1] as number) * (coeffs[i + 1] as number) +
          (input[idx + 2] as number) * (coeffs[i + 2] as number) +
          (input[idx + 3] as number) * (coeffs[i + 3] as number);
      }
      for (; i < tapCount; i++, idx++) {
        acc += (input[idx] as number) * (coeffs[i] as number);
      }
    } else {
      for (let i = 0, idx = start; i < tapCount; i++, idx++) {
        if (idx >= 0 && idx < inputFrames) {
          acc += (input[idx] as number) * (coeffs[i] as number);
        }
      }
    }
    output[frame] = clampS16(acc);
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

export function tryResampleWavS16ToS16Wav(
  bytes: Uint8Array,
  opts: PcmTransform,
): Uint8Array<ArrayBuffer> | undefined {
  if (!nativeLittleEndian) return undefined;
  if ((opts.container ?? 'wav') !== 'wav') return undefined;
  if (opts.sampleFormat !== undefined && opts.sampleFormat !== 's16') return undefined;
  if (opts.endian !== undefined && opts.endian !== 'le') return undefined;
  if (opts.sampleRate === undefined) return undefined;
  if (hasPcmDomainWork(opts)) return undefined;

  const parsed = parseWavPcmData(bytes);
  const { fmt } = parsed;
  if (parsed.format !== 's16') return undefined;
  if (fmt.channels <= 0 || !Number.isInteger(fmt.channels)) return undefined;
  if (fmt.sampleRate <= 0 || !Number.isInteger(fmt.sampleRate)) return undefined;
  if (opts.channels !== undefined && opts.channels !== fmt.channels) return undefined;
  if (opts.sampleRate === fmt.sampleRate) return undefined;

  const inRate = fmt.sampleRate;
  const outRate = opts.sampleRate;
  const bank = buildFastBank(inRate, outRate);
  if (bank === undefined) return undefined;

  const inputFrameBytes = fmt.channels * S16_BYTES_PER_SAMPLE;
  const inputFrames = Math.floor(parsed.dataSize / inputFrameBytes);
  const outFrames = Math.round((inputFrames * outRate) / inRate);
  const outputSampleCount = outFrames * fmt.channels;
  const outputDataBytes = outputSampleCount * S16_BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(outputDataBytes) || outputDataBytes > 0xffff_ffff - 36) {
    return undefined;
  }
  const inputOffset = bytes.byteOffset + parsed.dataOffset;
  if ((inputOffset & 1) !== 0) return undefined;
  throwIfAborted(opts.signal);

  const input = new Int16Array(bytes.buffer, inputOffset, inputFrames * fmt.channels);
  const out = new Uint8Array(WAV_HEADER_BYTES + outputDataBytes);
  const output = new Int16Array(out.buffer, WAV_HEADER_BYTES, outputSampleCount);
  resampleInterleavedS16(input, fmt.channels, inputFrames, output, outFrames, bank, opts.signal);
  writeWavHeader(out, outputDataBytes, fmt.channels, outRate, 's16');
  throwIfAborted(opts.signal);
  return out;
}
