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

import { CapabilityError } from '../contracts/errors.ts';
import { type PcmAudio, sampleAt } from './pcm.ts';

/**
 * Quality knobs of the prototype windowed-sinc filter. Fixed (not exposed) so every `convert` resample
 * is reproducible: a ~80 dB-stopband Kaiser kernel, 32 zero-crossings half-width, 512 sub-sample phases.
 */
const ZERO_CROSSINGS = 32; // sinc lobes on each side of center → transition sharpness
const SAMPLES_PER_ZERO_CROSSING = 512; // table phases between adjacent sinc zero crossings (interp grid)
const KAISER_BETA = 9.42; // Kaiser β for ≈ 80 dB stopband attenuation (Kaiser/Schafer design)
const MAX_POLYPHASE_PHASES = 4096;

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
  readonly offsets: Int32Array;
  readonly coeffs: Float64Array;
}

interface PolyphaseBank {
  readonly phaseCount: number;
  readonly step: number;
  readonly kernels: readonly PolyphaseKernel[];
}

const POLYPHASE_CACHE = new Map<string, PolyphaseBank>();

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
  const offsets = new Int32Array(tapCount);
  const coeffs = new Float64Array(tapCount);
  for (let i = 0; i < tapCount; i++) {
    const offset = first + i;
    offsets[i] = offset;
    coeffs[i] = tapAt(table, Math.abs((frac - offset) * cutoff)) * cutoff;
  }
  return { offsets, coeffs };
}

function polyphaseBank(
  inRate: number,
  outRate: number,
  ratio: number,
  table: Float64Array,
): PolyphaseBank | undefined {
  if (!Number.isInteger(inRate) || inRate <= 0) return undefined;
  const divisor = gcd(inRate, outRate);
  const phaseCount = outRate / divisor;
  if (phaseCount > MAX_POLYPHASE_PHASES) return undefined;
  const step = inRate / divisor;
  const key = `${inRate}:${outRate}`;
  const cached = POLYPHASE_CACHE.get(key);
  if (cached !== undefined) return cached;

  const cutoff = ratio < 1 ? ratio : 1;
  const halfSupport = ZERO_CROSSINGS / cutoff;
  const kernels: PolyphaseKernel[] = [];
  for (let phase = 0; phase < phaseCount; phase++) {
    kernels.push(buildPolyphaseKernel(phase, phaseCount, halfSupport, cutoff, table));
  }
  const bank = { phaseCount, step, kernels };
  POLYPHASE_CACHE.set(key, bank);
  return bank;
}

function resampleChannelPolyphase(
  input: Float64Array,
  outFrames: number,
  bank: PolyphaseBank,
): Float64Array {
  const out = new Float64Array(outFrames);
  const inputFrames = input.length;
  let base = 0;
  let phase = 0;
  for (let m = 0; m < outFrames; m++) {
    const kernel = bank.kernels[phase] as PolyphaseKernel;
    const { offsets, coeffs } = kernel;
    let acc = 0;
    for (let i = 0; i < coeffs.length; i++) {
      const idx = base + (offsets[i] as number);
      if (idx >= 0 && idx < inputFrames) acc += (input[idx] as number) * (coeffs[i] as number);
    }
    out[m] = acc;
    phase += bank.step;
    if (phase >= bank.phaseCount) {
      base += Math.floor(phase / bank.phaseCount);
      phase %= bank.phaseCount;
    }
  }
  return out;
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
): Float64Array {
  const out = new Float64Array(outFrames);
  const cutoff = ratio < 1 ? ratio : 1; // ≤ 1: lower-Nyquist low-pass; 1 for upsampling (input Nyquist)
  const halfSupport = ZERO_CROSSINGS / cutoff; // kernel half-width in INPUT samples (widens when downsampling)
  const invRatio = 1 / ratio; // output index → input position
  for (let m = 0; m < outFrames; m++) {
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
 * @throws CapabilityError if `outRate` is not a positive integer (the resample capability cannot be met).
 */
export function resample(audio: PcmAudio, outRate: number): PcmAudio {
  if (!Number.isInteger(outRate) || outRate <= 0) {
    throw new CapabilityError('capability-miss', `invalid target sample rate ${outRate}`, {
      op: 'filter',
      tried: [],
    });
  }
  const inRate = audio.sampleRate;
  if (outRate === inRate) {
    return {
      sampleRate: inRate,
      channels: audio.channels,
      frames: audio.frames,
      planar: audio.planar.map((ch) => ch.slice()),
    };
  }
  const ratio = outRate / inRate;
  const outFrames = Math.round(audio.frames * ratio);
  const table = filterTable();
  const bank = polyphaseBank(inRate, outRate, ratio, table);
  const planar =
    bank === undefined
      ? audio.planar.map((ch) => resampleChannel(ch, outFrames, ratio, table))
      : audio.planar.map((ch) => resampleChannelPolyphase(ch, outFrames, bank));
  return { sampleRate: outRate, channels: audio.channels, frames: outFrames, planar };
}
