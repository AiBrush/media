/**
 * Lossy-seam audio filter PLANNING (docs/architecture/09; ADR-088) — the pure builder that turns a public
 * {@link AudioTarget} into the ordered `AudioData→AudioData` {@link FilterSpec} chain the engine composes
 * on a decoded audio stream BEFORE the encoder, so a lossy-codec convert is bit-exactly equivalent to the
 * PCM-native `transformPcm` transform up to the encoder.
 *
 * Why a SEPARATE module (split out of `codec-pipeline.ts`): this code — `audioFilterSpecs` plus its
 * exclusive helpers (`fadeFramesAt`/`fadeCurve`/`resolveDynamics`) and the audio-dsp type imports they pull
 * (`BiquadSpec`, `DynamicsSpec`, `FadeShape`, `PcmDynamics`, …) — is reached ONLY on the
 * convert-with-lossy-audio-filter path. Keeping it here, behind the engine's lazy `import('./audio-stream-
 * plan.ts')` rather than the static `codec-pipeline.ts` edge, keeps it OUT of the eager kernel closure
 * (BUILD §2, doc 08 §7 byte budget). The geometry/codec-string/container helpers an eager probe/remux DOES
 * touch (`videoFilterSpecs`, `chooseOutputContainer`, `buildVideoEncoderConfig`, …) stay in
 * `codec-pipeline.ts`. Everything here is *pure* and Node-unit-tested (real, can-fail, no WebCodecs); the
 * live `AudioData` composition that runs the chain is browser-only (validated in the harness, BUILD §6.1).
 */

import type { FilterSpec } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import type { BiquadSpec } from '../dsp/biquad.ts';
import type { DynamicsSpec, LimitSpec, NormalizeSpec } from '../dsp/dynamics.ts';
import type { FadeShape } from '../dsp/fade.ts';
import type { AudioTarget, PcmDynamics } from './types.ts';

/** Source audio layout an audio filter chain is planned against (the decoded track's rate/channels). */
export interface SourceAudio {
  sampleRate: number | undefined;
  channels: number | undefined;
}

/** Resolve a fade-duration (seconds) to a source-rate frame count, mirroring `transformPcm`'s `fadeFrames`. */
function fadeFramesAt(
  sec: number | undefined,
  sampleRate: number | undefined,
  label: string,
): number {
  if (sec === undefined) return 0;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) {
    throw new InputError('unsupported-input', `${label} must be a finite non-negative duration`);
  }
  if (sampleRate === undefined || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new InputError(
      'unsupported-input',
      `cannot resolve ${label} without a known source sample rate`,
    );
  }
  const frames = Math.round(sec * sampleRate);
  if (!Number.isSafeInteger(frames)) {
    throw new InputError('unsupported-input', `${label} is too large for a safe frame count`);
  }
  return frames;
}

/** Validate the public fade `curve` (defaulting to `linear` like `transformPcm`'s `fadeShape`). */
function fadeCurve(curve: 'linear' | 'equal-power' | undefined): FadeShape {
  if (curve === undefined || curve === 'linear') return 'linear';
  if (curve === 'equal-power') return 'equal-power';
  throw new InputError('unsupported-input', `unsupported audio fade curve '${String(curve)}'`);
}

/** Resolve the public {@link PcmDynamics} into the dsp {@link DynamicsSpec} (same defaults as `transformPcm`). */
function resolveDynamics(dynamics: PcmDynamics): DynamicsSpec {
  let normalize: NormalizeSpec | undefined;
  if (dynamics.normalize !== undefined) {
    const { mode, targetDbfs } = dynamics.normalize;
    if (mode !== 'peak' && mode !== 'rms') {
      throw new InputError(
        'unsupported-input',
        `audio normalize mode '${String(mode)}' is not supported`,
      );
    }
    if (!Number.isFinite(targetDbfs)) {
      throw new InputError(
        'unsupported-input',
        'audio normalize targetDbfs must be a finite number',
      );
    }
    normalize = { mode, targetDbfs };
  }
  let limit: LimitSpec | undefined;
  if (dynamics.limit !== undefined) {
    const { ceilingDbfs, mode, knee } = dynamics.limit;
    const resolvedCeiling = ceilingDbfs ?? 0;
    if (!Number.isFinite(resolvedCeiling)) {
      throw new InputError(
        'unsupported-input',
        'audio limiter ceilingDbfs must be a finite number',
      );
    }
    const resolvedMode = mode ?? 'hard';
    if (resolvedMode !== 'hard' && resolvedMode !== 'soft') {
      throw new InputError(
        'unsupported-input',
        `audio limiter mode '${String(resolvedMode)}' is not supported`,
      );
    }
    if (knee !== undefined && !Number.isFinite(knee)) {
      throw new InputError('unsupported-input', 'audio limiter knee must be a finite number');
    }
    limit = {
      ceilingDbfs: resolvedCeiling,
      mode: resolvedMode,
      ...(knee !== undefined ? { knee } : {}),
    };
  }
  if (normalize === undefined && limit === undefined) {
    throw new InputError(
      'unsupported-input',
      'audio dynamics needs a normalize and/or limit stage',
    );
  }
  return {
    ...(normalize !== undefined ? { normalize } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/**
 * Build the ordered audio {@link FilterSpec} chain for an {@link AudioTarget} re-encode: **gain → fade →
 * remix → resample → biquad → dynamics**, each emitted only when it is not a no-op. The order mirrors the
 * PCM path (`transformPcm`) exactly, so a lossy-codec convert is bit-exactly equivalent to the PCM-native
 * transform up to the encoder: gain & fade scale samples in the source layout/rate (fade frames are
 * resolved against the **source** rate, since fade precedes resample), remix changes the channel layout,
 * resample changes the rate, then biquad/EQ and dynamics run on the final target layout/rate. These run as
 * `AudioData→AudioData` stages (the audio-dsp filter driver) on the decoded stream BEFORE the encoder, so
 * the `AudioData` fed in matches the encoder's configured `numberOfChannels`/`sampleRate` exactly. The
 * fade/biquad/dynamics stages are **stream-stateful** (fade tail look-ahead, persisted biquad registers, a
 * whole-signal normalize buffer) — that is what lets these whole-signal effects cross the codec seam.
 * Empty array ⇒ the decoded stream feeds the encoder unchanged. Pure: every spec is a plain object, so the
 * chain is Node-validated; the substrate that runs it is browser-only.
 */
export function audioFilterSpecs(target: AudioTarget, src: SourceAudio): FilterSpec[] {
  const specs: FilterSpec[] = [];
  if (target.gainDb !== undefined) {
    if (!Number.isFinite(target.gainDb)) {
      throw new InputError('unsupported-input', `audio gain ${target.gainDb} dB must be finite`);
    }
    if (target.gainDb !== 0) specs.push({ mediaType: 'audio', type: 'gain', db: target.gainDb });
  }
  if (target.fade !== undefined) {
    const curve = fadeCurve(target.fade.curve);
    const inFrames = fadeFramesAt(target.fade.inSec, src.sampleRate, 'fade-in duration');
    const outFrames = fadeFramesAt(target.fade.outSec, src.sampleRate, 'fade-out duration');
    if (inFrames > 0 || outFrames > 0) {
      specs.push({ mediaType: 'audio', type: 'fade', curve, inFrames, outFrames });
    }
  }
  if (target.channels !== undefined && target.channels !== src.channels) {
    if (target.channels <= 0 || !Number.isInteger(target.channels)) {
      throw new InputError(
        'unsupported-input',
        `audio channel count ${target.channels} must be a positive integer`,
      );
    }
    specs.push({ mediaType: 'audio', type: 'remix', channels: target.channels });
  }
  if (target.sampleRate !== undefined && target.sampleRate !== src.sampleRate) {
    if (target.sampleRate <= 0 || !Number.isInteger(target.sampleRate)) {
      throw new InputError(
        'unsupported-input',
        `audio sample rate ${target.sampleRate} must be a positive integer`,
      );
    }
    specs.push({ mediaType: 'audio', type: 'resample', sampleRate: target.sampleRate });
  }
  if (target.biquad !== undefined) {
    const biquads: readonly BiquadSpec[] = Array.isArray(target.biquad)
      ? target.biquad
      : [target.biquad as BiquadSpec];
    for (const spec of biquads) specs.push({ mediaType: 'audio', type: 'biquad', spec });
  }
  if (target.dynamics !== undefined) {
    specs.push({
      mediaType: 'audio',
      type: 'dynamics',
      dynamics: resolveDynamics(target.dynamics),
    });
  }
  return specs;
}
