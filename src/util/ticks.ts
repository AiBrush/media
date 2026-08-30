/**
 * Rational tick utilities — REQUIREMENTS §7.4.
 * Media time is overflow-safe integer ticks plus an explicit timescale.
 * Float seconds are convenience only; authoritative conversions use exact integer
 * arithmetic (bigint) with half-away-from-zero rounding and drift-free cumulative
 * semantics.
 */

import { MediaError } from '../contracts/errors.ts';

const MICROS_PER_SECOND_BIG = 1_000_000n;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new MediaError('demux-error', 'denominator must be >0');
  // Match Math.round semantics: floor(num/den + 0.5) for positive, ceil(num/den - 0.5) for negative is not
  // exactly Math.round; we want half-away-from-zero for negative edit offsets. Use sign-aware half.
  const half = den / 2n;
  return num >= 0n ? (num + half) / den : (num - half) / den;
}

/** Convert microseconds to timescale ticks, half-away-from-zero, overflow-checked. */
export function usToTicks(us: number, timescale: number): number {
  if (!Number.isFinite(us) || !Number.isSafeInteger(timescale) || timescale <= 0) {
    throw new MediaError(
      'demux-error',
      `usToTicks: us=${us} timescale=${timescale} must be finite with safe-integer timescale>0`,
    );
  }
  if (Number.isSafeInteger(us)) {
    const r = divRoundHalfUp(BigInt(us) * BigInt(timescale), MICROS_PER_SECOND_BIG);
    if (r > MAX_SAFE_BIG || r < -MAX_SAFE_BIG)
      throw new MediaError(
        'demux-error',
        `usToTicks overflow: ${us} * ${timescale} / 1e6 exceeds MAX_SAFE_INTEGER`,
      );
    return Number(r);
  }
  // Fractional microseconds (e.g., derived sample durations) — fall back to float half-up.
  return Math.round((us * timescale) / 1_000_000);
}

/** Convert ticks to microseconds, half-away-from-zero, overflow-checked. */
export function ticksToUs(ticks: number, timescale: number): number {
  if (!Number.isSafeInteger(ticks) || !Number.isSafeInteger(timescale) || timescale <= 0) {
    throw new MediaError(
      'demux-error',
      `ticksToUs: ticks=${ticks} timescale=${timescale} must be safe integers with timescale>0`,
    );
  }
  const r = divRoundHalfUp(BigInt(ticks) * MICROS_PER_SECOND_BIG, BigInt(timescale));
  if (r > MAX_SAFE_BIG || r < -MAX_SAFE_BIG)
    throw new MediaError('demux-error', 'ticksToUs overflow');
  return Number(r);
}

/** Duration ticks from sample count: ticks = samples * timescale / sampleRate (exact, half-up). */
export function samplesToTicks(samples: number, timescale: number, sampleRate: number): number {
  if (
    !Number.isSafeInteger(samples) ||
    !Number.isSafeInteger(timescale) ||
    !Number.isSafeInteger(sampleRate) ||
    timescale <= 0 ||
    sampleRate <= 0
  ) {
    throw new MediaError('demux-error', 'samplesToTicks: invalid args');
  }
  const r = divRoundHalfUp(BigInt(samples) * BigInt(timescale), BigInt(sampleRate));
  if (r > MAX_SAFE_BIG || r < -MAX_SAFE_BIG)
    throw new MediaError('demux-error', 'samplesToTicks overflow');
  return Number(r);
}

/** Ticks to sample count: samples = ticks * sampleRate / timescale (exact, half-up). */
export function ticksToSamples(ticks: number, timescale: number, sampleRate: number): number {
  if (
    !Number.isSafeInteger(ticks) ||
    !Number.isSafeInteger(timescale) ||
    !Number.isSafeInteger(sampleRate) ||
    timescale <= 0 ||
    sampleRate <= 0
  ) {
    throw new MediaError('demux-error', 'ticksToSamples: invalid args');
  }
  const r = divRoundHalfUp(BigInt(ticks) * BigInt(sampleRate), BigInt(timescale));
  if (r > MAX_SAFE_BIG || r < -MAX_SAFE_BIG)
    throw new MediaError('demux-error', 'ticksToSamples overflow');
  return Number(r);
}

/**
 * Cumulative drift-free conversion: each timestamp is `sum(durationTicks[0..i-1])` converted once.
 * This avoids the drift that accumulates when converting each float `seconds` independently.
 */
export function cumulativeUsFromDurations(
  durationsTicks: readonly number[],
  timescale: number,
): number[] {
  const out: number[] = [];
  let acc = 0n;
  const ts = BigInt(timescale);
  for (const d of durationsTicks) {
    // d is already ticks; acc is sum so far
    const us = divRoundHalfUp(acc * MICROS_PER_SECOND_BIG, ts);
    out.push(Number(us));
    acc += BigInt(d);
  }
  return out;
}

/** BigInt variants for >2^53 paths (public boundary bigint). */
export function usToTicksBigInt(us: bigint, timescale: bigint): bigint {
  if (timescale <= 0n) throw new MediaError('demux-error', 'timescale must be >0');
  return divRoundHalfUp(us * timescale, MICROS_PER_SECOND_BIG);
}
export function ticksToUsBigInt(ticks: bigint, timescale: bigint): bigint {
  if (timescale <= 0n) throw new MediaError('demux-error', 'timescale must be >0');
  return divRoundHalfUp(ticks * MICROS_PER_SECOND_BIG, timescale);
}
