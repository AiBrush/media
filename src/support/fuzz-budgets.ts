/**
 * Fuzz campaigns with budgets + stable error taxonomy (REQUIREMENTS §8.5 — 4.4).
 *
 * Malformed-input fuzzing MUST enforce per-operation byte, allocation, recursion,
 * and time budgets. Error taxonomy must remain stable — capability absence,
 * invalid request, malformed input, resource exhaustion, browser failure, and
 * internal invariant failure MUST be distinct classes. This module is the pure,
 * Node-testable invariant — no browser APIs, no fixture branching, never
 * huge-alloc, deterministic.
 */

export type ErrorClass =
  | 'capability-miss'
  | 'invalid-request'
  | 'malformed'
  | 'resource-exhaustion'
  | 'browser-failure'
  | 'internal';

export const ERROR_CLASS_CODES: Record<ErrorClass, readonly string[]> = Object.freeze({
  'capability-miss': Object.freeze(['capability-miss']),
  'invalid-request': Object.freeze(['invalid-request', 'InputError']),
  malformed: Object.freeze(['demux-error', 'mux-error', 'parse-error', 'truncated']),
  'resource-exhaustion': Object.freeze(['resource-exhaustion', 'budget exceeded']),
  'browser-failure': Object.freeze(['browser-error', 'NotSupportedError', 'OperationError']),
  internal: Object.freeze(['internal-error', 'invariant']),
} as const);

export interface FuzzBudget {
  readonly maxBytes: number;
  readonly maxAllocBytes: number;
  readonly maxRecursion: number;
  readonly maxTimeMs: number;
}

export const DEFAULT_FUZZ_BUDGET: FuzzBudget = Object.freeze({
  maxBytes: 10 * 1024 * 1024, // 10 MiB input
  maxAllocBytes: 64 * 1024 * 1024, // 64 MiB alloc
  maxRecursion: 100,
  maxTimeMs: 5000,
} as const);

export function isErrorClass(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('error class must be string');
  if (value.length > 40) throw new RangeError('error class too long');
  return (Object.keys(ERROR_CLASS_CODES) as readonly string[]).includes(value);
}

export function errorClassForCode(code: string): ErrorClass | undefined {
  if (typeof code !== 'string') throw new RangeError('code must be string');
  if (code.length > 80) throw new RangeError('code too long');
  for (const [cls, codes] of Object.entries(ERROR_CLASS_CODES) as [
    ErrorClass,
    readonly string[],
  ][]) {
    for (const c of codes) if (code.includes(c)) return cls;
  }
  return undefined;
}

export function isValidFuzzBudget(b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  const x = b as Partial<FuzzBudget>;
  if (
    typeof x.maxBytes !== 'number' ||
    !Number.isSafeInteger(x.maxBytes) ||
    x.maxBytes <= 0 ||
    x.maxBytes > 100 * 1024 * 1024
  )
    return false;
  if (
    typeof x.maxAllocBytes !== 'number' ||
    !Number.isSafeInteger(x.maxAllocBytes) ||
    x.maxAllocBytes <= 0 ||
    x.maxAllocBytes > 512 * 1024 * 1024
  )
    return false;
  if (
    typeof x.maxRecursion !== 'number' ||
    !Number.isSafeInteger(x.maxRecursion) ||
    x.maxRecursion <= 0 ||
    x.maxRecursion > 10000
  )
    return false;
  if (
    typeof x.maxTimeMs !== 'number' ||
    !Number.isSafeInteger(x.maxTimeMs) ||
    x.maxTimeMs <= 0 ||
    x.maxTimeMs > 60000
  )
    return false;
  return true;
}

export function assertFuzzBudget(budget: FuzzBudget): void {
  if (!isValidFuzzBudget(budget)) throw new RangeError('invalid fuzz budget');
}

/** Whether a fuzz run stayed within budgets. Throws RangeError on malformed. */
export function fuzzWithinBudgets(
  used: { bytes: number; allocBytes: number; recursion: number; timeMs: number },
  budget: FuzzBudget = DEFAULT_FUZZ_BUDGET,
): boolean {
  if (typeof used !== 'object' || used === null) throw new RangeError('used must be object');
  const u = used as Partial<Record<keyof typeof used, number>>;
  for (const k of ['bytes', 'allocBytes', 'recursion', 'timeMs'] as const) {
    const v = u[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`${k} invalid`);
  }
  assertFuzzBudget(budget);
  return (
    used.bytes <= budget.maxBytes &&
    used.allocBytes <= budget.maxAllocBytes &&
    used.recursion <= budget.maxRecursion &&
    used.timeMs <= budget.maxTimeMs
  );
}

export function assertFuzzWithinBudgets(
  used: { bytes: number; allocBytes: number; recursion: number; timeMs: number },
  budget: FuzzBudget = DEFAULT_FUZZ_BUDGET,
): void {
  if (!fuzzWithinBudgets(used, budget)) throw new RangeError('fuzz exceeded budget');
}
