/**
 * Independent evidence review before SOTA claim (REQUIREMENTS §11 — 4.9).
 *
 * The project is eligible for a best-in-class claim only when all P0/P1 gaps
 * are closed, every correctness/speed/bundle/memory gate passes, broadest
 * correct coverage wins, results reproduce, and docs state measured facts.
 * An independent reviewer must be able to recompute the score from raw
 * artifacts. This module is the pure, Node-testable checklist — no browser
 * APIs, no fixture branching, never huge-alloc, deterministic.
 */

export interface ReviewGates {
  readonly correctnessZeroFailError: boolean; // zero FAIL and zero ERROR for in-scope
  readonly bundlePass: boolean; // eager ≤50 KiB and typical ≤250 KiB, no heavy lazy leaks
  readonly memoryPass: boolean; // probe ≤64 MiB, remux ≤128 MiB, queue bounded
  readonly speedPass: boolean; // geomean ≤1, 90% within 5%, none >10% p95 without tradeoff
  readonly reportsPublished: boolean; // 6 reports
  readonly heldOutPass: boolean; // 20% held-out + no fixture recognition
  readonly comparisonPinned: boolean; // 6 engines pinned
  readonly soakPass: boolean; // no crash/deadlock/leak
  readonly fuzzPass: boolean; // budgets + taxonomy stable
  readonly browserMatrixCovered: boolean;
}

export const REQUIRED_GATES: readonly (keyof ReviewGates)[] = Object.freeze([
  'correctnessZeroFailError',
  'bundlePass',
  'memoryPass',
  'speedPass',
  'reportsPublished',
  'heldOutPass',
  'comparisonPinned',
  'soakPass',
  'fuzzPass',
  'browserMatrixCovered',
] as const);

export function isReviewGates(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ReviewGates>;
  for (const k of REQUIRED_GATES) if (typeof v[k] !== 'boolean') return false;
  return true;
}

export function reviewPasses(gates: ReviewGates): boolean {
  if (!isReviewGates(gates)) throw new RangeError('invalid review gates');
  for (const k of REQUIRED_GATES) if (!gates[k]) return false;
  return true;
}

export function assertReviewPasses(gates: ReviewGates): void {
  if (!reviewPasses(gates)) {
    const missing = REQUIRED_GATES.filter((k) => !gates[k]);
    throw new RangeError(`independent review failed — gates not met: ${missing.join(', ')}`);
  }
}

export function sotaClaimEligible(gates: ReviewGates): boolean {
  return reviewPasses(gates);
}

export function minimalPassingGates(): ReviewGates {
  return Object.freeze({
    correctnessZeroFailError: true,
    bundlePass: true,
    memoryPass: true,
    speedPass: true,
    reportsPublished: true,
    heldOutPass: true,
    comparisonPinned: true,
    soakPass: true,
    fuzzPass: true,
    browserMatrixCovered: true,
  } as ReviewGates);
}
