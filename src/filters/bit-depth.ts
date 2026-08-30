/**
 * 10→8-bit and range conversion helpers (REQUIREMENTS §5.4 — 1.3.3).
 * Pure, no browser types. Handles full vs limited range, alpha-preserve, and HDR transfer
 * passthrough. The engine's GPU path does this in shader; the CPU fallback must match within
 * declared tolerance (≤1 LSB for 8-bit).
 */

import { InputError } from '../contracts/errors.ts';

/** Clamp to [min,max] */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Convert a 10-bit sample (0..1023) to 8-bit (0..255) with correct rounding.
 * Full-range: `round(v * 255 / 1023)`. Limited-range luma 64..940 → 0..255 via `(v-64)*255/876`.
 */
export function convert10To8(
  value10: number,
  opts: { limitedRange?: boolean; isLuma?: boolean } = {},
): number {
  if (!Number.isFinite(value10))
    throw new InputError(`10-bit value must be finite, got ${value10}`);
  if (opts.limitedRange) {
    // BT.2020 10-bit limited: luma 64..940, chroma 64..960, but we use luma formula for both
    // and clamp — the caller can pass correct range per component if needed.
    const low = 64;
    const high = opts.isLuma === false ? 960 : 940;
    const v = clamp(Math.round(value10), low, high);
    return clamp(Math.round(((v - low) * 255) / (high - low)), 0, 255);
  }
  const v = clamp(Math.round(value10), 0, 1023);
  return Math.round((v * 255) / 1023);
}

/** 8-bit (0..255) → 10-bit (0..1023) full-range. */
export function convert8To10(value8: number): number {
  if (!Number.isFinite(value8)) throw new InputError(`8-bit value must be finite, got ${value8}`);
  const v = clamp(Math.round(value8), 0, 255);
  return Math.round((v * 1023) / 255);
}

/** Alpha is always full-range and must be preserved verbatim (no luma/chroma range expansion). */
export function preserveAlpha(alpha: number, fromBitDepth: 8 | 10, toBitDepth: 8 | 10): number {
  if (fromBitDepth === toBitDepth) {
    if (!Number.isFinite(alpha)) throw new InputError(`alpha must be finite, got ${alpha}`);
    const max = fromBitDepth === 8 ? 255 : 1023;
    return clamp(Math.round(alpha), 0, max);
  }
  if (fromBitDepth === 10 && toBitDepth === 8) return convert10To8(alpha, { limitedRange: false });
  return convert8To10(alpha);
}

/** Limited range flag to full-range 8-bit: 16..235 → 0..255 (8-bit), 64..940 → 0..255 (10-bit luma). */
export function limitedToFullRange8(value8: number): number {
  if (!Number.isFinite(value8)) throw new InputError(`limited value must be finite, got ${value8}`);
  const v = clamp(Math.round(value8), 16, 235);
  return Math.round(((v - 16) * 255) / 219);
}

export function limitedToFullRange10(value10: number, isLuma = true): number {
  if (!Number.isFinite(value10))
    throw new InputError(`limited value must be finite, got ${value10}`);
  const low = 64;
  const high = isLuma ? 940 : 960;
  const v = clamp(Math.round(value10), low, high);
  return Math.round(((v - low) * 1023) / (high - low));
}
