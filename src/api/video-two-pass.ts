/**
 * Pure H.264 two-pass rate allocation. The browser-only first pass reduces each encoded picture to one
 * small record; this module turns those records into the pass-two per-picture quantizer schedule without
 * retaining frames or payload bytes.
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';

export const H264_FIRST_PASS_QUANTIZER = 28 as const;
/**
 * Operational ceiling for the in-memory per-picture analysis schedule. The limit is independent of
 * fixture identity and keeps every analysis/candidate array bounded before a replay can allocate it.
 */
export const H264_TWO_PASS_MAX_PICTURE_EVIDENCE = 262_144;

const H264_MIN_QUANTIZER = 0;
const H264_MAX_QUANTIZER = 51;
const H264_QP_PER_SIZE_DOUBLING = 6;
/**
 * Allocate mildly superlinearly with fixed-QP bytes per presentation-time unit. For
 *
 *   weight = duration * (bytes / duration)^a
 *
 * the QP model below reduces to `q = constant + 6 * (1 - a) * log2(bytes / duration)` before
 * key-picture credit, smoothing, and global calibration. `a = 1.15` therefore gives a difficult
 * picture 0.9 lower (better) QP per complexity doubling. A sublinear exponent instead gives harder
 * pictures worse QP, the opposite of the intended complexity-aware allocation.
 */
const COMPLEXITY_EXPONENT = 1.15;
const KEYFRAME_WEIGHT = 1.15;
const MAX_ADJACENT_QP_DELTA = 4;
const MICROS_PER_SECOND = 1_000_000;
const BITS_PER_BYTE = 8;
const DECLARED_DURATION_ROUNDING_TOLERANCE_US = 1;

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
  /** Packed per-picture QPs, aligned one-to-one with {@link timestampsUs}. */
  readonly quantizers: Readonly<Uint8Array>;
  quantizerForTimestamp(timestampUs: number): number;
  /** Validate an encoded candidate's exact PTS/duration set and return its measured presentation span. */
  validateCandidateTimeline(actualSamples: readonly H264FirstPassSample[]): number;
  /**
   * Return a fresh replay cursor with the same complexity shape globally recalibrated from one exact
   * candidate encode. Candidate samples must cover the analyzed PTS set one-to-one.
   */
  recalibrate(actualSamples: readonly H264FirstPassSample[], targetBytes: number): H264TwoPassPlan;
}

interface TimedSample extends H264FirstPassSample {
  /** Duration that the eventual buffered mux path assigns to this presentation sample. */
  readonly durationUs: number;
  /** Verbatim nullable WebCodecs chunk duration retained for candidate-equivalence checks. */
  readonly chunkDurationUs: number | undefined;
}

function finiteNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InputError(`${label} must be a non-negative safe integer`);
  }
}

function positiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${label} must be finite and positive`);
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${label} must be a positive safe integer`);
  }
}

/** Reject a replay schedule before retaining more than the operation's fixed picture-evidence bound. */
export function assertH264TwoPassPictureEvidenceCapacity(pictureCount: number): void {
  if (!Number.isSafeInteger(pictureCount) || pictureCount < 0) {
    throw new InputError('H.264 two-pass picture count must be a non-negative safe integer');
  }
  if (pictureCount <= H264_TWO_PASS_MAX_PICTURE_EVIDENCE) return;
  throw new CapabilityError('H.264 two-pass picture evidence exceeds the in-memory limit', {
    op: {
      kind: 'route',
      id: 'h264-two-pass-picture-evidence',
      facts: {
        pictureCount,
        maximumPictureCount: H264_TWO_PASS_MAX_PICTURE_EVIDENCE,
      },
    },
    tried: ['in-memory-picture-evidence'],
    suggestion:
      'use a shorter/lower-frame-rate source or an encode mode that does not require replay',
  });
}

function clampQuantizer(value: number): number {
  return Math.min(H264_MAX_QUANTIZER, Math.max(H264_MIN_QUANTIZER, Math.round(value)));
}

function normalizeTimeline(
  samples: readonly H264FirstPassSample[],
  declaredDurationSec: number | undefined,
): { readonly samples: readonly TimedSample[]; readonly durationUs: number } {
  assertH264TwoPassPictureEvidenceCapacity(samples.length);
  if (samples.length === 0) {
    throw new InputError('H.264 two-pass first pass produced no pictures');
  }
  const presentationOrderIsEncodeOrder = samples.every(
    (sample, index) => index === 0 || sample.timestampUs >= (samples[index - 1]?.timestampUs ?? 0),
  );
  const sorted = [...samples].sort((a, b) => a.timestampUs - b.timestampUs);
  const declaredDurationUs =
    declaredDurationSec === undefined
      ? undefined
      : Math.round(declaredDurationSec * MICROS_PER_SECOND);
  if (declaredDurationUs !== undefined)
    positiveSafeInteger(declaredDurationUs, 'declared duration');

  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    if (current === undefined) continue;
    finiteNonNegativeInteger(current.timestampUs, 'first-pass timestamp');
    finiteNonNegativeInteger(current.byteLength, 'first-pass byte length');
    if (current.byteLength === 0) {
      throw new InputError('H.264 two-pass first pass emitted an empty picture');
    }
    if (current.durationUs !== undefined) {
      positiveSafeInteger(current.durationUs, 'picture duration');
    }
    const previous = sorted[index - 1];
    if (previous?.timestampUs === current.timestampUs) {
      throw new InputError(`H.264 two-pass first pass duplicated PTS ${current.timestampUs}`);
    }
  }

  const firstTimestamp = sorted[0]?.timestampUs ?? 0;
  const last = sorted.at(-1);
  if (last === undefined) {
    throw new InputError('H.264 two-pass first pass produced no pictures');
  }
  const hasAllChunkDurations = sorted.every((sample) => sample.durationUs !== undefined);

  const timed = sorted.map((current, index): TimedSample => {
    const next = sorted[index + 1];
    const nextPtsDuration = next === undefined ? undefined : next.timestampUs - current.timestampUs;
    let durationUs = current.durationUs;
    if (presentationOrderIsEncodeOrder && nextPtsDuration !== undefined) {
      positiveSafeInteger(nextPtsDuration, 'picture PTS interval');
      durationUs = nextPtsDuration;
    } else if (presentationOrderIsEncodeOrder && durationUs === undefined) {
      durationUs =
        index === 0
          ? 0
          : current.timestampUs - (sorted[index - 1]?.timestampUs ?? current.timestampUs);
    } else if (!presentationOrderIsEncodeOrder && !hasAllChunkDurations) {
      // This is the same presentation-order recovery used by the buffered MP4 muxer when a reordered
      // encoder omits at least one duration: every declared duration is ignored, adjacent PTS gaps are
      // authoritative, and the final picture reuses the preceding presentation gap.
      durationUs =
        nextPtsDuration ??
        (index === 0
          ? 0
          : current.timestampUs - (sorted[index - 1]?.timestampUs ?? current.timestampUs));
    }
    if (durationUs === undefined) {
      throw new InputError('H.264 two-pass needs a duration for its final picture');
    }
    positiveSafeInteger(durationUs, 'picture duration');
    return { ...current, chunkDurationUs: current.durationUs, durationUs };
  });
  let derivedEnd = firstTimestamp;
  for (const sample of timed) {
    const sampleEnd = sample.timestampUs + sample.durationUs;
    if (!Number.isSafeInteger(sampleEnd)) {
      throw new InputError('H.264 picture presentation end exceeds safe integer accounting');
    }
    if (sampleEnd > derivedEnd) derivedEnd = sampleEnd;
  }
  const durationUs = derivedEnd - firstTimestamp;
  positiveSafeInteger(durationUs, 'two-pass timeline duration');
  if (
    declaredDurationUs !== undefined &&
    Math.abs(declaredDurationUs - durationUs) > DECLARED_DURATION_ROUNDING_TOLERANCE_US
  ) {
    throw new InputError(
      `H.264 declared duration ${declaredDurationUs}us does not match measured presentation span ${durationUs}us`,
    );
  }
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
      throw new InputError('H.264 two-pass quantizer schedule is incomplete');
    }
    return (
      total +
      sample.byteLength * 2 ** ((H264_FIRST_PASS_QUANTIZER - quantizer) / H264_QP_PER_SIZE_DOUBLING)
    );
  }, 0);
}

interface PredictedQuantizerSchedule {
  readonly quantizers: readonly number[];
  readonly predictedBytes: number;
}

/**
 * Spend the byte headroom between two integer-QP schedules without requiring a fractional H.264 QP.
 * The lower-rate schedule is the safe base. Pictures are promoted to the higher-rate schedule in
 * descending measured-complexity order while their modeled increment still fits. This preserves the
 * hard bound, improves the most expensive pictures first, and avoids the coarse ~12% whole-stream rate
 * jump of changing every picture by one QP.
 */
function interpolateQuantizerSchedules(
  actualBytes: readonly number[],
  currentQuantizers: ArrayLike<number>,
  targetBytes: number,
  under: PredictedQuantizerSchedule,
  over: PredictedQuantizerSchedule,
): PredictedQuantizerSchedule {
  if (under.predictedBytes > targetBytes || over.predictedBytes <= targetBytes) return under;

  const quantizers = [...under.quantizers];
  const upgrades = actualBytes.flatMap((bytes, index) => {
    const current = currentQuantizers[index];
    const lowerRateQp = under.quantizers[index];
    const higherRateQp = over.quantizers[index];
    if (
      current === undefined ||
      lowerRateQp === undefined ||
      higherRateQp === undefined ||
      higherRateQp >= lowerRateQp
    ) {
      return [];
    }
    const lowerRateBytes = bytes * 2 ** ((current - lowerRateQp) / H264_QP_PER_SIZE_DOUBLING);
    const higherRateBytes = bytes * 2 ** ((current - higherRateQp) / H264_QP_PER_SIZE_DOUBLING);
    return [
      {
        index,
        quantizer: higherRateQp,
        increment: higherRateBytes - lowerRateBytes,
        complexity: bytes,
      },
    ];
  });
  upgrades.sort((a, b) => b.complexity - a.complexity || a.index - b.index);

  let predictedBytes = under.predictedBytes;
  for (const upgrade of upgrades) {
    if (!(upgrade.increment > 0) || predictedBytes + upgrade.increment > targetBytes) continue;
    quantizers[upgrade.index] = upgrade.quantizer;
    predictedBytes += upgrade.increment;
  }
  return { quantizers, predictedBytes };
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

function createPlan(
  timeline: {
    readonly samples: readonly TimedSample[];
    readonly durationUs: number;
  },
  firstPassBytes: number,
  targetBytes: number,
  predictedBytes: number,
  quantizerValues: readonly number[],
): H264TwoPassPlan {
  const timestampsUs = new Float64Array(timeline.samples.length);
  const packedQuantizers = new Uint8Array(timeline.samples.length);
  timeline.samples.forEach((sample, index) => {
    const quantizer = quantizerValues[index];
    if (quantizer === undefined) {
      throw new InputError('H.264 two-pass quantizer schedule is incomplete');
    }
    timestampsUs[index] = sample.timestampUs;
    packedQuantizers[index] = quantizer;
  });
  let replayCursor = 0;

  const quantizerAtIndex = (index: number): number => {
    const quantizer = packedQuantizers[index];
    if (quantizer === undefined) {
      throw new InputError('H.264 two-pass quantizer schedule is incomplete');
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

  const validateCandidate = (
    actualSamples: readonly H264FirstPassSample[],
  ): { readonly samples: readonly TimedSample[]; readonly durationUs: number } => {
    if (actualSamples.length !== timeline.samples.length) {
      throw new InputError(
        `H.264 candidate emitted ${actualSamples.length}/${timeline.samples.length} analyzed pictures`,
      );
    }
    const actualTimeline = normalizeTimeline(actualSamples, undefined);
    for (let index = 0; index < actualTimeline.samples.length; index++) {
      const expected = timeline.samples[index];
      const actual = actualTimeline.samples[index];
      if (
        expected === undefined ||
        actual === undefined ||
        actual.timestampUs !== expected.timestampUs
      ) {
        throw new InputError('H.264 candidate changed the analyzed presentation timeline');
      }
      if (actual.chunkDurationUs !== expected.chunkDurationUs) {
        throw new InputError(
          `H.264 candidate changed picture duration at PTS ${actual.timestampUs}`,
        );
      }
    }
    if (actualTimeline.durationUs !== timeline.durationUs) {
      throw new InputError(
        `H.264 candidate presentation span ${actualTimeline.durationUs}us does not match the analyzed mux span ${timeline.durationUs}us`,
      );
    }
    return actualTimeline;
  };

  return {
    sampleCount: timeline.samples.length,
    durationUs: timeline.durationUs,
    firstPassBytes,
    targetBytes,
    predictedBytes,
    evidenceBytes: timestampsUs.byteLength + packedQuantizers.byteLength,
    timestampsUs,
    quantizers: packedQuantizers,
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
        throw new InputError(`H.264 two-pass replay changed picture PTS ${timestampUs}`);
      }
      return quantizerAtIndex(index);
    },
    validateCandidateTimeline(actualSamples): number {
      return validateCandidate(actualSamples).durationUs;
    },
    recalibrate(actualSamples, nextTargetBytes): H264TwoPassPlan {
      if (!Number.isSafeInteger(nextTargetBytes) || nextTargetBytes <= 0) {
        throw new InputError('H.264 candidate target byte budget must be a positive safe integer');
      }
      const presentationSamples = validateCandidate(actualSamples).samples;
      const actualBytes: number[] = [];
      let totalActualBytes = 0;
      for (let index = 0; index < presentationSamples.length; index++) {
        const sample = presentationSamples[index];
        if (sample === undefined) throw new InputError('H.264 candidate evidence is incomplete');
        finiteNonNegativeInteger(sample.byteLength, 'candidate byte length');
        if (sample.byteLength === 0) {
          throw new InputError('H.264 candidate emitted an empty picture');
        }
        actualBytes.push(sample.byteLength);
        totalActualBytes += sample.byteLength;
      }
      if (!Number.isSafeInteger(totalActualBytes) || totalActualBytes <= 0) {
        throw new InputError('H.264 candidate size is not representable');
      }

      // H.264's local rate response is approximately one size doubling per six QPs. Use the exact
      // candidate access-unit sizes to score the globally shifted schedule, including per-picture QP
      // clamping, and inspect the ideal integer shift plus its neighbors. When the byte bound falls
      // between two integer global shifts, interpolate them across the measured picture population so a
      // one-QP step does not strand substantial usable headroom. No fixture/QP outcome is baked in:
      // every correction derives from the declared byte budget and the preceding candidate itself.
      const idealOffset = Math.round(
        H264_QP_PER_SIZE_DOUBLING * Math.log2(totalActualBytes / nextTargetBytes),
      );
      let bestUnder: PredictedQuantizerSchedule | undefined;
      let bestOver: PredictedQuantizerSchedule | undefined;
      let fallback: PredictedQuantizerSchedule = {
        quantizers: [...packedQuantizers],
        predictedBytes: totalActualBytes,
      };
      let fallbackError = Math.abs(Math.log(totalActualBytes / nextTargetBytes));
      for (const offset of new Set([0, idealOffset - 1, idealOffset, idealOffset + 1])) {
        const candidateQuantizers = Array.from(packedQuantizers, (value) =>
          clampQuantizer(value + offset),
        );
        const candidatePrediction = actualBytes.reduce((total, bytes, index) => {
          const before = packedQuantizers[index];
          const after = candidateQuantizers[index];
          if (before === undefined || after === undefined) {
            throw new InputError('H.264 candidate quantizer schedule is incomplete');
          }
          return total + bytes * 2 ** ((before - after) / H264_QP_PER_SIZE_DOUBLING);
        }, 0);
        const error = Math.abs(Math.log(candidatePrediction / nextTargetBytes));
        if (error < fallbackError) {
          fallback = { quantizers: candidateQuantizers, predictedBytes: candidatePrediction };
          fallbackError = error;
        }
        const schedule = { quantizers: candidateQuantizers, predictedBytes: candidatePrediction };
        if (
          candidatePrediction <= nextTargetBytes &&
          (bestUnder === undefined || candidatePrediction > bestUnder.predictedBytes)
        ) {
          bestUnder = schedule;
        } else if (
          candidatePrediction > nextTargetBytes &&
          (bestOver === undefined || candidatePrediction < bestOver.predictedBytes)
        ) {
          bestOver = schedule;
        }
      }
      // The next target is a hard candidate-spool ceiling. Prefer the closest modeled schedule that
      // stays at or below it; the fallback exists only for QP-clamped schedules where no inspected
      // offset can mathematically fit.
      const selected =
        bestUnder === undefined
          ? fallback
          : bestOver === undefined
            ? bestUnder
            : interpolateQuantizerSchedules(
                actualBytes,
                packedQuantizers,
                nextTargetBytes,
                bestUnder,
                bestOver,
              );
      return createPlan(
        timeline,
        firstPassBytes,
        nextTargetBytes,
        Math.round(selected.predictedBytes),
        selected.quantizers,
      );
    },
  };
}

/** Build the timestamp-exact second-pass H.264 quantizer schedule from a real fixed-QP first pass. */
export function planH264TwoPass(
  firstPass: readonly H264FirstPassSample[],
  targetBitrate: number,
  declaredDurationSec?: number,
): H264TwoPassPlan {
  if (!Number.isSafeInteger(targetBitrate) || targetBitrate <= 0) {
    throw new InputError('H.264 two-pass bitrate must be a positive safe integer');
  }
  const timeline = normalizeTimeline(firstPass, declaredDurationSec);
  const targetBytes = Math.floor(
    (targetBitrate * timeline.durationUs) / (BITS_PER_BYTE * MICROS_PER_SECOND),
  );
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new InputError('H.264 two-pass target byte budget is not representable');
  }
  const firstPassBytes = timeline.samples.reduce((total, sample) => total + sample.byteLength, 0);
  if (!Number.isSafeInteger(firstPassBytes) || firstPassBytes <= 0) {
    throw new InputError('H.264 two-pass first-pass size is not representable');
  }

  const weights = timeline.samples.map(
    (sample) =>
      sample.durationUs *
      (sample.byteLength / sample.durationUs) ** COMPLEXITY_EXPONENT *
      (sample.keyFrame ? KEYFRAME_WEIGHT : 1),
  );
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  positiveFinite(totalWeight, 'H.264 two-pass complexity weight');
  const rawQuantizers = timeline.samples.map((sample, index) => {
    const weight = weights[index];
    if (weight === undefined || weight <= 0) {
      throw new InputError('H.264 two-pass picture has no complexity weight');
    }
    const allocatedBytes = (targetBytes * weight) / totalWeight;
    const sizeRatio = sample.byteLength / allocatedBytes;
    return clampQuantizer(
      H264_FIRST_PASS_QUANTIZER + H264_QP_PER_SIZE_DOUBLING * Math.log2(sizeRatio),
    );
  });
  const quantizers = calibrateQuantizers(timeline.samples, rawQuantizers, targetBytes);
  const predictedBytes = Math.round(predictedBytesForQuantizers(timeline.samples, quantizers));
  return createPlan(timeline, firstPassBytes, targetBytes, predictedBytes, quantizers);
}
