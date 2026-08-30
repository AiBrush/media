/** Normalize clockwise-positive display rotation to the canonical [0, 360) degree interval. */
export function normalizeClockwiseRotation(rotation: number | undefined): number | undefined {
  if (rotation === undefined || !Number.isFinite(rotation)) return undefined;
  const normalized = ((rotation % 360) + 360) % 360;
  return Object.is(normalized, -0) || Math.abs(normalized) < 1e-10 ? 0 : normalized;
}

/**
 * Compose clockwise rotations into a single canonical angle (REQUIREMENTS §5.4 — rotation never
 * double-applied). Physical pixels are rotated once; the container's logical `rotation` metadata must
 * not repeat that same transform. Summing normalized angles and re-normalizing guarantees that a
 * 90° source display matrix plus an explicit 90° user `rotate` filter yields 180° exactly once, and
 * that a 90° decode-time physical rotation plus a preserved 90° mux metadata would be detected as
 * double-apply (360°→0) and corrected.
 *
 * Returns `undefined` for the identity (0) so callers that store `rotation?: number` can distinguish
 * "no display matrix" from "explicit 0°".
 */
export function composeClockwiseRotations(
  ...rotations: readonly (number | undefined)[]
): number | undefined {
  let sum = 0;
  let has = false;
  for (const r of rotations) {
    const n = normalizeClockwiseRotation(r);
    if (n === undefined || n === 0) continue;
    // enforce quarter-turn granularity (engine only supports 0/90/180/270 physical)
    if (n % 90 !== 0) throw new RangeError(`composeClockwiseRotations: non-quarter-turn ${r}`);
    sum = (sum + n) % 360;
    has = true;
  }
  if (!has) return undefined;
  const out = normalizeClockwiseRotation(sum);
  return out === 0 ? undefined : out;
}

/** True when a rotation is the identity (no display transform). */
export function isIdentityRotation(rotation: number | undefined): boolean {
  const n = normalizeClockwiseRotation(rotation);
  return n === undefined || n === 0;
}

/**
 * Resolve the physical pixel rotation vs logical metadata for a transcode pipeline.
 * Decoded frames are already presentation-oriented (`applyDecodedDisplayRotation` baked the source
 * `rotation` into pixels). The mux must therefore NOT preserve that same source rotation as metadata,
 * otherwise a player would rotate the already-rotated pixels a second time. The only metadata that may
 * be written is the user-requested `targetRotation` (composed with source if the physical step was
 * skipped, e.g. stream-copy).
 */
export function resolveMuxRotation(params: {
  readonly sourceRotation: number | undefined;
  readonly decodedFramesArePresentationOriented: boolean;
  readonly targetRotation: number | undefined;
}): number | undefined {
  const src = normalizeClockwiseRotation(params.sourceRotation);
  const tgt = normalizeClockwiseRotation(params.targetRotation);
  if (params.decodedFramesArePresentationOriented) {
    // Source already baked; only the explicit target remains as logical metadata.
    return tgt === 0 ? undefined : tgt;
  }
  // Stream-copy / no-decode path: preserve composed source+target logically.
  return composeClockwiseRotations(src, tgt);
}

/** Matroska ProjectionPoseRoll is counter-clockwise-positive and constrained to [-180, 180]. */
export function matroskaRollFromClockwise(rotation: number | undefined): number | undefined {
  const clockwise = normalizeClockwiseRotation(rotation);
  if (clockwise === undefined) return undefined;
  const counterClockwise = -clockwise;
  return counterClockwise < -180 ? counterClockwise + 360 : counterClockwise;
}

/** Convert Matroska's counter-clockwise ProjectionPoseRoll back to the engine's clockwise convention. */
export function clockwiseFromMatroskaRoll(roll: number): number | undefined {
  if (!Number.isFinite(roll) || roll < -180 || roll > 180) return undefined;
  return normalizeClockwiseRotation(-roll);
}
