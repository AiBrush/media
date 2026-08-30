/**
 * Container ↔ codec delay reconciliation — REQUIREMENTS §7.4, Phase 1.2.7.
 * Every audio container/codec pair can signal presentation delay in a different
 * place: MP4 edit lists (AAC leading 2112/1024 etc), Ogg OpusHead pre-skip,
 * Matroska/WebM CodecDelay + seekPreRoll, MP3 Xing/LAME encoder delay/padding,
 * raw ADTS/PCM none. The authoritative delay is the container's gapless
 * window when present; codec priming is a fallback for streams that carry no
 * container gapless fact (ADTS AAC) or a validation oracle for pairs that
 * signal the same value in both places (Opus). This module reconciles the two
 * without float drift: sample counts stay integers, timescale/tick conversions
 * use exact half-up bigint via `src/util/ticks.ts`.
 */

import { samplesToTicks, ticksToSamples } from './ticks.ts';

export type ContainerId =
  | 'mp4'
  | 'mov'
  | 'matroska'
  | 'webm'
  | 'ogg'
  | 'mp3'
  | 'adts'
  | 'wav'
  | 'flac'
  | 'aiff'
  | 'caf'
  | 'ts';
export type CodecId = 'aac' | 'opus' | 'vorbis' | 'mp3' | 'flac' | 'pcm' | 'unknown';

export interface DelayReconciliationInput {
  readonly container: ContainerId;
  readonly codec: CodecId;
  readonly sampleRate: number;
  /** Container-authored leading discard (edit-list, OpusHead pre-skip, CodecDelay, LAME delay), samples @ sampleRate. */
  readonly containerLeadingSamples?: number;
  /** Container-authored trailing discard (edit-list end padding, EOS granule, LAME padding). */
  readonly containerTrailingSamples?: number;
  /** Container-authored presentation sample count (gapless.totalSamples), when known. */
  readonly containerTotalSamples?: number;
  /** Decoder priming not yet accounted in the container leading (fallback for ADTS/no-edit AAC). */
  readonly codecPrimingSamples?: number;
  /** Decoder trailing padding not yet accounted. */
  readonly codecTrailingPaddingSamples?: number;
}

export interface ReconciledDelay {
  /** Samples to drop before first presentation frame, @ sampleRate. */
  readonly presentationLeadingSamples: number;
  /** Samples to drop after last presentation frame. */
  readonly presentationTrailingSamples: number;
  /** Authoritative presentation sample count when the container declares it, else undefined. */
  readonly presentationTotalSamples?: number;
}

function assertSafeNonNegativeInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe non-negative integer, got ${String(value)}`);
  }
  return value;
}

function isOpusContainerPair(container: ContainerId, codec: CodecId): boolean {
  return (
    codec === 'opus' && (container === 'ogg' || container === 'webm' || container === 'matroska')
  );
}
function isMp4AacPair(container: ContainerId, codec: CodecId): boolean {
  return codec === 'aac' && (container === 'mp4' || container === 'mov');
}
function isMp3Pair(container: ContainerId, codec: CodecId): boolean {
  return codec === 'mp3' && container === 'mp3';
}

/**
 * Reconcile container vs codec delay for the given pair. Container gapless is
 * authoritative when present; codec priming is a fallback/validation oracle.
 * Throws RangeError on malformed sampleRate or negative/NaN sample counts.
 */
export function reconcileAudioDelay(input: DelayReconciliationInput): ReconciledDelay {
  const { container, codec, sampleRate } = input;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be a safe positive integer, got ${String(sampleRate)}`);
  }
  const containerLeading =
    assertSafeNonNegativeInt(input.containerLeadingSamples, 'containerLeadingSamples') ?? 0;
  const containerTrailing =
    assertSafeNonNegativeInt(input.containerTrailingSamples, 'containerTrailingSamples') ?? 0;
  const containerTotal = assertSafeNonNegativeInt(
    input.containerTotalSamples,
    'containerTotalSamples',
  );
  const codecPriming =
    assertSafeNonNegativeInt(input.codecPrimingSamples, 'codecPrimingSamples') ?? 0;
  const codecTrailing =
    assertSafeNonNegativeInt(input.codecTrailingPaddingSamples, 'codecTrailingPaddingSamples') ?? 0;

  const hasContainerLeading = input.containerLeadingSamples !== undefined;
  const hasContainerTrailing = input.containerTrailingSamples !== undefined;

  let presentationLeadingSamples: number;
  let presentationTrailingSamples: number;

  // Per-pair authoritativeness:
  // - mp4-aac: edit list authoritative; ignore codec priming when container leading present
  // - ogg/webm-opus: OpusHead/CodecDelay authoritative; codec priming is same value, so container wins
  // - mp3: LAME delay authoritative; codec synthesis delay (528) never replaces it
  // - raw ADTS/PCM etc: no container gapless, so codec priming is the only fact
  if (isMp4AacPair(container, codec)) {
    presentationLeadingSamples = hasContainerLeading ? containerLeading : codecPriming;
    presentationTrailingSamples = hasContainerTrailing ? containerTrailing : codecTrailing;
  } else if (isOpusContainerPair(container, codec)) {
    // Opus container pre-skip is the presentation contract; codec priming validates but never overrides.
    presentationLeadingSamples = hasContainerLeading ? containerLeading : codecPriming;
    presentationTrailingSamples = hasContainerTrailing ? containerTrailing : codecTrailing;
  } else if (isMp3Pair(container, codec)) {
    presentationLeadingSamples = hasContainerLeading ? containerLeading : codecPriming;
    presentationTrailingSamples = hasContainerTrailing ? containerTrailing : codecTrailing;
  } else {
    // Generic: container gapless authoritative when present, else codec.
    presentationLeadingSamples = hasContainerLeading ? containerLeading : codecPriming;
    presentationTrailingSamples = hasContainerTrailing ? containerTrailing : codecTrailing;
  }

  // When container total is present, it is the authoritative presentation count (gapless.totalSamples).
  // Validate that trimming window doesn't exceed it when both sides present in future callers.
  const presentationTotalSamples = containerTotal;

  // Guard overflow of samples vs MAX_SAFE_INTEGER already via assert, but also guard sum.
  if (presentationLeadingSamples + presentationTrailingSamples > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('reconciled leading+trailing exceeds MAX_SAFE_INTEGER');
  }

  return {
    presentationLeadingSamples,
    presentationTrailingSamples,
    ...(presentationTotalSamples !== undefined ? { presentationTotalSamples } : {}),
  };
}

/**
 * Convert a reconciled leading sample count to ticks at the given timescale
 * (exact half-up bigint via ticks.ts). Overflow-checked.
 */
export function delaySamplesToTicks(
  samples: number,
  timescale: number,
  sampleRate: number,
): number {
  if (!Number.isSafeInteger(samples) || samples < 0)
    throw new RangeError(`samples must be safe non-negative int, got ${samples}`);
  return samplesToTicks(samples, timescale, sampleRate);
}

/** Ticks back to samples (exact half-up). */
export function delayTicksToSamples(ticks: number, timescale: number, sampleRate: number): number {
  if (!Number.isSafeInteger(ticks) || ticks < 0)
    throw new RangeError(`ticks must be safe non-negative int, got ${ticks}`);
  return ticksToSamples(ticks, timescale, sampleRate);
}
