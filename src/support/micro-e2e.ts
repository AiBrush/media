/**
 * Microbenchmark vs E2E precedence (REQUIREMENTS §8.2 — 3.9).
 *
 * A microbenchmark win MUST NOT override slower end-to-end execution.
 * Performance changes must be evaluated end-to-end on representative inputs,
 * not on isolated kernels. This module is the pure, Node-testable gate for
 * that invariant — no browser APIs, no fixture branching, never huge-alloc,
 * deterministic.
 */

export const E2E_TOLERANCE_RATIO = 1.05; // 5% — same as geomean within5Percent gate
export const MICRO_TOLERANCE_RATIO = 1; // micro <1 means faster than fastest

export interface MicroVsE2eRatios {
  readonly microRatio: number; // aibrush/micro / fastest/micro
  readonly e2eRatio: number; // aibrush/e2e / fastest/e2e
}

export interface MicroE2eGateResult {
  readonly microRatio: number;
  readonly e2eRatio: number;
  readonly passes: boolean; // true when E2E not regressed >5%, regardless of micro
  readonly microWinButE2eRegressed: boolean; // true when micro<1 but e2e>1.05 — the forbidden case
}

/**
 * Evaluate the gate. Throws RangeError on non-finite / non-positive, never huge-alloc.
 */
export function evaluateMicroE2eGate(ratios: MicroVsE2eRatios): MicroE2eGateResult {
  if (typeof ratios !== 'object' || ratios === null) throw new RangeError('ratios must be object');
  const { microRatio, e2eRatio } = ratios as Partial<MicroVsE2eRatios>;
  if (!Number.isFinite(microRatio) || (microRatio as number) <= 0)
    throw new RangeError('microRatio must be finite >0');
  if (!Number.isFinite(e2eRatio) || (e2eRatio as number) <= 0)
    throw new RangeError('e2eRatio must be finite >0');
  const micro = microRatio as number;
  const e2e = e2eRatio as number;
  const microWinButE2eRegressed = micro < 1 && e2e > E2E_TOLERANCE_RATIO;
  const passes = e2e <= E2E_TOLERANCE_RATIO;
  return Object.freeze({ microRatio: micro, e2eRatio: e2e, passes, microWinButE2eRegressed });
}

/**
 * Assert the gate passes — E2E not regressed >5%. Throws RangeError when
 * micro win would hide E2E regression or E2E itself is >5% slower.
 */
export function assertMicroNotOverridingE2e(ratios: MicroVsE2eRatios): void {
  const r = evaluateMicroE2eGate(ratios);
  if (!r.passes)
    throw new RangeError(
      `E2E regressed ${r.e2eRatio.toFixed(3)} >${E2E_TOLERANCE_RATIO} (micro ${r.microRatio.toFixed(3)}) — micro win must not override E2E`,
    );
}

/** Whether a change should be accepted — E2E gate only, micro is advisory. */
export function microE2eGatePasses(ratios: MicroVsE2eRatios): boolean {
  return evaluateMicroE2eGate(ratios).passes;
}
