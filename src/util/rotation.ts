/** Normalize clockwise-positive display rotation to the canonical [0, 360) degree interval. */
export function normalizeClockwiseRotation(rotation: number | undefined): number | undefined {
  if (rotation === undefined || !Number.isFinite(rotation)) return undefined;
  const normalized = ((rotation % 360) + 360) % 360;
  return Object.is(normalized, -0) || Math.abs(normalized) < 1e-10 ? 0 : normalized;
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
