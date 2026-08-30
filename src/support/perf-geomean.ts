/**
 * Per-family geometric mean vs threshold helpers (REQUIREMENTS §8.2 — 3.6).
 *
 * Speed is counted only after output correctness and quality equivalence pass.
 * This module is the pure, Node-testable math for the 90%/5% median and 10% p95 gates —
 * no browser APIs, no fixture branching. The runner can feed it median/p95 pairs per
 * comparable required scenario, and CI can assert the gates without re-implementing the math.
 */

export interface FamilyTiming {
  readonly family: string;
  readonly medianMsAibrush: number;
  readonly medianMsFastest: number;
  readonly p95MsAibrush: number;
  readonly p95MsFastest: number;
}

export interface GeomeanResult {
  readonly geomean: number; // geometric mean of (aibrush / fastest) ratios, 1.0 = parity
  readonly within5PercentCount: number;
  readonly totalComparable: number;
  readonly within5PercentRatio: number; // within5PercentCount / totalComparable
  readonly maxP95Excess: number; // max (p95A / p95F - 1), 0 when no excess
  readonly worstFamily?: string;
}

/**
 * Geometric mean of per-family median ratios. Returns 1.0 for empty input.
 * Throws RangeError on non-finite or non-positive inputs, never huge-alloc.
 */
export function geomeanMedianRatio(families: readonly FamilyTiming[]): number {
  if (families.length === 0) return 1;
  let logSum = 0;
  for (const f of families) {
    if (!Number.isFinite(f.medianMsAibrush) || !Number.isFinite(f.medianMsFastest))
      throw new RangeError('median must be finite');
    if (f.medianMsAibrush <= 0 || f.medianMsFastest <= 0) throw new RangeError('median must be >0');
    if (!Number.isFinite(f.p95MsAibrush) || !Number.isFinite(f.p95MsFastest))
      throw new RangeError('p95 must be finite');
    if (f.p95MsAibrush <= 0 || f.p95MsFastest <= 0) throw new RangeError('p95 must be >0');
    logSum += Math.log(f.medianMsAibrush / f.medianMsFastest);
  }
  return Math.exp(logSum / families.length);
}

/**
 * Evaluate the 90% within 5% median and none >10% p95 gates.
 * Returns a `GeomeanResult` with the geomean and gate metrics. Never huge-alloc.
 */
export function evaluateGeomeanGates(families: readonly FamilyTiming[]): GeomeanResult {
  if (families.length === 0) {
    return {
      geomean: 1,
      within5PercentCount: 0,
      totalComparable: 0,
      within5PercentRatio: 1,
      maxP95Excess: 0,
    };
  }
  const geomean = geomeanMedianRatio(families);
  let within = 0;
  let maxExcess = 0;
  let worst: string | undefined;
  for (const f of families) {
    const medianRatio = f.medianMsAibrush / f.medianMsFastest;
    if (medianRatio <= 1.05) within++;
    const p95Excess = f.p95MsAibrush / f.p95MsFastest - 1;
    if (p95Excess > maxExcess) {
      maxExcess = p95Excess;
      worst = f.family;
    }
  }
  return {
    geomean,
    within5PercentCount: within,
    totalComparable: families.length,
    within5PercentRatio: within / families.length,
    maxP95Excess: maxExcess,
    ...(worst ? { worstFamily: worst } : {}),
  };
}

/**
 * True when the gates pass: geomean ≤ 1.0 (no slower than fastest), 90% within 5% median,
 * and none >10% p95 without documented tradeoff (the caller must provide the tradeoff flag).
 */
export function geomeanGatesPass(
  result: GeomeanResult,
  hasDocumentedTradeoffForWorst = false,
): boolean {
  if (result.geomean > 1) return false;
  if (result.within5PercentRatio < 0.9) return false;
  if (result.maxP95Excess > 0.1 && !hasDocumentedTradeoffForWorst) return false;
  return true;
}
