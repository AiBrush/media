/**
 * Exact seek mode helpers (REQUIREMENTS §5.3 — 1.2.6).
 * Pure selection over packet timestamps with B-frame, VFR, open-GOP and edit-list awareness.
 */

import { InputError } from '../contracts/errors.ts';

export type SeekMode = 'keyframe-before' | 'keyframe-after' | 'nearest' | 'exact';

/**
 * A minimal chunk view for pure selection. `timestamp` is PTS (presentation time, µs),
 * `type` marks sync samples. Mirrors `EncodedChunk` but without browser types.
 */
export interface SeekChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
}

/** Validate a seek target is a finite non-negative microsecond time. */
function requireTarget(targetUs: number): void {
  if (!Number.isFinite(targetUs) || targetUs < 0) throw new InputError(`bad seek ${targetUs}`);
}

/** Last keyframe at-or-before target; undefined when no keyframe exists at/before target (open-GOP leading B-frames). */
export function indexOfKeyframeBefore(
  chunks: readonly SeekChunk[],
  targetUs: number,
): number | undefined {
  requireTarget(targetUs);
  let best: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === undefined) continue;
    if (!Number.isFinite(c.timestamp))
      throw new InputError(`seek chunk timestamp must be finite, got ${c.timestamp}`);
    if (c.type === 'key' && c.timestamp <= targetUs) best = i;
  }
  return best;
}

/** First keyframe at-or-after target; undefined when no keyframe at/after. */
export function indexOfKeyframeAfter(
  chunks: readonly SeekChunk[],
  targetUs: number,
): number | undefined {
  requireTarget(targetUs);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === undefined) continue;
    if (!Number.isFinite(c.timestamp))
      throw new InputError(`seek chunk timestamp must be finite, got ${c.timestamp}`);
    if (c.type === 'key' && c.timestamp >= targetUs) return i;
  }
  return undefined;
}

/** Nearest keyframe to target; tie goes to before. Undefined when no keyframes at all. */
export function indexOfNearestKeyframe(
  chunks: readonly SeekChunk[],
  targetUs: number,
): number | undefined {
  requireTarget(targetUs);
  const before = indexOfKeyframeBefore(chunks, targetUs);
  const after = indexOfKeyframeAfter(chunks, targetUs);
  if (before === undefined) return after;
  if (after === undefined) return before;
  const beforeTs = chunks[before]!.timestamp;
  const afterTs = chunks[after]!.timestamp;
  const dBefore = targetUs - beforeTs;
  const dAfter = afterTs - targetUs;
  return dAfter < dBefore ? after : before;
}

/**
 * Exact-seek start index: last keyframe at-or-before target (the GOP head that must be decoded).
 * When no keyframe exists at/before target (open-GOP leading frames), start at the first keyframe
 * (or 0 if no keyframes at all) so the decoder can still produce the target via dependency discard.
 * Returns 0 for empty input (caller will later handle no-frame error).
 */
export function indexOfExactSeekStart(chunks: readonly SeekChunk[], targetUs: number): number {
  requireTarget(targetUs);
  if (chunks.length === 0) return 0;
  const before = indexOfKeyframeBefore(chunks, targetUs);
  if (before !== undefined) return before;
  // open-GOP: no keyframe before target — start at first keyframe if any, else 0
  const firstKey = chunks.findIndex((c) => c.type === 'key');
  return firstKey >= 0 ? firstKey : 0;
}

/** Resolve the GOP start index for a given seek mode. */
export function indexForSeekMode(
  chunks: readonly SeekChunk[],
  targetUs: number,
  mode: SeekMode,
): number | undefined {
  switch (mode) {
    case 'keyframe-before':
      return indexOfKeyframeBefore(chunks, targetUs);
    case 'keyframe-after':
      return indexOfKeyframeAfter(chunks, targetUs);
    case 'nearest':
      return indexOfNearestKeyframe(chunks, targetUs);
    case 'exact':
      return indexOfExactSeekStart(chunks, targetUs);
    default:
      throw new InputError(`unknown seek mode ${String(mode)}`);
  }
}

/**
 * Whether a decoded frame's PTS satisfies the seek target under the given mode.
 * For keyframe modes the frame must be a keyframe; for exact/nearest the first frame at/after target.
 */
export function frameSatisfiesSeekMode(
  frame: { readonly timestamp: number; readonly type?: 'key' | 'delta' },
  targetUs: number,
  mode: SeekMode,
): boolean {
  requireTarget(targetUs);
  if (!Number.isFinite(frame.timestamp))
    throw new InputError(`frame timestamp must be finite, got ${frame.timestamp}`);
  if (mode === 'keyframe-before') return frame.type === 'key' && frame.timestamp <= targetUs;
  if (mode === 'keyframe-after') return frame.type === 'key' && frame.timestamp >= targetUs;
  // nearest and exact both resolve to first frame at/after target (nearest's distance already chosen via keyframe selection)
  return frame.timestamp >= targetUs;
}
