/**
 * Pure validation, accounting, sampling, objective-quality, and bounded-candidate helpers for the
 * replay-backed H.264 quality-constrained encode path. This module never opens a Source itself.
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../sources/abort.ts';
import { type Source, isSource } from '../sources/source.ts';
import { validateVideoTarget } from './job-schema-targets.ts';
import type { VideoTarget } from './types.ts';

const DEFAULT_VIDEO_QUALITY_SAMPLES = 8;
const MAX_VIDEO_QUALITY_SAMPLES = 256;
const BITS_PER_BYTE_MICROSECOND = 8_000_000n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/** Absolute compressed-candidate spool ceiling for the browser-only in-memory quality path. */
export const H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES = 128 * 1024 * 1024;
/**
 * Aggregate compressed-payload ceiling while the closed loop compares a retained feasible fallback with
 * one fresh private candidate. The runner retains no other candidate spools, so two individually bounded
 * spools are the whole compressed-candidate working set.
 */
export const H264_QUALITY_MAX_IN_MEMORY_AGGREGATE_CANDIDATE_BYTES =
  2 * H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES;
/**
 * Absolute per-picture objective-audit ceiling. SSIM holds two tight RGBA copies plus two Float64 luma
 * planes, so this power-of-two pixel bound caps that working set independently of authored dimensions.
 */
export const H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS = 4_194_304;

export interface H264QualityConstraintRequest {
  readonly bitrate: number;
  readonly maxAverageBitrate: number;
  readonly quality: {
    readonly metric: 'ssim-luma-v1';
    readonly minimumMean: number;
    readonly samples: number;
  };
}

export interface TightRgbaImage {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Validate a direct-call quality request before any source read. Non-quality targets return undefined.
 * The initially supported mode is deliberately atomic: explicit H.264 codec, preferred rate, hard
 * average-rate ceiling, objective-quality threshold, and a known finite replayable byte source.
 */
export function assertH264QualityConstraintPreflight(
  target: VideoTarget,
  source: Source,
): H264QualityConstraintRequest | undefined {
  const validated = validateVideoTarget(target, 'video target');
  if (validated.maxAverageBitrate === undefined && validated.quality === undefined)
    return undefined;

  if (validated.codec === undefined) {
    throw new InputError('H.264 quality-constrained encode requires explicit codec h264');
  }
  if (validated.codec !== 'h264') {
    throw new CapabilityError(
      `quality-constrained encode is initially supported only for H.264, not ${validated.codec}`,
      {
        op: {
          kind: 'route',
          id: 'quality-constrained-video',
          facts: { codec: validated.codec },
        },
        tried: [],
        suggestion: 'request codec h264 or omit the quality-constrained rate tuple',
      },
    );
  }
  if (!isSource(source) || typeof source.stream !== 'function') {
    throw new InputError('H.264 quality-constrained encode requires a normalized Source');
  }
  if (source.kind === 'stream') {
    throw new CapabilityError(
      'H.264 quality-constrained encode requires a replayable Source, not a one-shot stream',
      {
        op: {
          kind: 'route',
          id: 'quality-constrained-h264',
          facts: { sourceKind: source.kind, replayable: false },
        },
        tried: [],
        suggestion: 'provide bytes, Blob, URL, or OPFS input that can be replayed',
      },
    );
  }
  if (source.size === undefined) {
    throw new CapabilityError(
      'H.264 quality-constrained encode requires the finite Source size to be known before encoding',
      {
        op: {
          kind: 'route',
          id: 'quality-constrained-h264',
          facts: { sourceKind: source.kind, knownSize: false },
        },
        tried: [],
        suggestion: 'provide a replayable Source with its exact byte size',
      },
    );
  }
  if (!Number.isSafeInteger(source.size) || source.size <= 0) {
    throw new InputError(
      'H.264 quality-constrained encode requires a known finite nonempty Source size',
    );
  }

  const bitrate = validated.bitrate;
  const maxAverageBitrate = validated.maxAverageBitrate;
  const quality = validated.quality;
  // validateVideoTarget proves the atomic tuple before source metadata is inspected.
  if (bitrate === undefined || maxAverageBitrate === undefined || quality === undefined) {
    throw new InputError(
      'H.264 quality-constrained encode requires bitrate, maxAverageBitrate, and quality',
    );
  }
  return {
    bitrate,
    maxAverageBitrate,
    quality: {
      metric: quality.metric,
      minimumMean: quality.minimumMean,
      samples: quality.samples ?? DEFAULT_VIDEO_QUALITY_SAMPLES,
    },
  };
}

/** Exact floor(rate × duration / 8,000,000), with integer inputs and result kept lossless in JS. */
export function averageBitrateByteBudget(rate: number, durationUs: number): number {
  positiveSafeInteger(rate, 'average bitrate');
  positiveSafeInteger(durationUs, 'presentation duration');
  const budget = (BigInt(rate) * BigInt(durationUs)) / BITS_PER_BYTE_MICROSECOND;
  if (budget > MAX_SAFE_INTEGER_BIGINT) {
    throw new InputError('average bitrate byte budget exceeds safe integer accounting');
  }
  return Number(budget);
}

/** Reject an authored rate/duration budget that cannot be retained within the operational spool cap. */
export function assertH264QualityCandidateMemoryLimit(maxBytes: number): void {
  nonNegativeSafeInteger(maxBytes, 'candidate byte cap');
  if (maxBytes <= H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES) return;
  throw new CapabilityError('H.264 quality candidate exceeds the in-memory spool limit', {
    op: {
      kind: 'route',
      id: 'h264-quality-candidate-spool',
      facts: {
        candidateByteCap: maxBytes,
        maximumCandidateBytes: H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
      },
    },
    tried: ['in-memory-compressed-candidate'],
    suggestion:
      'use a shorter source, lower maxAverageBitrate, or an encode mode without quality replay',
  });
}

/** Reject an SSIM picture before allocating either its tight RGBA copy or its Float64 luma evidence. */
export function assertH264QualityObjectiveAuditPixelLimit(width: number, height: number): void {
  positiveSafeInteger(width, 'objective-audit picture width');
  positiveSafeInteger(height, 'objective-audit picture height');
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    throw new InputError('objective-audit picture dimensions exceed safe integer accounting');
  }
  if (pixelCount <= H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS) return;
  throw new CapabilityError('H.264 objective-quality picture exceeds the in-memory audit limit', {
    op: {
      kind: 'route',
      id: 'h264-quality-objective-audit',
      facts: {
        width,
        height,
        pixelCount,
        maximumPixelCount: H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS,
      },
    },
    tried: ['in-memory-ssim-luma-v1'],
    suggestion: 'use smaller output dimensions or omit the objective-quality constraint',
  });
}

/**
 * Pick real, unique PTS values nearest uniformly spaced presentation-time targets. One requested sample
 * selects the timeline midpoint; two or more always include both presentation endpoints.
 */
export function uniformQualitySampleTimestamps(
  timestamps: ArrayLike<number>,
  samples: number,
): readonly number[] {
  positiveSafeInteger(samples, 'quality sample count');
  if (samples > MAX_VIDEO_QUALITY_SAMPLES) {
    throw new InputError(`quality sample count must be in [1, ${MAX_VIDEO_QUALITY_SAMPLES}]`);
  }
  if (
    (typeof timestamps !== 'object' && typeof timestamps !== 'function') ||
    timestamps === null ||
    !Number.isSafeInteger(timestamps.length) ||
    timestamps.length < 0
  ) {
    throw new InputError('quality timestamps must be an array-like sequence');
  }

  const ordered: number[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const timestamp = timestamps[index];
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new InputError('quality timestamps must be non-negative safe integers');
    }
    ordered.push(timestamp);
  }
  ordered.sort((a, b) => a - b);
  const unique = ordered.filter(
    (timestamp, index) => index === 0 || timestamp !== ordered[index - 1],
  );
  if (unique.length === 0) return [];
  if (samples >= unique.length) return unique;

  const first = unique[0];
  const last = unique.at(-1);
  if (first === undefined || last === undefined) return [];
  if (samples === 1) {
    const index = nearestTimestampIndex(unique, first + (last - first) / 2, 0, unique.length - 1);
    const timestamp = unique[index];
    if (timestamp === undefined) throw new InputError('quality timestamp selection failed');
    return [timestamp];
  }

  const selected = [first];
  let previousIndex = 0;
  for (let slot = 1; slot < samples - 1; slot++) {
    const lowerIndex = previousIndex + 1;
    const upperIndex = unique.length - samples + slot;
    const ratio = slot / (samples - 1);
    const target = first + (last - first) * ratio;
    const index = nearestTimestampIndex(unique, target, lowerIndex, upperIndex);
    const timestamp = unique[index];
    if (timestamp === undefined) throw new InputError('quality timestamp selection failed');
    selected.push(timestamp);
    previousIndex = index;
  }
  selected.push(last);
  return selected;
}

/** Media-test-compatible Rec.601-luma, non-overlapping 8×8-window MSSIM (version 1). */
export function ssimLumaV1(a: TightRgbaImage, b: TightRgbaImage): number {
  assertTightRgbaImage(a, 'first SSIM image');
  assertTightRgbaImage(b, 'second SSIM image');
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const lumaA = lumaPlane(a, width, height);
  const lumaB = lumaPlane(b, width, height);

  const dynamicRange = 255;
  const c1 = (0.01 * dynamicRange) ** 2;
  const c2 = (0.03 * dynamicRange) ** 2;
  const windowSize = 8;
  let sum = 0;
  let count = 0;

  for (let blockY = 0; blockY + windowSize <= height; blockY += windowSize) {
    for (let blockX = 0; blockX + windowSize <= width; blockX += windowSize) {
      let sumA = 0;
      let sumB = 0;
      let squareSumA = 0;
      let squareSumB = 0;
      let productSum = 0;
      const sampleCount = windowSize * windowSize;
      for (let y = 0; y < windowSize; y++) {
        const row = (blockY + y) * width + blockX;
        for (let x = 0; x < windowSize; x++) {
          const valueA = lumaA[row + x] ?? 0;
          const valueB = lumaB[row + x] ?? 0;
          sumA += valueA;
          sumB += valueB;
          squareSumA += valueA * valueA;
          squareSumB += valueB * valueB;
          productSum += valueA * valueB;
        }
      }
      sum += ssimFromMoments(sumA, sumB, squareSumA, squareSumB, productSum, sampleCount, c1, c2);
      count++;
    }
  }

  if (count === 0) return globalSsim(lumaA, lumaB, c1, c2);
  let score = sum / count;
  if (a.width !== b.width || a.height !== b.height) {
    const comparedArea = width * height;
    score *= comparedArea / Math.max(a.width * a.height, b.width * b.height);
  }
  return clamp01(score);
}

/**
 * Drain a candidate stream while retaining it only if its exact payload stays within maxBytes.
 * Crossing the cap drops all retained references permanently but continues draining for exact accounting.
 */
export async function collectBoundedCandidateChunks<T extends { readonly byteLength: number }>(
  stream: ReadableStream<T>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly byteLength: number; readonly chunks: readonly T[] | undefined }> {
  assertH264QualityCandidateMemoryLimit(maxBytes);
  const reader = stream.getReader();
  let chunks: T[] | undefined = [];
  let byteLength = 0;
  try {
    throwIfSourceAborted(signal);
    for (;;) {
      const result = await raceAbort(reader.read(), signal);
      if (result.done) {
        throwIfSourceAborted(signal);
        return { byteLength, chunks };
      }
      const chunk = result.value;
      if (typeof chunk !== 'object' || chunk === null) {
        throw new InputError('candidate stream emitted a non-object chunk');
      }
      const chunkByteLength = chunk.byteLength;
      nonNegativeSafeInteger(chunkByteLength, 'candidate chunk byte length');
      if (chunkByteLength > Number.MAX_SAFE_INTEGER - byteLength) {
        throw new InputError('candidate byte total exceeds safe integer accounting');
      }
      byteLength += chunkByteLength;
      if (chunks !== undefined) {
        if (byteLength <= maxBytes) {
          chunks.push(chunk);
        } else {
          chunks.length = 0;
          chunks = undefined;
        }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function positiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${label} must be a positive safe integer`);
  }
}

function nonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(`${label} must be a non-negative safe integer`);
  }
}

function nearestTimestampIndex(
  timestamps: readonly number[],
  target: number,
  lowerIndex: number,
  upperIndex: number,
): number {
  let low = lowerIndex;
  let high = upperIndex;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((timestamps[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  const later = low;
  const earlier = Math.max(lowerIndex, later - 1);
  const earlierTimestamp = timestamps[earlier];
  const laterTimestamp = timestamps[later];
  if (earlierTimestamp === undefined || laterTimestamp === undefined) {
    throw new InputError('quality timestamp selection bounds are invalid');
  }
  return target - earlierTimestamp <= laterTimestamp - target ? earlier : later;
}

function assertTightRgbaImage(value: TightRgbaImage, label: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new InputError(`${label} must be an RGBA byte image`);
  }
  positiveSafeInteger(value.width, `${label} width`);
  positiveSafeInteger(value.height, `${label} height`);
  assertH264QualityObjectiveAuditPixelLimit(value.width, value.height);
  if (!(value.data instanceof Uint8Array) && !(value.data instanceof Uint8ClampedArray)) {
    throw new InputError(`${label} data must be an RGBA byte array`);
  }
  const pixelCount = value.width * value.height;
  const expectedLength = pixelCount * 4;
  if (!Number.isSafeInteger(pixelCount) || !Number.isSafeInteger(expectedLength)) {
    throw new InputError(`${label} dimensions exceed safe integer accounting`);
  }
  if (value.data.byteLength !== expectedLength) {
    throw new InputError(`${label} data must be tightly packed RGBA`);
  }
}

function lumaPlane(image: TightRgbaImage, width: number, height: number): Float64Array {
  const result = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgbaIndex = (y * image.width + x) * 4;
      result[y * width + x] =
        0.299 * (image.data[rgbaIndex] ?? 0) +
        0.587 * (image.data[rgbaIndex + 1] ?? 0) +
        0.114 * (image.data[rgbaIndex + 2] ?? 0);
    }
  }
  return result;
}

function globalSsim(a: Float64Array, b: Float64Array, c1: number, c2: number): number {
  let sumA = 0;
  let sumB = 0;
  let squareSumA = 0;
  let squareSumB = 0;
  let productSum = 0;
  for (let index = 0; index < a.length; index++) {
    const valueA = a[index] ?? 0;
    const valueB = b[index] ?? 0;
    sumA += valueA;
    sumB += valueB;
    squareSumA += valueA * valueA;
    squareSumB += valueB * valueB;
    productSum += valueA * valueB;
  }
  return clamp01(ssimFromMoments(sumA, sumB, squareSumA, squareSumB, productSum, a.length, c1, c2));
}

function ssimFromMoments(
  sumA: number,
  sumB: number,
  squareSumA: number,
  squareSumB: number,
  productSum: number,
  count: number,
  c1: number,
  c2: number,
): number {
  const meanA = sumA / count;
  const meanB = sumB / count;
  const varianceA = squareSumA / count - meanA * meanA;
  const varianceB = squareSumB / count - meanB * meanB;
  const covariance = productSum / count - meanA * meanB;
  return (
    ((2 * meanA * meanB + c1) * (2 * covariance + c2)) /
    ((meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2))
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
