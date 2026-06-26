import type { PcmTransform } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type BiquadSpec, biquad } from '../dsp/biquad.ts';
import { limit, normalizePeak, normalizeRms } from '../dsp/dynamics.ts';
import { type FadeShape, fadeIn, fadeOut } from '../dsp/fade.ts';
import { gain } from '../dsp/gain.ts';
import { remix } from '../dsp/mix.ts';
import type { PcmAudio } from '../dsp/pcm.ts';
import { resample } from '../dsp/resample.ts';

interface FadePlan {
  inFrames: number;
  outFrames: number;
  shape: FadeShape;
}

interface FadeInput {
  inSec?: unknown;
  outSec?: unknown;
  curve?: unknown;
}

interface DynamicsInput {
  normalize?: unknown;
  limit?: unknown;
}

interface DynamicsNormalizeInput {
  mode?: unknown;
  targetDbfs?: unknown;
}

interface DynamicsLimitInput {
  ceilingDbfs?: unknown;
  mode?: unknown;
  knee?: unknown;
}

interface PcmTransformOptions {
  resample?: 'allow' | 'reject';
  op?: string;
  tried?: readonly string[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', 'operation aborted');
}

function fadeRecord(value: unknown): FadeInput {
  if (typeof value !== 'object' || value === null) {
    throw new InputError('unsupported-input', 'audio fade must be an object');
  }
  return value as FadeInput;
}

function fadeShape(value: unknown): FadeShape {
  if (value === undefined || value === 'linear') return 'linear';
  if (value === 'equal-power') return 'equal-power';
  throw new InputError('unsupported-input', `unsupported audio fade curve '${String(value)}'`);
}

function fadeFrames(value: unknown, sampleRate: number, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InputError('unsupported-input', `${label} must be a finite non-negative duration`);
  }
  const frames = Math.round(value * sampleRate);
  if (!Number.isSafeInteger(frames)) {
    throw new InputError('unsupported-input', `${label} is too large for a safe frame count`);
  }
  return frames;
}

function fadePlan(o: PcmTransform | undefined, sampleRate: number): FadePlan | undefined {
  if (o?.fade === undefined) return undefined;
  const fade = fadeRecord(o.fade);
  return {
    inFrames: fadeFrames(fade.inSec, sampleRate, 'fade-in duration'),
    outFrames: fadeFrames(fade.outSec, sampleRate, 'fade-out duration'),
    shape: fadeShape(fade.curve),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new InputError('unsupported-input', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError('unsupported-input', `${label} must be a finite number`);
  }
  return value;
}

function dynamicsRecord(value: unknown): DynamicsInput {
  return record(value, 'audio dynamics') as DynamicsInput;
}

function dynamicsNormalize(value: unknown): DynamicsNormalizeInput {
  return record(value, 'audio dynamics normalize') as DynamicsNormalizeInput;
}

function dynamicsLimit(value: unknown): DynamicsLimitInput {
  return record(value, 'audio dynamics limit') as DynamicsLimitInput;
}

function limitMode(value: unknown): 'hard' | 'soft' {
  if (value === undefined || value === 'hard') return 'hard';
  if (value === 'soft') return 'soft';
  throw new InputError(
    'unsupported-input',
    `audio limiter mode '${String(value)}' is not supported`,
  );
}

function applyDynamics(audio: PcmAudio, value: unknown): PcmAudio {
  const dynamics = dynamicsRecord(value);
  let result = audio;
  if (dynamics.normalize !== undefined) {
    const normalize = dynamicsNormalize(dynamics.normalize);
    const target = finiteNumber(normalize.targetDbfs, 'audio normalize targetDbfs');
    if (normalize.mode === 'peak') result = normalizePeak(result, target);
    else if (normalize.mode === 'rms') result = normalizeRms(result, target);
    else {
      throw new InputError(
        'unsupported-input',
        `audio normalize mode '${String(normalize.mode)}' is not supported`,
      );
    }
  }
  if (dynamics.limit !== undefined) {
    const limiter = dynamicsLimit(dynamics.limit);
    const ceiling =
      limiter.ceilingDbfs === undefined
        ? 0
        : finiteNumber(limiter.ceilingDbfs, 'audio limiter ceilingDbfs');
    const mode = limitMode(limiter.mode);
    const knee =
      limiter.knee === undefined ? undefined : finiteNumber(limiter.knee, 'audio limiter knee');
    result = knee === undefined ? limit(result, ceiling, mode) : limit(result, ceiling, mode, knee);
  }
  return result;
}

function biquadSpec(value: unknown): BiquadSpec {
  if (typeof value !== 'object' || value === null) {
    throw new InputError('unsupported-input', 'audio biquad must be an object');
  }
  return value as BiquadSpec;
}

function biquadSpecs(value: unknown): readonly BiquadSpec[] {
  if (Array.isArray(value)) return value.map((item) => biquadSpec(item));
  return [biquadSpec(value)];
}

/**
 * Slice a PCM buffer to the half-open time window `[startSec, endSec)`, in its OWN sample rate (the cut
 * happens before any resample). Bounds are clamped to `[0, frames]` and `start ≤ end` so a request slightly
 * past EOF (a "to the end" trim that rounds up) yields the tail, never an error or a negative length — the
 * public `trim` op has already range-validated against the probed duration (engine `assertTrimRange`). Each
 * channel is a zero-copy `subarray` view of the source planar data (lossless; the serializer copies on
 * write). Returns the original buffer untouched when the window already covers everything.
 */
function slicePcmFrames(
  audio: PcmAudio,
  bounds: { readonly startSec: number; readonly endSec: number },
): PcmAudio {
  const rate = audio.sampleRate;
  const start = Math.min(audio.frames, Math.max(0, Math.round(bounds.startSec * rate)));
  const end = Math.min(audio.frames, Math.max(start, Math.round(bounds.endSec * rate)));
  if (start === 0 && end === audio.frames) return audio;
  return {
    sampleRate: rate,
    channels: audio.channels,
    frames: end - start,
    planar: audio.planar.map((ch) => ch.subarray(start, end)),
  };
}

export function applyPcmTransform(
  audio: PcmAudio,
  o?: PcmTransform,
  options: PcmTransformOptions = {},
): PcmAudio {
  throwIfAborted(o?.signal);
  let result = audio;
  // Sample-accurate trim FIRST (ADR-021 PCM-native trim): cut to `[startSec, endSec)` in the source rate so
  // every later stage (gain/fade/remix/resample) operates on the kept range — a fade-out then lands at the
  // new end, a resample changes the cut buffer's rate, etc. PCM has no inter-frame dependency, so this is a
  // lossless, frame-exact slice (no codec seam).
  if (o?.timeBounds !== undefined) result = slicePcmFrames(result, o.timeBounds);
  if (o?.gainDb !== undefined && o.gainDb !== 0) result = gain(result, o.gainDb);
  const fade = fadePlan(o, result.sampleRate);
  if (fade !== undefined) {
    if (fade.inFrames > 0) result = fadeIn(result, fade.inFrames, fade.shape);
    if (fade.outFrames > 0) result = fadeOut(result, fade.outFrames, fade.shape);
  }
  if (o?.channels !== undefined && o.channels !== result.channels)
    result = remix(result, o.channels);
  if (o?.sampleRate !== undefined && o.sampleRate !== result.sampleRate) {
    if (options.resample === 'reject') {
      throw new CapabilityError(
        'capability-miss',
        `audio resample ${result.sampleRate}→${o.sampleRate} Hz needs the WASM/WebAudio tail`,
        { op: options.op ?? 'convert', tried: [...(options.tried ?? [])] },
      );
    }
    result = resample(result, o.sampleRate, { signal: o.signal });
  }
  if (o?.biquad !== undefined) {
    for (const spec of biquadSpecs(o.biquad)) result = biquad(result, spec);
  }
  if (o?.dynamics !== undefined) result = applyDynamics(result, o.dynamics);
  throwIfAborted(o?.signal);
  return result;
}
