/**
 * Structured warnings for rate-control downgrades (REQUIREMENTS §5.5 — 2.2.2).
 *
 * Every requested control MUST be applied, explicitly downgraded with a structured warning, or
 * rejected before expensive work. This module is the single source for downgrade warnings:
 * - H.264 Main/High → Constrained Baseline profile fallback (implicit inherited profile)
 * - implicit bitrate warmup injection (native ABR priming)
 * - quality-constrained preferred-rate overshoot (averageBitrate > preferredAverageBitrate)
 *
 * Warnings are `LogEvent` with `level:'warn'` so `createMedia({onLog})` can surface them without
 * throwing, while the returned `detail.code` remains machine-readable for tests.
 */

import type { LogEvent } from './types.ts';

export type RateControlWarningCode =
  | 'h264-profile-fallback'
  | 'h264-warmup-injected'
  | 'h264-quality-rate-overshoot';

export interface RateControlWarningDetail {
  readonly code: RateControlWarningCode;
  readonly originalCodec?: string;
  readonly fallbackCodec?: string;
  readonly sourceCodec?: string;
  readonly warmupFrames?: number;
  readonly preferredAverageBitrate?: number;
  readonly averageBitrate?: number;
  readonly maxAverageBitrate?: number;
  readonly codec?: string;
}

/**
 * H.264 profile fallback warning: Main/High inherited from source was downgraded to
 * Constrained Baseline for broadest hardware decode coverage.
 */
export function h264ProfileFallbackWarning(
  originalCodec: string,
  fallbackCodec: string,
  sourceCodecString: string | undefined,
): LogEvent {
  return {
    level: 'warn',
    message: `H.264 profile downgraded from ${originalCodec} to ${fallbackCodec} for hardware compatibility`,
    detail: {
      code: 'h264-profile-fallback' as const,
      originalCodec,
      fallbackCodec,
      ...(sourceCodecString === undefined ? {} : { sourceCodec: sourceCodecString }),
    } satisfies RateControlWarningDetail,
  };
}

/**
 * Warmup frames injected for native ABR rate-control priming.
 */
export function h264WarmupWarning(
  codec: string,
  warmupFrames: number,
  frameRate: number | undefined,
): LogEvent {
  return {
    level: 'warn',
    message: `Injected ${warmupFrames} warmup frames for ${codec} rate-control priming`,
    detail: {
      code: 'h264-warmup-injected' as const,
      codec,
      warmupFrames,
      ...(frameRate === undefined ? {} : { warmupFrames, codec }),
    } satisfies RateControlWarningDetail,
  };
}

/**
 * Quality-constrained rate overshoot: the feasible candidate's average bitrate exceeds the
 * preferred average but stays within the hard ceiling to satisfy the quality floor.
 */
export function h264QualityOvershootWarning(
  preferredAverageBitrate: number,
  averageBitrate: number,
  maxAverageBitrate: number,
): LogEvent {
  return {
    level: 'warn',
    message: `Quality floor required average bitrate ${averageBitrate} exceeding preferred ${preferredAverageBitrate} (ceiling ${maxAverageBitrate})`,
    detail: {
      code: 'h264-quality-rate-overshoot' as const,
      preferredAverageBitrate,
      averageBitrate,
      maxAverageBitrate,
    } satisfies RateControlWarningDetail,
  };
}

/**
 * Pure helper: should a quality overshoot warning be emitted?
 */
export function shouldWarnQualityOvershoot(
  preferredAverageBitrate: number,
  averageBitrate: number,
): boolean {
  return averageBitrate > preferredAverageBitrate;
}
