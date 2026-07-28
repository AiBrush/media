/**
 * Sample-rate conversion — the band-limited resample tail of audio-dsp (doc 09 §audio-dsp; ADR-022
 * routes `convert`'s `sampleRate` changes here). A **windowed-sinc** interpolator (Kaiser window,
 * libsamplerate/soxr lineage) evaluated as a **polyphase dense filter table**: pure TS over the
 * canonical planar Float64 buffer, deterministic, force-software-safe (runs in Node).
 *
 * Why windowed-sinc-with-a-table rather than an integer L/M polyphase bank: the ideal band-limited
 * interpolator is a sinc with cutoff at the **lower** Nyquist `min(in,out)/2` (this single choice both
 * anti-aliases on downsampling and avoids imaging on upsampling). We truncate it to a few lobes, apply
 * a Kaiser window for ~80 dB stopband, and sample that prototype densely into one small table. Each
 * output sample is then a windowed multiply-accumulate over the input neighborhood, reading taps from
 * the table by linear interpolation at the exact fractional phase — so **any** ratio (44100↔48000, or
 * an irrational target) is first-class with one table, and the hot loop stays a flat MAC. An integer
 * L/M bank (L=outRate/gcd, M=inRate/gcd) is exact too but its prototype length scales with L and it
 * does not generalize to arbitrary ratios without rebuilding a huge bank.
 *
 * Edges use zero-extension (out-of-range input samples read as 0 via {@link sampleAt}) — the standard
 * offline-resampler boundary, deterministic and transient-bounded. The window is DC-normalized so a
 * constant signal is preserved to float epsilon. Mixing/imaging never push past the float domain;
 * clipping (if any) happens only at the integer encode boundary ({@link encodePcm}), keeping a
 * resample→f32 path lossless in spirit.
 */

import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';
import { ResampleLruCache } from './resample-cache.ts';

/**
 * Quality knobs of the prototype windowed-sinc filter. Fixed (not exposed) so every `convert` resample
 * is reproducible: a ~80 dB-stopband Kaiser kernel, 32 zero-crossings half-width, 512 sub-sample phases.
 */
const ZERO_CROSSINGS = 32; // sinc lobes on each side of center → transition sharpness
const SAMPLES_PER_ZERO_CROSSING = 512; // table phases between adjacent sinc zero crossings (interp grid)
const KAISER_BETA = 9.42; // Kaiser β for ≈ 80 dB stopband attenuation (Kaiser/Schafer design)
const MAX_POLYPHASE_PHASES = 4096;
const ABORT_CHECK_INTERVAL = 4096;
const MAX_RESAMPLE_KERNEL_TAPS = 262_144; // ≤ 2 MiB of Float64 coefficients for one phase
const MAX_POLYPHASE_BANK_BUILD_BYTES = 16 * 1024 * 1024; // larger safe work uses dense fallback
// Keep the complete planar result below the conservative signed-32-bit byte ceiling shared by older
// and current JS runtimes. Bounding the aggregate (not merely each Float64Array) prevents a valid
// per-plane shape with many channels from committing several GiB before the caller can consume it.
const MAX_RESAMPLE_OUTPUT_BYTES = 0x7fff_fff8; // ~2 GiB, divisible by Float64Array.BYTES_PER_ELEMENT
const POLYPHASE_CACHE_MAX_ENTRIES = 8;
const POLYPHASE_CACHE_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const CACHE_ACCOUNTING_ALIGNMENT = 4096;
const POLYPHASE_BANK_METADATA_BYTES = 256;
const POLYPHASE_KERNEL_METADATA_BYTES = 128;
const TYPED_ARRAY_METADATA_BYTES = 64;

/** Optional controls for long-running sample-rate conversion. */
export interface ResampleOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Normalized sinc, `sin(πx)/(πx)`, with the removable singularity at 0 filled by its limit (1). */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Zeroth-order modified Bessel function I₀, via its series (converges fast for the β·√… arguments here). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfXSq = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= halfXSq / (k * k);
    sum += term;
    if (term < sum * 1e-16) break; // converged to double precision
  }
  return sum;
}

/**
 * The prototype low-pass: a Kaiser-windowed sinc sampled at `SAMPLES_PER_ZERO_CROSSING` points per
 * unit, from center out to `ZERO_CROSSINGS`. Index `i` corresponds to continuous position
 * `i / SAMPLES_PER_ZERO_CROSSING` (in input-sample units, before the cutoff scale). Built once.
 */
function buildFilterTable(): Float64Array {
  const half = ZERO_CROSSINGS * SAMPLES_PER_ZERO_CROSSING;
  const table = new Float64Array(half + 2); // +2 guard taps so the run-time linear interp never overruns
  const i0Beta = besselI0(KAISER_BETA);
  for (let i = 0; i <= half; i++) {
    const x = i / SAMPLES_PER_ZERO_CROSSING; // position in zero-crossing units
    // Kaiser window over the support [-ZERO_CROSSINGS, ZERO_CROSSINGS]; t ∈ [0,1] is the normalized radius.
    const t = x / ZERO_CROSSINGS;
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - t * t))) / i0Beta;
    table[i] = sinc(x) * w;
  }
  return table;
}

/**
 * One fixed-size (~128 KiB), module-owned prototype table. It never escapes this module, and cached
 * banks copy their coefficients rather than retaining it, so it has one stable owner and is not part
 * of the variable bank-cache budget.
 */
let FILTER_TABLE: Float64Array | undefined;
function filterTable(): Float64Array {
  FILTER_TABLE ??= buildFilterTable();
  return FILTER_TABLE;
}

/**
 * Read the prototype filter at continuous position `pos` (in zero-crossing units, ≥ 0) by linear
 * interpolation between adjacent table taps. Outside the support → 0.
 */
function tapAt(table: Float64Array, pos: number): number {
  const f = pos * SAMPLES_PER_ZERO_CROSSING;
  const i = Math.floor(f);
  if (i < 0 || i + 1 >= table.length) return 0;
  const frac = f - i;
  const a = table[i] ?? 0;
  const b = table[i + 1] ?? 0;
  return a + (b - a) * frac;
}

interface PolyphaseKernel {
  readonly firstOffset: number;
  readonly coeffs: Float64Array;
}

interface PolyphaseBank {
  readonly baseIncrements: Int32Array;
  readonly nextPhases: Int32Array;
  readonly kernels: readonly PolyphaseKernel[];
}

const POLYPHASE_CACHE = new ResampleLruCache<PolyphaseBank>(
  POLYPHASE_CACHE_MAX_ENTRIES,
  POLYPHASE_CACHE_MAX_RETAINED_BYTES,
);

/**
 * Conservative retained-size accounting: typed-array payloads plus explicit allowances for their
 * views, kernel objects, the kernel reference array, key, Map entry, and bank object. Page rounding
 * intentionally over-counts small banks and allocator slack.
 */
function polyphaseBankRetainedBytes(key: string, bank: PolyphaseBank): number {
  let bytes =
    POLYPHASE_BANK_METADATA_BYTES +
    key.length * 2 +
    bank.kernels.length * 8 +
    bank.baseIncrements.byteLength +
    bank.nextPhases.byteLength +
    2 * TYPED_ARRAY_METADATA_BYTES;
  for (const kernel of bank.kernels) {
    bytes += POLYPHASE_KERNEL_METADATA_BYTES + kernel.coeffs.byteLength;
  }
  const aligned = Math.ceil(bytes / CACHE_ACCOUNTING_ALIGNMENT) * CACHE_ACCOUNTING_ALIGNMENT;
  return Number.isSafeInteger(aligned) ? aligned : Number.MAX_SAFE_INTEGER;
}

function estimatedPolyphaseBankRetainedBytes(
  key: string,
  phaseCount: number,
  maximumTapCount: number,
): number {
  const bytes =
    POLYPHASE_BANK_METADATA_BYTES +
    key.length * 2 +
    phaseCount *
      (8 +
        Int32Array.BYTES_PER_ELEMENT * 2 +
        POLYPHASE_KERNEL_METADATA_BYTES +
        maximumTapCount * Float64Array.BYTES_PER_ELEMENT) +
    2 * TYPED_ARRAY_METADATA_BYTES;
  const aligned = Math.ceil(bytes / CACHE_ACCOUNTING_ALIGNMENT) * CACHE_ACCOUNTING_ALIGNMENT;
  return Number.isSafeInteger(aligned) ? aligned : Number.MAX_SAFE_INTEGER;
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

function buildPolyphaseKernel(
  phase: number,
  phaseCount: number,
  halfSupport: number,
  cutoff: number,
  table: Float64Array,
): PolyphaseKernel {
  const frac = phase / phaseCount;
  const first = Math.ceil(frac - halfSupport);
  const last = Math.floor(frac + halfSupport);
  const tapCount = Math.max(0, last - first + 1);
  const coeffs = new Float64Array(tapCount);
  for (let i = 0; i < tapCount; i++) {
    const offset = first + i;
    coeffs[i] = tapAt(table, Math.abs((frac - offset) * cutoff)) * cutoff;
  }
  return { firstOffset: first, coeffs };
}

function buildPhaseIncrements(
  phaseCount: number,
  step: number,
): {
  readonly baseIncrements: Int32Array;
  readonly nextPhases: Int32Array;
} {
  const baseIncrements = new Int32Array(phaseCount);
  const nextPhases = new Int32Array(phaseCount);
  for (let phase = 0; phase < phaseCount; phase++) {
    const next = phase + step;
    const increment = Math.floor(next / phaseCount);
    baseIncrements[phase] = increment;
    nextPhases[phase] = next - increment * phaseCount;
  }
  return { baseIncrements, nextPhases };
}

function polyphaseBank(
  inRate: number,
  outRate: number,
  ratio: number,
  maximumTapCount: number,
  table: Float64Array,
): PolyphaseBank | undefined {
  const divisor = gcd(inRate, outRate);
  const phaseCount = outRate / divisor;
  if (phaseCount > MAX_POLYPHASE_PHASES) return undefined;
  const step = inRate / divisor;
  const key = `${inRate}:${outRate}`;
  const cached = POLYPHASE_CACHE.get(key);
  if (cached !== undefined) return cached;
  if (
    estimatedPolyphaseBankRetainedBytes(key, phaseCount, maximumTapCount) >
    MAX_POLYPHASE_BANK_BUILD_BYTES
  ) {
    return undefined;
  }

  const cutoff = ratio < 1 ? ratio : 1;
  const halfSupport = ZERO_CROSSINGS / cutoff;
  const kernels: PolyphaseKernel[] = [];
  for (let phase = 0; phase < phaseCount; phase++) {
    kernels.push(buildPolyphaseKernel(phase, phaseCount, halfSupport, cutoff, table));
  }
  const { baseIncrements, nextPhases } = buildPhaseIncrements(phaseCount, step);
  const bank = { baseIncrements, nextPhases, kernels };
  POLYPHASE_CACHE.set(key, bank, polyphaseBankRetainedBytes(key, bank));
  return bank;
}

function resampleCapabilityError(
  message: string,
  inRate: number,
  outRate: number,
  facts: Readonly<Record<string, string | number | boolean | undefined>> = {},
): CapabilityError {
  return new CapabilityError(message, {
    op: { kind: 'route', id: 'filter', facts: { inRate, outRate, ...facts } },
    tried: [],
  });
}

function maximumKernelTapCount(inRate: number, outRate: number, ratio: number): number {
  const cutoff = Math.min(1, ratio);
  const tapCount = Math.ceil((ZERO_CROSSINGS * 2) / cutoff) + 1;
  if (!Number.isSafeInteger(tapCount) || tapCount > MAX_RESAMPLE_KERNEL_TAPS) {
    throw resampleCapabilityError(
      `resample ratio ${inRate}:${outRate} requires an unsafe filter kernel`,
      inRate,
      outRate,
      { tapCount, maxTapCount: MAX_RESAMPLE_KERNEL_TAPS },
    );
  }
  return tapCount;
}

interface ResampleWorkPlan {
  readonly ratio: number;
  readonly outFrames: number;
  readonly maximumTapCount: number;
}

/**
 * Numeric-only safety plan shared with adversarial tests. It is intentionally absent from the
 * package/DSP entry points: callers use {@link resample}, while tests can cover hour-scale plans
 * without allocating hour-scale PCM planes.
 *
 * @internal
 */
export function planResampleWork(
  inRate: number,
  outRate: number,
  frames: number,
  channelCount: number,
): ResampleWorkPlan {
  if (!Number.isSafeInteger(outRate) || outRate <= 0) {
    throw resampleCapabilityError(`invalid target sample rate ${outRate}`, inRate, outRate);
  }
  if (!Number.isSafeInteger(inRate) || inRate <= 0) {
    throw resampleCapabilityError(`invalid source sample rate ${inRate}`, inRate, outRate);
  }
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new InputError(`invalid source frame count ${frames}`);
  }
  if (!Number.isSafeInteger(channelCount) || channelCount <= 0) {
    throw new InputError(`invalid source channel count ${channelCount}`);
  }
  const ratio = outRate / inRate;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw resampleCapabilityError('invalid resample ratio', inRate, outRate, { ratio });
  }
  const scaledFrames = frames * ratio;
  const outFrames = Math.round(scaledFrames);
  if (!Number.isSafeInteger(outFrames) || outFrames < 0) {
    throw resampleCapabilityError('resample output frame count is unsafe', inRate, outRate, {
      frames,
      scaledFrames,
    });
  }
  if (outFrames === 0) return { ratio, outFrames, maximumTapCount: 0 };

  const outputSamples = outFrames * channelCount;
  if (!Number.isSafeInteger(outputSamples)) {
    throw resampleCapabilityError(
      'resample output sample count exceeds safe integer accounting',
      inRate,
      outRate,
      { outFrames, channelCount, outputSamples },
    );
  }
  const outputBytes = outputSamples * Float64Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(outputBytes) || outputBytes > MAX_RESAMPLE_OUTPUT_BYTES) {
    throw resampleCapabilityError(
      'resample aggregate output exceeds the safe software allocation bound',
      inRate,
      outRate,
      {
        outFrames,
        channelCount,
        outputSamples,
        outputBytes,
        maxOutputBytes: MAX_RESAMPLE_OUTPUT_BYTES,
      },
    );
  }
  if (inRate === outRate) {
    return { ratio, outFrames, maximumTapCount: 0 };
  }

  const maximumTapCount = maximumKernelTapCount(inRate, outRate, ratio);
  const workUnits = outputSamples * maximumTapCount;
  if (!Number.isSafeInteger(workUnits)) {
    throw resampleCapabilityError(
      'resample operation exceeds safe integer work accounting',
      inRate,
      outRate,
      { outFrames, channelCount, maximumTapCount, workUnits },
    );
  }
  return { ratio, outFrames, maximumTapCount };
}

function validatePcmAudioShape(audio: PcmAudio): void {
  if (!Number.isSafeInteger(audio.frames) || audio.frames < 0) {
    throw new InputError(`invalid source frame count ${audio.frames}`);
  }
  if (!Number.isSafeInteger(audio.channels) || audio.channels <= 0) {
    throw new InputError(`invalid source channel count ${audio.channels}`);
  }
  if (audio.planar.length !== audio.channels) {
    throw new InputError(
      `source channel count ${audio.channels} does not match ${audio.planar.length} PCM planes`,
    );
  }
  for (let channel = 0; channel < audio.planar.length; channel++) {
    const plane = audio.planar[channel] as Float64Array;
    if (plane.length !== audio.frames) {
      throw new InputError(
        `source PCM plane ${channel} has ${plane.length} frames; expected ${audio.frames}`,
      );
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function resampleChannelPolyphase(
  input: Float64Array,
  outFrames: number,
  bank: PolyphaseBank,
  signal: AbortSignal | undefined,
): Float64Array {
  const out = new Float64Array(outFrames);
  const inputFrames = input.length;
  const kernels = bank.kernels;
  const baseIncrements = bank.baseIncrements;
  const nextPhases = bank.nextPhases;
  let base = 0;
  let phase = 0;
  throwIfAborted(signal);
  for (let m = 0; m < outFrames; m++) {
    if ((m & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[phase] as PolyphaseKernel;
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
        if (idx >= 0 && idx < inputFrames) acc += (input[idx] as number) * (coeffs[i] as number);
      }
    }
    out[m] = acc;
    base += baseIncrements[phase] as number;
    phase = nextPhases[phase] as number;
  }
  return out;
}

/**
 * Stereo specialization of {@link resampleChannelPolyphase}. Both planar channels share the exact phase,
 * boundary, and coefficient traversal while retaining independent accumulators in the scalar tap order.
 */
function resampleStereoPolyphase(
  left: Float64Array,
  right: Float64Array,
  outFrames: number,
  bank: PolyphaseBank,
  signal: AbortSignal | undefined,
): [Float64Array, Float64Array] {
  const leftOut = new Float64Array(outFrames);
  const rightOut = new Float64Array(outFrames);
  const kernels = bank.kernels;
  const baseIncrements = bank.baseIncrements;
  const nextPhases = bank.nextPhases;
  let base = 0;
  let phase = 0;
  throwIfAborted(signal);
  for (let frame = 0; frame < outFrames; frame++) {
    if ((frame & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const kernel = kernels[phase] as PolyphaseKernel;
    const { coeffs } = kernel;
    const tapCount = coeffs.length;
    const start = base + kernel.firstOffset;
    let leftAcc = 0;
    let rightAcc = 0;
    if (start >= 0 && start + tapCount <= left.length && start + tapCount <= right.length) {
      let tap = 0;
      let input = start;
      const unrolled = tapCount - (tapCount & 3);
      for (; tap < unrolled; tap += 4, input += 4) {
        leftAcc +=
          (left[input] as number) * (coeffs[tap] as number) +
          (left[input + 1] as number) * (coeffs[tap + 1] as number) +
          (left[input + 2] as number) * (coeffs[tap + 2] as number) +
          (left[input + 3] as number) * (coeffs[tap + 3] as number);
        rightAcc +=
          (right[input] as number) * (coeffs[tap] as number) +
          (right[input + 1] as number) * (coeffs[tap + 1] as number) +
          (right[input + 2] as number) * (coeffs[tap + 2] as number) +
          (right[input + 3] as number) * (coeffs[tap + 3] as number);
      }
      for (; tap < tapCount; tap++, input++) {
        leftAcc += (left[input] as number) * (coeffs[tap] as number);
        rightAcc += (right[input] as number) * (coeffs[tap] as number);
      }
    } else {
      for (let tap = 0, input = start; tap < tapCount; tap++, input++) {
        const coefficient = coeffs[tap] as number;
        if (input >= 0 && input < left.length) leftAcc += (left[input] as number) * coefficient;
        if (input >= 0 && input < right.length) {
          rightAcc += (right[input] as number) * coefficient;
        }
      }
    }
    leftOut[frame] = leftAcc;
    rightOut[frame] = rightAcc;
    base += baseIncrements[phase] as number;
    phase = nextPhases[phase] as number;
  }
  return [leftOut, rightOut];
}

/**
 * Resample one channel to `outFrames` samples. `ratio = outRate/inRate`; `cutoff = min(1, ratio)` shrinks
 * the kernel in input-space when downsampling so its cutoff drops to the **output** Nyquist (anti-alias).
 */
function resampleChannel(
  input: Float64Array,
  outFrames: number,
  ratio: number,
  table: Float64Array,
  signal: AbortSignal | undefined,
): Float64Array {
  const out = new Float64Array(outFrames);
  const cutoff = ratio < 1 ? ratio : 1; // ≤ 1: lower-Nyquist low-pass; 1 for upsampling (input Nyquist)
  const halfSupport = ZERO_CROSSINGS / cutoff; // kernel half-width in INPUT samples (widens when downsampling)
  const invRatio = 1 / ratio; // output index → input position
  throwIfAborted(signal);
  for (let m = 0; m < outFrames; m++) {
    if ((m & (ABORT_CHECK_INTERVAL - 1)) === 0) throwIfAborted(signal);
    const center = m * invRatio; // continuous input position this output sample lands on
    const first = Math.ceil(center - halfSupport);
    const last = Math.floor(center + halfSupport);
    let acc = 0;
    for (let n = first; n <= last; n++) {
      // Read the windowed sinc at the cutoff-scaled distance; |distance| keeps the table one-sided.
      acc += sampleAt(input, n) * tapAt(table, Math.abs((center - n) * cutoff));
    }
    out[m] = acc * cutoff; // DC normalization (the kernel's area scales with the cutoff compression)
  }
  return out;
}

/**
 * Band-limited sample-rate conversion of `audio` to `outRate` Hz (doc 09 §audio-dsp, ADR-022). Each
 * channel is resampled independently with the same phase schedule; output length is exactly
 * `round(frames · outRate / inRate)`. Equal rates return a bit-exact identity copy (input untouched).
 *
 * @throws InputError for an inconsistent canonical PCM shape.
 * @throws CapabilityError for invalid rates or a ratio/allocation that cannot be handled safely.
 */
export function resample(
  audio: PcmAudio,
  outRate: number,
  options: ResampleOptions = {},
): PcmAudio {
  validatePcmAudioShape(audio);
  const inRate = audio.sampleRate;
  const { ratio, outFrames, maximumTapCount } = planResampleWork(
    inRate,
    outRate,
    audio.frames,
    audio.channels,
  );
  throwIfAborted(options.signal);
  if (outRate === inRate) {
    return {
      sampleRate: inRate,
      channels: audio.channels,
      frames: audio.frames,
      planar: audio.planar.map((ch) => ch.slice()),
    };
  }
  if (outFrames === 0) {
    return {
      sampleRate: outRate,
      channels: audio.channels,
      frames: 0,
      planar: audio.planar.map(() => new Float64Array(0)),
    };
  }
  const table = filterTable();
  const bank = polyphaseBank(inRate, outRate, ratio, maximumTapCount, table);
  const planar =
    bank === undefined
      ? audio.planar.map((ch) => resampleChannel(ch, outFrames, ratio, table, options.signal))
      : audio.channels === 2
        ? resampleStereoPolyphase(
            channelAt(audio.planar, 0),
            channelAt(audio.planar, 1),
            outFrames,
            bank,
            options.signal,
          )
        : audio.planar.map((ch) => resampleChannelPolyphase(ch, outFrames, bank, options.signal));
  return { sampleRate: outRate, channels: audio.channels, frames: outFrames, planar };
}
