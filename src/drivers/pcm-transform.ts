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

export function applyPcmTransform(
  audio: PcmAudio,
  o?: PcmTransform,
  options: PcmTransformOptions = {},
): PcmAudio {
  throwIfAborted(o?.signal);
  let result = audio;
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
    result = resample(result, o.sampleRate);
  }
  if (o?.biquad !== undefined) {
    for (const spec of biquadSpecs(o.biquad)) result = biquad(result, spec);
  }
  if (o?.dynamics !== undefined) result = applyDynamics(result, o.dynamics);
  throwIfAborted(o?.signal);
  return result;
}
