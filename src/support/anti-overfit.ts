/**
 * Anti-overfitting lint — no fixture/size/ID/expected branching, no test weakening (REQUIREMENTS §10 — C6).
 *
 * Production code MUST NOT branch on fixture names, hashes, sizes, IDs,
 * expected outputs, etc. Tests MUST NOT be weakened/skipped to obtain PASS.
 * This module is the pure, Node-testable lint for that gate — no browser
 * APIs, no fixture branching, never huge-alloc, deterministic.
 */

export const OVERFIT_PATTERNS: readonly RegExp[] = Object.freeze([
  /fixture.*name/i,
  /hash.*fixture/i,
  /expected.*output/i,
  /bear-.*\.mp4/i,
  /mp3_xing\.mp3/i,
  /fixture.*size/i,
  /size.*fixture/i,
  /fixture.*id/i,
  /id.*fixture/i,
  /hash.*size/i,
  /expected.*hash/i,
] as const);

export const TEST_WEAKENING_PATTERNS: readonly RegExp[] = Object.freeze([
  /\.skip\b/i,
  /\.todo\b/i,
  /weaken.*expected/i,
  /skip.*test/i,
] as const);

/**
 * Lint `source` for overfit branching patterns. Returns matched pattern strings.
 * Throws RangeError on non-string, never huge-alloc.
 */
export function overfitLint(source: string): readonly string[] {
  if (typeof source !== 'string') throw new RangeError('overfitLint requires a string');
  if (source.length > 500_000) throw new RangeError('source too large');
  const hits: string[] = [];
  for (const p of OVERFIT_PATTERNS) if (p.test(source)) hits.push(p.source);
  return Object.freeze(hits);
}

export function testWeakeningLint(source: string): readonly string[] {
  if (typeof source !== 'string') throw new RangeError('testWeakeningLint requires a string');
  if (source.length > 500_000) throw new RangeError('source too large');
  const hits: string[] = [];
  for (const p of TEST_WEAKENING_PATTERNS) if (p.test(source)) hits.push(p.source);
  return Object.freeze(hits);
}

export function assertNoOverfit(source: string): void {
  const hits = overfitLint(source);
  if (hits.length > 0) throw new RangeError(`overfit branching detected: ${hits.join(', ')}`);
  const weak = testWeakeningLint(source);
  if (weak.length > 0) throw new RangeError(`test weakening detected: ${weak.join(', ')}`);
}

export function isCleanSource(source: string): boolean {
  return overfitLint(source).length === 0 && testWeakeningLint(source).length === 0;
}
