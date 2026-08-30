/**
 * Held-out corpus + fixture-recognition lint (REQUIREMENTS §10 — 0.9).
 *
 * At least 20% of release correctness scenarios SHOULD be held out from routine implementation
 * runs. A change that improves named fixtures but regresses held-out variants MUST be rejected.
 * Production code MUST NOT branch on fixture names, hashes, sizes, IDs, expected outputs, etc.
 * This module is the pure, Node-testable source for the held-out split and the fixture lint —
 * no browser APIs, no fixture branching. CI can use `heldOutSplit()` to partition a corpus and
 * `fixtureLint()` to fail if `src/` contains fixture-recognition patterns.
 */

export const HELD_OUT_FRACTION = 0.2;
export const HELD_OUT_MIN_COUNT = 1;

/**
 * Deterministically split `corpus` into `{ heldOut, training }` where `heldOut` is at least
 * `HELD_OUT_FRACTION` (20%) and at least `HELD_OUT_MIN_COUNT`. The split is stable (sorted,
 * then every `1/fraction`-th item is held out), so the same corpus always yields the same
 * held-out set without random seeds.
 */
export function heldOutSplit<T>(corpus: readonly T[]): {
  heldOut: readonly T[];
  training: readonly T[];
} {
  if (corpus.length === 0) return { heldOut: [], training: [] };
  const heldOutCount = Math.max(HELD_OUT_MIN_COUNT, Math.ceil(corpus.length * HELD_OUT_FRACTION));
  const sorted = [...corpus].sort();
  const heldOut: T[] = [];
  const training: T[] = [];
  // Use a stable hash of the stringified item to decide held-out, but for pure determinism
  // we use the sorted index modulo.
  for (let i = 0; i < sorted.length; i++) {
    if (i % 5 === 0 && heldOut.length < heldOutCount) heldOut.push(sorted[i] as T);
    else training.push(sorted[i] as T);
  }
  // If modulo left us short (e.g. tiny corpus), take from training until we reach the count
  while (heldOut.length < heldOutCount && training.length > 0) {
    heldOut.push(training.shift() as T);
  }
  // If we overshot due to modulo, move excess back
  while (heldOut.length > heldOutCount) {
    training.unshift(heldOut.pop() as T);
  }
  return { heldOut: Object.freeze([...heldOut]), training: Object.freeze([...training]) };
}

/** Patterns that indicate fixture-specific branching (production code MUST NOT contain them). */
export const FIXTURE_PATTERNS: readonly RegExp[] = [
  /fixture.*name/i,
  /hash.*fixture/i,
  /expected.*output/i,
  /bear-.*\.mp4/i,
  /mp3_xing\.mp3/i,
] as const;

/**
 * Lint `source` for fixture-recognition patterns. Returns the matched pattern strings, empty when clean.
 * Never huge-alloc: scans line-by-line, early exit after first match per pattern is not needed for correctness.
 */
export function fixtureLint(source: string): readonly string[] {
  if (typeof source !== 'string') throw new RangeError('fixtureLint requires a string');
  const hits: string[] = [];
  for (const pattern of FIXTURE_PATTERNS) {
    if (pattern.test(source)) hits.push(pattern.source);
  }
  return Object.freeze(hits);
}

/**
 * Validate that `heldOut` is at least 20% and that `training` + `heldOut` equals `corpus` size.
 * Throws `RangeError` on violation, never huge-alloc.
 */
export function assertHeldOutCorpus<T>(
  corpus: readonly T[],
  split: { heldOut: readonly T[]; training: readonly T[] },
): void {
  const total = split.heldOut.length + split.training.length;
  if (total !== corpus.length)
    throw new RangeError(`held-out split size ${total} != corpus ${corpus.length}`);
  if (split.heldOut.length < Math.ceil(corpus.length * HELD_OUT_FRACTION) && corpus.length >= 5) {
    throw new RangeError(`held-out ${split.heldOut.length} < 20% of ${corpus.length}`);
  }
}
