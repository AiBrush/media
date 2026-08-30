/**
 * Frozen candidate + held-out run gate (REQUIREMENTS §10, §4.8).
 *
 * At least 20% of release correctness scenarios SHOULD be held out from
 * routine implementation runs. A change that improves named fixtures but
 * regresses generated or held-out variants MUST be rejected.
 * On a frozen candidate, the held-out corpus must have been executed; a
 * generalized failure MUST reopen development. This module is the pure,
 * Node-testable gate — no filesystem, no fixture branching, never huge-alloc,
 * deterministic.
 */

export interface FrozenCandidate {
  readonly commit: string; // 7-40 hex
  readonly dirty: boolean;
}

export interface HeldOutResult {
  readonly heldOutPass: number;
  readonly heldOutFail: number;
  readonly heldOutError: number;
  readonly generalizedFailure: boolean; // true when held-out reveals regression vs routine
}

function isHexCommit(v: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(v);
}

export function isFrozenCandidate(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Partial<FrozenCandidate>;
  if (typeof c.commit !== 'string' || !isHexCommit(c.commit)) return false;
  if (typeof c.dirty !== 'boolean') return false;
  return c.dirty === false;
}

export function assertFrozenCandidate(candidate: unknown): asserts candidate is FrozenCandidate {
  if (!isFrozenCandidate(candidate))
    throw new RangeError('candidate must be frozen (clean commit, not dirty)');
}

export function isValidHeldOutResult(r: unknown): boolean {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Partial<HeldOutResult>;
  for (const k of ['heldOutPass', 'heldOutFail', 'heldOutError'] as const) {
    const v = x[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100000) return false;
  }
  if (typeof x.generalizedFailure !== 'boolean') return false;
  return true;
}

/**
 * Assert held-out was run on a frozen candidate. Throws when candidate not
 * frozen or held-out not executed (all zero and not failed). Never huge-alloc.
 */
export function assertHeldOutOnFrozen(candidate: unknown, result: unknown): void {
  assertFrozenCandidate(candidate);
  if (!isValidHeldOutResult(result)) throw new RangeError('invalid held-out result');
  const r = result as HeldOutResult;
  const total = r.heldOutPass + r.heldOutFail + r.heldOutError;
  if (total === 0) throw new RangeError('held-out not executed on frozen candidate');
}

/** Whether development must be reopened: generalized held-out failure. */
export function shouldReopenOnHeldOutFailure(result: HeldOutResult): boolean {
  if (!isValidHeldOutResult(result)) throw new RangeError('invalid held-out result');
  return result.generalizedFailure === true && (result.heldOutFail > 0 || result.heldOutError > 0);
}

export function assertNoReopenNeeded(result: HeldOutResult): void {
  if (shouldReopenOnHeldOutFailure(result))
    throw new RangeError('generalized held-out failure — reopen development');
}
