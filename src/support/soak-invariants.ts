/**
 * 24h mixed-workload soak invariants (REQUIREMENTS §8.5 — 4.3).
 *
 * A 24-hour repeated mixed-workload soak MUST complete without a crash,
 * deadlock, unbounded growth, or resource leak. This module is the pure,
 * Node-testable invariant for that gate — no timers, no fixture branching,
 * never huge-alloc, deterministic.
 */

export interface SoakIteration {
  readonly iteration: number;
  readonly memoryMB: number; // peak heap growth beyond baseline for this iteration
  readonly durationMs: number;
  readonly crashed?: boolean;
  readonly deadlocked?: boolean;
}

export interface SoakReport {
  readonly iterations: readonly SoakIteration[];
  readonly totalDurationMs: number;
}

export const MAX_SOAK_MEMORY_MB = 128; // copy/remux bound + headroom
export const MAX_SOAK_ITERATIONS = 10000;
export const GROWTH_SLOPE_THRESHOLD = 0.05; // 5% monotonic growth per window fails

function isSoakIteration(v: unknown): v is SoakIteration {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<SoakIteration>;
  const iter = r.iteration;
  if (typeof iter !== 'number' || !Number.isSafeInteger(iter) || iter < 0) return false;
  if (
    typeof r.memoryMB !== 'number' ||
    !Number.isFinite(r.memoryMB) ||
    r.memoryMB < 0 ||
    r.memoryMB > 10000
  )
    return false;
  if (
    typeof r.durationMs !== 'number' ||
    !Number.isFinite(r.durationMs) ||
    r.durationMs < 0 ||
    r.durationMs > 1e9
  )
    return false;
  if (r.crashed !== undefined && typeof r.crashed !== 'boolean') return false;
  if (r.deadlocked !== undefined && typeof r.deadlocked !== 'boolean') return false;
  return true;
}

export function isValidSoakReport(report: unknown): boolean {
  if (typeof report !== 'object' || report === null) return false;
  const r = report as Partial<SoakReport>;
  if (!Array.isArray(r.iterations)) return false;
  if (
    typeof r.totalDurationMs !== 'number' ||
    !Number.isFinite(r.totalDurationMs) ||
    r.totalDurationMs < 0
  )
    return false;
  if (r.iterations.length > MAX_SOAK_ITERATIONS) return false;
  for (const it of r.iterations) if (!isSoakIteration(it)) return false;
  return true;
}

/** Assert no crash or deadlock in any iteration. Throws RangeError on violation. */
export function assertSoakNoCrashDeadlock(report: SoakReport): void {
  if (!isValidSoakReport(report)) throw new RangeError('invalid soak report');
  for (const it of report.iterations) {
    if (it.crashed) throw new RangeError(`crash at iteration ${it.iteration}`);
    if (it.deadlocked) throw new RangeError(`deadlock at iteration ${it.iteration}`);
  }
}

/** Assert memory stays within budget every iteration. */
export function assertSoakMemoryBounded(
  report: SoakReport,
  budgetMB: number = MAX_SOAK_MEMORY_MB,
): void {
  if (!isValidSoakReport(report)) throw new RangeError('invalid soak report');
  if (!Number.isFinite(budgetMB) || budgetMB <= 0 || budgetMB > 10000)
    throw new RangeError('budget invalid');
  for (const it of report.iterations) {
    if (it.memoryMB > budgetMB)
      throw new RangeError(`memory ${it.memoryMB} >${budgetMB} at iteration ${it.iteration}`);
  }
}

/**
 * Assert no monotonic unbounded growth. Fails when last window median > first window median * (1+threshold).
 * Simple slope check: compares median of first third vs last third.
 */
export function assertSoakNoUnboundedGrowth(
  report: SoakReport,
  threshold: number = GROWTH_SLOPE_THRESHOLD,
): void {
  if (!isValidSoakReport(report)) throw new RangeError('invalid soak report');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new RangeError('threshold invalid');
  if (report.iterations.length < 6) return; // too few to assess growth
  const n = report.iterations.length;
  const first = report.iterations.slice(0, Math.floor(n / 3));
  const last = report.iterations.slice(Math.floor((n * 2) / 3));
  const median = (arr: readonly SoakIteration[]): number => {
    const vals = [...arr].map((x) => x.memoryMB).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] as number;
  };
  const mFirst = median(first);
  const mLast = median(last);
  if (mFirst === 0) return;
  const growth = (mLast - mFirst) / mFirst;
  if (growth > threshold)
    throw new RangeError(
      `unbounded growth ${(growth * 100).toFixed(1)}% >${(threshold * 100).toFixed(1)}%`,
    );
}

/** Full soak gate: no crash/deadlock, bounded, no unbounded growth. */
export function assertSoakInvariants(report: SoakReport): void {
  assertSoakNoCrashDeadlock(report);
  assertSoakMemoryBounded(report);
  assertSoakNoUnboundedGrowth(report);
}

export function soakInvariantsPass(report: SoakReport): boolean {
  try {
    assertSoakInvariants(report);
    return true;
  } catch {
    return false;
  }
}
