/**
 * Pure H.264 two-pass rate allocation. The browser-only first pass reduces each encoded picture to one
 * small record; this module turns those records into the pass-two per-picture quantizer schedule without
 * retaining frames or payload bytes.
 */

import { InputError } from '../contracts/errors.ts';

export const H264_FIRST_PASS_QUANTIZER = 28 as const;

const H264_MIN_QUANTIZER = 0;
const H264_MAX_QUANTIZER = 51;
const H264_QP_PER_SIZE_DOUBLING = 6;
const COMPLEXITY_BLUR = 0.6;
const KEYFRAME_WEIGHT = 1.15;
const MAX_ADJACENT_QP_DELTA = 4;
const MICROS_PER_SECOND = 1_000_000;
const BITS_PER_BYTE = 8;

export interface H264FirstPassSample {
  readonly timestampUs: number;
  readonly durationUs?: number;
  readonly byteLength: number;
  readonly keyFrame: boolean;
}

export interface H264TwoPassPlan {
  readonly sampleCount: number;
  readonly durationUs: number;
  readonly firstPassBytes: number;
  readonly targetBytes: number;
  /** Size predicted by the H.264 QP model after integer-QP smoothing/calibration. */
  readonly predictedBytes: number;
  /** Packed PTS evidence: eight timestamp bytes plus one QP byte per analyzed picture. */
  readonly evidenceBytes: number;
  readonly timestampsUs: Readonly<Float64Array>;
  quantizerForTimestamp(timestampUs: number): number;
}

interface TimedSample extends H264FirstPassSample {
  readonly durationUs: number;
}

function finiteNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InputError('unsupported-input', `${label} must be a non-negative safe integer`);
  }
}

function positiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError('unsupported-input', `${label} must be finite and positive`);
  }
}

function clampQuantizer(value: number): number {
  return Math.min(H264_MAX_QUANTIZER, Math.max(H264_MIN_QUANTIZER, Math.round(value)));
}

function normalizeTimeline(
  samples: readonly H264FirstPassSample[],
  declaredDurationSec: number | undefined,
): { readonly samples: readonly TimedSample[]; readonly durationUs: number } {
  if (samples.length === 0) {
    throw new InputError('unsupported-input', 'H.264 two-pass first pass produced no pictures');
  }
  const sorted = [...samples].sort((a, b) => a.timestampUs - b.timestampUs);
  const declaredDurationUs =
    declaredDurationSec === undefined
      ? undefined
      : Math.round(declaredDurationSec * MICROS_PER_SECOND);
  if (declaredDurationUs !== undefined) positiveFinite(declaredDurationUs, 'declared duration');

  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    if (current === undefined) continue;
    finiteNonNegativeInteger(current.timestampUs, 'first-pass timestamp');
    finiteNonNegativeInteger(current.byteLength, 'first-pass byte length');
    if (current.byteLength === 0) {
      throw new InputError(
        'unsupported-input',
        'H.264 two-pass first pass emitted an empty picture',
      );
    }
    if (current.durationUs !== undefined) positiveFinite(current.durationUs, 'picture duration');
    const previous = sorted[index - 1];
    if (previous?.timestampUs === current.timestampUs) {
      throw new InputError(
        'unsupported-input',
        `H.264 two-pass first pass duplicated PTS ${current.timestampUs}`,
      );
    }
  }

  const firstTimestamp = sorted[0]?.timestampUs ?? 0;
  const last = sorted.at(-1);
  if (last === undefined) {
    throw new InputError('unsupported-input', 'H.264 two-pass first pass produced no pictures');
  }
  const declaredEndUs =
    declaredDurationUs === undefined ? undefined : firstTimestamp + declaredDurationUs;
  const fallbackLastDuration =
    last.durationUs ??
    (declaredEndUs !== undefined ? declaredEndUs - last.timestampUs : undefined) ??
    (sorted.length > 1
      ? last.timestampUs - (sorted.at(-2)?.timestampUs ?? last.timestampUs)
      : undefined);
  if (fallbackLastDuration === undefined || fallbackLastDuration <= 0) {
    throw new InputError(
      'unsupported-input',
      'H.264 two-pass needs a duration for its final picture',
    );
  }

  const timed = sorted.map((current, index): TimedSample => {
    const next = sorted[index + 1];
    const durationUs =
      current.durationUs ??
      (next === undefined ? fallbackLastDuration : next.timestampUs - current.timestampUs);
    positiveFinite(durationUs, 'picture duration');
    return { ...current, durationUs };
  });
  const derivedEnd = Math.max(...timed.map((sample) => sample.timestampUs + sample.durationUs));
  const durationUs = declaredDurationUs ?? derivedEnd - firstTimestamp;
  positiveFinite(durationUs, 'two-pass timeline duration');
  return { samples: timed, durationUs };
}

function smoothQuantizers(values: readonly number[]): readonly number[] {
  const forward: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? H264_FIRST_PASS_QUANTIZER;
    const previous = forward[index - 1];
    forward.push(
      previous === undefined
        ? value
        : Math.min(
            previous + MAX_ADJACENT_QP_DELTA,
            Math.max(previous - MAX_ADJACENT_QP_DELTA, value),
          ),
    );
  }
  for (let index = forward.length - 2; index >= 0; index--) {
    const value = forward[index];
    const next = forward[index + 1];
    if (value === undefined || next === undefined) continue;
    forward[index] = Math.min(
      next + MAX_ADJACENT_QP_DELTA,
      Math.max(next - MAX_ADJACENT_QP_DELTA, value),
    );
  }
  return forward.map(clampQuantizer);
}

function predictedBytesForQuantizers(
  samples: readonly TimedSample[],
  quantizers: readonly number[],
): number {
  return samples.reduce((total, sample, index) => {
    const quantizer = quantizers[index];
    if (quantizer === undefined) {
      throw new InputError('unsupported-input', 'H.264 two-pass quantizer schedule is incomplete');
    }
    return (
      total +
      sample.byteLength * 2 ** ((H264_FIRST_PASS_QUANTIZER - quantizer) / H264_QP_PER_SIZE_DOUBLING)
    );
  }, 0);
}

function calibrateQuantizers(
  samples: readonly TimedSample[],
  values: readonly number[],
  targetBytes: number,
): readonly number[] {
  const smoothed = smoothQuantizers(values);
  // Integer QP rounding and adjacent-picture slew perturb the continuous allocation. Choose the bounded
  // global integer offset whose H.264 size model lands closest to the requested aggregate budget. The
  // logarithmic model gives the ideal offset directly; checking its two neighbors covers integer rounding
  // and QP clamping without scanning the whole range for every picture.
  let best = smoothed;
  let bestError = Number.POSITIVE_INFINITY;
  const basePrediction = predictedBytesForQuantizers(samples, smoothed);
  const idealOffset = Math.round(
    H264_QP_PER_SIZE_DOUBLING * Math.log2(basePrediction / targetBytes),
  );
  const offsets = new Set([0, idealOffset - 1, idealOffset, idealOffset + 1]);
  for (const offset of offsets) {
    const candidate = smoothed.map((value) => clampQuantizer(value + offset));
    const predicted = predictedBytesForQuantizers(samples, candidate);
    const error = Math.abs(Math.log(predicted / targetBytes));
    if (error < bestError) {
      best = candidate;
      bestError = error;
    }
  }
  return best;
}

/** Build the timestamp-exact second-pass H.264 quantizer schedule from a real fixed-QP first pass. */
export function planH264TwoPass(
  firstPass: readonly H264FirstPassSample[],
  targetBitrate: number,
  declaredDurationSec?: number,
): H264TwoPassPlan {
  if (!Number.isSafeInteger(targetBitrate) || targetBitrate <= 0) {
    throw new InputError(
      'unsupported-input',
      'H.264 two-pass bitrate must be a positive safe integer',
    );
  }
  const timeline = normalizeTimeline(firstPass, declaredDurationSec);
  const targetBytes = Math.round(
    (targetBitrate * timeline.durationUs) / (BITS_PER_BYTE * MICROS_PER_SECOND),
  );
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new InputError(
      'unsupported-input',
      'H.264 two-pass target byte budget is not representable',
    );
  }
  const firstPassBytes = timeline.samples.reduce((total, sample) => total + sample.byteLength, 0);
  if (!Number.isSafeInteger(firstPassBytes) || firstPassBytes <= 0) {
    throw new InputError(
      'unsupported-input',
      'H.264 two-pass first-pass size is not representable',
    );
  }

  const weights = timeline.samples.map((sample) => {
    const durationWeight = sample.durationUs ** (1 - COMPLEXITY_BLUR);
    const complexityWeight = sample.byteLength ** COMPLEXITY_BLUR;
    return durationWeight * complexityWeight * (sample.keyFrame ? KEYFRAME_WEIGHT : 1);
  });
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  positiveFinite(totalWeight, 'H.264 two-pass complexity weight');
  const rawQuantizers = timeline.samples.map((sample, index) => {
    const weight = weights[index];
    if (weight === undefined || weight <= 0) {
      throw new InputError('unsupported-input', 'H.264 two-pass picture has no complexity weight');
    }
    const allocatedBytes = (targetBytes * weight) / totalWeight;
    const sizeRatio = sample.byteLength / allocatedBytes;
    return clampQuantizer(
      H264_FIRST_PASS_QUANTIZER + H264_QP_PER_SIZE_DOUBLING * Math.log2(sizeRatio),
    );
  });
  const quantizers = calibrateQuantizers(timeline.samples, rawQuantizers, targetBytes);
  const predictedBytes = Math.round(predictedBytesForQuantizers(timeline.samples, quantizers));
  const timestampsUs = new Float64Array(timeline.samples.length);
  const packedQuantizers = new Uint8Array(timeline.samples.length);
  timeline.samples.forEach((sample, index) => {
    const quantizer = quantizers[index];
    if (quantizer === undefined) {
      throw new InputError('unsupported-input', 'H.264 two-pass quantizer schedule is incomplete');
    }
    timestampsUs[index] = sample.timestampUs;
    packedQuantizers[index] = quantizer;
  });
  let replayCursor = 0;

  const quantizerAtIndex = (index: number): number => {
    const quantizer = packedQuantizers[index];
    if (quantizer === undefined) {
      throw new InputError('unsupported-input', 'H.264 two-pass quantizer schedule is incomplete');
    }
    return quantizer;
  };

  const findTimestamp = (timestampUs: number): number => {
    let low = 0;
    let high = timestampsUs.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = timestampsUs[middle];
      if (candidate === timestampUs) return middle;
      if (candidate === undefined || candidate > timestampUs) high = middle - 1;
      else low = middle + 1;
    }
    return -1;
  };

  return {
    sampleCount: timeline.samples.length,
    durationUs: timeline.durationUs,
    firstPassBytes,
    targetBytes,
    predictedBytes,
    evidenceBytes: timestampsUs.byteLength + packedQuantizers.byteLength,
    timestampsUs,
    quantizerForTimestamp(timestampUs): number {
      finiteNonNegativeInteger(timestampUs, 'second-pass timestamp');
      // Normal decoder output is in presentation order, so replay is one array read per picture. The
      // binary-search fallback keeps this pure API robust for diagnostics and out-of-order callers.
      if (timestampsUs[replayCursor] === timestampUs) {
        const quantizer = quantizerAtIndex(replayCursor);
        replayCursor++;
        return quantizer;
      }
      const index = findTimestamp(timestampUs);
      if (index < 0) {
        throw new InputError(
          'unsupported-input',
          `H.264 two-pass replay changed picture PTS ${timestampUs}`,
        );
      }
      return quantizerAtIndex(index);
    },
  };
}
