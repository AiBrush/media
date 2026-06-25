/**
 * Biquad filters / parametric EQ (doc 09 §audio-dsp) — the RBJ "Audio EQ Cookbook" (Robert
 * Bristow-Johnson) second-order sections over the canonical planar Float64 buffer. Pure TS,
 * deterministic, in the style of {@link gain}/{@link fadeIn}: returns new audio, leaves the input
 * untouched, never produces `NaN`. Seven responses: `lowpass`, `highpass`, `bandpass` (0 dB peak),
 * `notch`, `peaking` EQ, `lowshelf`, `highshelf`.
 *
 * Implemented as **Direct-Form-II-transposed** (DF2T) — the canonical streaming biquad: two state
 * registers per channel, the best-conditioned form for float (it minimizes the state-magnitude and
 * coefficient-sensitivity problems that bite Direct-Form-I at high-Q / low-frequency). Per sample:
 *
 *     y  = b0·x + z1
 *     z1 = b1·x − a1·y + z2
 *     z2 = b2·x − a2·y
 *
 * State starts at zero (zero initial conditions ⇒ deterministic) and is independent per channel. The
 * coefficients come straight from the cookbook (normalized by `a0`); {@link magnitudeResponse} exposes
 * the analytic `|H(e^jω)|` so a caller (or the response oracle) can predict the gain at any frequency,
 * and {@link polesInsideUnitCircle} is the exact Jury stability check. A filter may boost past ±1
 * (e.g. a +12 dB peaking EQ on a full-scale input); like {@link gain}, saturation happens only at the
 * integer encode boundary ({@link encodePcm}).
 */

import { InputError } from '../contracts/errors.ts';
import type { PcmAudio } from './pcm.ts';

/** The RBJ filter responses supported here. `peaking`/`lowshelf`/`highshelf` require `gainDb`. */
export type BiquadType =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf';

/** A biquad to design: response `type`, center/corner `frequency` (Hz), `q` (>0), and `gainDb` (EQ/shelf). */
export interface BiquadSpec {
  readonly type: BiquadType;
  readonly frequency: number;
  readonly q: number;
  /** Required for `peaking`/`lowshelf`/`highshelf` (dB); ignored by the others. */
  readonly gainDb?: number;
}

/** Normalized biquad coefficients (`a0 = 1`): `y[n] = b0 x[n] + b1 x[n−1] + b2 x[n−2] − a1 y[n−1] − a2 y[n−2]`. */
export interface BiquadCoeffs {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** Read the required `gainDb` for a parametric-EQ/shelf design (the others ignore it). */
function requireGain(spec: BiquadSpec): number {
  if (spec.gainDb === undefined || !Number.isFinite(spec.gainDb)) {
    throw new InputError('unsupported-input', `${spec.type} requires a finite gainDb`);
  }
  return spec.gainDb;
}

/**
 * Design the normalized {@link BiquadCoeffs} for a spec at `sampleRate`, by the RBJ cookbook. Validates
 * the band: `0 < frequency < sampleRate/2` (ω0 ∈ (0,π)) and `q > 0`; EQ/shelf require a finite `gainDb`.
 *
 * @throws InputError if the frequency is out of band, `q ≤ 0`, or a required `gainDb` is missing/non-finite.
 */
export function designBiquad(spec: BiquadSpec, sampleRate: number): BiquadCoeffs {
  const { frequency, q } = spec;
  if (!(frequency > 0 && frequency < sampleRate / 2)) {
    throw new InputError(
      'unsupported-input',
      `biquad frequency ${frequency} must be in (0, ${sampleRate / 2}) Hz`,
    );
  }
  if (!(q > 0)) throw new InputError('unsupported-input', `biquad Q ${q} must be > 0`);

  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);

  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;

  switch (spec.type) {
    case 'lowpass': {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'bandpass': {
      // Constant 0 dB peak gain (the "Q" bandpass).
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'notch': {
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      const A = 10 ** (requireGain(spec) / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const A = 10 ** (requireGain(spec) / 40);
      const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + sqrtA2alpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - sqrtA2alpha);
      a0 = A + 1 + (A - 1) * cos + sqrtA2alpha;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - sqrtA2alpha;
      break;
    }
    case 'highshelf': {
      const A = 10 ** (requireGain(spec) / 40);
      const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + sqrtA2alpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - sqrtA2alpha);
      a0 = A + 1 - (A - 1) * cos + sqrtA2alpha;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - sqrtA2alpha;
      break;
    }
    /* v8 ignore next 2 -- unreachable: the BiquadType union is exhaustively handled above. */
    default:
      return exhaustive(spec.type);
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * The analytic magnitude `|H(e^jω)|` of a biquad at frequency `f` (Hz), where
 * `H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)` and `z = e^{jω}`, `ω = 2πf/fs`. Evaluating the
 * complex numerator/denominator and taking the ratio of magnitudes gives the exact filter gain at `f`.
 */
export function magnitudeResponse(c: BiquadCoeffs, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  // z⁻¹ = cos(ω) − j·sin(ω); z⁻² = cos(2ω) − j·sin(2ω).
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);
  const numMag = Math.hypot(numRe, numIm);
  const denMag = Math.hypot(denRe, denIm);
  return denMag === 0 ? Number.POSITIVE_INFINITY : numMag / denMag;
}

/**
 * Exact Jury / Schur–Cohn stability test for a normalized second-order denominator `1 + a1 z⁻¹ + a2 z⁻²`:
 * its poles lie strictly inside the unit circle iff `|a2| < 1` **and** `|a1| < 1 + a2`. Every valid RBJ
 * design satisfies this; the check lets callers/tests assert stability without root-finding.
 */
export function polesInsideUnitCircle(c: BiquadCoeffs): boolean {
  return Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2;
}

/** Filter one channel in place into `out` via DF2T with zero initial state. */
function filterChannel(input: Float64Array, c: BiquadCoeffs): Float64Array {
  const out = new Float64Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] ?? 0;
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * Apply an RBJ biquad to `audio` (per-channel, DF2T, zero initial state). Silence is a fixed point
 * (zero in → zero out). Input untouched.
 *
 * @throws InputError for an out-of-band frequency, `q ≤ 0`, or a missing/non-finite `gainDb` (EQ/shelf).
 */
export function biquad(audio: PcmAudio, spec: BiquadSpec): PcmAudio {
  const coeffs = designBiquad(spec, audio.sampleRate);
  const planar = audio.planar.map((ch) => filterChannel(ch, coeffs));
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planar };
}

/* v8 ignore start -- unreachable exhaustiveness guard (a `never` parameter). */
/** Exhaustiveness guard — unreachable if the {@link BiquadType} union is fully handled. */
function exhaustive(value: never): never {
  throw new InputError('unsupported-input', `unhandled biquad type: ${String(value)}`);
}
/* v8 ignore stop */
